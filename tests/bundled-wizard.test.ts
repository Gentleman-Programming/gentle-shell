import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { distributionAsset, prefixLayout, setupEnvironment } from "../scripts/bundled-install.mjs";
import { DISTRIBUTION_RELEASES, bundledBlockedReasons, bundledFailedSteps, bundledGate, bundledPlan, fetchDistribution, migrateGlobalShell, migrationGate,
	runBundledInstall, shadowingCommand, windowsPathRegistry } from "../scripts/bundled-wizard.mjs";
import { download } from "../scripts/installer-downloads.mjs";

const manifest = { shell: "4.1.0", pi: "1.0.2" };
const lockfile = "lockfileVersion: '9.0'\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const published = { status: "published", manifest, lockfile };
const newComputer = { platform: "linux", arch: "x64", shell: { available: false } };

// Rule 1: the gate. Only a new installation of the release channel whose release publishes the assets.
test("bundledGate says yes only for a new release installation whose release publishes the distribution assets", () => {
	const gate = (changes: Record<string, unknown> = {}) => bundledGate({ channel: "release", inventory: newComputer, distribution: published, version: "4.1.0", ...changes });
	assert.equal(gate(), true);
	for (const platform of ["darwin", "linux", "win32"]) for (const arch of ["x64", "arm64"]) assert.equal(gate({ inventory: { platform, arch, shell: { available: false } } }), true);
	assert.equal(gate({ channel: "main" }), false);
	// An existing Gentle Shell (any owner) or one that could not be checked keeps the current path.
	assert.equal(gate({ inventory: { ...newComputer, shell: { available: true, version: "4.0.0", owner: "pnpm" } } }), false);
	assert.equal(gate({ inventory: { ...newComputer, shell: { available: null } } }), false);
	assert.equal(gate({ inventory: { platform: "win32", arch: "x64" } }), false);
	for (const status of ["missing", "unavailable", "rejected"]) assert.equal(gate({ distribution: { status } }), false, status);
	assert.equal(gate({ distribution: null }), false);
	// The assets must be this package's own release.
	assert.equal(gate({ version: "4.2.0" }), false);
	assert.equal(gate({ inventory: { ...newComputer, platform: "freebsd" } }), false);
	assert.equal(gate({ inventory: { ...newComputer, arch: "ia32" } }), false);
});

function fakeDownload(files: Record<string, string | number | Error>) {
	const seen: { url: string; maxBytes: number; redirectHosts: string[] }[] = [];
	return {
		seen,
		download: async (descriptor: { url: string; maxBytes: number; redirectHosts: string[] }) => {
			seen.push(descriptor);
			const value = files[descriptor.url.split("/").pop()!];
			if (value instanceof Error) throw value;
			if (typeof value === "number") throw Object.assign(new Error(`Download responded ${value}`), { status: value });
			return Buffer.from(value);
		},
	};
}

test("fetchDistribution reads the asset pair of v<version> and tells published, missing, unavailable and rejected apart", async () => {
	assert.equal(DISTRIBUTION_RELEASES, "https://github.com/Gentleman-Programming/gentle-shell/releases/download");
	const asset = distributionAsset(manifest, lockfile);
	const both = fakeDownload({ "gentle-shell-distribution.json": asset, "gentle-shell-distribution-lock.yaml": lockfile });
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: both.download }), published);
	assert.deepEqual(both.seen.map((descriptor) => descriptor.url), [`${DISTRIBUTION_RELEASES}/v4.1.0/gentle-shell-distribution.json`,
		`${DISTRIBUTION_RELEASES}/v4.1.0/gentle-shell-distribution-lock.yaml`]);
	assert.deepEqual(both.seen.map((descriptor) => descriptor.maxBytes), [64 * 1024, 8 * 1024 * 1024]);
	assert.deepEqual(both.seen[0].redirectHosts, ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
	// A release without the assets (v4.0.0 today): the lockfile is not even requested.
	const missing = fakeDownload({ "gentle-shell-distribution.json": 404 });
	assert.deepEqual(await fetchDistribution({ version: "4.0.0", download: missing.download }), { status: "missing" });
	assert.equal(missing.seen.length, 1);
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: fakeDownload({ "gentle-shell-distribution.json": asset,
		"gentle-shell-distribution-lock.yaml": 404 }).download }), { status: "missing" });
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: fakeDownload({ "gentle-shell-distribution.json": new Error("offline") }).download }),
		{ status: "unavailable" });
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: fakeDownload({ "gentle-shell-distribution.json": 500 }).download }), { status: "unavailable" });
	// A lockfile whose sha256 is not the recorded one, or another schema, is never installed.
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: fakeDownload({ "gentle-shell-distribution.json": asset,
		"gentle-shell-distribution-lock.yaml": `${lockfile}# changed\n` }).download }), { status: "rejected" });
	assert.deepEqual(await fetchDistribution({ version: "4.1.0", download: fakeDownload({ "gentle-shell-distribution.json": "{}",
		"gentle-shell-distribution-lock.yaml": lockfile }).download }), { status: "rejected" });
	const local = fakeDownload({ "gentle-shell-distribution.json": 404 });
	await fetchDistribution({ version: "4.1.0", base: "http://127.0.0.1:9/assets", download: local.download });
	assert.equal(local.seen[0].url, "http://127.0.0.1:9/assets/v4.1.0/gentle-shell-distribution.json");
});

test("download reports the HTTP status and follows a redirect only to an allowed https host", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/missing") { res.writeHead(404); res.end(); return; }
		res.writeHead(302, { location: req.url === "/to-http" ? "http://127.0.0.1/x" : "https://elsewhere.example/x" });
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	try {
		await assert.rejects(download({ url: `${base}/missing`, maxBytes: 10 }), (error: { status?: number }) => error.status === 404);
		const hosts = ["github.com", "127.0.0.1"];
		await assert.rejects(download({ url: `${base}/to-http`, maxBytes: 10, redirectHosts: hosts }), /redirect rejected/);
		await assert.rejects(download({ url: `${base}/to-elsewhere`, maxBytes: 10, redirectHosts: hosts }), /redirect rejected/);
		// Without allowed hosts, any redirect is refused, as for the pinned runtimes.
		await assert.rejects(download({ url: `${base}/to-elsewhere`, maxBytes: 10 }));
	} finally {
		server.close();
	}
});

// Rule 2: the plan the user consents to.
const posixLayout = prefixLayout({ platform: "linux", env: {}, home: "/home/u" });
const profile = { kind: "profile", path: "/home/u/.bashrc", line: "export PATH=\"/home/u/.gentle-shell/bin:$PATH\" # gentle-shell bundled install", create: false };
test("bundledPlan lists the bundled steps, the versions and the single PATH change", () => {
	const plan = bundledPlan({ platform: "linux", distribution: published, layout: posixLayout, path: profile });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id),
		["bundled-prefix", "bundled-runtime", "bundled-version", "bundled-activate", "bundled-path", "bundled-setup"]);
	assert.deepEqual(plan.blockers, []);
	assert.equal(plan.ready, false);
	assert.deepEqual(plan.bundled, { shell: "4.1.0", pi: "1.0.2", id: "4.1.0-1.0.2", lockfile: sha256(lockfile), root: "/home/u/.gentle-shell",
		bin: "/home/u/.gentle-shell/bin", node: "24.21.0", pnpm: "11.1.1", go: null, path: { kind: "profile", file: "/home/u/.bashrc", line: profile.line } });
	// Nothing to change, a link in ~/.local/bin, or a line the user adds: only the link is a step.
	const ids = (path: Record<string, unknown>) => bundledPlan({ platform: "linux", distribution: published, layout: posixLayout, path }).actions.map((a: { id: string }) => a.id);
	assert.equal(ids({ kind: "none" }).includes("bundled-path"), false);
	assert.equal(ids({ kind: "symlink", path: "/home/u/.local/bin/gentle-shell", target: "/home/u/.gentle-shell/bin/gentle-shell" }).includes("bundled-path"), true);
	const manual = bundledPlan({ platform: "linux", distribution: published, layout: posixLayout, path: { ...profile, kind: "manual", reason: "symlink" } });
	assert.equal(manual.actions.some((action: { id: string }) => action.id === "bundled-path"), false);
	assert.deepEqual(manual.bundled.path, { kind: "manual", file: "/home/u/.bashrc", line: profile.line });
	const windowsLayout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" });
	const windows = bundledPlan({ platform: "win32", distribution: published, layout: windowsLayout,
		path: { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: windowsLayout.bin } });
	assert.equal(windows.bundled.go, "1.25.14");
	assert.deepEqual(windows.bundled.path, { kind: "registry", entry: "C:\\L\\gentle-shell\\bin" });
});

// Rule 3: the fixed step order, logged like the standard runner's steps.
function harness({ platform = "linux", path = profile as Record<string, unknown>, failAt = "", setup = { status: 0, stdout: "", stderr: "" },
	changes = {} as Record<string, unknown>, migrate = undefined as Record<string, unknown> | undefined, launcher = { ok: true, reported: "", stderr: "" },
	removed = true, applied = true } = {}) {
	const layout = platform === "win32" ? prefixLayout({ platform, env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" }) : posixLayout;
	const plan = bundledPlan({ platform, distribution: published, layout, path, ...(migrate ? { migrate } : {}) });
	const calls: string[] = [];
	const log: { step: string; status: string; reason?: string }[] = [];
	const runs: { command: string; args: string[]; options: { env: Record<string, string>; cwd: string } }[] = [];
	const step = (name: string, value: unknown) => {
		calls.push(name);
		if (failAt === name) throw Object.assign(new Error(`${name} failed`), { stderr: "ERR_PNPM_FETCH_401 GET https://npm.acme.dev/x: Unauthorized - 401" });
		return value;
	};
	const registry = { add: () => {}, remove: () => {} };
	const adapters = {
		platform, arch: "x64", env: { PATH: "/usr/bin", HOME: "/home/u" }, home: platform === "win32" ? "C:\\U" : "/home/u", distribution: published, registry,
		log: (entry: { step: string; status: string }) => log.push(entry),
		removeGlobal: async (manager: string) => step(`remove ${manager}`, removed),
		operations: {
			checkLauncher: async (_: unknown, options: { id: string; shell: string; pi: string; launcher: boolean }) =>
				step(`check ${options.id} ${options.shell} ${options.pi} launcher=${options.launcher}`, launcher),
			// The runner claims exactly the consented folder (claimPrefix refuses another one).
			claimPrefix: (options: { root?: string }) => { assert.equal(options.root, plan.bundled.root); return step("claim", layout); },
			userNpmrc: () => "registry=https://r.example/\nsave-exact=true\n",
			writeNpmrcAuth: (_: unknown, text: string) => step(`npmrc ${text.trim()}`, undefined),
			ensureRuntime: async (options: { go: boolean }) => step(`runtime go=${options.go}`, { node: layout.node, pnpm: layout.pnpm, go: options.go ? "C:\\L\\gentle-shell\\runtime\\go\\1.25.14\\go\\bin\\go.exe" : null, acquired: [] }),
			installVersion: async (options: { manifest: typeof manifest; lockfile: string; go: string | null }) =>
				step(`install ${options.manifest.shell}-${options.manifest.pi} ${options.lockfile === lockfile} go=${options.go !== null}`, { id: "4.1.0-1.0.2", path: "", installed: true }),
			activateVersion: (_: unknown, id: string) => step(`activate ${id}`, { id, previous: null }),
			ensureLauncher: () => step("launcher", { written: true }),
			pathEntryPlan: () => path,
			applyPathEntry: (plan: { kind: string }, options: { registry: unknown }) => step(`path ${plan.kind} ${options.registry === registry}`, { ...plan, applied }),
			writePathReceipt: (written: unknown, receipt: { kind: string }) => step(`receipt ${receipt.kind} ${written === layout}`, true),
			removePathEntry: (receipt: { kind: string }, options: { registry: unknown }) => step(`unpath ${receipt.kind} ${options.registry === registry}`, undefined),
			run: async (command: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
				runs.push({ command, args, options });
				return step("setup", setup);
			},
		},
		...changes,
	};
	return { layout, plan, calls, log, runs, adapters, run: (request: Record<string, unknown> = { plan, consent: true }) => runBundledInstall(request, adapters) };
}

test("runBundledInstall claims, copies the npm settings, installs runtimes and the version, activates, writes the launcher and the PATH entry, then sets up", async () => {
	const h = harness();
	const result = await h.run();
	const steps = ["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher", "bundled-path", "shell-setup"];
	assert.deepEqual(result, { outcome: "terminal-action-required", action: "open-new-terminal", completed: steps });
	assert.deepEqual(h.log, steps.map((step) => ({ step, status: "done" })));
	// writeNpmrcAuth gets the user's npmrc text and keeps only the S12 keys itself.
	assert.deepEqual(h.calls, ["claim", "npmrc registry=https://r.example/\nsave-exact=true", "runtime go=false", "install 4.1.0-1.0.2 true go=false", "activate 4.1.0-1.0.2",
		"launcher", "path profile true", "receipt profile true", "setup"]);
	// Setup runs through the launcher, in the bundled setup environment.
	assert.equal(h.runs[0].command, h.layout.launcher);
	assert.deepEqual(h.runs[0].args, ["setup"]);
	assert.deepEqual(h.runs[0].options.env, setupEnvironment(h.layout, { platform: "linux", env: h.adapters.env, id: "4.1.0-1.0.2" }));
	// No PATH change needed, or a link into a folder already on PATH: ready at once.
	for (const path of [{ kind: "none" }, { kind: "symlink", path: "/home/u/.local/bin/gentle-shell", target: "/home/u/.gentle-shell/bin/gentle-shell" }]) {
		const ready = await harness({ path }).run();
		assert.equal(ready.outcome, "ready", path.kind);
		assert.equal(ready.completed.includes("bundled-path"), path.kind === "symlink");
	}
	// A profile the installer may not edit: the user adds the exact line.
	const manual = await harness({ path: { ...profile, kind: "manual", reason: "symlink" } }).run();
	assert.deepEqual(manual, { outcome: "terminal-action-required", action: "add-path-line", pathLine: { file: profile.path, line: profile.line },
		completed: steps.filter((step) => step !== "bundled-path") });
});

test("runBundledInstall on Windows installs the pinned Go, writes the user Path through the registry and runs setup with our Node", async () => {
	const h = harness({ platform: "win32", path: { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\L\\gentle-shell\\bin" } });
	const result = await h.run();
	assert.equal(result.outcome, "terminal-action-required");
	assert.deepEqual(h.calls.slice(2, 4), ["runtime go=true", "install 4.1.0-1.0.2 true go=true"]);
	assert.ok(h.calls.includes("path registry true"));
	// A .cmd launcher would need cmd.exe: setup runs the same Node and entry it runs.
	assert.equal(h.runs[0].command, h.layout.node);
	assert.deepEqual(h.runs[0].args, ["C:\\L\\gentle-shell\\versions\\4.1.0-1.0.2\\node_modules\\gentle-pi\\bin\\gentle-shell.mjs", "setup"]);
});

// T6 (S7): the applied PATH entry is kept in the prefix, so self-uninstall reverts exactly it.
test("runBundledInstall keeps the receipt of the PATH entry it applied, writes none when nothing was applied, and reverts the entry when the receipt cannot be kept", async () => {
	const windows = harness({ platform: "win32", path: { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\L\\gentle-shell\\bin" } });
	await windows.run();
	assert.deepEqual(windows.calls.filter((call) => /^(path|receipt|unpath) /.test(call)), ["path registry true", "receipt registry true"]);
	const present = harness({ applied: false });
	assert.equal((await present.run()).outcome, "terminal-action-required");
	assert.deepEqual(present.calls.filter((call) => /^(path|receipt|unpath) /.test(call)), ["path profile true"]);
	const unwritable = harness();
	unwritable.adapters.operations.writePathReceipt = () => { throw new Error("EACCES"); };
	const failed = await unwritable.run();
	assert.equal(failed.failedStep, "bundled-path");
	assert.deepEqual(unwritable.calls.filter((call) => /^(path|receipt|unpath) /.test(call)), ["path profile true", "unpath profile true"]);
	assert.equal(unwritable.calls.includes("setup"), false);
});

test("runBundledInstall stops at the first failed step, keeps what finished and reports pnpm's or setup's last error line", async () => {
	const h = harness({ failAt: "install 4.1.0-1.0.2 true go=false" });
	assert.deepEqual(await h.run(), { outcome: "failed", failedStep: "install-version", completed: ["claim-prefix", "copy-npm-settings", "install-runtime"],
		detail: "ERR_PNPM_FETCH_401 GET https://npm.acme.dev/x: Unauthorized - 401" });
	assert.equal(h.log.at(-1)?.status, "failed");
	assert.equal(h.calls.includes("launcher"), false);
	const setup = await harness({ setup: { status: 1, stdout: "", stderr: "working\nError: GitHub API rate limit exceeded\n" } }).run();
	assert.equal(setup.failedStep, "shell-setup");
	assert.equal(setup.detail, "Error: GitHub API rate limit exceeded");
	const claim = await harness({ failAt: "claim" }).run();
	assert.deepEqual(claim, { outcome: "failed", failedStep: "claim-prefix", completed: [] });
	// The PATH change differs from the consented one: nothing is written.
	const moved = harness();
	moved.adapters.operations.pathEntryPlan = () => ({ ...profile, path: "/home/u/.profile" });
	const changed = await moved.run();
	assert.equal(changed.failedStep, "bundled-path");
	assert.equal(moved.calls.some((call) => call.startsWith("path ")), false);
	for (const step of [...new Set(["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher", "bundled-path", "shell-setup"])]) {
		assert.ok(bundledFailedSteps.includes(step), step);
	}
});

test("runBundledInstall blocks before any change without consent, on a modified plan, or when the assets are not the consented ones", async () => {
	const h = harness();
	const cases: [Record<string, unknown>, string, Record<string, unknown>?][] = [
		[{ plan: h.plan, consent: false }, "consent-required"],
		[{ plan: { ...h.plan, bundled: undefined }, consent: true }, "invalid-request"],
		[{ plan: { ...h.plan, actions: h.plan.actions.slice(1) }, consent: true }, "invalid-request"],
		[{ plan: { ...h.plan, bundled: { ...h.plan.bundled, id: "4.1.0-9.9.9" } }, consent: true }, "invalid-request"],
		[{ plan: h.plan, consent: true }, "invalid-request", { distribution: { ...published, lockfile: "other" } }],
		[{ plan: h.plan, consent: true }, "invalid-request", { distribution: null }],
	];
	for (const [request, reason, changes] of cases) {
		const blocked = harness({ changes });
		assert.deepEqual(await blocked.run(request), { outcome: "blocked", reason, completed: [] });
		assert.deepEqual(blocked.calls, []);
		assert.deepEqual(blocked.log, [{ step: "gate", status: "blocked", reason }]);
		assert.ok(bundledBlockedReasons.includes(reason));
	}
});

test("windowsPathRegistry edits only the HKCU user Path through Windows PowerShell, with the entry as data", () => {
	const seen: { command: string; args: string[]; env: Record<string, string> }[] = [];
	let answer = "added";
	const registry = windowsPathRegistry({ SystemRoot: "C:\\Windows", Path: "C:\\Windows" }, (command: string, args: string[], env: Record<string, string>) => {
		seen.push({ command, args, env });
		return answer;
	});
	assert.equal(registry.add("C:\\L\\gentle-shell\\bin"), "added");
	answer = "removed";
	registry.remove("C:\\L\\gentle-shell\\bin");
	assert.equal(seen[0].command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.deepEqual(seen[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
	// The script is fixed: the entry and the mode travel as environment data only.
	assert.equal(seen[0].args[4], seen[1].args[4]);
	assert.equal(seen[0].args[4].includes("gentle-shell\\bin"), false);
	assert.match(seen[0].args[4], /DoNotExpandEnvironmentNames/);
	assert.deepEqual([seen[0].env.GENTLE_BUNDLED_PATH_ENTRY, seen[0].env.GENTLE_BUNDLED_PATH_MODE], ["C:\\L\\gentle-shell\\bin", "add"]);
	assert.equal(seen[1].env.GENTLE_BUNDLED_PATH_MODE, "remove");
	// What applyPathEntry reads: an entry the user Path already held was not applied.
	answer = "present";
	assert.equal(registry.add("C:\\L\\gentle-shell\\bin"), "present");
	answer = "something else";
	assert.throws(() => registry.add("C:\\L\\gentle-shell\\bin"), /user Path/);
	assert.throws(() => registry.add("relative\\bin"), /user Path/);
});

// T3 (S4): an existing Gentle Shell owned by a global pnpm or npm moves to the bundled prefix.
const owned = (owner: unknown, version = "4.0.0") => ({ platform: "linux", arch: "x64", shell: { available: true, version, usable: true, global: true, owner } });
test("migrationGate names the owner only for a pnpm or npm Gentle Shell on release whose release publishes the assets", () => {
	const gate = (changes: Record<string, unknown> = {}) => migrationGate({ channel: "release", inventory: owned("pnpm"), distribution: published, version: "4.1.0", ...changes });
	assert.equal(gate(), "pnpm");
	assert.equal(gate({ inventory: owned("npm") }), "npm");
	assert.equal(gate({ inventory: owned("npm", "4.1.0") }), "npm", "the same version moves too");
	// An npm link or an unknown owner, main, no assets or another release: never migrated.
	for (const owner of [null, undefined, "linked"]) assert.equal(gate({ inventory: owned(owner) }), null, String(owner));
	assert.equal(gate({ channel: "main" }), null);
	for (const status of ["missing", "unavailable", "rejected"]) assert.equal(gate({ distribution: { status } }), null, status);
	assert.equal(gate({ version: "4.2.0" }), null);
	assert.equal(gate({ inventory: { ...owned("pnpm"), platform: "freebsd" } }), null);
	assert.equal(gate({ inventory: newComputer }), null);
	// A newer Gentle Shell than this release is never replaced by an older one.
	assert.equal(gate({ inventory: owned("pnpm", "4.2.0") }), null);
	// The new-installation gate is unchanged for an existing Gentle Shell.
	assert.equal(bundledGate({ channel: "release", inventory: owned("pnpm"), distribution: published, version: "4.1.0" }), false);
});

test("bundledPlan for a migration adds the final remove-global-shell action, or leaves setup and the removal question to the upgrade", () => {
	const plan = bundledPlan({ platform: "linux", distribution: published, layout: posixLayout, path: profile, migrate: { manager: "pnpm", removal: "plan" } });
	assert.deepEqual(plan.actions.map((action: { id: string }) => action.id),
		["bundled-prefix", "bundled-runtime", "bundled-version", "bundled-activate", "bundled-path", "bundled-setup", "remove-global-shell"]);
	assert.deepEqual(plan.bundled.migrate, { manager: "pnpm", command: "pnpm remove -g gentle-pi", removal: "plan" });
	const ask = bundledPlan({ platform: "linux", distribution: published, layout: posixLayout, path: profile, migrate: { manager: "npm", removal: "ask" } });
	assert.deepEqual(ask.actions.map((action: { id: string }) => action.id), ["bundled-prefix", "bundled-runtime", "bundled-version", "bundled-activate", "bundled-path"]);
	assert.deepEqual(ask.bundled.migrate, { manager: "npm", command: "npm uninstall -g gentle-pi", removal: "ask" });
});

test("runBundledInstall for a migration checks the launcher's versions, then removes the old global gentle-pi last", async () => {
	const h = harness({ migrate: { manager: "pnpm", removal: "plan" } });
	const steps = ["claim-prefix", "copy-npm-settings", "install-runtime", "install-version", "activate-version", "write-launcher", "verify-launcher", "bundled-path",
		"shell-setup", "remove-global-shell"];
	assert.deepEqual(await h.run(), { outcome: "terminal-action-required", action: "open-new-terminal", completed: steps,
		removeGlobal: { status: "removed", command: "pnpm remove -g gentle-pi" } });
	assert.deepEqual(h.calls.slice(-5), ["check 4.1.0-1.0.2 4.1.0 1.0.2 launcher=true", "path profile true", "receipt profile true", "setup", "remove pnpm"]);
	// A launcher that does not report both versions: no PATH change, and the old global gentle-pi is never removed.
	// The detail names what the launcher reported and what was expected (A1).
	const broken = harness({ migrate: { manager: "pnpm", removal: "plan" }, launcher: { ok: false, reported: "gentle-shell 4.0.0\npi 1.0.0", stderr: "Error: no Pi\n" } });
	assert.deepEqual(await broken.run(), { outcome: "failed", failedStep: "verify-launcher", completed: steps.slice(0, 6),
		detail: 'gentle-shell --version reported "gentle-shell 4.0.0 / pi 1.0.0" instead of "gentle-shell 4.1.0 / pi 1.0.2"' });
	const silent = harness({ migrate: { manager: "pnpm", removal: "plan" }, launcher: { ok: false, reported: "", stderr: "Error: Cannot find module /home/u/x\n" } });
	assert.equal((await silent.run()).detail, 'gentle-shell --version reported nothing instead of "gentle-shell 4.1.0 / pi 1.0.2": Error: Cannot find module ~/x');
	assert.equal(broken.calls.some((call) => call.startsWith("remove") || call.startsWith("path ")), false);
	assert.ok(bundledFailedSteps.includes("verify-launcher"));
	// B3: any failed migration step carries its error message as the detail; a new install's does not.
	assert.deepEqual(await harness({ migrate: { manager: "pnpm", removal: "plan" }, failAt: "claim" }).run(),
		{ outcome: "failed", failedStep: "claim-prefix", completed: [], detail: "claim failed" });
	assert.deepEqual(await harness({ failAt: "claim" }).run(), { outcome: "failed", failedStep: "claim-prefix", completed: [] });
	// A failed removal keeps the bundled install and names the manual command.
	const kept = await harness({ migrate: { manager: "npm", removal: "plan" }, removed: false }).run();
	assert.equal(kept.outcome, "terminal-action-required");
	assert.deepEqual(kept.removeGlobal, { status: "failed", command: "npm uninstall -g gentle-pi" });
	// A plan whose removal command was changed is not the consented one.
	const forged = harness({ migrate: { manager: "pnpm", removal: "plan" } });
	const plan = { ...forged.plan, bundled: { ...forged.plan.bundled, migrate: { ...forged.plan.bundled.migrate, command: "rm -rf ~" } } };
	assert.deepEqual(await forged.run({ plan, consent: true }), { outcome: "blocked", reason: "invalid-request", completed: [] });
	// The upgrade's plan has no setup and no removal step; its launcher check still runs.
	const upgrade = harness({ migrate: { manager: "pnpm", removal: "ask" } });
	assert.deepEqual((await upgrade.run()).completed, steps.slice(0, 8));
	assert.equal(upgrade.runs.length, 0);
});

// A POSIX or Windows PATH, looked up through an injected filesystem only.
function lookup(files: Record<string, string>) {
	return { exists: (path: string) => Object.hasOwn(files, path), realpath: (path: string) => files[path] ?? path };
}
test("shadowingCommand names the old gentle-shell a new terminal would still find before the bundled launcher", () => {
	const launcher = posixLayout.launcher;
	const oldBin = "/home/u/Library/pnpm/gentle-shell";
	const fs = lookup({ [oldBin]: oldBin, [launcher]: launcher, "/home/u/.local/bin/gentle-shell": launcher });
	const env = { PATH: "/home/u/Library/pnpm:/home/u/.local/bin:/usr/bin" };
	const check = (pathKind: string, changes: Record<string, unknown> = {}) =>
		shadowingCommand({ platform: "linux", env, layout: posixLayout, pathKind, fs, ...changes });
	// A link in ~/.local/bin after PNPM_HOME on PATH: the old one still runs.
	assert.equal(check("symlink"), oldBin);
	// A profile line puts the bundled bin first.
	assert.equal(check("profile"), null);
	assert.equal(check("manual"), null);
	assert.equal(check("symlink", { env: { PATH: "/home/u/.local/bin:/home/u/Library/pnpm" } }), null);
	// zsh (.zshrc, after .zprofile) and bash (the login file or .bashrc, our line appended last) put the bundled bin first.
	for (const profile of ["/home/u/.zshrc", "/home/u/.bash_profile", "/home/u/.bashrc", "/home/u/.profile"]) {
		assert.equal(check("profile", { profile }), null, profile);
	}
	// B1: fish reads conf.d/gentle-shell.fish before config.fish, so anything config.fish prepends
	// (pnpm setup's PNPM_HOME block) comes first: the bundled bin counts as last.
	const fish = "/home/u/.config/fish/conf.d/gentle-shell.fish";
	assert.equal(check("profile", { profile: fish }), oldBin);
	assert.equal(check("manual", { profile: fish }), oldBin);
	assert.equal(check("profile", { profile: fish, fs: lookup({ [launcher]: launcher }) }), null);
	assert.equal(check("none", { env: { PATH: `/home/u/Library/pnpm:${posixLayout.bin}` } }), oldBin);
	assert.equal(check("none", { fs: lookup({ [launcher]: launcher, "/home/u/.local/bin/gentle-shell": launcher }) }), null);
	// Windows: the user Path entry comes after everything already on PATH.
	const windows = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" });
	const oldCmd = "C:\\U\\AppData\\Local\\pnpm\\gentle-shell.cmd";
	const winFs = lookup({ [oldCmd]: oldCmd, [windows.launcher]: windows.launcher });
	assert.equal(shadowingCommand({ platform: "win32", env: { Path: "C:\\U\\AppData\\Local\\pnpm;C:\\Windows" }, layout: windows, pathKind: "registry", fs: winFs }), oldCmd);
	assert.equal(shadowingCommand({ platform: "win32", env: { Path: "C:\\Windows" }, layout: windows, pathKind: "registry", fs: winFs }), null);
});

/** migrateGlobalShell with fake operations: the bundled steps and the manager run are recorded. */
function migration({ owner = "pnpm" as string | null, distribution = published as Record<string, unknown>, interactive = true, answer = "y", removal = 0,
	failAt = "", pathKind = "profile", shadow = false, currentVersion = "4.0.0", fish = false } = {}) {
	const calls: string[] = [];
	let ownerCalls = 0;
	const lines: string[] = [];
	const asked: string[] = [];
	const fishLine = "set -gx PATH '/home/u/.gentle-shell/bin' $PATH # gentle-shell bundled install";
	const path = pathKind === "profile" ? (fish ? { kind: "profile", path: "/home/u/.config/fish/conf.d/gentle-shell.fish", line: fishLine, create: true } : profile)
		: { kind: pathKind };
	const home = "/home/u";
	const oldBin = "/home/u/Library/pnpm/gentle-shell";
	const files: Record<string, string> = { [posixLayout.launcher]: posixLayout.launcher, ...(shadow ? { [oldBin]: oldBin } : {}) };
	const manager = { name: owner, command: `/usr/bin/${owner}`, prefix: [] };
	const operations = {
		prefixRoot: () => undefined,
		claimPrefix: () => {
			calls.push("claim");
			if (failAt === "claim") throw new Error("Unsafe bundled prefix: /home/u/.gentle-shell");
			return posixLayout;
		},
		userNpmrc: () => "",
		writeNpmrcAuth: () => calls.push("npmrc"),
		ensureRuntime: async () => { calls.push("runtime"); return { node: posixLayout.node, pnpm: posixLayout.pnpm, go: null }; },
		installVersion: async () => {
			calls.push("install");
			if (failAt === "install") throw new Error("pnpm install failed");
			return { id: "4.1.0-1.0.2", path: "", installed: true };
		},
		activateVersion: () => calls.push("activate"),
		ensureLauncher: () => calls.push("launcher"),
		pathEntryPlan: () => { if (failAt === "plan") throw new Error("Unsafe bundled bin path"); return path; },
		applyPathEntry: () => calls.push("path"),
		checkLauncher: async () => { calls.push("check"); return { ok: failAt !== "check", reported: "", stderr: "" }; },
		run: async () => { calls.push("setup"); return { status: 0 }; },
	};
	const run = async (command: string, argv: string[]) => { calls.push(`${command} ${argv.join(" ")}`); return { code: removal, stdout: "" }; };
	const migrate = () => migrateGlobalShell({ latest: "4.1.0", currentVersion, platform: "linux", arch: "x64",
		env: { PATH: "/home/u/Library/pnpm:/usr/bin", HOME: home }, home, interactive,
		ask: async (question: string) => { asked.push(question); return answer; }, out: (line: string) => lines.push(line),
		adapters: { owner: async () => { ownerCalls += 1; if (!owner) throw new Error("neither pnpm nor npm owns /src/gentle-shell"); return manager; },
			distribution: async (version: string) => { calls.push(`assets ${version}`); return distribution; }, run, operations, fs: lookup(files) } });
	return { calls, lines, asked, migrate, owners: () => ownerCalls };
}

test("migrateGlobalShell explains, installs the bundled prefix, checks the launcher, then asks once and removes the old gentle-pi with its own manager", async () => {
	const m = migration();
	assert.deepEqual(await m.migrate(), { code: 0, installed: true });
	assert.deepEqual(m.calls, ["assets 4.1.0", "claim", "npmrc", "runtime", "install", "activate", "launcher", "check", "path", "/usr/bin/pnpm remove -g gentle-pi"]);
	const text = m.lines.join("\n");
	assert.match(text, /\/home\/u\/\.gentle-shell/);
	assert.match(text, /Pi 1\.0\.2/);
	assert.match(text, /Node\.js, npm, pnpm and Pi are not used or changed/);
	assert.match(text, /~\/\.gentle-shell\/agent/);
	assert.deepEqual(m.asked, ["Remove the old global gentle-pi with pnpm (pnpm remove -g gentle-pi)? [y/N] "]);
	assert.match(text, /Removed the old global gentle-pi/);
	assert.match(text, /Open a new terminal/);
});

test("migrateGlobalShell keeps the old gentle-pi on No, on EOF and without a terminal, and says which gentle-shell a new terminal runs", async () => {
	for (const answer of ["", "n", "no"]) {
		const m = migration({ answer, pathKind: "symlink", shadow: true });
		assert.deepEqual(await m.migrate(), { code: 0, installed: true }, answer);
		assert.equal(m.calls.some((call) => call.includes(" remove ")), false);
		const text = m.lines.join("\n");
		assert.match(text, /pnpm remove -g gentle-pi/);
		// The old global bin comes before ~/.local/bin, so the old one still runs.
		assert.match(text, /\/home\/u\/Library\/pnpm\/gentle-shell/);
	}
	const batch = migration({ interactive: false });
	assert.deepEqual(await batch.migrate(), { code: 0, installed: true });
	assert.deepEqual(batch.asked, []);
	assert.equal(batch.calls.some((call) => call.includes(" remove ")), false);
	assert.match(batch.lines.join("\n"), /To remove it, run: pnpm remove -g gentle-pi/);
});

test("migrateGlobalShell never removes after a failed step: it names the step and its detail, then hands back to the global update", async () => {
	// B3: null, so `gentle-shell upgrade` continues with the global package's own update this run.
	const expected: Record<string, RegExp> = { plan: /could not be planned: Unsafe bundled bin path/, claim: /stopped at claim-prefix: Unsafe bundled prefix: ~\/\.gentle-shell/,
		install: /stopped at install-version/, check: /stopped at verify-launcher/ };
	for (const failAt of ["plan", "claim", "install", "check"]) {
		const m = migration({ failAt });
		assert.equal(await m.migrate(), null, failAt);
		assert.deepEqual(m.asked, []);
		assert.equal(m.calls.some((call) => call.includes(" remove ")), false);
		const text = m.lines.join("\n");
		assert.match(text, expected[failAt], failAt);
		assert.match(text, /global gentle-pi was left untouched/);
	}
	const npm = migration({ owner: "npm", removal: 1 });
	assert.deepEqual(await npm.migrate(), { code: 1, installed: true });
	assert.ok(npm.calls.includes("/usr/bin/npm uninstall -g gentle-pi"));
	assert.match(npm.lines.join("\n"), /could not be removed.*npm uninstall -g gentle-pi/s);
});

test("migrateGlobalShell leaves an npm link, a release without the assets and main alone", async () => {
	const linked = migration({ owner: null });
	assert.equal(await linked.migrate(), null);
	assert.deepEqual(linked.calls, ["assets 4.1.0"]);
	assert.match(linked.lines.join("\n"), /not a global pnpm or npm package/);
	// B2: without published assets, or with a newer installed Gentle Shell, the owner (npm root -g) is never probed.
	for (const status of ["missing", "unavailable", "rejected"]) {
		const m = migration({ distribution: { status } });
		assert.equal(await m.migrate(), null, status);
		assert.deepEqual(m.calls, ["assets 4.1.0"]);
		assert.deepEqual(m.lines, []);
		assert.equal(m.owners(), 0, status);
	}
	const newer = migration({ currentVersion: "4.2.0" });
	assert.equal(await newer.migrate(), null);
	assert.equal(newer.owners(), 0);
	assert.equal(linked.owners(), 1);
});

test("migrateGlobalShell in fish reports the kept old gentle-shell, which config.fish puts before the conf.d line", async () => {
	const m = migration({ fish: true, shadow: true, answer: "n" });
	assert.deepEqual(await m.migrate(), { code: 0, installed: true });
	assert.match(m.lines.join("\n"), /New terminals still run \/home\/u\/Library\/pnpm\/gentle-shell/);
	assert.match(m.lines.join("\n"), /pnpm remove -g gentle-pi/);
});
