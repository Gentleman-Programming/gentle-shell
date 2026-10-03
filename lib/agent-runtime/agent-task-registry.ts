import { randomUUID } from "node:crypto";

export type AgentTaskState =
  | "queued" | "running" | "waiting-for-input" | "blocked" | "stopping"
  | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentTaskFailureCode =
  | "invalid-input" | "invalid-name" | "invalid-parent" | "capacity-exceeded"
  | "invalid-id" | "duplicate-id" | "unknown-task" | "invalid-transition"
  | "invalid-clock" | "notification-in-progress" | "revision-exhausted";
export interface AgentTaskRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: "managed-task";
  readonly state: AgentTaskState;
  readonly parent_id?: string;
  readonly started_at_ms?: number;
  readonly ended_at_ms?: number;
}
export interface AgentTaskRegistrySnapshot {
  readonly revision: number;
  readonly tasks: readonly AgentTaskRecord[];
}
export type AgentTaskMutationResult =
  | Readonly<{ kind: "ok"; task: AgentTaskRecord; snapshot: AgentTaskRegistrySnapshot }>
  | Readonly<{ kind: "error"; code: AgentTaskFailureCode }>;
export interface AgentTaskRegistry {
  create(input: unknown): AgentTaskMutationResult;
  transition(id: unknown, state: unknown): AgentTaskMutationResult;
  getSnapshot(): AgentTaskRegistrySnapshot;
  subscribe(listener: (snapshot: AgentTaskRegistrySnapshot) => void): () => void;
}

type CreateInput = { name: unknown; parent_id: unknown; hasParent: boolean };
type Listener = (snapshot: AgentTaskRegistrySnapshot) => void;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const states = new Set<AgentTaskState>([
  "queued", "running", "waiting-for-input", "blocked", "stopping",
  "completed", "failed", "cancelled", "interrupted",
]);
const terminalStates = new Set<AgentTaskState>([
  "completed", "failed", "cancelled", "interrupted",
]);
const transitions: Partial<Record<AgentTaskState, readonly AgentTaskState[]>> = {
  queued: ["running", "failed", "cancelled", "interrupted"],
  running: ["waiting-for-input", "blocked", "stopping", "completed", "failed", "cancelled", "interrupted"],
  "waiting-for-input": ["running", "blocked", "stopping", "failed", "cancelled", "interrupted"],
  blocked: ["running", "waiting-for-input", "stopping", "failed", "cancelled", "interrupted"],
  stopping: ["completed", "failed", "cancelled", "interrupted"],
};

const failure = (code: AgentTaskFailureCode): AgentTaskMutationResult =>
  Object.freeze({ kind: "error", code });
const isTerminal = (state: AgentTaskState): boolean => terminalStates.has(state);
const isValidClock = (value: unknown, previous: number | undefined): value is number =>
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value >= 0
  && (previous === undefined || value >= previous);

const compareTasks = (left: AgentTaskRecord, right: AgentTaskRecord): number => {
  const leftTerminal = isTerminal(left.state);
  const rightTerminal = isTerminal(right.state);
  if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
  if (!leftTerminal) return 0;
  const leftEnded = left.ended_at_ms;
  const rightEnded = right.ended_at_ms;
  if (leftEnded === undefined || rightEnded === undefined) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  const endedDifference = rightEnded - leftEnded;
  return endedDifference || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
};

const readExactCreateInput = (input: unknown): CreateInput | undefined => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(input).length > 0) return undefined;
    const keys = Object.getOwnPropertyNames(input);
    if (!keys.includes("name") || keys.some(key => key !== "name" && key !== "parent_id")) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const name = descriptors.name;
    if (!name || !("value" in name)) return undefined;
    const parent = descriptors.parent_id;
    if (parent && !("value" in parent)) return undefined;
    return { name: name.value, parent_id: parent?.value, hasParent: Boolean(parent) };
  } catch { return undefined; }
};

export const nextAgentTaskRevision = (revision: number): number | undefined =>
  revision < Number.MAX_SAFE_INTEGER ? revision + 1 : undefined;

export function createAgentTaskRegistry(
  options: { createId?: () => unknown; now?: () => unknown } = {},
): AgentTaskRegistry {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  const tasks = new Map<string, AgentTaskRecord>();
  const listeners = new Set<Listener>();
  let revision = 0;
  let lastTime: number | undefined;
  let notifying = false;
  let current: AgentTaskRegistrySnapshot = Object.freeze({ revision, tasks: Object.freeze([]) });

  const snapshot = (): AgentTaskRegistrySnapshot =>
    Object.freeze({ revision, tasks: Object.freeze([...tasks.values()].sort(compareTasks)) });
  const readClock = (): number | undefined => {
    try {
      const value = now();
      return isValidClock(value, lastTime) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const notify = (): void => {
    notifying = true;
    try {
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch {}
      }
    } finally {
      notifying = false;
    }
  };
  const commit = (task: AgentTaskRecord, time: number): AgentTaskMutationResult => {
    const nextRevision = nextAgentTaskRevision(revision);
    if (nextRevision === undefined) return failure("revision-exhausted");
    revision = nextRevision;
    lastTime = time;
    tasks.set(task.id, task);
    current = snapshot();
    const result = Object.freeze({ kind: "ok" as const, task, snapshot: current });
    notify();
    return result;
  };

  return {
    create(input) {
      if (notifying) return failure("notification-in-progress");
      const value = readExactCreateInput(input);
      if (!value) return failure("invalid-input");
      if (typeof value.name !== "string" || !NAME.test(value.name)) return failure("invalid-name");
      if (tasks.size >= 1000) return failure("capacity-exceeded");
      if (value.hasParent && (typeof value.parent_id !== "string" || !ID.test(value.parent_id) || !tasks.has(value.parent_id))) return failure("invalid-parent");
      if (nextAgentTaskRevision(revision) === undefined) return failure("revision-exhausted");
      let id: unknown;
      try {
        id = createId();
      } catch {
        return failure("invalid-id");
      }
      if (typeof id !== "string" || !ID.test(id)) return failure("invalid-id");
      if (tasks.has(id)) return failure("duplicate-id");
      const time = readClock();
      if (time === undefined) return failure("invalid-clock");
      const task: AgentTaskRecord = {
        id,
        name: value.name,
        kind: "managed-task",
        state: "queued",
        ...(typeof value.parent_id === "string" ? { parent_id: value.parent_id } : {}),
      };
      return commit(Object.freeze(task), time);
    },
    transition(id, state) {
      if (notifying) return failure("notification-in-progress");
      if (typeof id !== "string" || !ID.test(id)) return failure("invalid-input");
      if (typeof state !== "string" || !states.has(state as AgentTaskState)) return failure("invalid-input");
      const task = tasks.get(id);
      if (!task) return failure("unknown-task");
      const next = state as AgentTaskState;
      if (!transitions[task.state]?.includes(next)) return failure("invalid-transition");
      if (nextAgentTaskRevision(revision) === undefined) return failure("revision-exhausted");
      const time = readClock();
      if (time === undefined) return failure("invalid-clock");
      const updated: AgentTaskRecord = {
        ...task,
        state: next,
        ...(next === "running" && task.started_at_ms === undefined ? { started_at_ms: time } : {}),
        ...(isTerminal(next) ? { ended_at_ms: time } : {}),
      };
      return commit(Object.freeze(updated), time);
    },
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };
}
