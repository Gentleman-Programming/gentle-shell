import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { ServeAuth } from "../lib/serve-auth.ts";
import { printLaunch } from "../lib/serve-cli.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { call, pairDevice } from "./serve-test-client.ts";

const FAKE_PRINT = fileURLToPath(new URL("./fixtures/serve-fake-print.mjs", import.meta.url));
const ADMIN = "gsa_test-admin-token";
let root: string;
let project: string;
let server: ServeServer;
let bare: ServeServer;
const launches: Array<{ cwd: string; model?: string }> = [];

before(async () => {
	root = mkdtempSync(join(tmpdir(), "gentle-serve-print-"));
	project = realpathSync(mkdtempSync(join(root, "project-")));
	const auth = new ServeAuth({ devicesFile: join(root, "devices.json"), adminToken: ADMIN });
	const base = { host: "127.0.0.1", port: 0, auth, version: "test", launchSession: () => { throw new Error("no sessions here"); } };
	server = await startServeServer({
		...base,
		launchPrint: (input) => {
			launches.push(input);
			// The real launch, with the fake standing in for the launcher.
			return printLaunch({ nodePath: process.execPath, launcher: FAKE_PRINT, homeFlags: ["--isolated"], env: { ...process.env, GENTLE_SHELL_INTERACTIVE_HOST: "1" } }, input);
		},
		printLimits: { timeoutMs: 1500, stdoutBytes: 1000, maxRunning: 1, killGraceMs: 200 },
	});
	bare = await startServeServer(base);
});
after(async () => {
	await server?.close();
	await bare?.close();
	rmSync(root, { recursive: true, force: true });
});

test("the launch mirrors the app's commit-message run: --print, no session, no tools, no interactive host", () => {
	const launch = printLaunch({ nodePath: "/node", launcher: "/gs.mjs", homeFlags: ["--home", "/h"], env: { A: "1", GENTLE_SHELL_INTERACTIVE_HOST: "1" } }, { cwd: "/w", model: "anthropic/claude-x" });
	assert.equal(launch.command, "/node");
	assert.deepEqual(launch.args, ["/gs.mjs", "--home", "/h", "--print", "--no-session", "--no-tools", "--model", "anthropic/claude-x"]);
	assert.equal(launch.cwd, "/w");
	assert.equal(launch.env.A, "1");
	assert.equal(launch.env.GENTLE_SHELL_INTERACTIVE_HOST, undefined);
	assert.deepEqual(printLaunch({ nodePath: "/node", launcher: "/gs.mjs", homeFlags: [], env: {} }, { cwd: "/w" }).args, ["/gs.mjs", "--print", "--no-session", "--no-tools"]);
});

test("POST /api/print answers the run's stdout; the prompt goes on stdin", async () => {
	const info = await call(server.url, "GET", "/api/server", { token: ADMIN });
	assert.ok(info.body.capabilities.includes("print"));
	const prompt = "Write a commit message\n\n<diff>\n+ü\n</diff>\n";
	const answer = await call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt, model: "openai/gpt-x:high" } });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(Object.keys(answer.body), ["text"]);
	const ran = JSON.parse(answer.body.text);
	assert.equal(ran.prompt, prompt);
	assert.deepEqual(ran.args, ["--isolated", "--print", "--no-session", "--no-tools", "--model", "openai/gpt-x:high"]);
	assert.equal(ran.cwd, project);
	assert.equal(ran.interactiveHost, null);
	assert.deepEqual(launches.at(-1), { cwd: project, model: "openai/gpt-x:high" });
});

test("a failing run, a run past its time and an answer over the cap are errors", async () => {
	const failed = await call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "fail please" } });
	assert.equal(failed.status, 502);
	assert.equal(failed.body.error.code, "print_failed");
	assert.match(failed.body.error.message, /no model configured/);
	assert.equal(failed.body.exitCode, 3);

	const big = await call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "big" } });
	assert.equal(big.status, 502);
	assert.equal(big.body.error.code, "output_too_large");

	const started = Date.now();
	const launched = launches.length;
	const slow = call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "hang" } });
	// The run starts in the same tick as its launch is built; there is no event to await for it.
	while (launches.length === launched) await new Promise((r) => setImmediate(r));
	// One run at a time here: a second is refused, not queued.
	const busy = await call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "hello" } });
	assert.equal(busy.status, 429);
	assert.equal(busy.body.error.code, "too_many_prints");
	const timedOut = await slow;
	assert.equal(timedOut.status, 504);
	assert.equal(timedOut.body.error.code, "print_timeout");
	assert.ok(Date.now() - started < 5000);
	const again = await call(server.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "hello" } });
	assert.equal(again.status, 200, "the slot is free once the run ended");
});

test("print checks its input and scope, and a server without a launcher runs none", async () => {
	const reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
	assert.equal((await call(server.url, "POST", "/api/print", { token: reader.token, body: { cwd: project, prompt: "hi" } })).status, 403);
	assert.equal((await call(server.url, "POST", "/api/print", { body: { cwd: project, prompt: "hi" } })).status, 401);
	assert.equal((await call(server.url, "GET", "/api/print", { token: ADMIN })).status, 405);
	const bad = async (body: unknown) => (await call(server.url, "POST", "/api/print", { token: ADMIN, body })).body.error.code;
	assert.equal(await bad({ cwd: "relative", prompt: "hi" }), "invalid_cwd");
	assert.equal(await bad({ cwd: join(project, "missing"), prompt: "hi" }), "invalid_cwd");
	assert.equal(await bad({ cwd: project, prompt: "  " }), "invalid_prompt");
	assert.equal(await bad({ cwd: project, prompt: "x".repeat(256 * 1024 + 1) }), "invalid_prompt");
	assert.equal(await bad({ cwd: project, prompt: "hi", model: "--tools" }), "invalid_model");
	assert.equal(await bad({ cwd: project, prompt: "hi", model: "a b" }), "invalid_model");

	const info = await call(bare.url, "GET", "/api/server", { token: ADMIN });
	assert.ok(!info.body.capabilities.includes("print"));
	const none = await call(bare.url, "POST", "/api/print", { token: ADMIN, body: { cwd: project, prompt: "hi" } });
	assert.equal(none.status, 501);
	assert.equal(none.body.error.code, "not_supported");
});
