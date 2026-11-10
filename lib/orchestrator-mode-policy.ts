// Effective orchestrator workflow mode (full-delegation-mode S2/S7).
//
// Pure resolver, extracted so the prompt builder can read the mode without
// owning profile plumbing. No pi imports belong in this file.
//
// Resolution order (first hit wins):
//   1. Env `GENTLE_PI_ORCHESTRATOR_MODE` ("organic" | "full-delegation")
//   2. The session's profile, read live through `resolveSessionProfile`
//   3. Default "organic"
//
// The profile is READ LIVE on every call, never from the startup freeze: the
// whole point of a per-profile switch is that pressing Enter on another profile
// changes the orchestrator's rules on the next turn, in both directions. The
// freeze pins the `inherited` defaults so a shared default changed mid-session
// does not silently re-route work; it is not meant to pin the profile a session
// deliberately switched to, and `resolveSessionProfile` already returns an
// explicit `origin: "user"` binding before any frozen snapshot.
//
// The env override is deliberate and reported: an ambient override that changes
// behaviour while the panel shows something else is exactly the "I edited it and
// nothing happened" trap, so `source` is part of the result and the panel shows
// it rather than re-deriving it.

import { profilesFilePath, readProfileWorkflow, readProfilesFileResult, DEFAULT_ORCHESTRATOR_MODE, type OrchestratorMode } from "./agent-profiles.ts";
import { resolveSessionProfile } from "./session-profile-freeze.ts";

export const ORCHESTRATOR_MODE_ENV = "GENTLE_PI_ORCHESTRATOR_MODE";

/** Which layer decided the effective mode. */
export type OrchestratorModeSource = "environment" | "session_profile" | "default";

export interface OrchestratorModeResolution {
	mode: OrchestratorMode;
	source: OrchestratorModeSource;
	/** The profile that was consulted, when the session had one. */
	profileName?: string;
	/** The raw env value, reported even when it is unrecognized and inert. */
	envValue?: string;
}

export interface ResolveOrchestratorModeOptions {
	cwd: string;
	/** Gentle Pi config home directory (honors GENTLE_PI_CONFIG_HOME at the call site). */
	configHome: string;
	sessionId: string | undefined;
	/** Override the environment lookup (used in tests). */
	env?: NodeJS.ProcessEnv;
}

/** The profile name a session resolution points at, or undefined for no profile. */
function resolvedProfileName(resolution: ReturnType<typeof resolveSessionProfile>): string | undefined {
	return resolution.kind === "explicit" ? resolution.name : resolution.profile?.name;
}

/**
 * The mode a profile stores, or the raised default when the store cannot
 * answer. Never throws: this runs inside the prompt build, and a broken store
 * must degrade to today's behaviour instead of breaking the orchestrator.
 */
function modeFromProfile(configHome: string, profileName: string): OrchestratorMode {
	try {
		const read = readProfilesFileResult(profilesFilePath(configHome));
		if (read.status !== "valid") return DEFAULT_ORCHESTRATOR_MODE;
		return readProfileWorkflow(read.file, profileName).orchestratorMode;
	} catch {
		return DEFAULT_ORCHESTRATOR_MODE;
	}
}

export function resolveOrchestratorMode(
	options: ResolveOrchestratorModeOptions,
): OrchestratorModeResolution {
	const env = options.env ?? process.env;
	const envValue = env[ORCHESTRATOR_MODE_ENV];
	const overridden = envValue === "organic" || envValue === "full-delegation";
	let profileName: string | undefined;
	try {
		profileName = resolvedProfileName(
			resolveSessionProfile({
				cwd: options.cwd,
				configHome: options.configHome,
				sessionId: options.sessionId,
				...(options.env === undefined ? {} : { env: options.env }),
			}),
		);
	} catch {
		// A profile layer that cannot answer leaves the session in today's mode;
		// it must not take the prompt build down with it.
		profileName = undefined;
	}
	const reported = {
		...(profileName === undefined ? {} : { profileName }),
		...(envValue === undefined ? {} : { envValue }),
	};
	if (overridden) return { mode: envValue, source: "environment", ...reported };
	if (profileName !== undefined) {
		return { mode: modeFromProfile(options.configHome, profileName), source: "session_profile", ...reported };
	}
	return { mode: DEFAULT_ORCHESTRATOR_MODE, source: "default", ...reported };
}

/** Whether the effective mode requires the supervisor-only workflow. */
export function isFullDelegationMode(resolution: OrchestratorModeResolution): boolean {
	return resolution.mode === "full-delegation";
}
