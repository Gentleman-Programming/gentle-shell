import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { JsonLines, piCommand, type ChildLike, type PiCommand, type ProcessControl, type Spawn } from "./agents-runner.ts";
import { childPackageExtensionArgs, parseChildPackageInjection } from "./child-package-injection.ts";
import { classifyDialog, dialogResponse, type DialogResponse, type FleetDialogAnswer, type ProtectedDialog } from "./fleet-dialogs.ts";
import { FLEET_ROLE_ENV } from "./fleet-role.ts";
import { INTERACTIVE_HOST_ENV } from "./rpc-host.ts";
import { TODO_DETAILS_KEY, TODO_TOOL_NAME, todoProgress, type TodoState } from "./shell-todo.ts";

// Fleet member (odd/tasks/fleet-orchestrator.md): one full, headless Gentle
// Shell session (`pi --mode rpc`) led by the fleet controller. Everything the
// controller learns about a member is tracked here in code from RPC events;
// the controller model only ever reads the compact digest, never transcripts.

// Subagent-child markers: a member is a primary session, not a delegated child.
const CHILD_ONLY_ENV = ["GENTLE_PI_AGENTS_CHILD", "GENTLE_PI_AGENTS_OWNED_IPC", "GENTLE_PI_AGENTS_REQUESTED_TOOLS", "GENTLE_PI_AGENTS_PARENT_PERMISSION_FD"];
// Standing permissions are never inherited (S2): the env-forced autonomous
// guardrails (extensions/gentle-ai.ts:1770). The saved permission-mode default
// is not env-based; lib/yolo-session-policy.ts keeps every member in NORMAL.
const PERMISSION_STATE_ENV = ["GENTLE_PI_AUTONOMOUS_MODE"];
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const LAST_TEXT_MAX = 400;
const DETAIL_FIELD_MAX = 300;
// A protected dialog reaches the human with its full text (consent content).
const RELAY_FIELD_MAX = 8000;
const STOP_GRACE_MS = 5000;
// After the process exits, its last stdout lines may still be in the pipe.
const STDOUT_DRAIN_MS = 2000;
const ACTIVITY_MAX = 200;
const ACTIVITY_TEXT_MAX = 160;
const INSPECT_LINES_MAX = 200;
const FEATURE_DOC_PATTERN = /(?:[\w.~\/-]*\/)?odd\/tasks\/[\w.-]+\.md/g;
const hostProcess: ProcessControl = { platform: process.platform, kill: (pid, signal) => process.kill(pid, signal) };

export interface MemberLaunchInput {
	env: NodeJS.ProcessEnv;
	cwd: string;
	sessionDir: string;
	/** A resumed member reopens its own session file (Pi docs/cli.md: `--session <path|id>` "Opens by file path"). */
	sessionFile?: string;
	model?: string;
	pi?: PiCommand;
}

export interface MemberLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

export function buildMemberLaunch(input: MemberLaunchInput): MemberLaunch {
	const pi = input.pi ?? piCommand();
	const injection = parseChildPackageInjection(input.env) ?? { noExtensions: false, extensionPaths: [] };
	const args = [...pi.args, "--mode", "rpc", "--session-dir", input.sessionDir, ...(input.sessionFile ? ["--session", input.sessionFile] : []), ...childPackageExtensionArgs(injection)];
	if (input.model) args.push("--model", input.model);
	// The interactive-host signal routes the member's own questions through RPC
	// dialogs, so they reach the controller instead of failing headless.
	const env: NodeJS.ProcessEnv = { ...input.env, [FLEET_ROLE_ENV]: "member", [INTERACTIVE_HOST_ENV]: "1" };
	for (const key of [...CHILD_ONLY_ENV, ...PERMISSION_STATE_ENV]) delete env[key];
	return { command: pi.command, args, env, cwd: input.cwd };
}

/** The newest Pi session file (`<timestamp>_<id>.jsonl`) in a member's session dir, if any. */
export function latestMemberSessionFile(sessionDir: string): string | undefined {
	let newest: { path: string; mtime: number } | undefined;
	let names: string[];
	try { names = readdirSync(sessionDir); } catch { return undefined; }
	for (const name of names.filter(entry => entry.endsWith(".jsonl")).sort()) {
		const path = join(sessionDir, name);
		let mtime: number;
		try { mtime = statSync(path).mtimeMs; } catch { continue; }
		if (!newest || mtime >= newest.mtime) newest = { path, mtime };
	}
	return newest?.path;
}

export type FleetMemberStatus = "starting" | "working" | "idle" | "waiting-question" | "exited";

export interface FleetMemberDialog {
	id: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
	/** Set for a protected class: code relays it to the human; the fleet model cannot answer it. */
	protected?: ProtectedDialog;
	/** Full text of a protected dialog for the human relay. */
	relay?: { title: string; message?: string; placeholder?: string; prefill?: string };
}

export type FleetAnswerResult = { ok: true; dialog: FleetMemberDialog; response: DialogResponse } | { ok: false; error: string };

export type FleetMemberEvent =
	| { kind: "settled" }
	| { kind: "dialog"; dialog: FleetMemberDialog }
	| { kind: "exit"; code: number | null; signal: string | null };

export interface FleetMemberUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface FleetMemberOptions {
	name: string;
	objective?: string;
	launch: MemberLaunch;
	/** The member's own worktree and branch when it works in a git repository. */
	worktree?: { path: string; branch: string };
	/** A resumed member's earlier tokens and cost: its counts continue from them. */
	usage?: { totalTokens: number; cost: number };
	spawn: Spawn;
	schedule(fn: () => void, ms: number): () => void;
	process?: ProcessControl;
	stopGraceMs?: number;
	stdoutDrainMs?: number;
	/** Wake-worthy moments only: settle, question, exit. */
	onEvent?(member: FleetMember, event: FleetMemberEvent): void;
	/** Any tracked state change, for the user-facing status line. */
	onChange?(member: FleetMember): void;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : undefined;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function oneLine(value: unknown, max: number): string {
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export class FleetMember {
	readonly name: string;
	readonly objective: string;
	status: FleetMemberStatus = "starting";
	todo: { done: number; total: number; current: string | null } | undefined;
	lastTool: string | undefined;
	usage: FleetMemberUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	/** Tokens of the first assistant request: the member's session prefix. */
	prefixTokens: number | undefined;
	lastText = "";
	lastError: string | undefined;
	dialogs: FleetMemberDialog[] = [];
	exitCode: number | null = null;
	exitSignal: string | null = null;
	/** The member's own ODD feature document, when its tools or todo name one. */
	featureDoc: string | undefined;
	/** Bounded one-line activity log for explicit inspection; never a transcript. */
	readonly activity: string[] = [];
	private readonly options: FleetMemberOptions;
	private readonly processControl: ProcessControl;
	private child: ChildLike | undefined;
	private processGroup: number | undefined;
	private nextId = 0;
	private cancelStop: () => void = () => {};
	private cancelDrain: () => void = () => {};
	private stopRequested = false;
	private processExit: { code: number | null; signal: string | null } | undefined;
	private stdoutClosed = false;

	constructor(options: FleetMemberOptions) {
		this.options = options;
		this.name = options.name;
		this.objective = options.objective ?? "";
		this.processControl = options.process ?? hostProcess;
		if (options.usage) this.usage = { ...this.usage, totalTokens: options.usage.totalTokens, cost: options.usage.cost };
	}

	get live(): boolean {
		return this.status !== "exited";
	}

	get cwd(): string {
		return this.options.launch.cwd;
	}

	/** A stop was requested: the member takes no new commands. */
	get stopping(): boolean {
		return this.stopRequested;
	}

	start(): void {
		if (this.child) return;
		const detached = this.processControl.platform !== "win32";
		const { command, args, env, cwd } = this.options.launch;
		let child: ChildLike;
		try {
			child = this.options.spawn(command, args, { cwd, env, detached, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			this.lastError = `could not start pi: ${error instanceof Error ? error.message : String(error)}`;
			this.exited(null, null);
			return;
		}
		this.child = child;
		this.processGroup = detached && typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined;
		const lines = new JsonLines(value => this.handle(value));
		child.stdout?.setEncoding?.("utf8");
		child.stdout?.on("data", (chunk: string | Buffer) => lines.push(String(chunk)));
		// The member finishes when its stdout closes, so lines still in the pipe at
		// process exit (the final message_end, agent_settled) are counted.
		child.stdout?.on("end", () => { lines.push("\n"); this.stdoutDone(); });
		child.stdout?.on("close", () => this.stdoutDone());
		// EPIPE and write-after-end arrive as stream errors, not throws: without a
		// listener they would crash the controller (same guard as agents-runner).
		child.stdin?.on("error", error => { this.lastError = error.message; this.options.onChange?.(this); });
		// Drain stderr so a chatty member never blocks on a full pipe.
		child.stderr?.resume?.();
		child.on("error", error => {
			this.lastError = error.message;
			this.exited(null, null);
		});
		child.on("exit", (code, signal) => this.processExited(code, signal));
	}

	/** Returns false when the member is stopping or gone and nothing was sent. */
	prompt(message: string): boolean {
		const working = this.status === "working" || this.status === "waiting-question";
		if (!this.write({ type: "prompt", message, ...(working ? { streamingBehavior: "followUp" } : {}) })) return false;
		if (!working) this.setStatus("working");
		return true;
	}

	/** Steering only reaches a running member; an idle one gets a new prompt. */
	steer(message: string): boolean {
		if (this.status === "working" || this.status === "waiting-question") return this.write({ type: "steer", message });
		return this.prompt(message);
	}

	abort(): void {
		this.write({ type: "abort" });
	}

	getState(): void {
		this.write({ type: "get_state" });
	}

	/** Close stdin for an orderly shutdown, then escalate after the grace period. */
	stop(): void {
		const child = this.child;
		if (!child || !this.live || this.stopRequested || this.processExit) return;
		this.stopRequested = true;
		try { child.stdin?.end(); } catch { this.signal("SIGTERM"); }
		const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
		this.cancelStop = this.options.schedule(() => {
			if (!this.live) return;
			this.signal("SIGTERM");
			this.cancelStop = this.options.schedule(() => { if (this.live) this.signal("SIGKILL"); }, grace);
		}, grace);
	}

	/** One compact line, built by code. */
	digest(): string {
		const parts = [`${this.name} [${this.status}]`];
		if (this.todo) parts.push(`todo ${this.todo.done}/${this.todo.total}${this.todo.current ? ` "${oneLine(this.todo.current, 60)}"` : ""}`);
		if (this.lastTool) parts.push(`last tool ${this.lastTool}`);
		parts.push(`${tokens(this.usage.totalTokens)} tok`, `$${this.usage.cost.toFixed(2)}`);
		if (this.dialogs.length > 0) parts.push(`question${this.dialogs[0].protected ? " (relayed to the human)" : ""}: ${oneLine(this.dialogs[0].title, 80)}`);
		if (this.lastError) parts.push(`error: ${oneLine(this.lastError, 80)}`);
		return parts.join(" · ");
	}

	/**
	 * The fleet model's answer to a pending dialog (default: the oldest). Refused,
	 * with nothing written, for a protected dialog or an answer that does not fit.
	 */
	answer(answer: FleetDialogAnswer, dialogId?: string): FleetAnswerResult {
		const dialog = dialogId === undefined ? this.dialogs[0] : this.dialogs.find(entry => entry.id === dialogId);
		if (!dialog) return { ok: false, error: dialogId === undefined ? `no pending dialog for ${this.name}.` : `no pending dialog "${dialogId}" for ${this.name}.` };
		if (dialog.protected) return { ok: false, error: `dialog ${dialog.id} ("${oneLine(dialog.title, 80)}") is relayed to the human; you cannot answer it.` };
		const built = dialogResponse(dialog, answer);
		if ("error" in built) return { ok: false, error: built.error };
		if (!this.respond(dialog.id, built.response)) return { ok: false, error: `${this.name} is stopping or gone; nothing was written.` };
		return { ok: true, dialog, response: built.response };
	}

	/** Code path: writes the response for a pending dialog and clears it. */
	respond(dialogId: string, response: DialogResponse): boolean {
		if (!this.dialogs.some(dialog => dialog.id === dialogId)) return false;
		if (!this.write({ type: "extension_ui_response", id: dialogId, ...response })) return false;
		this.dialogs = this.dialogs.filter(dialog => dialog.id !== dialogId);
		this.note(`answered ${dialogId}`);
		if (this.dialogs.length === 0 && this.status === "waiting-question") this.setStatus("working");
		else this.options.onChange?.(this);
		return true;
	}

	hasDialog(dialogId: string): boolean {
		return this.dialogs.some(dialog => dialog.id === dialogId);
	}

	/** Bounded detail for an explicit request; still no transcript. */
	detail(): string {
		const lines = [this.digest()];
		if (this.objective) lines.push(`objective: ${oneLine(this.objective, DETAIL_FIELD_MAX)}`);
		const worktree = this.options.worktree;
		if (worktree) lines.push(`worktree: ${worktree.path} (branch ${worktree.branch})`);
		if (this.prefixTokens !== undefined) lines.push(`prefix ${tokens(this.prefixTokens)} tok`);
		for (const dialog of this.dialogs) {
			const choices = dialog.options?.length ? ` [${dialog.options.map(option => oneLine(option, 40)).join(" | ")}]` : "";
			lines.push(`${dialog.protected ? "protected question, relayed to the human" : "question"} (${dialog.method}): ${oneLine(dialog.title, 120)}${dialog.message ? ` — ${oneLine(dialog.message, 120)}` : ""}${choices}`);
		}
		if (this.lastText) lines.push(`last reply: ${this.lastText}`);
		return lines.join("\n");
	}

	/** Detail plus the cwd, the last `count` activity lines and the feature document. */
	inspect(count: number): string {
		// The cwd resolves the member's own Engram project (T2b, L32).
		const lines = [this.detail(), `cwd: ${this.cwd}`];
		if (this.featureDoc) lines.push(`feature document: ${this.featureDoc}`);
		const take = Math.max(1, Math.min(INSPECT_LINES_MAX, Math.floor(count) || 1));
		const tail = this.activity.slice(-take);
		lines.push(tail.length === 0 ? "recent activity: none" : `recent activity (last ${tail.length} of ${this.activity.length}):`, ...tail.map(entry => `- ${entry}`));
		return lines.join("\n");
	}

	private write(command: Raw): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || !this.live || this.stopRequested || this.processExit || stdin.writableEnded) return false;
		this.nextId += 1;
		try { stdin.write(`${JSON.stringify({ id: `${this.name}-${this.nextId}`, ...command })}\n`); }
		catch (error) { this.lastError = error instanceof Error ? error.message : String(error); return false; }
		return true;
	}

	private note(entry: string): void {
		this.activity.push(oneLine(entry, ACTIVITY_TEXT_MAX));
		if (this.activity.length > ACTIVITY_MAX) this.activity.splice(0, this.activity.length - ACTIVITY_MAX);
	}

	private findFeatureDoc(value: unknown): void {
		let text: string;
		try { text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; } catch { return; }
		const found = text.slice(0, 4000).match(FEATURE_DOC_PATTERN)?.at(-1);
		if (found) this.featureDoc = isAbsolute(found) ? found : resolve(this.cwd, found);
	}

	private setStatus(status: FleetMemberStatus): void {
		if (this.status === "exited") return;
		this.status = status;
		this.options.onChange?.(this);
	}

	private handle(value: unknown): void {
		const event = record(value);
		if (!event || !this.live) return;
		switch (event.type) {
			case "response":
				if (event.success === false) {
					this.lastError = oneLine(event.error, DETAIL_FIELD_MAX) || "command failed";
					this.note(`error: ${this.lastError}`);
					if (event.command === "prompt" && this.status === "working") {
						this.setStatus("idle");
						this.options.onEvent?.(this, { kind: "settled" });
					}
				}
				return;
			case "agent_start":
				this.lastError = undefined;
				if (this.status !== "waiting-question") this.setStatus("working");
				return;
			case "tool_execution_start":
				this.lastTool = oneLine(event.toolName, 40) || this.lastTool;
				this.note(`tool ${this.lastTool ?? "?"}`);
				this.findFeatureDoc(event.args);
				this.options.onChange?.(this);
				return;
			case "tool_execution_end": {
				this.lastTool = oneLine(event.toolName, 40) || this.lastTool;
				const state = record(record(event.result)?.details)?.[TODO_DETAILS_KEY];
				if (event.toolName === TODO_TOOL_NAME && record(state) && Array.isArray((state as Raw).tasks)) {
					const { done, total, current } = todoProgress(state as unknown as TodoState, "");
					this.todo = { done, total, current };
					this.findFeatureDoc((state as unknown as TodoState).tasks.map(task => `${task.title} ${task.note ?? ""}`).join(" "));
				}
				this.options.onChange?.(this);
				return;
			}
			case "message_end":
				this.assistantEnd(record(event.message));
				return;
			case "extension_ui_request": {
				if (!DIALOG_METHODS.has(String(event.method))) return;
				const dialog: FleetMemberDialog = { id: String(event.id ?? ""), method: String(event.method), title: oneLine(event.title, DETAIL_FIELD_MAX) };
				if (typeof event.message === "string") dialog.message = oneLine(event.message, DETAIL_FIELD_MAX);
				if (Array.isArray(event.options)) dialog.options = event.options.filter((option): option is string => typeof option === "string");
				// Classified on the raw text: a bounded title could cut its marker.
				const raw = { method: dialog.method, title: typeof event.title === "string" ? event.title : "", message: typeof event.message === "string" ? event.message : undefined, options: dialog.options };
				const protectedClass = classifyDialog(raw);
				if (protectedClass) {
					dialog.protected = protectedClass;
					dialog.relay = { title: raw.title.slice(0, RELAY_FIELD_MAX) };
					if (raw.message !== undefined) dialog.relay.message = raw.message.slice(0, RELAY_FIELD_MAX);
					if (typeof event.placeholder === "string") dialog.relay.placeholder = event.placeholder.slice(0, RELAY_FIELD_MAX);
					if (typeof event.prefill === "string") dialog.relay.prefill = event.prefill.slice(0, RELAY_FIELD_MAX);
				}
				this.dialogs.push(dialog);
				this.note(`question (${dialog.method}): ${dialog.title}${dialog.options?.length ? ` [${dialog.options.join(" | ")}]` : ""}`);
				this.setStatus("waiting-question");
				this.options.onEvent?.(this, { kind: "dialog", dialog });
				return;
			}
			case "agent_settled":
				// A settled run waits on nothing: its dialogs resolved or timed out.
				this.dialogs = [];
				this.note("settled");
				this.setStatus("idle");
				this.options.onEvent?.(this, { kind: "settled" });
				return;
			default:
				return;
		}
	}

	private assistantEnd(message: Raw | undefined): void {
		if (message?.role !== "assistant") return;
		const usage = record(message.usage);
		if (usage) {
			const input = num(usage.input), cacheRead = num(usage.cacheRead), cacheWrite = num(usage.cacheWrite);
			this.prefixTokens ??= input + cacheRead + cacheWrite;
			this.usage = {
				input: this.usage.input + input,
				output: this.usage.output + num(usage.output),
				cacheRead: this.usage.cacheRead + cacheRead,
				cacheWrite: this.usage.cacheWrite + cacheWrite,
				totalTokens: this.usage.totalTokens + num(usage.totalTokens),
				cost: this.usage.cost + num(record(usage.cost)?.total),
			};
		}
		const text = Array.isArray(message.content)
			? message.content.map(part => record(part)?.type === "text" ? String(record(part)?.text ?? "") : "").join("").replace(/\s+/g, " ").trim()
			: "";
		if (text) {
			this.lastText = text.length > LAST_TEXT_MAX ? `…${text.slice(-(LAST_TEXT_MAX - 1))}` : text;
			this.note(`reply: ${text}`);
		}
		this.options.onChange?.(this);
	}

	// The process is gone: stop escalating and take no commands, but keep reading
	// stdout until it closes, with a bounded fallback for a pipe left open.
	private processExited(code: number | null, signal: string | null): void {
		if (!this.live || this.processExit) return;
		this.processExit = { code, signal };
		this.cancelStop();
		const stdout = this.child?.stdout;
		if (!stdout || this.stdoutClosed || stdout.readableEnded) {
			this.exited(code, signal);
			return;
		}
		this.cancelDrain = this.options.schedule(() => this.exited(code, signal), this.options.stdoutDrainMs ?? STDOUT_DRAIN_MS);
	}

	private stdoutDone(): void {
		this.stdoutClosed = true;
		if (this.processExit) this.exited(this.processExit.code, this.processExit.signal);
	}

	private exited(code: number | null, signal: string | null): void {
		if (!this.live) return;
		this.cancelStop();
		this.cancelDrain();
		this.dialogs = [];
		this.exitCode = code;
		this.exitSignal = signal;
		this.note(`exited (code ${code ?? "none"}${signal ? `, ${signal}` : ""})`);
		this.status = "exited";
		this.options.onChange?.(this);
		this.options.onEvent?.(this, { kind: "exit", code, signal });
	}

	// POSIX members start detached, so their PID is the owned process group.
	private signal(signal: NodeJS.Signals): void {
		if (this.processGroup !== undefined) {
			try {
				this.processControl.kill(-this.processGroup, signal);
				return;
			} catch {
				// group already gone; fall back to the handle
			}
		}
		try { this.child?.kill(signal); } catch { /* already gone */ }
	}
}
