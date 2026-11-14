// Gentle Tower: the bounded, render-ready picture of one Gentle Shell session
// that the web tower draws as a floor. Pure: no I/O, no clocks of its own.

export const TOWER_SNAPSHOT_VERSION = 1;
export const TOWER_SAID_MAX = 600;

/** The latest visible assistant text on the branch (no thinking, no tool calls). */
export function latestAssistantText(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = (entries[i] as { type?: string; message?: { role?: string; content?: unknown } })?.message;
		if ((entries[i] as { type?: string })?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content.filter((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string").map((p: { text: string }) => p.text).join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

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
	/** Current permission mode (normal, auto, yolo, super-yolo). */
	permission?: string;
	/** Effective review mode. */
	review?: "on" | "off";
	/** A question is waiting for the person in the terminal. */
	waiting?: true;
	/** Result of the last action requested from the web view. */
	notice?: { text: string; ok: boolean; at: number };
	/** The orchestrator's latest visible words, bounded. */
	said?: string;
	/** Publishing process; a snapshot whose process is gone is stale. */
	pid?: number;
	/** A live session seen only through the peer presence registry (no tower extension): no tasks, cost or actions. */
	basic?: true;
	/** Spend per model in this session, for the bar tab. */
	models?: TowerModelSpend[];
	/** Docs, diagrams and images the session wrote. */
	artifacts?: TowerArtifact[];
	updatedAt: number;
}

export interface TowerModelSpend { model: string; cost: number; tokens: number }
export interface TowerArtifact { path: string; kind: "doc" | "diagram" | "image" }

const ARTIFACT_KINDS: Record<string, TowerArtifact["kind"]> = { ".md": "doc", ".markdown": "doc", ".txt": "doc", ".mmd": "diagram", ".mermaid": "diagram", ".svg": "image", ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image" };
export const TOWER_ARTIFACTS_MAX = 12;

/** Files the session wrote or edited successfully that the viewer can show, newest first. */
export function artifactsFromBranch(entries: readonly unknown[], cwd: string): TowerArtifact[] {
	const failed = new Set<string>();
	for (const e of entries as Array<{ type?: string; message?: { role?: string; toolCallId?: string; isError?: boolean } }>) {
		if (e?.type === "message" && e.message?.role === "toolResult" && e.message.isError === true && e.message.toolCallId) failed.add(e.message.toolCallId);
	}
	const seen = new Set<string>();
	const out: TowerArtifact[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < TOWER_ARTIFACTS_MAX; i--) {
		const m = (entries[i] as { type?: string; message?: { role?: string; content?: unknown } })?.message;
		if ((entries[i] as { type?: string })?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of [...m.content].reverse() as Array<{ type?: string; id?: string; name?: string; arguments?: { path?: unknown } }>) {
			if (part?.type !== "toolCall" || (part.name !== "write" && part.name !== "edit") || typeof part.arguments?.path !== "string") continue;
			if (part.id && failed.has(part.id)) continue;
			const raw = part.arguments.path;
			const path = raw.startsWith("/") ? raw : `${cwd.replace(/\/$/, "")}/${raw.replace(/^\.\//, "")}`;
			const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
			const kind = ARTIFACT_KINDS[ext];
			if (!kind || seen.has(path)) continue;
			seen.add(path);
			out.push({ path, kind });
		}
	}
	return out;
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
	permission?: string;
	review?: "on" | "off";
	waiting?: boolean;
	notice?: { text: string; ok: boolean; at: number };
	said?: string;
	models?: readonly TowerModelSpend[];
	artifacts?: readonly TowerArtifact[];
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
		...(input.permission ? { permission: input.permission } : {}),
		...(input.review ? { review: input.review } : {}),
		...(input.waiting ? { waiting: true as const } : {}),
		...(input.notice ? { notice: input.notice } : {}),
		...(input.said ? { said: input.said.length > TOWER_SAID_MAX ? `${input.said.slice(0, TOWER_SAID_MAX - 1)}…` : input.said } : {}),
		...(input.models?.length ? { models: input.models.map((m) => ({ model: m.model, cost: m.cost, tokens: m.tokens })) } : {}),
		...(input.artifacts?.length ? { artifacts: input.artifacts.slice(0, TOWER_ARTIFACTS_MAX).map((a) => ({ path: a.path, kind: a.kind })) } : {}),
		updatedAt: input.now,
	};
}

export function isTowerSnapshot(value: unknown): value is TowerSnapshot {
	const v = value as Partial<TowerSnapshot> | null;
	return !!v && typeof v === "object" && v.version === TOWER_SNAPSHOT_VERSION && typeof v.sessionId === "string"
		&& typeof v.name === "string" && Array.isArray(v.todos) && Array.isArray(v.subagents);
}
