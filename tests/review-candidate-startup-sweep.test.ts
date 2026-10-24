import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setWindowsAclAuthorityForTesting, sweepCandidateOwners } from "../lib/review-candidate-view-owner.ts";
import { launchSweep, runCandidateStartupSweep } from "../lib/review-candidate-startup-sweep.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "candidate-startup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const common = join(root, ".git");
	const parent = join(common, "gentle-ai", "candidate-views");
	mkdirSync(parent, { recursive: true });
	const markers = [1, 2, 3].map((n) => {
		const uuid = `00000000-0000-4000-8000-00000000000${n}`;
		const path = join(parent, `${uuid}.owner.json`);
		writeFileSync(path, JSON.stringify({ version: 1, uuid, token: uuid, pid: process.pid, host: null, root: join(parent, uuid), commonDir: common }));
		return path;
	});
	setWindowsAclAuthorityForTesting(() => {});
	t.after(() => setWindowsAclAuthorityForTesting());
	return { root, common, markers };
}

test("startup count budget preserves markers and never invokes Git or chmod for unknown owners", (t) => {
	const { common, markers } = fixture(t);
	const before = markers.map((path) => readFileSync(path, "utf8"));
	let git = 0, chmod = 0;
	const result = sweepCandidateOwners(common, () => { git++; return ""; }, () => { chmod++; }, "win32", { maxOwners: 1, budgetMs: 5000 });
	assert.deepEqual(result, { examined: 1, remaining: 2, failed: 0, budgetExceeded: true, unavailable: false });
	assert.deepEqual(markers.map((path) => readFileSync(path, "utf8")), before);
	assert.equal(git, 0);
	assert.equal(chmod, 0);
});

test("startup elapsed budget starts no marker work after exhaustion", (t) => {
	const { common, markers } = fixture(t);
	const before = markers.map((path) => readFileSync(path, "utf8"));
	const result = sweepCandidateOwners(common, () => assert.fail("Git"), () => assert.fail("chmod"), "win32", { budgetMs: 0 });
	assert.deepEqual(result, { examined: 0, remaining: 3, failed: 0, budgetExceeded: true, unavailable: false });
	assert.deepEqual(markers.map((path) => readFileSync(path, "utf8")), before);
});

test("ordinary synchronous sweep still checks every marker without startup limits", (t) => {
	const { common, markers } = fixture(t);
	const checked: string[] = [];
	setWindowsAclAuthorityForTesting((path) => checked.push(path));
	const before = markers.map((path) => readFileSync(path, "utf8"));
	sweepCandidateOwners(common, () => assert.fail("Git"), () => assert.fail("chmod"), "win32");
	assert.deepEqual(checked.filter((path) => path.endsWith(".owner.json")).sort(), markers.slice().sort());
	assert.deepEqual(markers.map((path) => readFileSync(path, "utf8")), before);
});

test("startup sweep keeps event loop responsive and shares one in-flight child per cwd", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "candidate-startup-process-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let settle!: () => void;
	let launches = 0;
	const runner = async () => {
		launches++;
		await new Promise<void>((resolve) => { settle = resolve; });
		return { examined: 0, remaining: 0, failed: 0, budgetExceeded: false, unavailable: false };
	};
	const first = runCandidateStartupSweep(root, runner);
	const second = runCandidateStartupSweep(root, runner);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(launches, 1);
	settle();
	assert.deepEqual(await first, await second);
	await runCandidateStartupSweep(root, async () => ({ examined: 0, remaining: 0, failed: 0, budgetExceeded: false, unavailable: false }));
});

test("startup helper that never exits is stopped by the hang backstop with a fixed message", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "candidate-startup-hang-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const script = join(root, "hang.mjs");
	writeFileSync(script, "setInterval(() => {}, 1000);\n");
	const started = Date.now();
	await assert.rejects(launchSweep(root, { timeoutMs: 300, script }), { message: "Candidate cleanup helper timed out" });
	assert.ok(Date.now() - started < 10_000);
});

test("real startup helper handles a non-repository without creating a candidate store", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "candidate-startup-helper-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const result = await runCandidateStartupSweep(root);
	assert.equal(result.unavailable, true);
	assert.equal(result.examined, 0);
	// Exercise the shipped entry point through Node, not an imported internal helper.
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../scripts/sweep-candidate-views.mjs", import.meta.url)), root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
	assert.equal(code, 0, stderr);
	assert.deepEqual(JSON.parse(stdout), result);
});
