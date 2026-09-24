import { readFileSync, readdirSync } from "node:fs";
import { parseAgentDefinition, type AgentDefinition, type ModelRef } from "./agents-config.ts";
import type { ChildObservationSnapshot } from "./agents-runner.ts";
import { FINISHED_STATUSES, type TaskStatus } from "./agents-protocol.ts";
import { classifyRuntimeModelId, EFFORTS, normalizeRuntimeProvider, parseAgentClass, RuntimeMetrics, UNKNOWN_AGENT_CLASS, validRuntimeResponse, type AgentClass, type FinalResponse, type RuntimeMetricBucket } from "./runtime-metrics.ts";
export const CHILD_METRICS_EVENT = "gentle:runtime-metrics:child/v1";
// Local revocation notification invalidates active observations. Contains only
// the local session join, never policy output.
export const CHILD_METRICS_REVOKED = "gentle:runtime-metrics:revoked/v1";
const missing = { state: "unavailable" } as const;
const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
/** Recognize only names from this package's fixed assets and the transport's
 * closed agent_class enum. Customized packaged agents retain their schema name;
 * user-defined names never enter telemetry. Exact fingerprints preserve the
 * worker/explore/verify compatibility mapping whose packaged names are prefixed.
 * Model/thinking routing is excluded from fingerprints because installation
 * rewrites it. No installed files are read; this class is not execution/review authority.
 * Only the fixed package catalog is cached; runtime instructions are not retained.
 */
let definitions: Array<{ name: string; fingerprint: string; fingerprintClass?: AgentClass }> | undefined;
const packagedAgentClassAliases = new Map([["sdd-proposal", "sdd-propose"]] as const);
function fingerprintAgentClassName(name: string): string {
	const compatibilityName = name.startsWith("gentle-ai-") ? name.slice("gentle-ai-".length) : name;
	return packagedAgentClassAliases.get(compatibilityName) ?? compatibilityName;
}
function fingerprint(agent: AgentDefinition): string {
	return JSON.stringify([agent.name, agent.description, agent.instructions, agent.tools, agent.mode]);
}
export function classifyBuiltinAgent(agent: AgentDefinition): AgentClass {
	try {
		definitions ??= readdirSync(new URL("../assets/agents/", import.meta.url))
			.filter(file => file.endsWith(".md")).map(file => {
			const path = new URL(`../assets/agents/${file}`, import.meta.url);
			const parsed = parseAgentDefinition(readFileSync(path, "utf8"), path.pathname, "global");
			if (!("instructions" in parsed)) throw new Error("Invalid packaged definition");
			return { name: parsed.name, fingerprint: fingerprint(parsed),
				fingerprintClass: parseAgentClass(fingerprintAgentClassName(parsed.name)) };
		});
		const namedClass = parseAgentClass(packagedAgentClassAliases.get(agent.name) ?? agent.name);
		if (namedClass && definitions.some(entry => entry.name === agent.name)) return namedClass;
		return definitions.find(entry => entry.fingerprintClass && entry.fingerprint === fingerprint(agent))?.fingerprintClass ?? UNKNOWN_AGENT_CLASS;
	} catch { return UNKNOWN_AGENT_CLASS; }
}
function provider(value: unknown): FinalResponse["provider"] {
	return normalizeRuntimeProvider(value);
}
function modelId(namespace: unknown, value: unknown): string {
	if (value === "unknown" || value === undefined) return "unknown";
	return classifyRuntimeModelId(namespace, value);
}
function effort(value: unknown): FinalResponse["effort"] {
	return EFFORTS.includes(value as FinalResponse["effort"]) ? value as FinalResponse["effort"] : "unavailable";
}
export interface LaunchSelection {
	agentClass: AgentClass;
	selectedProvider: FinalResponse["provider"];
	selectedModelId: string;
	selectedEffort: FinalResponse["effort"];
}
export interface ChildLaunchBucket extends LaunchSelection {
	evidence: "launch_configuration";
	launches: number;
}
export function launchSelection(agent: AgentDefinition, model: ModelRef | undefined, thinking: unknown): LaunchSelection {
	return { agentClass: classifyBuiltinAgent(agent), selectedProvider: provider(model?.provider),
		selectedModelId: modelId(model?.provider, model?.id), selectedEffort: effort(thinking) };
}
/** LOCAL event only: these two bounded join IDs must never enter output/export. */
export interface ChildMetricsEvent {
	schema: typeof CHILD_METRICS_EVENT;
	parentSessionId: string;
	taskId: string;
	launchedAt: number;
	launch: LaunchSelection;
	status: TaskStatus;
	agentSettled: boolean;
	coverage: "final_assistant_messages_only";
	droppedResponses: number;
	responses: FinalResponse[];
}
export function childEvent(parentSessionId: string, taskId: string, launch: LaunchSelection, status: TaskStatus,
	snapshot: ChildObservationSnapshot, launchedAt = 0): ChildMetricsEvent | undefined {
	const result: ChildMetricsEvent = { schema: CHILD_METRICS_EVENT, parentSessionId, taskId, launchedAt, launch: { ...launch }, status,
		agentSettled: snapshot.agentSettled, coverage: snapshot.coverage, droppedResponses: snapshot.droppedResponses,
		responses: snapshot.responses.slice(0, 128).map((row, index) => {
			const namespace = row.provider.state === "observed" ? row.provider.value : undefined;
			const name = (value: typeof row.model) => value.state === "observed" ? modelId(namespace, value.value) : undefined;
			return { kind: "final_assistant_response", responseId: String(index), agentClass: launch.agentClass,
				executor: "worker", provider: provider(namespace), modelFamily: "unknown", observedModelId: name(row.model),
				responseModelId: name(row.responseModel), providerThinkingLevel: effort(row.providerThinkingLevel.state === "observed" ? row.providerThinkingLevel.value : undefined),
				selectedProvider: launch.selectedProvider, selectedModelId: launch.selectedModelId, effort: launch.selectedEffort,
				error: row.stopReason === "error" ? "unknown" : row.stopReason === "aborted" ? "aborted" : "none",
				tokens: Object.fromEntries(tokenFields.map(field => [field, { ...row.tokens[field] }])) as FinalResponse["tokens"],
				responseHeadersMs: missing, fullResponseMs: missing };
		}) };
	return validEvent(result) ? result : undefined;
}
function validEvent(value: unknown): value is ChildMetricsEvent {
	if (!value || typeof value !== "object") return false;
	const e = value as ChildMetricsEvent;
	const id = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
	const l = e.launch;
	return e.schema === CHILD_METRICS_EVENT && id(e.taskId) && id(e.parentSessionId)
		&& Number.isFinite(e.launchedAt) && e.launchedAt >= 0
		&& e.coverage === "final_assistant_messages_only" && typeof e.agentSettled === "boolean"
		&& FINISHED_STATUSES.includes(e.status) && Number.isSafeInteger(e.droppedResponses) && e.droppedResponses >= 0
		&& e.droppedResponses <= Number.MAX_SAFE_INTEGER && !!l && !!parseAgentClass(l.agentClass) && l.agentClass !== "orchestrator"
		&& provider(l.selectedProvider) === l.selectedProvider && modelId(l.selectedProvider, l.selectedModelId) === l.selectedModelId
		&& effort(l.selectedEffort) === l.selectedEffort && Array.isArray(e.responses) && e.responses.length <= 128
		&& e.responses.every(row => validRuntimeResponse(row) && row.agentClass === l.agentClass
			&& row.executor === "worker" && row.effort === l.selectedEffort && row.selectedProvider === l.selectedProvider && row.selectedModelId === l.selectedModelId
			&& provider(row.provider) === row.provider && effort(row.providerThinkingLevel) === row.providerThinkingLevel
			&& (row.observedModelId === undefined || modelId(row.provider, row.observedModelId) === row.observedModelId)
			&& (row.responseModelId === undefined || modelId(row.provider, row.responseModelId) === row.responseModelId)
			&& row.fullResponseMs.state === "unavailable" && row.responseHeadersMs.state === "unavailable");
}
/** Copy only validated local fields at the completion callback.
 * Do not clone arbitrary event properties or retain a caller-mutable bus object.
 */
export function snapshotChildEvent(value: unknown): ChildMetricsEvent | undefined {
	if (!validEvent(value)) return undefined;
	const l = value.launch;
	return { schema: CHILD_METRICS_EVENT, parentSessionId: value.parentSessionId, taskId: value.taskId, launchedAt: value.launchedAt,
		launch: { agentClass: l.agentClass, selectedProvider: l.selectedProvider, selectedModelId: l.selectedModelId, selectedEffort: l.selectedEffort },
		status: value.status, agentSettled: value.agentSettled, coverage: value.coverage, droppedResponses: value.droppedResponses,
		responses: value.responses.map((row, index) => ({ kind: "final_assistant_response", responseId: String(index),
			agentClass: row.agentClass, executor: "worker", provider: row.provider, observedModelId: row.observedModelId,
			responseModelId: row.responseModelId, providerThinkingLevel: row.providerThinkingLevel, modelFamily: "unknown",
			selectedProvider: l.selectedProvider, selectedModelId: l.selectedModelId, effort: l.selectedEffort, error: row.error,
			tokens: Object.fromEntries(tokenFields.map(field => {
				const t = row.tokens[field];
				return [field, t?.state === "reported" ? { state: "reported", value: t.value } : { state: t?.state ?? "unavailable" }];
			})) as FinalResponse["tokens"], responseHeadersMs: missing, fullResponseMs: missing })) };
}

/** Export-facing shape: no IDs, paths, task labels, or raw agent/model names.
 * Rankings are descending counts, NOT quality/success comparisons. Native
 * transport is deliberately absent. Response buckets retain selected launch
 * identity and effort separately from effective response evidence.
 */
export interface ChildCompositionSnapshot {
	launches: ChildLaunchBucket[];
	responses: RuntimeMetricBucket[];
	settled: number;
	statuses: Record<"completed" | "failed" | "cancelled" | "timed_out", number>;
	droppedResponses: number;
	saturated: boolean;
}
export class ChildComposition {
	#seen = new Set<string>();
	#pending = new WeakSet<object>();
	#metrics = new RuntimeMetrics();
	#launches = new Map<string, ChildLaunchBucket>();
	#count = 0;
	#settled = 0;
	#statuses = { completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
	#dropped = 0;
	#saturated = false;
	reserve(value: unknown, session: string): value is ChildMetricsEvent {
		if (!validEvent(value) || value.parentSessionId !== session || this.#seen.has(value.taskId)) return false;
		if (this.#seen.size >= 256) { this.#saturated = true; return false; }
		this.#seen.add(value.taskId);
		this.#pending.add(value);
		return true;
	}
	record(event: ChildMetricsEvent): void {
		if (!this.#pending.delete(event) || !validEvent(event)) return;
		const key = JSON.stringify(event.launch);
		let bucket = this.#launches.get(key);
		if (!bucket && this.#launches.size < 64) {
			bucket = { ...event.launch, evidence: "launch_configuration", launches: 0 };
			this.#launches.set(key, bucket);
		}
		if (bucket) bucket.launches++;
		else this.#saturated = true;
		this.#settled += Number(event.agentSettled);
		this.#statuses[event.status as keyof ChildCompositionSnapshot["statuses"]]++;
		this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + event.droppedResponses);
		for (const row of event.responses) {
			if (this.#metrics.record({ ...row, responseId: String(this.#count + 1) }) === "recorded") this.#count++;
			else { this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1); this.#saturated = true; }
		}
	}
	clear(): void {
		this.#metrics = new RuntimeMetrics();
		this.#pending = new WeakSet();
		this.#launches.clear();
		this.#count = this.#settled = this.#dropped = 0;
		this.#statuses = { completed: 0, failed: 0, cancelled: 0, timed_out: 0 };
		// Bounded tombstones survive revocation; denied tasks cannot replay.
	}
	snapshot(): ChildCompositionSnapshot {
		return structuredClone({ launches: [...this.#launches.values()].sort((a, b) => b.launches - a.launches),
			responses: this.#metrics.snapshot().sort((a, b) => b.responses - a.responses),
			settled: this.#settled, statuses: this.#statuses, droppedResponses: this.#dropped, saturated: this.#saturated });
	}
}
