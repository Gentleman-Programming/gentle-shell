import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { HERDR_DESKTOP_TASKS, HERDR_DESKTOP_TASKS_REQUEST, HERDR_DESKTOP_TASK_FINISHED, HERDR_DESKTOP_JOBS, HERDR_DESKTOP_JOB_SETTLED, HERDR_DESKTOP_CONSULT, HERDR_DESKTOP_SEND, HERDR_DESKTOP_INBOUND, type HerdrDesktopTask } from "../lib/herdr-desktop-events.ts";
import { desktopJobTitle, desktopTaskTitle, diffRecords, hasUsableDesktopLabel, projectAll, SEND_TTL_MS, ERROR_TTL_MS, type DesktopRecord } from "../lib/herdr-desktop-status.ts";
import { isJobsSidebarSnapshot, JOBS_SIDEBAR_EVENT, type JobsSidebarSnapshot, type RunningJobDisplay } from "../lib/jobs-sidebar-state.ts";
import { replayTodo, todoProgress, TODO_PROGRESS_EVENT, type TodoState } from "../lib/shell-todo.ts";

const WIDGET_KEY = "gentle-shell:herdr-desktop-status";
/** Delay before retrying a diff the terminal rejected part of. */
export const WRITE_RETRY_MS = 1000;
const taskStatuses = new Set(["queued", "running", "waiting", "completed", "failed", "cancelled", "timed_out"]);
const todoStatuses = new Set(["pending", "in_progress", "blocked", "done", "dropped"]);

interface StatusOptions {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Schedule one expiry; return a cancellation function. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

// OSC IDs allow slash, but Herdr clears descendants with an ancestor. Reserve
// h- for hashed segments; the longer subagents/ prefix needs a shorter hash.
function segment(value: string, maxLength = 59): string {
	return value.length <= maxLength && /^[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("h-")
		? value : `h-${createHash("sha256").update(value).digest("hex").slice(0, Math.min(56, maxLength - 2))}`;
}
function validTasks(value: unknown): value is HerdrDesktopTask[] {
	return Array.isArray(value) && Array.from(value).every(task => task && typeof task === "object"
		&& typeof task.id === "string" && task.id.length > 0 && typeof task.agent === "string" && task.agent.trim().length > 0
		&& typeof task.status === "string" && taskStatuses.has(task.status)
		&& (task.label === undefined || typeof task.label === "string")
		&& (task.explicitLabel === undefined || typeof task.explicitLabel === "string")
		&& (task.pendingQuery === undefined || typeof task.pendingQuery === "boolean"));
}
function validTodoTasks(value: unknown): value is TodoState["tasks"] {
	return Array.isArray(value) && Array.from(value).every(task => task && typeof task === "object"
		&& typeof task.title === "string" && typeof task.status === "string" && todoStatuses.has(task.status));
}
function validProgress(value: unknown): value is { done: number; total: number; current: string | null } {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.done === "number" && Number.isSafeInteger(v.done) && v.done >= 0
		&& typeof v.total === "number" && Number.isSafeInteger(v.total) && v.total >= v.done
		&& (v.current === null || (typeof v.current === "string" && v.total > 0));
}

type Session = {
	id: string;
	startedAt: number;
	ctx: ExtensionContext;
	manager: ExtensionContext["sessionManager"];
	terminal?: Terminal;
	previous: Map<string, DesktopRecord>;
	todo?: unknown;
	jobs?: JobsSidebarSnapshot;
	tasks: HerdrDesktopTask[];
	jobMetadata: Map<string, { explicitLabel?: string; kind?: "command" | "monitor" }>;
	taskLabels: Map<string, string>;
	consults: Map<string, string>;
	sends: Map<string, number>;
	asksFromPeers: Map<string, Map<string, string>>;
	errors: Map<string, { record: DesktopRecord; expiresAt: number }>;
	seenJobErrors: Set<string>;
	seenTaskErrors: Set<string>;
	/** The last diff stopped at a failed write; retry even without a TTL deadline. */
	dirty: boolean;
	cancelTimer?: () => void;
	unsubscribe: Array<() => void>;
};

export function createHerdrDesktopStatusExtension(options: StatusOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const env = options.env ?? process.env;
		// Fail closed on any GENTLE_PI_AGENTS_CHILD value (gentle-agents checks === "1"): this
		// publishes to an external host, so an ambiguous marker never enables it.
		if (!env.HC_TERMINAL_ID || env.PI_PROGRAM_STATUS_APP !== "gentle-shell" || env.GENTLE_PI_AGENTS_CHILD !== undefined) return;
		const now = options.now ?? Date.now;
		const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer);
		});
		let owner: Session | undefined;
		// Keep seen job identities across replacement of the same session so an
		// old finished sidebar tail cannot revive a record we just cleared.
		const seenJobsBySession = new Map<string, Set<string>>();
		// Records a closing owner could not clear. The next owner starts from them, so
		// its first diff clears them unless it publishes a replacement with the same ID.
		let unflushed = new Map<string, DesktopRecord>();
		const owns = (ctx: ExtensionContext) => owner !== undefined && ctx.sessionManager === owner.manager && ctx.sessionManager.getSessionId() === owner.id;
		// Track successful individual writes so a later cleanup can clear even a
		// partially published diff if terminal.write throws.
		const apply = (s: Session, next: Map<string, DesktopRecord>): boolean => {
			if (!s.terminal) return true;
			for (const chunk of diffRecords(s.previous, next)) {
				try { s.terminal.write(chunk); } catch { return false; }
				const id = /:id=([A-Za-z0-9_./-]+)\x1b\\$/.exec(chunk)?.[1];
				if (!id) continue;
				const record = next.get(id);
				if (record) s.previous.set(id, record); else s.previous.delete(id);
			}
			return true;
		};
		const publish = (s: Session) => {
			if (owner !== s) return;
			const time = now();
			for (const [target, at] of s.sends) if (time - at >= SEND_TTL_MS) s.sends.delete(target);
			for (const [id, error] of s.errors) if (time >= error.expiresAt) s.errors.delete(id);
			const targets = [...new Set(s.consults.values())];
			const next = projectAll({ todo: s.todo,
				jobs: s.jobs && { jobs: s.jobs.jobs.map(job => ({ ...job, id: segment(job.id) })) },
				subagents: s.tasks.map(task => ({ ...task, id: segment(task.id, 54) })),
				waits: targets.map(target => segment(target)), sends: [...s.sends].map(([target, at]) => ({ target: segment(target), at })), now: time });
			// IDs are opaque safe segments, but the user-facing text names the real target.
			for (const target of targets) { const item = next.get(`wait/${segment(target)}`); if (item) item.msg = `consulting ${target}`; }
			for (const target of s.sends.keys()) { const item = next.get(`sent/${segment(target)}`); if (item) item.msg = `sent to ${target}`; }
			for (const [id, error] of s.errors) next.set(id, error.record);
			for (const [peer, pending] of s.asksFromPeers) {
				const name = [...pending.values()].at(-1);
				if (name !== undefined) next.set(`ask/${segment(peer)}`, { state: "blocked", kind: "question", title: name, msg: `question from ${name}` });
			}
			s.dirty = !apply(s, next);
			// arm keeps the earliest deadline, so a pending TTL timer never delays the retry.
			if (s.dirty) arm(s);
		};
		const arm = (s: Session) => {
			s.cancelTimer?.(); s.cancelTimer = undefined;
			if (owner !== s || (s.sends.size === 0 && s.errors.size === 0 && !s.dirty)) return;
			const deadlines = [...s.sends.values()].map(at => at + SEND_TTL_MS);
			for (const error of s.errors.values()) deadlines.push(error.expiresAt);
			if (s.dirty) deadlines.push(now() + WRITE_RETRY_MS);
			const delay = Math.max(0, Math.min(...deadlines) - now());
			s.cancelTimer = schedule(() => { s.cancelTimer = undefined; publish(s); arm(s); }, delay);
		};
		const close = (s: Session) => {
			s.cancelTimer?.(); s.cancelTimer = undefined;
			for (const unsubscribe of s.unsubscribe) unsubscribe();
			s.unsubscribe = [];
			apply(s, new Map());
			if (owner === s) { owner = undefined; unflushed = new Map(s.previous); }
		};
		const updateTodo = (s: Session, tasks: unknown) => {
			if (!validTodoTasks(tasks)) return;
			s.todo = todoProgress({ tasks, nextId: 1, updatedTurn: null }, s.id);
			publish(s);
		};
		const replay = (s: Session) => {
			try { updateTodo(s, replayTodo(s.manager.getBranch()).tasks); } catch { /* malformed branch is ignored */ }
		};
		pi.on("session_start", (_event, ctx) => {
			if (owner) close(owner);
			if (ctx.mode !== "tui" || !ctx.hasUI) return;
			const id = ctx.sessionManager.getSessionId();
			if (!id) return;
			const seenJobErrors = seenJobsBySession.get(id) ?? new Set<string>();
			seenJobsBySession.set(id, seenJobErrors);
			const s: Session = { id, startedAt: now(), ctx, manager: ctx.sessionManager, previous: unflushed, dirty: false, tasks: [], jobMetadata: new Map(), taskLabels: new Map(), consults: new Map(), sends: new Map(), asksFromPeers: new Map(), errors: new Map(), seenJobErrors, seenTaskErrors: new Set(), unsubscribe: [] };
			owner = s;
			unflushed = new Map();
			const listen = (name: string, handler: (data: any) => void) => {
				s.unsubscribe.push(pi.events.on(name, (data: unknown) => {
					try { if (owner === s && s.manager.getSessionId() === s.id && data && typeof data === "object" && (data as { sessionId?: unknown }).sessionId === s.id) handler(data); }
					catch { /* A malformed display event is ignored. */ }
				}));
			};
			listen(TODO_PROGRESS_EVENT, data => { if (validProgress(data)) { s.todo = data; publish(s); } });
			const updateJob = (job: RunningJobDisplay) => {
				const id = `bg/${segment(job.id)}`;
				const identity = JSON.stringify([job.id, job.startedAt]);
				const previous = s.jobMetadata.get(identity);
				const metadata = {
					explicitLabel: hasUsableDesktopLabel(job.explicitLabel) ? job.explicitLabel : previous?.explicitLabel,
					kind: job.kind === "command" || job.kind === "monitor" ? job.kind : previous?.kind,
				};
				s.jobMetadata.set(identity, metadata);
				const failure = job.status === "failed" ? "failed"
					: job.status === "exited" && typeof job.exitCode === "number" && Number.isFinite(job.exitCode) && job.exitCode !== 0 ? `exited ${job.exitCode}` : undefined;
				if (failure && !s.seenJobErrors.has(identity)) {
					s.seenJobErrors.add(identity);
					if (job.endedAt === undefined || job.endedAt >= s.startedAt) {
						s.errors.set(id, { record: { state: "error", title: desktopJobTitle(metadata), msg: failure }, expiresAt: now() + ERROR_TTL_MS });
					}
				} else if (!failure) {
					s.errors.delete(id);
					if (job.status === undefined) s.seenJobErrors.delete(identity);
				}
			};
			const updateJobs = (data: any) => {
				if (!isJobsSidebarSnapshot(data.snapshot) || !Array.from(data.snapshot.jobs).every(job => job !== undefined)) return;
				s.jobs = data.snapshot;
				for (const job of data.snapshot.jobs) updateJob(job);
				publish(s); arm(s);
			};
			listen(JOBS_SIDEBAR_EVENT, updateJobs);
			listen(HERDR_DESKTOP_JOBS, updateJobs);
			listen(HERDR_DESKTOP_JOB_SETTLED, data => {
				if (!data.job || typeof data.job !== "object") return;
				// Reuse the sidebar validator without reading a local command as a title.
				const { id, explicitLabel, kind, startedAt, status, endedAt, exitCode } = data.job;
				const snapshot = { jobs: [{ id, explicitLabel, kind, startedAt, status, endedAt, exitCode, label: "" }] };
				if (!isJobsSidebarSnapshot(snapshot)) return;
				const job = snapshot.jobs[0]!;
				if (job.status === undefined) return;
				updateJob(job);
				// The edge can precede the sidebar refresh, including for success.
				if (s.jobs) s.jobs = { jobs: s.jobs.jobs.filter(active => active.id !== job.id || active.startedAt !== job.startedAt) };
				publish(s); arm(s);
			});
			listen(HERDR_DESKTOP_TASKS, data => {
				if (!validTasks(data.tasks)) return;
				for (const task of data.tasks) if (hasUsableDesktopLabel(task.explicitLabel)) s.taskLabels.set(task.id, task.explicitLabel);
				s.tasks = data.tasks; publish(s);
			});
			listen(HERDR_DESKTOP_TASK_FINISHED, data => {
				if (!validTasks([data.task]) || (data.task.status !== "failed" && data.task.status !== "timed_out")) return;
				const task = data.task as HerdrDesktopTask;
				const id = `subagents/${segment(task.id, 54)}`;
				if (s.seenTaskErrors.has(id)) return;
				s.seenTaskErrors.add(id);
				const explicitLabel = hasUsableDesktopLabel(task.explicitLabel) ? task.explicitLabel : s.taskLabels.get(task.id);
				const title = desktopTaskTitle({ explicitLabel, agent: task.agent });
				s.errors.set(id, { record: { state: "error", title, msg: task.status === "timed_out" ? "timed out" : "failed" }, expiresAt: now() + ERROR_TTL_MS });
				s.tasks = s.tasks.filter(active => active.id !== task.id);
				publish(s); arm(s);
			});
			listen(HERDR_DESKTOP_CONSULT, data => {
				if (typeof data.target !== "string" || !data.target || typeof data.callId !== "string" || !data.callId) return;
				if (data.phase === "start") { if (s.consults.has(data.callId)) return; s.consults.set(data.callId, data.target); }
				else if (data.phase === "settle") { if (s.consults.get(data.callId) !== data.target) return; s.consults.delete(data.callId); }
				else return;
				publish(s);
			});
			listen(HERDR_DESKTOP_SEND, data => {
				if (typeof data.target !== "string" || !data.target) return;
				s.sends.set(data.target, now()); publish(s); arm(s);
			});
			listen(HERDR_DESKTOP_INBOUND, data => {
				if (typeof data.peer !== "string" || !data.peer.trim() || typeof data.id !== "string" || !data.id.trim()
					|| (data.peerName !== undefined && typeof data.peerName !== "string")) return;
				if (data.phase === "received") {
					const pending = s.asksFromPeers.get(data.peer) ?? new Map<string, string>();
					pending.set(data.id, data.peerName?.trim() || data.peer);
					s.asksFromPeers.set(data.peer, pending);
				} else if (data.phase === "handled") {
					const pending = s.asksFromPeers.get(data.peer);
					if (!pending?.delete(data.id)) return;
					if (pending.size === 0) s.asksFromPeers.delete(data.peer);
				} else return;
				publish(s);
			});
			// Replay before the terminal attaches so the first diff already has the todo
			// and replaces an unflushed record instead of clearing it first.
			replay(s);
			ctx.ui.setWidget(WIDGET_KEY, tui => {
				if (owner === s) { s.terminal = tui.terminal; publish(s); }
				return { render: () => [], invalidate() {}, dispose() { if (owner === s) close(s); } };
			});
			try { pi.events.emit(HERDR_DESKTOP_TASKS_REQUEST, { sessionId: s.id }); } catch { /* Optional display source. */ }
		});
		pi.on("session_tree", (_event, ctx) => { if (owns(ctx)) replay(owner!); });
		pi.on("tool_execution_end", (event, ctx) => {
			if (!owns(ctx) || event.toolName !== "todo" || event.isError) return;
			try {
				const details = (event.result as { details?: { gentleTodo?: TodoState; error?: unknown } })?.details;
				if (details && Object.hasOwn(details, "gentleTodo") && !details.error) updateTodo(owner!, details.gentleTodo?.tasks);
			} catch { /* Malformed result is ignored. */ }
		});
		pi.on("session_shutdown", (_event, ctx) => {
			if (!owns(ctx)) return;
			const s = owner!; close(s);
			if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		});
	};
}

export default createHerdrDesktopStatusExtension();
