import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTaskRegistry } from "../lib/agent-runtime/agent-task-registry.ts";

const error = (value: unknown): void => {
  assert.deepEqual(value, Object.freeze({ kind: "error", code: "invalid-input" }));
  assert(Object.isFrozen(value));
};

test("create contains hostile exact-input reflection", () => {
  let idCalls = 0;
  let clockCalls = 0;
  const registry = createAgentTaskRegistry({
    createId: () => { idCalls++; return "id"; },
    now: () => { clockCalls++; return 1; },
  });
  const inputs = [
    new Proxy({ name: "agent" }, { getPrototypeOf() { throw Error("prototype"); } }),
    new Proxy({ name: "agent" }, { ownKeys() { throw Error("keys"); } }),
    new Proxy({ name: "agent" }, { getOwnPropertyDescriptor() { throw Error("descriptor"); } }),
  ];
  for (const input of inputs) error(registry.create(input));
  assert.deepEqual([idCalls, clockCalls], [0, 0]);
});

test("terminal IDs with equal timestamps use code-unit order", () => {
  const ids = ["a_", "a-"];
  const registry = createAgentTaskRegistry({ createId: () => ids.shift(), now: () => 1 });
  const underscore = registry.create({ name: "underscore" });
  const hyphen = registry.create({ name: "hyphen" });
  assert.equal(underscore.kind, "ok");
  assert.equal(hyphen.kind, "ok");
  if (underscore.kind !== "ok" || hyphen.kind !== "ok") return;
  registry.transition(underscore.task.id, "running");
  registry.transition(underscore.task.id, "completed");
  registry.transition(hyphen.task.id, "running");
  registry.transition(hyphen.task.id, "completed");
  assert.deepEqual(registry.getSnapshot().tasks.map(task => task.id), ["a-", "a_"]);
});
