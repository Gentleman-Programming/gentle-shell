// Gentle Desktop credential-status slice: the pure contract shared by the
// Desktop bridge (`lib/desktop-auth-service.ts`) and Pi's model registry.
//
// It answers which providers have credentials and of which kind, never a
// value. The only registry calls it makes are the ones that cannot return a
// secret: `getAll` (models, for provider ids), `getProviderAuthStatus`
// (`{ configured, source }`, from Pi's in-memory snapshot), `isUsingOAuth`,
// `getProviderDisplayName`, and `refresh`. It never calls `getApiKey*` or
// `getProviderAuth`, never reads `auth.json`, and never forwards a status
// `label` (an environment variable name or source text) or an error message.

export const DESKTOP_AUTH_METHODS = ["get_auth_status", "reload_credentials"] as const;
/** Every answer carries the provider list; this slice advertises no event. */
export const DESKTOP_AUTH_EVENTS = [] as const;

export const INVALID_GET_AUTH_STATUS = { code: "invalid_request", message: "Invalid get_auth_status parameters" } as const;
export const INVALID_RELOAD_CREDENTIALS = { code: "invalid_request", message: "Invalid reload_credentials parameters" } as const;
export const AUTH_UNAVAILABLE = { code: "auth_unavailable", message: "Credential status unavailable" } as const;
export const RELOAD_FAILED = { code: "reload_failed", message: "Credentials could not be reloaded" } as const;

export const DESKTOP_AUTH_LIMITS = { providers: 200, displayName: 128 } as const;

/** Provider ids that may cross the wire; anything else is skipped. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type CredentialType = "oauth" | "api_key";
export type CredentialSource = "stored" | "runtime" | "environment" | "models_json" | "extension";

export interface DesktopProviderAuth {
	provider: string;
	displayName: string;
	configured: boolean;
	/** `oauth` or `api_key` when configured, otherwise `null`. */
	type: CredentialType | null;
	source: CredentialSource | null;
}

export interface DesktopAuthStatus {
	providers: DesktopProviderAuth[];
	truncated: boolean;
}

/** The registry surface this slice uses: none of these return a credential. */
export interface DesktopAuthRegistry {
	getAll(): ReadonlyArray<{ provider: string }>;
	getProviderAuthStatus(provider: string): { configured: boolean; source?: string };
	getProviderDisplayName?(provider: string): string;
	isUsingOAuth(model: { provider: string }): boolean;
	refresh(options?: { allowNetwork?: boolean }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, unknown> }>;
}

export function isDesktopAuthRegistry(value: unknown): value is DesktopAuthRegistry {
	if (!value || typeof value !== "object") return false;
	const registry = value as Partial<DesktopAuthRegistry>;
	return typeof registry.getAll === "function" && typeof registry.getProviderAuthStatus === "function"
		&& typeof registry.isUsingOAuth === "function" && typeof registry.refresh === "function";
}

export const parseEmptyParams = (params: Record<string, unknown>): boolean => Object.keys(params).length === 0;

const SOURCES: Readonly<Record<string, CredentialSource>> = {
	stored: "stored",
	runtime: "runtime",
	environment: "environment",
	// A key or a command in models.json: which one, and the command itself, never cross.
	models_json_key: "models_json",
	models_json_command: "models_json",
	fallback: "extension",
};

function displayName(registry: DesktopAuthRegistry, provider: string): string {
	try {
		const name = registry.getProviderDisplayName?.(provider);
		if (typeof name === "string" && name.trim().length > 0) {
			const trimmed = name.trim();
			return trimmed.length > DESKTOP_AUTH_LIMITS.displayName ? trimmed.slice(0, DESKTOP_AUTH_LIMITS.displayName) : trimmed;
		}
	} catch { /* the id is a fine name */ }
	return provider;
}

/** One row per provider that has models, sorted by id, from the registry's safe reads only. */
export function projectAuthStatus(registry: DesktopAuthRegistry): DesktopAuthStatus {
	const firstModel = new Map<string, { provider: string }>();
	for (const model of registry.getAll()) {
		if (typeof model?.provider === "string" && PROVIDER_ID.test(model.provider) && !firstModel.has(model.provider)) firstModel.set(model.provider, model);
	}
	const ids = [...firstModel.keys()].sort();
	const providers = ids.slice(0, DESKTOP_AUTH_LIMITS.providers).map((provider): DesktopProviderAuth => {
		const status = registry.getProviderAuthStatus(provider);
		const configured = status?.configured === true;
		const source = configured && typeof status.source === "string" && Object.hasOwn(SOURCES, status.source) ? SOURCES[status.source]! : null;
		let type: CredentialType | null = null;
		if (configured) type = registry.isUsingOAuth(firstModel.get(provider)!) ? "oauth" : "api_key";
		return { provider, displayName: displayName(registry, provider), configured, type, source };
	});
	return { providers, truncated: ids.length > DESKTOP_AUTH_LIMITS.providers };
}

/** Provider ids of a refresh's errors map; the errors themselves never cross. */
export function failedProviderIds(errors: ReadonlyMap<string, unknown>): string[] {
	return [...errors.keys()].filter((id) => PROVIDER_ID.test(id)).sort().slice(0, DESKTOP_AUTH_LIMITS.providers);
}
