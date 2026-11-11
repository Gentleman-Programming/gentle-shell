// In-process reviewer completion (gentle-ai#4611; gentle-pi#311 P1).
//
// The relay child this module replaced ran a locked-down `pi --print` process
// with extension discovery disabled, which dropped extension-registered
// providers ("Model not found") and stripped env-provided API keys; its env
// allowlist required per-provider manual configuration and Go roles had no
// parity with it. This module is that transport's replacement for a single
// reviewer completion: it resolves
// the caller's "provider/id" selection through pi's live model registry,
// authenticates through the registry's own resolver, and completes exactly
// one frozen prompt as a single user message — no systemPrompt, no tools, no
// session, and none of pi's tool/skill/prompt extension hooks. Extension
// *providers* are the opposite: they are explicitly in scope. Reading the
// earlier "no extension hooks" wording as "no extension providers" is what
// produced gentle-shell#1304, where every extension-registered model was
// unreachable, so the distinction is stated here rather than implied.
//
// Every I/O seam is injected (`registry`, `complete`, `now`), so this module
// runs under tests with no network and no pi process. gentle-pi#311 P2 wires
// this into the lens relay (lib/review-host-relay.ts); P3 wires the provider
// role vectors. This file stays a pure completion, never invoked from here.

import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Context, Model, ProviderEnv, ProviderHeaders, SimpleStreamOptions, TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import { SAFE_MODEL_ID_PATTERN, type ServiceTier } from "./model-routing-authority.ts";
import { applyOpenAITier, supportsOpenAIFast } from "./openai-fast-tier.ts";
import { readReviewerStream, type ReviewerStream, type ReviewerProgressObserver } from "./reviewer-stream.ts";

// ---------------------------------------------------------------------------
// Registry seam — a structural subset of pi's live ModelRegistry
// (@earendil-works/pi-coding-agent core/model-registry.ts). `find` and
// `getApiKeyAndHeaders` are required. `getProvider` is optional and selects
// the dispatch path: when present, the completion goes through the composed
// provider it returns (which is what reaches extension-registered providers);
// when absent, it falls back to `deps.complete`, so a test double with no
// composition layer still satisfies the seam. Resolved auth includes the
// request-local endpoint and provider environment, just as pi's normal
// ModelRuntime.prepareRequest applies them before dispatch.
// ---------------------------------------------------------------------------

/**
 * The single method this module needs from a resolved provider. pi's
 * `Provider.streamSimple` returns an `AssistantMessageEventStream`. Observe
 * content activity when iterable; result-only compatibility seams retain the
 * overall deadline without inventing stream progress.
 */
export interface InProcessReviewerProvider {
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): ReviewerStream;
}

export interface InProcessReviewerRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { readonly ok: true; readonly apiKey?: string; readonly headers?: ProviderHeaders; readonly baseUrl?: string; readonly env?: ProviderEnv }
		| { readonly ok: false; readonly error: string }
	>;
	getProvider?(provider: string): InProcessReviewerProvider | undefined;
}

export const INPROCESS_REVIEWER_FAILURE = {
	SELECTION_INVALID: "selection-invalid",
	MODEL_NOT_FOUND: "model-not-found",
	AUTH_UNAVAILABLE: "auth-unavailable",
	THINKING_INVALID: "thinking-invalid",
	TOOL_CALL_ATTEMPTED: "tool-call-attempted",
	EMPTY_OUTPUT: "empty-output",
	OUTPUT_TOO_LARGE: "output-too-large",
	TIMED_OUT: "timed-out",
	ABORTED: "aborted",
	PROVIDER_FAILED: "provider-failed",
} as const;
export type InProcessReviewerFailureCode = (typeof INPROCESS_REVIEWER_FAILURE)[keyof typeof INPROCESS_REVIEWER_FAILURE];

// gentle-ai#6095: an empty completion has more than one cause, and only the
// completion itself carries the facts that tell them apart. Attributing it
// generically ("reviewer produced no text") pushed the diagnosis onto whoever
// read the transcript next: the recorded model id, stop reason and usage split
// stayed uninterpreted, so six relay runs had to be correlated by hand before
// a single model's reasoning budget was visible as the cause. Each cause below
// names what actually went wrong and what can be done about it. Nothing here
// infers a candidate defect: a generation failure is not a review finding.
export const INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE = {
	REASONING_EXHAUSTED_OUTPUT_BUDGET: "reasoning-exhausted-output-budget",
	EMPTY_COMPLETION: "empty-completion",
} as const;
export type InProcessReviewerEmptyOutputCause = (typeof INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE)[keyof typeof INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE];

export interface InProcessReviewerRequest {
	/** "provider/id" from models.json routing; already validated by SAFE_MODEL_ID_PATTERN upstream, re-validated here. */
	readonly selection: string;
	/** Routing thinking label: off | minimal | low | medium | high | xhigh | max. Omitted is treated as "off". */
	readonly thinking?: string;
	readonly tier?: ServiceTier;
	/** Effective Pi transport preference; absent preserves the provider default. */
	readonly transport?: SimpleStreamOptions["transport"];
	/** Frozen Go-materialized prompt bytes, submitted verbatim as the one user message. */
	readonly prompt: Buffer;
	readonly timeoutMs: number;
	readonly firstOutputTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly signal?: AbortSignal;
	/**
	 * The live pi session id, threaded from the extension context. Pi's main
	 * agent loop adds OpenCode attribution headers itself; this side-call must
	 * carry them itself instead. Absent (or empty) means no attribution header
	 * from this field, and never an error. (The per-completion `options.sessionId`
	 * is separate: it isolates provider conversations and is never this id.)
	 */
	readonly sessionId?: string;
	/** e.g. "review-risk" — only used to name the routing config key in refusal messages. */
	readonly routingKey: string;
}

export type InProcessReviewerOutcome =
	| { readonly kind: "text"; readonly text: string; readonly reviewerModel: string; readonly evidence?: Record<string, unknown> }
	| { readonly kind: "refused"; readonly code: InProcessReviewerFailureCode; readonly message: string; readonly evidence?: Record<string, unknown> };

export interface InProcessReviewerDeps {
	readonly registry: InProcessReviewerRegistry;
	readonly complete: typeof completeSimple;
	/** Test seam for the single user message's timestamp; defaults to Date.now. */
	readonly now?: () => number;
	/** Host-only facts, including on thrown auth errors. Never awaited; observer failure is non-authoritative. */
	readonly onEvidence?: (evidence: Record<string, unknown>) => void | Promise<void>;
	readonly onProgress?: ReviewerProgressObserver;
}

// No existing bound covers the reviewer's completion text: the child this
// module replaced returned its extracted text unbounded. 4 MiB matches this
// repo's established convention for this class of bound (lib/session-changes.ts
// MAX_SESSION_BYTES, lib/provider-contract-bundle.ts MAX_FILE_BYTES).
export const INPROCESS_REVIEWER_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

// pi-ai's `SimpleStreamOptions.reasoning` accepts every routing label except
// "off" (`ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" |
// "max"`), and pi-ai itself clamps a level to what the selected model
// supports through its `thinkingLevelMap`. The label is therefore forwarded
// verbatim: the routing config owns the choice and the library owns the
// per-provider mapping, so this module never second-guesses either.
const THINKING_LABELS = new Set<ThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const ERROR_EXCERPT_MAX_CHARS = 512;

function parseSelection(selection: string): { provider: string; modelId: string } | undefined {
	if (typeof selection !== "string" || selection.length === 0 || !SAFE_MODEL_ID_PATTERN.test(selection)) return undefined;
	const separatorIndex = selection.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === selection.length - 1) return undefined;
	return { provider: selection.slice(0, separatorIndex), modelId: selection.slice(separatorIndex + 1) };
}

type ReasoningResolution = { readonly ok: true; readonly reasoning?: ThinkingLevel } | { readonly ok: false };

/**
 * "off" (or an omitted label) omits `reasoning` entirely; every other pi-ai
 * level is forwarded verbatim; an unrecognized label is a typed refusal. A model with
 * `reasoning === false` never receives the field, regardless of the label —
 * checked last so an unknown label is still refused even for a non-reasoning
 * model, instead of silently passing validation because it would be dropped
 * anyway.
 */
function resolveReasoning(thinking: string | undefined, model: Model<Api>): ReasoningResolution {
	if (thinking === undefined || thinking === "off") return { ok: true };
	if (!THINKING_LABELS.has(thinking as ThinkingLevel)) return { ok: false };
	return model.reasoning === false ? { ok: true } : { ok: true, reasoning: thinking as ThinkingLevel };
}

function sanitizeErrorExcerpt(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const collapsed = raw.replace(/\s+/g, " ").trim();
	return collapsed.length <= ERROR_EXCERPT_MAX_CHARS ? collapsed : `${collapsed.slice(0, ERROR_EXCERPT_MAX_CHARS - 1)}…`;
}

function refuse(code: InProcessReviewerFailureCode, message: string, evidence?: Record<string, unknown>): Extract<InProcessReviewerOutcome, { kind: "refused" }> {
	return { kind: "refused", code, message, ...(evidence === undefined ? {} : { evidence }) };
}

function isTextContent(part: { type?: unknown }): part is TextContent {
	return part.type === "text";
}

/** A counter the completion actually reported, or undefined; never a calculated one. */
function reportedCounter(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Attribute an empty completion from the facts the completion itself reported.
 * Two shapes are attributable today (gentle-ai#6095):
 *
 * - `stopReason: "length"` whose output budget was consumed by reasoning. This
 *   is deterministic for the routed model, not an incident: a lens routed to a
 *   model that spends the whole ceiling thinking cannot ever emit a verdict.
 * - `stopReason: "stop"` that reported zero output tokens: the provider
 *   returned no completion at all.
 *
 * Every other empty shape stays unattributed — the host has no evidence to
 * name a cause, and inventing one would be worse than the generic refusal.
 * Exported so the vocabulary is asserted directly, not only through prose.
 */
export function classifyEmptyOutput(assistant: Pick<AssistantMessage, "stopReason" | "usage">): InProcessReviewerEmptyOutputCause | undefined {
	const output = reportedCounter(assistant.usage?.output);
	const reasoning = reportedCounter(assistant.usage?.reasoning);
	if (assistant.stopReason === "length" && output !== undefined && output > 0 && reasoning !== undefined && reasoning > 0 && reasoning >= output) {
		return INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.REASONING_EXHAUSTED_OUTPUT_BUDGET;
	}
	if (assistant.stopReason === "stop" && output === 0) {
		return INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.EMPTY_COMPLETION;
	}
	return undefined;
}

/**
 * Names the attributed cause, the model or provider response responsible for
 * it, the facts the completion reported, and the remedy that fits this cause.
 * The closing sentence is deliberate: an empty generation is a transport
 * outcome, never a candidate issue, and this message is what a blocked capture
 * returns as its `reason`.
 */
function emptyOutputRefusalMessage(cause: InProcessReviewerEmptyOutputCause, routingKey: string, reviewerModel: string, assistant: AssistantMessage): string {
	const output = reportedCounter(assistant.usage?.output);
	const reasoning = reportedCounter(assistant.usage?.reasoning);
	const facts = [
		`stopReason: ${assistant.stopReason}`,
		...(output === undefined ? [] : [`output: ${output}`]),
		...(reasoning === undefined ? [] : [`reasoning: ${reasoning}`]),
	].join("; ");
	if (cause === INPROCESS_REVIEWER_EMPTY_OUTPUT_CAUSE.REASONING_EXHAUSTED_OUTPUT_BUDGET) {
		return `Reviewer model ${reviewerModel} exhausted its ${output}-token output budget on reasoning before emitting a verdict for ${routingKey} (${facts}). Route this lens to a reviewer model with a sufficient output ceiling, raise the output budget, or reduce reasoning. No candidate issue is inferred from this generation failure.`;
	}
	return `The provider returned no completion for ${routingKey} from reviewer model ${reviewerModel} (${facts}). Retry the slot. No candidate issue is inferred from this generation failure.`;
}

/** Completion diagnostics are facts only; never copy provider text, errors, or payloads. */
function completionEvidence(model: Model<Api>, assistant: AssistantMessage): Record<string, unknown> {
	const evidence: Record<string, unknown> = { reviewerModel: `${model.provider}/${model.id}`.slice(0, 512) };
	if (["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(assistant.stopReason)) {
		evidence.stopReason = assistant.stopReason;
	}
	const addCounter = (target: Record<string, number>, key: string, value: unknown) => {
		const counter = reportedCounter(value);
		if (counter !== undefined) target[key] = counter;
	};
	const usage: Record<string, number> = {};
	for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		addCounter(usage, key, assistant.usage?.[key]);
	}
	if (Object.keys(usage).length > 0) evidence.usage = usage;
	// Copy only numbers the completion actually reported. Do not calculate
	// missing totals or confuse SDK-reported cost with verified billing.
	const reportedCost = assistant.usage?.cost;
	const cost: Record<string, number | boolean> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		const value = reportedCost?.[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) cost[key] = value;
	}
	const totalFromProvider = (reportedCost as unknown as Record<string, unknown> | undefined)?.totalFromProvider;
	if (typeof totalFromProvider === "boolean") cost.totalFromProvider = totalFromProvider;
	if (Object.keys(cost).length > 0) evidence.cost = cost;
	const text = assistant.content.filter(isTextContent);
	const thinking = assistant.content.filter((part) => part.type === "thinking");
	const content: Record<string, number> = {};
	addCounter(content, "blocks", assistant.content.length);
	addCounter(content, "textBlocks", text.length);
	addCounter(content, "thinkingBlocks", thinking.length);
	if (text.every((part) => typeof part.text === "string")) {
		addCounter(content, "textChars", text.reduce((sum, part) => sum + part.text.length, 0));
	}
	if (thinking.every((part) => typeof part.thinking === "string")) {
		addCounter(content, "thinkingChars", thinking.reduce((sum, part) => sum + part.thinking.length, 0));
	}
	evidence.content = content;
	return evidence;
}

/**
 * Mirrors pi's main-loop OpenCode attribution condition exactly
 * (core/provider-attribution.js#getSessionHeaders): the model's provider is
 * `opencode` or `opencode-go`, or its baseUrl host is `opencode.ai`. Returns
 * the `{ x-opencode-session, x-opencode-client }` attribution pair, or
 * undefined when the model is not OpenCode-routed or there is no live session
 * id — a missing session id is never an error and never invents a header.
 * The URL parse is guarded: an unparseable baseUrl follows the provider
 * condition alone.
 */
export function openCodeSessionAttributionHeaders(model: Model<Api>, sessionId: string | undefined): ProviderHeaders | undefined {
	const isOpenCode = model.provider === "opencode"
		|| model.provider === "opencode-go"
		|| (() => {
			try {
				return new URL(String(model.baseUrl ?? "")).hostname === "opencode.ai";
			} catch {
				return false;
			}
		})();
	if (!isOpenCode || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

// Own settlement independently of the provider's AbortSignal handling. A timed
// out provider may continue running; its late fulfillment/rejection is consumed
// without resuming the reviewer pipeline or authorizing a submission.
function reviewerDeadline(request: InProcessReviewerRequest) {
	const controller = new AbortController();
	const endsAt = performance.now() + request.timeoutMs;
	const interrupted = Symbol("reviewer interrupted");
	let timedOut = false;
	let refusal: InProcessReviewerOutcome | undefined;
	const failure = (): InProcessReviewerOutcome | undefined => {
		if (refusal !== undefined) return refusal;
		// The deadline wins if already elapsed when cancellation is observed.
		// Otherwise caller cancellation settles immediately and retains ABORTED.
		if (timedOut || performance.now() >= endsAt) {
			refusal = refuse(INPROCESS_REVIEWER_FAILURE.TIMED_OUT, `Reviewer completion for ${request.routingKey} exceeded its ${request.timeoutMs}ms bound.`);
			controller.abort(new DOMException("Reviewer deadline exceeded", "TimeoutError"));
		} else if (request.signal?.aborted) {
			refusal = refuse(INPROCESS_REVIEWER_FAILURE.ABORTED, `Reviewer completion for ${request.routingKey} was aborted by the caller.`);
			controller.abort(request.signal.reason);
		}
		return refusal;
	};
	const onCallerAbort = () => { failure(); };
	request.signal?.addEventListener("abort", onCallerAbort, { once: true });
	const timer = setTimeout(() => { timedOut = true; failure(); }, request.timeoutMs);
	return {
		signal: controller.signal,
		failure,
		timeout(phase: "first-output" | "stream-idle", limitMs: number) {
			if (failure() !== undefined) return;
			refusal = refuse(INPROCESS_REVIEWER_FAILURE.TIMED_OUT,
				`Reviewer ${request.routingKey} exceeded its ${limitMs}ms ${phase} bound; no result was admitted.`,
				{ timeoutPhase: phase, streamTimeoutMs: limitMs });
			controller.abort(new DOMException("Reviewer stream stalled", "TimeoutError"));
		},
		wait<T>(start: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				if (failure() !== undefined) { reject(interrupted); return; }
				let settled = false;
				const finish = (action: () => void) => {
					if (settled) return;
					settled = true;
					controller.signal.removeEventListener("abort", onAbort);
					action();
				};
				const onAbort = () => finish(() => reject(interrupted));
				controller.signal.addEventListener("abort", onAbort, { once: true });
				let pending: Promise<T>;
				try { pending = start(); }
				catch (error) { finish(() => reject(error)); return; }
				// Both handlers stay attached after interruption to consume a late
				// provider rejection, but finish can never resume this call twice.
				Promise.resolve(pending).then(
					value => finish(() => failure() === undefined ? resolve(value) : reject(interrupted)),
					error => finish(() => reject(error)),
				);
			});
		},
		dispose() {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

type InProcessReviewerModelResolution =
	| { readonly kind: "resolved"; readonly model: Model<Api>; readonly provider?: InProcessReviewerProvider; readonly providerId: string }
	| Extract<InProcessReviewerOutcome, { kind: "refused" }>;

/** Resolve only caller-owned model routing; no authentication or completion. */
export function resolveInProcessReviewerModel(request: Pick<InProcessReviewerRequest, "selection" | "routingKey">, registry: InProcessReviewerRegistry): InProcessReviewerModelResolution {
	const parsed = parseSelection(request.selection);
	if (parsed === undefined) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.SELECTION_INVALID,
			`Invalid model selection ${JSON.stringify(request.selection)} for ${request.routingKey}; expected the "provider/id" shape.`,
		);
	}

	const model = registry.find(parsed.provider, parsed.modelId);
	if (model === undefined) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND,
			`No model matches selection ${JSON.stringify(request.selection)} configured for ${request.routingKey}; assign ${request.routingKey} a model that the interactive pi's model list actually shows.`,
		);
	}

	// pi's composed provider is the only layer that honors extension-registered
	// providers (core/provider-composer.ts: `extension.streamSimple` when
	// `model.api === extension.api`). pi-ai's `completeSimple` resolves against
	// its own builtin-only registry and throws for any extension api, so a seam
	// that carries `getProvider` is always preferred; a seam without it at all
	// (a test double with no composition layer) still uses `deps.complete`.
	// A registry that has `getProvider` yet owns no provider for a model its
	// own `find` just resolved is incoherent: refuse, never route past it.
	//
	// The lookup deliberately uses `parsed.provider` — the key `find` was
	// called with — and not `model.provider`, which is a field of the object
	// `find` returned. In pi's registry both reads hit one provider map
	// (core/model-runtime.ts `getProvider`/`getModel` -> pi-ai models.ts, where
	// `getModels(provider)` returns [] for an unknown id), so a resolved model
	// always has a provider under its own key and this branch is unreachable by
	// construction. Keying on the returned field instead would make that
	// guarantee depend on every provider's `getModels()` echoing its own id,
	// which a native or OAuth-modified extension provider is free not to do.
	const provider = registry.getProvider?.(parsed.provider);
	if (registry.getProvider !== undefined && provider === undefined) {
		const evidence: Record<string, unknown> = { provider: parsed.provider, api: model.api };
		// Preserve already resolved identity when configuration refuses before auth.
		if (typeof model.provider === "string" && typeof model.id === "string") {
			evidence.reviewerModel = `${model.provider}/${model.id}`.slice(0, 512);
			evidence.provider = model.provider.slice(0, 256);
		}
		return refuse(
			INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND,
			`The model registry resolved ${JSON.stringify(request.selection)} for ${request.routingKey} but owns no provider for ${JSON.stringify(parsed.provider)}; reassign ${request.routingKey} to a model whose provider the interactive pi can actually dispatch.`,
			evidence,
		);
	}
	return { kind: "resolved", model, ...(provider === undefined ? {} : { provider }), providerId: parsed.provider };
}

/**
 * Runs one reviewer completion in-process: resolve the model, authenticate,
 * map the routing thinking label, and complete exactly one frozen prompt as
 * a single user message. Never retries, never falls back to another model,
 * never reads process.env — every seam is injected through `deps`.
 */
export async function runInProcessReviewer(request: InProcessReviewerRequest, deps: InProcessReviewerDeps): Promise<InProcessReviewerOutcome> {
	const began = performance.now();
	let phase: "configuration" | "auth" | "completion" = "configuration";
	let resolvedModel: Model<Api> | undefined, resolvedAssistant: AssistantMessage | undefined;
	let authStarted: number | undefined, completionStarted: number | undefined;
	let authDurationMs: number | undefined, completionDurationMs: number | undefined;
	let finalEvidence: Record<string, unknown> | undefined;
	/** Capture allowlisted facts at one instant, including unfinished phase durations. */
	const snapshot = (): Record<string, unknown> => {
		const evidence: Record<string, unknown> = { phase };
		/** Omit unavailable or invalid measurements rather than inventing a duration. */
		const duration = (key: string, value: number | undefined) => {
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) evidence[key] = value;
		};
		const now = performance.now();
		duration("durationMs", now - began);
		duration("authDurationMs", authDurationMs ?? (authStarted === undefined ? undefined : now - authStarted));
		duration("completionDurationMs", completionDurationMs ?? (completionStarted === undefined ? undefined : now - completionStarted));
		if (resolvedModel !== undefined) {
			if (typeof resolvedModel.provider === "string" && typeof resolvedModel.id === "string") {
				evidence.reviewerModel = `${resolvedModel.provider}/${resolvedModel.id}`.slice(0, 512);
				evidence.provider = resolvedModel.provider.slice(0, 256);
			}
			// Diagnostics never change an otherwise valid completion or refusal.
			try { if (resolvedAssistant !== undefined) Object.assign(evidence, completionEvidence(resolvedModel, resolvedAssistant)); } catch { /* malformed diagnostic metadata is unavailable */ }
		}
		return evidence;
	};
	/** Freeze the final evidence before phase cleanup or late provider settlement. */
	const finish = (outcome: InProcessReviewerOutcome): InProcessReviewerOutcome => {
		finalEvidence = { ...outcome.evidence, ...snapshot() };
		return { ...outcome, evidence: finalEvidence };
	};
	try {
		const resolved = resolveInProcessReviewerModel(request, deps.registry);
		if (resolved.kind === "refused") return finish(resolved);
		const { model, provider, providerId } = resolved;
		resolvedModel = model;

		// Authentication and completion share one monotonic host deadline. Do not
		// restart its budget after auth or rely on a provider to settle on abort.
		const deadline = reviewerDeadline(request);
		try {
			let auth: Awaited<ReturnType<InProcessReviewerRegistry["getApiKeyAndHeaders"]>>;
			try { auth = await deadline.wait(() => {
				phase = "auth"; authStarted = performance.now();
				return deps.registry.getApiKeyAndHeaders(model);
			}); }
			catch (error) {
				const stopped = deadline.failure();
				if (stopped !== undefined) return finish(stopped);
				throw error;
			}
			finally { if (authStarted !== undefined) authDurationMs = performance.now() - authStarted; }
			// Negation narrowing (`!auth.ok`) does not eliminate the `ok: true` arm of
			// this discriminated union under this project's `strict: false` tsconfig;
			// an explicit `=== false` comparison narrows correctly in both directions.
			if (auth.ok === false) {
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.AUTH_UNAVAILABLE,
					`No credentials available for provider ${JSON.stringify(providerId)} (used by ${request.routingKey}): ${auth.error}`,
				));
			}

			phase = "configuration";
			const reasoning = resolveReasoning(request.thinking, model);
			if (reasoning.ok === false) {
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.THINKING_INVALID,
					`Unknown thinking level ${JSON.stringify(request.thinking)} for ${request.routingKey}; use one of off, minimal, low, medium, high, xhigh, max.`,
				));
			}

			// OAuth resolution may supply an account-specific endpoint alongside the
			// exchanged API key. Match ModelRuntime.prepareRequest: apply that endpoint
			// to a request-local copy, never mutate the shared registry model.
			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// Extension side-calls bypass pi's main agent loop, which is where OpenCode
			// attribution headers are otherwise added. Use the effective request model
			// and place attribution defaults beneath the registry's own auth headers,
			// matching pi's core merge order for explicit header sources.
			const attributionHeaders = openCodeSessionAttributionHeaders(requestModel, request.sessionId);

			const context: Context = {
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: request.prompt.toString("utf8") }],
						timestamp: (deps.now ?? Date.now)(),
					},
				],
			};
			const options: SimpleStreamOptions = {
				signal: deadline.signal,
				// Preserve the provider's configured transport budget. The host's
				// earlier deadline still includes auth and cannot be extended by it.
				timeoutMs: request.timeoutMs,
				// Providers that keep server-side conversation state key it on
				// `options.sessionId` and otherwise fall back to something coarser (for
				// example the worktree), which would merge every reviewer completion into
				// one growing conversation. A fresh id per completion keeps each review
				// isolated. It is deliberately not `request.sessionId`: that is the parent
				// session's id and would merge reviewer calls into the parent's conversation.
				sessionId: `review-${request.routingKey}-${randomUUID()}`,
				...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
				...(auth.env === undefined ? {} : { env: auth.env }),
				...(auth.headers === undefined && attributionHeaders === undefined ? {} : { headers: attributionHeaders === undefined ? auth.headers : { ...attributionHeaders, ...auth.headers } }),
				...(reasoning.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
				...(request.transport === undefined ? {} : { transport: request.transport }),
				...(request.tier !== undefined && supportsOpenAIFast(requestModel)
					? { onPayload: (payload: unknown) => applyOpenAITier(payload, request.tier, requestModel) }
					: {}),
			};

			// Observe the composed SDK stream while retaining the original result.
			// The promise-only compatibility seam has only the overall deadline.
			let assistant: AssistantMessage;
			try {
				assistant = await deadline.wait(() => {
					phase = "completion"; completionStarted = performance.now();
					return provider === undefined ? deps.complete(requestModel, context, options) : readReviewerStream(provider.streamSimple(requestModel, context, options), {
						routingKey: request.routingKey, firstOutputTimeoutMs: request.firstOutputTimeoutMs, idleTimeoutMs: request.idleTimeoutMs,
						wait: deadline.wait, timeout: deadline.timeout, onProgress: deps.onProgress,
					});
				});
				resolvedAssistant = assistant;
			} catch (error) {
				return finish(deadline.failure() ?? refuse(INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED, `Reviewer completion failed for ${request.routingKey}: ${sanitizeErrorExcerpt(error)}`));
			}

			finally { if (completionStarted !== undefined) completionDurationMs = performance.now() - completionStarted; }

			const resolvedAbort = deadline.failure();
			if (resolvedAbort !== undefined) return finish(resolvedAbort);
			if (assistant.stopReason === "aborted") {
				// No signal of ours fired, so the provider cut the completion on its
				// own: that is a provider failure, and its partial text is not a review.
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED,
					`Reviewer completion failed for ${request.routingKey}: the provider reported an aborted completion (${assistant.errorMessage ?? "no provider message"}).`,
				));
			}

			if (assistant.stopReason === "error") {
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED,
					`Reviewer completion failed for ${request.routingKey}: ${assistant.errorMessage ?? "unknown provider error"}`,
				));
			}
			if (assistant.content.some((part) => part.type === "toolCall")) {
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED,
					`Reviewer attempted a tool call for ${request.routingKey}; the in-process reviewer completion must answer in text only.`,
				));
			}

			const text = assistant.content.filter(isTextContent).map((part) => part.text).join("");
			if (text.length === 0) {
				const stopReason = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(assistant.stopReason) ? assistant.stopReason : undefined;
				const cause = classifyEmptyOutput(assistant);
				// An attributed cause keeps the same failure code and the same evidence
				// facts; it adds the interpretation (as `cause`) and replaces only the
				// message, so no other empty shape changes its refusal.
				return finish(cause === undefined
					? refuse(INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT, `Reviewer produced no text for ${request.routingKey} (stopReason: ${stopReason ?? "unknown"}).`)
					: refuse(INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT, emptyOutputRefusalMessage(cause, request.routingKey, `${model.provider}/${model.id}`, assistant), { cause }));
			}

			const textBytes = Buffer.byteLength(text, "utf8");
			if (textBytes > INPROCESS_REVIEWER_OUTPUT_MAX_BYTES) {
				return finish(refuse(
					INPROCESS_REVIEWER_FAILURE.OUTPUT_TOO_LARGE,
					`Reviewer output for ${request.routingKey} exceeds the ${INPROCESS_REVIEWER_OUTPUT_MAX_BYTES}-byte bound (received ${textBytes} bytes).`,
				));
			}

			return finish({ kind: "text", text, reviewerModel: `${model.provider}/${model.id}` });
		} finally { deadline.dispose(); }

	} finally {
		try {
			const observer = deps.onEvidence?.(structuredClone(finalEvidence ?? snapshot()));
			if (observer !== undefined) void Promise.resolve(observer).catch(() => {});
		} catch { /* Host diagnostics never affect classification or settlement. */ }
	}
}
