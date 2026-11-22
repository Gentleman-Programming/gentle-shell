// Gentle Desktop credential-status bridge: answers `get_auth_status` and
// `reload_credentials` from the session's own model registry
// (`ctx.modelRegistry`) and projects it with `lib/desktop-rpc-auth.ts`.
//
// `reload_credentials` calls `modelRegistry.refresh({ allowNetwork: false })`:
// Pi rebuilds which providers are configured and which models are available
// from its credential store, environment, and models.json, so a sign-in made by
// another process shows up without restarting the session. Credentials
// themselves are already re-read by Pi on each request. Concurrent reloads
// share one refresh.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	AUTH_UNAVAILABLE,
	failedProviderIds,
	INVALID_GET_AUTH_STATUS,
	INVALID_RELOAD_CREDENTIALS,
	isDesktopAuthRegistry,
	parseEmptyParams,
	projectAuthStatus,
	RELOAD_FAILED,
	type DesktopAuthRegistry,
} from "./desktop-rpc-auth.ts";

/**
 * The Desktop domain slice for credential status. No event and no write: the
 * credential store is Pi's, and sign-in and sign-out stay out of scope. A reset
 * drops the bound context and the answer of any call that started before it.
 */
export class DesktopAuthBridge {
	private host: ExtensionContext | undefined;
	private generation = 0;
	private inFlight: { registry: DesktopAuthRegistry; run: Promise<{ aborted: boolean; errors: ReadonlyMap<string, unknown> }> } | undefined;

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.generation += 1;
		this.host = undefined;
	}

	private registry(): DesktopAuthRegistry | undefined {
		const registry = (this.host as { modelRegistry?: unknown } | undefined)?.modelRegistry;
		return isDesktopAuthRegistry(registry) ? registry : undefined;
	}

	async handle(method: string, params: Record<string, unknown>): Promise<DesktopRpcOutcome | undefined> {
		if (method === "get_auth_status") {
			if (!parseEmptyParams(params)) return { ok: false, error: INVALID_GET_AUTH_STATUS };
			const registry = this.registry();
			if (!registry) return { ok: false, error: AUTH_UNAVAILABLE };
			try {
				return { ok: true, data: { ...projectAuthStatus(registry) } };
			} catch {
				return { ok: false, error: AUTH_UNAVAILABLE };
			}
		}
		if (method === "reload_credentials") {
			if (!parseEmptyParams(params)) return { ok: false, error: INVALID_RELOAD_CREDENTIALS };
			const registry = this.registry();
			if (!registry) return { ok: false, error: AUTH_UNAVAILABLE };
			const generation = this.generation;
			let result: { aborted: boolean; errors: ReadonlyMap<string, unknown> };
			try {
				result = await this.sharedRefresh(registry);
			} catch {
				// A refresh failure can carry URLs or paths; none crosses.
				return { ok: false, error: RELOAD_FAILED };
			}
			if (generation !== this.generation) return { ok: false, error: AUTH_UNAVAILABLE };
			try {
				return {
					ok: true,
					// The refresh already took effect: an unexpected result shape answers
					// the reloaded state with no aborted flag and no failed ids, never unavailable.
					data: {
						reloaded: true,
						aborted: result?.aborted === true,
						failedProviders: result?.errors instanceof Map ? failedProviderIds(result.errors) : [],
						...projectAuthStatus(registry),
					},
				};
			} catch {
				return { ok: false, error: AUTH_UNAVAILABLE };
			}
		}
		return undefined;
	}

	private sharedRefresh(registry: DesktopAuthRegistry): Promise<{ aborted: boolean; errors: ReadonlyMap<string, unknown> }> {
		if (this.inFlight?.registry === registry) return this.inFlight.run;
		// Never reach the network: model catalogs are not part of a credential reload.
		const run = Promise.resolve().then(() => registry.refresh({ allowNetwork: false })).finally(() => {
			if (this.inFlight?.run === run) this.inFlight = undefined;
		});
		this.inFlight = { registry, run };
		return run;
	}
}
