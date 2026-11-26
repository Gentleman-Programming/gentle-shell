// Gentle Tower: the bounded, render-ready picture of one Gentle Shell session
// that the web tower draws as a floor. Pure: no I/O, no clocks of its own.

export const TOWER_SNAPSHOT_VERSION = 1;
export const TOWER_SAID_MAX = 600;
/** The hub refuses a larger file; the snapshot is built to always fit under it. */
export const TOWER_SNAPSHOT_MAX_BYTES = 64 * 1024;
/** Per-field and per-list bounds; a list that is cut says how many entries it left out. */
const TEXT_MAX = { name: 200, title: 300, note: 400, step: 300, model: 160, notice: 400, word: 80 } as const;
const LIST_MAX = { todos: 200, subagents: 40, models: 40 } as const;
/** Paths are used to open files and launch floors, so they are never cut: a longer artifact path is left out instead. The project folder is always kept whole. */
export const TOWER_PATH_MAX = 4096;

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

/** The intercom conversation: the latest visible turns, each bounded. */
export const TOWER_CHAT_TURNS = 12;
export const TOWER_CHAT_TEXT_MAX = 1200;
/** Automated wakes open with this prefix (extensions/gentle-agents.ts PARENT_WAKE_TEXT); they are not the person's words. */
const AUTOMATED_USER_PREFIX = "[System-generated ";

export interface TowerChatTurn { role: "you" | "agent"; text: string; at: number }

function visibleText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string").map((p: { text: string }) => p.text).join("\n").trim();
}

/** The latest visible turns of the branch, oldest first: what the person typed and what the agent said
 * (no thinking, tool calls, tool output, custom or system-generated messages). When many assistant
 * tool turns fill the window, keep the latest human question with the newest replies. */
export function chatFromBranch(entries: readonly unknown[]): TowerChatTurn[] {
	const out: TowerChatTurn[] = [];
	let hasUser = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; timestamp?: unknown; message?: { role?: string; content?: unknown; timestamp?: unknown } };
		const m = e?.message;
		if (e?.type !== "message" || (m?.role !== "user" && m?.role !== "assistant")) continue;
		const text = visibleText(m.content);
		if (!text || (m.role === "user" && text.startsWith(AUTOMATED_USER_PREFIX))) continue;
		if (out.length === TOWER_CHAT_TURNS) {
			if (hasUser) break;
			if (m.role !== "user") continue;
			out.pop(); // make room for the question; retain the newest assistant turns
		}
		const at = typeof m.timestamp === "number" ? m.timestamp : typeof e.timestamp === "string" ? Date.parse(e.timestamp) || 0 : 0;
		out.push({ role: m.role === "user" ? "you" : "agent", text: clip(text, TOWER_CHAT_TEXT_MAX), at });
		if (m.role === "user") hasUser = true;
	}
	return out.reverse();
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
	/** The orchestrator's latest visible words, bounded (kept for views that predate `chat`). */
	said?: string;
	/** The latest visible conversation turns, oldest first. */
	chat?: TowerChatTurn[];
	/** Publishing process; a snapshot whose process is gone is stale. */
	pid?: number;
	/** A live session seen only through the peer presence registry (no tower extension): no tasks, cost or actions. */
	basic?: true;
	/** Spend per model in this session, for the bar tab. */
	models?: TowerModelSpend[];
	/** Docs, diagrams and images the session wrote. */
	artifacts?: TowerArtifact[];
	/** Entries left out so the snapshot fits the hub limit. */
	omitted?: { todos?: number; subagents?: number; models?: number; artifacts?: number; chat?: number };
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
	chat?: readonly TowerChatTurn[];
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

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Cuts lists until the snapshot fits: the oldest chat turns first, then notes and steps, then finished tasks, then the oldest tail of each list. */
function fit(s: TowerSnapshot, input: { todos: number; subagents: number; models: number; artifacts: number; chat: number }): TowerSnapshot {
	const record = () => {
		const omitted = {
			...(input.todos > s.todos.length ? { todos: input.todos - s.todos.length } : {}),
			...(input.subagents > s.subagents.length ? { subagents: input.subagents - s.subagents.length } : {}),
			...(input.models > (s.models?.length ?? 0) ? { models: input.models - (s.models?.length ?? 0) } : {}),
			...(input.artifacts > (s.artifacts?.length ?? 0) ? { artifacts: input.artifacts - (s.artifacts?.length ?? 0) } : {}),
			...(input.chat > (s.chat?.length ?? 0) ? { chat: input.chat - (s.chat?.length ?? 0) } : {}),
		};
		if (Object.keys(omitted).length) s.omitted = omitted; else delete s.omitted;
	};
	const fits = () => { record(); return bytes(s) <= TOWER_SNAPSHOT_MAX_BYTES; };
	const halve = <T>(list: T[] | undefined) => (list && list.length ? list.slice(0, Math.floor(list.length / 2)) : list);
	const steps: Array<() => boolean> = [
		() => { const had = s.todos.some((t) => t.note); s.todos = s.todos.map(({ note: _n, ...t }) => t); return had; },
		() => { const had = s.subagents.some((a) => a.lastStep); s.subagents = s.subagents.map(({ lastStep: _l, ...a }) => a); return had; },
		() => { const open = s.todos.filter((t) => t.status !== "done" && t.status !== "dropped"); const had = open.length < s.todos.length; s.todos = open; return had; },
	];
	if (fits()) return s;
	while (s.chat?.length) {
		s.chat = s.chat.slice(1);
		if (!s.chat.length) delete s.chat;
		if (fits()) return s;
	}
	for (const step of steps) if (step() && fits()) return s;
	// Still too large: halve the longest list until it fits (each list is bounded, so this ends).
	for (let guard = 0; guard < 64 && !fits(); guard++) {
		const lists = [
			["todos", bytes(s.todos)], ["subagents", bytes(s.subagents)], ["models", bytes(s.models ?? [])], ["artifacts", bytes(s.artifacts ?? [])],
		] as const;
		const [key] = [...lists].sort((a, b) => b[1] - a[1])[0];
		if (key === "todos") s.todos = halve(s.todos)!;
		else if (key === "subagents") s.subagents = halve(s.subagents)!;
		else if (key === "models") s.models = halve(s.models);
		else s.artifacts = halve(s.artifacts);
	}
	return s;
}

export function buildTowerSnapshot(input: TowerSnapshotInput): TowerSnapshot {
	const project = { cwd: input.cwd, name: clip(baseName(input.cwd), TEXT_MAX.name) };
	const word = (v: string) => clip(v, TEXT_MAX.word);
	const chat = (input.chat ?? []).slice(-TOWER_CHAT_TURNS).map((t) => ({ role: t.role, text: clip(t.text, TOWER_CHAT_TEXT_MAX), at: t.at }));
	const snapshot: TowerSnapshot = {
		version: TOWER_SNAPSHOT_VERSION,
		sessionId: input.sessionId,
		name: clip(input.sessionName?.trim() || project.name, TEXT_MAX.name),
		project,
		model: clip(input.modelId ?? "no-model", TEXT_MAX.model),
		...(input.effort ? { effort: word(input.effort) } : {}),
		context: { percent: input.context?.percent ?? null, window: input.context?.contextWindow ?? 0 },
		cost: { total: input.stats.cost, input: input.stats.input, output: input.stats.output },
		todos: input.todos.slice(0, LIST_MAX.todos).map((t) => ({ id: t.id, title: clip(t.title, TEXT_MAX.title), status: t.status, ...(t.note ? { note: clip(t.note, TEXT_MAX.note) } : {}) })),
		subagents: nameSubagents(input.agents.slice(0, LIST_MAX.subagents)).map((a) => ({
			id: a.id,
			role: word(a.role),
			name: word(a.name),
			status: word(a.status ?? "unknown"),
			...(a.lastStep ? { lastStep: clip(a.lastStep, TEXT_MAX.step) } : {}),
			cost: a.usage?.cost ?? 0,
			tokens: a.usage?.total ?? 0,
		})),
		...(input.phase ? { phase: word(input.phase) } : {}),
		...(input.permission ? { permission: word(input.permission) } : {}),
		...(input.review ? { review: input.review } : {}),
		...(input.waiting ? { waiting: true as const } : {}),
		...(input.notice ? { notice: { ...input.notice, text: clip(input.notice.text, TEXT_MAX.notice) } } : {}),
		...(input.said ? { said: clip(input.said, TOWER_SAID_MAX) } : {}),
		...(chat.length ? { chat } : {}),
		...(input.models?.length ? { models: input.models.slice(0, LIST_MAX.models).map((m) => ({ model: clip(m.model, TEXT_MAX.model), cost: m.cost, tokens: m.tokens })) } : {}),
		...(input.artifacts?.length ? { artifacts: input.artifacts.slice(0, TOWER_ARTIFACTS_MAX).filter((a) => a.path.length <= TOWER_PATH_MAX).map((a) => ({ path: a.path, kind: a.kind })) } : {}),
		updatedAt: input.now,
	};
	return fit(snapshot, { todos: input.todos.length, subagents: input.agents.length, models: input.models?.length ?? 0, artifacts: Math.min(input.artifacts?.length ?? 0, TOWER_ARTIFACTS_MAX), chat: chat.length });
}

export function isTowerSnapshot(value: unknown): value is TowerSnapshot {
	const v = value as Partial<TowerSnapshot> | null;
	return !!v && typeof v === "object" && v.version === TOWER_SNAPSHOT_VERSION && typeof v.sessionId === "string"
		&& typeof v.name === "string" && Array.isArray(v.todos) && Array.isArray(v.subagents);
}
