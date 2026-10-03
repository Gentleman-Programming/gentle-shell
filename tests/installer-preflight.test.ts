import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectInventory, planPreflight, pnpmGlobalBin, requirements } from "../scripts/installer-preflight.mjs";

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

test("Windows requires compatible Go only before a missing native binary", () => {
	const inventory = { ...installed("win32"), gentleAi: absent, go: tool("1.26.0") };
	assert.equal(planPreflight(inventory).tools.go.status, "reusable");
	assert.deepEqual(ids(inventory), ["provision-native", "setup-shell", "verify-readiness"]);
	assert.ok(planPreflight({ ...inventory, go: tool("1.25.9") }).blockers.some((b: { tool: string }) => b.tool === "go"));
});

for (const [name, version] of [["node", "22.18.0"], ["pi", "0.99.0"], ["shell", "3.9.0"], ["node", "banana"], ["pi", "1.0.0-rc.1"]]) {
	test(`${name} ${version} blocks rather than replacing an existing tool`, () => {
		const inventory = { ...installed(), [name]: tool(version) };
		const plan = planPreflight(inventory);
		assert.ok(plan.blockers.some((b: { tool: string }) => b.tool === name));
		assert.deepEqual(plan.actions, []);
		assert.equal(plan.ready, false);
	});
}

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
	// Bootstrap-only Node: the full group, whatever npm and pnpm report.
	for (const npm of [true, false]) {
		for (const pnpm of [true, false, undefined]) {
			assert.deepEqual(ids(stack({ ...tool("24.18.0"), persistent: false, npm }, pnpm)), [...full, ...rest]);
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
	assert.deepEqual(ids(unreachable).slice(0, 4), ["setup-global-bin", ...full]);
});
