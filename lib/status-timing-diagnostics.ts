import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const MAX_STATUSES = 8;
const MAX_ACTIVE_OBSERVATIONS = 8;
type Outcome = { kind: "success" | "cli_error" | "native_failure" | "unknown"; code?: string; phase?: string; mutation_outcome?: string; retry_safe?: boolean; next_action?: string };
interface StatusSample {
	timeout_ms: number;
	total_ms: number;
	resolution_ms: number;
	adapter_ms: number;
	decode_ms: number;
	outcome: Outcome;
}
interface Summary {
	schema: "gentle-pi.status-timing/v1";
	host_total_ms: number;
	dispatch_ms: number;
	sidebar_ms: number;
	completion_ms: number;
	truncated: boolean;
	clock_unavailable?: true;
	statuses: StatusSample[];
}
interface HostObservation {
	clock: () => number;
	current: () => boolean;
	claim: () => boolean;
	claimed: boolean;
	started: number;
	lastNativeEnd: number;
	summary: Summary;
}
interface NativeObservation { host: HostObservation; sample: StatusSample; }
const hostScope = new AsyncLocalStorage<HostObservation>();
const nativeScope = new AsyncLocalStorage<NativeObservation>();

// Observer failures must never replace the operation's result or exception.
function safely<T>(run: () => T): T | undefined {
	try { return run(); } catch { return undefined; }
}
function now(host: HostObservation): number {
	const value = safely(host.clock);
	if (value !== undefined && Number.isFinite(value) && value >= 0) return value;
	host.summary.clock_unavailable = true;
	return 0;
}
function elapsed(start: number, end: number): number { return Math.max(0, end - start); }

// Failure/v2 codes and next_action are extensible strings, not safe diagnostic
// text. Only recognized values enter this summary; no messages or raw envelopes.
const CLI_CODES = new Set(["unavailable", "timeout", "non-zero", "signal", "unexpected-stderr", "output-limit", "empty-output", "malformed-json", "schema-incompatible", "identity-mismatch", "version-incompatible", "cancelled", "package-local-binary-missing", "unsupported-transition-operation"]);
const NATIVE_CODES = new Set(["operation_timeout", "invalid_request", "binding_revision_conflict", "internal_error", "cancelled"]);
function outcome(error: unknown): Outcome {
	return safely((): Outcome => {
		if (typeof error !== "object" || error === null) return { kind: "unknown" };
		const value = error as { name?: unknown; code?: unknown; failureEnvelope?: Record<string, unknown> };
		if (value.name === "NativeReviewCliError") return { kind: "cli_error", code: typeof value.code === "string" && CLI_CODES.has(value.code) ? value.code : "other" };
		if (value.name !== "NativeReviewIntegrationError" || !value.failureEnvelope) return { kind: "unknown" };
		const failure = value.failureEnvelope;
		const result: Outcome = { kind: "native_failure", code: typeof failure.code === "string" && NATIVE_CODES.has(failure.code) ? failure.code : "other" };
		if (["preflight", "pre_native", "native_running", "native_committed", "reconciliation"].includes(String(failure.phase))) result.phase = String(failure.phase);
		if (["not_started", "committed", "unknown"].includes(String(failure.mutationOutcome))) result.mutation_outcome = String(failure.mutationOutcome);
		if (typeof failure.retrySafe === "boolean") result.retry_safe = failure.retrySafe;
		if (["stop", "review.status"].includes(String(failure.nextAction))) result.next_action = String(failure.nextAction);
		return result;
	}) ?? { kind: "unknown" };
}

/** The next already-authorized STATUS-bearing tool call consumes the arm. */
export class StatusTimingDiagnostics {
	private armed = false;
	private epoch = 0;
	private manager: ExtensionContext["sessionManager"] | undefined;
	private session: string | undefined;
	private last: Summary | undefined;
	private readonly active = new Set<HostObservation>();
	private readonly clock: () => number;
	constructor(clock = () => performance.now()) { this.clock = clock; }

	reset(ctx?: ExtensionContext): void {
		this.epoch++;
		this.armed = false;
		this.last = undefined;
		for (const host of this.active) host.summary.statuses.length = 0;
		this.active.clear();
		this.manager = ctx?.sessionManager;
		this.session = safely(() => ctx?.sessionManager.getSessionId());
	}
	private matches(ctx: ExtensionContext): boolean {
		return safely(() => this.manager === ctx.sessionManager && !!this.session && this.session === ctx.sessionManager.getSessionId()) === true;
	}
	command(args: string, ctx: ExtensionContext): void {
		if (!this.matches(ctx)) this.reset(ctx);
		const action = args.trim() || "show";
		if (action === "enable") {
			this.reset(ctx);
			this.armed = !!this.session;
			ctx.ui.notify(this.armed
				? "STATUS timing armed for the next separately authorized STATUS-bearing tool call. No STATUS is invoked or retried. Use /gentle:status-timing show to consult the completed summary."
				: "STATUS timing requires a live session.", "info");
		} else if (action === "disable") {
			this.reset(ctx);
			ctx.ui.notify("STATUS timing disabled; in-memory observations cleared.", "info");
		} else if (action === "show") {
			ctx.ui.notify(this.last ? JSON.stringify(this.last, null, 2) : `No completed STATUS timing summary. Diagnostic is ${this.armed ? "armed" : "off"}.`, "info");
		} else {
			ctx.ui.notify("Unknown /gentle:status-timing sub-action. Use enable, disable, or show.", "warning");
		}
	}
	tool<TParams extends TSchema, TDetails>(definition: ToolDefinition<TParams, TDetails>): ToolDefinition<TParams, TDetails> {
		return {
			...definition,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				const run = () => definition.execute(toolCallId, params, signal, onUpdate, ctx);
				if (!this.matches(ctx)) this.reset(ctx);
				if (!this.armed || this.active.size >= MAX_ACTIVE_OBSERVATIONS) return run();
				const epoch = this.epoch;
				const host: HostObservation = {
					clock: this.clock,
					current: () => this.epoch === epoch && this.matches(ctx),
					claim: () => {
						if (!host.current() || !this.armed) return false;
						this.armed = false;
						return true;
					},
					claimed: false, started: 0, lastNativeEnd: 0,
					summary: { schema: "gentle-pi.status-timing/v1", host_total_ms: 0, dispatch_ms: 0, sidebar_ms: 0, completion_ms: 0, truncated: false, statuses: [] },
				};
				this.active.add(host);
				host.started = now(host);
				return hostScope.run(host, async () => {
					try { return await run(); }
					finally {
						this.active.delete(host);
						safely(() => {
							if (!host.claimed || !host.current()) return;
							const ended = now(host);
							host.summary.host_total_ms = elapsed(host.started, ended);
							host.summary.completion_ms = elapsed(host.lastNativeEnd, ended);
							this.last = host.summary;
						});
					}
				});
			},
		};
	}
}

/** Only called by the existing STATUS entry points; never invokes one itself. */
export async function observeNativeStatus<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const host = hostScope.getStore();
	if (!host || !safely(host.current)) return run();
	if (!host.claimed) {
		if (!safely(host.claim)) return run();
		host.claimed = true;
		host.summary.dispatch_ms = elapsed(host.started, now(host));
	}
	const sample: StatusSample = { timeout_ms: timeoutMs, total_ms: 0, resolution_ms: 0, adapter_ms: 0, decode_ms: 0, outcome: { kind: "success" } };
	if (host.summary.statuses.length < MAX_STATUSES) host.summary.statuses.push(sample);
	else host.summary.truncated = true;
	const started = now(host);
	return nativeScope.run({ host, sample }, async () => {
		try { return await run(); }
		catch (error) { safely(() => { sample.outcome = outcome(error); }); throw error; }
		finally {
			safely(() => {
				const ended = now(host);
				sample.total_ms = elapsed(started, ended);
				host.lastNativeEnd = ended;
			});
		}
	});
}

function activeNative(): NativeObservation | undefined {
	const observation = nativeScope.getStore();
	return observation && safely(observation.host.current) ? observation : undefined;
}
export function measureStatusSync<T>(stage: "resolution" | "decode", run: () => T): T {
	const observation = activeNative();
	if (!observation) return run();
	const started = now(observation.host);
	try { return run(); }
	finally { safely(() => { observation.sample[`${stage}_ms`] += elapsed(started, now(observation.host)); }); }
}
export async function measureStatusAsync<T>(stage: "adapter", run: () => Promise<T>): Promise<T> {
	const observation = activeNative();
	if (!observation) return run();
	const started = now(observation.host);
	try { return await run(); }
	finally { safely(() => { observation.sample[`${stage}_ms`] += elapsed(started, now(observation.host)); }); }
}
export function measureStatusSidebar<T>(run: () => T): T {
	const host = hostScope.getStore();
	if (!host || !safely(host.current)) return run();
	const started = now(host);
	try { return run(); }
	finally { safely(() => { host.summary.sidebar_ms += elapsed(started, now(host)); }); }
}
