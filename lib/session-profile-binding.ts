// Session-bound active profiles (gentle-shell#1064, slice 1).
//
// One parent Pi session may bind one saved profile for its own launches without
// touching any shared state: no clone pin (`p`), no repository declaration (`P`),
// no global routing, no materialized stores, no agent frontmatter, no Pi default
// settings. The binding is an in-process store keyed by the parent session id, so
// concurrent Pi processes are isolated by construction and a resumed session
// starts from the shared layers (`p → P → global`) until it binds again.
// Persistence across resume and reload semantics are deliberate follow-up
// slices; this module never writes a file.
//
// Pi loads every extension entrypoint with its own Jiti instance and
// `moduleCache: false` (loader.js `loadExtensionModule`), so a module-local Map
// would be re-evaluated per entrypoint: the panel writes one copy while the
// launch, usage, and status readers hold their own empty copies
// (gentle-shell#1558). The store therefore lives on `globalThis` behind a
// `Symbol.for` key, which every evaluation of this module in one process
// resolves to the same symbol and therefore the same shared Map.
import type { AgentModelConfig } from "./model-routing-authority.ts";

/** A session's bound profile: its saved name plus the routing snapshot taken at bind time. */
export interface SessionProfileBinding {
	readonly name: string;
	readonly modelProfiles: AgentModelConfig;
}

const bindingsRegistryKey = Symbol.for("gentle-pi:session-profile-bindings");

/** The one process-wide binding store, shared across every extension entrypoint that imports this module. */
function bindingsBySession(): Map<string, SessionProfileBinding> {
	const holder = globalThis as { [bindingsRegistryKey]?: Map<string, SessionProfileBinding> };
	(holder[bindingsRegistryKey] ??= new Map());
	return holder[bindingsRegistryKey]!;
}

/** Copy one routing snapshot level deep — the layer a defensive copy needs, so a binding never aliases its source or its readers. */
function cloneProfiles(profiles: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(Object.entries(profiles).map(([agent, entry]) => [agent, { ...entry }]));
}

/**
 * Bind (or rebind) one parent session to a profile. The routing snapshot is
 * copied, so later edits to the caller's object or to the saved profile
 * definition never mutate a session that already bound it; refreshing a bound
 * session requires an explicit re-selection.
 */
export function bindSessionProfile(sessionId: string, name: string, modelProfiles: AgentModelConfig): void {
	bindingsBySession().set(sessionId, { name, modelProfiles: cloneProfiles(modelProfiles) });
}

/**
 * Read a session's binding as a private copy. Returns `undefined` for unknown,
 * cleared, or undefined session ids: an unbound session keeps resolving the
 * shared layers exactly as before.
 */
export function readSessionProfileBinding(sessionId: string | undefined): SessionProfileBinding | undefined {
	if (sessionId === undefined) return undefined;
	const binding = bindingsBySession().get(sessionId);
	return binding === undefined ? undefined : { name: binding.name, modelProfiles: cloneProfiles(binding.modelProfiles) };
}

/** Remove one session's binding without touching any other session's. */
export function clearSessionProfileBinding(sessionId: string): void {
	bindingsBySession().delete(sessionId);
}

/** Testing-only reset of every binding. */
export function resetSessionProfileBindingsForTesting(): void {
	bindingsBySession().clear();
}

/**
 * The launch-time precedence for wholesale routing replacement: a session
 * binding outranks a winning pin, a pin alone still replaces, and neither
 * leaves today's routing untouched. Named so the precedence rule a launch and
 * the status display agree on lives in exactly one place.
 */
export function sessionOrPinModelProfiles(
	session: AgentModelConfig | undefined,
	pin: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
	return session ?? pin;
}
