import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentRunner, type RunnerDeps, type TaskRequest } from "../lib/agents-runner.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

// Settlement drain (#2266): a child that reported unfinished background jobs
// gets one bounded window on agent_settled before the ordinary orderly
// shutdown. Every terminal path cancels the window, and a child that never
// reported a job keeps the pre-existing immediate settlement.

const explorer: AgentDefinition = { name: "explore", description: "maps", filePath: "/a/explore.md", scope: "global", instructions: "You map things.", model: undefined, thinking: undefined, mode: undefined, tools: ["read", "bash_background"] };
const request = (overrides: Partial<TaskRequest> = {}): TaskRequest => ({ agent: explorer, prompt: "Map the repo", label: undefined, context: undefined, mode: AGENT_MODE.TASK, cwd: "/repo", parentSessionId: "s1", model: { provider: "openai-codex", id: "gpt-5.6-terra" }, thinking: "high", sessionDir: "/sessions", resumeSessionPath: undefined, env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" }, ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const job = (id: string, running: number, pending: boolean) => ({ id, kind: "job", message: JSON.stringify({ running, pending }) });

function harness(options: { cleanupTimeoutMs?: number; drainTimeoutMs?: number } = {}) {
	const children: FakeChild[] = [];
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const finishes: TaskRecord[] = [];
	const notifications: string[] = [];
	const deps: RunnerDeps = {
		spawn: () => { const fake = fakeChild({ exitOnKill: false, exitOnStdinEnd: false }); children.push(fake); return fake.child; },
		now: () => Date.now(),
		schedule: (fn, ms) => { const timer = { fn, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
		pi: { command: "pi", args: [] },
	};
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 2, stallTimeoutMs: 600_000, cleanupTimeoutMs: options.cleanupTimeoutMs ?? 3_000, drainTimeoutMs: options.drainTimeoutMs ?? 2_000 }, deps, {
		askUser: async () => ({ cancelled: true }),
		onFinish: (task) => finishes.push(task),
		onNotification: (_task, message) => { notifications.push(message); },
	});
	const pending = (ms: number) => timers.filter((timer) => !timer.cancelled && timer.ms === ms);
	const created = (ms: number) => timers.filter((timer) => timer.ms === ms);
	const fire = (ms: number) => { const timer = pending(ms)[0]; assert.ok(timer, `expected a live ${ms}ms timer`); timer.cancelled = true; timer.fn(); };
	return { store, runner, children, timers, finishes, notifications, pending, created, fire };
}

async function drained(h: ReturnType<typeof harness>) {
	const task = h.runner.run(request());
	await tick();
	const child = h.children[0];
	child.message(job("j1", 1, true));
	child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "waiting on CI" }] }] });
	child.emit({ type: "agent_settled" });
	await tick();
	return { task, child };
}

test("P-B1 one bounded drain is armed, then the ordinary SIGTERM/SIGKILL timeline follows the drain expiry", async () => {
	const h = harness();
	const { task, child } = await drained(h);
	assert.equal(h.created(2_000).length, 1, "exactly one drain window");
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.store.get(task.id)?.lastStep, "draining background jobs");
	assert.deepEqual(child.killed, [], "nothing is signalled during the drain");
	assert.equal(child.child.stdin.writableEnded, false);
	assert.deepEqual(child.sent[0], { id: "j1", kind: "ack", accepted: true });

	h.fire(2_000);
	await tick();
	assert.ok(child.child.stdin.writableEnded, "the drain ends by settling");
	assert.equal(h.pending(3_000).length, 1, "cleanup window starts after the drain");
	assert.deepEqual(child.killed, []);
	h.fire(3_000);
	assert.deepEqual(child.killed, ["SIGTERM"]);
	assert.equal(h.pending(250).length, 1, "SIGKILL is exactly TERMINATION_GRACE_MS after SIGTERM");
	h.fire(250);
	assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
	assert.equal(h.finishes.length, 0, "the slot is held until the exit is confirmed");
	child.exit(0);
	await tick();
	assert.equal(h.finishes.length, 1);
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
	assert.equal(h.store.get(task.id)?.error, null);
});

test("P-B2 a report with nothing left ends the drain early, and only one finish follows", async () => {
	const h = harness();
	const { task, child } = await drained(h);
	child.message(job("j2", 0, false));
	await tick();
	assert.ok(h.pending(2_000).length === 0, "the drain timer is cancelled");
	assert.ok(child.child.stdin.writableEnded);
	child.exit(0);
	await tick();
	assert.equal(h.finishes.length, 1);
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
});

test("P-B3 many reports during the drain never accumulate a second window", async () => {
	const h = harness();
	const { child } = await drained(h);
	for (let index = 2; index < 8; index += 1) { child.message(job(`j${index}`, 1, true)); await tick(); }
	assert.equal(h.created(2_000).length, 1, "still one created drain timer");
	assert.equal(h.pending(2_000).length, 1, "still one live drain timer");
	child.emit({ type: "agent_settled" });
	await tick();
	assert.equal(h.created(2_000).length, 1, "a repeated settlement cannot arm another window");
});

test("P-B4 requestStop cancels the drain: a cancel is not delayed by the window", async () => {
	const h = harness();
	const { task, child } = await drained(h);
	assert.ok(h.pending(2_000).length === 1);
	assert.equal(h.runner.cancel(task.id), true);
	await tick();
	assert.equal(h.pending(2_000).length, 0, "the drain timer is cancelled by the stop");
	assert.deepEqual(child.killed, ["SIGTERM"], "the stop signals at once instead of draining");
	// A stop keeps today's semantics: it signals at once and does not end stdin.
	assert.equal(child.child.stdin.writableEnded, false);
	child.exit(0, "SIGTERM");
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.CANCELLED);
	assert.equal(h.finishes.length, 1);
});

test("P-B5 a child that never reports a job settles immediately, exactly as before", async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	const child = h.children[0];
	child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	child.emit({ type: "agent_settled" });
	await tick();
	assert.equal(h.created(2_000).length, 0, "no drain window without a child job report");
	assert.ok(child.child.stdin.writableEnded);
	assert.equal(h.pending(3_000).length, 1);
	child.exit(0);
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
	assert.equal(h.finishes.length, 1);
});

test("P-B6 an invalid job report is refused and cannot open or end a drain", async () => {
	for (const message of ["not json", '{"running":-1,"pending":false}', '{"running":1}', '{"running":1,"pending":false,"x":0}', "x".repeat(9_000)]) {
		const h = harness();
		const task = h.runner.run(request());
		await tick();
		const c = h.children[0];
		c.message({ id: "j1", kind: "job", message });
		await tick();
		const ack = c.sent.at(-1) as { accepted?: boolean; error?: string };
		assert.equal(ack.accepted, false, message.slice(0, 24));
		assert.ok(ack.error, message.slice(0, 24));
		c.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		c.emit({ type: "agent_settled" });
		await tick();
		assert.equal(h.created(2_000).length, 0, `no drain for ${message.slice(0, 24)}`);
		assert.ok(c.child.stdin.writableEnded);
		assert.ok(task.id);
	}
});

test("P-B7 a child exit mid-drain settles once, with the status the settlement already produced", async () => {
	const h = harness();
	const { task, child } = await drained(h);
	assert.ok(h.pending(2_000).length === 1);
	child.exit(0);
	await tick();
	assert.equal(h.finishes.length, 1, "exactly one finish");
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
	assert.equal(h.pending(2_000).length, 0, "no drain timer is left behind to fire later");
	assert.equal(h.created(2_000).length, 1);
	const after = h.timers.length;
	await tick();
	assert.equal(h.timers.length, after);
});

test("P-B8 job reports are never routed to the parent model", async () => {
	const h = harness();
	const { child } = await drained(h);
	child.message(job("j2", 0, false));
	await tick();
	assert.deepEqual(h.notifications, [], "no parent notification came from a job frame");
});

test("P-B9 a late report after the terminal state cannot reopen a drain or mutate the record", async () => {
	const h = harness();
	const { task, child } = await drained(h);
	child.message(job("j2", 0, false));
	await tick();
	child.exit(0);
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
	child.message(job("j3", 1, true));
	await tick();
	assert.equal(h.created(2_000).length, 1, "no window after the terminal state");
	assert.equal(h.finishes.length, 1);
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.COMPLETED);
});
