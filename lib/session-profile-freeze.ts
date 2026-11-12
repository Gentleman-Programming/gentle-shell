// Inherited profile freeze (gentle-shell#1064 slice 3b-ii).
//
// A parent session that never pressed Enter in `/gentle:profiles` resolves the
// shared defaults `p → P → G` (local pin, repository declaration, global
// `active` in profiles.json) ONCE, at startup, and keeps that snapshot with its
// origin. Changing a default later only affects new sessions, exactly like Pi's
// "set as default" for the orchestrator model; an open session changes profile
// only through its own Enter. Each launch re-resolves the defaults to compare
// and shows one drift notice per distinct change.
//
// Precedence, the single rule every consumer reads through
// `resolveSessionProfile`:
//
//   explicit Enter binding  →  frozen inherited snapshot  →  live p → P → G
//
// The live resolution applies only in `follow` mode (GENTLE_PI_PROFILE_FOLLOW=1,
// for CI and headless runs), in subagent children (their routing comes from the
// parent through --model), and when no session id is available. In `follow`
// mode the orchestrator is still chosen at startup while children follow later
// defaults: an accepted, documented limitation.
//
// The frozen state is in-process only, like the explicit binding of slice 2: it
// lives on `globalThis` behind a `Symbol.for` key because Pi evaluates this
// module once per extension entrypoint. A resumed session (`--resume`,
// `--continue`, `--session`) therefore freezes again from the current defaults,
// and its drift memory starts empty. Persisting the freeze as a
// `gentle-pi.session-profile/v1` entry with origin `local | repo | global` is
// the integration point with slice 3b-i.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeModelConfig, normalizeRoutingEntry, readModelConfigFile, type AgentModelConfig, type AgentRoutingEntry } from "./model-routing-authority.ts";
import { profileRoleEntries, profilesFilePath, readProfileOrchestrator, readProfilesFileResult } from "./agent-profiles.ts";
import { readProfilePinStatus, resolveProfilePin, resolveUnversionedProjectProfile } from "./agent-profile-pin.ts";
import { readSessionProfileBinding, readSessionProfileStartupNone } from "./session-profile-binding.ts";
import type { SessionProfileStartupState } from "./session-profile-persistence.ts";
import type { WorktreeIdentity, WorktreeResolver } from "./session-worktree-registry.ts";

/** Opt-in that keeps the live `p → P → G` resolution instead of freezing it at startup. */
export const PROFILE_FOLLOW_ENV = "GENTLE_PI_PROFILE_FOLLOW";

/** Which shared default supplied an inherited profile. */
export type InheritedProfileOrigin = "local" | "repo" | "global";

/** A profile resolved from the shared defaults: its name, its origin, and its role routing. */
export interface InheritedProfile {
	readonly name: string;
	readonly origin: InheritedProfileOrigin;
	readonly modelProfiles: AgentModelConfig;
}

/** A frozen session: `profile` is `undefined` when no layer had a profile at startup. */
export interface FrozenInheritedProfile {
	readonly profile: InheritedProfile | undefined;
	/** The frozen orchestrator, separate from the role-only routing. */
	readonly defaultOrchestrator?: AgentRoutingEntry;
}

/**
 * The profile a session uses. `inherited` is the startup snapshot (with or
 * without a profile); `follow` and `live` carry the current defaults.
 */
export type SessionProfileResolution =
	| { kind: "explicit"; name: string; modelProfiles: AgentModelConfig }
	| { kind: "inherited"; profile: InheritedProfile | undefined }
	| { kind: "follow"; profile: InheritedProfile | undefined }
	| { kind: "live"; profile: InheritedProfile | undefined };

export interface InheritedProfileOptions {
	cwd: string;
	configHome: string;
	resolveWorktree?: WorktreeResolver;
}

export interface SessionProfileOptions extends InheritedProfileOptions {
	sessionId: string | undefined;
	env?: NodeJS.ProcessEnv;
	/** Injected only by callers that already own an authoritative startup snapshot. */
	readDefaultOrchestrator?: () => AgentRoutingEntry | undefined;
}

interface FreezeRegistry {
	frozen: Map<string, FrozenInheritedProfile>;
	// The frozen profile's full definition, orchestrator included, read in the
	// same freeze step; launch routing keeps the role-only `frozen` copy.
	definitions: Map<string, AgentModelConfig>;
	// Sessions this process froze at their own start, not at a resume.
	ownStart: Set<string>;
	orchestrators: Map<string, AgentRoutingEntry | null>;
	// Drift fingerprints already reported, per session.
	notified: Map<string, Set<string>>;
}

const freezeRegistryKey = Symbol.for("gentle-pi:session-profile-freeze");

function registry(): FreezeRegistry {
	const holder = globalThis as { [freezeRegistryKey]?: FreezeRegistry };
	(holder[freezeRegistryKey] ??= { frozen: new Map(), definitions: new Map(), ownStart: new Set(), orchestrators: new Map(), notified: new Map() });
	const store = holder[freezeRegistryKey]!;
	store.orchestrators ??= new Map();
	// An older evaluation of this module may have created the shared registry.
	store.definitions ??= new Map();
	store.ownStart ??= new Set();
	return store;
}

function cloneProfiles(profiles: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(Object.entries(profiles).map(([agent, entry]) => [agent, { ...entry }]));
}

function cloneProfile(profile: InheritedProfile | undefined): InheritedProfile | undefined {
	return profile === undefined ? undefined : { name: profile.name, origin: profile.origin, modelProfiles: cloneProfiles(profile.modelProfiles) };
}

function roleRouting(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(profileRoleEntries(config).map(([agent, entry]) => [agent, { ...entry }]));
}

export function profileFollowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PROFILE_FOLLOW_ENV] === "1";
}

function isChildSession(env: NodeJS.ProcessEnv): boolean {
	return env.GENTLE_PI_AGENTS_CHILD === "1";
}

/**
 * The shared defaults `p → P → G` for one directory, with the layer that won.
 * Pin layers keep `resolveProfilePin` semantics; outside a Git worktree the
 * repository declaration is read as admission does for non-Git projects; the
 * global layer is the `active` profile of profiles.json. The orchestrator key
 * is never part of the routing. `undefined` means no layer has a profile.
 */
export function resolveInheritedProfile(options: InheritedProfileOptions): InheritedProfile | undefined {
	// One worktree lookup serves both the pin layers and the non-Git check,
	// whether the caller passes a resolver or the pin module's default runs.
	const status = readProfilePinStatus(options.cwd, options.resolveWorktree);
	if (status !== undefined) {
		const identity: WorktreeIdentity = { root: status.root, commonDir: status.commonDir };
		const pin = resolveProfilePin({ cwd: options.cwd, configHome: options.configHome, resolveWorktree: () => identity });
		if (pin !== undefined) return { name: pin.profile, origin: pin.source, modelProfiles: pin.modelProfiles };
	} else {
		const declaration = resolveUnversionedProjectProfile(options.cwd, options.configHome);
		if (declaration !== undefined) return { name: declaration.profile, origin: "repo", modelProfiles: declaration.modelProfiles };
	}
	const store = readProfilesFileResult(profilesFilePath(options.configHome));
	if (store.status !== "valid" || store.file.active === undefined) return undefined;
	const active = store.file.active;
	if (!Object.prototype.hasOwnProperty.call(store.file.profiles, active)) return undefined;
	return { name: active, origin: "global", modelProfiles: roleRouting(store.file.profiles[active]!) };
}

/** A copy of one session's frozen snapshot, or `undefined` when it never froze. */
export function readFrozenInheritedProfile(sessionId: string | undefined): FrozenInheritedProfile | undefined {
	if (sessionId === undefined) return undefined;
	const frozen = registry().frozen.get(sessionId);
	if (frozen === undefined) return undefined;
	const defaultOrchestrator = readFrozenDefaultOrchestrator(sessionId);
	return { profile: cloneProfile(frozen.profile), ...(defaultOrchestrator ? { defaultOrchestrator } : {}) };
}

/** Capture the materialized global orchestrator once; pins only affect roles. */
function freezeDefaultOrchestrator(options: SessionProfileOptions): void {
	const id = options.sessionId;
	if (!id || isChildSession(options.env ?? process.env)) return;
	const store = registry().orchestrators;
	if (store.has(id)) return;
	const raw = options.readDefaultOrchestrator
		? options.readDefaultOrchestrator()
		: (() => {
			const result = readModelConfigFile(join(options.configHome, "models.json"));
			return result.status === "valid" ? result.config.orchestrator : undefined;
		})();
	const entry = normalizeRoutingEntry(raw);
	store.set(id, entry?.model && entry.tier ? { model: entry.model, tier: entry.tier } : null);
}

export function readFrozenDefaultOrchestrator(sessionId: string | undefined): AgentRoutingEntry | undefined {
	if (!sessionId) return undefined;
	const entry = registry().orchestrators.get(sessionId);
	return entry ? { ...entry } : undefined;
}

/** Own start and explicit Make default update only this session's snapshot. */
export function setFrozenDefaultOrchestrator(sessionId: string | undefined, value: AgentRoutingEntry | undefined): void {
	if (!sessionId) return;
	const entry = normalizeRoutingEntry(value);
	registry().orchestrators.set(sessionId, entry?.model ? {
		model: entry.model,
		...(entry.thinking === undefined ? {} : { thinking: entry.thinking }),
		...(entry.tier === undefined ? {} : { tier: entry.tier }),
	} : null);
}

function freezes(options: SessionProfileOptions): boolean {
	const env = options.env ?? process.env;
	return options.sessionId !== undefined && options.sessionId.length > 0 && !isChildSession(env) && !profileFollowEnabled(env);
}

// Only called after `freezes(options)`, which guarantees a session id.
function frozenOrFreeze(options: SessionProfileOptions): FrozenInheritedProfile {
	freezeDefaultOrchestrator(options);
	const store = registry().frozen;
	const sessionId = options.sessionId!;
	let frozen = store.get(sessionId);
	if (frozen === undefined) {
		frozen = { profile: cloneProfile(resolveInheritedProfile(options)) };
		store.set(sessionId, frozen);
		const definition = frozen.profile && startupDefinition(options, frozen.profile);
		if (definition !== undefined) registry().definitions.set(sessionId, definition);
	}
	return { profile: cloneProfile(frozen.profile) };
}

// The full definition behind a profile just frozen; `undefined` when the store
// no longer holds the role routing the freeze resolved.
function startupDefinition(options: SessionProfileOptions, profile: InheritedProfile): AgentModelConfig | undefined {
	const store = readProfilesFileResult(profilesFilePath(options.configHome));
	if (store.status !== "valid" || !Object.hasOwn(store.file.profiles, profile.name)) return undefined;
	const definition = store.file.profiles[profile.name]!;
	return stableJson(roleRouting(definition)) === stableJson(profile.modelProfiles) ? cloneProfiles(definition) : undefined;
}

/**
 * Freeze at the session's own start, a new session rather than a resume, so
 * this process knows its startup state (gentle-shell#2742, section 3).
 */
export function freezeSessionProfileAtOwnStart(options: SessionProfileOptions): void {
	freezeSessionProfileAtStartup(options);
	if (!freezes(options) || registry().ownStart.has(options.sessionId!)) return;
	registry().ownStart.add(options.sessionId!);
	const startup = readSessionProfileOwnStartup(options.sessionId);
	const orchestrator = startup && startup !== "none" ? readProfileOrchestrator(startup.modelProfiles) : undefined;
	if (orchestrator?.model) setFrozenDefaultOrchestrator(options.sessionId, orchestrator);
}

/**
 * The startup state this process froze at the session's own start, with the
 * profile's full definition; `undefined` when unknown, including a profile
 * whose definition the freeze could not capture.
 */
export function readSessionProfileOwnStartup(sessionId: string | undefined): SessionProfileStartupState | undefined {
	const frozen = sessionId === undefined ? undefined : registry().frozen.get(sessionId);
	if (frozen === undefined || !registry().ownStart.has(sessionId!)) return undefined;
	if (frozen.profile === undefined) return "none";
	const definition = registry().definitions.get(sessionId!);
	return definition && { origin: frozen.profile.origin, name: frozen.profile.name, modelProfiles: cloneProfiles(definition) };
}

/**
 * Freeze a parent session's inherited profile at startup. Idempotent: the
 * first snapshot wins, so a session keeps it across `/reload` in the same
 * process. Children and `follow` sessions never freeze.
 */
export function freezeSessionProfileAtStartup(options: SessionProfileOptions): void {
	freezeDefaultOrchestrator(options);
	if (freezes(options)) frozenOrFreeze(options);
}

/**
 * The single precedence rule for launch, status and Usage. A parent session
 * that has not frozen yet freezes here, so the snapshot never depends on which
 * extension's `session_start` ran first.
 */
export function resolveSessionProfile(options: SessionProfileOptions): SessionProfileResolution {
	const recorded = readSessionProfileBinding(options.sessionId);
	if (recorded?.origin === "user") return { kind: "explicit", name: recorded.name, modelProfiles: recorded.modelProfiles };
	// gentle-shell#2742: a startup record is the session's inherited profile,
	// taken as recorded instead of freezing again, and routed in `follow` mode
	// too, as v1 routes any bind. Like the freeze, it keeps role routing only.
	if (recorded !== undefined)
		return { kind: "inherited", profile: { name: recorded.name, origin: recorded.origin, modelProfiles: roleRouting(recorded.modelProfiles) } };
	if (freezes(options) && readSessionProfileStartupNone(options.sessionId)) return { kind: "inherited", profile: undefined };
	if (freezes(options)) return { kind: "inherited", profile: frozenOrFreeze(options).profile };
	const env = options.env ?? process.env;
	const profile = resolveInheritedProfile(options);
	return isChildSession(env) || !profileFollowEnabled(env) ? { kind: "live", profile } : { kind: "follow", profile };
}

/** The routing that replaces subagent model profiles, or `undefined` for today's routing. */
export function sessionProfileModelProfiles(resolution: SessionProfileResolution): AgentModelConfig | undefined {
	return resolution.kind === "explicit" ? resolution.modelProfiles : resolution.profile?.modelProfiles;
}

/**
 * The routing one launch target uses under a resolution read once per request.
 * Explicit and frozen profiles belong to the session, so they apply wherever
 * the launch goes, a foreign repository included; a `follow` or `live`
 * resolution reads the defaults of the target itself. A session frozen without
 * a profile has nothing to carry into a foreign repository, so that
 * repository keeps its own pin layers (local pin, then declaration), as
 * before the freeze; the global active profile is not the repository's own
 * default and does not apply there either.
 */
export function sessionProfileRoutingAt(
	resolution: SessionProfileResolution,
	target: InheritedProfileOptions & { foreignRepository?: boolean },
): AgentModelConfig | undefined {
	// A binding keeps the whole profile, the reserved orchestrator key included,
	// but launch routing returns role keys only, like the pin and global layers.
	// The provider review roles read the orchestrator from the resolution's full
	// modelProfiles (readReviewerModelConfig), not from this routing.
	if (resolution.kind === "explicit") return roleRouting(resolution.modelProfiles);
	if (resolution.kind === "inherited") {
		if (resolution.profile !== undefined || target.foreignRepository !== true) return resolution.profile?.modelProfiles;
		return resolveProfilePin(target)?.modelProfiles;
	}
	return resolveInheritedProfile(target)?.modelProfiles;
}

/** The status label, spelled as before: `name (session)`, `name (local)`, `name (repo)`, or the bare global name. */
export function sessionProfileLabel(resolution: SessionProfileResolution): string | undefined {
	if (resolution.kind === "explicit") return `${resolution.name} (session)`;
	const profile = resolution.profile;
	if (profile === undefined) return undefined;
	return profile.origin === "global" ? profile.name : `${profile.name} (${profile.origin})`;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		// Absent and `undefined` fields are the same route: a recorded snapshot
		// (gentle-shell#2742) omits what a live resolution may hold as `undefined`.
		return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

// The origin does not route anything: the same profile reached through another
// layer is not drift.
function fingerprint(profile: InheritedProfile | undefined): string {
	if (profile === undefined) return "none";
	return createHash("sha256").update(stableJson({ name: profile.name, modelProfiles: profile.modelProfiles })).digest("hex");
}

function describe(profile: InheritedProfile | undefined): string {
	return profile === undefined ? "no profile" : `"${profile.name}" (${profile.origin})`;
}

/**
 * Compare a frozen inherited session with the current defaults. Returns the
 * one-line notice the first time a given current default differs from the
 * snapshot, and `undefined` otherwise: the same change is never reported
 * twice in one session. Explicit bindings, `follow` sessions and children are
 * never compared. The comparison never adopts the new default.
 */
export function inheritedProfileDriftNotice(options: SessionProfileOptions): string | undefined {
	const resolution = resolveSessionProfile(options);
	if (resolution.kind === "explicit") return bindingDefinitionDriftNotice(options, resolution);
	if (resolution.kind !== "inherited") return undefined;
	const current = resolveInheritedProfile(options);
	const key = fingerprint(current);
	if (key === fingerprint(resolution.profile)) return undefined;
	const notified = registry().notified;
	const seen = notified.get(options.sessionId!) ?? new Set<string>();
	if (seen.has(key)) return undefined;
	seen.add(key);
	notified.set(options.sessionId!, seen);
	return `el Gentleman: the default profile changed to ${describe(current)}, this session keeps ${describe(resolution.profile)}. Open /gentle:profiles and choose Use in this session to adopt one.`;
}

// gentle-shell#2228: an explicit binding re-copies the profile definition at
// selection, so later edits to that entry in profiles.json no-op silently until
// the operator re-Enters. The same once-per-change fingerprint machine as the
// inherited notice names the drift; the comparison never adopts the edit.
function bindingDefinitionDriftNotice(
	options: SessionProfileOptions,
	resolution: { kind: "explicit"; name: string; modelProfiles: AgentModelConfig },
): string | undefined {
	const file = readProfilesFileResult(profilesFilePath(options.configHome));
	if (file.status !== "valid") return undefined;
	const definition = file.file.profiles[resolution.name];
	if (definition === undefined) return undefined;
	// Both sides normalize through the store's own route normalizer: a bound
	// snapshot taken from the panel holds normalized routes, while raw string
	// forms from other callers must hash equal to the same definition.
	const normalized = (config: AgentModelConfig) =>
		Object.fromEntries(Object.entries(config).map(([agent, route]) => [agent, normalizeModelConfig(route)]));
	const key = createHash("sha256").update(stableJson({ modelProfiles: normalized(definition) })).digest("hex");
	const current = createHash("sha256").update(stableJson({ modelProfiles: normalized(resolution.modelProfiles) })).digest("hex");
	if (key === current) return undefined;
	const notified = registry().notified;
	const seen = notified.get(options.sessionId!) ?? new Set<string>();
	if (seen.has(key)) return undefined;
	seen.add(key);
	notified.set(options.sessionId!, seen);
	return `el Gentleman: the profile definition changed to "${resolution.name}" (profiles.json), this session keeps the binding from selection. Open /gentle:profiles and choose Use in this session to adopt one.`;
}

/** Testing-only reset of every frozen snapshot and drift memory. */
export function resetFrozenInheritedProfilesForTesting(): void {
	registry().frozen.clear();
	registry().definitions.clear();
	registry().ownStart.clear();
	registry().orchestrators.clear();
	registry().notified.clear();
}
