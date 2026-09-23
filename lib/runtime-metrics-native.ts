import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import { runtimeMetricsEnvAllows } from "./runtime-metrics-policy.ts";
import { isPublicRuntimeModelId, normalizeRuntimeModel, type RuntimeMetricBucket } from "./runtime-metrics.ts";
import type { ChildLaunchBucket } from "./runtime-metrics-children.ts";

import schema from "../contracts/telemetry/runtime-aggregate-v1.schema.json" with { type: "json" };

export type NativeRuntimeResult = "stored" | "duplicate" | "discarded" | "disabled";
export const NATIVE_SEND_ACK_SCHEMA = "gentle-ai.telemetry-runtime-send/v1";
const MAX_METRIC = schema.$defs.count.maximum;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_METRIC;
// Re-derives through the same schema-driven normalizer used at record time so
// an already-classified (provider, id) pair is re-validated against the
// transport's anyOf shape before it ever leaves the machine.
function publicModel(provider: string, id: string) {
	return normalizeRuntimeModel(provider, id);
}

/** Closed field projection of one event, not a session snapshot. Oversized or
 * invalid events discard whole; never split into queued sends or invent IDs.
 */
export function encodeNativeRuntimeEvent(source: readonly RuntimeMetricBucket[], launches: readonly ChildLaunchBucket[] = []): string | undefined {
	if (!Array.isArray(source) || !Array.isArray(launches) || source.length < 1
		|| source.length + launches.length > schema.properties.rows.maxItems) return undefined;
	try {
		const rows: Array<Record<string, unknown>> = source.map(row => {
			if (!count(row.responses)) throw new Error("Invalid occurrence coverage");
			const token = (field: keyof RuntimeMetricBucket["tokens"]) => {
				const t = row.tokens[field];
				const coverage = { reported: t.reported, unavailable: t.unavailable, unsupported: t.unsupported, sum: t.sum };
				if (!Object.values(coverage).every(count) || (!coverage.reported && coverage.sum !== 0)) throw new Error("Invalid coverage");
				return coverage;
			};
			const agentClass = schema.$defs.row.properties.agent_class.enum.includes(row.agentClass) ? row.agentClass : "unknown";
			const effort = (value: string) => schema.$defs.effort.enum.includes(value) ? value : "unavailable";
			// Evidence order: an actually-dispatched response model wins; otherwise
			// the caller's own selection; otherwise the SDK-observed model the
			// selection never captured (still labeled "selected" evidence, since
			// the transport has no separate "observed" category). Never response
			// evidence unless the response model itself normalizes to a public id.
			const response = isPublicRuntimeModelId(row.responseModelId);
			const selected = !response && isPublicRuntimeModelId(row.selectedModelId);
			const observed = !response && !selected && isPublicRuntimeModelId(row.observedModelId);
			const model = response ? publicModel(row.provider, row.responseModelId)
				: selected ? publicModel(row.selectedProvider, row.selectedModelId)
				: observed ? publicModel(row.provider, row.observedModelId)
				: { provider: "unknown", id: "unknown" };
			const time = row.fullResponseMs;
			if (!count(time.measured) || !Number.isFinite(time.sum) || time.sum < 0 || time.sum > MAX_METRIC
				|| (!time.measured && time.sum !== 0)) throw new Error("Invalid duration");
			return { model, model_evidence: response ? "response" : (selected || observed) ? "selected" : "unknown",
				agent_kind: agentClass === "orchestrator" || agentClass === "unknown" ? agentClass : "built_in", agent_class: agentClass,
				selected_effort: effort(row.effort), effective_effort: effort(row.providerThinkingLevel),
				launches: null, responses: row.responses,
				input_tokens: token("input"), output_tokens: token("output"), cache_read_tokens: token("cacheRead"),
				cache_creation_tokens: token("cacheWrite"), reasoning_tokens: token("reasoning"), total_tokens: token("totalTokens"),
				error_category: row.error === "authentication" ? "auth" : ["none", "aborted", "rate_limit"].includes(row.error) ? row.error : "unknown",
				duration: time.measured > 0 ? { kind: "request", measured_count: time.measured, sum_ms: time.sum }
					: { kind: "unavailable", measured_count: 0, sum_ms: null } };
		});
		for (const launch of launches) {
			if (!count(launch.launches) || launch.evidence !== "launch_configuration") return undefined;
			const agentClass = schema.$defs.row.properties.agent_class.enum.includes(launch.agentClass) ? launch.agentClass : "unknown";
			const empty = { reported: 0, unavailable: 0, unsupported: 0, sum: 0 };
			rows.push({ model: publicModel(launch.selectedProvider, launch.selectedModelId), model_evidence: "selected",
				agent_kind: agentClass === "orchestrator" || agentClass === "unknown" ? agentClass : "built_in", agent_class: agentClass,
				selected_effort: schema.$defs.effort.enum.includes(launch.selectedEffort) ? launch.selectedEffort : "unavailable",
				effective_effort: "unavailable", launches: launch.launches, responses: null,
				input_tokens: empty, output_tokens: empty, cache_read_tokens: empty, cache_creation_tokens: empty,
				reasoning_tokens: empty, total_tokens: empty, error_category: "unknown",
				duration: { kind: "unavailable", measured_count: 0, sum_ms: null } });
		}
		const payload = JSON.stringify({ schema: schema.properties.schema.const, registry: schema.properties.registry.const, host: "pi", rows });
		return Buffer.byteLength(payload) <= 16384 ? payload : undefined;
	} catch { return undefined; }
}
export interface NativeRuntimeTransportDeps {
	/** Observed launch occurrence accompanying this child completion, not totals. */
	launches?: readonly ChildLaunchBucket[];
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	current?: () => boolean;
	/** Injected test seams; production uses the verified pin or validated dev override. */
	resolve?: () => string;
	encode?: typeof encodeNativeRuntimeEvent;
	spawn?: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}
let busy = false;

/** Native owns fresh policy and exactly one POST. No policy/capability probe,
 * disk intake, flush, queue or retry. Call via RuntimeMetricsAttempt so binary
 * verification is outside the provider callback. Cancellation requests a kill;
 * the slot stays occupied until close, never permitting overlapping processes.
 */
export async function sendNativeRuntimeEvent(rows: readonly RuntimeMetricBucket[], cwd: string,
	deps: NativeRuntimeTransportDeps = {}): Promise<NativeRuntimeResult> {
	const env = deps.env ?? process.env;
	if (!runtimeMetricsEnvAllows(env)) return "disabled";
	if (busy || deps.signal?.aborted || deps.current?.() === false) return "discarded";
	busy = true;
	try {
		const payload = (deps.encode ?? encodeNativeRuntimeEvent)(rows, deps.launches);
		if (!payload || Buffer.byteLength(payload) > 16384) return "discarded";
		const file = (deps.resolve ?? resolveGentleAiBinary)();
		if (!runtimeMetricsEnvAllows(env)) return "disabled";
		if (deps.signal?.aborted || deps.current?.() === false) return "discarded";
		return await sendProcess(file, cwd, payload, env, deps.spawn ?? spawn, deps.signal);
	} catch { return "discarded"; }
	finally { busy = false; }
}

function sendProcess(file: string, cwd: string, payload: string, env: NodeJS.ProcessEnv,
	launch: NonNullable<NativeRuntimeTransportDeps["spawn"]>, signal?: AbortSignal): Promise<NativeRuntimeResult> {
	return new Promise(done => {
		let child: ChildProcessWithoutNullStreams | undefined;
		let output = "";
		let rejected = false;
		let settled = false;
		const ignore = () => {};
		const finish = (result: NativeRuntimeResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			output = "";
			if (child) {
				for (const stream of [child.stdin, child.stdout, child.stderr]) {
					stream.on("error", ignore);
					try { stream.destroy(); } catch { /* Best effort cleanup. */ }
				}
				try { child.unref(); } catch { /* No diagnostics. */ }
			}
			done(result);
		};
		const cancel = () => {
			if (rejected || settled) return;
			rejected = true;
			output = "";
			try { child?.kill("SIGKILL"); } catch { /* Keep busy until close. */ }
		};
		const timer = setTimeout(cancel, 1000);
		timer.unref();
		try {
			child = launch(file, ["telemetry", "runtime", "send", "--json"],
				{ cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
			child.on("error", cancel);
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", cancel);
			child.stdout.on("data", (chunk: Buffer) => {
				if (rejected || settled) return;
				if (Buffer.byteLength(output) + chunk.length > 2048) { cancel(); return; }
				output += chunk.toString("utf8");
			});
			child.stderr.on("data", cancel); // Do not retain or expose raw errors.
			child.on("close", (code: number | null, exitSignal: NodeJS.Signals | null) => {
				let result: NativeRuntimeResult = "discarded";
				if (!rejected && code === 0 && exitSignal === null) {
					try {
						const value = JSON.parse(output);
						if (Object.keys(value).sort().join(",") === "decision,schema" && value.schema === NATIVE_SEND_ACK_SCHEMA
							&& ["stored", "duplicate", "discarded", "disabled"].includes(value.decision)) result = value.decision;
					} catch { /* Invalid/old acknowledgements discard. */ }
				}
				finish(result);
			});
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) cancel();
			if (!rejected) child.stdin.end(payload, "utf8");
		} catch {
			if (child) cancel();
			else finish("discarded");
		}
	});
}
