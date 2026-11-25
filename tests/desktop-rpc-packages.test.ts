import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc, { type DesktopRpcExtensionOptions } from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_PACKAGES_EVENTS,
	DESKTOP_PACKAGES_METHODS,
	INVALID_INSTALL_PACKAGE,
	INVALID_LIST_PACKAGES,
	INVALID_REMOVE_PACKAGE,
	PACKAGE_JOB_RUNNING,
	progressLines,
} from "../lib/desktop-rpc-packages.ts";
import { cliPackageRunner, GENTLE_SHELL_LAUNCH_ENV, packageCli, settingsPackages, type PackageJobInput } from "../lib/desktop-packages-service.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Package installs and removals from a client: jobs through the real Desktop
// transport over a fake installer (no npm, no git, no network), the production
// runner over a fake CLI script, and the listing over a temporary agent home.

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function scratch(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gs-pkg-")));
	roots.push(root);
	return root;
}

/** A fake installer a test drives: each call waits until the test finishes it. */
function fakeInstaller() {
	const calls: Array<PackageJobInput & { finish: (outcome: { ok: true } | { ok: false; error: string }) => void }> = [];
	return {
		calls,
		runner: (input: PackageJobInput) => {
			const { promise, resolve } = Promise.withResolvers<{ ok: true } | { ok: false; error: string }>();
			calls.push({ ...input, finish: resolve });
			input.signal.addEventListener("abort", () => resolve({ ok: false, error: (input.signal.reason as Error).message }), { once: true });
			return promise;
		},
	};
}

function setup(t: test.TestContext, options: DesktopRpcExtensionOptions = {}) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
		registerShortcut() {},
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { on() { return () => {}; }, emit() {} },
	} as unknown as ExtensionAPI;
	desktopRpc(pi, options);
	const widgets: string[] = [];
	const session = { idle: Promise.withResolvers<void>(), reloads: 0, waited: 0, linesAtReload: -1 };
	session.idle.resolve();
	const ctx = {
		mode: "rpc",
		cwd: "/work/project",
		sessionManager: { getCwd: () => "/work/project", getSessionId: () => "s", getEntries: () => [] },
		ui: { setWidget(_key: string, lines: string[]) { widgets.push(...lines); } },
		// The command context's `/reload`, which a successful job runs once the agent is idle.
		waitForIdle: () => { session.waited += 1; return session.idle.promise; },
		reload: async () => { session.reloads += 1; session.linesAtReload = widgets.length; },
	};
	for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
	const parsed = () => widgets.map((line) => JSON.parse(line));
	const app = {
		widgets,
		session,
		async call(requestId: string, method: string, params: Record<string, unknown> = {}) {
			await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
			return parsed().findLast((line) => line.kind === "response" && line.requestId === requestId);
		},
		events(name: string) {
			return parsed().filter((line) => line.kind === "event" && line.event === name).map((line) => line.data);
		},
		async until(check: () => boolean, what: string) {
			const deadline = Date.now() + 5000;
			while (!check()) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		async shutdown() { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
	};
	return app;
}

test("the slice advertises its methods and events", () => {
	assert.deepEqual([...DESKTOP_PACKAGES_METHODS], ["list_packages", "install_package", "remove_package"]);
	assert.deepEqual([...DESKTOP_PACKAGES_EVENTS], ["package_progress", "package_finished"]);
});

test("an install is a job: its id first, then its lines, then one finish, then the session reloads once idle", async (t) => {
	const installer = fakeInstaller();
	const app = setup(t, { packages: { runner: installer.runner } });
	const started = await app.call("i-1", "install_package", { source: "npm:@scope/tool@1.2.0" });
	assert.equal(started.ok, true);
	const { jobId } = started.data;
	assert.match(jobId, /^pkg_[0-9a-f]{16}$/);
	await app.until(() => installer.calls.length === 1, "the installer to start");
	const call = installer.calls[0]!;
	assert.deepEqual({ action: call.action, source: call.source, scope: call.scope, cwd: call.cwd }, { action: "install", source: "npm:@scope/tool@1.2.0", scope: "user", cwd: "/work/project" });
	assert.deepEqual((await app.call("i-2", "remove_package", { source: "npm:other" })).error, PACKAGE_JOB_RUNNING, "one job at a time");

	call.onLine("Installing npm:@scope/tool@1.2.0...");
	call.onLine("added 3 packages");
	assert.ok(app.widgets.findIndex((line) => line.includes('"requestId":"i-1"')) < app.widgets.findIndex((line) => line.includes('"event":"package_progress"')));
	call.finish({ ok: true });
	await app.until(() => app.session.reloads === 1, "the reload");
	assert.deepEqual(app.events("package_progress"), [{ jobId, line: "Installing npm:@scope/tool@1.2.0..." }, { jobId, line: "added 3 packages" }]);
	assert.deepEqual(app.events("package_finished"), [{ jobId, ok: true }]);
	assert.equal(app.session.waited, 1, "the reload waited for the agent to be idle");
	// The finish is published before the reload tears the session's extensions down.
	const finishedAt = app.widgets.findIndex((line) => line.includes('"event":"package_finished"'));
	assert.ok(finishedAt >= 0 && finishedAt < app.session.linesAtReload);

	// The next job may start once the first finished.
	const removal = await app.call("i-3", "remove_package", { source: "npm:@scope/tool", scope: "project" });
	await app.until(() => installer.calls.length === 2, "the removal to start");
	assert.deepEqual({ action: installer.calls[1]!.action, scope: installer.calls[1]!.scope }, { action: "remove", scope: "project" });
	installer.calls[1]!.finish({ ok: false, error: "No matching package found for npm:@scope/tool" });
	await app.until(() => app.events("package_finished").length === 2, "the removal to finish");
	assert.deepEqual(app.events("package_finished")[1], { jobId: removal.data.jobId, ok: false, error: "No matching package found for npm:@scope/tool" });
	assert.equal(app.session.reloads, 1, "a failed job reloads nothing");
});

test("a job is stopped at its time limit, and a session change stops it without events", async (t) => {
	const installer = fakeInstaller();
	const app = setup(t, { packages: { runner: installer.runner, timeoutMs: 20 } });
	const { data: { jobId } } = await app.call("t-1", "install_package", { source: "npm:slow" });
	await app.until(() => app.events("package_finished").length === 1, "the time limit");
	assert.deepEqual(app.events("package_finished"), [{ jobId, ok: false, error: "Stopped: it ran past the time limit" }]);
	assert.equal(installer.calls[0]!.signal.aborted, true);

	const other = setup(t, { packages: { runner: installer.runner } });
	await other.call("t-2", "install_package", { source: "npm:slow" });
	await other.until(() => installer.calls.length === 2, "the second job");
	await other.shutdown();
	assert.equal(installer.calls[1]!.signal.aborted, true, "the job is stopped with the session");
	for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(other.events("package_finished"), []);
	assert.equal(other.session.reloads, 0);
});

test("requests are validated like the CLI's arguments: a source is never read as an option", async (t) => {
	const app = setup(t, { packages: { runner: fakeInstaller().runner } });
	for (const params of [{}, { source: "" }, { source: "--approve" }, { source: "-l" }, { source: " npm:x" }, { source: "npm:x\nrm" }, { source: "npm:x", scope: "global" }, { source: "npm:x", extra: true }, { source: "x".repeat(1025) }]) {
		assert.deepEqual((await app.call("v", "install_package", params)).error, INVALID_INSTALL_PACKAGE, JSON.stringify(params));
	}
	assert.deepEqual((await app.call("v", "remove_package", { source: "-x" })).error, INVALID_REMOVE_PACKAGE);
	assert.deepEqual((await app.call("v", "list_packages", { scope: "user" })).error, INVALID_LIST_PACKAGES);
});

test("list_packages answers the listing", async (t) => {
	const app = setup(t, { packages: { lister: (cwd) => [{ source: "npm:a", version: "1.0.0", scope: "user" }, { source: `git:${cwd}`, scope: "project" }] } });
	assert.deepEqual((await app.call("l-1", "list_packages")).data, { packages: [{ source: "npm:a", version: "1.0.0", scope: "user" }, { source: "git:/work/project", scope: "project" }] });
});

test("the production listing reads Pi's settings in the agent home, with installed versions and local paths made absolute", (t) => {
	const root = scratch();
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "git", "github.com", "u", "r"), { recursive: true });
	mkdirSync(join(root, "pkg"));
	writeFileSync(join(root, "pkg", "package.json"), JSON.stringify({ name: "pkg", version: "0.0.1" }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:not-installed", "git:github.com/u/r", "../pkg", "../gone"] }));
	writeFileSync(join(agentDir, "git", "github.com", "u", "r", "package.json"), JSON.stringify({ name: "r", version: "2.3.4" }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
	// A session in another folder lists (and so removes) the local paths by where they are, not as written.
	assert.deepEqual(settingsPackages(join(root, "elsewhere")), [
		{ source: "npm:not-installed", scope: "user" },
		{ source: "git:github.com/u/r", version: "2.3.4", scope: "user" },
		{ source: join(root, "pkg"), version: "0.0.1", scope: "user" },
		{ source: join(root, "gone"), scope: "user" },
	]);
});

test("the production runner runs the CLI with the source as one argument, streams clean lines, and reports the CLI's last word", async () => {
	const root = scratch();
	const script = join(root, "fake-cli.mjs");
	writeFileSync(script, [
		"const args = process.argv.slice(2);",
		"process.stdout.write('\\u001b[2mARGS ' + JSON.stringify(args) + '\\u001b[0m\\n');",
		"process.stdout.write('ENV ' + JSON.stringify({ host: process.env.GENTLE_SHELL_INTERACTIVE_HOST ?? null, noColor: process.env.NO_COLOR, cwd: process.cwd() }) + '\\n');",
		"process.stdout.write('half a ');",
		"setTimeout(() => {",
		"  process.stdout.write('line\\r\\n\\n');",
		"  if (args.includes('npm:broken')) { process.stderr.write('npm ERR! 404 Not Found\\nError: Could not install npm:broken\\n'); process.exit(1); }",
		"  if (args.includes('npm:hang')) { setInterval(() => {}, 1000); return; }",
		"  process.stdout.write('Installed ' + args[3]);",
		"}, 5);",
	].join("\n"));
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	try {
		const run = cliPackageRunner({ command: process.execPath, args: [script, "--home", "/h"] });
		const lines: string[] = [];
		const ok = await run({ action: "install", source: "npm:good tool", scope: "project", cwd: root, signal: new AbortController().signal, onLine: (line) => lines.push(line) });
		assert.deepEqual(ok, { ok: true });
		assert.deepEqual(lines, [
			`ARGS ${JSON.stringify(["--home", "/h", "install", "npm:good tool", "-l"])}`,
			`ENV ${JSON.stringify({ host: null, noColor: "1", cwd: root })}`,
			"half a line",
			"Installed npm:good tool",
		]);

		const failed = await run({ action: "install", source: "npm:broken", scope: "user", cwd: root, signal: new AbortController().signal, onLine: () => {} });
		assert.deepEqual(failed, { ok: false, error: "Error: Could not install npm:broken" });

		const stop = new AbortController();
		const hanging = run({ action: "remove", source: "npm:hang", scope: "user", cwd: root, signal: stop.signal, onLine: (line) => { if (line === "half a line") stop.abort(new Error("Stopped: it ran past the time limit")); } });
		assert.deepEqual(await hanging, { ok: false, error: "Stopped: it ran past the time limit" });
	} finally {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	}
});

test("the CLI is the launcher and home the session was started with, else this package's launcher on Pi's home", () => {
	assert.deepEqual(packageCli({ [GENTLE_SHELL_LAUNCH_ENV]: JSON.stringify({ command: "/node", args: ["/pkg/bin/gentle-shell.mjs", "--link"] }) }), { command: "/node", args: ["/pkg/bin/gentle-shell.mjs", "--link"] });
	const fallback = packageCli({ [GENTLE_SHELL_LAUNCH_ENV]: "{not json" });
	assert.equal(fallback.command, process.execPath);
	assert.match(fallback.args[0]!, /bin[\\/]gentle-shell\.mjs$/);
	assert.equal(fallback.args[1], "--home");
});

test("progress lines drop color codes, control characters and blank lines", () => {
	assert.deepEqual(progressLines("\u001b[32m✔ done\u001b[0m\r\n\n  \n\u0007bell\rnext"), ["✔ done", "bell", "next"]);
	assert.equal(progressLines("y".repeat(3000))[0]!.length, 2000);
});
