import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentTaskRegistry,
  nextAgentTaskRevision,
} from "../lib/agent-runtime/agent-task-registry.ts";

type Ok = Extract<ReturnType<ReturnType<typeof createAgentTaskRegistry>["create"]>, { kind: "ok" }>;
const ok = (value: unknown): Ok => {
  assert.equal((value as { kind: string }).kind, "ok");
  return value as Ok;
};
const error = (value: unknown, code: string): void => {
  assert.deepEqual(value, Object.freeze({ kind: "error", code }));
  assert(Object.isFrozen(value));
};
const registry = (ids = ["a", "b", "c"], clocks = [1, 2, 3, 4, 5, 6]) => {
  let idCalls = 0;
  let clockCalls = 0;
  const value = createAgentTaskRegistry({
    createId: () => {
      idCalls++;
      return ids.shift();
    },
    now: () => {
      clockCalls++;
      return clocks.shift();
    },
  });
  return { value, calls: () => [idCalls, clockCalls] };
};

test("initial snapshot and revision helper are immutable and bounded", () => {
  const snapshot = registry().value.getSnapshot();
  assert.deepEqual(snapshot, { revision: 0, tasks: [] });
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.tasks));
  assert.equal(nextAgentTaskRevision(0), 1);
  assert.equal(nextAgentTaskRevision(Number.MAX_SAFE_INTEGER), undefined);
});

test("create validates exact data without invoking rejected accessors", () => {
  const { value, calls } = registry();
  let accessorCalls = 0;
  const accessor = Object.create(null, {
    name: { enumerable: true, get() { accessorCalls++; throw Error("read"); } },
  });
  const inherited = Object.create({ name: "agent" });
  const symbol = Object.assign(Object.create(null), { name: "agent" }, { [Symbol("x")]: "no" });
  for (const input of [null, [], inherited, accessor, symbol, { name: "agent", extra: "no" }]) {
    error(value.create(input), "invalid-input");
  }
  assert.equal(accessorCalls, 0);
  assert.deepEqual(calls(), [0, 0]);
  for (const name of ["", "-bad", "a!", "a".repeat(65)]) {
    error(value.create({ name }), "invalid-name");
  }
  const result = ok(value.create({ name: "agent" }));
  assert.equal(result.task.id, "a");
  assert.equal(result.task.kind, "managed-task");
  assert.strictEqual(result.task, result.snapshot.tasks[0]);
  assert.strictEqual(result.snapshot, value.getSnapshot());
  assert.deepEqual(calls(), [1, 1]);
});

test("creation validates IDs, parents, capacity, and immutable ancestry", () => {
  const invalid = registry(["bad id"]);
  error(invalid.value.create({ name: "agent" }), "invalid-id");
  assert.deepEqual(invalid.calls(), [1, 0]);
  const duplicate = registry(["a", "a"]);
  ok(duplicate.value.create({ name: "agent" }));
  error(duplicate.value.create({ name: "child" }), "duplicate-id");
  const { value, calls } = registry();
  for (const parent_id of ["missing", 1, undefined]) error(value.create({ name: "child", parent_id }), "invalid-parent");
  assert.deepEqual(calls(), [0, 0]);
  const parent = ok(value.create({ name: "parent" })).task;
  const child = ok(value.create({ name: "child", parent_id: parent.id })).task;
  assert.equal(child.parent_id, parent.id);
  assert(Object.isFrozen(child));
  assert.throws(() => { (child as { parent_id?: string }).parent_id = "other"; });
  let sequence = 0;
  const capacity = createAgentTaskRegistry({ createId: () => `x${sequence++}`, now: () => 1 });
  for (let index = 0; index < 1000; index++) ok(capacity.create({ name: `a${index}` }));
  error(capacity.create({ name: "overflow" }), "capacity-exceeded");
});

test("transitions retain lifecycle timestamps and reject invalid changes", () => {
  const { value } = registry(["a"], [10, 20, 30, 40, 50]);
  const queued = ok(value.create({ name: "agent" })).task;
  assert.equal("started_at_ms" in queued, false);
  assert.equal("ended_at_ms" in queued, false);
  const running = ok(value.transition(queued.id, "running")).task;
  assert.equal(running.started_at_ms, 20);
  const waiting = ok(value.transition(queued.id, "waiting-for-input")).task;
  const reentered = ok(value.transition(queued.id, "running")).task;
  assert.equal(reentered.started_at_ms, running.started_at_ms);
  const completed = ok(value.transition(queued.id, "completed")).task;
  assert.equal(completed.ended_at_ms, 50);
  error(value.transition(queued.id, "queued"), "invalid-transition");
  error(value.transition("missing", "running"), "unknown-task");
  error(value.transition(1, "running"), "invalid-input");
  error(value.transition(queued.id, "no"), "invalid-input");
  assert.equal(waiting.state, "waiting-for-input");
});

test("snapshots preserve non-terminal creation order and terminal completion order", () => {
  const { value } = registry(["a", "b", "c"], [1, 2, 3, 4, 5, 6, 7]);
  const a = ok(value.create({ name: "a" })).task;
  const b = ok(value.create({ name: "b" })).task;
  const c = ok(value.create({ name: "c" })).task;
  ok(value.transition(c.id, "running"));
  ok(value.transition(a.id, "running"));
  assert.deepEqual(value.getSnapshot().tasks.map(task => task.id), [a.id, b.id, c.id]);
  ok(value.transition(a.id, "completed"));
  ok(value.transition(c.id, "completed"));
  assert.deepEqual(value.getSnapshot().tasks.map(task => task.id), [b.id, c.id, a.id]);
});

test("revision advances once per success and retained values reject caller mutation", () => {
  const { value } = registry(["a"], [1, 2]);
  const initial = value.getSnapshot();
  error(value.transition("missing", "running"), "unknown-task");
  assert.equal(value.getSnapshot().revision, initial.revision);
  const created = ok(value.create({ name: "a" }));
  assert.equal(created.snapshot.revision, initial.revision + 1);
  error(value.transition(created.task.id, "queued"), "invalid-transition");
  assert.equal(value.getSnapshot().revision, created.snapshot.revision);
  const running = ok(value.transition(created.task.id, "running"));
  assert.equal(running.snapshot.revision, created.snapshot.revision + 1);
  for (const valueToMutate of [running, running.task, running.snapshot, running.snapshot.tasks]) {
    assert(Object.isFrozen(valueToMutate));
  }
  assert.throws(() => { (running.snapshot.tasks as unknown[]).push({}); });
  assert.throws(() => { (running.task as { state: string }).state = "failed"; });
  assert.equal(value.getSnapshot().tasks[0].state, "running");
});

test("clock failures, terminal ties, and subscriptions are deterministic and contained", () => {
  const badClock = createAgentTaskRegistry({ createId: () => "a", now: () => { throw Error("no"); } });
  error(badClock.create({ name: "a" }), "invalid-clock");
  const nonMonotonic = registry(["a"], [2, 1]);
  const task = ok(nonMonotonic.value.create({ name: "a" })).task;
  error(nonMonotonic.value.transition(task.id, "running"), "invalid-clock");
  const ties = registry(["b", "a", "next"], [1, 1, 1, 1, 1, 1, 1]);
  const b = ok(ties.value.create({ name: "b" })).task;
  const a = ok(ties.value.create({ name: "a" })).task;
  ok(ties.value.transition(b.id, "running"));
  ok(ties.value.transition(b.id, "completed"));
  ok(ties.value.transition(a.id, "running"));
  ok(ties.value.transition(a.id, "completed"));
  assert.deepEqual(ties.value.getSnapshot().tasks.map(task => task.id), ["a", "b"]);
  const observed: unknown[] = [];
  let nested: unknown;
  const unsubscribe = ties.value.subscribe(snapshot => {
    observed.push(snapshot);
    nested = ties.value.create({ name: "nested" });
  });
  const result = ok(ties.value.create({ name: "next" }));
  assert.strictEqual(observed[0], result.snapshot);
  error(nested, "notification-in-progress");
  unsubscribe();
});
