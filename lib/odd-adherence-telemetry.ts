import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sessionPath, sessionRoot } from "./odd-runtime-delegation-gate.ts";

export type OddAdherenceAppender = (line: string) => void;
export type OddAdherencePathResolver = (toolName: string, input: unknown, cwd: string) => string | undefined;
export type OddAdherenceRootResolver = (cwd: string) => string | undefined;

type PathKind = "read" | "write";
type PendingPath = { order: number };

type PathEntry = {
	order: number;
	successful: boolean;
	refused: boolean;
};

type SessionState = {
	primary: boolean;
	childDepth: number;
	active: boolean;
	turn: number;
	session: string;
	repo: string;
	toolCalls: number;
	reads: Set<string>;
	edits: number;
	writePaths: Map<string, PathEntry>;
	pendingReads: Map<string, PendingPath[]>;
	pendingWrites: Map<string, PendingPath[]>;
	delegations: number;
	blocked: boolean;
	blockedKind: string | null;
	noDelegationMechanism: boolean;
};

export type OddAdherenceToolCall = {
	state: SessionState;
	kind?: PathKind;
	input: unknown;
	cwd: string;
	order: number;
	finalized: boolean;
};

const hashIdentity = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";
const isGateRefusal = (value: unknown): value is { block: true; reason?: unknown } =>
	isRecord(value) && value.block === true;
const inputPath = (input: unknown): string | undefined => {
	if (!isRecord(input) || typeof input.path !== "string" || input.path.trim().length === 0) return undefined;
	return input.path;
};

function removePendingPath(
	state: SessionState,
	kind: PathKind,
	path: string,
	pending: PendingPath[] | undefined,
): void {
	if (!pending || pending.length === 0) return;
	pending.shift();
	const map = kind === "read" ? state.pendingReads : state.pendingWrites;
	if (pending.length === 0) map.delete(path);
}

export function createOddAdherenceAppender(processEnv: NodeJS.ProcessEnv = process.env): OddAdherenceAppender | undefined {
	try {
		if (processEnv.DO_NOT_TRACK === "1" || processEnv.CI === "true") return undefined;
		const home = processEnv.HOME;
		if (typeof home !== "string" || home.trim().length === 0) return undefined;
		const logPath = join(home, ".gentle-ai", "odd-adherence.jsonl");
		return (line: string): void => {
			try {
				mkdirSync(dirname(logPath), { recursive: true });
				appendFileSync(logPath, `${line}\n`, { encoding: "utf8" });
			} catch {
				// Telemetry is strictly best-effort and local-only.
			}
		};
	} catch {
		return undefined;
	}
}

export class OddAdherenceTelemetry {
	private readonly sessions = new Map<string, SessionState>();
	private readonly append: OddAdherenceAppender | undefined;
	private readonly now: () => string;
	private readonly resolvePath: OddAdherencePathResolver;
	private readonly resolveRoot: OddAdherenceRootResolver;

	constructor(
		append: OddAdherenceAppender | undefined,
		now: () => string = () => new Date().toISOString(),
		resolvePath: OddAdherencePathResolver = sessionPath,
		resolveRoot: OddAdherenceRootResolver = sessionRoot,
	) {
		this.append = append;
		this.now = now;
		this.resolvePath = resolvePath;
		this.resolveRoot = resolveRoot;
	}

	start(sessionId: string, primary: boolean, cwd: string): void {
		try {
			const previous = this.sessions.get(sessionId);
			if (primary) {
				this.sessions.set(sessionId, {
					primary: true,
					childDepth: 0,
					active: true,
					turn: (previous?.turn ?? 0) + 1,
					session: hashIdentity(sessionId),
					repo: hashIdentity(this.resolveRoot(cwd) ?? ""),
					toolCalls: 0,
					reads: new Set(),
					edits: 0,
					writePaths: new Map(),
					pendingReads: new Map(),
					pendingWrites: new Map(),
					delegations: 0,
					blocked: false,
					blockedKind: null,
					noDelegationMechanism: false,
				});
				return;
			}
			if (previous?.primary) previous.childDepth += 1;
			else this.sessions.set(sessionId, {
				primary: false,
				childDepth: 1,
				active: false,
				turn: previous?.turn ?? 0,
				session: hashIdentity(sessionId),
				repo: "00000000",
				toolCalls: 0,
				reads: new Set(),
				edits: 0,
				writePaths: new Map(),
				pendingReads: new Map(),
				pendingWrites: new Map(),
				delegations: 0,
				blocked: false,
				blockedKind: null,
				noDelegationMechanism: false,
			});
		} catch {
			// A telemetry failure must never affect the agent lifecycle.
		}
	}

	endChild(sessionId: string): void {
		try {
			const state = this.sessions.get(sessionId);
			if (state && state.childDepth > 0) state.childDepth -= 1;
		} catch {
			// A telemetry failure must never affect the agent lifecycle.
		}
	}

	observeToolCall(
		sessionId: string,
		toolName: string,
		input: unknown,
		cwd: string,
	): OddAdherenceToolCall | undefined {
		try {
			const state = this.sessions.get(sessionId);
			if (!state?.primary || !state.active || state.childDepth > 0) return undefined;
			const order = ++state.toolCalls;
			if (toolName === "subagent_run") state.delegations += 1;
			const kind: PathKind | undefined = toolName === "read" ? "read" : toolName === "edit" || toolName === "write" ? "write" : undefined;
			return { state, kind, input, cwd, order, finalized: false };
		} catch {
			return undefined;
		}
	}

	observeGateDecision(observation: OddAdherenceToolCall | undefined, result: unknown): void {
		try {
			if (!observation || observation.finalized) return;
			observation.finalized = true;
			const state = observation.state;
			if (!state.primary || !state.active || state.childDepth > 0) return;
			const refusal = isGateRefusal(result) ? result : undefined;
			if (refusal) {
				state.blocked = true;
				state.blockedKind = "multi-file-write";
				if (typeof refusal.reason === "string" && /no delegation mechanism is callable/i.test(refusal.reason)) {
					state.noDelegationMechanism = true;
				}
			}
			if (observation.kind === undefined) return;
			if (refusal) {
				if (observation.kind !== "write") return;
				const path = this.resolvePath("write", observation.input, observation.cwd);
				if (path === undefined) return;
				const existing = state.writePaths.get(path);
				if (existing === undefined) state.writePaths.set(path, { order: observation.order, successful: false, refused: true });
				return;
			}
			const pendingKey = inputPath(observation.input);
			if (pendingKey === undefined) return;
			const map = observation.kind === "read" ? state.pendingReads : state.pendingWrites;
			const pending = map.get(pendingKey) ?? [];
			pending.push({ order: observation.order });
			map.set(pendingKey, pending);
		} catch {
			// A telemetry failure must never affect a gate decision.
		}
	}

	observeToolResult(
		sessionId: string,
		toolName: string,
		input: unknown,
		cwd: string,
		succeeded: boolean,
	): void {
		try {
			const state = this.sessions.get(sessionId);
			if (!state?.primary || !state.active || state.childDepth > 0) return;
			const kind: PathKind | undefined = toolName === "read" ? "read" : toolName === "edit" || toolName === "write" ? "write" : undefined;
			if (kind === undefined) return;
			const pendingKey = inputPath(input);
			if (pendingKey === undefined) return;
			const map = kind === "read" ? state.pendingReads : state.pendingWrites;
			const pending = map.get(pendingKey);
			if (!pending || pending.length === 0) return;
			if (!succeeded) {
				removePendingPath(state, kind, pendingKey, pending);
				return;
			}
			const path = this.resolvePath(toolName, input, cwd);
			const pendingCall = pending.shift();
			if (pending.length === 0) map.delete(pendingKey);
			if (path === undefined || pendingCall === undefined) return;
			if (kind === "read") {
				state.reads.add(path);
				return;
			}
			const entry = state.writePaths.get(path);
			if (entry === undefined) state.writePaths.set(path, { order: pendingCall.order, successful: true, refused: false });
			else entry.successful = true;
			state.edits += 1;
		} catch {
			// A telemetry failure must never affect a successful tool result.
		}
	}

	endTurn(sessionId: string): void {
		try {
			const state = this.sessions.get(sessionId);
			if (!state?.primary || !state.active || state.childDepth > 0) return;
			const pathOrders = [...state.writePaths.values()].sort((left, right) => left.order - right.order).map((entry) => entry.order);
			const record = {
				v: 1,
				ts: this.now(),
				session: state.session,
				repo: state.repo,
				provider: "pi",
				turn: state.turn,
				tool_calls: state.toolCalls,
				reads: state.reads.size,
				edits: state.edits,
				distinct_paths: pathOrders.length,
				first_path_order: pathOrders[0] ?? null,
				second_path_order: pathOrders[1] ?? null,
				delegations: state.delegations,
				blocked: state.blocked,
				blocked_kind: state.blockedKind,
				no_delegation_mechanism: state.noDelegationMechanism,
				backstops: {
					tool_calls: state.toolCalls >= 20 && state.delegations === 0,
					reads: state.reads.size >= 5 && state.delegations === 0,
					edits: pathOrders.length >= 2 && state.delegations === 0,
				},
			};
			state.active = false;
			state.pendingReads.clear();
			state.pendingWrites.clear();
			try { this.append?.(JSON.stringify(record)); } catch {
				// Telemetry is strictly best-effort and local-only.
			}
		} catch {
			// A telemetry failure must never affect the agent lifecycle.
		}
	}
}
