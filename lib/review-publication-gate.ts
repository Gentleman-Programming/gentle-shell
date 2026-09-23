import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	publicationProbeGitEnvironment,
	reviewGitEnvironment,
} from "./review-repository.ts";

export const GATE_TARGET_KIND = {
	INTENDED_COMMIT: "intended-commit",
	PUSH: "push",
	PULL_REQUEST: "pull-request",
	RELEASE: "release",
} as const;

export type GateTargetKind =
	(typeof GATE_TARGET_KIND)[keyof typeof GATE_TARGET_KIND];

export const PUSH_UPDATE_KIND = {
	CREATE: "create",
	UPDATE: "update",
} as const;

export type PushUpdateKind =
	(typeof PUSH_UPDATE_KIND)[keyof typeof PUSH_UPDATE_KIND];

export const GATE_RESULT = {
	ALLOW: "allow",
	SCOPE_CHANGED: "scope-changed",
	DENY: "deny",
} as const;

export type GateResult = (typeof GATE_RESULT)[keyof typeof GATE_RESULT];

export interface IntendedCommitGateTargetV1 {
	kind: typeof GATE_TARGET_KIND.INTENDED_COMMIT;
	intended_commit_tree: string;
}

export interface PushCreateUpdateV1 {
	kind: typeof PUSH_UPDATE_KIND.CREATE;
	source_ref: string;
	destination_ref: string;
	old_object: null;
	old_peeled_commit: null;
	old_tree: null;
	new_object: string;
	new_peeled_commit: string;
	new_tree: string;
}

export interface PushExistingUpdateV1 {
	kind: typeof PUSH_UPDATE_KIND.UPDATE;
	source_ref: string;
	destination_ref: string;
	old_object: string;
	old_peeled_commit: string;
	old_tree: string;
	new_object: string;
	new_peeled_commit: string;
	new_tree: string;
}

export type PushRefUpdateV1 = PushCreateUpdateV1 | PushExistingUpdateV1;

export interface PushGateTargetV1 {
	kind: typeof GATE_TARGET_KIND.PUSH;
	remote: string;
	destination_id: string;
	updates: readonly PushRefUpdateV1[];
}

export interface PullRequestGateTargetV1 {
	kind: typeof GATE_TARGET_KIND.PULL_REQUEST;
	base_ref: string;
	base_commit: string;
	base_tree: string;
	head_ref: string;
	head_commit: string;
	head_tree: string;
}

export interface ReleaseGateTargetV1 {
	kind: typeof GATE_TARGET_KIND.RELEASE;
	tag_ref: string;
	tag_object: string;
	peeled_commit: string;
	tree: string;
}

export interface GateTargetByKind {
	[GATE_TARGET_KIND.INTENDED_COMMIT]: IntendedCommitGateTargetV1;
	[GATE_TARGET_KIND.PUSH]: PushGateTargetV1;
	[GATE_TARGET_KIND.PULL_REQUEST]: PullRequestGateTargetV1;
	[GATE_TARGET_KIND.RELEASE]: ReleaseGateTargetV1;
}

export type GateTargetV1 = GateTargetByKind[keyof GateTargetByKind];

export interface ConfiguredPushDestinationV1 {
	remote: string;
	url: string;
	destination_id: string;
}

const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const FULL_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const CONFIGURED_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectId(value: unknown): value is string {
	return typeof value === "string" && OBJECT_ID.test(value);
}

function isFullRef(value: unknown): value is string {
	return (
		typeof value === "string" &&
		FULL_REF.test(value) &&
		!value.includes("..") &&
		!value.includes("//") &&
		!value.includes("/.") &&
		!value.endsWith("/") &&
		!value.endsWith(".")
	);
}

function publicationError(message: string): Error {
	return new Error(message);
}

function runGateGit(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: reviewGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`Git publication identity could not be resolved: ${args.join(" ")}`);
	return result.stdout.trim();
}

function repositoryRootForGate(cwd: string): string {
	return runGateGit(cwd, ["rev-parse", "--show-toplevel"]);
}

function listConfiguredRemotes(cwd: string): string[] {
	const result = spawnSync("git", ["-C", cwd, "remote"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: reviewGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError("Configured Git remotes could not be listed");
	return result.stdout.split(/\r?\n/).filter(Boolean);
}

function configuredRemoteValues(cwd: string, key: string): string[] {
	const result = spawnSync("git", ["-C", cwd, "config", "--get-all", key], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: publicationProbeGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		throw publicationError(`Configured Git remote value "${key}" could not be resolved`);
	}
	return result.status === 1 ? [] : result.stdout.split(/\r?\n/).filter(Boolean);
}

export function resolveConfiguredPushDestinationV1(cwd: string, remote: string): ConfiguredPushDestinationV1 {
	if (!CONFIGURED_REMOTE_NAME.test(remote)) {
		throw publicationError("Publication remote must be a bare configured Git remote name, not a URL or path");
	}
	if (!listConfiguredRemotes(cwd).includes(remote)) {
		throw publicationError(`Publication remote "${remote}" is not a configured Git remote`);
	}
	const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "--push", "--all", remote], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: publicationProbeGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`Configured remote "${remote}" push destination could not be resolved`);
	const urls = result.stdout.split(/\r?\n/).filter(Boolean);
	if (urls.length !== 1) throw publicationError(`Configured remote "${remote}" must have one effective push destination`);
	if (configuredRemoteValues(cwd, `remote.${remote}.pushurl`).length > 1) {
		throw publicationError(`Configured remote "${remote}" has multiple pushurl destinations`);
	}
	return { remote, url: urls[0]!, destination_id: createHash("sha256").update(urls[0]!).digest("hex") };
}

export function resolvePushRemoteRefV1(
	cwd: string,
	remote: string,
	ref: string,
	label: string,
	expectedDestinationId?: string,
): { destination: ConfiguredPushDestinationV1; object_id: string | null } {
	const destination = resolveConfiguredPushDestinationV1(cwd, remote);
	if (expectedDestinationId !== undefined && destination.destination_id !== expectedDestinationId) {
		throw publicationError(`${label} publication destination changed or does not match`);
	}
	if (!isFullRef(ref)) throw publicationError(`${label} is not a full ref`);
	const result = spawnSync("git", ["ls-remote", "--refs", destination.url, ref], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: publicationProbeGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`${label} could not be resolved`);
	if (result.stdout.length === 0) return { destination, object_id: null };
	const rows = result.stdout.split(/\r?\n/).filter(Boolean);
	const matches = rows.flatMap((line) => {
		const parts = line.split("\t");
		return parts.length === 2 && parts[1] === ref && isObjectId(parts[0]) ? [parts[0]] : [];
	});
	if (matches.length !== rows.length) throw publicationError(`${label} returned malformed output`);
	if (matches.length !== 1) throw publicationError(`${label} resolved ambiguously`);
	return { destination, object_id: matches[0]! };
}

export function resolvePushDestinationRefV1(
	cwd: string,
	remote: string,
	destinationValue: string,
	sourceRef: string,
	label: string,
): { destination: ConfiguredPushDestinationV1; ref: string; object_id: string | null } {
	if (destinationValue.startsWith("refs/")) {
		return { ...resolvePushRemoteRefV1(cwd, remote, destinationValue, label), ref: destinationValue };
	}
	const formatCheck = spawnSync("git", ["check-ref-format", `refs/${destinationValue}`], {
		cwd,
		stdio: "ignore",
		env: reviewGitEnvironment(),
		windowsHide: true,
	});
	if (formatCheck.error || formatCheck.status !== 0) throw publicationError(`${label} is malformed`);
	const destination = resolveConfiguredPushDestinationV1(cwd, remote);
	const result = spawnSync("git", ["ls-remote", "--refs", destination.url], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: publicationProbeGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`${label} could not be resolved`);
	const rows = result.stdout.split(/\r?\n/).filter(Boolean);
	const advertised = rows.flatMap((line) => {
		const parts = line.split("\t");
		return parts.length === 2 && isObjectId(parts[0]) && isFullRef(parts[1]) ? [{ object_id: parts[0], ref: parts[1] }] : [];
	});
	if (advertised.length !== rows.length || new Set(advertised.map(({ ref }) => ref)).size !== advertised.length) {
		throw publicationError(`${label} returned malformed output`);
	}
	const matches = advertised.filter(({ ref }) => ref.endsWith(`/${destinationValue}`));
	if (matches.length > 1) throw publicationError(`${label} resolved ambiguously`);
	if (matches.length === 1) return { destination, ...matches[0]! };
	const namespace = sourceRef.startsWith("refs/heads/") ? "refs/heads/" : sourceRef.startsWith("refs/tags/") ? "refs/tags/" : undefined;
	if (!namespace) throw publicationError(`${label} namespace cannot be inferred from the source ref`);
	return { destination, ref: `${namespace}${destinationValue}`, object_id: null };
}

export function pushRemoteAdvertisesObjectV1(
	cwd: string,
	remote: string,
	expectedDestinationId: string,
	objectId: string,
): boolean {
	const destination = resolveConfiguredPushDestinationV1(cwd, remote);
	if (destination.destination_id !== expectedDestinationId) throw publicationError("Push parent publication destination changed or does not match");
	const result = spawnSync("git", ["ls-remote", "--refs", destination.url], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: publicationProbeGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError("Push parent advertisement could not be resolved");
	const rows = result.stdout.split(/\r?\n/).filter(Boolean);
	const advertised = rows.flatMap((line) => {
		const parts = line.split("\t");
		return parts.length === 2 && isObjectId(parts[0]) && isFullRef(parts[1]) ? [parts[0]] : [];
	});
	if (advertised.length !== rows.length) throw publicationError("Push parent advertisement returned malformed output");
	return advertised.includes(objectId);
}

export const RELEASE_FAST_PATH_PROTECTED_REF = "refs/heads/main";

export const EXTERNAL_RELEASE_EVIDENCE = {
	NONE: "none",
	INVALIDATING: "invalidating",
	ESCALATING: "escalating",
} as const;

export type ExternalReleaseEvidenceDisposition =
	(typeof EXTERNAL_RELEASE_EVIDENCE)[keyof typeof EXTERNAL_RELEASE_EVIDENCE];

export interface ReleaseFastPathCiEvidenceV1 {
	revision: string;
	status: string;
}

export interface ReleaseFastPathEvidenceV1 {
	protected_ref: string;
	remote: string;
	ci: ReleaseFastPathCiEvidenceV1;
	external_evidence: ExternalReleaseEvidenceDisposition;
	post_incident: boolean;
}

export interface ReleaseFastPathEvaluationV1 {
	eligible: boolean;
	remote_head: string | null;
	reason: string;
}

const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER = `(?:${SEMVER_NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const RELEASE_SEMVER_TAG_SOURCE = `v(${SEMVER_NUMERIC_IDENTIFIER})\\.(${SEMVER_NUMERIC_IDENTIFIER})\\.(${SEMVER_NUMERIC_IDENTIFIER})(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?(?:\\+${SEMVER_BUILD_IDENTIFIER}(?:\\.${SEMVER_BUILD_IDENTIFIER})*)?`;
const RELEASE_SEMVER_TAG = new RegExp(`^${RELEASE_SEMVER_TAG_SOURCE}$`);
const RELEASE_FAST_PATH_TAG_REF = new RegExp(`^refs/tags/${RELEASE_SEMVER_TAG_SOURCE}$`);

export function projectExactTagCreatePushAsReleaseV1(target: GateTargetV1): ReleaseGateTargetV1 | null {
	if (target.kind !== GATE_TARGET_KIND.PUSH || target.remote !== "origin" || target.updates.length !== 1) return null;
	const update = target.updates[0]!;
	if (
		update.kind !== PUSH_UPDATE_KIND.CREATE ||
		update.old_object !== null ||
		update.old_peeled_commit !== null ||
		update.old_tree !== null ||
		update.source_ref !== update.destination_ref ||
		!RELEASE_FAST_PATH_TAG_REF.test(update.destination_ref) ||
		!isObjectId(update.new_object) ||
		!isObjectId(update.new_peeled_commit) ||
		!isObjectId(update.new_tree)
	) return null;
	return {
		kind: GATE_TARGET_KIND.RELEASE,
		tag_ref: update.destination_ref,
		tag_object: update.new_object,
		peeled_commit: update.new_peeled_commit,
		tree: update.new_tree,
	};
}

export type GhCommandRunnerV1 = (
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; error?: Error };

let releaseGhCommandRunnerForTesting: GhCommandRunnerV1 | undefined;

export function setReleaseGhCommandRunnerForTestingV1(runner: GhCommandRunnerV1 | undefined): void {
	releaseGhCommandRunnerForTesting = runner;
}

function defaultGhCommandRunner(
	args: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; error?: Error } {
	const result = spawnSync("gh", args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

function deriveReleaseCiStatusForShaV1(options: {
	repositoryCwd: string;
	sha: string;
	ghCommandRunner: GhCommandRunnerV1;
}): { proven: boolean; status: string | null } {
	const runnerOptions = { cwd: options.repositoryCwd, env: reviewGitEnvironment() };
	let checkRunsResult: ReturnType<GhCommandRunnerV1>;
	try {
		checkRunsResult = options.ghCommandRunner([
			"api",
			`repos/{owner}/{repo}/commits/${options.sha}/check-runs?per_page=100`,
			"--jq",
			"{total_count, returned: (.check_runs | length), checks: [.check_runs[] | [.status, .conclusion]]}",
		], runnerOptions);
	} catch {
		return { proven: false, status: null };
	}
	if (checkRunsResult.error || checkRunsResult.status !== 0) return { proven: false, status: null };
	let summary: unknown;
	try {
		summary = JSON.parse(checkRunsResult.stdout);
	} catch {
		return { proven: false, status: null };
	}
	if (!isRecord(summary) || !Number.isSafeInteger(summary.total_count) || !Number.isSafeInteger(summary.returned) || !Array.isArray(summary.checks) || summary.total_count < 0 || summary.returned < 0 || summary.returned !== summary.checks.length || summary.total_count !== summary.checks.length) {
		return { proven: false, status: null };
	}
	if (summary.total_count > 0) {
		const successful = summary.checks.every((check) => Array.isArray(check) && check.length === 2 && check[0] === "completed" && check[1] === "success");
		return successful ? { proven: true, status: "success" } : { proven: false, status: null };
	}
	let legacyResult: ReturnType<GhCommandRunnerV1>;
	try {
		legacyResult = options.ghCommandRunner(["api", `repos/{owner}/{repo}/commits/${options.sha}/status`, "--jq", ".state"], runnerOptions);
	} catch {
		return { proven: false, status: null };
	}
	return legacyResult.error || legacyResult.status !== 0 || legacyResult.stdout.trim() !== "success"
		? { proven: false, status: null }
		: { proven: true, status: "success" };
}

export function recheckReleaseFastPathCiStatusV1(options: {
	repositoryCwd: string;
	sha: string;
	expectedStatus: "success";
}): { proven: boolean; status: string | null } {
	const derived = deriveReleaseCiStatusForShaV1({
		repositoryCwd: options.repositoryCwd,
		sha: options.sha,
		ghCommandRunner: releaseGhCommandRunnerForTesting ?? defaultGhCommandRunner,
	});
	return { proven: derived.proven && derived.status === options.expectedStatus, status: derived.status };
}

function resolveConfiguredRemoteUrl(cwd: string, remote: string): string {
	if (!CONFIGURED_REMOTE_NAME.test(remote)) throw publicationError("Release fast path remote must be a bare configured Git remote name, not a URL or path");
	if (!listConfiguredRemotes(cwd).includes(remote)) throw publicationError(`Release fast path remote "${remote}" is not a configured Git remote`);
	const result = spawnSync("git", ["-C", cwd, "remote", "get-url", remote], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: reviewGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`Configured remote "${remote}" URL could not be resolved`);
	const url = result.stdout.trim();
	if (!url) throw publicationError(`Configured remote "${remote}" has no URL`);
	return url;
}

function resolveRemoteGateRef(cwd: string, remote: string, ref: string, label: string): string | null {
	if (!isFullRef(ref)) throw publicationError(`${label} is not a full ref`);
	const result = spawnSync("git", ["ls-remote", "--refs", resolveConfiguredRemoteUrl(cwd, remote), ref], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: reviewGitEnvironment(),
		windowsHide: true,
	});
	if (result.error || result.status !== 0) throw publicationError(`${label} could not be resolved`);
	const matches = result.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
		const [objectId, remoteRef] = line.split("\t");
		return remoteRef === ref && isObjectId(objectId) ? [objectId] : [];
	});
	if (matches.length === 0) return null;
	if (matches.length !== 1) throw publicationError(`${label} resolved ambiguously`);
	return matches[0]!;
}

function assertReleaseIdentity(cwd: string, target: ReleaseGateTargetV1): void {
	if (!isObjectId(target.tag_object) || !isObjectId(target.peeled_commit) || !isObjectId(target.tree)) {
		throw publicationError("Release target requires resolved object IDs");
	}
	if (runGateGit(cwd, ["rev-parse", "--verify", `${target.tag_ref}^{object}`]) !== target.tag_object) throw publicationError("Release tag ref does not resolve to its supplied object");
	if (runGateGit(cwd, ["rev-parse", "--verify", `${target.tag_object}^{commit}`]) !== target.peeled_commit) throw publicationError("Release tag object does not peel to the supplied commit");
	if (runGateGit(cwd, ["rev-parse", "--verify", `${target.peeled_commit}^{tree}`]) !== target.tree) throw publicationError("Release commit does not resolve to the supplied tree");
}

export function evaluateReleaseFastPathV1(options: {
	target: GateTargetV1;
	evidence: ReleaseFastPathEvidenceV1;
	repositoryCwd: string;
	ghCommandRunner?: GhCommandRunnerV1;
}): ReleaseFastPathEvaluationV1 {
	const ineligible = (reason: string): ReleaseFastPathEvaluationV1 => ({ eligible: false, remote_head: null, reason });
	const { target, evidence } = options;
	if (target.kind !== GATE_TARGET_KIND.RELEASE) return ineligible("Release fast path applies only to a release gate target.");
	if (evidence.protected_ref !== RELEASE_FAST_PATH_PROTECTED_REF) return ineligible("Release fast path applies only to the protected refs/heads/main publication ref.");
	if (evidence.post_incident) return ineligible("Releases following an operational or security incident require explicit extraordinary review even when fast-path checks pass.");
	if (!isFullRef(target.tag_ref) || !target.tag_ref.startsWith("refs/tags/")) return ineligible("Release fast path requires an exact release tag ref.");
	const semver = RELEASE_SEMVER_TAG.exec(target.tag_ref.slice("refs/tags/".length));
	if (!semver) return ineligible("Release tag is not a provable semantic version, so a major release cannot be ruled out; explicit extraordinary review is required.");
	if (semver[3] === "0" && (semver[2] === "0" || semver[1] === "0")) return ineligible("Major releases require explicit extraordinary review even when fast-path checks pass.");
	let remoteHead: string | null;
	let repositoryRoot: string;
	try {
		repositoryRoot = repositoryRootForGate(options.repositoryCwd);
		assertReleaseIdentity(repositoryRoot, target);
		remoteHead = resolveRemoteGateRef(repositoryRoot, evidence.remote, RELEASE_FAST_PATH_PROTECTED_REF, "release protected main head");
	} catch (error) {
		return ineligible(`Release fast path identity cannot be proven: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (remoteHead === null) return ineligible("The current immutable origin/main SHA cannot be proven on the release remote.");
	if (target.peeled_commit !== remoteHead) return ineligible("Release tag target is not the current immutable origin/main SHA.");
	if (evidence.ci.revision !== remoteHead || evidence.ci.status !== "success") return ineligible("Required CI for the exact origin/main SHA is not proven successful.");
	const derivedCi = deriveReleaseCiStatusForShaV1({
		repositoryCwd: repositoryRoot,
		sha: remoteHead,
		ghCommandRunner: options.ghCommandRunner ?? releaseGhCommandRunnerForTesting ?? defaultGhCommandRunner,
	});
	if (!derivedCi.proven || derivedCi.status !== "success") return ineligible("Required CI success for the exact origin/main SHA could not be independently derived via the gh CLI; caller-supplied CI evidence alone is never sufficient.");
	if (evidence.external_evidence !== EXTERNAL_RELEASE_EVIDENCE.NONE) return ineligible("New vulnerability, policy, provenance, signing, generated-artifact, or release evidence requires escalation and blocks the release fast path.");
	return {
		eligible: true,
		remote_head: remoteHead,
		reason: "Release fast path proven: the tag targets the current immutable origin/main SHA, required CI for that exact SHA is successful, and no new evidence requires escalation. Local branch position and worktree dirtiness are not publication inputs.",
	};
}

export function recheckReleaseFastPathRemoteHeadV1(options: {
	repositoryCwd: string;
	remote: string;
	expectedRemoteHead: string;
}): { advanced: boolean; remote_head: string | null } {
	let remoteHead: string | null;
	try {
		remoteHead = resolveRemoteGateRef(repositoryRootForGate(options.repositoryCwd), options.remote, RELEASE_FAST_PATH_PROTECTED_REF, "release protected main head");
	} catch {
		remoteHead = null;
	}
	return { advanced: remoteHead === null || remoteHead !== options.expectedRemoteHead, remote_head: remoteHead };
}
