import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activitySummary } from "../lib/herdr-activity.ts";

const input = { agent: "pi" as const, session: "../session", pid: 42, cwd: "/workspace", state: "working" as const, task: null };
test("S2: exact schema and UTC timestamp", async () => {
	const { agentStatus } = await import("../lib/agent-status.ts");
	assert.deepEqual(agentStatus(input, 0), { schema: "gentle-shell.agent-status/v1", ...input, updatedAt: "1970-01-01T00:00:00.000Z" });
});
test("S2/S4: shared title selection, sanitizing, bounds and null cases; Herdr bytes unchanged", async () => {
	const { activeTodoTitle } = await import("../lib/herdr-activity.ts");
	const tasks = [{ status: "pending", title: "ignored" }, { status: "in_progress", title: "\u001b[31mFix\u001b[0m\n\u202etests" }];
	assert.equal(activeTodoTitle(tasks), "Fix tests");
	assert.equal(activitySummary(tasks), "◐ Fix tests");
	assert.equal(activitySummary([{ status: "in_progress", title: "one two three four" }], 12), "◐ one two\n  three four");
	for (const value of [null, [], [{ status: "done", title: "done" }], [{ status: "in_progress", title: 3 }], [{ status: "in_progress", title: "\n\u202e" }]]) assert.equal(activeTodoTitle(value), null);
	assert.equal(activeTodoTitle([{ status: "in_progress", title: 3 }, { status: "in_progress", title: "later" }]), null);
	assert.ok(activeTodoTitle([{ status: "in_progress", title: "x".repeat(5000) }])!.length <= 4096);
});
test("S5: private modes, safe stable filename and atomic replacement", async () => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	const home = mkdtempSync(join(tmpdir(), "agent-status-"));
	const store = createAgentStatusStore(home, input.session);
	assert.equal(store.write(agentStatus(input, 0)), true);
	const before = lstatSync(store.path);
	assert.equal(store.write(agentStatus({ ...input, state: "idle" }, 1)), true);
	assert.notEqual(lstatSync(store.path).ino, before.ino);
	assert.equal(JSON.parse(readFileSync(store.path, "utf8")).state, "idle");
	assert.deepEqual(readdirSync(join(home, "agent-status")), [store.path.split(/[\\/]/).at(-1)]);
	if (process.platform !== "win32") {
		assert.equal(lstatSync(join(home, "agent-status")).mode & 0o777, 0o700);
		assert.equal(lstatSync(store.path).mode & 0o777, 0o600);
	}
	store.remove(); assert.deepEqual(readdirSync(join(home, "agent-status")), []);
});
test("S5/S6: symlink directories/files refused and failures contained", async (t) => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	const home = mkdtempSync(join(tmpdir(), "agent-status-"));
	const target = mkdtempSync(join(tmpdir(), "agent-status-target-"));
	await t.test("symlinked status directory", (t) => {
		try { symlinkSync(target, join(home, "agent-status"), "dir"); }
		catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("symlink privileges unavailable"); return; } throw error; }
		const linked = createAgentStatusStore(home, "linked");
		assert.equal(linked.write(agentStatus(input, 0)), false); assert.doesNotThrow(() => linked.remove());
		assert.deepEqual(readdirSync(target), []);
	});
	const store = createAgentStatusStore(target, "file"); store.write(agentStatus(input, 0)); store.remove();
	const victim = join(target, "victim"); writeFileSync(victim, "untouched");
	await t.test("symlinked status file", (t) => {
		try { symlinkSync(victim, store.path); }
		catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("symlink privileges unavailable"); return; } throw error; }
		assert.equal(store.write(agentStatus(input, 0)), false); store.remove();
		assert.ok(lstatSync(store.path).isSymbolicLink()); assert.equal(readFileSync(victim, "utf8"), "untouched");
	});
	const bad = createAgentStatusStore(victim, "bad");
	assert.equal(bad.write(agentStatus(input, 0)), false); assert.doesNotThrow(() => bad.remove());
});
test("S5: group/world-writable config home and loose status directory refused", { skip: process.platform === "win32" }, async () => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	for (const mode of [0o777, 0o775]) {
		const open = mkdtempSync(join(tmpdir(), "agent-status-open-"));
		chmodSync(open, mode);
		assert.equal(createAgentStatusStore(open, "s").write(agentStatus(input, 0)), false, `config home mode ${mode.toString(8)}`);
		assert.deepEqual(readdirSync(open), []);
	}
	const loose = mkdtempSync(join(tmpdir(), "agent-status-loose-"));
	mkdirSync(join(loose, "agent-status"), { mode: 0o755 }); chmodSync(join(loose, "agent-status"), 0o755);
	assert.equal(createAgentStatusStore(loose, "s").write(agentStatus(input, 0)), false);
	assert.deepEqual(readdirSync(join(loose, "agent-status")), []);
	assert.equal(lstatSync(join(loose, "agent-status")).mode & 0o777, 0o755);
});
test("S5: config home under a symlinked ancestor writes and removes", async (t) => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	const parent = mkdtempSync(join(tmpdir(), "agent-status-ancestor-"));
	const target = join(parent, "target"); mkdirSync(target);
	const link = join(parent, "link");
	try { symlinkSync(target, link, "dir"); }
	catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("symlink privileges unavailable"); return; } throw error; }
	const home = join(link, "config");
	const store = createAgentStatusStore(home, "s");
	assert.equal(store.write(agentStatus(input, 0)), true);
	assert.equal(JSON.parse(readFileSync(store.path, "utf8")).session, input.session);
	if (process.platform !== "win32") {
		assert.equal(lstatSync(home).mode & 0o777, 0o700);
		assert.equal(lstatSync(join(home, "agent-status")).mode & 0o777, 0o700);
	}
	store.remove(); assert.deepEqual(readdirSync(join(home, "agent-status")), []);
});
test("S5: symlinked config home is refused", async (t) => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	const parent = mkdtempSync(join(tmpdir(), "agent-status-home-link-"));
	const target = join(parent, "target"); mkdirSync(target);
	const home = join(parent, "config");
	try { symlinkSync(target, home, "dir"); }
	catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("symlink privileges unavailable"); return; } throw error; }
	const store = createAgentStatusStore(home, "s");
	assert.equal(store.write(agentStatus(input, 0)), false);
	assert.doesNotThrow(() => store.remove());
	assert.deepEqual(readdirSync(target), []);
});
test("S5: a missing config home is created privately on first write", async () => {
	const { createAgentStatusStore, agentStatus } = await import("../lib/agent-status.ts");
	const home = join(mkdtempSync(join(tmpdir(), "agent-status-new-")), "config");
	const store = createAgentStatusStore(home, "s");
	assert.equal(store.write(agentStatus(input, 0)), true);
	assert.equal(JSON.parse(readFileSync(store.path, "utf8")).session, "../session");
});
