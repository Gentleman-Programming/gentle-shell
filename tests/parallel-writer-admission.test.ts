import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { TASK_STATUS, TaskStore } from "../lib/agents-protocol.ts";
import { AgentRunner, type TaskRequest } from "../lib/agents-runner.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

// gentle-shell#1731 T4 (S2, AC6): the runner admits a writer only while no
// queued or running writer in the same worktree root claims an overlapping
// `## Allowed edit surfaces` entry. Admission and registration happen in the
// same synchronous run() call, and every terminal path releases the claim.

const worker: AgentDefinition = { name: "gentle-ai-worker", description: "writes", filePath: "/a/worker.md", scope: "global", instructions: "You write.", model: undefined, thinking: undefined, mode: undefined, tools: ["read", "edit", "write"] };
const explorer: AgentDefinition = { ...worker, name: "explore", description: "maps", tools: ["read"] };

function writer(surfaces: string[], overrides: Partial<TaskRequest> = {}): TaskRequest {
	return { agent: worker, prompt: `Write.\n\n## Allowed edit surfaces\n${surfaces.join("\n")}\n`, label: undefined, context: undefined, mode: AGENT_MODE.BACKGROUND, cwd: "/repo", parentSessionId: "s1", model: undefined, thinking: undefined, sessionDir: "/sessions", resumeSessionPath: undefined, env: {}, writerSurfaces: surfaces, ...overrides };
}

function harness(maxConcurrency = 5) {
	const children: FakeChild[] = [];
	const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency, stallTimeoutMs: 10_000 }, {
		spawn: () => {
			const fake = fakeChild();
			children.push(fake);
			return fake.child;
		},
		now: () => Date.now(),
		schedule: (fn) => {
			const timer = { fn, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pi: { command: "pi", args: [] },
	}, { askUser: async () => ({ cancelled: true }) });
	const fireTimers = () => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn(); };
	return { store, runner, children, fireTimers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function complete(h: ReturnType<typeof harness>, index: number, id: string): Promise<void> {
	h.children[index].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
	h.children[index].emit({ type: "agent_settled" });
	await h.runner.waitFor(id);
}

test("writers with disjoint surfaces run concurrently in one worktree", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts", "tests/a.test.ts"]));
	const b = h.runner.run(writer(["lib/b.ts", "tests/b.test.ts"]));
	await tick();
	assert.equal(h.children.length, 2);
	assert.equal(h.store.get(a.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.store.get(b.id)?.status, TASK_STATUS.RUNNING);
	h.runner.cancelAll();
});

test("an overlapping writer is rejected before any task, queue entry or spawn exists", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts", "tests/a.test.ts"]));
	await tick();
	assert.throws(() => h.runner.run(writer(["lib/*.ts"])), (error: Error) => {
		assert.match(error.message, new RegExp(`task ${a.id}`));
		assert.match(error.message, /`lib\/\*\.ts` overlaps `lib\/a\.ts`/);
		assert.match(error.message, /isolated worktree/);
		return true;
	});
	assert.equal(h.store.list("s1").length, 1, "the rejected writer leaves no task record");
	await tick();
	assert.equal(h.children.length, 1, "the rejected writer never spawns");
	h.runner.cancelAll();
});

test("a queued writer already holds its surfaces", async () => {
	const h = harness(1);
	h.runner.run(writer(["lib/a.ts"]));
	const queued = h.runner.run(writer(["lib/b.ts"]));
	await tick();
	assert.equal(h.store.get(queued.id)?.status, TASK_STATUS.QUEUED);
	assert.throws(() => h.runner.run(writer(["lib/b.ts"])), new RegExp(`task ${queued.id}`));
	h.runner.cancelAll();
});

test("completion releases the claim", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts"]));
	await tick();
	await complete(h, 0, a.id);
	assert.equal(h.store.get(a.id)?.status, TASK_STATUS.COMPLETED);
	const next = h.runner.run(writer(["lib/a.ts"]));
	assert.ok(next.id);
	h.runner.cancelAll();
});

test("failure releases the claim", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts"]));
	await tick();
	h.children[0].exit(1);
	await h.runner.waitFor(a.id);
	assert.equal(h.store.get(a.id)?.status, TASK_STATUS.FAILED);
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"])));
	h.runner.cancelAll();
});

test("a spawn failure releases the claim", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts"], { beforeSpawn: () => { throw new Error("session changed"); } }));
	await h.runner.waitFor(a.id);
	assert.equal(h.store.get(a.id)?.status, TASK_STATUS.FAILED);
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"])));
	h.runner.cancelAll();
});

test("cancelling a running or queued writer releases its claim", async () => {
	const h = harness(1);
	const running = h.runner.run(writer(["lib/a.ts"]));
	const queued = h.runner.run(writer(["lib/b.ts"]));
	await tick();
	assert.equal(h.runner.cancel(queued.id), true);
	assert.equal(h.store.get(queued.id)?.status, TASK_STATUS.CANCELLED);
	assert.doesNotThrow(() => h.runner.run(writer(["lib/b.ts"])));
	assert.equal(h.runner.cancel(running.id), true);
	await h.runner.waitFor(running.id);
	assert.equal(h.store.get(running.id)?.status, TASK_STATUS.CANCELLED);
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"])));
	h.runner.cancelAll();
});

test("a stall timeout releases the claim", async () => {
	const h = harness();
	const a = h.runner.run(writer(["lib/a.ts"]));
	await tick();
	h.fireTimers();
	await h.runner.waitFor(a.id);
	assert.equal(h.store.get(a.id)?.status, TASK_STATUS.TIMED_OUT);
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"])));
	h.runner.cancelAll();
});

// Verify m1: a quarantined writer may still be alive, so its claim lives as
// long as its reserved concurrency slot and is released only on proven exit.
test("a quarantined writer keeps its claim until its exit is confirmed", async () => {
	const store = new TaskStore();
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	let now = 0;
	let groupGone = false;
	const child = fakeChild({ exitOnKill: false, pid: 71 });
	const runner = new AgentRunner(store, { maxConcurrency: 5, stallTimeoutMs: 10_000 }, {
		spawn: () => child.child,
		now: () => now,
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pi: { command: "pi", args: [] },
		process: { platform: "linux", kill: (_pid, signal) => {
			if (signal === 0) throw Object.assign(new Error("group probe"), { code: groupGone ? "ESRCH" : "EPERM" });
		} },
	}, { askUser: async () => ({ cancelled: true }) });
	const first = runner.run(writer(["lib/a.ts"]));
	await tick();
	runner.cancel(first.id);
	timers.find((timer) => timer.ms === 250)!.fn();
	now = 2_000;
	timers.filter((timer) => timer.ms === 25).at(-1)!.fn();
	await tick();
	assert.match(store.get(first.id)?.error ?? "", /capacity quarantined/);
	assert.throws(() => runner.run(writer(["lib/a.ts"])), new RegExp(`task ${first.id}`), "the quarantined writer still holds its surfaces");
	groupGone = true;
	child.exit(0);
	await tick();
	assert.doesNotThrow(() => runner.run(writer(["lib/a.ts"])), "proven exit releases the claim");
	runner.cancelAll();
});

// Second verify A1: the claim key is the canonical worktree root supplied by
// the parent, not the spawn cwd, so a subdirectory cwd and the root conflict.
test("writers keyed to the same canonical root conflict whatever their cwd", async () => {
	const h = harness();
	const first = h.runner.run(writer(["lib/a.ts"], { cwd: "/repo/sub", writerRoot: "/repo" }));
	assert.throws(() => h.runner.run(writer(["lib/a.ts"], { cwd: "/repo", writerRoot: "/repo" })), new RegExp(`task ${first.id}`));
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"], { cwd: "/repo-worktrees/feature", writerRoot: "/repo-worktrees/feature" })));
	h.runner.cancelAll();
});

test("writers in different worktree roots never conflict", async () => {
	const h = harness();
	h.runner.run(writer(["lib/a.ts"], { cwd: "/repo" }));
	assert.doesNotThrow(() => h.runner.run(writer(["lib/a.ts"], { cwd: "/repo-worktrees/feature" })));
	await tick();
	assert.equal(h.children.length, 2);
	h.runner.cancelAll();
});

test("read-only agents are never registered and never blocked", async () => {
	const h = harness();
	h.runner.run(writer(["lib/**"]));
	const reader = h.runner.run(writer([], { agent: explorer, prompt: "Map lib/", writerSurfaces: undefined }));
	const second = h.runner.run(writer([], { agent: explorer, prompt: "Map lib/ again", writerSurfaces: undefined }));
	await tick();
	assert.equal(h.store.get(reader.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.store.get(second.id)?.status, TASK_STATUS.RUNNING);
	assert.doesNotThrow(() => h.runner.run(writer(["tests/a.ts"])), "a reader holds no surfaces");
	h.runner.cancelAll();
});
