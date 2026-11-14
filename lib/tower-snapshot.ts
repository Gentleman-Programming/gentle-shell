// Gentle Tower: the bounded, render-ready picture of one Gentle Shell session
// that the web tower draws as a floor. Pure: no I/O, no clocks of its own.

export const TOWER_SNAPSHOT_VERSION = 1;

export type TowerTodoStatus = "pending" | "in_progress" | "blocked" | "done" | "dropped";

export interface TowerTodo {
	id: number;
	title: string;
	status: TowerTodoStatus;
	note?: string;
}

export interface TowerSubagent {
	id: string;
	/** Role without the package prefix: worker, explore, verify… */
	role: string;
	/** Role, or role-word when the floor has more than one of that role. */
	name: string;
	status: string;
	lastStep?: string;
	cost: number;
	tokens: number;
}

export interface TowerSnapshot {
	version: typeof TOWER_SNAPSHOT_VERSION;
	sessionId: string;
	name: string;
	project: { cwd: string; name: string };
	model: string;
	effort?: string;
	context: { percent: number | null; window: number };
	cost: { total: number; input: number; output: number };
	todos: TowerTodo[];
	subagents: TowerSubagent[];
	phase?: string;
	updatedAt: number;
}

export interface TowerAgentInput {
	id: string;
	agent: string;
	label?: string;
	status?: string;
	lastStep?: string;
	usage?: { total?: number; cost?: number };
}

export interface TowerSnapshotInput {
	sessionId: string;
	sessionName?: string;
	cwd: string;
	modelId?: string;
	effort?: string;
	context?: { percent?: number | null; contextWindow?: number };
	stats: { cost: number; input: number; output: number };
	todos: readonly TowerTodo[];
	agents: readonly TowerAgentInput[];
	phase?: string;
	now: number;
}

const STOP_WORDS = new Set(["a", "an", "the", "to", "for", "of", "and", "in", "on", "with", "write", "run", "make", "do", "add", "fix", "check"]);

function roleOf(agent: string): string {
	return agent.replace(/^gentle-ai-/, "").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "helper";
}

function taskWord(agent: TowerAgentInput): string {
	const words = (agent.label ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const word = words.find((w) => !STOP_WORDS.has(w) && w.length > 1);
	return word ?? (agent.id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-4) || "x");
}

/** Names helpers by role; a role that repeats on the floor gets a word from its task. */
export function nameSubagents<T extends TowerAgentInput>(agents: readonly T[]): Array<T & { role: string; name: string }> {
	const counts = new Map<string, number>();
	for (const a of agents) counts.set(roleOf(a.agent), (counts.get(roleOf(a.agent)) ?? 0) + 1);
	return agents.map((a) => {
		const role = roleOf(a.agent);
		return { ...a, role, name: (counts.get(role) ?? 0) > 1 ? `${role}-${taskWord(a)}` : role };
	});
}

function baseName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

export function buildTowerSnapshot(input: TowerSnapshotInput): TowerSnapshot {
	const project = { cwd: input.cwd, name: baseName(input.cwd) };
	return {
		version: TOWER_SNAPSHOT_VERSION,
		sessionId: input.sessionId,
		name: input.sessionName?.trim() || project.name,
		project,
		model: input.modelId ?? "no-model",
		...(input.effort ? { effort: input.effort } : {}),
		context: { percent: input.context?.percent ?? null, window: input.context?.contextWindow ?? 0 },
		cost: { total: input.stats.cost, input: input.stats.input, output: input.stats.output },
		todos: input.todos.map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.note ? { note: t.note } : {}) })),
		subagents: nameSubagents(input.agents).map((a) => ({
			id: a.id,
			role: a.role,
			name: a.name,
			status: a.status ?? "unknown",
			...(a.lastStep ? { lastStep: a.lastStep } : {}),
			cost: a.usage?.cost ?? 0,
			tokens: a.usage?.total ?? 0,
		})),
		...(input.phase ? { phase: input.phase } : {}),
		updatedAt: input.now,
	};
}

export function isTowerSnapshot(value: unknown): value is TowerSnapshot {
	const v = value as Partial<TowerSnapshot> | null;
	return !!v && typeof v === "object" && v.version === TOWER_SNAPSHOT_VERSION && typeof v.sessionId === "string"
		&& typeof v.name === "string" && Array.isArray(v.todos) && Array.isArray(v.subagents);
}
