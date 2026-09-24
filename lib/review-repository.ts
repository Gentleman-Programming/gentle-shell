import { execFileSync } from "node:child_process";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJsonV1, domainHashV1, parseCanonicalJsonV1 } from "./review-canonical.ts";

const OBJECT_FORMAT = /^(sha1|sha256)$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class ReviewRepositoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewRepositoryError";
	}
}

export interface ReviewRepositoryIdentityBodyV1 {
	schema: "gentle-ai.review-repository/v1";
	object_format: "sha1" | "sha256";
	root_commit_ids: string[];
}

export interface RepositoryAuthorityV1 {
	readonly common_directory: string;
	readonly store_root: string;
	readonly repository_identity: ReviewRepositoryIdentityBodyV1;
	readonly repository_id: string;
	readonly authority_id: string;
}

const UNSAFE_GIT_ENVIRONMENT = new Set([
	"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_QUARANTINE_PATH", "GIT_PREFIX", "GIT_SUPER_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE",
]);

const UNSAFE_PUBLICATION_GIT_ENVIRONMENT = new Set([
	...UNSAFE_GIT_ENVIRONMENT,
	"GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_PARAMETERS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND",
]);

export function inheritedUnsafeGitEnvironmentKeys(
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	return Object.keys(environment)
		.filter((key) => {
			const normalizedKey = key.toUpperCase();
			return UNSAFE_PUBLICATION_GIT_ENVIRONMENT.has(normalizedKey) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(normalizedKey);
		})
		.toSorted();
}

export function reviewGitEnvironment(): NodeJS.ProcessEnv {
	for (const key of Object.keys(process.env)) {
		const normalizedKey = key.toUpperCase();
		if (UNSAFE_GIT_ENVIRONMENT.has(normalizedKey) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(normalizedKey)) throw new ReviewRepositoryError("REVIEW_GIT_ENV_UNSAFE: inherited Git routing/configuration override is present");
	}
	const environment: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) environment[key] = value;
	environment.GIT_CONFIG_NOSYSTEM = "1";
	environment.GIT_CONFIG_GLOBAL = "/dev/null";
	environment.GIT_CONFIG_SYSTEM = "/dev/null";
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.LC_ALL = "C";
	environment.LANG = "C";
	return environment;
}

export function publicationProbeGitEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env };
	for (const key of inheritedUnsafeGitEnvironmentKeys(environment)) delete environment[key];
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.LC_ALL = "C";
	environment.LANG = "C";
	return environment;
}

function gitLines(cwd: string, args: string[]): string[] {
	let output: string;
	try {
		output = execFileSync("git", ["-C", resolve(cwd), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, env: reviewGitEnvironment(), windowsHide: true });
	} catch (error) {
		if (error instanceof ReviewRepositoryError) throw error;
		throw new ReviewRepositoryError("Unable to resolve Git repository authority");
	}
	if (output.includes("\0")) throw new ReviewRepositoryError("Git authority probe returned malformed output");
	return output.split("\n").filter(Boolean);
}

function oneGitLine(cwd: string, args: string[]): string {
	const lines = gitLines(cwd, args);
	if (lines.length !== 1) throw new ReviewRepositoryError("Git authority probe returned an ambiguous value");
	return lines[0]!;
}

export function assertManagedStorePathV1(commonDirectory: string, path: string): string {
	const canonicalCommonDirectory = realpathSync(commonDirectory);
	const resolved = resolve(path);
	if (relative(canonicalCommonDirectory, resolved).startsWith(`..${sep}`) || relative(canonicalCommonDirectory, resolved) === "..") throw new ReviewRepositoryError("Review store path escapes the Git common directory");
	let current = canonicalCommonDirectory;
	for (const part of relative(canonicalCommonDirectory, resolved).split(sep).filter(Boolean)) {
		current = join(current, part);
		try {
			const entry = lstatSync(current);
			if (entry.isSymbolicLink()) throw new ReviewRepositoryError("Review store path contains a symlink or reparse-point redirect");
		} catch (error) {
			if (error instanceof ReviewRepositoryError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ReviewRepositoryError("Review store path cannot be safely inspected");
		}
	}
	return resolved;
}

// Pinned root-set identity (resolves RESL-001): the repository/authority
// identity is derived from a root-commit set that is computed once, the
// first time this repository's review store is resolved, and then
// persisted beside the store as `IDENTITY`. Every later resolution reuses
// that pinned set for `repository_id`/`authority_id` instead of
// recomputing identity from git's live root-commit set, so an unrelated
// orphan branch or subtree merge added afterward cannot change identity
// and orphan the store. The live root-commit set is still recomputed on
// every call, but only to validate that the pinned set remains a SUBSET
// of it — an orphan branch adds roots (subset holds, store keeps
// working); a store transplanted into an unrelated repository or a
// history rewrite that removes a pinned root commit breaks the subset
// and fails closed with the same authority-mismatch semantics as before.
export const IDENTITY_FILENAME = "IDENTITY";

function pinnedIdentityPathV1(storeRoot: string): string {
	return join(storeRoot, IDENTITY_FILENAME);
}

function isValidRepositoryIdentityBodyV1(value: unknown): value is ReviewRepositoryIdentityBodyV1 {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as ReviewRepositoryIdentityBodyV1;
	return (
		candidate.schema === "gentle-ai.review-repository/v1" &&
		OBJECT_FORMAT.test(candidate.object_format) &&
		Array.isArray(candidate.root_commit_ids) &&
		candidate.root_commit_ids.length > 0 &&
		new Set(candidate.root_commit_ids).size === candidate.root_commit_ids.length &&
		candidate.root_commit_ids.every((anchor) => typeof anchor === "string" && OBJECT_ID.test(anchor))
	);
}

// RESL2-002 remediation: a first-time IDENTITY write is racy under
// `O_CREAT|O_EXCL` (`{ flag: "wx" }`) because the file becomes visible to
// other readers the moment it is created, before its content is written.
// The install below closes that window structurally: content is written to
// a process-unique temporary file, fsynced, and only then linked into the
// final IDENTITY path — so the final path either does not exist yet or
// already holds fully-written bytes, never a partial write. A bounded
// retry additionally covers any read that still observes a transiently
// incomplete file at that path (e.g. one produced by an out-of-process
// writer that predates this install pattern), without masking genuine
// corruption: retries apply only to a parse failure, never to a
// well-formed-but-invalid body.
let identityReadRetryHookForTesting: (() => void) | undefined;
export function setReviewRepositoryIdentityRetryHookForTesting(hook: (() => void) | undefined): void {
	identityReadRetryHookForTesting = hook;
}
const IDENTITY_READ_RETRY_ATTEMPTS = 5;
const IDENTITY_READ_RETRY_DELAY_MS = 4;

function sleepSyncMs(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readPinnedRepositoryIdentityV1(storeRoot: string): ReviewRepositoryIdentityBodyV1 | undefined {
	for (let attempt = 1; attempt <= IDENTITY_READ_RETRY_ATTEMPTS; attempt += 1) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(pinnedIdentityPathV1(storeRoot));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new ReviewRepositoryError("Pinned repository identity is unavailable");
		}
		let parsed: unknown;
		try {
			parsed = parseCanonicalJsonV1(bytes);
		} catch {
			if (attempt < IDENTITY_READ_RETRY_ATTEMPTS) {
				identityReadRetryHookForTesting?.();
				sleepSyncMs(IDENTITY_READ_RETRY_DELAY_MS);
				continue;
			}
			throw new ReviewRepositoryError("Pinned repository identity is malformed");
		}
		if (!isValidRepositoryIdentityBodyV1(parsed)) throw new ReviewRepositoryError("Pinned repository identity is invalid");
		return parsed;
	}
	throw new ReviewRepositoryError("Pinned repository identity is malformed");
}

// Pins the repository IDENTITY on first authority resolution and re-pins a
// fresh IDENTITY during explicit broken-identity recovery. Not intended for
// ordinary use outside those flows.
export function writePinnedRepositoryIdentityV1(storeRoot: string, identity: ReviewRepositoryIdentityBodyV1): ReviewRepositoryIdentityBodyV1 {
	mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
	const path = pinnedIdentityPathV1(storeRoot);
	const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
	let installed = false;
	try {
		writeFileSync(temporary, canonicalJsonV1(identity), { flag: "wx", mode: 0o600 });
		const temporaryFile = openSync(temporary, "r+");
		try {
			fsyncSync(temporaryFile);
		} finally {
			closeSync(temporaryFile);
		}
		try {
			linkSync(temporary, path);
			installed = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} catch {
		throw new ReviewRepositoryError("Unable to persist pinned repository identity");
	} finally {
		try {
			unlinkSync(temporary);
		} catch {}
	}
	if (!installed) return readPinnedRepositoryIdentityV1(storeRoot) ?? identity;
	const file = openSync(path, "r+");
	try {
		fsyncSync(file);
	} finally {
		closeSync(file);
	}
	if (process.platform !== "win32") {
		const directory = openSync(storeRoot, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	}
	return identity;
}

interface LiveRepositoryProbeV1 {
	canonicalCommonDirectory: string;
	storeRoot: string;
	objectFormat: "sha1" | "sha256";
	liveAnchors: string[];
}

function probeLiveRepositoryV1(cwd: string): LiveRepositoryProbeV1 {
	const commonDirectory = oneGitLine(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!isAbsolute(commonDirectory)) throw new ReviewRepositoryError("Git common directory is not absolute");
	let canonicalCommonDirectory: string;
	try {
		canonicalCommonDirectory = realpathSync(commonDirectory);
		if (!statSync(canonicalCommonDirectory).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new ReviewRepositoryError("Git common directory is unavailable");
	}
	const objectFormat = oneGitLine(cwd, ["rev-parse", "--show-object-format"]);
	if (!OBJECT_FORMAT.test(objectFormat)) throw new ReviewRepositoryError("Git object format is unsupported");
	if (oneGitLine(cwd, ["rev-parse", "--is-shallow-repository"]) !== "false") {
		throw new ReviewRepositoryError("Shallow repositories cannot establish review authority");
	}
	const storeRoot = assertManagedStorePathV1(canonicalCommonDirectory, join(canonicalCommonDirectory, "gentle-ai", "reviews"));
	const liveAnchors = gitLines(cwd, ["rev-list", "--max-parents=0", "--all"]).toSorted();
	if (liveAnchors.length === 0) throw new ReviewRepositoryError("Repository root commit anchors are required");
	if (new Set(liveAnchors).size !== liveAnchors.length || liveAnchors.some((anchor) => !OBJECT_ID.test(anchor))) {
		throw new ReviewRepositoryError("Repository root commit anchors are invalid");
	}
	return { canonicalCommonDirectory, storeRoot, objectFormat: objectFormat as "sha1" | "sha256", liveAnchors };
}

export function resolveRepositoryAuthorityV1(cwd: string): RepositoryAuthorityV1 {
	const probe = probeLiveRepositoryV1(cwd);
	const pinned = readPinnedRepositoryIdentityV1(probe.storeRoot);
	let repository_identity: ReviewRepositoryIdentityBodyV1;
	if (pinned) {
		if (pinned.object_format !== probe.objectFormat) {
			throw new ReviewRepositoryError("Pinned repository identity object format no longer matches this repository");
		}
		const live = new Set(probe.liveAnchors);
		if (!pinned.root_commit_ids.every((anchor) => live.has(anchor))) {
			throw new ReviewRepositoryError("Repository root commit authority no longer matches the pinned store identity");
		}
		repository_identity = pinned;
	} else {
		repository_identity = writePinnedRepositoryIdentityV1(probe.storeRoot, {
			schema: "gentle-ai.review-repository/v1",
			object_format: probe.objectFormat,
			root_commit_ids: probe.liveAnchors,
		});
	}
	const repository_id = domainHashV1("repository", repository_identity);
	return Object.freeze({
		common_directory: probe.canonicalCommonDirectory,
		store_root: probe.storeRoot,
		repository_identity,
		repository_id,
		authority_id: domainHashV1("authority", { repository_id, graph_format: "graph-v1" }),
	});
}

export interface RepositoryAuthorityRecoveryV1 extends RepositoryAuthorityV1 {
	readonly identity_broken: boolean;
}

// RESL2-001 / RELY2-001 remediation: a pinned root commit removed by an
// ordinary history rewrite (e.g. `git branch -D` on an orphan root) makes
// the SUBSET check in `resolveRepositoryAuthorityV1` fail permanently.
// That is correct, fail-closed behavior for ordinary access — but recovery
// inspection could never even start if it called that same fail-closed
// resolver as its first line. This lenient variant runs the identical live
// probe but never throws on a broken subset: when the pin no longer holds,
// it reports `identity_broken: true` and computes a fresh, NOT-YET-PERSISTED
// identity from the CURRENT live root-commit set instead, so explicit
// recovery inspection can detect the break and surface it. This function
// must never be used by ordinary read/mutation paths — only by the explicit
// recovery-inspection path (legacy authority detection).
export function resolveRepositoryAuthorityForRecoveryV1(cwd: string): RepositoryAuthorityRecoveryV1 {
	const probe = probeLiveRepositoryV1(cwd);
	const pinned = readPinnedRepositoryIdentityV1(probe.storeRoot);
	let repository_identity: ReviewRepositoryIdentityBodyV1;
	let identity_broken = false;
	if (pinned) {
		const live = new Set(probe.liveAnchors);
		const subsetHolds = pinned.object_format === probe.objectFormat && pinned.root_commit_ids.every((anchor) => live.has(anchor));
		if (subsetHolds) {
			repository_identity = pinned;
		} else {
			identity_broken = true;
			repository_identity = { schema: "gentle-ai.review-repository/v1", object_format: probe.objectFormat, root_commit_ids: probe.liveAnchors };
		}
	} else {
		repository_identity = { schema: "gentle-ai.review-repository/v1", object_format: probe.objectFormat, root_commit_ids: probe.liveAnchors };
	}
	const repository_id = domainHashV1("repository", repository_identity);
	return Object.freeze({
		common_directory: probe.canonicalCommonDirectory,
		store_root: probe.storeRoot,
		repository_identity,
		repository_id,
		authority_id: domainHashV1("authority", { repository_id, graph_format: "graph-v1" }),
		identity_broken,
	});
}

export function reviewStoreRootForRepositoryV1(cwd: string): string {
	return resolve(resolveRepositoryAuthorityV1(cwd).store_root);
}
