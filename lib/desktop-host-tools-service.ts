// Gentle Desktop host tools bridge: answers `set_host_tools` and
// `host_tool_result`, and turns the agent's calls to a host tool into
// `host_tool_call` / `host_tool_cancel` events (contract in
// `lib/desktop-rpc-host-tools.ts`).
//
// Each host tool is a real Pi tool registered with `pi.registerTool()` after
// startup (Pi refreshes its tool registry and system prompt at once, so the
// next model request sees it), with the client's description, its JSON Schema
// as `parameters`, and its guidelines as `promptGuidelines` (bullets Pi adds to
// the system prompt only while the tool is active). Pi has no way to remove a
// registered tool, so unregistering re-registers it with `exposure: "hidden"`:
// registered but unreachable, never declared to the model, guidelines left out.
// Registering the name again later makes it `direct` and active again.
//
// The tool's `execute` never runs client code: it emits the call, waits for the
// client's content, and gives up when the turn is aborted or after ten minutes.
//
// `host_message` hands a custom message to `pi.sendMessage` (persisted in the
// session like any extension's custom message). `set_host_context` keeps one
// hidden custom message per provider that a `before_agent_start` handler adds
// to every run while it is set; a session change drops them all.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	ALREADY_ANSWERED,
	DESKTOP_HOST_TOOLS_LIMITS,
	HOST_MESSAGES_UNAVAILABLE,
	HOST_TOOLS_UNAVAILABLE,
	hostContextType,
	hostToolOfflineText,
	modelGuidelines,
	parseHostMessage,
	parseHostToolResult,
	parseSetHostContext,
	parseSetHostTools,
	promptSnippet,
	TOO_MANY_CONTEXTS,
	UNKNOWN_CALL,
	type HostToolContent,
	type HostToolSpec,
} from "./desktop-rpc-host-tools.ts";

export type DesktopHostToolsEmit = (event: string, data: Record<string, unknown>) => void;

export interface DesktopHostToolsTimers {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface DesktopHostToolsOptions {
	timers?: DesktopHostToolsTimers;
	callTimeoutMs?: number;
	newCallId?: () => string;
}

/**
 * What a host tool call resolves to; Pi shows `content` to the model, as an
 * error when `isError`. `details` is the client's own `details` when it sent
 * one, otherwise who answered.
 */
export interface HostToolCallResult {
	content: HostToolContent[];
	details: Record<string, unknown>;
	isError?: boolean;
}

interface HostContext {
	content: string;
	details?: Record<string, unknown>;
	/** Removes the provider's `before_agent_start` handler. */
	off: () => void;
}

interface PendingCall {
	provider: string;
	tool: string;
	finish: (result: HostToolCallResult) => void;
}

const realTimers: DesktopHostToolsTimers = {
	setTimeout(callback, ms) {
		const handle = setTimeout(callback, ms);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const HIDDEN_PARAMETERS = { type: "object", properties: {} };

function errorResult(provider: string, text: string, callId?: string): HostToolCallResult {
	return { content: [{ type: "text", text }], details: { provider, ...(callId === undefined ? {} : { callId }) }, isError: true };
}

/**
 * The Desktop domain slice for host tools. Registrations and calls belong to
 * the running session: a reset (new session, switch, shutdown) hides every
 * host tool and fails every call still waiting, so a client registers again
 * in the next session.
 */
export class DesktopHostToolsBridge {
	private readonly pi: ExtensionAPI;
	private readonly timers: DesktopHostToolsTimers;
	private readonly callTimeoutMs: number;
	private readonly newCallId: () => string;
	private emit: DesktopHostToolsEmit | undefined;
	/** Active host tools by name. */
	private readonly tools = new Map<string, { provider: string; spec: HostToolSpec }>();
	/** Every name this bridge registered with Pi, active or hidden: never a collision for a later host. */
	private readonly owned = new Set<string>();
	private readonly calls = new Map<string, PendingCall>();
	private readonly settled: string[] = [];
	private readonly contexts = new Map<string, HostContext>();
	private isIdle: () => boolean = () => true;

	constructor(pi: ExtensionAPI, options: DesktopHostToolsOptions = {}) {
		this.pi = pi;
		this.timers = options.timers ?? realTimers;
		this.callTimeoutMs = options.callTimeoutMs ?? DESKTOP_HOST_TOOLS_LIMITS.callTimeoutMs;
		this.newCallId = options.newCallId ?? (() => `htc_${randomBytes(12).toString("hex")}`);
	}

	/** Events go out through the Desktop router while the session's transport is up. */
	wire(emit: DesktopHostToolsEmit): void {
		this.emit = emit;
	}

	/** Whether the agent is idle, read from the dispatching command's context when `host_message` says `auto`. */
	attach(ctx: { isIdle(): boolean }): void {
		this.isIdle = () => ctx.isIdle();
	}

	reset(): void {
		this.emit = undefined;
		this.isIdle = () => true;
		for (const [callId, call] of [...this.calls]) call.finish(errorResult(call.provider, `${call.tool} was stopped: the session ended before ${call.provider} answered.`, callId));
		for (const name of [...this.tools.keys()]) this.hide(name);
		this.tools.clear();
		for (const provider of [...this.contexts.keys()]) this.clearContext(provider);
	}

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | undefined {
		if (method === "set_host_tools") return this.setHostTools(params);
		if (method === "host_message") return this.message(params);
		if (method === "set_host_context") return this.setContext(params);
		if (method === "host_tool_result") return this.answer(params);
		return undefined;
	}

	private setHostTools(params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseSetHostTools(params);
		if (parsed.ok === false) return { ok: false, error: parsed.error };
		const { provider, tools } = parsed.value;
		if (typeof this.pi.registerTool !== "function" || typeof this.pi.getAllTools !== "function") return { ok: false, error: HOST_TOOLS_UNAVAILABLE };
		try {
			const taken = new Set(this.pi.getAllTools().map((tool) => tool.name).filter((name) => !this.owned.has(name)));
			const registered: string[] = [];
			const rejected: Array<{ name: string; reason: string }> = [];
			const accepted: HostToolSpec[] = [];
			for (const spec of tools) {
				const holder = this.tools.get(spec.name);
				if (taken.has(spec.name)) rejected.push({ name: spec.name, reason: "A built-in or extension tool already has this name" });
				else if (holder && holder.provider !== provider) rejected.push({ name: spec.name, reason: `${holder.provider} already provides a host tool with this name` });
				else accepted.push(spec);
			}
			const keep = new Set(accepted.map((spec) => spec.name));
			for (const [name, entry] of [...this.tools]) {
				if (entry.provider !== provider || keep.has(name)) continue;
				this.tools.delete(name);
				this.hide(name);
			}
			for (const spec of accepted) {
				this.register(provider, spec);
				registered.push(spec.name);
			}
			return { ok: true, data: { registered, rejected } };
		} catch {
			return { ok: false, error: HOST_TOOLS_UNAVAILABLE };
		}
	}

	private register(provider: string, spec: HostToolSpec): void {
		const guidelines = modelGuidelines(spec);
		this.owned.add(spec.name);
		this.tools.set(spec.name, { provider, spec });
		this.pi.registerTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			promptSnippet: promptSnippet(spec),
			...(guidelines.length === 0 ? {} : { promptGuidelines: guidelines }),
			// A client's JSON Schema, not a TypeBox value: Pi validates arguments with a JSON Schema compiler.
			parameters: spec.parameters as never,
			exposure: "direct",
			execute: (_toolCallId, args, signal) => this.call(spec.name, args as Record<string, unknown>, signal),
		});
	}

	private hide(name: string): void {
		try {
			this.pi.registerTool({
				name,
				label: name,
				description: `${name} is not provided right now.`,
				parameters: HIDDEN_PARAMETERS as never,
				exposure: "hidden",
				execute: async () => errorResult("none", `${name} is not provided right now.`),
			});
		} catch {
			// A torn-down extension instance cannot register; its tools went with its session.
		}
	}

	private call(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<HostToolCallResult> {
		const entry = this.tools.get(name);
		if (!entry) return Promise.resolve(errorResult("none", `${name} is not provided right now.`));
		const { provider } = entry;
		const emit = this.emit;
		if (!emit) return Promise.resolve(errorResult(provider, hostToolOfflineText(name, provider)));
		if (signal?.aborted) return Promise.resolve(errorResult(provider, `${name} was cancelled.`));
		const callId = this.newCallId();
		const { promise, resolve } = Promise.withResolvers<HostToolCallResult>();
		let timer: unknown;
		const onAbort = () => {
			finish(errorResult(provider, `${name} was cancelled.`, callId));
			this.cancel(callId);
		};
		const finish = (result: HostToolCallResult) => {
			if (!this.calls.delete(callId)) return;
			this.timers.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			this.settled.push(callId);
			if (this.settled.length > DESKTOP_HOST_TOOLS_LIMITS.settledMemory) this.settled.shift();
			resolve(result);
		};
		this.calls.set(callId, { provider, tool: name, finish });
		timer = this.timers.setTimeout(() => {
			finish(errorResult(provider, `${name} got no answer from ${provider} within ${Math.round(this.callTimeoutMs / 60_000)} minutes.`, callId));
			this.cancel(callId);
		}, this.callTimeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			emit("host_tool_call", { callId, provider, tool: name, args });
		} catch {
			finish(errorResult(provider, hostToolOfflineText(name, provider), callId));
		}
		return promise;
	}

	private cancel(callId: string): void {
		try {
			this.emit?.("host_tool_cancel", { callId });
		} catch {
			/* the call is already settled; a lost cancel only leaves the client working */
		}
	}

	private answer(params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseHostToolResult(params);
		if (parsed.ok === false) return { ok: false, error: parsed.error };
		const { callId, content, isError, details } = parsed.value;
		const call = this.calls.get(callId);
		if (!call) return { ok: false, error: this.settled.includes(callId) ? ALREADY_ANSWERED : UNKNOWN_CALL };
		call.finish({ content, details: details ?? { provider: call.provider, callId }, ...(isError ? { isError: true } : {}) });
		return { ok: true, data: { accepted: true } };
	}

	/**
	 * `auto` is what a client wants almost always: start a run when the agent is
	 * idle (unless `triggerTurn` is false), steer the running one otherwise. The
	 * other modes are Pi's own `deliverAs`, with `triggerTurn` passed as given.
	 */
	private message(params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseHostMessage(params);
		if (parsed.ok === false) return { ok: false, error: parsed.error };
		const { customType, content, display, details, deliver, triggerTurn } = parsed.value;
		if (typeof this.pi.sendMessage !== "function") return { ok: false, error: HOST_MESSAGES_UNAVAILABLE };
		const options = deliver === "auto"
			? (this.isIdle() ? { triggerTurn: triggerTurn ?? true } : { deliverAs: "steer" as const })
			: { deliverAs: deliver, ...(triggerTurn === undefined ? {} : { triggerTurn }) };
		try {
			this.pi.sendMessage({ customType, content, display, ...(details === undefined ? {} : { details }) }, options);
		} catch {
			return { ok: false, error: HOST_MESSAGES_UNAVAILABLE };
		}
		return { ok: true, data: { delivered: true } };
	}

	private setContext(params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseSetHostContext(params);
		if (parsed.ok === false) return { ok: false, error: parsed.error };
		const { provider, content, details } = parsed.value;
		if (content.length === 0) {
			this.clearContext(provider);
			return { ok: true, data: { set: true } };
		}
		const current = this.contexts.get(provider);
		if (current) {
			this.contexts.set(provider, { content, ...(details === undefined ? {} : { details }), off: current.off });
			return { ok: true, data: { set: true } };
		}
		if (this.contexts.size >= DESKTOP_HOST_TOOLS_LIMITS.contextProviders) return { ok: false, error: TOO_MANY_CONTEXTS };
		if (typeof this.pi.on !== "function") return { ok: false, error: HOST_MESSAGES_UNAVAILABLE };
		const customType = hostContextType(provider);
		let off: unknown;
		try {
			// One handler per provider: a `before_agent_start` result carries one message.
			off = this.pi.on("before_agent_start", () => {
				const entry = this.contexts.get(provider);
				if (!entry) return undefined;
				return { message: { customType, content: entry.content, display: false, ...(entry.details === undefined ? {} : { details: entry.details }) } };
			});
		} catch {
			return { ok: false, error: HOST_MESSAGES_UNAVAILABLE };
		}
		this.contexts.set(provider, { content, ...(details === undefined ? {} : { details }), off: typeof off === "function" ? (off as () => void) : () => {} });
		return { ok: true, data: { set: true } };
	}

	private clearContext(provider: string): void {
		const entry = this.contexts.get(provider);
		if (!entry) return;
		this.contexts.delete(provider);
		try {
			entry.off();
		} catch {
			// A torn-down extension instance took its handlers with it.
		}
	}
}
