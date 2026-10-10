import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireProjectMapClaim, readProjectMapClaim } from "../lib/project-map-store-claims.ts";
import { bindProjectMapStoreSession, projectMapStoreBindingProvesDead, readProjectMapStoreSessionBinding } from "../lib/project-map-store-heartbeats.ts";
import { PROJECT_MAP_STORE_HISTORY_LIMIT } from "../lib/project-map-store-history.ts";
import { issueProjectMapStoreReadinessReceipt } from "../lib/project-map-store-receipts.ts";
import { ensureProjectMapStoreRoot, resolveProjectMapStoreRoot } from "../lib/project-map-store-root.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES } from "../lib/project-map-store-schema.ts";
import { advanceProjectMapStore, initializeProjectMapStore, readProjectMapStoreDescriptor } from "../lib/project-map-store.ts";

const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const INCARNATION_A = "123e4567-e89b-12d3-a456-426614174001";
const INCARNATION_B = "123e4567-e89b-12d3-a456-426614174002";
const START = "2026-09-24T12:00:00.000Z";

function fixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "project-map-store-worktrees-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const main = join(dir, "main");
	const linked = join(dir, "linked");
	const other = join(dir, "other");
	const empty = join(dir, "empty");
	mkdirSync(empty);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" });
	writeFileSync(join(empty, "config"), "");
	const git = (cwd: string, args: string[]) => {
		const result = spawnSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		assert.equal(result.status, 0, result.stderr.toString());
	};
	git(dir, ["init", "--initial-branch=main", `--template=${empty}`, main]);
	git(main, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
	git(main, ["worktree", "add", "-b", "linked", linked]);
	git(dir, ["init", `--template=${empty}`, other]);
	return { dir, main, linked, other };
}

function digest(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function runStoreChild(source: string, args: string[]): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
}

function waitForChildExit(child: ChildProcess, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
		// A child that never closes would hang the whole suite, so the wait is bounded and the
		// process is killed on the way out instead of leaking into the test run.
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Child process did not exit in time.")); }, timeoutMs);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		// "close" fires after the stdio streams are closed, so the collected output is
		// complete; "exit" can arrive while the last stdout chunk is still unread.
		child.once("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
	});
}

async function waitForPaths(paths: string[]): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!paths.every((path) => existsSync(path))) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${paths.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function rootFor(cwd: string): { root: string; repositoryId: string; commonDir: string } {
	const resolved = ensureProjectMapStoreRoot(cwd);
	assert.deepEqual(resolved.diagnostics, []);
	assert.ok(resolved.root);
	assert.ok(resolved.repositoryId);
	assert.ok(resolved.commonDir);
	return { root: resolved.root, repositoryId: resolved.repositoryId, commonDir: resolved.commonDir };
}

function initialize(cwd: string) {
	const store = rootFor(cwd);
	const result = initializeProjectMapStore({ root: store.root, repositoryId: store.repositoryId, epoch: EPOCH, now: START });
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.descriptor);
	return { ...store, descriptor: result.descriptor };
}

function nextInstant(index: number): string {
	return new Date(Date.parse(START) + index * 1_000).toISOString();
}

test("linked worktrees share a restrictive common-dir store while unrelated repositories do not", (t) => {
	const f = fixture(t);
	const main = resolveProjectMapStoreRoot(f.main);
	const linked = resolveProjectMapStoreRoot(f.linked);
	const other = resolveProjectMapStoreRoot(f.other);
	assert.deepEqual(main.diagnostics, []);
	assert.deepEqual(linked.diagnostics, []);
	assert.deepEqual(other.diagnostics, []);
	assert.equal(main.root, linked.root);
	assert.equal(main.commonDir, linked.commonDir);
	assert.equal(main.repositoryId, linked.repositoryId);
	assert.notEqual(other.root, main.root);
	assert.notEqual(other.repositoryId, main.repositoryId);

	const store = rootFor(f.main);
	assert.equal(store.root, main.root);
	assert.equal(store.commonDir, main.commonDir);
	assert.equal(lstatSync(store.root).mode & 0o777, 0o700);
	assert.equal(store.commonDir, realpathSync(join(f.main, ".git")));
	assert.equal(store.root, join(store.commonDir, "gentle-ai", "project-map"));
	assert.equal(existsSync(join(f.main, "gentle-ai", "project-map")), false);
	assert.equal(existsSync(join(f.linked, "gentle-ai", "project-map")), false);
});

test("siblings persist claim and descriptor bytes through their shared store root", (t) => {
	const f = fixture(t);
	const initialized = initialize(f.main);
	const linked = rootFor(f.linked);
	assert.equal(linked.root, initialized.root);
	const other = resolveProjectMapStoreRoot(f.other);
	assert.ok(other.root);
	const acquired = acquireProjectMapClaim({ root: linked.root, capabilityId: "shared-capability", sessionId: "linked-session", now: START });
	assert.ok(acquired.claim);
	const claimPath = join(initialized.root, "claims", `${createHash("sha256").update("shared-capability").digest("hex")}.json`);
	const claimBytes = readFileSync(claimPath, "utf8");
	const readFromMain = readProjectMapClaim({ root: initialized.root, capabilityId: "shared-capability", now: START });
	assert.equal(readFromMain.status, "live");
	assert.equal(readFromMain.claim?.session_id, "linked-session");
	assert.equal(readFileSync(claimPath, "utf8"), claimBytes);

	const descriptorBytes = readFileSync(join(initialized.root, "store.json"), "utf8");
	const advanced = advanceProjectMapStore({
		root: initialized.root,
		expected: { generation: initialized.descriptor.generation, epoch: initialized.descriptor.epoch, predecessor: digest(descriptorBytes) },
		now: nextInstant(1),
	});
	assert.equal(advanced.descriptor?.generation, 1);
	assert.equal(readProjectMapStoreDescriptor(linked.root).descriptor?.generation, 1);
	assert.notEqual(readFileSync(join(linked.root, "store.json"), "utf8"), descriptorBytes);

	// The unrelated repository must not see the claim that now exists, and its refused
	// attempt must leave the sibling's bytes untouched.
	assert.equal(readProjectMapClaim({ root: other.root, capabilityId: "shared-capability", now: START }).status, "free");
	const refusedByOther = acquireProjectMapClaim({ root: other.root, capabilityId: "shared-capability", sessionId: "other-session", now: START });
	assert.equal(refusedByOther.claim, null);
	assert.ok(refusedByOther.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
	assert.equal(existsSync(join(other.root, "claims")), false);
	assert.equal(readFileSync(claimPath, "utf8"), claimBytes);
});

test("concurrent worktree children leave exactly one on-disk claim winner", async (t) => {
	const f = fixture(t);
	const initialized = initialize(f.main);
	const readyFirst = join(f.dir, "ready-first");
	const readySecond = join(f.dir, "ready-second");
	const gate = join(f.dir, "gate");
	const source = `
		import { existsSync, writeFileSync } from "node:fs";
		import { acquireProjectMapClaim } from "./lib/project-map-store-claims.ts";
		import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES } from "./lib/project-map-store-schema.ts";
		const [root, sessionId, readyPath, gatePath] = process.argv.slice(-4);
		// Rendezvous: both children are past startup and waiting before either may acquire,
		// so the two acquisitions genuinely overlap instead of racing on process start.
		writeFileSync(readyPath, "ready");
		const gateDeadline = Date.now() + 10_000;
		while (!existsSync(gatePath) && Date.now() < gateDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
		let result;
		// A competing writer can hold the store lock, which the store refuses with
		// STORE_LOCKED rather than waiting for it; retrying is the caller's discipline, and
		// this test still fails if the loser never reaches CLAIM_HELD.
		for (let attempt = 0; attempt < 500; attempt += 1) {
			result = acquireProjectMapClaim({ root, capabilityId: "raced-capability", sessionId, now: "${START}" });
			if (!result.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_LOCKED)) break;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
		}
		console.log(JSON.stringify({ claimed: result.claim !== null, sessionId, codes: result.diagnostics.map((entry) => entry.code) }));
	`;
	const first = waitForChildExit(runStoreChild(source, [initialized.root, "first-session", readyFirst, gate]));
	const second = waitForChildExit(runStoreChild(source, [initialized.root, "second-session", readySecond, gate]));
	await waitForPaths([readyFirst, readySecond]);
	writeFileSync(gate, "go");
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.code, 0, firstResult.stderr);
	assert.equal(secondResult.code, 0, secondResult.stderr);
	const results = [firstResult, secondResult].map((result) => JSON.parse(result.stdout) as { claimed: boolean; sessionId: string; codes: string[] });
	const winner = results.find((result) => result.claimed);
	const loser = results.find((result) => !result.claimed);
	assert.ok(winner);
	assert.ok(loser);
	assert.equal(results.filter((result) => result.claimed).length, 1);
	assert.ok(loser.codes.includes(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_HELD), `the losing process must report claim-held, got ${loser.codes.join(", ")}`);
	const path = join(initialized.root, "claims", `${createHash("sha256").update("raced-capability").digest("hex")}.json`);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).session_id, winner.sessionId);
	assert.equal(readdirSync(join(initialized.root, "claims")).length, 1);
});

test("claim expiry alone recovers a crashed owner while binding takeover requires dead-pid proof", async (t) => {
	const f = fixture(t);
	const initialized = initialize(f.main);
	const child = await waitForChildExit(runStoreChild(`
		import { acquireProjectMapClaim } from "./lib/project-map-store-claims.ts";
		const [root] = process.argv.slice(-1);
		const result = acquireProjectMapClaim({ root, capabilityId: "crashed-capability", sessionId: "crashed-session", now: "${START}" });
		console.log(JSON.stringify({ claimed: result.claim !== null, pid: process.pid }));
	`, [initialized.root]));
	assert.equal(child.code, 0, child.stderr);
	const crashed = JSON.parse(child.stdout) as { claimed: boolean; pid: number };
	assert.equal(crashed.claimed, true);
	assert.ok(crashed.pid > 0);
	const linked = rootFor(f.linked);
	const beforeDeadline = acquireProjectMapClaim({ root: linked.root, capabilityId: "crashed-capability", sessionId: "linked-session", now: "2026-09-24T12:00:59.999Z" });
	assert.equal(beforeDeadline.claim, null);
	assert.ok(beforeDeadline.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.CLAIM_HELD));
	const recovered = acquireProjectMapClaim({ root: linked.root, capabilityId: "crashed-capability", sessionId: "linked-session", now: "2026-09-24T12:01:00.001Z" });
	assert.equal(recovered.claim?.session_id, "linked-session");
	const recovery = recovered.diagnostics.find((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STALE_CLAIM_RECOVERED);
	assert.match(recovery?.message ?? "", /crashed-session/);
	assert.match(recovery?.message ?? "", /2026-09-24T12:01:00.000Z/);
	assert.equal(JSON.parse(readFileSync(join(linked.root, "claims", `${createHash("sha256").update("crashed-capability").digest("hex")}.json`), "utf8")).session_id, "linked-session");

	const deadBound = bindProjectMapStoreSession({ root: initialized.root, sessionId: "dead-binding", pid: crashed.pid, incarnation: INCARNATION_A, workspaceRoot: f.main, now: START });
	assert.ok(deadBound.binding);
	assert.equal(projectMapStoreBindingProvesDead(deadBound.binding), true);
	assert.equal(projectMapStoreBindingProvesDead({ ...deadBound.binding, pid: process.pid }), false);
	const takeover = bindProjectMapStoreSession({ root: linked.root, sessionId: "dead-binding", pid: process.pid, incarnation: INCARNATION_B, workspaceRoot: f.linked, now: nextInstant(2) });
	assert.equal(takeover.binding?.pid, process.pid);
	const rereadBinding = readProjectMapStoreSessionBinding({ root: initialized.root, sessionId: "dead-binding" });
	assert.equal(rereadBinding.binding?.pid, process.pid);
	assert.equal(rereadBinding.binding?.incarnation, INCARNATION_B);
	assert.equal(rereadBinding.binding?.workspace_root, f.linked);
	const liveBound = bindProjectMapStoreSession({ root: initialized.root, sessionId: "live-binding", pid: process.pid, incarnation: INCARNATION_A, workspaceRoot: f.main, now: START });
	assert.ok(liveBound.binding);
	const held = bindProjectMapStoreSession({ root: linked.root, sessionId: "live-binding", pid: crashed.pid, incarnation: INCARNATION_B, workspaceRoot: f.linked, now: nextInstant(2) });
	assert.equal(held.binding, null);
	assert.ok(held.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.SESSION_BINDING_HELD));
});

test("a fresh process reloads the descriptor, claim, and receipt bytes written by its sibling", async (t) => {
	const f = fixture(t);
	const initialized = initialize(f.main);
	assert.ok(acquireProjectMapClaim({ root: initialized.root, capabilityId: "reload-capability", sessionId: "main-session", now: START }).claim);
	const before = readFileSync(join(initialized.root, "store.json"), "utf8");
	assert.ok(advanceProjectMapStore({ root: initialized.root, expected: { generation: 0, epoch: EPOCH, predecessor: digest(before) }, now: nextInstant(1) }).descriptor);
	const issued = issueProjectMapStoreReadinessReceipt({ root: initialized.root, capabilityId: "reload-capability", issuedBy: "main-session", verified: ["focused"], evidence: ["filesystem"], now: nextInstant(2) });
	assert.ok(issued.receipt);
	const receiptDirectory = join(initialized.root, "receipts", createHash("sha256").update("reload-capability").digest("hex"));
	assert.equal(readdirSync(receiptDirectory).length, 1);
	const child = await waitForChildExit(runStoreChild(`
		import { readProjectMapClaim } from "./lib/project-map-store-claims.ts";
		import { readProjectMapStoreReadinessReceipts } from "./lib/project-map-store-receipts.ts";
		import { readProjectMapStoreDescriptor } from "./lib/project-map-store.ts";
		const [root] = process.argv.slice(-1);
		const descriptor = readProjectMapStoreDescriptor(root).descriptor;
		const claim = readProjectMapClaim({ root, capabilityId: "reload-capability", now: "${nextInstant(2)}" }).claim;
		const receipts = readProjectMapStoreReadinessReceipts({ root, capabilityId: "reload-capability", limit: 10 }).receipts;
		console.log(JSON.stringify({ generation: descriptor?.generation, claimSession: claim?.session_id, receipt: receipts[0] }));
	`, [rootFor(f.linked).root]));
	assert.equal(child.code, 0, child.stderr);
	const observed = JSON.parse(child.stdout) as { generation: number; claimSession: string; receipt: { verified: string[]; evidence: string[] } };
	assert.equal(observed.generation, 1);
	assert.equal(observed.claimSession, "main-session");
	assert.deepEqual(observed.receipt, issued.receipt);
});

test("interleaved worktree descriptor advances retain only bounded shared history", (t) => {
	const f = fixture(t);
	const initialized = initialize(f.main);
	const roots = [initialized.root, rootFor(f.linked).root];
	let descriptor = initialized.descriptor;
	for (let generation = 1; generation <= PROJECT_MAP_STORE_HISTORY_LIMIT + 1; generation += 1) {
		const root = roots[generation % roots.length];
		const bytes = readFileSync(join(root, "store.json"), "utf8");
		const result = advanceProjectMapStore({
			root,
			expected: { generation: descriptor.generation, epoch: descriptor.epoch, predecessor: digest(bytes) },
			now: nextInstant(generation),
		});
		assert.ok(result.descriptor);
		descriptor = result.descriptor;
	}
	assert.equal(PROJECT_MAP_STORE_HISTORY_LIMIT, 20);
	const history = readdirSync(join(initialized.root, "history")).sort();
	assert.equal(history.length, 20);
	assert.equal(history.includes(`0-${EPOCH}.json`), false);
	assert.equal(history.includes(`20-${EPOCH}.json`), true);
	assert.equal(readProjectMapStoreDescriptor(rootFor(f.linked).root).descriptor?.generation, PROJECT_MAP_STORE_HISTORY_LIMIT + 1);
});
