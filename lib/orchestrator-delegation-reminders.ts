// Orchestrator delegation reminders (ODR-1): post-tool, next-decision nudges
// that keep the parent orchestrator inside its delegation triggers without
// ever blocking or rewriting a tool result.
//
// Delivery (owned by extensions/gentle-ai.ts, never by this module):
// tool_result -> pi.sendMessage(
//   { customType: "gentle-pi.delegation-reminder", content, display: false },
//   { deliverAs: "steer", triggerTurn: true },
// )
// "steer" bounds the nudge to the next model decision inside the already
// active turn. tool_result only fires mid-turn, so an idle session is never
// woken: there is no idle turn, no follow-up drain delay, and no result
// mutation. This module is pure state + message selection so it stays
// unit-testable without the extension host.

export const DELEGATION_REMINDER_TYPE = "gentle-pi.delegation-reminder";

export const READ_FILES_THRESHOLD = 3;
export const EXPLORATION_THRESHOLD = 5;
export const LONG_SESSION_THRESHOLD = 20;
export const WRITE_FILES_THRESHOLD = 2;

export const READ_FILES_MESSAGE =
	"Delegation: 3 files read. If you need to map more, delegate exploration.";
export const EXPLORATION_MESSAGE =
	"Delegation: 5 exploration calls. If you need more exploration, delegate it.";
export const LONG_SESSION_MESSAGE =
	"Delegation: 20 tool calls without delegation. If more work remains, delegate a bounded unit.";
export const WRITE_FILES_MESSAGE =
	"Delegation: 2 files changed. If further multi-file work is non-trivial, delegate it.";

export type DelegationSignal = "write" | "read-files" | "exploration" | "long-session";

// Most specific first: a simultaneous crossing emits only the head and marks
// every crossed signal fired so the suppressed ones stay quiet this interval.
const SIGNAL_PRIORITY: readonly DelegationSignal[] = [
	"write",
	"read-files",
	"exploration",
	"long-session",
];

const SIGNAL_MESSAGE: Record<DelegationSignal, string> = {
	write: WRITE_FILES_MESSAGE,
	"read-files": READ_FILES_MESSAGE,
	exploration: EXPLORATION_MESSAGE,
	"long-session": LONG_SESSION_MESSAGE,
};

interface IntervalState {
	totalCalls: number;
	readFiles: Set<string>;
	explorationCalls: number;
	writtenFiles: Set<string>;
	fired: Set<DelegationSignal>;
}

function createInterval(): IntervalState {
	return {
		totalCalls: 0,
		readFiles: new Set(),
		explorationCalls: 0,
		writtenFiles: new Set(),
		fired: new Set(),
	};
}

/**
 * Strip one trailing `:line` / `:start-end` suffix ("src/a.ts:1-500" ->
 * "src/a.ts"). Only strips when the remaining prefix still looks like a
 * path (contains a separator or a dot), so a colon that is genuinely part
 * of a filename is preserved.
 */
export function normalizeReminderPath(raw: string): string {
	const trimmed = raw.trim();
	const suffix = trimmed.match(/^(.*):\d+(?:-\d+)?$/);
	if (!suffix) return trimmed;
	const prefix = suffix[1]!;
	if (
		prefix.length > 0 &&
		(prefix.includes("/") || prefix.includes("\\") || prefix.includes("."))
	) {
		return prefix;
	}
	return trimmed;
}

function unifiedPath(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/\/$/, "");
}

function pathSegments(normalized: string): string[] {
	return unifiedPath(normalized).split("/").filter((segment) => segment.length > 0);
}

/** True when any segment of the path is a `skills` directory, wherever rooted. */
export function isSkillsPath(rawPath: string): boolean {
	return pathSegments(normalizeReminderPath(rawPath)).some(
		(segment) => segment === "skills",
	);
}

/** True when the path spells `odd/tasks/**` repo-relative (or absolute). */
export function isOddTasksPath(rawPath: string): boolean {
	const segments = pathSegments(normalizeReminderPath(rawPath));
	return segments.some(
		(segment, index) => segment === "odd" && segments[index + 1] === "tasks",
	);
}

/** Lexical distinctness key: absolute stays absolute, relative resolves under cwd. */
export function reminderPathKey(rawPath: string, cwd: string): string {
	const normalized = unifiedPath(normalizeReminderPath(rawPath));
	if (/^(?:[A-Za-z]:)?\//.test(normalized)) return normalized;
	return unifiedPath(`${cwd.replace(/\\/g, "/")}/${normalized}`);
}

/**
 * Exploration tools counted toward the 5-call signal: exactly the four
 * orchestrator-listed IDs. Generic `codegraph` init/query calls and
 * `codegraph_explore`-shaped aliases are not explore operations and do
 * not count.
 */
export function isExplorationTool(toolName: string): boolean {
	return (
		toolName === "read" ||
		toolName === "grep" ||
		toolName === "find" ||
		toolName === "codegraph_codegraph_explore"
	);
}

function inputPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" && path.trim().length > 0 ? path : undefined;
}

export interface DelegationToolResult {
	sessionId: string;
	toolName: string;
	input: unknown;
	cwd: string;
	isError: boolean;
}

export class OrchestratorDelegationReminders {
	private readonly intervals = new Map<string, IntervalState>();

	private intervalFor(sessionId: string): IntervalState {
		let state = this.intervals.get(sessionId);
		if (!state) {
			state = createInterval();
			this.intervals.set(sessionId, state);
		}
		return state;
	}

	/** Drop the whole interval (counts and fired flags) for one session. */
	reset(sessionId: string): void {
		this.intervals.delete(sessionId);
	}

	/**
	 * Record one tool_result. Returns the single reminder message to deliver,
	 * or undefined when no threshold crossed. Never throws for malformed
	 * input: unparseable events simply count toward the long-session total.
	 *
	 * - A successful `subagent_run` resets the interval and returns
	 *   undefined: the delegating act itself must not nag. A failed one only
	 *   counts toward the 20-call total.
	 * - File/exploration/write signals require success; the 20-call signal
	 *   counts everything with no exclusions.
	 */
	record(result: DelegationToolResult): string | undefined {
		const state = this.intervalFor(result.sessionId);

		if (result.toolName === "subagent_run") {
			if (!result.isError) {
				this.intervals.delete(result.sessionId);
				return undefined;
			}
			state.totalCalls += 1;
			return this.evaluate(state);
		}

		state.totalCalls += 1;
		if (!result.isError) {
			this.recordExploration(state, result);
			this.recordFileRead(state, result);
			this.recordFileWrite(state, result);
		}
		return this.evaluate(state);
	}

	private recordExploration(state: IntervalState, result: DelegationToolResult): void {
		if (!isExplorationTool(result.toolName)) return;
		const path = inputPath(result.input);
		// odd/tasks traffic is delegated scope for every scoped operation.
		if (path !== undefined && isOddTasksPath(path)) return;
		// The skills exemption covers skill *reads* only: grep/find over a
		// skills path is still exploration effort and still counts.
		if (result.toolName === "read" && path !== undefined && isSkillsPath(path)) return;
		state.explorationCalls += 1;
	}

	private recordFileRead(state: IntervalState, result: DelegationToolResult): void {
		if (result.toolName !== "read") return;
		const path = inputPath(result.input);
		if (path === undefined || isOddTasksPath(path) || isSkillsPath(path)) return;
		state.readFiles.add(reminderPathKey(path, result.cwd));
	}

	private recordFileWrite(state: IntervalState, result: DelegationToolResult): void {
		if (result.toolName !== "write" && result.toolName !== "edit") return;
		const path = inputPath(result.input);
		if (path === undefined || isOddTasksPath(path)) return;
		state.writtenFiles.add(reminderPathKey(path, result.cwd));
	}

	private evaluate(state: IntervalState): string | undefined {
		const crossed = SIGNAL_PRIORITY.filter(
			(signal) => !state.fired.has(signal) && this.crossed(state, signal),
		);
		if (crossed.length === 0) return undefined;
		for (const signal of crossed) state.fired.add(signal);
		return SIGNAL_MESSAGE[crossed[0]!];
	}

	private crossed(state: IntervalState, signal: DelegationSignal): boolean {
		switch (signal) {
			case "write":
				return state.writtenFiles.size >= WRITE_FILES_THRESHOLD;
			case "read-files":
				return state.readFiles.size >= READ_FILES_THRESHOLD;
			case "exploration":
				return state.explorationCalls >= EXPLORATION_THRESHOLD;
			case "long-session":
				return state.totalCalls >= LONG_SESSION_THRESHOLD;
		}
	}
}
