import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { distributionAsset, prefixLayout, setupEnvironment } from "../scripts/bundled-install.mjs";
import { DISTRIBUTION_RELEASES, bundledBlockedReasons, bundledFailedSteps, bundledGate, bundledPlan, fetchDistribution, runBundledInstall,
	windowsPathRegistry } from "../scripts/bundled-wizard.mjs";
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
	changes = {} as Record<string, unknown> } = {}) {
	const layout = platform === "win32" ? prefixLayout({ platform, env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" }) : posixLayout;
	const plan = bundledPlan({ platform, distribution: published, layout, path });
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
		operations: {
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
			applyPathEntry: (plan: { kind: string }, options: { registry: unknown }) => step(`path ${plan.kind} ${options.registry === registry}`, { ...plan, applied: true }),
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
		"launcher", "path profile true", "setup"]);
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
	registry.add("C:\\L\\gentle-shell\\bin");
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
	answer = "present";
	registry.add("C:\\L\\gentle-shell\\bin");
	answer = "something else";
	assert.throws(() => registry.add("C:\\L\\gentle-shell\\bin"), /user Path/);
	assert.throws(() => registry.add("relative\\bin"), /user Path/);
});
