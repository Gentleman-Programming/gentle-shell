// Per-repository agent-model profile pins.
//
// `/gentle:profiles` applies a profile globally: it rewrites `models.json`, the
// agent frontmatter, `subagents.json`, and the orchestrator in `settings.json`.
// Two repositories worked in parallel therefore fight over one global routing.
// A pin re-anchors only the subagent routing of one repository to a named profile
// from the global store, at launch time, without materialising anything:
//
//   local pin         <git-common-dir>/gentle-ai/profile-pin.json
//   repo declaration  <worktree-root>/.pi/gentle-ai/profile.json
//
// The local pin sits inside the Git common directory, so it is invisible to Git
// and shared by every worktree of the clone; the repo declaration is an ordinary
// tracked file, so a team can commit the routing a repository expects. Precedence
// is local, then repo, then no pin — and "no pin" is exactly today's behaviour, so
// an unreadable, invalid, or stale layer is skipped instead of aborting a launch.
//
// The orchestrator is deliberately out of scope: `profileRoleEntries` drops the
// reserved orchestrator key, so a pin never moves the orchestrator model.
//
// `evaluateProfilePin` is the single precedence rule. The launch resolver below and
// the `/gentle:profiles` panel both go through it, so the layer a launch uses and the
// layer the panel reports can never disagree.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isValidProfileName, profileRoleEntries, profilesFilePath, readProfilesFileResult, writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import type { AgentModelConfig } from "./model-routing-authority.ts";
import { resolveSessionWorktreeWithGit, type WorktreeIdentity, type WorktreeResolver } from "./session-worktree-registry.ts";

export const PROFILE_PIN_KIND = "gentle-pi.agent_model_profile_pin";
export const PROFILE_PIN_VERSION = 1;
// Ordered root .gitignore rules that expose only the committable declaration.
// Git cannot re-include a file while an excluded parent directory remains hidden,
// so each parent is reopened and its unrelated children are ignored again.
export const REPO_PROFILE_DECLARATION_GITIGNORE_RULES = [
	"!.pi/",
	".pi/*",
	"!.pi/gentle-ai/",
	".pi/gentle-ai/*",
	"!.pi/gentle-ai/profile.json",
] as const;

export interface AgentProfilePinFile {
	kind: typeof PROFILE_PIN_KIND;
	version: typeof PROFILE_PIN_VERSION;
	profile: string;
}

export type ProfilePinSource = "local" | "repo";

/**
 * What one pin file holds. `missing` is an absent file; `invalid` is a file that
 * exists but does not hold a pin this version understands. Collapsing the two hides
 * a broken pin behind "no pin", so the reader reports which one it found and the
 * panel can say so instead of silently changing nothing.
 */
export type ProfilePinReadResult =
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "valid"; profile: string };

/** Which pin files exist for a directory, and what each of them holds. */
export interface ProfilePinStatus {
	root: string;
	commonDir: string;
	localPath: string;
	repoPath: string;
	local: ProfilePinReadResult;
	repo: ProfilePinReadResult;
}

/** One pin layer, named by its path, without the name it stores. */
export interface ProfilePinLayerIssue {
	source: ProfilePinSource;
	path: string;
}

/** One pin layer whose stored name the profiles store no longer defines. */
export interface ProfilePinStaleIssue extends ProfilePinLayerIssue {
	profile: string;
}

/** The layer the launch resolves, when one does. */
export interface ProfilePinSelection {
	source: ProfilePinSource;
	profile: string;
	path: string;
}

/**
 * What both layers amount to: the layer that wins (if any), every layer that is not
 * a pin file, and every layer that names a profile the store dropped.
 */
export interface ProfilePinEvaluation {
	winner?: ProfilePinSelection;
	invalid: ProfilePinLayerIssue[];
	stale: ProfilePinStaleIssue[];
}

/** A pin that resolved to routing the launch will actually use. */
export interface ProfilePinResolution extends ProfilePinSelection {
	modelProfiles: AgentModelConfig;
	/** Both layers as they were read, so a caller can report what was skipped and why. */
	status: ProfilePinStatus;
	invalidLayers: ProfilePinLayerIssue[];
	staleLayers: ProfilePinStaleIssue[];
}

export function localProfilePinPath(commonDir: string): string {
	return join(commonDir, "gentle-ai", "profile-pin.json");
}

export function repoProfileDeclarationPath(worktreeRoot: string): string {
	return join(worktreeRoot, ".pi", "gentle-ai", "profile.json");
}

// Fixed key order plus a trailing newline keeps the artifact byte-identical for the
// same profile, so a committed declaration does not churn on every write.
export function serializeProfilePin(profile: string): string {
	const file: AgentProfilePinFile = {
		kind: PROFILE_PIN_KIND,
		version: PROFILE_PIN_VERSION,
		profile,
	};
	return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Value-level normalizer: the profile name a parsed pin file holds, or `undefined`
 * when the value is not a pin this version understands. The text parser below reuses
 * it, so a value and its serialized text can never disagree about what is a pin.
 */
export function normalizeProfilePin(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== PROFILE_PIN_KIND || record.version !== PROFILE_PIN_VERSION) {
		return undefined;
	}
	// Only a store-legal profile name can ever resolve, so an unparseable name is
	// rejected here rather than reaching the store lookup.
	if (!isValidProfileName(record.profile)) return undefined;
	return record.profile;
}

export type ProfilePinParseResult =
	| { status: "valid"; profile: string }
	| { status: "invalid" };

export function parseProfilePinText(text: string): ProfilePinParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { status: "invalid" };
	}
	const profile = normalizeProfilePin(value);
	return profile === undefined ? { status: "invalid" } : { status: "valid", profile };
}

export function readProfilePinResult(path: string): ProfilePinReadResult {
	if (!existsSync(path)) return { status: "missing" };
	try {
		return parseProfilePinText(readFileSync(path, "utf8"));
	} catch {
		// A file that exists but cannot be read is not "no pin": it is a broken pin.
		return { status: "invalid" };
	}
}

/**
 * The stored name, or `undefined` for both "missing" and "invalid". Prefer
 * `readProfilePinResult` where the difference matters; this stays for callers that
 * only want the name.
 */
export function readProfilePin(path: string): string | undefined {
	const result = readProfilePinResult(path);
	return result.status === "valid" ? result.profile : undefined;
}

let profilePinWorktreeResolver: WorktreeResolver = resolveSessionWorktreeWithGit;

/**
 * Test seam, mirroring the other injectable seams in `lib/`: the `/gentle:profiles`
 * panel resolves the pin through the ambient resolver, and a test must not depend
 * on where the test runner's working directory happens to sit. The launch path
 * passes its own resolver instead, so it needs no seam.
 */
export function setProfilePinWorktreeResolverForTesting(resolver?: WorktreeResolver): void {
	profilePinWorktreeResolver = resolver ?? resolveSessionWorktreeWithGit;
}

function gentlePiWorktreeIdentity(
	cwd: string,
	resolveWorktree: WorktreeResolver,
): WorktreeIdentity | undefined {
	let identity: WorktreeIdentity | undefined;
	try {
		identity = resolveWorktree(cwd, cwd);
	} catch {
		identity = undefined;
	}
	return identity;
}

/**
 * Read both pin layers for a directory. This never throws and never writes: an
 * absent, unreadable, or invalid pin file is reported as such, so a broken pin
 * cannot block the panel or a launch.
 */
export function readProfilePinStatus(
	cwd: string,
	resolveWorktree: WorktreeResolver = profilePinWorktreeResolver,
): ProfilePinStatus | undefined {
	const identity = gentlePiWorktreeIdentity(cwd, resolveWorktree);
	if (!identity) return undefined;
	const localPath = localProfilePinPath(identity.commonDir);
	const repoPath = repoProfileDeclarationPath(identity.root);
	return {
		root: identity.root,
		commonDir: identity.commonDir,
		localPath,
		repoPath,
		local: readProfilePinResult(localPath),
		repo: readProfilePinResult(repoPath),
	};
}

export function writeProfilePinSync(path: string, profile: string): void {
	if (!isValidProfileName(profile)) {
		throw new Error(`Invalid profile name: ${JSON.stringify(profile)}.`);
	}
	writeJsonFileAtomicallySync(path, serializeProfilePin(profile));
}

/**
 * Remove one pin layer. Pinning is a toggle: the key that sets a layer clears the
 * same layer, and a missing file is already the desired state.
 */
export function clearProfilePinSync(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function hasProfile(profiles: Record<string, unknown>, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(profiles, name);
}

function profilePinLayers(
	status: ProfilePinStatus,
): Array<{ source: ProfilePinSource; path: string; read: ProfilePinReadResult }> {
	return [
		{ source: "local", path: status.localPath, read: status.local },
		{ source: "repo", path: status.repoPath, read: status.repo },
	];
}

/**
 * The single precedence rule, shared by the launch resolver and the panel: the first
 * layer, in local-then-repo order, whose file holds a legal name the store still
 * defines wins. Everything else is reported instead of hidden, so the panel can name
 * a file that is not a pin (`invalid`) separately from a name the store dropped
 * (`stale`), and neither masks a lower layer that does resolve.
 */
export function evaluateProfilePin(
	status: ProfilePinStatus | undefined,
	profiles: Record<string, unknown>,
): ProfilePinEvaluation {
	const evaluation: ProfilePinEvaluation = { invalid: [], stale: [] };
	if (!status) return evaluation;
	for (const layer of profilePinLayers(status)) {
		if (layer.read.status === "missing") continue;
		if (layer.read.status === "invalid") {
			evaluation.invalid.push({ source: layer.source, path: layer.path });
			continue;
		}
		if (evaluation.winner !== undefined) {
			// Precedence is already decided; the lower layer is only reported.
			if (!hasProfile(profiles, layer.read.profile)) {
				evaluation.stale.push({ source: layer.source, path: layer.path, profile: layer.read.profile });
			}
			continue;
		}
		if (hasProfile(profiles, layer.read.profile)) {
			evaluation.winner = { source: layer.source, profile: layer.read.profile, path: layer.path };
		} else {
			evaluation.stale.push({ source: layer.source, path: layer.path, profile: layer.read.profile });
		}
	}
	return evaluation;
}

export interface ProfilePinResolveOptions {
	cwd: string;
	configHome: string;
	resolveWorktree?: WorktreeResolver;
}

/**
 * The routing a launch should use, or `undefined` when no pin applies.
 *
 * Layers are tried in precedence order by `evaluateProfilePin`, and the first usable
 * one wins: the pin file holds a legal name AND the global store still defines that
 * profile. Everything else — no pin file, invalid JSON, a name the store no longer
 * defines — is skipped, so a stale local pin cannot mask a valid repository
 * declaration and a stale chain degrades to today's global routing. The resolution
 * also carries both layers as read, so a caller can report what was skipped.
 */
export function resolveProfilePin(
	options: ProfilePinResolveOptions,
): ProfilePinResolution | undefined {
	const status = readProfilePinStatus(options.cwd, options.resolveWorktree);
	if (!status) return undefined;
	if (status.local.status === "missing" && status.repo.status === "missing") return undefined;
	const store = readProfilesFileResult(profilesFilePath(options.configHome));
	const profiles: Record<string, AgentModelConfig> = store.status === "valid" ? store.file.profiles : {};
	const evaluation = evaluateProfilePin(status, profiles);
	const winner = evaluation.winner;
	if (winner === undefined) return undefined;
	const config = profiles[winner.profile];
	if (config === undefined) return undefined;
	return {
		source: winner.source,
		profile: winner.profile,
		path: winner.path,
		modelProfiles: Object.fromEntries(
			profileRoleEntries(config).map(([agent, entry]) => [agent, { ...entry }]),
		),
		status,
		invalidLayers: evaluation.invalid,
		staleLayers: evaluation.stale,
	};
}
