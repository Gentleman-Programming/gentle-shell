import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServeAuth } from "../lib/serve-auth.ts";
import { setupLaunch } from "../lib/serve-cli.ts";
import { parseVersion, ServeChecks, settingsList, type ServeCheck, type ServeChecksOptions } from "../lib/serve-checks.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { after, before, call, pairDevice, stream, test } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";
const LAUNCHER = fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url));
// Fake tools are shell scripts the kernel runs by their `#!` line.
const skip = process.platform === "win32" ? "fake tools are POSIX scripts" : false;
let root: string;
let server: ServeServer | undefined;

before(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-checks-")));
});
after(async () => {
	await server?.close();
	rmSync(root, { recursive: true, force: true });
});

let dirs = 0;
/** A folder of fake tools: `name` → its script body (after `#!/bin/sh`). */
function tools(scripts: Record<string, string>): string {
	const dir = join(root, `bin${(dirs += 1)}`);
	mkdirSync(dir);
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

/** A fake `gentle-shell setup --check --json`: prints `report`, exits with `code`. */
function companion(report: unknown, code: number): ServeChecksOptions["companion"] {
	const dir = tools({ "setup-check": `printf '%s\\n' '${JSON.stringify(report)}'\nexit ${code}` });
	return () => ({ command: join(dir, "setup-check"), args: [], cwd: root, env: {} });
}

const report = (needsSetup: boolean, reasons: string[], mode = "isolated") => ({ schema: "gentle-shell.setup-check/v1", needsSetup, home: { mode }, reasons, foreign: false });

function agentHome(name: string, provisioned?: Record<string, unknown>): { home: string; config: string } {
	const home = join(root, name);
	mkdirSync(home);
	const config = join(root, `${name}-config.json`);
	writeFileSync(config, JSON.stringify(provisioned === undefined ? {} : { provisioned: { [home]: provisioned } }));
	return { home, config };
}

const byId = (checks: ServeCheck[]) => Object.fromEntries(checks.map((check) => [check.id, check]));

test("parseVersion reads versions the way the app's checklist does", () => {
	assert.deepEqual(parseVersion("v22.19.0\n"), [22, 19, 0]);
	assert.deepEqual(parseVersion("3.0.0-beta.1"), [3, 0, 0]);
	assert.deepEqual(parseVersion("22.19"), [22, 19, 0]);
	assert.equal(parseVersion("nope"), undefined);
	assert.equal(settingsList({ packages: ["npm:gentle-engram@1.2.0"] }, "gentle-engram"), true);
	assert.equal(settingsList({ packages: [{ source: "npm:@scope/x@1" }, "npm:gentle-engram-extra"] }, "gentle-engram"), false);
});

test("everything in place: ok rows with versions, the companion's setup record", { skip }, async () => {
	const bin = tools({ node: "echo v22.19.0", npm: "echo 10.9.0", git: "echo 'git version 2.47.1'", engram: "echo 'engram v3.1.0'; echo 'A newer version is available'" });
	const { home, config } = agentHome("ready", { gentleAi: "1.40.2", gentlePi: "5.0.0", at: "2026-11-20T10:00:00.000Z" });
	const checks = new ServeChecks({ env: { PATH: bin, GENTLE_SHELL_CONFIG: config }, agentHome: home, companion: companion(report(false, []), 0) });
	const rows = await checks.checks();
	assert.deepEqual(rows.map((row) => row.id), ["node", "companion", "git", "engram"]);
	assert.deepEqual(byId(rows), {
		node: { id: "node", state: "ok", version: "22.19.0", detail: "npm 10.9.0" },
		companion: { id: "companion", state: "ok", version: "1.40.2", detail: "Set up 2026-11-20" },
		git: { id: "git", state: "ok", version: "2.47.1", detail: null },
		engram: { id: "engram", state: "ok", version: "3.1.0", detail: "engram v3.1.0" },
	});
});

test("nothing installed: missing rows", { skip }, async () => {
	const { home, config } = agentHome("bare");
	const checks = new ServeChecks({ env: { PATH: tools({}), GENTLE_SHELL_CONFIG: config }, agentHome: home, companion: companion(report(true, ["never-provisioned"]), 1) });
	assert.deepEqual(byId(await checks.checks()), {
		node: { id: "node", state: "missing", version: null, detail: "Node.js isn't installed" },
		companion: { id: "companion", state: "missing", version: null, detail: "Not set up yet — the first chat would do it silently" },
		git: { id: "git", state: "missing", version: null, detail: "Git isn't installed" },
		engram: { id: "engram", state: "missing", version: null, detail: "Not installed" },
	});
});

test("old versions, a missing npm, a stale setup and a broken ENGRAM_BIN are errors that say why", { skip }, async () => {
	const old = tools({ node: "echo v20.11.1", npm: "echo 10.2.4", git: "exit 1", engram: "echo 'engram 2.1.0'" });
	const { home, config } = agentHome("stale", { gentleAi: "1.40.2", gentlePi: "4.9.0", at: "2026-01-02T00:00:00.000Z" });
	const stale = new ServeChecks({ env: { PATH: old, GENTLE_SHELL_CONFIG: config }, agentHome: home, version: "5.0.0", companion: companion(report(true, ["gentle-pi-changed"]), 1) });
	assert.deepEqual(byId(await stale.checks()), {
		node: { id: "node", state: "error", version: "20.11.1", detail: "Node 20.11.1 — needs 22.19.0 or newer" },
		companion: { id: "companion", state: "error", version: "1.40.2", detail: "Set up with gentle-pi 4.9.0; 5.0.0 is installed" },
		git: { id: "git", state: "missing", version: null, detail: "Git isn't installed" },
		engram: { id: "engram", state: "error", version: "2.1.0", detail: "Engram 2.1.0 — needs 3.0.0 or newer" },
	});

	const noNpm = tools({ node: "echo v24.1.0", engram: "echo 'engram 3.0.0'" });
	const other = new ServeChecks({ env: { PATH: noNpm, ENGRAM_BIN: join(root, "no-engram") }, companion: companion({ schema: "gentle-shell.setup-check/v1", error: "could not read the launcher config or home (EACCES)" }, 3) });
	const rows = byId(await other.checks());
	assert.deepEqual(rows.node, { id: "node", state: "missing", version: "24.1.0", detail: "Node 24.1.0 found, but not npm" });
	assert.deepEqual(rows.engram, { id: "engram", state: "error", version: null, detail: `ENGRAM_BIN points to ${join(root, "no-engram")}, which can't be run. Fix or remove it.` });
	assert.deepEqual(rows.companion, { id: "companion", state: "error", version: null, detail: "`gentle-shell setup --check` failed: could not read the launcher config or home (EACCES)" });

	// ENGRAM_BIN wins over the PATH; a tool that hangs is killed at its timeout and counts as not running.
	const hang = tools({ node: "exec /bin/sleep 30", engram: "echo 'engram 3.2.0'" });
	const slow = new ServeChecks({ env: { PATH: noNpm, ENGRAM_BIN: join(hang, "engram") }, limits: { toolTimeoutMs: 200 } });
	const slowRows = byId(await slow.checks());
	assert.equal(slowRows.engram.version, "3.2.0");
	assert.equal(slowRows.companion.state, "error", "no companion check without the launcher");
	const timed = byId(await new ServeChecks({ env: { PATH: hang }, limits: { toolTimeoutMs: 200 } }).checks());
	assert.deepEqual(timed.node, { id: "node", state: "error", version: null, detail: `${join(hang, "node")} doesn't run` });
});

test("a --link home is set up once its settings list gentle-engram", { skip }, async () => {
	const { home, config } = agentHome("linked");
	const linked = () => new ServeChecks({ env: { PATH: tools({}), GENTLE_SHELL_CONFIG: config }, agentHome: home, companion: companion(report(true, ["never-provisioned"], "link"), 1) });
	assert.deepEqual(byId(await linked().checks()).companion, { id: "companion", state: "missing", version: null, detail: `${home} isn't set up yet` });
	writeFileSync(join(home, "settings.json"), JSON.stringify({ packages: ["npm:gentle-engram@1.0.0"] }));
	assert.deepEqual(byId(await linked().checks()).companion, { id: "companion", state: "ok", version: null, detail: `Linked to ${home}` });
});

test("the real launcher's setup --check answers the companion row", { skip }, async () => {
	const fakeHome = join(root, "user");
	const { home, config } = agentHome("real");
	mkdirSync(fakeHome);
	const env = { PATH: tools({}), HOME: fakeHome, USERPROFILE: fakeHome, GENTLE_SHELL_CONFIG: config };
	const launch = () => setupLaunch({ launcher: LAUNCHER, nodePath: process.execPath, homeFlags: ["--home", home], env }, ["--check", "--json"]);
	assert.deepEqual(launch().args.slice(-3), ["setup", "--check", "--json"]);
	const checks = new ServeChecks({ env, agentHome: home, companion: launch });
	assert.deepEqual(byId(await checks.checks()).companion, { id: "companion", state: "missing", version: null, detail: "Not set up yet — the first chat would do it silently" });
});

test("GET /api/checks: sessions:read, the checks capability, one result per cache window, fresh after a setup job", { skip }, async () => {
	let now = 1_000_000;
	const bin = tools({ node: "read -r v < \"${0%/*}/version\"; echo \"$v\"", npm: "echo 10.9.0", git: "echo 'git version 2.47.1'" });
	writeFileSync(join(bin, "version"), "v22.19.0\n");
	// A setup job that installs a newer Node.
	const setup = tools({ setup: `printf 'v24.1.0\\n' > '${join(bin, "version")}'` });
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth: new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN }),
		version: "test",
		launchSession: () => { throw new Error("no sessions here"); },
		env: { PATH: bin },
		checks: { companion: companion(report(false, []), 0), now: () => now },
		upgrade: { launch: () => { throw new Error("no upgrades here"); }, onUpgraded: () => {}, setup: () => ({ command: join(setup, "setup"), args: [], cwd: root, env: {} }) },
	});
	const reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
	assert.ok((await call(server.url, "GET", "/api/server", { token: reader.token })).body.capabilities.includes("checks"));
	assert.equal((await call(server.url, "GET", "/api/checks")).status, 401);
	assert.equal((await call(server.url, "POST", "/api/checks", { token: reader.token })).status, 405);

	const first = await call(server.url, "GET", "/api/checks", { token: reader.token });
	assert.equal(first.status, 200);
	assert.deepEqual(Object.keys(first.body), ["checks"]);
	for (const row of first.body.checks) assert.deepEqual(Object.keys(row), ["id", "state", "version", "detail"]);
	assert.deepEqual(first.body.checks.map((row: ServeCheck) => [row.id, row.state]), [["node", "ok"], ["companion", "ok"], ["git", "ok"], ["engram", "missing"]]);

	writeFileSync(join(bin, "version"), "v20.0.0\n");
	now += 5_000;
	assert.equal(byId((await call(server.url, "GET", "/api/checks", { token: reader.token })).body.checks).node.version, "22.19.0", "cached");
	now += 5_000;
	assert.deepEqual(byId((await call(server.url, "GET", "/api/checks", { token: reader.token })).body.checks).node, { id: "node", state: "error", version: "20.0.0", detail: "Node 20.0.0 — needs 22.19.0 or newer" });

	const job = await call(server.url, "POST", "/api/setup", { token: ADMIN, body: {} });
	assert.equal(job.status, 202);
	const events = await stream(server.url, `/api/setup/${job.body.jobId}/stream`, ADMIN);
	await events.waitFor("event: finished");
	await events.closed;
	assert.equal(byId((await call(server.url, "GET", "/api/checks", { token: reader.token })).body.checks).node.version, "24.1.0", "the job's end clears the cache");
});
