import { isSessionChangeEvidence, type SessionChangeEvidence } from "./session-changes.ts";
import type { Duplex, Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { RESEARCH_SELECTION_ENV } from "./sdd-research-capabilities.ts";
import { AGENT_MODE, formatModelRef, type AgentDefinition, type AgentMode, type ModelRef } from "./agents-config.ts";
import { CHILD_QUERY_MAX_INFLIGHT, CHILD_QUERY_TIMEOUT_MS, parseChildFrame, validChildMessage, validChildQueryId } from "./agents-messaging.ts";
import { ParentStandingReviewPermissionBroker } from "./review-session-standing-permission-ipc.ts";
import { isFinished, normalizeRpcEvent, TASK_EVENT, TASK_STATUS, taskLabel, type AskRequest, type ChildResponseObservation, type TaskRecord, type TaskStore } from "./agents-protocol.ts";

// Gentle Agents runner. Every subagent is its own `pi --mode rpc` process:
// the host never runs subagent work on the TUI thread. It writes JSON
// commands, reads JSON lines, applies deltas to the store, answers dialogs,
// and enforces an inactivity watchdog per task.

export interface ChildLike {
	pid: number | undefined;
	stdin: Writable;
	stdout: Readable;
	stderr: Readable | null | undefined;
	stdio?: Array<Duplex | null | undefined>;
	kill(signal?: NodeJS.Signals): boolean;
	send?(message: Record<string, unknown>, callback?: (error: Error | null) => void): boolean;
	disconnect?(): void;
	channel?: { unref?(): void };
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "spawn" | "message" | "disconnect", listener: (...args: unknown[]) => void): unknown;
}

export interface SpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	detached?: boolean;
	stdio?: Array<"pipe" | "ignore" | "inherit" | "ipc">;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface ProcessControl {
	platform: NodeJS.Platform;
	kill(pid: number, signal: NodeJS.Signals | 0): void;
}

export interface PiCommand {
	command: string;
	args: string[];
}

export interface RunnerDeps {
	spawn: Spawn;
	now(): number;
	schedule(fn: () => void, ms: number): () => void;
	pi: PiCommand;
	process?: ProcessControl;
}

export interface RunnerLimits {
	maxConcurrency: number;
	stallTimeoutMs: number;
	// Longer ceiling used while an announced tool call is in flight. Optional so
	// callers that only bound silence keep the idle budget as the tool ceiling.
	toolStallTimeoutMs?: number;
}

export interface AskAnswer {
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface TaskQuery {
	taskId: string;
	requestId: string;
}

export const MAX_CHILD_RESPONSE_OBSERVATIONS = 128;

/** Local producer snapshot only; never native workflow success or export authority.
 * Scope excludes tools, compaction, hidden provider retries and history replay.
 * Each message_end is retained separately; RPC supplies no stable dedupe key.
 * Unsettled shutdown may lose in-flight responses even when droppedResponses is 0.
 */
export interface ChildObservationSnapshot {
	readonly coverage: "final_assistant_messages_only";
	readonly agentSettled: boolean;
	readonly responses: readonly ChildResponseObservation[];
	readonly droppedResponses: number;
}
interface ChildObservationBuffer {
	agentSettled: boolean;
	responses: ChildResponseObservation[];
	droppedResponses: number;
}

export interface RunnerHooks {
	askUser(taskId: string, request: AskRequest, raw: Record<string, unknown>): Promise<AskAnswer>;
	/** Optional immutable snapshot, delivered once at existing finalization.
	 * Undefined when collection was disabled or no child handle was created.
	 * Parent must check task.status AND agentSettled; observations are not success.
	 */
	onFinish?(task: TaskRecord, observations?: ChildObservationSnapshot): void;
	// Accepts a child notification only while the originating parent session is active.
	onNotification?(task: TaskRecord, message: string): boolean | void;
	onQuery?(task: TaskRecord, requestId: string, message: string): boolean | void;
	// Parent-only observation of a paired successful filesystem tool, not prose.
	onSuccessfulMutation?(task: TaskRecord, tool: { toolName: "write" | "edit"; toolCallId: string; path: string; evidence?: SessionChangeEvidence }): void | Promise<void>;
}

export interface RemediationHarnessPlan { command?: string; naReason?: string }
export interface RemediationRollbackPlan { boundary: string; command: string }
export interface RemediationScope { cwd: string; editPaths: string[]; commands: string[]; allowedEditRoots: string[] }
export interface RemediationPlan {
	editPaths?: string[];
	cwd: string;
	commands: string[];
	runtimeHarness: RemediationHarnessPlan;
	rollback: RemediationRollbackPlan;
}
const concrete = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 3 && value.length <= 4096 && !/[\0\r\n]/.test(value);
export function parseRemediationPlan(value: unknown, cwd: string): RemediationPlan {
	const plan = value as RemediationPlan;
	if (!plan || plan.cwd !== cwd || !Array.isArray(plan.commands) || plan.commands.length < 1 || plan.commands.length > 16 || !plan.commands.every(concrete) ||
		!concrete(plan.rollback?.boundary) || !concrete(plan.rollback?.command) || !plan.runtimeHarness ||
		!(concrete(plan.runtimeHarness.command) && plan.runtimeHarness.naReason === undefined || plan.runtimeHarness.command === undefined && concrete(plan.runtimeHarness.naReason) && plan.runtimeHarness.naReason.length >= 20 && /because/i.test(plan.runtimeHarness.naReason))) throw new TypeError("Invalid remediation evidence plan");
	return structuredClone(plan);
}
export const plannedCommands = (plan: RemediationPlan) => [...plan.commands, ...(plan.runtimeHarness.command ? [plan.runtimeHarness.command] : []), plan.rollback.command];
// Launch-local scope only; task history is not an attempt authority.
export interface RemediationContext {
	failedEvidenceRevision: string;
	plan: RemediationPlan;
	scope: RemediationScope;
}

export interface SddChangeSelection {
	changeName: string;
	workspaceRoot: string;
	phase: "apply" | "verify" | "archive" | "remediate";
	failedEvidenceRevision?: string;
}

export const SDD_CHANGE_FLAG = "--gentle-sdd-change";

export const REMEDIATION_PLAN_ENV = "GENTLE_PI_SDD_REMEDIATION_PLAN";

export interface TaskRequest {
	remediationIntent?: unknown;
	sddRemediation?: RemediationContext;
	sddPreflightContext?: string;
	agent: AgentDefinition;
	prompt: string;
	label: string | undefined;
	context: string | undefined;
	mode: AgentMode;
	cwd: string;
	parentSessionId: string;
	model: ModelRef | undefined;
	thinking: string | undefined;
	sessionDir: string;
	resumeSessionPath: string | undefined;
	env: NodeJS.ProcessEnv;
	// A launch-local SDD identity. It is never prompt text or shared state.
	sddChange?: SddChangeSelection;
	// Untrusted narrowing intent; paths come only from matching host provenance.
	researchSelection?: unknown;
	extensionPaths?: string[];
	// Captures the originating session; invoked only after successful OS spawn.
	onLaunch?: () => void;
	/** Default off. Parent owns policy before opting into bounded local buffering,
	 * and must recheck policy/catalog privacy before recording or forwarding.
	 * This flag does not authorize telemetry export or perform policy subprocesses.
	 */
	collectResponseObservations?: boolean;
	/** Optional parallel preparation after dequeue; never delays OS spawn.
	 * Unready at the first observation checkpoint permanently drops collection. */
	prepareResponseObservations?: () => Promise<boolean>;
	/** Optional synchronous parent-local grant check; never perform I/O here.
	 * Parent checks environment, known revocation and a monotonic expiry against
	 * its fresh native policy grant. False/throw permanently discards this task's
	 * buffer. Checked once ready, on RPC values, and finish; this is not a watcher.
	 * Omission preserves the explicit opt-in producer API, not policy authority.
	 */
	canCollectResponseObservations?: () => boolean;
	// This closure stays only in the parent process. Its presence creates an
	// inherited fd, never an environment boolean or model-visible permission.
	authorizeParentStandingReviewPermission?: (repositoryIdentity: string) => boolean;
}

interface ProcessLike {
	execPath: string;
	argv: string[];
	env: NodeJS.ProcessEnv;
}

interface Pending {
	resolve(value: Record<string, unknown>): void;
}

interface PendingQuery {
	cancel: () => void;
	replying: boolean;
}

interface PendingReply {
	resolve(value: boolean): void;
}

interface LiveTask {
	child: ChildLike;
	observations?: ChildObservationBuffer;
	observationGuard?: () => boolean;
	observationPreparation?: () => boolean;
	pending: Map<string, Pending>;
	queries: Map<string, PendingQuery>;
	replies: Map<string, PendingReply>;
	cancelStall: () => void;
	cancelGrace: () => void;
	processGroup: number | undefined;
	terminal: { status: TaskRecord["status"]; error: string | null } | undefined;
	childExit: number | null | undefined;
	cleanupDeadlineAt: number | undefined;
	quarantined: boolean;
	nextId: number;
	permissionBroker?: ParentStandingReviewPermissionBroker;
	ipcClosed: boolean;
	acknowledgedIpcIds: Set<string>;
	acknowledgedIpcOrder: string[];
	mutationStarts: Map<string, { toolName: "write" | "edit"; toolCallId: string; path: string }>;
	// Tool calls the child announced and has not ended yet. A call in flight is
	// live work, so the watchdog gives it the tool ceiling instead of the idle
	// silence budget. Keyed by call id, holding the announced tool name.
	inFlightTools: Map<string, string>;
	// Bounded ring buffer of the child's raw stderr output, capped to the last
	// STDERR_TAIL_MAX characters. Only surfaced on the stall and pre-settle exit
	// terminal paths, never on completed, cancelled, or other failure reasons.
	stderrTail: string;
}

const STDERR_TAIL_MAX = 512;
const CHILD_MARKER = "GENTLE_PI_AGENTS_CHILD";
const IPC_MARKER = "GENTLE_PI_AGENTS_OWNED_IPC";
const PARENT_NOTIFICATION_TOOL = "subagent_parent_message";
const DEFAULT_TOOLS: readonly string[] = [];
const TERMINATION_GRACE_MS = 250;
const GROUP_CONFIRM_MS = 25;
const GROUP_CONFIRM_DEADLINE_MS = 1_000;
const QUERY_REJECTION_ERRORS = new Set([
	"invalid child IPC frame",
	"invalid child IPC correlation",
	"unsupported child IPC kind",
	"invalid child IPC message",
	"task is not a live owned recipient",
	"task parent cannot accept queries",
	"task parent is not the active host session",
	"duplicate query request",
	"too many pending parent queries",
	"parent query timed out",
	"parent rejected query",
]);
const QUERY_REJECTION = Symbol("query rejection");

function rejectQuery(error: string): never {
	throw { [QUERY_REJECTION]: error };
}

function queryRejection(error: unknown): string {
	if (error && typeof error === "object" && QUERY_REJECTION in error) {
		const value = (error as { [QUERY_REJECTION]?: unknown })[QUERY_REJECTION];
		if (typeof value === "string" && QUERY_REJECTION_ERRORS.has(value)) return value;
	}
	return "parent rejected query";
}

const hostProcess: ProcessControl = { platform: process.platform, kill: (pid, signal) => process.kill(pid, signal) };

export function childArguments(request: TaskRequest): string[] {
	const args = ["--mode", "rpc", "--session-dir", request.sessionDir];
	for (const path of request.extensionPaths ?? []) args.push("--extension", path);
	if (request.sddChange) args.push(SDD_CHANGE_FLAG, JSON.stringify(request.sddChange));
	if (request.resumeSessionPath) args.push("--session", request.resumeSessionPath);
	if (request.model) args.push("--model", request.thinking ? `${formatModelRef(request.model)}:${request.thinking}` : formatModelRef(request.model));
	else if (request.thinking) args.push("--thinking", request.thinking);
	const tools = request.agent.tools.length > 0 || request.agent.name === "sdd-research" ? [...new Set([...request.agent.tools, PARENT_NOTIFICATION_TOOL])] : DEFAULT_TOOLS;
	if (tools.length > 0) args.push("--tools", tools.join(","));
	if (request.agent.instructions.length > 0) args.push("--append-system-prompt", request.agent.instructions);
	return args;
}

// The child is the same pi that is running us: node plus its cli entry.
// GENTLE_PI_AGENTS_PI overrides it with a command line.
export function piCommand(proc: ProcessLike = process): PiCommand {
	const override = proc.env.GENTLE_PI_AGENTS_PI?.trim();
	if (override) {
		const [command, ...args] = override.split(/\s+/);
		return { command, args };
	}
	const entry = proc.argv[1];
	if (entry && /(^|[\\/])cli\.js$/.test(entry)) return { command: proc.execPath, args: [entry] };
	return { command: "pi", args: [] };
}

// RPC framing is strict JSONL: LF only, optional CR. Lines that do not parse
// are dropped (pi's own parse errors arrive as responses anyway).
export class JsonLines {
	private buffer = "";
	private readonly onValue: (value: unknown) => void;

	constructor(onValue: (value: unknown) => void) {
		this.onValue = onValue;
	}

	push(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const raw of lines) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.length === 0) continue;
			try {
				this.onValue(JSON.parse(line));
			} catch {
				// not JSON: ignore
			}
		}
	}
}

export function promptText(request: TaskRequest): string {
	const prompt = request.context ? `${request.prompt}\n\n## Context\n${request.context}` : request.prompt;
	return request.sddRemediation ? `${prompt}\n\n## Human-authorized remediation plan\nExecute only these exact commands in the selected cwd; report actual results without claiming native verification.\n${JSON.stringify(request.sddRemediation.plan)}\nFailed evidence: ${request.sddRemediation.failedEvidenceRevision}` : prompt;
}

export class AgentRunner {
	private readonly store: TaskStore;
	private readonly limits: RunnerLimits;
	private readonly deps: RunnerDeps;
	private readonly hooks: RunnerHooks;
	private readonly processControl: ProcessControl;
	private readonly queue: Array<{ task: TaskRecord; request: TaskRequest }> = [];
	private readonly live = new Map<string, LiveTask>();
	private readonly waiters = new Map<string, Array<(task: TaskRecord) => void>>();
	private readonly queryWaiters = new Map<string, Array<(query: TaskQuery | undefined) => void>>();
	private readonly firstQueries = new Map<string, TaskQuery>();
	private counter = 0;

	constructor(store: TaskStore, limits: RunnerLimits, deps: RunnerDeps, hooks: RunnerHooks) {
		this.store = store;
		this.limits = limits;
		this.deps = deps;
		this.hooks = hooks;
		this.processControl = deps.process ?? hostProcess;
	}

	private createTask(request: TaskRequest): TaskRecord {
		const now = this.deps.now();
		this.counter += 1;
		const task: TaskRecord = {
			id: `${now.toString(36)}-${this.counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
			agent: request.agent.name,
			...(request.sddPreflightContext ? { sddPreflightContext: request.sddPreflightContext } : {}),
			mode: request.mode,
			prompt: request.prompt,
			label: taskLabel(request.prompt, request.label),
			cwd: request.cwd,
			parentSessionId: request.parentSessionId,
			status: TASK_STATUS.QUEUED,
			createdAt: now,
			startedAt: null,
			endedAt: null,
			model: formatModelRef(request.model),
			thinking: request.thinking,
			sessionPath: request.resumeSessionPath ?? null,
			error: null,
			result: null,
			lastStep: "queued",
			lastActivityAt: now,
			turns: 0,
			toolCalls: 0,
			tokens: 0,
			cost: 0,
		};
		this.store.add(task);
		return task;
	}

	run(request: TaskRequest): TaskRecord {
		// Admission already confirmed the canonical cwd and human edit scope.
		// Check this runner's queue/live slots before scheduling any launch: history
		// is not a lock, and quarantined children still own their live slot.
		if (request.sddRemediation) {
			const active = [...this.queue.map(entry => entry.task), ...[...this.live.keys()].map(id => this.store.get(id))];
			if (active.some(task => task?.agent === "sdd-remediate" && task.cwd === request.cwd)) {
				throw new Error("Remediation already queued or running in this worktree; wait for confirmed cleanup or cancel the active task before requesting fresh authorization");
			}
		}
		const task = this.createTask(request);
		// A caller can retain and mutate its request after dispatch. Preserve only
		// the identity selected at construction for this child launch.
		const launchRequest = {
			...request,
			sddChange: request.sddChange && { ...request.sddChange },
		};
		this.queue.push({ task, request: launchRequest });
		queueMicrotask(() => this.pump());
		return task;
	}

	waitFor(id: string): Promise<TaskRecord> {
		const current = this.store.get(id);
		if (!current) return Promise.reject(new Error(`no task ${id}`));
		if (isFinished(current.status)) return Promise.resolve(current);
		return new Promise((resolve) => {
			const list = this.waiters.get(id) ?? [];
			list.push(resolve);
			this.waiters.set(id, list);
		});
	}

	waitForQuery(id: string): Promise<TaskQuery | undefined> {
		const current = this.store.get(id);
		if (!current || isFinished(current.status)) return Promise.resolve(undefined);
		const first = this.firstQueries.get(id);
		if (first) return Promise.resolve(first);
		return new Promise((resolve) => {
			const list = this.queryWaiters.get(id) ?? [];
			list.push(resolve);
			this.queryWaiters.set(id, list);
		});
	}

	async reply(id: string, requestId: string, message: string, parentSessionId: string): Promise<boolean> {
		const task = this.store.get(id);
		const live = this.live.get(id);
		if (!task || !live || live.terminal || task.parentSessionId !== parentSessionId || !validChildMessage(message)) return false;
		const query = live.queries.get(requestId);
		if (!query || query.replying) return false;
		query.replying = true;
		const accepted = await this.sendReply(live, requestId, { id: requestId, kind: "reply", message });
		if (live.queries.get(requestId) === query) {
			query.cancel();
			live.queries.delete(requestId);
		}
		return accepted;
	}

	cancel(id: string, reason = "cancelled"): boolean {
		const queued = this.queue.findIndex((entry) => entry.task.id === id);
		if (queued >= 0) {
			this.queue.splice(queued, 1);
			this.finish(id, TASK_STATUS.CANCELLED, `${reason} before start`);
			return true;
		}
		if (!this.live.has(id)) return false;
		this.requestStop(id, TASK_STATUS.CANCELLED, reason, true);
		return true;
	}

	/** Parent-known revocation clears buffered metadata immediately, including
	 * during an idle provider call. No task/store/status mutation. */
	discardResponseObservations(id: string): void {
		const live = this.live.get(id);
		if (live) { live.observations = undefined; live.observationGuard = undefined; }
	}

	cancelAll(reason = "cancelled"): number {
		const ids = [...this.queue.map((entry) => entry.task.id), ...this.live.keys()];
		return ids.filter((id) => this.cancel(id, reason)).length;
	}

	steer(id: string, message: string): boolean {
		if (!this.live.has(id)) return false;
		void this.send(id, { type: "steer", message });
		this.store.apply(id, { type: TASK_EVENT.NOTE, text: `steered: ${message}` }, this.deps.now());
		return true;
	}

	private pump(): void {
		while (this.live.size < this.limits.maxConcurrency && this.queue.length > 0) {
			const entry = this.queue.shift();
			if (!entry) continue;
			const { task, request } = entry;
			this.launch(task.id, request);
		}
	}

	// A child that cannot start (missing pi, bad cwd) fails only its task:
	// spawn exceptions and process errors settle without uncaught host errors.
	private launch(id: string, request: TaskRequest): void {
		const detached = this.processControl.platform !== "win32";
		const hasParentPermissionChannel = request.authorizeParentStandingReviewPermission !== undefined;
		const env = {
			...request.env,
			...(request.extensionPaths ? { [RESEARCH_SELECTION_ENV]: JSON.stringify(request.researchSelection ?? null) } : {}),
			[CHILD_MARKER]: "1",
			[IPC_MARKER]: `${this.deps.now()}-${Math.random().toString(36).slice(2)}`,
			...(hasParentPermissionChannel ? { GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" } : {}),
		};
		delete env[REMEDIATION_PLAN_ENV];
		if (request.sddRemediation) env[REMEDIATION_PLAN_ENV] = JSON.stringify({ plan: request.sddRemediation.plan, scope: request.sddRemediation.scope, selection: request.sddChange });
		let child: ChildLike;
		try {
			child = this.deps.spawn(this.deps.pi.command, [...this.deps.pi.args, ...childArguments(request)], {
				cwd: request.cwd,
				env,
				detached,
				stdio: hasParentPermissionChannel ? ["pipe", "pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe", "ipc"],
			});
		} catch (error) {
			this.store.update(id, { status: TASK_STATUS.RUNNING, startedAt: this.deps.now(), lastStep: "starting" });
			this.finish(id, TASK_STATUS.FAILED, `could not start pi: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const processGroup = detached && typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
		const live: LiveTask = { child, mutationStarts: new Map(), inFlightTools: new Map(), pending: new Map(), queries: new Map(), replies: new Map(), cancelStall: () => {}, cancelGrace: () => {}, processGroup, terminal: undefined, childExit: undefined, cleanupDeadlineAt: undefined, quarantined: false, nextId: 0, ipcClosed: false, acknowledgedIpcIds: new Set(), acknowledgedIpcOrder: [], stderrTail: "" };
		if (request.prepareResponseObservations) {
			let ready = false;
			live.observationPreparation = () => ready;
			void Promise.resolve().then(() => this.live.get(id) === live && !live.terminal
				? request.prepareResponseObservations!() : false).then(allowed => { ready = allowed === true; }).catch(() => {});
		}
		if (request.collectResponseObservations === true || request.prepareResponseObservations) {
			live.observationGuard = request.canCollectResponseObservations;
			live.observations = { agentSettled: false, responses: [], droppedResponses: 0 };
			if (!request.prepareResponseObservations) this.checkObservationGrant(live);
		}
		this.live.set(id, live);
		const permissionPipe = child.stdio?.[3];
		if (hasParentPermissionChannel && permissionPipe !== undefined && permissionPipe !== null) {
			live.permissionBroker = new ParentStandingReviewPermissionBroker(
				{ readable: permissionPipe, writable: permissionPipe },
				(repositoryIdentity) => this.live.get(id) === live && !live.terminal && request.authorizeParentStandingReviewPermission?.(repositoryIdentity) === true,
			);
		}
		this.store.update(id, { status: TASK_STATUS.RUNNING, startedAt: this.deps.now(), lastStep: "starting" });
		child.channel?.unref?.();
		child.on("error", (error) => this.childError(id, error));
		child.on("message", (value) => this.receiveChildMessage(id, value));
		child.on("disconnect", () => this.closeIpc(live));
		let announced = false;
		child.on("spawn", () => {
			if (announced || this.live.get(id) !== live || live.terminal) return;
			announced = true;
			try { request.onLaunch?.(); }
			catch (error) { this.requestStop(id, TASK_STATUS.FAILED, `could not register launched worktree: ${error instanceof Error ? error.message : String(error)}`); }
		});
		child.stdin.on("error", () => {});
		this.armStall(id, live);
		const lines = new JsonLines((value) => this.receive(id, request, value));
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => lines.push(chunk));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			const tail = live.stderrTail + chunk;
			live.stderrTail = tail.length > STDERR_TAIL_MAX ? tail.slice(-STDERR_TAIL_MAX) : tail;
		});
		child.on("exit", (code) => this.exited(id, code));
		if (request.sddRemediation && child.pid === undefined) {
			this.childError(id, new Error("remediation child has no process ID"));
			return;
		}
		void this.send(id, { type: "get_state" }).then((response) => {
			const data = response.data as { sessionFile?: unknown; model?: { provider?: unknown; id?: unknown } | null; thinkingLevel?: unknown } | undefined;
			if (response.success !== true || live.terminal || this.live.get(id) !== live || !data) return;
			const resolved: Partial<TaskRecord> = {};
			if (this.canAdvanceLastStep(id, ["starting"])) resolved.lastStep = "pi ready";
			if (typeof data.sessionFile === "string" && data.sessionFile) resolved.sessionPath = data.sessionFile;
			if (data.model === null) resolved.model = "default";
			else if (typeof data.model?.provider === "string" && data.model.provider && typeof data.model.id === "string" && data.model.id) {
				resolved.model = formatModelRef({ provider: data.model.provider, id: data.model.id });
			}
			if (typeof data.thinkingLevel === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(data.thinkingLevel)) resolved.thinking = data.thinkingLevel;
			this.store.update(id, resolved);
		});
		void this.send(id, { type: "prompt", message: promptText(request) }).then((response) => {
			if (response.success === false) {
				this.requestStop(id, TASK_STATUS.FAILED, String(response.error ?? "prompt rejected"));
				return;
			}
			if (!live.terminal && this.live.get(id) === live && this.canAdvanceLastStep(id, ["starting", "pi ready"])) this.store.update(id, { lastStep: "prompt accepted" });
		});
	}

	// A late get_state/prompt reply must never overwrite a stage that a child
	// event (or the other reply) has already advanced lastStep past.
	private canAdvanceLastStep(id: string, from: readonly string[]): boolean {
		const current = this.store.get(id)?.lastStep;
		return current !== undefined && from.includes(current);
	}

	// Cleaned for display only: raw bytes stay in live.stderrTail so later
	// appends keep working from the unstripped ring buffer.
	private stderrSuffix(live: LiveTask): string {
		const cleaned = stripVTControlCharacters(live.stderrTail).replace(/\s+/g, " ").trim();
		return cleaned ? `; stderr: ${cleaned}` : "";
	}

	// An idle child is bounded by the silence budget; a child whose announced
	// tool call is still running is live work and bounded by the longer tool
	// ceiling. The budget is chosen from the state at arm time, and every RPC
	// object re-arms, so a finished tool call returns the task to idle silence.
	private armStall(id: string, live: LiveTask): void {
		live.cancelStall();
		const tool = live.inFlightTools.values().next().value;
		const budget = tool === undefined ? this.limits.stallTimeoutMs : Math.max(this.limits.toolStallTimeoutMs ?? this.limits.stallTimeoutMs, this.limits.stallTimeoutMs);
		live.cancelStall = this.deps.schedule(() => {
			const lastStep = this.store.get(id)?.lastStep ?? "starting";
			const minutes = Math.round(budget / 60_000);
			if (tool === undefined) this.requestStop(id, TASK_STATUS.TIMED_OUT, `stalled for ${minutes} min after: ${lastStep}${this.stderrSuffix(live)}`);
			else this.requestStop(id, TASK_STATUS.TIMED_OUT, `stalled for ${minutes} min with tool "${tool}" still running after: ${lastStep}${this.stderrSuffix(live)}`);
		}, budget);
	}

	private send(id: string, command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const live = this.live.get(id);
		if (!live) return Promise.resolve({ success: false, error: "task is not running" });
		live.nextId += 1;
		const requestId = `r${live.nextId}`;
		return new Promise((resolve) => {
			live.pending.set(requestId, { resolve });
			this.write(live, { id: requestId, ...command });
		});
	}

	private receiveChildMessage(id: string, value: unknown): void {
		const live = this.live.get(id);
		if (!live || live.ipcClosed) return;
		const parsed = parseChildFrame(value);
		if (!parsed.frame) {
			if (parsed.id && validChildQueryId(parsed.id)) this.sendQueryError(live, parsed.id, parsed.error ?? "invalid child IPC frame");
			else if (parsed.id) this.acknowledge(live, parsed.id, false, parsed.error ?? "invalid child IPC frame");
			return;
		}
		const task = this.store.get(id);
		if (!task || live.terminal || isFinished(task.status) || task.parentSessionId === "") {
			if (parsed.frame.kind === "notification") this.acknowledge(live, parsed.frame.id, false, "task is not a live owned recipient");
			else this.sendQueryError(live, parsed.frame.id, "task is not a live owned recipient");
			return;
		}
		if (parsed.frame.kind === "notification") {
			if (live.acknowledgedIpcIds.has(parsed.frame.id)) return;
			try {
				if (this.hooks.onNotification?.(task, parsed.frame.message) === false) this.acknowledge(live, parsed.frame.id, false, "task parent is not the active host session");
				else this.acknowledge(live, parsed.frame.id, true);
			} catch { this.acknowledge(live, parsed.frame.id, false, "parent rejected notification"); }
			return;
		}
		let query: PendingQuery | undefined;
		try {
			if (live.queries.has(parsed.frame.id)) rejectQuery("duplicate query request");
			if (live.queries.size >= CHILD_QUERY_MAX_INFLIGHT) rejectQuery("too many pending parent queries");
			query = { replying: false, cancel: this.deps.schedule(() => this.expireQuery(live, parsed.frame!.id), CHILD_QUERY_TIMEOUT_MS) };
			live.queries.set(parsed.frame.id, query);
			if (!this.hooks.onQuery) rejectQuery("task parent cannot accept queries");
			if (this.hooks.onQuery(task, parsed.frame.id, parsed.frame.message) === false) rejectQuery("task parent is not the active host session");
			if (task.mode === AGENT_MODE.TASK && !this.firstQueries.has(id)) {
				const first = { taskId: id, requestId: parsed.frame.id };
				this.firstQueries.set(id, first);
				for (const resolve of this.queryWaiters.get(id) ?? []) resolve(first);
				this.queryWaiters.delete(id);
			}
		} catch (error) {
			if (query && live.queries.get(parsed.frame.id) === query) {
				query.cancel();
				live.queries.delete(parsed.frame.id);
			}
			this.sendQueryError(live, parsed.frame.id, queryRejection(error));
		}
	}

	private expireQuery(live: LiveTask, id: string): void {
		const query = live.queries.get(id);
		if (!query) return;
		live.queries.delete(id);
		if (query.replying) this.settleReply(live, id, false);
		else this.sendQueryError(live, id, "parent query timed out");
	}

	private sendQueryError(live: LiveTask, id: string, error: string): void {
		const safeError = QUERY_REJECTION_ERRORS.has(error) ? error : "parent rejected query";
		try { live.child.send?.({ id, kind: "reply", error: safeError }, () => {}); }
		catch { /* Child-owned IPC callback reports transport failure. */ }
	}

	private acknowledge(live: LiveTask, id: string, accepted: boolean, error?: string): void {
		if (live.ipcClosed || live.acknowledgedIpcIds.has(id) || !live.child.send) return;
		live.acknowledgedIpcIds.add(id);
		live.acknowledgedIpcOrder.push(id);
		if (live.acknowledgedIpcOrder.length > 64) live.acknowledgedIpcIds.delete(live.acknowledgedIpcOrder.shift()!);
		try { live.child.send({ id, kind: "ack", accepted, ...(error ? { error } : {}) }, () => {}); }
		catch { /* Child-owned IPC callback reports transport failure. */ }
	}

	private sendReply(live: LiveTask, id: string, frame: Record<string, unknown>): Promise<boolean> {
		return new Promise((resolve) => {
			live.replies.set(id, { resolve });
			try {
				if (!live.child.send) this.settleReply(live, id, false);
				else live.child.send(frame, (error) => this.settleReply(live, id, !error));
			} catch { this.settleReply(live, id, false); }
		});
	}

	private settleReply(live: LiveTask, id: string, accepted: boolean): void {
		const pending = live.replies.get(id);
		if (!pending) return;
		live.replies.delete(id);
		pending.resolve(accepted);
	}

	private closeIpc(live: LiveTask): void {
		if (live.ipcClosed) return;
		live.ipcClosed = true;
		for (const query of live.queries.values()) query.cancel();
		live.queries.clear();
		for (const pending of live.replies.values()) pending.resolve(false);
		live.replies.clear();
		live.child.channel?.unref?.();
		try { live.child.disconnect?.(); }
		catch { /* Channel may already be disconnected. */ }
	}

	private write(live: LiveTask, payload: Record<string, unknown>): void {
		try {
			live.child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// the child is gone; the exit handler settles the task
		}
	}

	private checkObservationGrant(live: LiveTask): void {
		if (live.observationPreparation) {
			if (!live.observationPreparation()) live.observations = undefined;
			live.observationPreparation = undefined; // One chance; late readiness cannot attach.
		}
		if (!live.observations || !live.observationGuard) return;
		try {
			if (live.observationGuard() === true) return;
		} catch { /* Policy bookkeeping must not interrupt child execution. */ }
		live.observations = undefined;
		live.observationGuard = undefined;
	}

	private receive(id: string, request: TaskRequest, value: unknown): void {
		const live = this.live.get(id);
		if (!live || live.terminal || !value || typeof value !== "object") return;
		const raw = value as Record<string, unknown>;
		if (raw.type === "response") {
			this.armStall(id, live);
			if (!live.observationPreparation) this.checkObservationGrant(live);
			const pending = typeof raw.id === "string" ? live.pending.get(raw.id) : undefined;
			if (pending) {
				live.pending.delete(raw.id as string);
				pending.resolve(raw);
			}
			return;
		}
		this.checkObservationGrant(live);
		const events = normalizeRpcEvent(raw, { observeResponses: live.observations !== undefined });
		// A parsed object is not progress by itself. Only a recognized run event
		// renews the watchdog here, so fire-and-forget UI traffic that normalizes
		// to nothing cannot keep a child that never started its run alive forever
		// (#1034); the pre-existing timer stays armed until real progress arrives.
		const progress = events.length > 0;
		for (const event of events) {
			if (event.type === TASK_EVENT.RESPONSE_OBSERVATION) {
				const buffer = live.observations;
				if (buffer) {
					if (buffer.responses.length < MAX_CHILD_RESPONSE_OBSERVATIONS) buffer.responses.push(event.observation);
					else buffer.droppedResponses = Math.min(Number.MAX_SAFE_INTEGER, buffer.droppedResponses + 1);
				}
				continue; // Separate from store persistence, UI totals and notifications.
			}
			this.store.apply(id, event, this.deps.now());
			if (event.type === TASK_EVENT.TOOL_START && event.callId) {
				live.inFlightTools.set(event.callId, event.name);
				live.mutationStarts.delete(event.callId);
				if ((event.name === "write" || event.name === "edit") && typeof event.args.path === "string" && event.args.path.trim()) {
					live.mutationStarts.set(event.callId, { toolName: event.name, toolCallId: event.callId, path: event.args.path });
				}
			}
			if (event.type === TASK_EVENT.TOOL_END) {
				live.inFlightTools.delete(event.callId);
				const mutation = live.mutationStarts.get(event.callId);
				live.mutationStarts.delete(event.callId);
				const task = this.store.get(id);
				if (mutation && task && raw.isError === false && !event.isError) {
					try {
						const evidence = (raw.result as { details?: { gentleSessionChange?: unknown } } | undefined)?.details?.gentleSessionChange;
						const observed = isSessionChangeEvidence(evidence) && evidence.id === mutation.toolCallId ? { ...mutation, evidence: structuredClone(evidence) } : mutation;
						void Promise.resolve(this.hooks.onSuccessfulMutation?.(task, observed)).catch(() => {});
					}
					catch { /* Bookkeeping failure must not rewrite a successful tool or stop the child. */ }
				}
			}
			if (event.type === TASK_EVENT.ASK) void this.answer(id, request, live, event.request, raw);
			if (event.type === TASK_EVENT.AGENT_SETTLED) {
				if (live.observations) live.observations.agentSettled = true;
				const terminal = this.store.get(id);
				if (terminal?.error) this.requestStop(id, TASK_STATUS.FAILED, terminal.error);
				else if (terminal?.result) this.requestStop(id, TASK_STATUS.COMPLETED, null);
				else this.requestStop(id, TASK_STATUS.FAILED, "assistant settled without a final report");
			}
		}
		if (!live.terminal && progress) this.armStall(id, live);
	}

	// Task-mode subagents may ask the human through the host; background ones
	// get their dialog cancelled so they never block on nobody.
	private async answer(id: string, request: TaskRequest, live: LiveTask, ask: AskRequest, raw: Record<string, unknown>): Promise<void> {
		let answer: AskAnswer = { cancelled: true };
		if (request.mode === "task") {
			try {
				answer = await this.hooks.askUser(id, ask, raw);
			} catch {
				answer = { cancelled: true };
			}
		}
		if (this.live.get(id) !== live || live.terminal) return;
		this.write(live, { type: "extension_ui_response", id: ask.id, ...answer });
		const current = this.store.get(id);
		if (current?.status === TASK_STATUS.WAITING) this.store.update(id, { status: TASK_STATUS.RUNNING, lastStep: answer.cancelled ? "question dismissed" : "answered" });
	}

	// POSIX children start detached, so their PID is the owned process-group ID.
	// Windows uses ChildProcess.kill only: Node has no equivalent tree guarantee.
	private signal(live: LiveTask, signal: NodeJS.Signals): void {
		if (live.processGroup !== undefined) {
			try {
				this.processControl.kill(-live.processGroup, signal);
				return;
			} catch {
				// The owned group is already gone; the child handle may still observe exit.
			}
		}
		try {
			live.child.kill(signal);
		} catch {
			// already gone
		}
	}

	private requestStop(id: string, status: TaskRecord["status"], error: string | null, abort = false): void {
		const live = this.live.get(id);
		if (!live || live.terminal) return;
		live.terminal = { status, error };
		live.mutationStarts.clear();
		live.inFlightTools.clear();
		live.cleanupDeadlineAt = this.deps.now() + GROUP_CONFIRM_DEADLINE_MS;
		live.permissionBroker?.close();
		this.closeIpc(live);
		live.cancelStall();
		if (abort) void this.send(id, { type: "abort" });
		this.signal(live, "SIGTERM");
		live.cancelGrace = this.deps.schedule(() => {
			if (this.live.get(id) !== live) return;
			this.signal(live, "SIGKILL");
			this.confirmGroupExit(id, live);
		}, TERMINATION_GRACE_MS);
	}

	// A false result is ambiguous, so the probe reports which one it is: an ESRCH
	// result proves the group is gone, while an absent process group means the
	// question cannot be asked at all. Only the first justifies treating the exit as
	// complete without an observed exit event.
	private probeGroup(live: LiveTask): "present" | "gone" | "unavailable" {
		if (live.processGroup === undefined) return "unavailable";
		try {
			this.processControl.kill(-live.processGroup, 0);
			return "present";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "present";
		}
	}

	private groupExists(live: LiveTask): boolean {
		return this.probeGroup(live) === "present";
	}

	private confirmGroupExit(id: string, live: LiveTask): void {
		if (this.live.get(id) !== live) return;
		const group = this.probeGroup(live);
		if (group === "present") {
			if (this.deps.now() >= (live.cleanupDeadlineAt ?? 0)) {
				live.cancelGrace();
				live.quarantined = true;
				this.finish(id, TASK_STATUS.FAILED, `process cleanup unconfirmed after ${GROUP_CONFIRM_DEADLINE_MS}ms; capacity quarantined`, live);
				return;
			}
			live.cancelGrace = this.deps.schedule(() => this.confirmGroupExit(id, live), GROUP_CONFIRM_MS);
			return;
		}
		if (group === "gone") {
			// No process remains in the group, so the exit is complete whether or not
			// the child's own exit event was ever observed. Completing here also frees
			// the concurrency slot; finishing without it would leave the task recorded
			// while its slot stayed occupied and queued work never pumped.
			this.completeExit(id, live);
			return;
		}
		if (live.childExit !== undefined) {
			this.completeExit(id, live);
			return;
		}
		// With no process group to probe, an observed exit is the only confirmation
		// available. Wait for it within the deadline, then quarantine instead of
		// completing on an assumption, and never return without either.
		if (this.deps.now() >= (live.cleanupDeadlineAt ?? 0)) {
			live.cancelGrace();
			live.quarantined = true;
			this.finish(id, TASK_STATUS.FAILED, `child exit unconfirmed after ${GROUP_CONFIRM_DEADLINE_MS}ms; capacity quarantined`, live);
			return;
		}
		live.cancelGrace = this.deps.schedule(() => this.confirmGroupExit(id, live), GROUP_CONFIRM_MS);
	}

	private childError(id: string, error: Error): void {
		const live = this.live.get(id);
		if (!live) return;
		// Node leaves pid undefined when spawn failed; a live PID must still exit
		// before its slot is released, even if its handle later emits an error.
		if (live.child.pid !== undefined) {
			this.requestStop(id, TASK_STATUS.FAILED, `pi process error: ${error.message}`);
			return;
		}
		live.permissionBroker?.close();
		this.closeIpc(live);
		live.cancelStall();
		live.cancelGrace();
		this.live.delete(id);
		this.finish(id, TASK_STATUS.FAILED, `could not start pi: ${error.message}`, live);
	}

	private exited(id: string, code: number | null): void {
		const live = this.live.get(id);
		if (!live) return;
		live.childExit = code;
		if (this.groupExists(live)) {
			if (!live.terminal) this.requestStop(id, TASK_STATUS.FAILED, `pi exited with code ${code ?? "unknown"} before agent_settled${this.stderrSuffix(live)}`);
			return;
		}
		this.completeExit(id, live);
	}

	private completeExit(id: string, live: LiveTask): void {
		live.permissionBroker?.close();
		this.closeIpc(live);
		live.cancelStall();
		live.cancelGrace();
		this.live.delete(id);
		// Quarantine already notified completion, but its retained slot is now free.
		if (live.quarantined) {
			queueMicrotask(() => this.pump());
			return;
		}
		const terminal = live.terminal;
		this.finish(id, terminal ? terminal.status : TASK_STATUS.FAILED, terminal ? terminal.error : `pi exited with code ${live.childExit ?? "unknown"} before agent_settled${this.stderrSuffix(live)}`, live);
	}

	private finish(id: string, status: TaskRecord["status"], error: string | null, live?: LiveTask): void {
		const current = this.store.get(id);
		if (!current || isFinished(current.status)) return;
		const finished = this.store.update(id, { status, endedAt: this.deps.now(), error, lastStep: error ?? "done" });
		if (finished) {
			if (live) this.checkObservationGrant(live);
			const buffer = live?.observations;
			const snapshot: ChildObservationSnapshot | undefined = buffer ? Object.freeze({
				coverage: "final_assistant_messages_only", agentSettled: buffer.agentSettled,
				responses: Object.freeze(buffer.responses.slice()), droppedResponses: buffer.droppedResponses,
			}) : undefined;
			if (live) {
				live.observations = undefined; // Also release quarantined buffers.
				live.observationGuard = undefined;
			}
			this.hooks.onFinish?.(finished, snapshot);
			for (const resolve of this.waiters.get(id) ?? []) resolve(finished);
			this.waiters.delete(id);
			for (const resolve of this.queryWaiters.get(id) ?? []) resolve(undefined);
			this.queryWaiters.delete(id);
			this.firstQueries.delete(id);
		}
		queueMicrotask(() => this.pump());
	}
}

// Human-readable suffix for an abort signal's reason, so a cancelled tool call is
// distinguishable in the record and the notification rather than reported only as
// "aborted". Returns an empty string when there is no usable reason.
export function abortReasonText(reason: unknown): string {
	if (reason === undefined) return "";
	const message =
		reason instanceof Error && reason.message.length > 0
			? reason.message
			: typeof reason === "string" && reason.length > 0
				? reason
				: "";
	return message.length > 0 ? ` (${message})` : "";
}
