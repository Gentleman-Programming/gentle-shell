import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EFFORTS, ORCHESTRATOR_AGENT_CLASS, RuntimeMetrics, UNKNOWN_AGENT_CLASS, type FinalResponse, type TokenMeasurement } from "../lib/runtime-metrics.ts";
import { CHILD_METRICS_EVENT, CHILD_METRICS_REVOKED, snapshotChildEvent, type ChildLaunchBucket } from "../lib/runtime-metrics-children.ts";
import { RuntimeMetricsAttempt } from "../lib/runtime-metrics-delivery.ts";
import { sendNativeRuntimeEvent, type NativeRuntimeTransportDeps } from "../lib/runtime-metrics-native.ts";
import { runtimeMetricsEnvAllows } from "../lib/runtime-metrics-policy.ts";

/** Available final usage -> one deferred attempt -> discard. No history reads,
 * cumulative session accounting, policy leases, delivery queue or retry. Print
 * mode alone joins its accepted attempt for at most 1.5 seconds at shutdown.
 * Pi hooks lack request correlation: latency and SDK-zero presence are unknown.
 */
export default function runtimeMetrics(pi: ExtensionAPI, env = process.env,
	{ native, send = sendNativeRuntimeEvent, now = () => performance.now(), shutdownWaitMs = 1500 }:
	{ native?: NativeRuntimeTransportDeps; send?: typeof sendNativeRuntimeEvent; now?: () => number; shutdownWaitMs?: number } = {}): void {
	const allows = () => env.GENTLE_PI_AGENTS_CHILD !== "1" && runtimeMetricsEnvAllows(env);
	if (!allows()) return;
	type Selection = Pick<FinalResponse, "selectedModelId" | "selectedProvider" | "effort">;
	let selection: Selection | undefined;
	let active = false;
	let requestSeen = false;
	let ambiguous = false;
	let live: { id: string; started: number; ctx: ExtensionContext; attempt: RuntimeMetricsAttempt;
		seen: WeakSet<object>; children: Set<string> } | undefined;
	const missing = { state: "unavailable" } as const;
	function invalidate() { selection = undefined; ambiguous = true; }
	function dispose() { live?.attempt.dispose(); live = undefined; active = false; invalidate(); }
	function current(ctx: ExtensionContext) {
		if (!allows() || live?.id !== ctx.sessionManager.getSessionId()) dispose();
		return live;
	}
	function submit(owner: NonNullable<typeof live>, responses: FinalResponse[], launches?: ChildLaunchBucket[]) {
		if (!responses.length || live !== owner || !current(owner.ctx)) return;
		// Ephemeral event-local accounting only; source IDs never enter these rows.
		const metrics = new RuntimeMetrics();
		for (const [index, row] of responses.entries()) metrics.record({ ...row, responseId: String(index) });
		const rows = metrics.snapshot();
		if (!rows.length) return;
		const cwd = owner.ctx.cwd;
		owner.attempt.offer(async signal => {
			if (live !== owner || !current(owner.ctx) || signal.aborted) return;
			await send(rows, cwd, { ...native, launches, env, signal,
				current: () => live === owner && current(owner.ctx) === owner });
		});
	}
	const offChild = pi.events.on(CHILD_METRICS_EVENT, value => {
		try {
			const owner = live && current(live.ctx);
			const event = snapshotChildEvent(value);
			if (!owner || !event || event.parentSessionId !== owner.id || event.launchedAt < owner.started
				|| owner.children.has(event.taskId) || owner.children.size >= 256) return;
			owner.children.add(event.taskId); // Busy/failed completions stay consumed.
			submit(owner, event.responses, [{ ...event.launch, evidence: "launch_configuration", launches: 1 }]);
		} catch { /* No telemetry error enters the shared event bus. */ }
	});
	const offRevoke = pi.events.on(CHILD_METRICS_REVOKED, id => {
		if (live?.id === id) {
			live.attempt.dispose();
			live.attempt = new RuntimeMetricsAttempt();
			invalidate();
		}
	});
	pi.on("session_start", (_event, ctx) => {
		dispose();
		if (!allows()) return;
		live = { id: ctx.sessionManager.getSessionId(), started: now(), ctx,
			attempt: new RuntimeMetricsAttempt(), seen: new WeakSet<object>(), children: new Set<string>() };
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const teardown = () => { dispose(); offChild(); offRevoke(); };
		const owner = live;
		if (ctx.mode !== "print" || !owner) { teardown(); return; }
		return owner.attempt.waitForSettled(shutdownWaitMs).finally(teardown);
	});
	pi.on("turn_start", () => { ambiguous = active; active = true; requestSeen = false; selection = undefined; });
	pi.on("turn_end", () => { active = false; invalidate(); });
	pi.on("agent_end", () => { active = false; invalidate(); });
	pi.on("session_before_compact", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("before_provider_request", (_event, ctx) => {
		const owner = current(ctx);
		if (!owner) return;
		if (requestSeen) invalidate();
		requestSeen = true;
		if (!active || ambiguous) return;
		let effort: FinalResponse["effort"] = "unavailable";
		try { const value = pi.getThinkingLevel(); if (EFFORTS.includes(value)) effort = value; } catch { /* No evidence. */ }
		// No catalog gate: the selection is taken as-is (bounded to 128 chars) and
		// the schema-driven normalizer decides what actually leaves the machine.
		selection = { selectedProvider: typeof ctx.model?.provider === "string" && ctx.model.provider.length <= 128 ? ctx.model.provider : undefined,
			selectedModelId: typeof ctx.model?.id === "string" && ctx.model.id.length <= 128 ? ctx.model.id : undefined, effort };
	});
	function token(value: unknown): TokenMeasurement {
		return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000
			? { state: "reported", value } : missing;
	}
	pi.on("message_end", (event, ctx) => {
		try {
			const owner = current(ctx);
			const message = event.message;
			if (!owner || message.role !== "assistant" || message.stopReason === "pending" || message.stopReason === "deferred"
				|| owner.seen.has(message)) return;
			owner.seen.add(message);
			const selected = active && !ambiguous ? selection : undefined;
			submit(owner, [{ kind: "final_assistant_response", responseId: "0",
				selectedProvider: selected?.selectedProvider ?? "unknown", selectedModelId: selected?.selectedModelId,
				effort: selected?.effort ?? "unavailable",
				executor: env.GENTLE_PI_AGENTS_CHILD === undefined ? "orchestrator" : "unknown",
				agentClass: env.GENTLE_PI_AGENTS_CHILD === undefined ? ORCHESTRATOR_AGENT_CLASS : UNKNOWN_AGENT_CLASS,
				observedModelId: message.model, responseModelId: message.responseModel,
				providerThinkingLevel: EFFORTS.includes(message.providerThinkingLevel as FinalResponse["effort"])
					? message.providerThinkingLevel as FinalResponse["effort"] : "unavailable",
				provider: message.provider as FinalResponse["provider"], modelFamily: "unknown",
				error: message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "unknown" : "none",
				tokens: { input: token(message.usage?.input), output: token(message.usage?.output), cacheRead: token(message.usage?.cacheRead),
					cacheWrite: token(message.usage?.cacheWrite), reasoning: token(message.usage?.reasoning), totalTokens: token(message.usage?.totalTokens) },
				responseHeadersMs: missing, fullResponseMs: missing }]);
			invalidate();
		} catch { /* Provider hooks never expose telemetry failures. */ }
	});
}
