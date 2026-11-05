// Golden-transcript replay for the v1 compatibility matrix (gentle-shell#2742,
// section 10). One transcript is a record sequence plus the shared defaults at
// resume; `replay` resumes it from disk under v1 or under the current modules
// and reports what a launch and the status line would see.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfile, emptyProfilesFile, profilesFilePath, setActiveProfile, writeProfilesFileSync } from "../../../lib/agent-profiles.ts";
import { localProfilePinPath, repoProfileDeclarationPath, writeProfilePinSync } from "../../../lib/agent-profile-pin.ts";
import type { AgentModelConfig } from "../../../lib/model-routing-authority.ts";
import * as currentAuthority from "../../../lib/session-profile-authority.ts";
import * as currentBinding from "../../../lib/session-profile-binding.ts";
import * as currentFreeze from "../../../lib/session-profile-freeze.ts";
import { SESSION_PROFILE_CUSTOM_TYPE } from "../../../lib/session-profile-persistence.ts";
import type { WorktreeIdentity } from "../../../lib/session-worktree-registry.ts";
import * as v1Authority from "./session-profile-authority.ts";
import * as v1Binding from "./session-profile-binding.ts";
import * as v1Freeze from "./session-profile-freeze.ts";

export interface TranscriptDefaults {
	profiles: Record<string, AgentModelConfig>;
	active?: string;
	localPin?: string;
	repoDeclaration?: string;
	/** The pin of another repository a launch may target. */
	foreignPin?: string;
}

export interface Transcript {
	/** Session-profile record payloads, oldest first, as Pi appends them. */
	records: unknown[];
	defaults: TranscriptDefaults;
	/** The resumed process environment, e.g. follow mode; empty by default. */
	env?: NodeJS.ProcessEnv;
}

export interface ReplayObservation {
	authority: boolean;
	kind: string;
	label: string | undefined;
	routing: AgentModelConfig | undefined;
	foreignRouting: AgentModelConfig | undefined;
	notice: string | undefined;
}

export type Version = "v1" | "current";

const versions = {
	v1: { authority: v1Authority, binding: v1Binding, freeze: v1Freeze },
	current: { authority: currentAuthority, binding: currentBinding, freeze: currentFreeze },
};

const SESSION_ID = "replayed-session";

function worktree(base: string, name: string): WorktreeIdentity {
	const identity = { root: join(base, name, "worktree"), commonDir: join(base, name, "git-common") };
	mkdirSync(identity.root, { recursive: true });
	mkdirSync(identity.commonDir, { recursive: true });
	return identity;
}

function writeDefaults(base: string, defaults: TranscriptDefaults) {
	const configHome = join(base, "config");
	let file = Object.entries(defaults.profiles).reduce((acc, [name, config]) => createProfile(acc, name, config), emptyProfilesFile());
	if (defaults.active !== undefined) file = setActiveProfile(file, defaults.active);
	writeProfilesFileSync(profilesFilePath(configHome), file);
	const home = worktree(base, "home");
	const foreign = worktree(base, "foreign");
	if (defaults.localPin !== undefined) writeProfilePinSync(localProfilePinPath(home.commonDir), defaults.localPin);
	if (defaults.repoDeclaration !== undefined) writeProfilePinSync(repoProfileDeclarationPath(home.root), defaults.repoDeclaration);
	if (defaults.foreignPin !== undefined) writeProfilePinSync(localProfilePinPath(foreign.commonDir), defaults.foreignPin);
	return { configHome, home, foreign };
}

function writeSession(base: string, records: unknown[]) {
	const entries = records.map((data, index) => ({
		type: "custom",
		id: `record-${index}`,
		parentId: index === 0 ? null : `record-${index - 1}`,
		timestamp: "2026-11-03T00:00:00Z",
		customType: SESSION_PROFILE_CUSTOM_TYPE,
		data,
	}));
	const file = join(base, "session.jsonl");
	const header = { type: "session", id: SESSION_ID, version: 3 };
	writeFileSync(file, [header, ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n");
	return {
		getSessionId: () => SESSION_ID,
		getSessionFile: () => file,
		getBranch: () => entries,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getHeader: () => header,
	};
}

/** Resume `transcript` under one version, with that version's process state reset first. */
export function replay(version: Version, transcript: Transcript): ReplayObservation {
	const modules = versions[version];
	const base = mkdtempSync(join(tmpdir(), `gentle-pi-v1-replay-${version}-`));
	try {
		// Both versions keep their stores on the same `Symbol.for` registries, so a
		// replay starts from an empty process and never sees the other version's state.
		for (const each of Object.values(versions)) {
			each.binding.resetSessionProfileBindingsForTesting();
			each.freeze.resetFrozenInheritedProfilesForTesting();
		}
		const { configHome, home, foreign } = writeDefaults(base, transcript.defaults);
		const manager = writeSession(base, transcript.records);
		const authority = modules.authority.readSessionProfileAuthority(manager);
		const options = { sessionId: SESSION_ID, cwd: home.root, configHome, resolveWorktree: () => home, env: transcript.env ?? {} };
		modules.freeze.freezeSessionProfileAtStartup(options);
		const resolution = modules.freeze.resolveSessionProfile(options);
		const foreignTarget = { cwd: foreign.root, configHome, resolveWorktree: () => foreign, foreignRepository: true };
		return {
			authority: authority.available,
			kind: resolution.kind,
			label: modules.freeze.sessionProfileLabel(resolution),
			routing: modules.freeze.sessionProfileRoutingAt(resolution, { ...options, foreignRepository: false }),
			foreignRouting: modules.freeze.sessionProfileRoutingAt(resolution, foreignTarget),
			notice: modules.freeze.inheritedProfileDriftNotice(options),
		};
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}
