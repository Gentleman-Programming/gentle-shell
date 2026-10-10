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
// mode the orchestrator still comes from the startup profile while children
// follow later defaults: an accepted, documented limitation.
//
// The frozen state is in-process only, like the explicit binding of slice 2: it
// lives on `globalThis` behind a `Symbol.for` key because Pi evaluates this
// module once per extension entrypoint. A resumed session (`--resume`,
// `--continue`, `--session`) therefore freezes again from the current defaults,
// and its drift memory starts empty. Persisting the freeze as a
// `gentle-pi.session-profile/v1` entry with origin `local | repo | global` is
// the integration point with slice 3b-i.
import { createHash } from "node:crypto";
import { profileRoleEntries, profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { readProfilePinStatus, resolveProfilePin, resolveUnversionedProjectProfile } from "./agent-profile-pin.ts";
import type { AgentModelConfig } from "./model-routing-authority.ts";
import { readSessionProfileBinding } from "./session-profile-binding.ts";
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
}

interface FreezeRegistry {
	frozen: Map<string, FrozenInheritedProfile>;
	// Drift fingerprints already reported, per session.
	notified: Map<string, Set<string>>;
}

const freezeRegistryKey = Symbol.for("gentle-pi:session-profile-freeze");

function registry(): FreezeRegistry {
	const holder = globalThis as { [freezeRegistryKey]?: FreezeRegistry };
	(holder[freezeRegistryKey] ??= { frozen: new Map(), notified: new Map() });
	return holder[freezeRegistryKey]!;
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
	// One worktree lookup serves both the pin layers and the non-Git check.
	let resolved = false;
	let identity: WorktreeIdentity | undefined;
	const resolveWorktree: WorktreeResolver | undefined = options.resolveWorktree === undefined ? undefined : (cwd, base) => {
		if (!resolved) {
			resolved = true;
			identity = options.resolveWorktree!(cwd, base);
		}
		return identity;
	};
	const pin = resolveProfilePin({ cwd: options.cwd, configHome: options.configHome, resolveWorktree });
	if (pin !== undefined) return { name: pin.profile, origin: pin.source, modelProfiles: pin.modelProfiles };
	if (readProfilePinStatus(options.cwd, resolveWorktree) === undefined) {
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
	return frozen === undefined ? undefined : { profile: cloneProfile(frozen.profile) };
}

function freezes(options: SessionProfileOptions): boolean {
	const env = options.env ?? process.env;
	return options.sessionId !== undefined && options.sessionId.length > 0 && !isChildSession(env) && !profileFollowEnabled(env);
}

// Only called after `freezes(options)`, which guarantees a session id.
function frozenOrFreeze(options: SessionProfileOptions): FrozenInheritedProfile {
	const store = registry().frozen;
	const sessionId = options.sessionId!;
	let frozen = store.get(sessionId);
	if (frozen === undefined) {
		frozen = { profile: cloneProfile(resolveInheritedProfile(options)) };
		store.set(sessionId, frozen);
	}
	return { profile: cloneProfile(frozen.profile) };
}

/**
 * Freeze a parent session's inherited profile at startup. Idempotent: the
 * first snapshot wins, so a session keeps it across `/reload` in the same
 * process. Children and `follow` sessions never freeze.
 */
export function freezeSessionProfileAtStartup(options: SessionProfileOptions): void {
	if (freezes(options)) frozenOrFreeze(options);
}

/**
 * The single precedence rule for launch, status and Usage. A parent session
 * that has not frozen yet freezes here, so the snapshot never depends on which
 * extension's `session_start` ran first.
 */
export function resolveSessionProfile(options: SessionProfileOptions): SessionProfileResolution {
	const explicit = readSessionProfileBinding(options.sessionId);
	if (explicit !== undefined) return { kind: "explicit", name: explicit.name, modelProfiles: explicit.modelProfiles };
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
	if (resolution.kind === "explicit") return resolution.modelProfiles;
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
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
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
	if (resolution.kind !== "inherited") return undefined;
	const current = resolveInheritedProfile(options);
	const key = fingerprint(current);
	if (key === fingerprint(resolution.profile)) return undefined;
	const notified = registry().notified;
	const seen = notified.get(options.sessionId!) ?? new Set<string>();
	if (seen.has(key)) return undefined;
	seen.add(key);
	notified.set(options.sessionId!, seen);
	return `el Gentleman: the default profile changed to ${describe(current)}, this session keeps ${describe(resolution.profile)}. Press Enter on a profile in /gentle:profiles to adopt it.`;
}

/** Testing-only reset of every frozen snapshot and drift memory. */
export function resetFrozenInheritedProfilesForTesting(): void {
	registry().frozen.clear();
	registry().notified.clear();
}
