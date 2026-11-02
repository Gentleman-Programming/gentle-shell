import { JsonLines, piCommand, type ChildLike, type PiCommand, type ProcessControl, type Spawn } from "./agents-runner.ts";
import { childPackageExtensionArgs, parseChildPackageInjection } from "./child-package-injection.ts";
import { FLEET_ROLE_ENV } from "./fleet-role.ts";
import { INTERACTIVE_HOST_ENV } from "./rpc-host.ts";
import { TODO_DETAILS_KEY, TODO_TOOL_NAME, todoProgress, type TodoState } from "./shell-todo.ts";

// Fleet member (odd/tasks/fleet-orchestrator.md): one full, headless Gentle
// Shell session (`pi --mode rpc`) led by the fleet controller. Everything the
// controller learns about a member is tracked here in code from RPC events;
// the controller model only ever reads the compact digest, never transcripts.

// Subagent-child markers: a member is a primary session, not a delegated child.
const CHILD_ONLY_ENV = ["GENTLE_PI_AGENTS_CHILD", "GENTLE_PI_AGENTS_OWNED_IPC", "GENTLE_PI_AGENTS_REQUESTED_TOOLS", "GENTLE_PI_AGENTS_PARENT_PERMISSION_FD"];
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const LAST_TEXT_MAX = 400;
const DETAIL_FIELD_MAX = 300;
const STOP_GRACE_MS = 5000;
const hostProcess: ProcessControl = { platform: process.platform, kill: (pid, signal) => process.kill(pid, signal) };

export interface MemberLaunchInput {
	env: NodeJS.ProcessEnv;
	cwd: string;
	sessionDir: string;
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
	const args = [...pi.args, "--mode", "rpc", "--session-dir", input.sessionDir, ...childPackageExtensionArgs(injection)];
	if (input.model) args.push("--model", input.model);
	// The interactive-host signal routes the member's own questions through RPC
	// dialogs, so they reach the controller instead of failing headless.
	const env: NodeJS.ProcessEnv = { ...input.env, [FLEET_ROLE_ENV]: "member", [INTERACTIVE_HOST_ENV]: "1" };
	for (const key of CHILD_ONLY_ENV) delete env[key];
	return { command: pi.command, args, env, cwd: input.cwd };
}

export type FleetMemberStatus = "starting" | "working" | "idle" | "waiting-question" | "exited";

export interface FleetMemberDialog {
	id: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
}

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
	spawn: Spawn;
	schedule(fn: () => void, ms: number): () => void;
	process?: ProcessControl;
	stopGraceMs?: number;
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
	private readonly options: FleetMemberOptions;
	private readonly processControl: ProcessControl;
	private child: ChildLike | undefined;
	private processGroup: number | undefined;
	private nextId = 0;
	private cancelStop: () => void = () => {};

	constructor(options: FleetMemberOptions) {
		this.options = options;
		this.name = options.name;
		this.objective = options.objective ?? "";
		this.processControl = options.process ?? hostProcess;
	}

	get live(): boolean {
		return this.status !== "exited";
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
		// Drain stderr so a chatty member never blocks on a full pipe.
		child.stderr?.resume?.();
		child.on("error", error => {
			this.lastError = error.message;
			this.exited(null, null);
		});
		child.on("exit", (code, signal) => this.exited(code, signal));
	}

	prompt(message: string): void {
		const working = this.status === "working" || this.status === "waiting-question";
		this.write({ type: "prompt", message, ...(working ? { streamingBehavior: "followUp" } : {}) });
		if (!working) this.setStatus("working");
	}

	/** Steering only reaches a running member; an idle one gets a new prompt. */
	steer(message: string): void {
		if (this.status === "working" || this.status === "waiting-question") this.write({ type: "steer", message });
		else this.prompt(message);
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
		if (!child || !this.live) return;
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
		if (this.dialogs.length > 0) parts.push(`question: ${oneLine(this.dialogs[0].title, 80)}`);
		if (this.lastError) parts.push(`error: ${oneLine(this.lastError, 80)}`);
		return parts.join(" · ");
	}

	/** Bounded detail for an explicit request; still no transcript. */
	detail(): string {
		const lines = [this.digest()];
		if (this.objective) lines.push(`objective: ${oneLine(this.objective, DETAIL_FIELD_MAX)}`);
		if (this.prefixTokens !== undefined) lines.push(`prefix ${tokens(this.prefixTokens)} tok`);
		for (const dialog of this.dialogs) {
			const choices = dialog.options?.length ? ` [${dialog.options.map(option => oneLine(option, 40)).join(" | ")}]` : "";
			lines.push(`question (${dialog.method}): ${oneLine(dialog.title, 120)}${dialog.message ? ` — ${oneLine(dialog.message, 120)}` : ""}${choices}`);
		}
		if (this.lastText) lines.push(`last reply: ${this.lastText}`);
		return lines.join("\n");
	}

	private write(command: Raw): void {
		const stdin = this.child?.stdin;
		if (!stdin || !this.live) return;
		this.nextId += 1;
		try { stdin.write(`${JSON.stringify({ id: `${this.name}-${this.nextId}`, ...command })}\n`); }
		catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
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
				this.options.onChange?.(this);
				return;
			case "tool_execution_end": {
				this.lastTool = oneLine(event.toolName, 40) || this.lastTool;
				const state = record(record(event.result)?.details)?.[TODO_DETAILS_KEY];
				if (event.toolName === TODO_TOOL_NAME && record(state) && Array.isArray((state as Raw).tasks)) {
					const { done, total, current } = todoProgress(state as unknown as TodoState, "");
					this.todo = { done, total, current };
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
				this.dialogs.push(dialog);
				this.setStatus("waiting-question");
				this.options.onEvent?.(this, { kind: "dialog", dialog });
				return;
			}
			case "agent_settled":
				// A settled run waits on nothing: its dialogs resolved or timed out.
				this.dialogs = [];
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
		if (text) this.lastText = text.length > LAST_TEXT_MAX ? `…${text.slice(-(LAST_TEXT_MAX - 1))}` : text;
		this.options.onChange?.(this);
	}

	private exited(code: number | null, signal: string | null): void {
		if (!this.live) return;
		this.cancelStop();
		this.dialogs = [];
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
