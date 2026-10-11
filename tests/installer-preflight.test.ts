import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactFor } from "../scripts/installer-downloads.mjs";
import test from "node:test";
import { PI_INSTALL_VERSION, collectInventory, goAcquisition, planPreflight, pnpmGlobalBin, requirements } from "../scripts/installer-preflight.mjs";

const absent = { available: false };
const tool = (version: string) => ({ available: true, version, usable: true });
function clean(platform = "linux", arch = "x64") {
	return { platform, arch, node: absent, pnpm: absent, pi: absent, shell: absent,
		gentleAi: absent, go: absent, globalBin: absent, setup: false };
}
function installed(platform = "linux") {
	return { ...clean(platform), node: tool("24.1.0"),
		pnpm: { ...tool("12.0.0"), compatible: true }, pi: tool("1.2.0"),
		shell: { ...tool("5.0.0"), global: true },
		gentleAi: { ...tool(requirements.gentleAi), compatible: true },
		globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true }, setup: true };
}
const ids = (inventory: object) => planPreflight(inventory).actions.map((action: { id: string }) => action.id);

test("requirements follow repository metadata and native installer pin", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(requirements.node, pkg.engines.node.slice(2));
	assert.equal(requirements.pi, pkg.peerDependencies["@earendil-works/pi-coding-agent"].slice(2));
	assert.equal(requirements.pnpm, pkg.packageManager.split("@")[1]);
	assert.equal(requirements.shell, pkg.version);
	assert.equal(requirements.go, "1.25.10");
});

test("preflight imports a packed manifest without packageManager using the verified pnpm pin", () => {
	const root = mkdtempSync(fileURLToPath(new URL("./.preflight-packed-", import.meta.url)));
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		delete pkg.packageManager;
		writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
		cpSync(new URL("../scripts", import.meta.url), join(root, "scripts"), { recursive: true });
		const entry = pathToFileURL(join(root, "scripts/installer-preflight.mjs")).href;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e",
			`const { requirements } = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(requirements));`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, `${JSON.stringify({ ...requirements, pnpm: artifactFor("pnpm").version })}\n`);
		assert.equal(readFileSync(join(root, "package.json"), "utf8"), JSON.stringify(pkg));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const platform of ["linux", "darwin", "win32"]) {
	for (const arch of ["x64", "arm64"]) {
		test(`clean ${platform}/${arch} has dependency-ordered actions`, () => {
			const plan = planPreflight(clean(platform, arch));
			assert.equal(plan.blockers.length, 0);
			assert.equal(plan.ready, false);
			assert.deepEqual(ids(clean(platform, arch)), ["acquire-node", "verify-node", "acquire-pnpm", "verify-pnpm",
				"setup-global-bin", ...(platform === "win32" ? ["acquire-go", "verify-go"] : []),
				"install-pi", "install-shell", "setup-shell", "verify-readiness"]);
		});
	}
	test(`compatible ${platform} reuses newer global tools without acquiring Go`, () => {
		const inventory = installed(platform);
		const before = structuredClone(inventory);
		const plan = planPreflight(inventory);
		assert.equal(plan.ready, true);
		assert.deepEqual(ids(inventory), ["verify-readiness"]);
		assert.deepEqual(inventory, before);
		assert.equal(plan.tools.node.status, "reusable");
		assert.equal(plan.tools.go.status, "not-required");
	});
}

const mainSteps = ["build-gentle-ai-main", "install-shell-main", "record-channel"];
for (const platform of ["linux", "darwin", "win32"]) {
	test(`the main channel on ${platform} adds the main build steps after a clean installation`, () => {
		const inventory = { ...clean(platform), node: tool("24.1.0"), pnpm: { ...tool("11.1.1"), compatible: true },
			globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true }, go: tool("1.26.0") };
		const release = ids(inventory);
		const plan = planPreflight(inventory, { channel: "main" });
		assert.deepEqual(plan.blockers, []);
		assert.equal(plan.tools.go.status, "reusable");
		assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), [...release, ...mainSteps]);
		assert.deepEqual(plan.actions.slice(-3), [
			{ id: "build-gentle-ai-main", kind: "build-native-main", target: "gentleAi" },
			{ id: "install-shell-main", kind: "install-global", target: "shell" },
			{ id: "record-channel", kind: "configure", target: "channel" }]);
		assert.equal(plan.ready, false);
	});
}

const goActions = [{ id: "acquire-go", kind: "acquire", target: "go", version: goAcquisition.version }, { id: "verify-go", kind: "verify", target: "go" }];
test("the pinned Go is a 1.25 patch release that meets the requirement", () => {
	assert.equal(goAcquisition.version, "1.25.14");
	const [major, minor, patch] = goAcquisition.version.split(".").map(Number);
	const [rMajor, rMinor, rPatch] = requirements.go.split(".").map(Number);
	assert.ok(major === rMajor && minor === rMinor && patch >= rPatch);
});

test("the pinned Go is acquired before the runtime is persisted, so a failed Go download changes nothing", () => {
	const persisting = { ...tool("24.18.0"), persistent: false, npm: true };
	for (const [platform, channel] of [["linux", "main"], ["darwin", "main"], ["win32", "release"]] as const) {
		const inventory = { ...clean(platform), node: persisting, pnpm: { ...tool("11.1.1"), compatible: true, persistent: false },
			globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true }, go: absent };
		const plan = planPreflight(inventory, { channel });
		assert.deepEqual(plan.blockers, [], platform);
		assert.deepEqual(plan.actions.map((action: { id: string }) => action.id).slice(0, 5),
			["acquire-go", "verify-go", "persist-node", "persist-package-managers", "configure-npm-prefix"], platform);
	}
});

test("the main channel acquires the pinned Go when Go is missing or older, before the build, on every platform", () => {
	for (const platform of ["linux", "darwin", "win32"]) {
		for (const [go, found] of [[absent, null], [tool("1.25.9"), "1.25.9"]] as const) {
			const inventory = { ...clean(platform), node: tool("24.1.0"), pnpm: { ...tool("11.1.1"), compatible: true },
				globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true }, go };
			const plan = planPreflight(inventory, { channel: "main" });
			assert.deepEqual(plan.blockers, []);
			assert.deepEqual(plan.tools.go, { status: "needs-acquire", required: requirements.go, version: goAcquisition.version, ...(found ? { found } : {}) });
			const order = plan.actions.map((action: { id: string }) => action.id);
			assert.deepEqual(plan.actions.filter((action: { target: string }) => action.target === "go"), goActions);
			assert.deepEqual(order, ["acquire-go", "verify-go", "install-pi", "install-shell", "setup-shell", "verify-readiness", ...mainSteps], platform);
		}
	}
});

test("an unknown Go still blocks the main channel: it is neither missing nor older", () => {
	const plan = planPreflight({ ...clean("darwin"), go: { available: null } }, { channel: "main" });
	assert.ok(plan.blockers.some((blocker: { code: string; tool: string }) => blocker.code === "main-requires-go" && blocker.tool === "go"));
	assert.deepEqual(plan.actions, []);
});

test("a release installation on macOS or Linux never acquires Go, whatever Go is there", () => {
	for (const platform of ["linux", "darwin"]) {
		for (const go of [absent, tool("1.24.0"), { available: null }]) {
			const plan = planPreflight({ ...clean(platform), go });
			assert.equal(plan.tools.go.status, "not-required");
			assert.equal(plan.actions.some((action: { target: string }) => action.target === "go"), false);
		}
	}
});

test("the release channel is the default and plans exactly as before", () => {
	for (const inventory of [clean("darwin"), installed("linux"), { ...clean("win32"), go: tool("1.26.0") }]) {
		assert.deepEqual(planPreflight(inventory, { channel: "release" }), planPreflight(inventory));
	}
	assert.equal(planPreflight(clean("darwin")).tools.go.status, "not-required");
});

test("an already set-up stack on the main channel plans no main steps, since nothing is installed", () => {
	const plan = planPreflight({ ...installed("darwin"), go: tool("1.26.0") }, { channel: "main" });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["verify-readiness"]);
	assert.equal(plan.ready, true);
});

test("an unknown channel is rejected", () => {
	assert.throws(() => planPreflight(clean("linux"), { channel: "nightly" }), /Unsupported installation channel/);
});

test("Windows requires compatible Go only before a missing native binary", () => {
	const inventory = { ...installed("win32"), gentleAi: absent, go: tool("1.26.0") };
	assert.equal(planPreflight(inventory).tools.go.status, "reusable");
	assert.deepEqual(ids(inventory), ["provision-native", "setup-shell", "verify-readiness"]);
	const older = planPreflight({ ...inventory, go: tool("1.25.9") });
	assert.deepEqual(older.blockers, []);
	assert.deepEqual(older.tools.go, { status: "needs-acquire", required: requirements.go, version: goAcquisition.version, found: "1.25.9" });
	assert.deepEqual(older.actions.slice(0, 2), goActions);
});

for (const [name, version] of [["node", "22.18.0"], ["shell", "3.9.0"], ["node", "banana"], ["pi", "1.0.0-rc.1"]]) {
	test(`${name} ${version} blocks rather than replacing an existing tool`, () => {
		const inventory = { ...installed(), [name]: tool(version) };
		const plan = planPreflight(inventory);
		assert.ok(plan.blockers.some((b: { tool: string }) => b.tool === name));
		assert.deepEqual(plan.actions, []);
		assert.equal(plan.ready, false);
	});
}

test("an older Shell without its global command is reported as incompatible, not unknown", () => {
	const unchecked = { available: null };
	const inventory = { ...installed(), shell: { available: true, version: "3.4.0", usable: false, global: true },
		gentleAi: unchecked, setup: unchecked };
	const plan = planPreflight(inventory);
	assert.deepEqual(plan.blockers, [{ code: "incompatible-tool", tool: "shell" }]);
	assert.equal(plan.tools.shell.status, "incompatible");
	assert.deepEqual(plan.actions, []);
	assert.equal(plan.ready, false);
});

test("a Shell installed outside pnpm is the only blocker, without derived Gentle AI and setup blockers", () => {
	const unchecked = { available: null };
	const plan = planPreflight({ ...installed(), shell: { available: null, outsidePnpm: true }, gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(plan.blockers, [{ code: "unknown-tool", tool: "shell" }]);
	assert.deepEqual(plan.actions, []);
	assert.equal(plan.ready, false);
});

const unchecked = { available: null };
const owned = (version: string, owner = "pnpm", usable = true) => ({ available: true, version, usable, global: true, owner });
const updateIds = (plan: { actions: Array<{ id: string }> }) => plan.actions.map((action) => action.id);

test("an older Gentle Shell that pnpm or npm owns is updated to the latest release, then set up", () => {
	for (const shell of [owned("3.9.0"), owned("3.9.0", "npm"), owned("3.4.0", "pnpm", false), owned(`${requirements.shell}-main.6e7e3a18f794`, "npm")]) {
		const plan = planPreflight({ ...installed(), shell, gentleAi: unchecked, setup: unchecked });
		assert.deepEqual(plan.blockers, [], JSON.stringify(shell));
		assert.equal(plan.tools.shell.status, "needs-update");
		assert.deepEqual(updateIds(plan), ["update-shell-release", "setup-shell", "verify-readiness"]);
		assert.deepEqual(plan.actions[0], { id: "update-shell-release", kind: "upgrade", target: "shell" });
		assert.equal(plan.ready, false);
	}
});

test("a current Gentle Shell installed by npm needs nothing on the release channel", () => {
	const plan = planPreflight({ ...installed(), shell: owned(requirements.shell, "npm"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(updateIds(plan), ["verify-readiness"]);
	assert.equal(plan.ready, true);
});

test("a current pnpm-owned Gentle Shell plans exactly as before", () => {
	const inventory = installed();
	assert.deepEqual(planPreflight({ ...inventory, shell: { ...inventory.shell, owner: "pnpm" } }), planPreflight(inventory));
});

test("on the main channel an owned Gentle Shell is updated to the latest main, which needs Go", () => {
	for (const shell of [owned(requirements.shell), owned("3.9.0", "npm"), owned(`${requirements.shell}-main.6e7e3a18f794`)]) {
		const plan = planPreflight({ ...installed(), shell, go: tool("1.26.0"), gentleAi: unchecked, setup: unchecked }, { channel: "main" });
		assert.deepEqual(plan.blockers, []);
		assert.deepEqual(updateIds(plan), ["update-shell-main", "setup-shell", "verify-readiness"]);
		assert.deepEqual(plan.actions[0], { id: "update-shell-main", kind: "upgrade", target: "shell" });
	}
	for (const go of [absent, tool("1.24.0")]) {
		const noGo = planPreflight({ ...installed(), shell: owned("3.9.0"), go, gentleAi: unchecked, setup: unchecked }, { channel: "main" });
		assert.deepEqual(noGo.blockers, []);
		assert.deepEqual(updateIds(noGo), ["acquire-go", "verify-go", "update-shell-main", "setup-shell", "verify-readiness"]);
	}
	// A Windows release update runs gentle-pi's postinstall, which may build Gentle AI.
	const windows = planPreflight({ ...installed("win32"), shell: owned("3.9.0"), go: tool("1.24.0"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(updateIds(windows), ["acquire-go", "verify-go", "update-shell-release", "setup-shell", "verify-readiness"]);
	assert.deepEqual(updateIds(planPreflight({ ...installed("darwin"), shell: owned("3.9.0"), go: absent, gentleAi: unchecked, setup: unchecked })),
		["update-shell-release", "setup-shell", "verify-readiness"]);
});

test("a missing Pi is installed before an existing Gentle Shell is updated", () => {
	const plan = planPreflight({ ...installed(), pi: absent, shell: owned("3.9.0", "npm"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(updateIds(plan), ["install-pi", "update-shell-release", "setup-shell", "verify-readiness"]);
});

test("an existing compatible Pi from any installation is reused and only Gentle Shell is installed", () => {
	for (const pi of [tool("1.2.0"), { ...tool("1.0.4"), external: true }]) {
		const plan = planPreflight({ ...installed(), pi, shell: absent, gentleAi: absent, setup: false });
		assert.equal(plan.tools.pi.status, "reusable");
		assert.deepEqual(updateIds(plan), ["install-shell", "setup-shell", "verify-readiness"]);
	}
});

test("a pnpm Pi newer than the installer's pin never blocks: Gentle Shell is added or updated beside it", () => {
	const newer = { ...tool("1.1.0") };
	const install = planPreflight({ ...installed(), pi: newer, shell: absent, gentleAi: absent, setup: false });
	assert.deepEqual([install.blockers, updateIds(install)], [[], ["install-shell", "setup-shell", "verify-readiness"]]);
	const update = planPreflight({ ...installed(), pi: newer, shell: owned("3.9.0"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual([update.blockers, updateIds(update)], [[], ["update-shell-release", "setup-shell", "verify-readiness"]]);
	// Even a probe that reported an owner is not a blocker: only an older owned Pi is updated.
	assert.deepEqual(planPreflight({ ...installed(), pi: { ...newer, owner: "pnpm" }, shell: absent, gentleAi: absent, setup: false }).blockers, []);
});

// An older Pi that pnpm or npm owns is updated to the version the installer installs.
const olderPi = (owner?: string, version = "0.87.1") => ({ ...tool(version), ...(owner ? { owner } : {}) });

test("an older Pi that pnpm or npm owns is updated before Gentle Shell is installed, instead of blocking", () => {
	for (const owner of ["pnpm", "npm"]) {
		const plan = planPreflight({ ...installed(), pi: olderPi(owner), shell: absent, gentleAi: absent, setup: false });
		assert.deepEqual(plan.blockers, [], owner);
		assert.deepEqual(plan.tools.pi, { status: "needs-update", required: requirements.pi, version: "0.87.1", owner });
		assert.deepEqual(updateIds(plan), ["update-pi", "install-shell", "setup-shell", "verify-readiness"]);
		assert.deepEqual(plan.actions[0], { id: "update-pi", kind: "upgrade", target: "pi", version: PI_INSTALL_VERSION });
		assert.equal(plan.ready, false);
	}
});

test("an older owned Pi is updated before an existing Gentle Shell is updated", () => {
	const plan = planPreflight({ ...installed(), pi: olderPi("pnpm"), shell: owned("3.9.0", "npm"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(updateIds(plan), ["update-pi", "update-shell-release", "setup-shell", "verify-readiness"]);
});

test("with a current Gentle Shell, an older owned Pi is the only thing updated", () => {
	for (const shell of [owned(requirements.shell, "npm"), { ...tool(requirements.shell), global: true }]) {
		const plan = planPreflight({ ...installed(), pi: olderPi("npm"), shell });
		assert.deepEqual(plan.blockers, [], JSON.stringify(shell));
		assert.deepEqual(updateIds(plan), ["update-pi", "verify-readiness"]);
		assert.equal(plan.ready, false);
	}
});

test("the main channel updates an older owned Pi before the main overlay", () => {
	const inventory = { ...clean("darwin"), node: tool("24.1.0"), pnpm: { ...tool("11.1.1"), compatible: true }, pi: olderPi("pnpm"),
		globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true }, go: tool("1.26.0") };
	assert.deepEqual(updateIds(planPreflight(inventory, { channel: "main" })),
		["update-pi", "install-shell", "setup-shell", "verify-readiness", ...mainSteps]);
});

test("an older Pi that neither pnpm nor npm owns is left as it is, and the installer's Pi is installed alongside", () => {
	for (const pi of [olderPi(), olderPi("mise"), { ...olderPi(), external: true }, { ...tool("0.99.0"), external: true }]) {
		const plan = planPreflight({ ...installed(), pi, shell: absent, gentleAi: absent, setup: false });
		assert.deepEqual(plan.blockers, [], JSON.stringify(pi));
		assert.deepEqual(plan.tools.pi, { status: "needs-install", required: requirements.pi, version: pi.version });
		// Exactly the absent-Pi installation: Pi and Gentle Shell in one pnpm add.
		assert.deepEqual(updateIds(plan), ["install-pi", "install-shell", "setup-shell", "verify-readiness"]);
		assert.deepEqual(updateIds(plan), updateIds(planPreflight({ ...installed(), pi: absent, shell: absent, gentleAi: absent, setup: false })));
	}
	const update = planPreflight({ ...installed(), pi: olderPi(), shell: owned("3.9.0", "npm"), gentleAi: unchecked, setup: unchecked });
	assert.deepEqual(updateIds(update), ["install-pi", "update-shell-release", "setup-shell", "verify-readiness"]);
	// A current Gentle Shell: only the installer's Pi is added.
	for (const shell of [owned(requirements.shell, "npm"), { ...tool(requirements.shell), global: true }]) {
		assert.deepEqual(updateIds(planPreflight({ ...installed(), pi: olderPi(), shell })), ["install-pi", "verify-readiness"]);
	}
});

test("Pi is never touched when it is current, and an unknown or unusable Pi keeps blocking", () => {
	// A current Pi, even with a known owner, is reused untouched.
	for (const pi of [olderPi("pnpm", requirements.pi), olderPi("npm", "1.2.0"), { ...olderPi(undefined, "1.2.0"), external: true }]) {
		const plan = planPreflight({ ...installed(), pi, shell: absent, gentleAi: absent, setup: false });
		assert.equal(plan.tools.pi.status, "reusable");
		assert.deepEqual(updateIds(plan), ["install-shell", "setup-shell", "verify-readiness"]);
	}
	// A prerelease, an unusable Pi or one whose version cannot be read keeps blocking.
	for (const pi of [olderPi("pnpm", "0.99.1-rc.1"), { ...olderPi("pnpm"), usable: false }, { ...olderPi(), usable: false },
		{ available: null, owner: "pnpm" }, { available: null, outsidePnpm: true }]) {
		const plan = planPreflight({ ...installed(), pi, shell: absent, gentleAi: absent, setup: false });
		assert.ok(plan.blockers.some((b: { tool: string }) => b.tool === "pi"), JSON.stringify(pi));
		assert.deepEqual(plan.actions, []);
	}
});

test("an unknown Gentle AI still blocks when the Shell is reusable", () => {
	const plan = planPreflight({ ...installed(), gentleAi: { available: null } });
	assert.deepEqual(plan.blockers, [{ code: "unknown-tool", tool: "gentleAi" }]);
});

test("a current Shell without its global command still blocks as unknown", () => {
	const plan = planPreflight({ ...installed(), shell: { available: true, version: "5.0.0", usable: false, global: true } });
	assert.deepEqual(plan.blockers, [{ code: "unknown-tool", tool: "shell" }]);
	assert.deepEqual(plan.actions, []);
});

test("missing Windows Go is acquired before reprovisioning an existing Shell", () => {
	const inventory = { ...installed("win32"), gentleAi: absent };
	assert.deepEqual(ids(inventory), ["acquire-go", "verify-go", "provision-native", "setup-shell", "verify-readiness"]);
	for (const go of [tool("devel"), { ...tool("1.26.0"), usable: false }]) {
		assert.equal(planPreflight({ ...inventory, go }).tools.go.status, "unknown");
		assert.deepEqual(ids({ ...inventory, go }), []);
	}
});

// A pinned stack this pnpm installed whose setup did not finish (setup probe: recoverable).
const recoverable = { available: true, recoverable: true };
function partial(change: object = {}) {
	return { ...installed(), pi: tool("1.0.0"), shell: { ...tool(requirements.shell), global: true }, setup: recoverable, ...change };
}

test("a recoverable stack only reruns setup, with PATH setup when the global bin is off PATH", () => {
	const offPath = { available: true, path: "/disposable/bin", writable: true, onPath: false };
	const plan = planPreflight(partial());
	assert.deepEqual(plan.blockers, []);
	assert.equal(plan.tools.setup.status, "needs-setup");
	assert.equal(plan.ready, false);
	assert.deepEqual(ids(partial()), ["setup-shell", "verify-readiness"]);
	assert.deepEqual(ids(partial({ globalBin: offPath })), ["setup-global-bin", "setup-shell", "verify-readiness"]);
	// Never runtime persistence: the earlier run persisted it before installing the stack.
	const bootstrapPnpm = { ...tool("11.1.1"), compatible: true, persistent: false };
	for (const node of [{ ...tool("24.18.0"), persistent: false, npm: false }, { ...tool("24.18.0"), persistent: true, npm: false }]) {
		assert.deepEqual(ids(partial({ node, pnpm: bootstrapPnpm, globalBin: offPath })), ["setup-global-bin", "setup-shell", "verify-readiness"]);
	}
});

test("only an exact recoverable setup with a verified Gentle AI is a recovery", () => {
	for (const setup of [{ available: null }, { available: true }, { available: true, recoverable: "yes" }, { available: false, recoverable: true }]) {
		const plan = planPreflight(partial({ setup }));
		assert.ok(plan.blockers.some((b: { tool: string; code: string }) => b.tool === "setup" && b.code === "unknown-tool"), JSON.stringify(setup));
		assert.deepEqual(plan.actions, []);
	}
	// A missing native binary keeps its existing provisioning plan; the runner does not run it.
	assert.deepEqual(ids(partial({ gentleAi: absent })), ["provision-native", "setup-shell", "verify-readiness"]);
	for (const change of [{ gentleAi: { available: null } }, { pi: tool("0.99.0") }, { shell: { ...tool(requirements.shell), global: false } }]) {
		assert.deepEqual(ids(partial(change)), []);
	}
});

test("unknown probes and pnpm compatibility fail closed", () => {
	for (const change of [{ node: undefined }, { pnpm: tool("11.1.1") }, { setup: undefined },
		{ gentleAi: { ...tool("5.0.0"), compatible: false } }, { shell: { ...tool("4.0.0"), global: false } }]) {
		assert.ok(planPreflight({ ...installed(), ...change }).blockers.length > 0);
	}
});

test("global-bin must be writable and reachable; known PATH repair is explicit", () => {
	const inventory = installed();
	assert.deepEqual(ids({ ...inventory, globalBin: { ...inventory.globalBin, onPath: false } }),
		["setup-global-bin", "verify-readiness"]);
	for (const globalBin of [{ ...inventory.globalBin, writable: false }, { available: true }]) {
		assert.deepEqual(planPreflight({ ...inventory, globalBin }).actions, []);
		assert.equal(planPreflight({ ...inventory, globalBin }).tools.globalBin.status, "unknown");
	}
});

test("pnpm global bin is $PNPM_HOME/bin and onPath checks that directory, not $PNPM_HOME", () => {
	const home = "/home/u/.local/share/pnpm";
	assert.deepEqual(pnpmGlobalBin({ platform: "linux", env: { HOME: "/home/u", PATH: `${home}:/usr/bin` } }),
		{ pnpmHome: home, path: `${home}/bin`, onPath: false });
	assert.equal(pnpmGlobalBin({ platform: "linux", env: { HOME: "/home/u", PATH: `/usr/bin:${home}/bin/` } })?.onPath, true);
	assert.equal(pnpmGlobalBin({ platform: "linux", env: { HOME: "/home/u", XDG_DATA_HOME: "/data", PATH: "" } })?.path, "/data/pnpm/bin");
	assert.equal(pnpmGlobalBin({ platform: "darwin", env: { HOME: "/Users/u", PNPM_HOME: "/opt/pnpm", PATH: "/opt/pnpm/bin" } })?.onPath, true);
	assert.equal(pnpmGlobalBin({ platform: "darwin", env: { HOME: "/Users/u" } })?.path, "/Users/u/Library/pnpm/bin");
	assert.deepEqual(pnpmGlobalBin({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", Path: "c:\\users\\U\\appdata\\local\\PNPM\\Bin\\;C:\\Windows" } }),
		{ pnpmHome: "C:\\Users\\u\\AppData\\Local\\pnpm", path: "C:\\Users\\u\\AppData\\Local\\pnpm\\bin", onPath: true });
	for (const env of [{ PNPM_HOME: "relative/pnpm", HOME: "/home/u" }, { PATH: "/usr/bin" }, { HOME: "relative" }]) {
		assert.equal(pnpmGlobalBin({ platform: "linux", env }), null);
	}
});

test("unsupported targets never offer installation", () => {
	for (const inventory of [clean("freebsd"), clean("linux", "ia32")]) {
		assert.equal(planPreflight(inventory).blockers[0].code, "unsupported-target");
		assert.deepEqual(ids(inventory), []);
	}
});

test("collector invokes only injected named probes, catches failures without logging details", async () => {
	const calls: string[] = [];
	const probes = Object.fromEntries(["node", "pnpm", "pi", "shell", "gentleAi", "go", "globalBin", "setup"].map((name) =>
		[name, async () => { calls.push(name); if (name === "node") throw new Error("private diagnostic"); return absent; }]));
	const inventory = await collectInventory({ platform: "linux", arch: "x64", probes });
	assert.deepEqual(calls, Object.keys(probes));
	assert.deepEqual(inventory.node, { available: null });
	assert.equal(JSON.stringify(inventory).includes("private diagnostic"), false);
	assert.ok(planPreflight(inventory).blockers.length > 0);
});

test("runtime persistence intents persist only what is missing", async () => {
	const { persistencePins } = await import("../scripts/installer-preflight.mjs");
	const full = ["persist-node", "persist-package-managers", "configure-npm-prefix"];
	const persistence = [...full, "persist-npm", "persist-pnpm"];
	const stack = (node: object, pnpmPersistent?: boolean) => ({ ...clean(), node,
		pnpm: { ...tool("11.1.1"), compatible: true, ...(pnpmPersistent === undefined ? {} : { persistent: pnpmPersistent }) },
		globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true } });
	const rest = ["install-pi", "install-shell", "setup-shell", "verify-readiness"];
	// Bootstrap-only Node: the runtime and npm whatever npm reports, and pnpm only when it is bootstrap-only too.
	for (const npm of [true, false]) {
		for (const pnpm of [true, false, undefined]) {
			const group = pnpm === false ? full : ["persist-node", "persist-npm", "configure-npm-prefix"];
			assert.deepEqual(ids(stack({ ...tool("24.18.0"), persistent: false, npm }, pnpm)), [...group, ...rest]);
		}
	}
	assert.deepEqual(planPreflight(stack({ ...tool("24.18.0"), persistent: false, npm: true })).actions[0],
		{ id: "persist-node", kind: "persist-runtime", target: "node", version: persistencePins.node });
	// Persistent Node: never runtime persistence; one add for the missing npm and/or pnpm.
	const node = (npm: boolean | null) => ({ ...tool("24.18.0"), persistent: true, npm });
	assert.deepEqual(planPreflight(stack(node(false), true)).actions[0],
		{ id: "persist-npm", kind: "install-global", target: "npm", version: persistencePins.npm });
	assert.deepEqual(planPreflight(stack(node(true), false)).actions[0],
		{ id: "persist-pnpm", kind: "install-global", target: "pnpm", version: persistencePins.pnpm });
	assert.deepEqual(ids(stack(node(false), false)), ["persist-package-managers", ...rest]);
	for (const [npm, pnpm] of [[true, true], [true, undefined], [null, true]] as const) {
		assert.deepEqual(ids(stack(node(npm), pnpm)), rest);
	}
	assert.equal(ids(stack(tool("24.18.0"))).some((id) => persistence.includes(id)), false);
	assert.deepEqual(ids(stack({ ...tool("20.0.0"), persistent: false, npm: false })), []);
	const unreachable = { ...stack({ ...tool("24.18.0"), persistent: false, npm: false }),
		globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: false } };
	assert.deepEqual(ids({ ...unreachable, pnpm: { ...unreachable.pnpm, persistent: false } }).slice(0, 4), ["setup-global-bin", ...full]);
});

test("a bootstrap-only Node next to a persistent pnpm persists Node and npm only, never pnpm", async () => {
	const { persistencePins } = await import("../scripts/installer-preflight.mjs");
	const stack = (pnpm: object) => ({ ...clean(), node: { ...tool("24.18.0"), persistent: false, npm: true },
		pnpm: { ...tool("11.1.1"), compatible: true, ...pnpm }, globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true } });
	const rest = ["install-pi", "install-shell", "setup-shell", "verify-readiness"];
	// A compatible newer pnpm 11 already in $PNPM_HOME/bin (or persistent elsewhere) is kept as it is.
	// So is a Windows user pnpm in $PNPM_HOME\bin that failed the storage walk (S7): never replaced.
	for (const pnpm of [{ version: "11.5.0", persistent: true, inGlobalBin: true }, { persistent: true }, {},
		{ version: "11.9.0", persistent: true, inGlobalBin: true, untrusted: true }]) {
		const plan = planPreflight(stack(pnpm));
		assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), ["persist-node", "persist-npm", "configure-npm-prefix", ...rest], JSON.stringify(pnpm));
		assert.deepEqual(plan.actions[1], { id: "persist-npm", kind: "install-global", target: "npm", version: persistencePins.npm });
	}
	// A bootstrap-only pnpm is still persisted with npm in one add.
	assert.deepEqual(ids(stack({ persistent: false })), ["persist-node", "persist-package-managers", "configure-npm-prefix", ...rest]);
});

// An older Node or an incompatible pnpm on the user's PATH: the bootstrap's
// pinned copy runs the installer (the probe's version) and the probe reports
// the user's version as `found`. That copy is persisted; the user's stays.
const runtimeStack = (node: object, pnpm: object) => ({ ...clean(), node, pnpm,
	globalBin: { available: true, path: "/disposable/bin", writable: true, onPath: true } });
const pinnedNode = (found?: string) => ({ ...tool("24.21.0"), persistent: false, npm: false, ...(found ? { found } : {}) });
const pinnedPnpm = (found?: string) => ({ ...tool("11.1.1"), compatible: true, persistent: false, ...(found ? { found } : {}) });
const rest = ["install-pi", "install-shell", "setup-shell", "verify-readiness"];

test("an older Node is left as it is: the pinned Node is persisted alongside instead of blocking", () => {
	const plan = planPreflight(runtimeStack(pinnedNode("22.18.0"), { ...pinnedPnpm(), persistent: true }));
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(plan.tools.node, { status: "reusable", required: requirements.node, found: "22.18.0", version: "24.21.0" });
	// The user's persistent pnpm stays; only Node and npm are persisted.
	assert.deepEqual(updateIds(plan), ["persist-node", "persist-npm", "configure-npm-prefix", ...rest]);
	assert.deepEqual(updateIds(planPreflight(runtimeStack(pinnedNode("22.18.0"), pinnedPnpm()))), ["persist-node", "persist-package-managers", "configure-npm-prefix", ...rest]);
});

test("an incompatible pnpm is left as it is: the pinned pnpm is persisted alongside instead of blocking", () => {
	for (const found of ["10.27.0", "12.0.0", "11.0.0"]) {
		const persistentNode = { ...tool("24.18.0"), persistent: true, npm: true };
		const plan = planPreflight(runtimeStack(persistentNode, pinnedPnpm(found)));
		assert.deepEqual(plan.blockers, [], found);
		assert.deepEqual(plan.tools.pnpm, { status: "reusable", required: requirements.pnpm, found, version: requirements.pnpm });
		assert.deepEqual(updateIds(plan), ["persist-pnpm", ...rest]);
		// Without a genuine npm both managers are added in one step, as when pnpm is absent.
		assert.deepEqual(updateIds(planPreflight(runtimeStack({ ...persistentNode, npm: false }, pinnedPnpm(found)))), ["persist-package-managers", ...rest]);
	}
	const both = planPreflight(runtimeStack(pinnedNode("20.0.0"), pinnedPnpm("10.27.0")));
	assert.equal(both.tools.node.found, "20.0.0");
	assert.equal(both.tools.pnpm.found, "10.27.0");
	assert.deepEqual(updateIds(both), ["persist-node", "persist-package-managers", "configure-npm-prefix", ...rest]);
});

test("a found version is recorded only for a bootstrap copy replacing a stable older or incompatible one", () => {
	// A tool that meets the requirement is untouched, with or without a stray `found`.
	for (const node of [{ ...tool("24.18.0"), persistent: true, npm: true, found: "20.0.0" }, pinnedNode("24.18.0"), pinnedNode("banana")]) {
		const plan = planPreflight(runtimeStack(node, { ...pinnedPnpm(), persistent: true }));
		assert.equal(plan.tools.node.found, undefined, JSON.stringify(node));
	}
	assert.equal(planPreflight(runtimeStack(pinnedNode(), pinnedPnpm("10.27.0-beta.1"))).tools.pnpm.found, undefined);
	// The older tool itself (no bootstrap copy) or one of unknown version keeps blocking.
	for (const node of [tool("22.18.0"), { available: null }]) {
		const plan = planPreflight(runtimeStack(node, pinnedPnpm()));
		assert.ok(plan.blockers.some((b: { tool: string }) => b.tool === "node"), JSON.stringify(node));
		assert.deepEqual(plan.actions, []);
	}
	for (const pnpm of [{ ...tool("10.27.0"), compatible: false }, { available: null }]) {
		assert.ok(planPreflight(runtimeStack(pinnedNode(), pnpm)).blockers.some((b: { tool: string }) => b.tool === "pnpm"));
	}
});

test("an update of an existing installation persists nothing, so an older Node or incompatible pnpm still blocks it", () => {
	for (const [name, change] of [["node", { node: pinnedNode("22.18.0") }], ["pnpm", { pnpm: pinnedPnpm("10.27.0") }]] as const) {
		const plan = planPreflight({ ...installed(), shell: owned("3.9.0"), gentleAi: unchecked, setup: unchecked, ...change });
		assert.deepEqual(plan.blockers, [{ code: "incompatible-tool", tool: name }]);
		assert.deepEqual(plan.actions, []);
	}
});

test("a current Gentle Shell persists nothing either, so an older Node or incompatible pnpm blocks before consent", () => {
	// The runner persists runtimes only while installing Gentle Shell (planGate):
	// these plans would otherwise be rejected as unsupported after consent.
	const current = { ...installed(), shell: owned(requirements.shell) };
	const cases = [
		["node", { node: pinnedNode("22.18.0") }],
		["node", { node: pinnedNode("22.18.0"), pi: { ...tool("0.87.1"), owner: "pnpm" } }],
		["node", { node: pinnedNode("22.18.0"), setup: false }],
		["pnpm", { node: { ...tool("24.18.0"), persistent: true, npm: true }, pnpm: pinnedPnpm("10.27.0") }],
	] as const;
	for (const [name, change] of cases) {
		const plan = planPreflight({ ...current, ...change });
		assert.deepEqual(plan.blockers, [{ code: "incompatible-tool", tool: name }], JSON.stringify(change));
		assert.deepEqual(plan.actions, []);
	}
	// A setup recovery persists nothing and runs with the bootstrap's Node, as before.
	const recovery = planPreflight({ ...current, node: pinnedNode("22.18.0"), setup: recoverable });
	assert.deepEqual(recovery.blockers, []);
	assert.deepEqual(updateIds(recovery), ["setup-shell", "verify-readiness"]);
});

test("a user's pnpm in $PNPM_HOME/bin is never persisted over: an older or newer-major one blocks", () => {
	const node = { ...tool("24.18.0"), persistent: true, npm: true };
	for (const version of ["11.0.5", "12.0.0"]) {
		for (const n of [node, pinnedNode("22.18.0")]) {
			const plan = planPreflight(runtimeStack(n, { ...tool(version), compatible: false, persistent: true, inGlobalBin: true }));
			assert.ok(plan.blockers.some((b: { code: string; tool: string }) => b.code === "incompatible-tool" && b.tool === "pnpm"), version);
			assert.deepEqual(plan.actions, []);
		}
	}
	assert.deepEqual(planPreflight(runtimeStack(node, { available: null, inGlobalBin: true })).blockers, [{ code: "unknown-tool", tool: "pnpm" }]);
});

test("a user's pnpm in $PNPM_HOME/bin that could not be checked is left as it is: the bootstrap's pnpm runs, nothing is persisted over it", () => {
	const node = { ...tool("24.18.0"), persistent: true, npm: true };
	const unchecked = { ...tool("11.1.1"), compatible: true, persistent: true, inGlobalBin: true, unchecked: true };
	const rest = ["install-pi", "install-shell", "setup-shell", "verify-readiness"];
	for (const [n, persisted] of [[node, []], [pinnedNode("22.18.0"), ["persist-node", "persist-npm", "configure-npm-prefix"]]] as const) {
		const plan = planPreflight(runtimeStack(n, unchecked));
		assert.deepEqual(plan.blockers, []);
		assert.deepEqual(plan.tools.pnpm, { status: "reusable", required: requirements.pnpm, unchecked: true });
		assert.deepEqual(plan.actions.map((action: { id: string }) => action.id), [...persisted, ...rest]);
	}
	// Only that case is recorded: a checked compatible pnpm there, or an untrusted one (S7), is not.
	for (const pnpm of [{ ...unchecked, unchecked: undefined }, { ...unchecked, unchecked: undefined, untrusted: true }]) {
		assert.deepEqual(planPreflight(runtimeStack(node, pnpm)).tools.pnpm, { status: "reusable", required: requirements.pnpm });
	}
	// One whose version was read and is incompatible still blocks.
	assert.deepEqual(planPreflight(runtimeStack(node, { ...tool("11.0.5"), compatible: false, persistent: true, inGlobalBin: true })).blockers,
		[{ code: "incompatible-tool", tool: "pnpm" }]);
});

test("an older Go is left as it is: the pinned Go is acquired alongside, and a set-up stack downloads nothing", () => {
	for (const [platform, channel, change] of [["win32", "release", { gentleAi: absent }], ["darwin", "main", { shell: absent, setup: false }]] as const) {
		const plan = planPreflight({ ...installed(platform), ...change, go: tool("1.24.0") }, { channel });
		assert.deepEqual(plan.blockers, [], platform);
		assert.equal(plan.tools.go.found, "1.24.0");
		assert.deepEqual(plan.actions.filter((action: { target: string }) => action.target === "go"), goActions);
	}
	// Nothing to build: no download, even on main.
	const ready = planPreflight({ ...installed("darwin"), go: absent }, { channel: "main" });
	assert.deepEqual(ready.actions.map((action: { id: string }) => action.id), ["verify-readiness"]);
});

// S6: the Windows PNPM_HOME decision (windowsPnpmHome) the wizard records before
// any probe. A passing default leaves the plan exactly as before.
const W_DEFAULT = "C:\\Users\\m\\AppData\\Local\\pnpm";
const W_PRIVATE = "C:\\Users\\m\\.pnpm";
const weakFinding = { check: "target-acl-mask", at: "C:\\Users\\m\\AppData\\Local", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" };
test("a Windows PNPM_HOME that passes the walk leaves the plan unchanged; POSIX ignores the record", () => {
	for (const pnpmHome of [{ available: true, path: W_DEFAULT, source: "default" }, { available: true, path: "D:\\pnpm", source: "user" }]) {
		for (const inventory of [clean("win32"), installed("win32")]) assert.deepEqual(planPreflight({ ...inventory, pnpmHome }), planPreflight(inventory));
	}
	const untrusted = { available: true, path: "/home/u/.local/share/pnpm", source: "user", untrusted: weakFinding };
	assert.deepEqual(planPreflight({ ...clean("linux"), pnpmHome: untrusted }), planPreflight(clean("linux")));
	assert.deepEqual(planPreflight({ ...clean("win32"), pnpmHome: { available: null } }), planPreflight(clean("win32")), "no decision recorded");
});

test("a private Windows PNPM_HOME is recorded with the default it replaces and why, and its PATH is set up", () => {
	const pnpmHome = { available: true, path: W_PRIVATE, source: "private", rejected: { path: W_DEFAULT, ...weakFinding } };
	const plan = planPreflight({ ...clean("win32"), pnpmHome });
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(plan.tools.pnpmHome, { status: "private", path: W_PRIVATE, default: W_DEFAULT, finding: weakFinding });
	assert.deepEqual(plan.actions, planPreflight(clean("win32")).actions);
	assert.ok(plan.actions.some((action: { id: string }) => action.id === "setup-global-bin"));
	// Only known string fields reach the plan.
	const odd = planPreflight({ ...clean("win32"), pnpmHome: { ...pnpmHome, rejected: { path: W_DEFAULT, check: "target-owner", at: W_DEFAULT, sid: 7, extra: "x" } } });
	assert.deepEqual(odd.tools.pnpmHome.finding, { check: "target-owner", at: W_DEFAULT });
});

test("an untrusted Windows PNPM_HOME, or one that could not be checked, blocks before any action", () => {
	const cases = [
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weakFinding, installed: true }, "untrusted-pnpm-home"],
		[{ available: true, path: "D:\\pnpm", source: "user", untrusted: weakFinding }, "untrusted-pnpm-home"],
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weakFinding, private: { path: W_PRIVATE, foreign: true } }, "untrusted-pnpm-home"],
		[{ available: null, failed: true }, "unknown-tool"],
	] as const;
	for (const [pnpmHome, code] of cases) {
		for (const inventory of [clean("win32"), installed("win32")]) {
			const plan = planPreflight({ ...inventory, pnpmHome });
			assert.deepEqual(plan.blockers.filter((blocker: { tool: string }) => blocker.tool === "pnpmHome"), [{ code, tool: "pnpmHome" }], JSON.stringify(pnpmHome));
			assert.deepEqual(plan.actions, []);
			assert.equal(plan.ready, false);
		}
	}
	assert.equal(planPreflight({ ...clean("win32"), pnpmHome: cases[0][0] }).tools.pnpmHome.status, "untrusted");
});

// R1: a blocked Windows PNPM_HOME decision means no probe runs at all; the plan
// carries only that blocker.
test("a blocked Windows PNPM_HOME decision runs no probe and plans only that blocker", async () => {
	const cases = [
		[{ available: true, path: W_DEFAULT, source: "default", untrusted: weakFinding, installed: true }, { code: "untrusted-pnpm-home", tool: "pnpmHome" }],
		[{ available: true, path: "D:\\pnpm", source: "user", untrusted: weakFinding }, { code: "untrusted-pnpm-home", tool: "pnpmHome" }],
		[{ available: null, failed: true }, { code: "unknown-tool", tool: "pnpmHome" }],
	] as const;
	for (const [pnpmHome, blocker] of cases) {
		const called: string[] = [];
		const probes = Object.fromEntries(["node", "pnpm", "pi", "shell", "gentleAi", "go", "globalBin", "setup"]
			.map((name) => [name, async () => { called.push(name); return { available: null }; }]));
		const inventory = await collectInventory({ platform: "win32", arch: "x64", probes, pnpmHome });
		assert.deepEqual(called, [], JSON.stringify(pnpmHome));
		assert.deepEqual(inventory.pnpmHome, pnpmHome);
		const plan = planPreflight(inventory);
		assert.deepEqual([plan.blockers, plan.actions, plan.ready], [[blocker], [], false]);
		// Even with every other tool unknown, that blocker stands alone.
		assert.deepEqual(planPreflight({ ...clean("win32"), node: { available: null }, pi: { available: null }, pnpmHome }).blockers, [blocker]);
	}
	// A passing or private decision still runs every probe.
	for (const pnpmHome of [{ available: true, path: W_DEFAULT, source: "default" },
		{ available: true, path: W_PRIVATE, source: "private", rejected: { path: W_DEFAULT, ...weakFinding } }]) {
		const called: string[] = [];
		await collectInventory({ platform: "win32", arch: "x64", probes: { node: async () => { called.push("node"); return absent; } }, pnpmHome });
		assert.deepEqual(called, ["node"]);
	}
	// POSIX ignores a decision record.
	const posixCalled: string[] = [];
	await collectInventory({ platform: "linux", arch: "x64", probes: { node: async () => { posixCalled.push("node"); return absent; } },
		pnpmHome: { available: null, failed: true } });
	assert.deepEqual(posixCalled, ["node"]);
});

// S6 notice: reused tools whose folders another account can change, from one walk.
const weakFolder = { check: "parent-acl-mask", at: "C:\\Users\\m\\AppData\\Roaming", sid: "S-1-5-21-1-2-3-1002", account: "PC\\other", rights: "0x001301BF" };
const allFolders = { node: weakFolder, npm: weakFolder, go: { check: "target-owner", at: "C:\\Go\\bin\\go.exe", sid: "S-1-5-21-9" }, pi: weakFolder, shell: weakFolder };
test("Windows: collectInventory records the folders walk after the tool probes, and never blocks on it", async () => {
	const order: string[] = [];
	const probes = { ...Object.fromEntries(["node", "pnpm", "pi", "shell", "gentleAi", "go", "globalBin", "setup"].map((name) => [name, async () => { order.push(name); return absent; }])),
		folders: async () => { order.push("folders"); return { node: weakFolder }; } };
	const inventory = await collectInventory({ platform: "win32", arch: "x64", probes });
	assert.deepEqual(order, ["node", "pnpm", "pi", "shell", "gentleAi", "go", "globalBin", "setup", "folders"]);
	assert.deepEqual(inventory.folders, { node: weakFolder });
	for (const folders of [async () => null, async () => ({}), async () => ({ available: null }), async () => { throw new Error("walk failed"); }]) {
		const quiet = await collectInventory({ platform: "win32", arch: "x64", probes: { ...probes, folders } });
		assert.equal("folders" in quiet, false);
	}
	// POSIX and a blocked PNPM_HOME decision never walk.
	order.length = 0;
	assert.equal("folders" in await collectInventory({ platform: "linux", arch: "x64", probes }), false);
	assert.equal(order.includes("folders"), false);
	order.length = 0;
	await collectInventory({ platform: "win32", arch: "x64", probes, pnpmHome: { available: null, failed: true } });
	assert.deepEqual(order, []);
});

test("Windows: the plan notes only the reused tools whose folders another account can change, without blocking", () => {
	const reused = { ...clean("win32"), node: { ...tool("24.18.0"), persistent: true, npm: true }, pnpm: { ...tool("11.1.1"), compatible: true, persistent: true },
		pi: { ...tool("1.2.0"), external: true }, go: tool("1.26.0"), globalBin: { available: true, path: "C:\\Users\\m\\AppData\\Local\\pnpm\\bin", writable: true, onPath: true } };
	const plan = planPreflight({ ...reused, folders: allFolders });
	assert.deepEqual(plan.blockers, []);
	assert.deepEqual(plan.actions, planPreflight(reused).actions, "a notice changes no action");
	assert.deepEqual(plan.tools.folders, { status: "notice", reused: [{ tool: "node", ...weakFolder }, { tool: "npm", ...weakFolder }, { tool: "go", ...allFolders.go }, { tool: "pi", ...weakFolder }] },
		"Gentle Shell is installed by pnpm here, so its folder is not reused");
	assert.equal("folders" in planPreflight(reused).tools, false);
	// Not reused: a Node left for the pinned one, a missing npm, Go not needed, a Pi installed alongside.
	const replaced = planPreflight({ ...reused, node: { ...tool("24.21.0"), persistent: false, npm: false, found: "22.0.0" },
		pi: { ...tool("0.80.0"), external: true }, folders: allFolders });
	assert.deepEqual(replaced.tools.folders?.reused.map((entry: { tool: string }) => entry.tool), ["go"], "only Go, which the Windows build still reuses");
	const missingNpm = planPreflight({ ...reused, node: { ...tool("24.18.0"), persistent: true, npm: false }, folders: { npm: weakFolder } });
	assert.equal(missingNpm.tools.folders, undefined);
	// An npm-owned Gentle Shell that is kept or updated with npm is reused.
	const npmShell = planPreflight({ ...installed("win32"), node: { ...tool("24.18.0"), persistent: true, npm: true },
		shell: { ...tool(requirements.shell), global: true, owner: "npm" }, folders: { shell: weakFolder, go: weakFolder } });
	assert.deepEqual(npmShell.tools.folders?.reused.map((entry: { tool: string }) => entry.tool), ["shell"], "no build here, so Go is not reused");
	// A path the walk could not check is noted as such; an unknown code never reaches the plan.
	const unchecked = planPreflight({ ...reused, folders: { node: { check: "unchecked", at: "C:\\nodejs\\node.exe" }, pi: { check: "denied", at: "C:\\x" } } });
	assert.deepEqual(unchecked.tools.folders, { status: "notice", reused: [{ tool: "node", check: "unchecked", at: "C:\\nodejs\\node.exe" }] });
	assert.deepEqual(unchecked.blockers, []);
	// Only known string fields reach the plan; POSIX ignores the record.
	const odd = planPreflight({ ...reused, folders: { node: { ...weakFolder, sid: 7, extra: "x" }, other: weakFolder } });
	assert.deepEqual(odd.tools.folders.reused, [{ tool: "node", check: weakFolder.check, at: weakFolder.at, account: weakFolder.account, rights: weakFolder.rights }]);
	assert.equal(planPreflight({ ...reused, platform: "linux", folders: allFolders }).tools.folders, undefined);
});
