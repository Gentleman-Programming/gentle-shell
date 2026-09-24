import { readFileSync } from "node:fs";

const runtimeSchema = JSON.parse(readFileSync(new URL("../contracts/telemetry/runtime-aggregate-v1.schema.json", import.meta.url), "utf8"));

// Pure local accounting, not a telemetry transport or Pi event adapter.
// Callers supply finalized assistant responses and authoritative classifications.
// Never infer executor, usage availability, or measured timings from SDK defaults.
const EXECUTORS = ["orchestrator", "worker", "reviewer", "unknown"] as const;
// Stable families, not model IDs/versions: new models need no catalog update.
// Callers map known native metadata to families; private aliases stay custom.
const FAMILIES = ["claude", "gpt", "o-series", "gemini", "llama", "qwen", "deepseek", "kimi", "custom", "unknown"] as const;
// Pi 0.85.1 docs/models.md, Thinking Level Map. These are selected Pi levels,
// not inferred provider effort or a claim that each model supports every level.
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "not_selected", "unsupported", "unavailable"] as const;
const ERRORS = ["none", "aborted", "rate_limit", "authentication", "network", "provider", "unknown"] as const;
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
declare const agentClassBrand: unique symbol;
export type AgentClass = string & { readonly [agentClassBrand]: "AgentClass" };

function agentClasses(): readonly AgentClass[] {
	const values: unknown = runtimeSchema?.$defs?.row?.properties?.agent_class?.enum;
	if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== "string")) {
		throw new Error("Invalid runtime telemetry agent_class schema");
	}
	return Object.freeze([...values]) as readonly AgentClass[];
}

// The mirrored transport contract is the runtime source of truth. Keeping this
// data-driven lets packaged agent updates follow the closed enum without a
// second name registry drifting in TypeScript.
export const AGENT_CLASSES = agentClasses();
export function parseAgentClass(value: unknown): AgentClass | undefined {
	return typeof value === "string" && (AGENT_CLASSES as readonly string[]).includes(value) ? value as AgentClass : undefined;
}
function requiredAgentClass(value: string): AgentClass {
	const parsed = parseAgentClass(value);
	if (!parsed) throw new Error(`Runtime telemetry schema is missing required agent_class ${value}`);
	return parsed;
}
export const UNKNOWN_AGENT_CLASS = requiredAgentClass("unknown");
export const ORCHESTRATOR_AGENT_CLASS = requiredAgentClass("orchestrator");

interface ModelFieldRule { pattern: RegExp; maxLength: number }

function modelFieldRule(field: "provider" | "id"): ModelFieldRule {
	// The length cap lives on $defs.model.properties.<field>; the shape pattern
	// lives only on the first (public-pattern) branch of $defs.model.anyOf, next
	// to the unknown/custom/opencode sentinel branches. Both are mirrored,
	// byte-for-byte, from the Gentle AI transport schema.
	const property: unknown = runtimeSchema?.$defs?.model?.properties?.[field];
	if (!object(property) || typeof property.maxLength !== "number") {
		throw new Error(`Invalid runtime telemetry model ${field} schema`);
	}
	const branches: unknown = runtimeSchema?.$defs?.model?.anyOf;
	const patternProperty = Array.isArray(branches) && object(branches[0]) && object(branches[0].properties)
		? branches[0].properties[field] : undefined;
	if (!object(patternProperty) || typeof patternProperty.pattern !== "string") {
		throw new Error(`Invalid runtime telemetry model ${field} schema`);
	}
	return { pattern: new RegExp(patternProperty.pattern), maxLength: property.maxLength };
}

// Schema-driven, not a hardcoded TypeScript regex: the mirrored transport
// contract owns the open family-pattern rules for provider/id shape. A
// companion Gentle AI change keeps the Go side on the same patterns.
const MODEL_PROVIDER_RULE = modelFieldRule("provider");
const MODEL_ID_RULE = modelFieldRule("id");

/** Provider-only normalization, independent of any specific model id: trims,
 * lowercases, and keeps the slug only when it matches the schema provider
 * pattern within its maxLength. Non-string/empty input is "unknown"; a
 * non-conforming non-empty string is "custom". Shared by the standalone
 * provider dimension and by normalizeRuntimeModel's own provider handling.
 */
export function normalizeRuntimeProvider(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const trimmed = value.trim();
	if (!trimmed) return "unknown";
	const lower = trimmed.toLowerCase();
	return lower.length <= MODEL_PROVIDER_RULE.maxLength && MODEL_PROVIDER_RULE.pattern.test(lower) ? lower : "custom";
}

/** Generic, schema-driven family-pattern normalizer for a (provider, id)
 * selection or response pair (gentle-pi#968 / gentle-ai#4536). Open-weight
 * models on arbitrary providers are reported by name; private aliases and
 * fine-tunes stay custom. Rules, identical to the mirrored Go/schema side:
 *  - a non-string or empty provider or id fails closed to unknown/unknown;
 *  - id: trim, keep the LAST "/"-separated segment, lowercase; public only
 *    when it matches the schema id pattern within its maxLength, otherwise
 *    "custom";
 *  - provider: trim, lowercase; kept when it matches the schema provider
 *    pattern, otherwise "custom";
 *  - when the id is not public the provider becomes "custom" too, except
 *    "opencode", which stays opencode/custom;
 *  - the literal unknown/unknown and custom/custom pairs pass through.
 */
export function normalizeRuntimeModel(provider: unknown, id: unknown): { provider: string; id: string } {
	if (typeof provider !== "string" || typeof id !== "string") return { provider: "unknown", id: "unknown" };
	const providerTrimmed = provider.trim();
	const idTrimmed = id.trim();
	if (!providerTrimmed || !idTrimmed) return { provider: "unknown", id: "unknown" };
	const providerLower = providerTrimmed.toLowerCase();
	const idSegment = idTrimmed.split("/").pop() ?? "";
	const idLower = idSegment.toLowerCase();
	if (providerLower === "unknown" && idLower === "unknown") return { provider: "unknown", id: "unknown" };
	if (providerLower === "custom" && idLower === "custom") return { provider: "custom", id: "custom" };
	const idPublic = idLower.length <= MODEL_ID_RULE.maxLength && MODEL_ID_RULE.pattern.test(idLower);
	const id_ = idPublic ? idLower : "custom";
	let providerResult = normalizeRuntimeProvider(providerTrimmed);
	if (!idPublic) providerResult = providerResult === "opencode" ? "opencode" : "custom";
	return { provider: providerResult, id: id_ };
}

/** Thin wrapper over normalizeRuntimeModel for callers that only track the
 * id dimension (the provider is used only to decide the closed unknown/empty
 * fast path; a valid non-empty provider string never changes the id result).
 */
export function classifyRuntimeModelId(provider: unknown, modelId: unknown): string {
	return normalizeRuntimeModel(provider, modelId).id;
}

/** True only for an id already in its normalized public form: it matches the
 * schema id pattern within its maxLength (which, by construction, also
 * excludes the "unknown"/"custom" sentinels, since neither matches any
 * recognized family prefix). Used to pick the strongest available evidence
 * tier among already-classified id dimensions (response/selected/observed).
 */
export function isPublicRuntimeModelId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MODEL_ID_RULE.maxLength && MODEL_ID_RULE.pattern.test(value);
}

type Missing = { state: "unavailable" | "unsupported" };
export type TokenMeasurement = Missing | { state: "reported"; value: number };
export type DurationMeasurement = Missing | { state: "measured"; value: number };
export interface FinalResponse {
	kind: "final_assistant_response";
	/** Local dedupe only: 1..128 UTF-16 code units; never exported. */
	responseId: string;
	/** Caller-observed selected SDK model ID, never dispatched/response identity.
	 * Normalized through normalizeRuntimeModel at record time; only an id
	 * matching the schema family pattern survives as a public name.
	 */
	selectedModelId?: string;
	/** Selection namespace, independent from observed response provider.
	 * Omission preserves legacy same-provider callers; adapters must pass it explicitly.
	 */
	selectedProvider?: string;
	agentClass?: AgentClass;
	/** SDK-observed model id from response metadata, never endpoint proof.
	 * Normalized like selectedModelId; only a schema family match survives.
	 */
	observedModelId?: string;
	responseModelId?: string;
	providerThinkingLevel?: typeof EFFORTS[number];
	executor: typeof EXECUTORS[number];
	provider: string;
	modelFamily: typeof FAMILIES[number];
	effort: typeof EFFORTS[number];
	error: typeof ERRORS[number];
	/** Separate native counters; do not add cached tokens into input here. */
	tokens: Record<"input" | "output" | "cacheRead" | "cacheWrite", TokenMeasurement>
		& Partial<Record<"reasoning" | "totalTokens", TokenMeasurement>>;
	/** Request start to response headers; not first token or full response. */
	responseHeadersMs: DurationMeasurement;
	/** Same request start to completed response; only explicitly measured values. */
	fullResponseMs: DurationMeasurement;
}

interface TokenTotals { reported: number; unavailable: number; unsupported: number; sum: number }
interface DurationTotals { measured: number; unavailable: number; unsupported: number; sum: number }
export interface RuntimeMetricBucket {
	hostAgent: "pi";
	agentClass: AgentClass;
	observedModelId: string;
	responseModelId: string;
	providerThinkingLevel: typeof EFFORTS[number];
	selectedModelId: string;
	selectedProvider: FinalResponse["provider"];
	executor: FinalResponse["executor"];
	provider: FinalResponse["provider"];
	modelFamily: FinalResponse["modelFamily"];
	effort: FinalResponse["effort"];
	error: FinalResponse["error"];
	responses: number;
	tokens: Record<typeof TOKEN_FIELDS[number], TokenTotals>;
	responseHeadersMs: DurationTotals;
	fullResponseMs: DurationTotals;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function category<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
	return member(values, value) ? value : fallback;
}

function measurement(value: unknown, present: "reported" | "measured"): boolean {
	if (!object(value)) return false;
	if (value.state === "unavailable" || value.state === "unsupported") return !("value" in value);
	if (value.state !== present || typeof value.value !== "number") return false;
	const n = value.value;
	// Hard ceilings keep every sum finite/exact for integer counters, even at capacity.
	return Number.isFinite(n) && n >= 0 && (present === "reported"
		? Number.isSafeInteger(n) && n <= 1_000_000_000
		: n <= 86_400_000);
}

export function validRuntimeResponse(value: unknown): value is FinalResponse {
	if (!object(value) || value.kind !== "final_assistant_response") return false;
	if (typeof value.responseId !== "string" || value.responseId.length < 1 || value.responseId.length > 128) return false;
	if (!member(EFFORTS, value.effort) || !member(ERRORS, value.error)) return false;
	const tokens = value.tokens;
	if (!object(tokens) || !TOKEN_FIELDS.every(key => measurement(tokens[key] === undefined && ["reasoning", "totalTokens"].includes(key)
		? { state: "unavailable" } : tokens[key], "reported"))) return false;
	if (!measurement(value.responseHeadersMs, "measured") || !measurement(value.fullResponseMs, "measured")) return false;
	const headers = value.responseHeadersMs as DurationMeasurement;
	const full = value.fullResponseMs as DurationMeasurement;
	return headers.state !== "measured" || full.state !== "measured" || headers.value <= full.value;
}

function tokenTotals(): TokenTotals {
	return { reported: 0, unavailable: 0, unsupported: 0, sum: 0 };
}

function durationTotals(): DurationTotals {
	return { measured: 0, unavailable: 0, unsupported: 0, sum: 0 };
}

function addDuration(totals: DurationTotals, value: DurationMeasurement): void {
	totals[value.state] += 1;
	if (value.state === "measured") totals.sum += value.value;
}

/**
 * At most 1024 accepted responses/IDs, 64 dimension buckets, and 128 code units
 * per ID. No eviction: once capacity is reached, new records are rejected
 * atomically (including existing buckets); accepted IDs remain deduplicated.
 * Invalid/rejected IDs are not reserved. A new instance starts a new accounting
 * window with NO cross-instance/lifetime dedupe guarantee. No reset/flush API:
 * window ownership and delivery remain future work. Runtime consumption stays
 * separate from deterministic SDD/RDD counts; no closure attribution or bridge.
 * Snapshots contain only closed dimensions and bounded numeric aggregates.
 */
export class RuntimeMetrics {
	#ids = new Set<string>();
	#buckets = new Map<string, RuntimeMetricBucket>();
	#maxResponses: number;
	#maxBuckets: number;

	constructor({ maxResponses = 1024, maxBuckets = 64 }: { maxResponses?: number; maxBuckets?: number } = {}) {
		if (!Number.isInteger(maxResponses) || maxResponses < 1 || maxResponses > 1024
			|| !Number.isInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > 64) {
			throw new RangeError("Invalid runtime metrics capacity");
		}
		this.#maxResponses = maxResponses;
		this.#maxBuckets = maxBuckets;
	}

	record(response: FinalResponse): "recorded" | "duplicate" | "invalid" | "capacity" {
		if (!validRuntimeResponse(response)) return "invalid";
		if (this.#ids.has(response.responseId)) return "duplicate";
		const selectedProvider = response.selectedProvider ?? response.provider;
		const dimensions = {
			hostAgent: "pi" as const,
			agentClass: category(AGENT_CLASSES, response.agentClass, UNKNOWN_AGENT_CLASS),
			observedModelId: classifyRuntimeModelId(response.provider, response.observedModelId),
			responseModelId: classifyRuntimeModelId(response.provider, response.responseModelId),
			providerThinkingLevel: category(EFFORTS, response.providerThinkingLevel, "unavailable"),
			selectedModelId: classifyRuntimeModelId(selectedProvider, response.selectedModelId),
			selectedProvider: normalizeRuntimeProvider(selectedProvider),
			executor: category(EXECUTORS, response.executor, "unknown"),
			provider: normalizeRuntimeProvider(response.provider),
			modelFamily: category(FAMILIES, response.modelFamily, typeof response.modelFamily === "string" && response.modelFamily ? "custom" : "unknown"),
			effort: response.effort,
			error: response.error,
		};
		const key = JSON.stringify(dimensions);
		let bucket = this.#buckets.get(key);
		if (this.#ids.size >= this.#maxResponses || (!bucket && this.#buckets.size >= this.#maxBuckets)) return "capacity";
		if (!bucket) {
			bucket = {
				...dimensions, responses: 0,
				tokens: { input: tokenTotals(), output: tokenTotals(), cacheRead: tokenTotals(), cacheWrite: tokenTotals(), reasoning: tokenTotals(), totalTokens: tokenTotals() },
				responseHeadersMs: durationTotals(), fullResponseMs: durationTotals(),
			};
			this.#buckets.set(key, bucket);
		}
		this.#ids.add(response.responseId);
		bucket.responses += 1;
		for (const field of TOKEN_FIELDS) {
			const value = response.tokens[field] ?? { state: "unavailable" as const };
			bucket.tokens[field][value.state] += 1;
			if (value.state === "reported") bucket.tokens[field].sum += value.value;
		}
		addDuration(bucket.responseHeadersMs, response.responseHeadersMs);
		addDuration(bucket.fullResponseMs, response.fullResponseMs);
		return "recorded";
	}

	snapshot(): RuntimeMetricBucket[] {
		return structuredClone([...this.#buckets.values()]);
	}
}
