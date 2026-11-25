// Gentle Desktop sign-in slice: the pure contract of `login_start`,
// `login_complete`, `login_cancel`, `set_api_key` and `remove_credentials`,
// shared by the bridge (`lib/desktop-login-service.ts`) and its tests.
//
// A client drives Pi's own provider sign-in from another device: what Pi's
// `/login` dialog would show becomes a `login_prompt` event, and what the user
// types or pastes there comes back as `login_complete`. Nothing here ever
// carries a credential back to the client: an API key goes one way, and
// errors are Pi's message text, bounded, never a stored value.

import { PROVIDER_ID } from "./desktop-rpc-auth.ts";

export const DESKTOP_LOGIN_METHODS = ["login_start", "login_complete", "login_cancel", "set_api_key", "remove_credentials"] as const;
export const DESKTOP_LOGIN_EVENTS = ["login_prompt", "login_finished"] as const;

export const DESKTOP_LOGIN_LIMITS = {
	/** A sign-in that has not finished by then is cancelled. */
	timeoutMs: 15 * 60_000,
	/** `set_api_key` / `remove_credentials` give up on Pi's credential store after this. */
	saveTimeoutMs: 30_000,
	/** A pasted code, an answer or a full redirect URL. */
	value: 8 * 1024,
	apiKey: 4 * 1024,
	text: 1024,
	url: 4096,
	options: 32,
	error: 300,
} as const;

const err = (code: string, message: string) => ({ code, message }) as const;
export const INVALID_LOGIN_START = err("invalid_request", "Invalid login_start parameters");
export const INVALID_LOGIN_COMPLETE = err("invalid_request", "Invalid login_complete parameters");
export const INVALID_LOGIN_CANCEL = err("invalid_request", "Invalid login_cancel parameters");
export const INVALID_SET_API_KEY = err("invalid_request", "Invalid set_api_key parameters");
export const INVALID_REMOVE_CREDENTIALS = err("invalid_request", "Invalid remove_credentials parameters");
export const LOGIN_UNAVAILABLE = err("login_unavailable", "Sign-in is not available in this session");
export const UNKNOWN_PROVIDER = err("unknown_provider", "No such provider");
export const LOGIN_UNSUPPORTED = err("login_unsupported", "This provider has no sign-in of that kind");
export const LOGIN_IN_PROGRESS = err("login_in_progress", "A sign-in to this provider is already in progress");
export const UNKNOWN_LOGIN = err("unknown_login", "No such sign-in in progress");
export const NO_PENDING_PROMPT = err("no_pending_prompt", "This sign-in is not waiting for an answer");
export const INVALID_CHOICE = err("invalid_request", "value must be one of the prompt's option ids");
export const INTERACTIVE_SETUP_REQUIRED = err("interactive_setup_required", "This provider needs more than a key; use login_start with kind api_key");
export const SAVE_FAILED = err("save_failed", "The API key could not be saved");
export const REMOVE_FAILED = err("remove_failed", "The credentials could not be removed");

/** `login_start`'s `kind`: Pi's OAuth sign-in (browser or device code), or its interactive API key setup. */
export type LoginStartKind = "oauth" | "api_key";

/** Pi's `AuthEvent` (`@earendil-works/pi-ai`), structurally: what a sign-in shows. */
export type LoginAuthEvent =
	| { type: "info"; message: string; links?: ReadonlyArray<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };

/** Pi's `AuthPrompt`, structurally: what a sign-in asks. */
export type LoginAuthPrompt = { signal?: AbortSignal } & (
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: ReadonlyArray<{ id: string; label: string; description?: string }> }
);

/** The `login_prompt` event's data. */
export interface LoginPromptEvent {
	loginId: string;
	kind: "open_url" | "device_code" | "input" | "progress";
	url?: string;
	userCode?: string;
	message?: string;
	placeholder?: string;
	/** The loopback callback the provider redirects the browser to, when the sign-in waits for that redirect. */
	redirectPrefix?: string;
	/** `input` only: mask what the user types (an API key). */
	secret?: true;
	/** `input` only: a choice; `login_complete`'s value is one option's `id`. */
	options?: Array<{ id: string; label: string }>;
}

export const LOGIN_ID = /^login_[0-9a-f]{16}$/;

function onlyKeys(params: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(params).every((key) => keys.includes(key));
}

export function parseLoginStart(params: Record<string, unknown>): { provider: string; kind?: LoginStartKind } | undefined {
	if (!onlyKeys(params, ["provider", "kind"])) return undefined;
	if (typeof params.provider !== "string" || !PROVIDER_ID.test(params.provider)) return undefined;
	if (params.kind !== undefined && params.kind !== "oauth" && params.kind !== "api_key") return undefined;
	const kind = params.kind as LoginStartKind | undefined;
	return { provider: params.provider, ...(kind === undefined ? {} : { kind }) };
}

export function parseLoginComplete(params: Record<string, unknown>): { loginId: string; value: string } | undefined {
	if (!onlyKeys(params, ["loginId", "value"])) return undefined;
	if (typeof params.loginId !== "string" || !LOGIN_ID.test(params.loginId)) return undefined;
	if (typeof params.value !== "string" || params.value.length > DESKTOP_LOGIN_LIMITS.value) return undefined;
	return { loginId: params.loginId, value: params.value };
}

export function parseLoginCancel(params: Record<string, unknown>): { loginId: string } | undefined {
	if (!onlyKeys(params, ["loginId"])) return undefined;
	if (typeof params.loginId !== "string" || !LOGIN_ID.test(params.loginId)) return undefined;
	return { loginId: params.loginId };
}

/** A key is one line of printable characters; surrounding whitespace is dropped, as a paste often carries it. */
export function parseSetApiKey(params: Record<string, unknown>): { provider: string; key: string } | undefined {
	if (!onlyKeys(params, ["provider", "key"])) return undefined;
	if (typeof params.provider !== "string" || !PROVIDER_ID.test(params.provider)) return undefined;
	if (typeof params.key !== "string") return undefined;
	const key = params.key.trim();
	// eslint-disable-next-line no-control-regex
	if (key.length === 0 || key.length > DESKTOP_LOGIN_LIMITS.apiKey || /[\u0000-\u001f\u007f]/.test(key)) return undefined;
	return { provider: params.provider, key };
}

export function parseRemoveCredentials(params: Record<string, unknown>): { provider: string } | undefined {
	if (!onlyKeys(params, ["provider"])) return undefined;
	if (typeof params.provider !== "string" || !PROVIDER_ID.test(params.provider)) return undefined;
	return { provider: params.provider };
}

/** One line of display text: control characters become spaces, bounded. */
export function boundedText(value: unknown, limit: number = DESKTOP_LOGIN_LIMITS.text): string | undefined {
	if (typeof value !== "string") return undefined;
	// eslint-disable-next-line no-control-regex
	const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
	if (text.length === 0) return undefined;
	return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function boundedUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > DESKTOP_LOGIN_LIMITS.url) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? value : undefined;
	} catch {
		return undefined;
	}
}

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/**
 * The loopback origin a URL names (`http://localhost:1455/`), when it is one:
 * the callback a browser sign-in redirects to on the machine that started it.
 */
export function loopbackPrefix(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" || !Object.hasOwn(LOOPBACK_HOSTS, url.hostname)) return undefined;
		return `${url.protocol}//${url.host}/`;
	} catch {
		return undefined;
	}
}

/** The loopback callback an authorization URL asks the provider to redirect to (`redirect_uri`, or OpenRouter's `callback_url`). */
export function redirectPrefixOf(authUrl: string): string | undefined {
	try {
		const params = new URL(authUrl).searchParams;
		return loopbackPrefix(params.get("redirect_uri")) ?? loopbackPrefix(params.get("callback_url"));
	} catch {
		return undefined;
	}
}

/** A `login_prompt` for something the sign-in shows; `undefined` for an event with nothing to show. */
export function promptForEvent(loginId: string, event: LoginAuthEvent): LoginPromptEvent | undefined {
	switch (event?.type) {
		case "auth_url": {
			const url = boundedUrl(event.url);
			if (!url) return undefined;
			const message = boundedText(event.instructions);
			const redirectPrefix = redirectPrefixOf(url);
			return { loginId, kind: "open_url", url, ...(message ? { message } : {}), ...(redirectPrefix ? { redirectPrefix } : {}) };
		}
		case "device_code": {
			const url = boundedUrl(event.verificationUri);
			const userCode = boundedText(event.userCode, 64);
			if (!url || !userCode) return undefined;
			return { loginId, kind: "device_code", url, userCode };
		}
		case "info":
		case "progress": {
			const message = boundedText(event.message);
			if (!message) return undefined;
			const link = event.type === "info" ? boundedUrl(event.links?.[0]?.url) : undefined;
			return { loginId, kind: "progress", message, ...(link ? { url: link } : {}) };
		}
		default:
			return undefined;
	}
}

/** The `login_prompt` for a question the sign-in asks; `redirectPrefix` is the open sign-in's callback, for a pasted redirect URL. */
export function promptForQuestion(loginId: string, prompt: LoginAuthPrompt, redirectPrefix: string | undefined): LoginPromptEvent {
	const message = boundedText(prompt.message) ?? "";
	if (prompt.type === "select") {
		const options = prompt.options.slice(0, DESKTOP_LOGIN_LIMITS.options).map((option) => ({ id: String(option.id), label: boundedText(option.label, 256) ?? String(option.id) }));
		return { loginId, kind: "input", message, options };
	}
	const placeholder = boundedText(prompt.placeholder, 256);
	// A pasted code races the provider's redirect to the server's own callback: say which redirect the client may intercept.
	const prefix = prompt.type === "manual_code" ? (redirectPrefix ?? loopbackPrefix(prompt.placeholder)) : undefined;
	return { loginId, kind: "input", message, ...(placeholder ? { placeholder } : {}), ...(prompt.type === "secret" ? { secret: true as const } : {}), ...(prefix ? { redirectPrefix: prefix } : {}) };
}

/** A failure's text for `login_finished`: Pi's message, one line, bounded. */
export function loginErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return boundedText(message, DESKTOP_LOGIN_LIMITS.error) ?? "Sign-in failed";
}
