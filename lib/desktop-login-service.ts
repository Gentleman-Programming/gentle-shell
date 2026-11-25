// Gentle Desktop sign-in bridge: `login_start` / `login_complete` /
// `login_cancel` run Pi's own provider sign-in for a client on another device,
// and `set_api_key` / `remove_credentials` save or remove a stored credential.
//
// Everything goes through Pi's model runtime, the one `/login` and `/logout`
// use (`ModelRuntime.login` / `logout`, behind the session's
// `ctx.modelRegistry`): the provider's own flow, Pi's credential store
// (`auth.json`, owner-only), and Pi's synchronization of the provider's models.
// Then the session's registry is refreshed as `reload_credentials` does, so the
// new models are available without a restart.
//
// The flow's interaction is what crosses: each thing Pi's login dialog would
// show is a `login_prompt` event, and each question waits for the client's
// `login_complete`. A browser sign-in whose provider redirects to a loopback
// callback (`http://localhost:1455/…`) on this machine cannot reach it from the
// client's browser: the client intercepts that redirect and sends the full URL
// as the answer to the paste prompt Pi raises beside its callback, and Pi
// completes the exchange exactly as its callback would.

import { randomBytes } from "node:crypto";
import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	DESKTOP_LOGIN_LIMITS,
	INTERACTIVE_SETUP_REQUIRED,
	INVALID_CHOICE,
	INVALID_LOGIN_CANCEL,
	INVALID_LOGIN_COMPLETE,
	INVALID_LOGIN_START,
	INVALID_REMOVE_CREDENTIALS,
	INVALID_SET_API_KEY,
	LOGIN_IN_PROGRESS,
	LOGIN_UNAVAILABLE,
	LOGIN_UNSUPPORTED,
	loginErrorText,
	NO_PENDING_PROMPT,
	parseLoginCancel,
	parseLoginComplete,
	parseLoginStart,
	parseRemoveCredentials,
	parseSetApiKey,
	promptForEvent,
	promptForQuestion,
	redirectPrefixOf,
	REMOVE_FAILED,
	SAVE_FAILED,
	UNKNOWN_LOGIN,
	UNKNOWN_PROVIDER,
	type LoginAuthEvent,
	type LoginAuthPrompt,
	type LoginStartKind,
} from "./desktop-rpc-login.ts";

/** Pi's `AuthInteraction`, structurally. */
export interface LoginInteraction {
	signal: AbortSignal;
	prompt(prompt: LoginAuthPrompt): Promise<string>;
	notify(event: LoginAuthEvent): void;
}

/** Pi's provider definition: only which sign-ins it has is read. */
export interface LoginProviderDefinition {
	auth?: { oauth?: unknown; apiKey?: { login?: unknown } };
}

/** The part of Pi's `ModelRuntime` this bridge drives. */
export interface LoginRuntime {
	getProvider(providerId: string): LoginProviderDefinition | undefined;
	login(providerId: string, type: LoginStartKind, interaction: LoginInteraction, options?: { getDeviceId?: () => string }): Promise<unknown>;
	logout(providerId: string, options?: { signal?: AbortSignal }): Promise<void>;
	listCredentials(options?: { signal?: AbortSignal }): Promise<ReadonlyArray<{ providerId: string }>>;
}

export type DesktopLoginEmit = (event: string, data: Record<string, unknown>) => void;

export interface DesktopLoginOptions {
	/** A sign-in that has not finished by then is cancelled (15 minutes). */
	timeoutMs?: number;
	newLoginId?: () => string;
}

function isLoginRuntime(value: unknown): value is LoginRuntime {
	const runtime = value as Partial<LoginRuntime> | undefined;
	return !!runtime && typeof runtime.getProvider === "function" && typeof runtime.login === "function"
		&& typeof runtime.logout === "function" && typeof runtime.listCredentials === "function";
}

/** Pi's `CredentialSynchronizationError`: the credential was saved, only the local model refresh failed. */
function credentialsCommitted(error: unknown): boolean {
	return error instanceof Error && error.name === "CredentialSynchronizationError";
}

interface PendingPrompt {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	options?: ReadonlySet<string>;
}

interface ActiveLogin {
	loginId: string;
	provider: string;
	controller: AbortController;
	timer: NodeJS.Timeout;
	pending?: PendingPrompt;
	/** The loopback callback of the last authorization URL, for a pasted redirect. */
	redirectPrefix?: string;
	/** Why the flow was aborted, when it was. */
	ended?: string;
}

/** Where a session's sign-ins go: its model registry (for the reload) and Pi's runtime behind it. */
interface SessionAuth {
	runtime: LoginRuntime;
	refresh: () => Promise<unknown>;
	deviceId: () => string;
}

export class DesktopLoginBridge {
	private host: ExtensionContext | undefined;
	private emit: DesktopLoginEmit | undefined;
	private generation = 0;
	private readonly logins = new Map<string, ActiveLogin>();
	/** Providers with a sign-in, a key save or a removal under way: one at a time per provider. */
	private readonly busy = new Set<string>();
	private readonly timeoutMs: number;
	private readonly newLoginId: () => string;

	constructor(options: DesktopLoginOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? DESKTOP_LOGIN_LIMITS.timeoutMs;
		this.newLoginId = options.newLoginId ?? (() => `login_${randomBytes(8).toString("hex")}`);
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	wire(emit: DesktopLoginEmit): void {
		this.emit = emit;
	}

	/** A session change ends every sign-in still running; its events would reach no one. */
	reset(): void {
		this.generation += 1;
		this.host = undefined;
		this.emit = undefined;
		for (const login of [...this.logins.values()]) this.end(login, "The session ended");
	}

	private session(): SessionAuth | undefined {
		const host = this.host;
		try {
			const registry = (host as { modelRegistry?: unknown } | undefined)?.modelRegistry as { runtime?: unknown; refresh?: (options: { allowNetwork: boolean }) => Promise<unknown> } | undefined;
			const runtime = registry?.runtime;
			if (!isLoginRuntime(runtime) || typeof registry?.refresh !== "function") return undefined;
			const cwd = host!.cwd;
			return {
				runtime,
				// `reload_credentials` semantics: rebuild which providers are configured, never fetch a catalog.
				refresh: () => registry.refresh!({ allowNetwork: false }),
				// The stable id of this installation, which OpenAI's sign-in sends; Pi's own `/login` uses the same.
				deviceId: () => SettingsManager.create(cwd, getAgentDir()).getOrCreateDeviceId(),
			};
		} catch {
			return undefined;
		}
	}

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | Promise<DesktopRpcOutcome> | undefined {
		switch (method) {
			case "login_start": return this.start(params);
			case "login_complete": return this.complete(params);
			case "login_cancel": return this.cancel(params);
			case "set_api_key": return this.setApiKey(params);
			case "remove_credentials": return this.removeCredentials(params);
			default: return undefined;
		}
	}

	private start(params: Record<string, unknown>): DesktopRpcOutcome {
		const request = parseLoginStart(params);
		if (!request) return { ok: false, error: INVALID_LOGIN_START };
		const session = this.session();
		if (!session) return { ok: false, error: LOGIN_UNAVAILABLE };
		let auth: LoginProviderDefinition["auth"];
		try {
			const provider = session.runtime.getProvider(request.provider);
			if (!provider) return { ok: false, error: UNKNOWN_PROVIDER };
			auth = provider.auth;
		} catch {
			return { ok: false, error: LOGIN_UNAVAILABLE };
		}
		const kind: LoginStartKind = request.kind ?? (auth?.oauth ? "oauth" : "api_key");
		if (kind === "oauth" ? !auth?.oauth : typeof auth?.apiKey?.login !== "function") return { ok: false, error: LOGIN_UNSUPPORTED };
		if (this.busy.has(request.provider)) return { ok: false, error: LOGIN_IN_PROGRESS };
		const loginId = this.newLoginId();
		const controller = new AbortController();
		const login: ActiveLogin = {
			loginId,
			provider: request.provider,
			controller,
			timer: setTimeout(() => this.end(login, "Sign-in timed out"), this.timeoutMs),
		};
		login.timer.unref?.();
		this.logins.set(loginId, login);
		this.busy.add(request.provider);
		// The flow starts after this answer is published, so `{ loginId }` precedes its first `login_prompt`.
		setImmediate(() => void this.run(login, kind, session));
		return { ok: true, data: { loginId } };
	}

	private async run(login: ActiveLogin, kind: LoginStartKind, session: SessionAuth): Promise<void> {
		const generation = this.generation;
		const send = (event: string, data: Record<string, unknown>) => {
			if (generation !== this.generation) return;
			try {
				this.emit?.(event, data);
			} catch {
				/* the transport is gone; the flow goes on */
			}
		};
		const interaction: LoginInteraction = {
			signal: login.controller.signal,
			notify: (event) => {
				if (event?.type === "auth_url" && typeof event.url === "string") login.redirectPrefix = redirectPrefixOf(event.url) ?? login.redirectPrefix;
				const data = promptForEvent(login.loginId, event);
				if (data) send("login_prompt", { ...data });
			},
			prompt: (prompt) => this.ask(login, prompt, send),
		};
		let error: string | undefined;
		if (login.controller.signal.aborted) error = login.ended;
		else {
			try {
				await session.runtime.login(login.provider, kind, interaction, { getDeviceId: session.deviceId });
			} catch (failure) {
				if (!credentialsCommitted(failure)) error = login.ended ?? loginErrorText(failure);
			}
		}
		clearTimeout(login.timer);
		this.drop(login);
		if (error === undefined) {
			try {
				await session.refresh();
			} catch {
				/* the credential is saved; the next reload_credentials picks it up */
			}
		}
		send("login_finished", { loginId: login.loginId, provider: login.provider, ok: error === undefined, ...(error === undefined ? {} : { error }) });
	}

	/** One question of the flow: a `login_prompt` now, the answer when `login_complete` brings it. */
	private ask(login: ActiveLogin, prompt: LoginAuthPrompt, send: DesktopLoginEmit): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		if (login.controller.signal.aborted || !this.logins.has(login.loginId)) {
			reject(new Error(login.ended ?? "Sign-in cancelled"));
			return promise;
		}
		// Pi asks one question at a time; a new one replaces any left unanswered.
		login.pending?.reject(new Error("Superseded by another question"));
		const pending: PendingPrompt = {
			resolve,
			reject,
			...(prompt.type === "select" ? { options: new Set(prompt.options.map((option) => String(option.id))) } : {}),
		};
		login.pending = pending;
		// The flow withdraws a question it no longer needs (its own callback received the redirect first).
		prompt.signal?.addEventListener("abort", () => {
			if (login.pending === pending) login.pending = undefined;
			reject(new Error("Sign-in cancelled"));
		}, { once: true });
		send("login_prompt", { ...promptForQuestion(login.loginId, prompt, login.redirectPrefix) });
		return promise;
	}

	private complete(params: Record<string, unknown>): DesktopRpcOutcome {
		const request = parseLoginComplete(params);
		if (!request) return { ok: false, error: INVALID_LOGIN_COMPLETE };
		const login = this.logins.get(request.loginId);
		if (!login) return { ok: false, error: UNKNOWN_LOGIN };
		const pending = login.pending;
		if (!pending) return { ok: false, error: NO_PENDING_PROMPT };
		if (pending.options && !pending.options.has(request.value)) return { ok: false, error: INVALID_CHOICE };
		login.pending = undefined;
		pending.resolve(request.value);
		return { ok: true, data: { accepted: true } };
	}

	private cancel(params: Record<string, unknown>): DesktopRpcOutcome {
		const request = parseLoginCancel(params);
		if (!request) return { ok: false, error: INVALID_LOGIN_CANCEL };
		const login = this.logins.get(request.loginId);
		if (!login) return { ok: false, error: UNKNOWN_LOGIN };
		this.end(login, "Sign-in cancelled");
		return { ok: true, data: { cancelled: true } };
	}

	/** Aborts a sign-in; its flow then finishes with `reason` as the error. */
	private end(login: ActiveLogin, reason: string): void {
		if (login.ended !== undefined) return;
		login.ended = reason;
		clearTimeout(login.timer);
		const pending = login.pending;
		login.pending = undefined;
		pending?.reject(new Error(reason));
		login.controller.abort(new Error(reason));
	}

	private drop(login: ActiveLogin): void {
		if (this.logins.get(login.loginId) !== login) return;
		this.logins.delete(login.loginId);
		this.busy.delete(login.provider);
	}

	/**
	 * Saves an API key through the provider's own key setup (`apiKey.login`), the
	 * path `/login` takes: Pi stores it in its owner-only credential file and
	 * synchronizes the provider. A setup that asks for more than the key is
	 * refused; `login_start` with `kind: "api_key"` runs it interactively.
	 */
	private async setApiKey(params: Record<string, unknown>): Promise<DesktopRpcOutcome> {
		const request = parseSetApiKey(params);
		if (!request) return { ok: false, error: INVALID_SET_API_KEY };
		const session = this.session();
		if (!session) return { ok: false, error: LOGIN_UNAVAILABLE };
		let provider: LoginProviderDefinition | undefined;
		try {
			provider = session.runtime.getProvider(request.provider);
		} catch {
			return { ok: false, error: LOGIN_UNAVAILABLE };
		}
		if (!provider) return { ok: false, error: UNKNOWN_PROVIDER };
		if (typeof provider.auth?.apiKey?.login !== "function") return { ok: false, error: LOGIN_UNSUPPORTED };
		if (this.busy.has(request.provider)) return { ok: false, error: LOGIN_IN_PROGRESS };
		this.busy.add(request.provider);
		let keyGiven = false;
		let askedMore = false;
		try {
			await session.runtime.login(request.provider, "api_key", {
				signal: AbortSignal.timeout(DESKTOP_LOGIN_LIMITS.saveTimeoutMs),
				notify: () => {},
				prompt: async (prompt) => {
					if (prompt.type === "secret" && !keyGiven) {
						keyGiven = true;
						return request.key;
					}
					askedMore = true;
					throw new Error("This provider asks for more than a key");
				},
			});
		} catch (error) {
			// Pi's message may quote the provider's answer; the key is never echoed, so nothing of it crosses.
			if (!credentialsCommitted(error)) return { ok: false, error: askedMore || !keyGiven ? INTERACTIVE_SETUP_REQUIRED : SAVE_FAILED };
		} finally {
			this.busy.delete(request.provider);
		}
		await session.refresh().catch(() => undefined);
		return { ok: true, data: { saved: true } };
	}

	/** `/logout`: removes what Pi stored for the provider (a sign-in or a key); environment variables and models.json stay. */
	private async removeCredentials(params: Record<string, unknown>): Promise<DesktopRpcOutcome> {
		const request = parseRemoveCredentials(params);
		if (!request) return { ok: false, error: INVALID_REMOVE_CREDENTIALS };
		const session = this.session();
		if (!session) return { ok: false, error: LOGIN_UNAVAILABLE };
		if (this.busy.has(request.provider)) return { ok: false, error: LOGIN_IN_PROGRESS };
		this.busy.add(request.provider);
		try {
			const signal = AbortSignal.timeout(DESKTOP_LOGIN_LIMITS.saveTimeoutMs);
			const stored = (await session.runtime.listCredentials({ signal })).some((entry) => entry?.providerId === request.provider);
			if (!stored) return { ok: true, data: { removed: false } };
			try {
				await session.runtime.logout(request.provider, { signal });
			} catch (error) {
				if (!credentialsCommitted(error)) return { ok: false, error: REMOVE_FAILED };
			}
		} catch {
			return { ok: false, error: REMOVE_FAILED };
		} finally {
			this.busy.delete(request.provider);
		}
		await session.refresh().catch(() => undefined);
		return { ok: true, data: { removed: true } };
	}
}
