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

import type { Api, AssistantMessage, Context, Model, ProviderHeaders, SimpleStreamOptions, TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import { SAFE_MODEL_ID_PATTERN } from "./model-routing-authority.ts";

// ---------------------------------------------------------------------------
// Registry seam — a structural subset of pi's live ModelRegistry
// (@earendil-works/pi-coding-agent core/model-registry.ts). `find` and
// `getApiKeyAndHeaders` are required. `getProvider` is optional and selects
// the dispatch path: when present, the completion goes through the composed
// provider it returns (which is what reaches extension-registered providers);
// when absent, it falls back to `deps.complete`, so a test double with no
// composition layer still satisfies the seam. The real registry's resolved
// auth carries extra optional fields (`baseUrl`, `env`) that this narrower
// shape simply ignores.
// ---------------------------------------------------------------------------

/**
 * The single method this module needs from a resolved provider. pi's
 * `Provider.streamSimple` returns an `AssistantMessageEventStream`; only its
 * `result()` is consumed here, so the seam asks for nothing more.
 */
export interface InProcessReviewerProvider {
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): { result(): Promise<AssistantMessage> };
}

export interface InProcessReviewerRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { readonly ok: true; readonly apiKey?: string; readonly headers?: ProviderHeaders }
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

export interface InProcessReviewerRequest {
	/** "provider/id" from models.json routing; already validated by SAFE_MODEL_ID_PATTERN upstream, re-validated here. */
	readonly selection: string;
	/** Routing thinking label: off | minimal | low | medium | high | xhigh | max. Omitted is treated as "off". */
	readonly thinking?: string;
	/** Frozen Go-materialized prompt bytes, submitted verbatim as the one user message. */
	readonly prompt: Buffer;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/**
	 * The live pi session id, threaded from the extension context. Pi's main
	 * agent loop adds OpenCode attribution headers itself; this side-call must
	 * carry them itself instead. Absent (or empty) means no attribution header,
	 * never an invented one and never an error.
	 */
	readonly sessionId?: string;
	/** e.g. "review-risk" — only used to name the routing config key in refusal messages. */
	readonly routingKey: string;
}

export type InProcessReviewerOutcome =
	| { readonly kind: "text"; readonly text: string; readonly reviewerModel: string }
	| { readonly kind: "refused"; readonly code: InProcessReviewerFailureCode; readonly message: string; readonly evidence?: Record<string, unknown> };

export interface InProcessReviewerDeps {
	readonly registry: InProcessReviewerRegistry;
	readonly complete: typeof completeSimple;
	/** Test seam for the single user message's timestamp; defaults to Date.now. */
	readonly now?: () => number;
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

function refuse(code: InProcessReviewerFailureCode, message: string, evidence?: Record<string, unknown>): InProcessReviewerOutcome {
	return { kind: "refused", code, message, ...(evidence === undefined ? {} : { evidence }) };
}

function isTextContent(part: { type?: unknown }): part is TextContent {
	return part.type === "text";
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

/**
 * Runs one reviewer completion in-process: resolve the model, authenticate,
 * map the routing thinking label, and complete exactly one frozen prompt as
 * a single user message. Never retries, never falls back to another model,
 * never reads process.env — every seam is injected through `deps`.
 */
export async function runInProcessReviewer(request: InProcessReviewerRequest, deps: InProcessReviewerDeps): Promise<InProcessReviewerOutcome> {
	const parsed = parseSelection(request.selection);
	if (parsed === undefined) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.SELECTION_INVALID,
			`Invalid model selection ${JSON.stringify(request.selection)} for ${request.routingKey}; expected the "provider/id" shape.`,
		);
	}

	const model = deps.registry.find(parsed.provider, parsed.modelId);
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
	const provider = deps.registry.getProvider?.(parsed.provider);
	if (deps.registry.getProvider !== undefined && provider === undefined) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.MODEL_NOT_FOUND,
			`The model registry resolved ${JSON.stringify(request.selection)} for ${request.routingKey} but owns no provider for ${JSON.stringify(parsed.provider)}; reassign ${request.routingKey} to a model whose provider the interactive pi can actually dispatch.`,
			{ provider: parsed.provider, api: model.api },
		);
	}

	const auth = await deps.registry.getApiKeyAndHeaders(model);
	// Negation narrowing (`!auth.ok`) does not eliminate the `ok: true` arm of
	// this discriminated union under this project's `strict: false` tsconfig;
	// an explicit `=== false` comparison narrows correctly in both directions.
	if (auth.ok === false) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.AUTH_UNAVAILABLE,
			`No credentials available for provider ${JSON.stringify(parsed.provider)} (used by ${request.routingKey}): ${auth.error}`,
		);
	}

	const reasoning = resolveReasoning(request.thinking, model);
	if (reasoning.ok === false) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.THINKING_INVALID,
			`Unknown thinking level ${JSON.stringify(request.thinking)} for ${request.routingKey}; use one of off, minimal, low, medium, high, xhigh, max.`,
		);
	}

	// Extension side-calls bypass pi's main agent loop, which is where OpenCode
	// attribution headers are otherwise added, so this completion carries them
	// itself — as a default beneath the registry's own auth headers, the same
	// merge order pi's core uses for explicit header sources.
	const attributionHeaders = openCodeSessionAttributionHeaders(model, request.sessionId);

	// The caller's own signal (if any) and a floor timeout race together:
	// whichever fires first aborts the completion. The catch branch below
	// tells them apart by which underlying signal actually fired, never by
	// inspecting the thrown error's shape, which providers are free to vary.
	const timeoutSignal = AbortSignal.timeout(request.timeoutMs);
	const combinedSignal = request.signal === undefined ? timeoutSignal : AbortSignal.any([request.signal, timeoutSignal]);

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
		signal: combinedSignal,
		timeoutMs: request.timeoutMs,
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(auth.headers === undefined && attributionHeaders === undefined ? {} : { headers: attributionHeaders === undefined ? auth.headers : { ...attributionHeaders, ...auth.headers } }),
		...(reasoning.reasoning === undefined ? {} : { reasoning: reasoning.reasoning }),
	};

	// An abort is classified by which signal actually fired, never by the
	// error's shape or the message's text, and the same classification serves
	// both settlement paths: a provider may reject on abort, or — the pi-ai
	// provider convention — resolve an AssistantMessage with `stopReason:
	// "aborted"` carrying whatever text streamed before the cut. Either way a
	// fired signal is a timeout or a caller abort, never empty or usable output.
	const abortRefusal = (): InProcessReviewerOutcome | undefined => {
		if (timeoutSignal.aborted) {
			return refuse(INPROCESS_REVIEWER_FAILURE.TIMED_OUT, `Reviewer completion for ${request.routingKey} exceeded its ${request.timeoutMs}ms bound.`);
		}
		if (request.signal?.aborted === true) {
			return refuse(INPROCESS_REVIEWER_FAILURE.ABORTED, `Reviewer completion for ${request.routingKey} was aborted by the caller.`);
		}
		return undefined;
	};

	// `SimpleStreamOptions` is identical on both paths; only the return shape
	// differs (an event stream versus a promise), hence `.result()` — which is
	// exactly what pi-ai's own compat layer does with the same stream.
	let assistant: AssistantMessage;
	try {
		assistant = provider === undefined ? await deps.complete(model, context, options) : await provider.streamSimple(model, context, options).result();
	} catch (error) {
		return abortRefusal() ?? refuse(INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED, `Reviewer completion failed for ${request.routingKey}: ${sanitizeErrorExcerpt(error)}`);
	}

	const resolvedAbort = abortRefusal();
	if (resolvedAbort !== undefined) return resolvedAbort;
	if (assistant.stopReason === "aborted") {
		// No signal of ours fired, so the provider cut the completion on its
		// own: that is a provider failure, and its partial text is not a review.
		return refuse(
			INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED,
			`Reviewer completion failed for ${request.routingKey}: the provider reported an aborted completion (${assistant.errorMessage ?? "no provider message"}).`,
		);
	}

	if (assistant.stopReason === "error") {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.PROVIDER_FAILED,
			`Reviewer completion failed for ${request.routingKey}: ${assistant.errorMessage ?? "unknown provider error"}`,
		);
	}
	if (assistant.content.some((part) => part.type === "toolCall")) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.TOOL_CALL_ATTEMPTED,
			`Reviewer attempted a tool call for ${request.routingKey}; the in-process reviewer completion must answer in text only.`,
		);
	}

	const text = assistant.content.filter(isTextContent).map((part) => part.text).join("");
	if (text.length === 0) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.EMPTY_OUTPUT,
			`Reviewer produced no text for ${request.routingKey} (stopReason: ${assistant.stopReason}).`,
			{ stopReason: assistant.stopReason, ...(assistant.errorMessage === undefined ? {} : { errorMessage: assistant.errorMessage }) },
		);
	}

	const textBytes = Buffer.byteLength(text, "utf8");
	if (textBytes > INPROCESS_REVIEWER_OUTPUT_MAX_BYTES) {
		return refuse(
			INPROCESS_REVIEWER_FAILURE.OUTPUT_TOO_LARGE,
			`Reviewer output for ${request.routingKey} exceeds the ${INPROCESS_REVIEWER_OUTPUT_MAX_BYTES}-byte bound (received ${textBytes} bytes).`,
		);
	}

	return { kind: "text", text, reviewerModel: `${model.provider}/${model.id}` };
}
