// Pure mapping from live snapshots to what the tower shows. No DOM, no Pixi.
import type { FloorState, Project, TowerChatTurn, TowerSnapshot, TowerSubagent, TowerTodo } from "./types";

export type RoomId = "map" | "workshop" | "lab" | "review" | "engram" | "engine" | "lounge";

export const FLOOR_COLORS = ["#f095c8", "#5ee6e6", "#b4e7c7", "#e0c27a", "#a9c7ee", "#b48cff", "#ffb1dd", "#ff718f"];

/** Sessions grouped by project folder; projects and floors keep a stable order. */
export function groupProjects(sessions: readonly TowerSnapshot[]): Project[] {
	const byCwd = new Map<string, Project>();
	for (const s of [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
		const p = byCwd.get(s.project.cwd) ?? { id: s.project.name, cwd: s.project.cwd, sessions: [] };
		p.sessions.push(s);
		byCwd.set(s.project.cwd, p);
	}
	const projects = [...byCwd.values()].sort((a, b) => a.id.localeCompare(b.id) || a.cwd.localeCompare(b.cwd));
	// Two folders with the same name: keep both, tell them apart.
	const seen = new Map<string, number>();
	for (const p of projects) {
		const n = (seen.get(p.id) ?? 0) + 1;
		seen.set(p.id, n);
		if (n > 1) p.id = `${p.id} (${n})`;
	}
	return projects;
}

export function openTodos(todos: readonly TowerTodo[]): TowerTodo[] {
	return todos.filter((t) => t.status !== "dropped");
}

export function todoProgress(todos: readonly TowerTodo[]): { done: number; total: number; now?: TowerTodo } {
	const open = openTodos(todos);
	const now = open.find((t) => t.status === "blocked") ?? open.find((t) => t.status === "in_progress") ?? open.find((t) => t.status === "pending");
	return { done: open.filter((t) => t.status === "done").length, total: open.length, ...(now ? { now } : {}) };
}

export function floorState(s: TowerSnapshot): FloorState {
	// Without the tower we cannot tell whether it waits or finished; it is live, so it works.
	if (s.basic) return "work";
	const p = todoProgress(s.todos);
	if (s.waiting || s.todos.some((t) => t.status === "blocked")) return "need";
	if (p.total > 0 && p.done === p.total && !s.subagents.some((a) => a.status === "running")) return "done";
	return "work";
}

const PHASE_ROOM: Record<string, RoomId> = {
	authorizing: "map", exploring: "map", researching: "engram", deciding: "map", planning: "map",
	implementing: "workshop", checking: "lab", closing: "lounge",
};

export function orchestratorRoom(s: TowerSnapshot): RoomId {
	const state = floorState(s);
	if (state === "done") return "lounge";
	if (s.phase && PHASE_ROOM[s.phase]) return PHASE_ROOM[s.phase];
	return state === "need" ? "workshop" : "map";
}

export function helperRoom(a: TowerSubagent): RoomId {
	if (a.status !== "running" && a.status !== "queued" && a.status !== "waiting") return "lounge";
	if (a.role.startsWith("review") || a.role.startsWith("jd-")) return "review";
	if (a.role === "verify") return "lab";
	if (a.role === "explore") return /memory|recall|engram/i.test(a.lastStep ?? "") ? "engram" : "map";
	if (a.role === "worker") return /test/i.test(a.lastStep ?? "") ? "lab" : "workshop";
	return "workshop";
}

export function money(n: number): string {
	return `$${n.toFixed(2)}`;
}

// ---------- intercom: matching a sent message with the session's record of it ----------
/** The session cuts a chat turn at this many characters, ending it with "…" (lib/tower-snapshot.ts TOWER_CHAT_TEXT_MAX). */
const CHAT_TEXT_MAX = 1200;
/** How much earlier than the send a turn may be stamped (same machine, but separate clocks reads). */
const ECHO_SLACK_MS = 2000;
const turnKey = (t: TowerChatTurn) => `${t.at}|${t.text}`;

/** A message sent from the intercom, with the "you" turns already in the chat when it was sent. */
export interface SentMessage { text: string; at: number; before: ReadonlySet<string> }
export function sentMessage(text: string, at: number, chat: readonly TowerChatTurn[]): SentMessage {
	return { text, at, before: new Set(chat.filter((t) => t.role === "you").map(turnKey)) };
}

/** The "you" turn that is the session's record of this message: new since sending, stamped at or after it
 * (within a small slack), not already used for another message, and with the same text (a prefix only when
 * the session cut the turn at its length limit). Undefined while the session has not recorded it. */
export function echoTurn(o: SentMessage, chat: readonly TowerChatTurn[], used: ReadonlySet<TowerChatTurn>): TowerChatTurn | undefined {
	return chat.find((t) => {
		if (t.role !== "you" || used.has(t) || o.before.has(turnKey(t)) || t.at < o.at - ECHO_SLACK_MS) return false;
		if (t.text === o.text) return true;
		const cut = t.text.length === CHAT_TEXT_MAX && t.text.endsWith("…");
		return cut && o.text.startsWith(t.text.slice(0, -1));
	});
}
