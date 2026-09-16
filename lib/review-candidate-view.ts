import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { assertCandidateOwnerParent, createCandidateOwner, prepareCandidateOwnerParent, removeCandidateOwner, samePath, sweepCandidateOwners, type CandidateViewOwner } from "./review-candidate-view-owner.ts";

const REVIEW_LENS = ["review-risk", "review-resilience", "review-readability", "review-reliability"] as const;
export type ReviewLens = (typeof REVIEW_LENS)[number];
const CANDIDATE_GIT_TIMEOUT_MS = 10_000;
const CANDIDATE_GIT_TIMEOUT_MAX_MS = 120_000;
const CANDIDATE_GIT_TIMEOUT_ENV = "GENTLE_PI_CANDIDATE_GIT_TIMEOUT_MS";
const CANDIDATE_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// Keep the copied index at least one timestamp tick behind its source. The
// two-second target also clears filesystems whose mtime granularity is a second
// or coarser without needlessly assigning an arbitrary historical timestamp.
const PRIVATE_INDEX_RACY_SAFETY_NS = 1_000_000_000n;
const PRIVATE_INDEX_RACY_BACKDATE_NS = 2_000_000_000n;

// Candidate views may materialize full repository trees. Large repositories can
// raise this bounded deadline without creating an unbounded child process.
function resolveCandidateGitTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
	const value = environment[CANDIDATE_GIT_TIMEOUT_ENV];
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return CANDIDATE_GIT_TIMEOUT_MS;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= CANDIDATE_GIT_TIMEOUT_MAX_MS
		? parsed
		: CANDIDATE_GIT_TIMEOUT_MS;
}

function isCandidateGitTimeoutMs(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= CANDIDATE_GIT_TIMEOUT_MAX_MS;
}
const CANDIDATE_VIEW_DIAGNOSTIC_PHASE = "candidate-view";
const CANDIDATE_VIEW_GIT_FAILURE_CATEGORY = {
	TIMEOUT: "timeout",
	OUTPUT_LIMIT: "output-limit",
	GIT_FAILURE: "git-failure",
} as const;
export type CandidateViewGitFailureCategory = (typeof CANDIDATE_VIEW_GIT_FAILURE_CATEGORY)[keyof typeof CANDIDATE_VIEW_GIT_FAILURE_CATEGORY];
const CANDIDATE_GIT_SUBCOMMAND = {
	ADD: "add",
	CHECKOUT_INDEX: "checkout-index",
	DIFF: "diff",
	FOR_EACH_REF: "for-each-ref",
	LOG: "log",
	LS_FILES: "ls-files",
	LS_TREE: "ls-tree",
	READ_TREE: "read-tree",
	REV_PARSE: "rev-parse",
	WORKTREE: "worktree",
	WRITE_TREE: "write-tree",
	OTHER: "other",
} as const;
type CandidateGitSubcommand = (typeof CANDIDATE_GIT_SUBCOMMAND)[keyof typeof CANDIDATE_GIT_SUBCOMMAND];

export type CandidateGitExecutor = (file: string, arguments_: readonly string[], options: ExecFileSyncOptions) => string | Buffer;
const defaultCandidateGitExecutor: CandidateGitExecutor = (file, arguments_, options) => execFileSync(file, arguments_, options);

const CONTROLLER_CANDIDATE_VIEW_HEADING = "## Controller-owned candidate view";
const MAX_SUBAGENT_TASK_LENGTH = 16_384;
const MAX_SUBAGENT_CONTEXT_LENGTH = 4_096;
const MAX_CANDIDATE_CONTEXT_LENGTH = 4_096;
const MAX_CANDIDATE_CONTEXT_MANIFEST_BYTES = 1024 * 1024;
const MAX_CANDIDATE_SCOPE_PAGE_BYTES = 16 * 1024;
const MAX_CANDIDATE_SCOPE_PAGE_ENTRIES = 128;
const CANDIDATE_CONTEXT_MANIFEST = {
	VERSION: 1,
} as const;
const CANDIDATE_CONTEXT_MODE = {
	REGULAR: "100644",
	EXECUTABLE: "100755",
	SYMLINK: "120000",
	GITLINK: "160000",
	DELETED: "deleted",
} as const;
export type CandidateContextMode = (typeof CANDIDATE_CONTEXT_MODE)[keyof typeof CANDIDATE_CONTEXT_MODE];
const SUBAGENT_RUN_KEYS = new Set(["agent", "agents", "task", "context", "mode"]);

interface CandidateTreeEntry {
	path: string;
	mode: string;
	objectId: string;
}

interface CandidateViewEntry extends CandidateTreeEntry {
	contentHash: string;
}

interface CandidateGitlink extends CandidateTreeEntry { mode: "160000"; }
interface ParsedCandidateTree { entries: CandidateTreeEntry[]; gitlinks: CandidateGitlink[]; }

interface CandidateViewScope {
	paths: readonly string[];
	modes: Readonly<Record<string, string>>;
	gitlinks: Readonly<Record<string, string>>;
	deletedPaths: readonly string[];
}

interface CandidateViewRecord {
	owner: CandidateViewOwner;
	token: string;
	root: string;
	parent: string;
	contributorRoot: string;
	commonDir: string;
	baseCommit: string;
	baseTree: string;
	candidateTree: string;
	committedOnly: boolean;
	intendedUntracked?: readonly string[];
	entries: readonly CandidateViewEntry[];
	gitlinks: readonly CandidateGitlink[];
	scope: CandidateViewScope;
	lineageId?: string;
	selectedLenses?: readonly ReviewLens[];
	gitExecutor: CandidateGitExecutor;
}

export interface CandidateView {
	token: string;
	root: string;
	contributorRoot: string;
	baseCommit: string;
	baseTree: string;
	candidateTree: string;
	committedOnly: boolean;
	intendedUntracked?: readonly string[];
	paths: readonly string[];
	modes: Readonly<Record<string, string>>;
	gitlinks: Readonly<Record<string, string>>;
	deletedPaths: readonly string[];
	verify(): void;
	cleanup(): void;
}

export interface CandidateContextManifest {
	version: typeof CANDIDATE_CONTEXT_MANIFEST.VERSION;
	scopeByMode: Readonly<Record<string, readonly string[]>>;
	gitlinks: Readonly<Record<string, string>>;
}

export interface DecodedCandidateContextManifest {
	manifest: CandidateContextManifest;
	bytes: Buffer;
	sha256: string;
}

export interface CandidateContextPageEntry {
	path: string;
	mode: CandidateContextMode;
	gitlinkObjectId?: string;
}

export interface CandidateContextPage {
	version: typeof CANDIDATE_CONTEXT_MANIFEST.VERSION;
	sha256: string;
	cursor: number;
	totalPaths: number;
	entries: readonly CandidateContextPageEntry[];
	nextCursor?: number;
}

export interface FrozenCandidateProjection {
	contributorRoot: string;
	baseCommit: string;
	baseTree: string;
	candidateTree: string;
	committedOnly: boolean;
	intendedUntracked?: readonly string[];
	paths: readonly string[];
	modes: Readonly<Record<string, string>>;
	gitlinks: Readonly<Record<string, string>>;
	deletedPaths: readonly string[];
}

export interface CreateCandidateViewRequest {
	contributorRoot: string;
	baseRef?: string;
	committedOnly?: boolean;
	/** Undefined keeps legacy all-untracked capture; [] excludes untracked files. */
	intendedUntracked?: readonly string[];
	replayKey?: string;
}

export interface BindCandidateViewRequest {
	token: string;
	lineageId: string;
	selectedLenses: readonly string[];
}

export interface AuthoritativeReviewingCandidateState {
	lineageId: string;
	contributorRoot: string;
	baseCommit: string;
	baseTree: string;
	candidateTree: string;
	committedOnly?: boolean;
	intendedUntracked?: readonly string[];
	paths: readonly string[];
	modes: Readonly<Record<string, string>>;
	gitlinks?: Readonly<Record<string, string>>;
	deletedPaths: readonly string[];
	selectedLenses: readonly string[];
}

export interface NativeCandidateProjectionDescriptor {
	baseTree: string;
	currentCandidateTree: string;
	paths: readonly string[];
	intendedUntracked: readonly string[];
	projection: "workspace" | "staged";
	// Optional so Phase 3 stays additive: existing callers keep the legacy
	// sorted-path behavior until the v2 switchover supplies a manifest.
	manifest?: readonly ChangedPathEntry[];
	// The provider artifact-subject's `changed_path_manifest_sha256` claim.
	// Production callers verify this field across all collect inputs and their
	// artifact subjects; hand-built descriptors may still use Pi's local digest
	// as a self-consistency check.
	manifestSha256?: string;
	// Set only by the production status adapter after it has checked every
	// provider-issued collect input and artifact subject for one identical hash.
	// Provider canonicalization is intentionally not reimplemented here.
	providerManifestHashVerified?: true;
}

export interface CandidateViewDiagnostic {
	phase: typeof CANDIDATE_VIEW_DIAGNOSTIC_PHASE;
	category: CandidateViewGitFailureCategory;
	git_subcommand: CandidateGitSubcommand;
	timeout_ms: number;
	max_buffer_bytes: number;
	message: string;
}

export class CandidateViewError extends Error {
	readonly reason: string;
	readonly diagnostics?: CandidateViewDiagnostic;
	constructor(message: string, reason = "candidate-view-invalid", diagnostics?: CandidateViewDiagnostic, options?: ErrorOptions) {
		super(message, options);
		this.name = "CandidateViewError";
		this.reason = reason;
		this.diagnostics = diagnostics === undefined ? undefined : sanitizeCandidateViewDiagnostic(diagnostics);
	}
}

function candidateGitSubcommand(arguments_: readonly string[]): CandidateGitSubcommand {
	switch (arguments_[0]) {
		case CANDIDATE_GIT_SUBCOMMAND.ADD: return CANDIDATE_GIT_SUBCOMMAND.ADD;
		case CANDIDATE_GIT_SUBCOMMAND.CHECKOUT_INDEX: return CANDIDATE_GIT_SUBCOMMAND.CHECKOUT_INDEX;
		case CANDIDATE_GIT_SUBCOMMAND.DIFF: return CANDIDATE_GIT_SUBCOMMAND.DIFF;
		case CANDIDATE_GIT_SUBCOMMAND.FOR_EACH_REF: return CANDIDATE_GIT_SUBCOMMAND.FOR_EACH_REF;
		case CANDIDATE_GIT_SUBCOMMAND.LOG: return CANDIDATE_GIT_SUBCOMMAND.LOG;
		case CANDIDATE_GIT_SUBCOMMAND.LS_FILES: return CANDIDATE_GIT_SUBCOMMAND.LS_FILES;
		case CANDIDATE_GIT_SUBCOMMAND.LS_TREE: return CANDIDATE_GIT_SUBCOMMAND.LS_TREE;
		case CANDIDATE_GIT_SUBCOMMAND.READ_TREE: return CANDIDATE_GIT_SUBCOMMAND.READ_TREE;
		case CANDIDATE_GIT_SUBCOMMAND.REV_PARSE: return CANDIDATE_GIT_SUBCOMMAND.REV_PARSE;
		case CANDIDATE_GIT_SUBCOMMAND.WORKTREE: return CANDIDATE_GIT_SUBCOMMAND.WORKTREE;
		case CANDIDATE_GIT_SUBCOMMAND.WRITE_TREE: return CANDIDATE_GIT_SUBCOMMAND.WRITE_TREE;
		default: return CANDIDATE_GIT_SUBCOMMAND.OTHER;
	}
}

function candidateGitDiagnosticMessage(category: CandidateViewGitFailureCategory, subcommand: CandidateGitSubcommand, timeoutMs: number): string {
	if (category === CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.TIMEOUT) return `candidate-view Git command ${subcommand} timed out after ${timeoutMs}ms; inspect the candidate state before any new START`;
	if (category === CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.OUTPUT_LIMIT) return `candidate-view Git command ${subcommand} exceeded the ${CANDIDATE_GIT_MAX_BUFFER_BYTES}-byte output limit; inspect the candidate state before any new START`;
	return `candidate-view Git command ${subcommand} failed; inspect the candidate state before any new START`;
}

function candidateGitDiagnostic(category: CandidateViewGitFailureCategory, arguments_: readonly string[], timeoutMs: number): CandidateViewDiagnostic {
	const git_subcommand = candidateGitSubcommand(arguments_);
	return Object.freeze({
		phase: CANDIDATE_VIEW_DIAGNOSTIC_PHASE,
		category,
		git_subcommand,
		timeout_ms: timeoutMs,
		max_buffer_bytes: CANDIDATE_GIT_MAX_BUFFER_BYTES,
		message: candidateGitDiagnosticMessage(category, git_subcommand, timeoutMs),
	});
}

function sanitizeCandidateViewDiagnostic(diagnostics: CandidateViewDiagnostic): CandidateViewDiagnostic | undefined {
	const { phase, category, git_subcommand, timeout_ms, max_buffer_bytes, message } = diagnostics;
	if (
		phase !== CANDIDATE_VIEW_DIAGNOSTIC_PHASE ||
		!Object.values(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY).includes(category) ||
		!Object.values(CANDIDATE_GIT_SUBCOMMAND).includes(git_subcommand) ||
		!isCandidateGitTimeoutMs(timeout_ms) ||
		max_buffer_bytes !== CANDIDATE_GIT_MAX_BUFFER_BYTES ||
		message !== candidateGitDiagnosticMessage(category, git_subcommand, timeout_ms)
	) return undefined;
	return Object.freeze({ phase, category, git_subcommand, timeout_ms, max_buffer_bytes, message });
}

function candidateGitFailure(category: CandidateViewGitFailureCategory, arguments_: readonly string[], timeoutMs: number): CandidateViewError {
	const diagnostics = candidateGitDiagnostic(category, arguments_, timeoutMs);
	return new CandidateViewError(diagnostics.message, `candidate-view-${category}`, diagnostics);
}

function candidateGit(cwd: string, arguments_: readonly string[], env: NodeJS.ProcessEnv, encoding: "utf8" | "buffer", executor: CandidateGitExecutor): string | Buffer {
	const timeoutMs = resolveCandidateGitTimeoutMs(env);
	try {
		return executor("git", arguments_, {
			cwd,
			encoding,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
			maxBuffer: CANDIDATE_GIT_MAX_BUFFER_BYTES,
			windowsHide: true,
		});
	} catch (error) {
		const detail = error as NodeJS.ErrnoException & { killed?: boolean };
		if (detail.code === "ENOBUFS" || detail.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.OUTPUT_LIMIT, arguments_, timeoutMs);
		if (detail.code === "ETIMEDOUT" || detail.killed === true) throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.TIMEOUT, arguments_, timeoutMs);
		throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.GIT_FAILURE, arguments_, timeoutMs);
	}
}

function git(cwd: string, arguments_: readonly string[], env: NodeJS.ProcessEnv = process.env, executor: CandidateGitExecutor = defaultCandidateGitExecutor): string {
	return (candidateGit(cwd, arguments_, env, "utf8", executor) as string).trim();
}

function isWithin(parent: string, path: string): boolean {
	const value = relative(parent, path);
	return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function isSafeCandidatePath(path: string): boolean {
	return path.length > 0
		&& !isAbsolute(path)
		&& !path.includes("\\")
		&& !/[\u0000-\u001f\u007f]/.test(path)
		&& path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isMaterializedCandidateMode(mode: string): boolean {
	return mode === "100644" || mode === "100755" || mode === "120000";
}

export function hasExpectedExecutableBits(filesystemMode: number, gitMode: string, platform: NodeJS.Platform = process.platform): boolean {
	return gitMode === "100755" && platform === "win32"
		|| (filesystemMode & 0o111) === (gitMode === "100755" ? 0o111 : 0);
}

function isCanonicalObjectId(objectId: string): boolean { return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId); }
function gitlinkMapsEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
	const entries = Object.entries(left);
	return entries.length === Object.keys(right).length && entries.every(([path, objectId]) => right[path] === objectId);
}

// Two materialized candidate views describe the exact same reviewable content
// when their base, candidate tree, commit-state, and changed scope all match.
// This is what makes a retried native START's freshly-materialized duplicate
// view safely discardable in favor of an already-bound one (gentle-pi
// candidate-view rebind defect, ga#4085 / ga#4050): the comparison never
// trusts a caller-supplied claim, only Git-derived identity already computed
// by materializeCandidateView for both records.
function candidateRecordsShareIdentity(left: CandidateViewRecord, right: CandidateViewRecord): boolean {
	return left.contributorRoot === right.contributorRoot &&
		left.baseCommit === right.baseCommit &&
		left.baseTree === right.baseTree &&
		left.candidateTree === right.candidateTree &&
		left.committedOnly === right.committedOnly &&
		JSON.stringify(left.intendedUntracked ?? null) === JSON.stringify(right.intendedUntracked ?? null) &&
		JSON.stringify(left.scope.paths) === JSON.stringify(right.scope.paths) &&
		JSON.stringify(left.scope.modes) === JSON.stringify(right.scope.modes) &&
		gitlinkMapsEqual(left.scope.gitlinks, right.scope.gitlinks) &&
		JSON.stringify(left.scope.deletedPaths) === JSON.stringify(right.scope.deletedPaths);
}

function decodeCanonicalPath(value: Buffer): string {
	const path = value.toString("utf8");
	if (!Buffer.from(path, "utf8").equals(value) || !isSafeCandidatePath(path)) {
		throw new CandidateViewError("candidate tree contains an unsafe or noncanonical path");
	}
	return path;
}

function assertSafeSymlinkTarget(root: string, entryPath: string, value: Buffer): void {
	const target = value.toString("utf8");
	if (
		!Buffer.from(target, "utf8").equals(value) ||
		target.length === 0 ||
		isAbsolute(target) ||
		/^[A-Za-z]:\//.test(target) ||
		target.includes("\\") ||
		/[\u0000-\u001f\u007f]/.test(target) ||
		target.split("/").some((segment) => segment.length === 0 || segment === ".")
	) {
		throw new CandidateViewError("candidate view symlink target is unsafe");
	}
	const resolvedTarget = resolve(dirname(join(root, entryPath)), target);
	const metadata = join(root, ".git");
	if (!isWithin(root, resolvedTarget) || resolvedTarget === metadata || isWithin(metadata, resolvedTarget)) {
		throw new CandidateViewError("candidate view symlink target escapes its frozen root or enters metadata");
	}
}

function splitNulTerminated(raw: Buffer, errorMessage: string): Buffer[] {
	if (raw.length === 0) return [];
	if (raw.at(-1) !== 0) throw new CandidateViewError(errorMessage);
	const tokens: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < raw.length; index += 1) {
		if (raw[index] === 0) {
			tokens.push(raw.subarray(start, index));
			start = index + 1;
		}
	}
	return tokens;
}

function parseTree(cwd: string, tree: string, executor: CandidateGitExecutor): ParsedCandidateTree {
	const raw = candidateGit(cwd, ["ls-tree", "-r", "-z", tree], process.env, "buffer", executor) as Buffer;
	const entries: CandidateTreeEntry[] = [];
	const gitlinks: CandidateGitlink[] = [];
	const paths = new Set<string>();
	for (const row of splitNulTerminated(raw, "candidate tree output is not NUL-terminated")) {
		const separator = row.indexOf(0x09);
		if (separator < 0) throw new CandidateViewError("candidate tree contains an unsafe entry");
		const match = /^(100644|100755|120000) blob ([0-9a-f]{40}|[0-9a-f]{64})$|^(160000) commit ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(row.subarray(0, separator).toString("ascii"));
		const path = decodeCanonicalPath(row.subarray(separator + 1));
		if (!match || paths.has(path)) throw new CandidateViewError("candidate tree contains an unsafe entry");
		paths.add(path);
		const mode = match[1] ?? match[3]!;
		const objectId = match[2] ?? match[4]!;
		if (mode === "160000") gitlinks.push({ path, mode, objectId });
		else if (isMaterializedCandidateMode(mode)) entries.push({ path, mode, objectId });
	}
	const compare = (left: CandidateTreeEntry, right: CandidateTreeEntry): number => left.path.localeCompare(right.path);
	entries.sort(compare); gitlinks.sort(compare);
	return { entries, gitlinks };
}

function gitPathTokens(cwd: string, arguments_: readonly string[], executor: CandidateGitExecutor): Buffer[] {
	const raw = candidateGit(cwd, arguments_, process.env, "buffer", executor) as Buffer;
	return splitNulTerminated(raw, "candidate scope Git output is not NUL-terminated");
}

// One manifest entry per changed path, carrying the state contract v2 ships in
// `changed_path_manifest`. `deriveChangedScope` cannot produce this: it runs
// `--name-status`, which reports a status and a path but never an old mode, so
// a mode-only or type change is invisible to it. `--raw` carries both modes and
// both blob ids, which is what makes `modeOnly` decidable at all.
export interface ChangedPathEntry {
	readonly path: string;
	readonly status: string;
	readonly oldMode: string;
	readonly newMode: string;
	readonly deleted: boolean;
	readonly typeChanged: boolean;
	readonly modeOnly: boolean;
}

//
// gentle-pi#518: both derivations diff with `--no-renames`, exactly as the
// native provider does. A rename is then its source deletion plus its
// destination addition, one path each, so the projection identity Pi freezes
// is the identity native STATUS projects. Rename detection here previously
// kept only the destination, and an exact staged rename was rejected before
// native admission with candidate-target-projection-drift.
export function deriveChangedPathManifest(cwd: string, baseTree: string, candidateTree: string, executor: CandidateGitExecutor = defaultCandidateGitExecutor): readonly ChangedPathEntry[] {
	const tokens = gitPathTokens(cwd, ["diff", "--raw", "-z", "--abbrev=40", "--no-ext-diff", "--no-renames", baseTree, candidateTree], executor);
	const entries: ChangedPathEntry[] = [];
	for (let index = 0; index < tokens.length;) {
		const header = tokens[index++]?.toString("ascii");
		if (header === undefined) break;
		// `:<old_mode> <new_mode> <old_sha> <new_sha> <status>`; with rename
		// detection off, Git never emits a two-path R or C record here.
		const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{7,64}) ([0-9a-f]{7,64}) ([AMDT])$/.exec(header);
		if (match === null) throw new CandidateViewError("candidate manifest Git output contains an unsafe raw header", "manifest-derivation-invalid");
		const [, oldMode, newMode, oldSha, newSha, status] = match;
		const rawPath = tokens[index++];
		if (rawPath === undefined) throw new CandidateViewError("candidate manifest Git output is incomplete", "manifest-derivation-invalid");
		const path = decodeCanonicalPath(rawPath);
		entries.push(Object.freeze({
			path,
			status,
			oldMode,
			newMode,
			deleted: status === "D",
			typeChanged: status === "T",
			// Identical blob on both sides with different modes is the case the
			// sorted-path comparison could never see.
			modeOnly: oldSha === newSha && oldMode !== newMode,
		}));
	}
	return Object.freeze([...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));
}

// Pi's own canonical digest of a changed-path manifest: sorted by path, with
// the wire (snake_case) field names the v2 `changed_path` schema uses. This
// is deliberately NOT an attempt to reproduce the provider's undocumented
// `changed_path_manifest_sha256` canonicalization byte-for-byte (design.md's
// open question). It is Pi's own self-consistency check: does the manifest a
// descriptor carries digest to the same value the descriptor claims for it?
// A caller (or a corrupted transport) that supplies a manifest and a claimed
// digest that disagree with each other is caught here, independent of and
// before any comparison against live Git content.
export function digestChangedPathManifest(manifest: readonly ChangedPathEntry[]): string {
	const canonical = [...manifest]
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map((entry) => ({
			path: entry.path,
			status: entry.status,
			old_mode: entry.oldMode,
			new_mode: entry.newMode,
			deleted: entry.deleted,
			type_changed: entry.typeChanged,
			mode_only: entry.modeOnly,
		}));
	return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function assertManifestMatchesGit(descriptor: NativeCandidateProjectionDescriptor, derived: readonly ChangedPathEntry[]): void {
	const claimed = descriptor.manifest;
	if (claimed === undefined) return;

	// Self-consistency: does the manifest digest to what the subject claims
	// for it? Checked before any Git comparison, same as input-divergence.
	if (descriptor.manifestSha256 !== undefined && descriptor.providerManifestHashVerified !== true && digestChangedPathManifest(claimed) !== descriptor.manifestSha256) {
		throw new CandidateViewError("native manifest does not digest to its own artifact-subject claim", "manifest-subject-drift");
	}

	// First: is the provider's own input self-consistent? A manifest that does
	// not describe the descriptor's paths is not a drift observation, it is a
	// malformed input, and saying so separately keeps the diagnosis honest.
	const claimedPaths = [...claimed.map((entry) => entry.path)].sort();
	if (JSON.stringify(claimedPaths) !== JSON.stringify([...descriptor.paths].sort())) {
		throw new CandidateViewError("native manifest does not describe the same paths as its own projection", "manifest-input-divergence");
	}

	const derivedByPath = new Map(derived.map((entry) => [entry.path, entry]));
	if (JSON.stringify(claimedPaths) !== JSON.stringify(derived.map((entry) => entry.path))) {
		throw new CandidateViewError("native manifest paths do not match Git content", "manifest-path-set-drift");
	}

	for (const entry of claimed) {
		const actual = derivedByPath.get(entry.path);
		if (actual === undefined) throw new CandidateViewError("native manifest paths do not match Git content", "manifest-path-set-drift");
		if (entry.status !== actual.status || entry.deleted !== actual.deleted) {
			throw new CandidateViewError(`native manifest status for ${entry.path} does not match Git content`, "manifest-status-drift");
		}
		if (entry.oldMode !== actual.oldMode || entry.newMode !== actual.newMode || entry.modeOnly !== actual.modeOnly || entry.typeChanged !== actual.typeChanged) {
			throw new CandidateViewError(`native manifest mode state for ${entry.path} does not match Git content`, "manifest-mode-drift");
		}
	}
}

function deriveChangedScope(cwd: string, baseTree: string, candidateTree: string, entries: readonly CandidateTreeEntry[], executor: CandidateGitExecutor): CandidateViewScope {
	const present = new Map(entries.map((entry) => [entry.path, entry]));
	const paths = new Set<string>();
	const deleted = new Set<string>();
	// `--no-renames` mirrors the native projection: a rename is one deleted
	// path plus one added path (gentle-pi#518), and every record carries
	// exactly one path.
	const tokens = gitPathTokens(cwd, ["diff", "--name-status", "-z", "--no-ext-diff", "--no-renames", baseTree, candidateTree], executor);
	for (let index = 0; index < tokens.length;) {
		const status = tokens[index++]?.toString("ascii");
		if (status === undefined || !/^[AMDT]$/.test(status)) throw new CandidateViewError("candidate scope Git output contains an unsafe status");
		const rawPath = tokens[index++];
		if (rawPath === undefined) throw new CandidateViewError("candidate scope Git output is incomplete");
		const path = decodeCanonicalPath(rawPath);
		if (paths.has(path) || deleted.has(path)) throw new CandidateViewError("candidate scope Git output contains duplicate paths");
		if (status === "D") {
			if (present.has(path)) throw new CandidateViewError("candidate scope deletion is present in the candidate tree");
			deleted.add(path);
		} else {
			if (!present.has(path)) throw new CandidateViewError("candidate scope path is absent from the candidate tree");
			paths.add(path);
		}
	}
	const presentPaths = [...paths].sort();
	const deletedPaths = [...deleted].sort();
	const allPaths = [...presentPaths, ...deletedPaths].sort();
	return {
		paths: allPaths,
		modes: Object.fromEntries(presentPaths.map((path) => [path, present.get(path)!.mode])),
		gitlinks: Object.fromEntries(presentPaths.flatMap((path) => {
			const entry = present.get(path)!;
			return entry.mode === "160000" ? [[path, entry.objectId]] : [];
		})),
		deletedPaths,
	};
}

function entryContentHash(root: string, entry: CandidateTreeEntry): string {
	const path = join(root, entry.path);
	const item = lstatSync(path);
	if (entry.mode === "120000") {
		if (!item.isSymbolicLink()) throw new CandidateViewError("candidate view symlink does not match its frozen tree");
		const target = readlinkSync(path, "buffer");
		// libuv reports Windows symlink targets with backslash separators even
		// when the link was materialized from a forward-slash blob target, so raw
		// readlink bytes can never equal the frozen blob on win32. Normalize win32
		// separators back to POSIX form before the safety checks and the content
		// hash; every other platform stays byte-exact.
		const bytes = process.platform === "win32"
			? Buffer.from(target.toString("utf8").replace(/\\/g, "/"), "utf8")
			: Buffer.isBuffer(target) ? target : Buffer.from(target);
		assertSafeSymlinkTarget(root, entry.path, bytes);
		return createHash("sha256").update(bytes).digest("hex");
	}
	if (!item.isFile() || item.isSymbolicLink()) throw new CandidateViewError("candidate view entry does not match its frozen tree");
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function candidateDirectories(root: string, entries: readonly CandidateViewEntry[]): string[] {
	const directories = new Set([root]);
	for (const entry of entries) {
		for (let path = dirname(join(root, entry.path)); isWithin(root, path) || path === root; path = dirname(path)) {
			directories.add(path);
			if (path === root) break;
		}
	}
	return [...directories].sort((left, right) => right.length - left.length);
}

function makeReadonly(root: string, entries: readonly CandidateViewEntry[]): void {
	for (const entry of entries) {
		if (entry.mode !== "120000") chmodSync(join(root, entry.path), entry.mode === "100755" ? 0o555 : 0o444);
	}
	const gitFile = join(root, ".git");
	const metadata = lstatSync(gitFile);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CandidateViewError("candidate worktree metadata is unsafe");
	chmodSync(gitFile, 0o444);
	for (const directory of candidateDirectories(root, entries)) chmodSync(directory, 0o555);
}

function makeWritableForCleanup(path: string): void {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (!entry || entry.isSymbolicLink()) return;
	if (entry.isDirectory()) {
		for (const child of readdirSync(path)) makeWritableForCleanup(join(path, child));
		chmodSync(path, 0o755);
		return;
	}
	chmodSync(path, 0o644);
}

function candidateViewParent(commonDir: string, platform: NodeJS.Platform): string {
	const control = join(commonDir, "gentle-ai");
	mkdirSync(control, { recursive: true, mode: 0o700 });
	const controlStat = lstatSync(control);
	if (!controlStat.isDirectory() || controlStat.isSymbolicLink() || realpathSync(control) !== control) throw new CandidateViewError("candidate view ancestor is unsafe");
	const parent = join(control, "candidate-views");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const stat = lstatSync(parent);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CandidateViewError("candidate view parent is unsafe");
	try {
		return prepareCandidateOwnerParent(commonDir, platform);
	} catch (error) {
		throw new CandidateViewError("candidate view owner preparation failed", "candidate-owner-preparation-failed", undefined, { cause: error });
	}
}

export interface ResolvedCandidateBase {
	commit: string;
	tree: string;
}

function isFullCommitId(selector: string): boolean {
	return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(selector);
}

function explicitBaseRefCandidates(cwd: string, selector: string, env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): string[] {
	if (selector === "HEAD" || isFullCommitId(selector)) return [selector];
	const refs = new Set(git(cwd, ["for-each-ref", "--format=%(refname)"], env, executor).split("\n").filter((ref) => ref.length > 0));
	const candidates = selector.startsWith("refs/")
		? [selector]
		: [
			`refs/${selector}`,
			`refs/tags/${selector}`,
			`refs/heads/${selector}`,
			`refs/remotes/${selector}`,
			`refs/remotes/${selector}/HEAD`,
		];
	return [...new Set(candidates)].filter((candidate) => refs.has(candidate));
}

// Runs a probe command that may exit nonzero as an expected signal (absent
// ref, detached HEAD). Returns the exit status and trimmed stdout. Timeout,
// output-limit, and unexpected Git failures propagate as sanitized
// CandidateViewError diagnostics, same as candidateGit.
function probeCandidateGit(cwd: string, arguments_: readonly string[], env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): { status: number; stdout: string } {
	const timeoutMs = resolveCandidateGitTimeoutMs(env);
	try {
		const stdout = executor("git", arguments_, {
			cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs, maxBuffer: CANDIDATE_GIT_MAX_BUFFER_BYTES, windowsHide: true,
		}) as string;
		return { status: 0, stdout: stdout.trim() };
	} catch (error) {
		const detail = error as NodeJS.ErrnoException & { killed?: boolean; status?: number; stdout?: string | Buffer };
		if (detail.code === "ENOBUFS" || detail.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.OUTPUT_LIMIT, arguments_, timeoutMs);
		if (detail.code === "ETIMEDOUT" || detail.killed === true) throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.TIMEOUT, arguments_, timeoutMs);
		if (typeof detail.status === "number") return { status: detail.status, stdout: typeof detail.stdout === "string" ? detail.stdout.trim() : "" };
		throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.GIT_FAILURE, arguments_, timeoutMs);
	}
}

// An unborn repository's HEAD is a symbolic ref to a branch with no commits.
// `symbolic-ref --quiet HEAD` exits nonzero for a detached HEAD (not unborn).
// `rev-parse --verify --quiet <ref>` distinguishes a valid unborn (status 1,
// ref absent) from a broken symbolic ref (exit 0, ref OID text exists even
// when the object is missing). Any other status (128, etc.) signals
// corruption or an I/O failure, so it fails closed instead of masquerading as
// an unborn repository.
function isUnbornSymbolicHead(cwd: string, env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): boolean {
	const symbolic = probeCandidateGit(cwd, ["symbolic-ref", "--quiet", "HEAD"], env, executor);
	if (symbolic.status !== 0) return false;
	const refProbeArguments = ["rev-parse", "--verify", "--quiet", symbolic.stdout];
	const refProbe = probeCandidateGit(cwd, refProbeArguments, env, executor);
	if (refProbe.status === 1) return true;
	if (refProbe.status === 0) return false;
	throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.GIT_FAILURE, refProbeArguments, resolveCandidateGitTimeoutMs(env));
}

// Derives Git's repository-native empty tree without hardcoding the SHA-1 id,
// so a sha256 repository derives its own empty-tree object id. `mktree` with
// ignored stdin reads empty input and writes the empty tree object.
function resolveEmptyTree(cwd: string, env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): string {
	return git(cwd, ["mktree"], env, executor);
}

function resolveCandidateBase(cwd: string, baseRef: string | undefined, env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): ResolvedCandidateBase {
	const selector = baseRef ?? "HEAD";
	// An unborn repository has a symbolic HEAD pointing at a branch with no
	// commits yet. Its review base is Git's repository-native empty tree, not a
	// missing or malformed commit. Only the default/HEAD selector is entitled to
	// the empty-tree base; a detached HEAD over a missing commit stays fail-closed.
	if (selector === "HEAD" && isUnbornSymbolicHead(cwd, env, executor)) {
		return { commit: "HEAD", tree: resolveEmptyTree(cwd, env, executor) };
	}
	try {
		if (baseRef !== undefined) {
			const candidates = explicitBaseRefCandidates(cwd, selector, env, executor);
			if (candidates.length > 1) throw new CandidateViewError("candidate base reference is ambiguous", "base-ref-ambiguous");
			if (candidates.length === 0) throw new CandidateViewError("candidate base reference is unresolvable", "base-ref-unresolvable");
		}
		const firstCommit = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${selector}^{commit}`], env, executor);
		const tree = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${firstCommit}^{tree}`], env, executor);
		const confirmedCommit = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${selector}^{commit}`], env, executor);
		if (firstCommit !== confirmedCommit) throw new CandidateViewError("candidate base reference moved during resolution", "base-ref-moved");
		const confirmedTree = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${confirmedCommit}^{tree}`], env, executor);
		if (tree !== confirmedTree) throw new CandidateViewError("candidate base tree changed during resolution", "base-ref-moved");
		return { commit: confirmedCommit, tree: confirmedTree };
	} catch (error) {
		if (error instanceof CandidateViewError && (error.diagnostics !== undefined || error.reason === "base-ref-ambiguous" || error.reason === "base-ref-moved" || error.reason === "base-ref-unresolvable")) throw error;
		throw new CandidateViewError("candidate base reference is unresolvable", "base-ref-unresolvable");
	}
}

function resolveCandidateBaseTree(cwd: string, baseTree: string, executor: CandidateGitExecutor): ResolvedCandidateBase {
	const row = git(cwd, ["log", "--format=%H%x09%T", "HEAD"], process.env, executor)
		.split("\n")
		.find((entry) => entry.endsWith(`\t${baseTree}`));
	if (row === undefined) throw new CandidateViewError("native projection base is not reachable from HEAD");
	const base = resolveCandidateBase(cwd, row.slice(0, row.indexOf("\t")), process.env, executor);
	if (base.tree !== baseTree) throw new CandidateViewError("native projection base tree is inconsistent");
	return base;
}

export function resolveCanonicalCandidateBase(contributorRoot: string, baseRef: string): ResolvedCandidateBase {
	return resolveCandidateBase(realpathSync(contributorRoot), baseRef, process.env, defaultCandidateGitExecutor);
}

function materializeSymlinkEntries(root: string, entries: readonly CandidateTreeEntry[], executor: CandidateGitExecutor): void {
	if (entries.length === 0) return;
	for (const entry of entries) {
		const target = candidateGit(root, ["cat-file", "blob", entry.objectId], process.env, "buffer", executor) as Buffer;
		// The frozen blob bytes are the authoritative symlink target: validate
		// them lexically before creating anything, so committed targets that are
		// genuinely unsafe (backslashes, escapes, metadata) are rejected on every
		// platform identically, independent of how the host readlink renders
		// separators.
		assertSafeSymlinkTarget(root, entry.path, target);
		const path = join(root, entry.path);
		mkdirSync(dirname(path), { recursive: true });
		rmSync(path, { force: true });
		try {
			symlinkSync(target.toString("utf8"), path);
		} catch {
			throw new CandidateViewError("candidate view symlink could not be materialized; the host requires symlink privilege for committed symlinks", "symlink-materialization-failed");
		}
	}
}

function checkoutMaterializedEntries(root: string, entries: readonly CandidateTreeEntry[], executor: CandidateGitExecutor): void {
	let batch: string[] = [];
	let bytes = 0;
	const flush = (): void => {
		if (batch.length === 0) return;
		git(root, ["checkout-index", "-f", "--", ...batch], process.env, executor);
		batch = []; bytes = 0;
	};
	for (const entry of entries) {
		// Committed symlinks (mode 120000) are excluded from checkout-index and
		// materialized directly from their blob bytes. Git for Windows cannot
		// round-trip symlink targets: with core.symlinks=false it writes the
		// target as a plain file, and even with core.symlinks=true it rewrites
		// forward slashes to backslashes, so the frozen-tree verification in
		// entryContentHash (which compares readlinkSync bytes with the blob)
		// fails with "candidate view symlink does not match its frozen tree" or
		// an unsafe-target rejection. Node symlinkSync preserves the blob bytes
		// verbatim on every platform.
		if (entry.mode === "120000") continue;
		const size = Buffer.byteLength(entry.path, "utf8") + 1;
		if (batch.length > 0 && bytes + size > 16_384) flush();
		batch.push(entry.path); bytes += size;
	}
	flush();
	materializeSymlinkEntries(root, entries.filter((entry) => entry.mode === "120000"), executor);
}

// Creates an unborn worktree (symbolic HEAD pointing at a branch with no
// commits, no ref written, no phantom commit). Git 2.42+ supports --orphan
// directly; older Git lacks the flag and reports an unsupported-option usage
// error (exit status 129). Only that exact status triggers the fallback: a
// temporary empty-tree commit seeds a detached --no-checkout worktree, then
// a symbolic-ref rewrite makes HEAD unborn. The temporary commit is never
// referenced by any ref and is GC-able, so it is not a phantom commit. The
// fallback uses a deterministic author/committer identity and timestamp in a
// copied environment so it does not depend on user.name/user.email or the
// ambient date. Contributor HEAD, branch, refs, and index are never touched.
function addUnbornWorktree(cwd: string, root: string, branch: string, env: NodeJS.ProcessEnv, executor: CandidateGitExecutor): void {
	const primary = probeCandidateGit(cwd, ["worktree", "add", "--orphan", "-b", branch, root], env, executor);
	if (primary.status === 0) return;
	// Only the unsupported-option usage status (129, pre-2.42 Git lacking --orphan)
	// triggers the fallback. Every other status propagates as a git-failure.
	if (primary.status !== 129 || existsSync(root)) throw candidateGitFailure(CANDIDATE_VIEW_GIT_FAILURE_CATEGORY.GIT_FAILURE, ["worktree", "add", "--orphan", "-b", branch, root], resolveCandidateGitTimeoutMs(env));
	const fallbackEnv = {
		...env,
		GIT_AUTHOR_NAME: "gentle-ai-candidate",
		GIT_AUTHOR_EMAIL: "gentle-ai-candidate@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "gentle-ai-candidate",
		GIT_COMMITTER_EMAIL: "gentle-ai-candidate@example.invalid",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	};
	const emptyTree = git(cwd, ["mktree"], fallbackEnv, executor);
	const tempCommit = git(cwd, ["commit-tree", "-m", "gentle-ai-candidate", emptyTree], fallbackEnv, executor);
	git(cwd, ["worktree", "add", "--no-checkout", "--detach", root, tempCommit], env, executor);
	git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`], env, executor);
}

function normalizeIntendedUntracked(paths: readonly string[] | undefined): readonly string[] | undefined {
	if (paths === undefined) return undefined;
	if (!Array.isArray(paths) || paths.some((path) => !isSafeCandidatePath(path)) || new Set(paths).size !== paths.length) {
		throw new CandidateViewError("candidate intended-untracked selection is invalid");
	}
	return Object.freeze([...paths]);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function timestampSeconds(timestampNs: bigint): number {
	// Node's utimes API takes Unix seconds as a number. Splitting the value keeps
	// the seconds conversion exact; the explicit racy-clean backdate below is far
	// larger than the fractional precision a Number can represent at this epoch.
	return Number(timestampNs / 1_000_000_000n) + Number(timestampNs % 1_000_000_000n) / 1_000_000_000;
}

function seedPrivateIndexFromLiveIndex(cwd: string, indexPath: string, executor: CandidateGitExecutor): boolean {
	const liveIndex = resolve(cwd, git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"], process.env, executor));
	const entry = lstatSync(liveIndex, { bigint: true, throwIfNoEntry: false });
	if (entry === undefined) return false; if (!entry.isFile()) throw new CandidateViewError("candidate live Git index is not a regular file");
	if (entry.mtimeNs < PRIVATE_INDEX_RACY_BACKDATE_NS) throw new CandidateViewError("candidate live Git index timestamp is too early for racy-clean protection");
	copyFileSync(liveIndex, indexPath);
	// Git's racy-clean check compares index and tracked-file mtimes. copyFileSync
	// gives the private index a new timestamp; restoring a Date can also lose
	// nanoseconds. Backdate the bigint live timestamp instead, then verify the
	// filesystem applied enough of that bounded interval for Git to refresh
	// content rather than trusting a racy-clean stat match.
	utimesSync(indexPath, timestampSeconds(entry.atimeNs), timestampSeconds(entry.mtimeNs - PRIVATE_INDEX_RACY_BACKDATE_NS));
	const privateMtimeNs = lstatSync(indexPath, { bigint: true }).mtimeNs;
	if (privateMtimeNs >= entry.mtimeNs || entry.mtimeNs - privateMtimeNs < PRIVATE_INDEX_RACY_SAFETY_NS) {
		throw new CandidateViewError("candidate private Git index timestamp cannot preserve racy-clean protection");
	}
	for (const name of readdirSync(dirname(liveIndex))) if (/^sharedindex\.[0-9a-f]+$/.test(name)) {
		try {
			const sharedIndex = join(dirname(liveIndex), name);
			if (lstatSync(sharedIndex).isFile()) copyFileSync(sharedIndex, join(dirname(indexPath), name));
		} catch (error) {
			if (!isErrnoCode(error, "ENOENT")) throw error;
		}
	}
	return true;
}

function materializeCandidateView(request: CreateCandidateViewRequest, executor: CandidateGitExecutor, platform: NodeJS.Platform = process.platform): CandidateViewRecord {
	const contributorRoot = realpathSync(request.contributorRoot);
	if (!lstatSync(contributorRoot).isDirectory()) throw new CandidateViewError("contributor root is not a directory");
	if (request.committedOnly === true && request.baseRef === undefined) throw new CandidateViewError("committed-only candidate views require an explicit base reference", "committed-only-base-required");
	const commonDir = resolve(contributorRoot, git(contributorRoot, ["rev-parse", "--git-common-dir"], process.env, executor));
	const canonicalCommonDir = realpathSync(commonDir);
	const base = resolveCandidateBase(contributorRoot, request.baseRef, process.env, executor);
	const committedOnly = request.committedOnly === true;
	const intendedUntracked = normalizeIntendedUntracked(request.intendedUntracked);
	const candidateCommit = committedOnly
		? resolveCandidateBase(contributorRoot, "HEAD", process.env, executor)
		: base;
	const parent = candidateViewParent(canonicalCommonDir, platform);
	sweepCandidateOwners(canonicalCommonDir, (args) => git(canonicalCommonDir, args, process.env, executor), makeWritableForCleanup, platform);
	const index = mkdtempSync(join(tmpdir(), "gentle-ai-candidate-index-"));
	const indexPath = join(index, "index");
	const environment = { ...process.env, GIT_INDEX_FILE: indexPath };
	try {
		const baseCommit = base.commit;
		const unborn = baseCommit === "HEAD";
		// Workspace candidates seed their isolated index from the resolved live index; missing indexes use the frozen base.
		const seededFromLiveIndex = !committedOnly && intendedUntracked !== undefined && seedPrivateIndexFromLiveIndex(contributorRoot, indexPath, executor);
		if (!seededFromLiveIndex) {
			// For an unborn repository the base tree is Git's empty tree, so seed the
			// private candidate index from `--empty` instead of a non-existent commit.
			if (unborn) git(contributorRoot, ["read-tree", "--empty"], environment, executor);
			else git(contributorRoot, ["read-tree", candidateCommit.commit], environment, executor);
		}
		if (!committedOnly) {
			if (intendedUntracked === undefined) git(contributorRoot, ["add", "-A"], environment, executor);
			else {
				git(contributorRoot, ["add", "-u"], environment, executor);
				if (intendedUntracked.length > 0) git(contributorRoot, ["add", "--", ...intendedUntracked], { ...environment, GIT_LITERAL_PATHSPECS: "1" }, executor);
			}
		}
		const candidateTree = git(contributorRoot, ["write-tree"], environment, executor);
		const root = join(parent, randomUUID());
		let owner: CandidateViewOwner;
		try {
			owner = createCandidateOwner(canonicalCommonDir, root, platform);
		} catch (error) {
			throw new CandidateViewError("candidate view owner preparation failed", "candidate-owner-preparation-failed", undefined, { cause: error });
		}
		// The worktree is created under the same try/catch cleanup boundary as
		// the read-tree materialization that follows. addUnbornWorktree's
		// fallback path can register a worktree with `worktree add` and then
		// fail on a later step (for example `symbolic-ref`); moving creation
		// here ensures any such partial registration is removed by the catch
		// below instead of leaking a registered/admin worktree and directory.
		try {
			// An unborn repository has no commit to detach a worktree at. addUnbornWorktree
			// creates an orphan worktree (unborn branch, no commit, no ref) to host the
			// materialized candidate tree without a phantom commit, with a fallback for
			// Git versions older than 2.42 that do not support --orphan.
			if (unborn) addUnbornWorktree(contributorRoot, root, `gentle-ai-candidate-${randomUUID()}`, process.env, executor);
			else git(contributorRoot, ["worktree", "add", "--detach", "--no-checkout", root, candidateCommit.commit], process.env, executor);
			git(root, ["read-tree", candidateTree], process.env, executor);
			const tree = parseTree(root, candidateTree, executor);
			checkoutMaterializedEntries(root, tree.entries, executor);
			const entries = tree.entries.map((entry) => ({ ...entry, contentHash: entryContentHash(root, entry) }));
			const scope = deriveChangedScope(contributorRoot, base.tree, candidateTree, [...tree.entries, ...tree.gitlinks], executor);
			for (const gitlink of tree.gitlinks) if (lstatSync(join(root, gitlink.path), { throwIfNoEntry: false })) throw new CandidateViewError("candidate view materialized a metadata-only gitlink");
			makeReadonly(root, entries);
			return { owner, token: basename(root), root: realpathSync(root), parent, contributorRoot, commonDir: canonicalCommonDir, baseCommit, baseTree: base.tree, candidateTree, committedOnly, intendedUntracked, entries, gitlinks: tree.gitlinks, scope, gitExecutor: executor };
		} catch (error) {
			try { removeCandidateOwner(owner, (args) => git(canonicalCommonDir, args, process.env, executor), makeWritableForCleanup, false, platform); } catch { /* Preserve the marker and any partial worktree for conservative recovery. */ }
			throw error;
		}
	} finally {
		rmSync(index, { recursive: true, force: true });
	}
}

function assertRecordSafe(record: CandidateViewRecord, platform: NodeJS.Platform = process.platform): void {
	try {
		const contributor = lstatSync(record.contributorRoot);
		if (!contributor.isDirectory() || contributor.isSymbolicLink() || realpathSync(record.contributorRoot) !== record.contributorRoot) {
			throw new CandidateViewError("candidate contributor root identity changed", "contributor-root-drift");
		}
		const toplevel = realpathSync(git(record.contributorRoot, ["rev-parse", "--show-toplevel"], process.env, record.gitExecutor));
		const commonDir = realpathSync(resolve(record.contributorRoot, git(record.contributorRoot, ["rev-parse", "--git-common-dir"], process.env, record.gitExecutor)));
		if (!samePath(toplevel, record.contributorRoot, platform) || !samePath(commonDir, record.commonDir, platform)) {
			throw new CandidateViewError("candidate contributor root Git identity changed", "contributor-root-drift");
		}
	} catch (error) {
		if (error instanceof CandidateViewError) throw error;
		throw new CandidateViewError("candidate contributor root identity cannot be verified", "contributor-root-drift");
	}
	const root = record.root;
	assertCandidateOwnerParent(record.commonDir, platform);
	if (!isWithin(record.parent, root) || !existsSync(root)) throw new CandidateViewError("candidate view is missing or moved");
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) throw new CandidateViewError("candidate view root is unsafe");
	for (const directory of candidateDirectories(root, record.entries)) {
		const metadata = lstatSync(directory);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) throw new CandidateViewError("candidate view directory is unsafe or writable");
	}
	const gitFile = lstatSync(join(root, ".git"));
	if (!gitFile.isFile() || gitFile.isSymbolicLink() || (gitFile.mode & 0o222) !== 0) throw new CandidateViewError("candidate worktree metadata is unsafe or writable");
	if (gitPathTokens(root, ["ls-files", "--others", "--exclude-standard", "-z"], record.gitExecutor).length !== 0) throw new CandidateViewError("candidate view contains injected untracked entries");
	const tree = git(root, ["write-tree"], process.env, record.gitExecutor);
	if (tree !== record.candidateTree) throw new CandidateViewError("candidate view index no longer matches its frozen tree");
	for (const gitlink of record.gitlinks) {
		if (!isSafeCandidatePath(gitlink.path) || gitlink.mode !== "160000" || !isCanonicalObjectId(gitlink.objectId)) throw new CandidateViewError("candidate view gitlink metadata is unsafe");
		if (lstatSync(join(root, gitlink.path), { throwIfNoEntry: false })) throw new CandidateViewError("candidate view contains materialized gitlink contents");
	}
	for (const entry of record.entries) {
		if (!isSafeCandidatePath(entry.path)) throw new CandidateViewError("candidate view entry path is unsafe");
		const path = join(root, entry.path);
		if (!isWithin(root, path)) throw new CandidateViewError("candidate view entry is missing or moved");
		const item = lstatSync(path, { throwIfNoEntry: false });
		if (!item) throw new CandidateViewError("candidate view entry is missing or moved");
		if (entry.mode === "120000") {
			if (!item.isSymbolicLink()) throw new CandidateViewError("candidate view symlink is unsafe or changed");
		} else if (!item.isFile() || item.isSymbolicLink() || (item.mode & 0o222) !== 0 || !hasExpectedExecutableBits(item.mode, entry.mode, platform)) {
			throw new CandidateViewError("candidate view entry is unsafe, writable, or has a changed mode");
		}
		const actualHash = entryContentHash(root, entry);
		if (actualHash !== entry.contentHash) throw new CandidateViewError("candidate view content no longer matches its frozen tree");
	}
}

export class CandidateViewRegistry {
	private readonly records = new Map<string, CandidateViewRecord>();
	private readonly gitExecutor: CandidateGitExecutor;
	private readonly platform: NodeJS.Platform;
	constructor(gitExecutor: CandidateGitExecutor = defaultCandidateGitExecutor, platform: NodeJS.Platform = process.platform) {
		this.gitExecutor = gitExecutor;
		this.platform = platform;
	}
	// Lifecycle state is scoped to the canonical target worktree as well as the
	// provider lineage. Lineage text is repository-local and may legitimately be
	// identical in two repositories owned by one Pi session.
	private readonly lineages = new Map<string, string>();
	private readonly projections = new Map<string, FrozenCandidateProjection>();
	private readonly replays = new Map<string, string>();
	private readonly current = new Map<string, { lineageId: string; token: string }>();
	// The last dispatch-binding hydration that was attempted and failed. A
	// swallowed hydration failure is its own defect (field report 2026-08-16):
	// without it the later dispatch refusal claims no binding was ever
	// available instead of naming the attempt and its typed cause.
	private readonly lastHydrationFailures = new Map<string, { lineageId: string; reason: string; message: string }>();

	private canonicalRoot(contributorRoot: string): string {
		try {
			return realpathSync(contributorRoot);
		} catch {
			throw new CandidateViewError("candidate contributor root could not be resolved", "contributor-root-unresolvable");
		}
	}

	private lineageKey(contributorRoot: string, lineageId: string): string {
		return `${this.canonicalRoot(contributorRoot)}\u0000${lineageId}`;
	}

	private replayKey(contributorRoot: string, replayKey: string): string {
		return `${this.canonicalRoot(contributorRoot)}\u0000${replayKey}`;
	}

	private uniqueKey(
		entries: ReadonlyMap<string, unknown>,
		lineageId: string,
		contributorRoot: string | undefined,
	): string | undefined {
		if (contributorRoot !== undefined) {
			const key = this.lineageKey(contributorRoot, lineageId);
			return entries.has(key) ? key : undefined;
		}
		const suffix = `\u0000${lineageId}`;
		const matches = [...entries.keys()].filter((key) => key.endsWith(suffix));
		if (matches.length === 0) return undefined;
		if (matches.length !== 1) {
			throw new CandidateViewError(`candidate lifecycle lineage ${lineageId} is ambiguous across target roots; pass an explicit workspaceRoot`, "lineage-root-ambiguous");
		}
		return matches[0]!;
	}

	private requireKey(
		entries: ReadonlyMap<string, unknown>,
		lineageId: string,
		contributorRoot: string | undefined,
		missing: string,
	): string {
		return this.uniqueKey(entries, lineageId, contributorRoot)
			?? (() => { throw new CandidateViewError(missing); })();
	}

	/**
	 * Returns the one active target root bound to a lineage, or undefined.
	 * Throws when that lineage is bound across multiple roots; callers must pass
	 * an explicit workspaceRoot to resolve the ambiguity.
	 */
	resolveWorkspaceRoot(lineageId: string): string | undefined {
		const key = this.uniqueKey(this.lineages, lineageId, undefined);
		return key === undefined ? undefined : key.slice(0, key.lastIndexOf("\u0000"));
	}

	assertWorkspaceRoot(lineageId: string, contributorRoot: string): void {
		const root = this.canonicalRoot(contributorRoot);
		const exactKey = this.lineageKey(root, lineageId);
		if (this.lineages.has(exactKey)) {
			this.assertLineageRootIdentity(lineageId, root);
			return;
		}
		const bound = this.resolveWorkspaceRoot(lineageId);
		if (bound !== undefined) {
			throw new CandidateViewError(`candidate lifecycle lineage ${lineageId} is bound to ${bound}, not the requested workspaceRoot ${root}`, "lineage-root-drift");
		}
	}

	private assertLineageRootIdentity(lineageId: string, contributorRoot: string): void {
		const key = this.lineageKey(contributorRoot, lineageId);
		const token = this.lineages.get(key);
		const record = token === undefined ? undefined : this.records.get(token);
		if (record !== undefined) assertRecordSafe(record, this.platform);
	}

	create(request: CreateCandidateViewRequest): CandidateView {
		return this.createOrReuse(request);
	}

	sweepOrphans(contributorRoot: string): void {
		try {
			const cwd = realpathSync(contributorRoot);
			const common = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"], process.env, this.gitExecutor)));
			sweepCandidateOwners(common, (args) => git(common, args, process.env, this.gitExecutor), makeWritableForCleanup, this.platform);
		} catch { /* Non-repositories and unavailable ownership are preserved. */ }
	}

	cleanupAll(): void {
		for (const token of [...this.records.keys()]) {
			try { this.cleanup(token); } catch { /* Continue other owned views; failed records remain retryable. */ }
		}
	}

	createOrReuse(request: CreateCandidateViewRequest): CandidateView {
		const contributorRoot = this.canonicalRoot(request.contributorRoot);
		const normalizedRequest = { ...request, contributorRoot };
		const scopedReplayKey = normalizedRequest.replayKey === undefined ? undefined : this.replayKey(contributorRoot, normalizedRequest.replayKey);
		const token = scopedReplayKey === undefined ? undefined : this.replays.get(scopedReplayKey);
		const existing = token === undefined ? undefined : this.records.get(token);
		if (existing) { assertRecordSafe(existing, this.platform); return this.expose(existing); }
		const record = materializeCandidateView(normalizedRequest, this.gitExecutor, this.platform);
		this.records.set(record.token, record);
		if (scopedReplayKey !== undefined) this.replays.set(scopedReplayKey, record.token);
		return this.expose(record);
	}

	bind(request: BindCandidateViewRequest): void {
		this.bindCurrent(request);
	}

	bindCurrent(request: BindCandidateViewRequest): void {
		const selectedLenses = this.validateSelectedLenses(request.selectedLenses);
		const candidate = this.records.get(request.token);
		const key = candidate === undefined ? undefined : this.lineageKey(candidate.contributorRoot, request.lineageId);
		const existingToken = key === undefined ? undefined : this.lineages.get(key);
		// A retried native START for a lineage this controller already bound
		// (native reports it "resumed") re-materializes a fresh, content-
		// identical candidate view under a new token before it reaches here.
		// Rebinding that duplicate to the same lineage key used to fail closed
		// with "candidate view lineage binding is missing or ambiguous" even
		// though nothing is actually ambiguous: it is the exact same reviewable
		// content, re-verified from Git. Discard the redundant duplicate and
		// keep the already-bound view current instead of failing the retry
		// (gentle-pi candidate-view rebind defect, ga#4085 / ga#4050).
		if (candidate !== undefined && existingToken !== undefined && existingToken !== request.token) {
			const existing = this.records.get(existingToken);
			let existingSafe = false;
			if (existing !== undefined && existing.lineageId === request.lineageId) {
				try { assertRecordSafe(existing, this.platform); existingSafe = true; } catch { existingSafe = false; }
			}
			if (existing !== undefined && existingSafe && candidateRecordsShareIdentity(existing, candidate)) {
				existing.selectedLenses = selectedLenses;
				this.remove(candidate);
				this.forget(candidate);
				this.current.set(existing.contributorRoot, { lineageId: request.lineageId, token: existingToken });
				return;
			}
		}
		const record = this.bindRecord(request.token, request.lineageId, selectedLenses);
		this.current.set(record.contributorRoot, { lineageId: request.lineageId, token: request.token });
	}

	retain(token: string, lineageId: string): void {
		const record = this.bindRecord(token, lineageId, []);
		this.current.set(record.contributorRoot, { lineageId, token });
	}

	restoreCurrentFromNativeStart(request: BindCandidateViewRequest): void {
		const record = this.records.get(request.token);
		if (!record || record.lineageId !== undefined) throw new CandidateViewError("native reviewing candidate view is missing or already bound", "authoritative-current-match-missing");
		if (this.current.has(record.contributorRoot)) throw new CandidateViewError("candidate view already has a current lineage binding", "current-binding-already-established");
		assertRecordSafe(record, this.platform);
		this.assertCurrentBindingMatchesLiveCandidate(record);
		this.bindCurrent(request);
	}

	hasCurrentBinding(contributorRoot?: string): boolean {
		return contributorRoot === undefined ? this.current.size > 0 : this.current.has(this.canonicalRoot(contributorRoot));
	}

	restoreCurrentFromAuthoritativeReviewingStates(
		contributorRoot: string,
		states: readonly AuthoritativeReviewingCandidateState[],
	): void {
		const root = this.canonicalRoot(contributorRoot);
		if (this.current.has(root)) throw new CandidateViewError("candidate view already has a current lineage binding", "current-binding-already-established");
		if (states.length === 0) throw new CandidateViewError("no authoritative reviewing lineage exactly matches the live candidate", "authoritative-current-match-missing");
		if (states.length !== 1) throw new CandidateViewError("multiple authoritative reviewing lineages exactly match the live candidate", "authoritative-current-match-ambiguous");
		const live = materializeCandidateView({ contributorRoot: root, baseRef: states[0]!.baseCommit, committedOnly: states[0]!.committedOnly === true, ...(states[0]!.intendedUntracked === undefined ? {} : { intendedUntracked: states[0]!.intendedUntracked }) }, this.gitExecutor, this.platform);
		try {
			const matches = states.filter((state) => this.matchesAuthoritativeState(live, state));
			if (matches.length === 0) throw new CandidateViewError("no authoritative reviewing lineage exactly matches the live candidate", "authoritative-current-match-missing");
			if (matches.length !== 1) throw new CandidateViewError("multiple authoritative reviewing lineages exactly match the live candidate", "authoritative-current-match-ambiguous");
			const state = matches[0]!;
			const selectedLenses = this.validateSelectedLenses(state.selectedLenses);
			this.records.set(live.token, live);
			this.bindRecord(live.token, state.lineageId, selectedLenses);
			this.current.set(root, { lineageId: state.lineageId, token: live.token });
		} catch (error) {
			this.records.delete(live.token);
			this.remove(live);
			throw error;
		}
	}

	createCorrected(lineageId: string, contributorRoot: string, replayKey: string): CandidateView {
		const root = this.canonicalRoot(contributorRoot);
		const projection = this.resolveProjection(lineageId, root);
		const scopedReplayKey = this.replayKey(root, replayKey);
		const existingToken = this.replays.get(scopedReplayKey);
		const existing = existingToken === undefined ? undefined : this.records.get(existingToken);
		if (existing) {
			if (existing.lineageId !== undefined) throw new CandidateViewError("corrected candidate replay is no longer pending");
			assertRecordSafe(existing, this.platform);
			return this.expose(existing);
		}
		const record = materializeCandidateView({ contributorRoot: root, baseRef: projection.baseCommit, committedOnly: projection.committedOnly, ...(projection.intendedUntracked === undefined ? {} : { intendedUntracked: projection.intendedUntracked }) }, this.gitExecutor, this.platform);
		try {
			if (record.baseCommit !== projection.baseCommit || record.baseTree !== projection.baseTree) throw new CandidateViewError("corrected candidate base does not match the frozen genesis base");
			if (!record.scope.paths.every((path) => projection.paths.includes(path))) throw new CandidateViewError("corrected candidate scope escapes the frozen genesis paths");
			this.records.set(record.token, record);
			this.replays.set(scopedReplayKey, record.token);
			return this.expose(record);
		} catch (error) {
			this.remove(record);
			throw error;
		}
	}

	promoteCorrected(lineageId: string, token: string, contributorRoot?: string): void {
		const replacement = this.records.get(token);
		const root = contributorRoot === undefined ? replacement?.contributorRoot : this.canonicalRoot(contributorRoot);
		const key = root === undefined ? undefined : this.uniqueKey(this.projections, lineageId, root);
		const projection = key === undefined ? undefined : this.projections.get(key);
		const currentToken = key === undefined ? undefined : this.lineages.get(key);
		const current = currentToken === undefined ? undefined : this.records.get(currentToken);
		if (!replacement || replacement.lineageId !== undefined || !key || !projection || (currentToken !== undefined && (!current || current.lineageId !== lineageId))) {
			throw new CandidateViewError("corrected candidate replacement is missing or ambiguous");
		}
		const currentBinding = this.current.get(root);
		if (currentBinding !== undefined && currentBinding.lineageId !== lineageId) {
			throw new CandidateViewError("corrected candidate replacement conflicts with the current lineage binding");
		}
		assertRecordSafe(replacement, this.platform);
		if (current) assertRecordSafe(current, this.platform);
		if (
			replacement.contributorRoot !== projection.contributorRoot ||
			replacement.baseCommit !== projection.baseCommit ||
			replacement.baseTree !== projection.baseTree ||
			replacement.committedOnly !== projection.committedOnly ||
			JSON.stringify(replacement.intendedUntracked ?? null) !== JSON.stringify(projection.intendedUntracked ?? null) ||
			!replacement.scope.paths.every((path) => projection.paths.includes(path))
		) {
			throw new CandidateViewError("corrected candidate replacement does not preserve its frozen lineage projection");
		}
		replacement.lineageId = lineageId;
		replacement.selectedLenses = [];
		this.lineages.set(key, token);
		for (const [pendingKey, pendingToken] of this.replays) if (pendingToken === token) this.replays.delete(pendingKey);
		this.projections.set(key, {
			contributorRoot: replacement.contributorRoot,
			baseCommit: replacement.baseCommit,
			baseTree: replacement.baseTree,
			candidateTree: replacement.candidateTree,
			committedOnly: replacement.committedOnly,
			intendedUntracked: replacement.intendedUntracked,
			paths: replacement.scope.paths,
			modes: replacement.scope.modes,
			gitlinks: replacement.scope.gitlinks,
			deletedPaths: replacement.scope.deletedPaths,
		});
		this.current.set(root, { lineageId, token });
		if (current) {
			this.remove(current);
			this.forget(current);
		}
	}

	private validateSelectedLenses(lenses: readonly string[]): ReviewLens[] {
		const selectedLenses = lenses.filter((lens): lens is ReviewLens => (REVIEW_LENS as readonly string[]).includes(lens));
		if (selectedLenses.length !== lenses.length || selectedLenses.length === 0) throw new CandidateViewError("candidate view has no valid selected review lenses");
		return selectedLenses;
	}

	private matchesAuthoritativeState(record: CandidateViewRecord, state: AuthoritativeReviewingCandidateState): boolean {
		try {
			return realpathSync(state.contributorRoot) === record.contributorRoot &&
				state.baseCommit === record.baseCommit &&
				state.baseTree === record.baseTree &&
				state.candidateTree === record.candidateTree &&
				(state.committedOnly ?? false) === record.committedOnly &&
				(state.intendedUntracked === undefined || JSON.stringify(state.intendedUntracked) === JSON.stringify(record.intendedUntracked)) &&
				JSON.stringify(state.paths) === JSON.stringify(record.scope.paths) &&
				JSON.stringify(state.modes) === JSON.stringify(record.scope.modes) &&
				gitlinkMapsEqual(state.gitlinks ?? {}, record.scope.gitlinks) &&
				JSON.stringify(state.deletedPaths) === JSON.stringify(record.scope.deletedPaths);
		} catch {
			return false;
		}
	}

	private bindRecord(token: string, lineageId: string, selectedLenses: readonly ReviewLens[]): CandidateViewRecord {
		const record = this.records.get(token);
		const key = record === undefined ? undefined : this.lineageKey(record.contributorRoot, lineageId);
		if (!record || record.lineageId !== undefined || !key || this.lineages.has(key)) throw new CandidateViewError("candidate view lineage binding is missing or ambiguous");
		assertRecordSafe(record, this.platform);
		record.lineageId = lineageId;
		record.selectedLenses = selectedLenses;
		this.lineages.set(key, record.token);
		this.projections.set(key, {
			contributorRoot: record.contributorRoot,
			baseCommit: record.baseCommit,
			baseTree: record.baseTree,
			candidateTree: record.candidateTree,
			committedOnly: record.committedOnly,
			intendedUntracked: record.intendedUntracked,
			paths: record.scope.paths,
			modes: record.scope.modes,
			gitlinks: record.scope.gitlinks,
			deletedPaths: record.scope.deletedPaths,
		});
		for (const [replayKey, pendingToken] of this.replays) if (pendingToken === token) this.replays.delete(replayKey);
		return record;
	}

	hasProjection(lineageId: string, contributorRoot?: string): boolean {
		return this.uniqueKey(this.projections, lineageId, contributorRoot) !== undefined;
	}

	restoreProjection(lineageId: string, contributorRoot: string, baseCommit: string, baseTree: string, candidateTree: string, paths: readonly string[]): void {
		const root = this.canonicalRoot(contributorRoot);
		const key = this.lineageKey(root, lineageId);
		const base = resolveCandidateBase(root, baseCommit, process.env, this.gitExecutor);
		if (!lineageId || this.projections.has(key) || base.commit !== baseCommit || base.tree !== baseTree || !isFullCommitId(candidateTree) || paths.some((path) => !isSafeCandidatePath(path)) || new Set(paths).size !== paths.length) throw new CandidateViewError("frozen correction projection is invalid or already restored");
		this.projections.set(key, { contributorRoot: root, baseCommit, baseTree, candidateTree, committedOnly: false, paths: [...paths], modes: {}, gitlinks: {}, deletedPaths: [] });
	}

	restoreProjectionFromNative(lineageId: string, contributorRoot: string, descriptor: NativeCandidateProjectionDescriptor): void {
		const root = this.canonicalRoot(contributorRoot);
		const key = this.lineageKey(root, lineageId);
		if (!lineageId || this.projections.has(key) || !isFullCommitId(descriptor.baseTree) || !isFullCommitId(descriptor.currentCandidateTree)) throw new CandidateViewError("native frozen projection is invalid or already restored");
		if (descriptor.paths.some((path) => !isSafeCandidatePath(path)) || new Set(descriptor.paths).size !== descriptor.paths.length) throw new CandidateViewError("native frozen projection paths are invalid");
		if (descriptor.intendedUntracked.some((path) => !descriptor.paths.includes(path)) || new Set(descriptor.intendedUntracked).size !== descriptor.intendedUntracked.length) throw new CandidateViewError("native intended-untracked projection is invalid");
		const head = resolveCandidateBase(root, "HEAD", process.env, this.gitExecutor);
		const base = head.tree === descriptor.baseTree ? head : resolveCandidateBaseTree(root, descriptor.baseTree, this.gitExecutor);
		const committedOnly = head.tree === descriptor.currentCandidateTree && base.tree !== head.tree;
		if (!committedOnly && head.tree !== descriptor.baseTree) throw new CandidateViewError("native projection base no longer matches HEAD");
		// Native `staged` covers both a committed HEAD range and the exact current
		// index over HEAD. Re-derive the latter from Git instead of trusting the
		// label; this also rejects dirty-inclusive snapshots mislabeled as staged.
		const stagedIndex = !committedOnly && descriptor.baseTree === head.tree &&
			git(root, ["write-tree"], process.env, this.gitExecutor) === descriptor.currentCandidateTree;
		if (
			(descriptor.projection === "staged" && !committedOnly && !stagedIndex) ||
			(descriptor.projection === "workspace" && committedOnly)
		) {
			throw new CandidateViewError("native projection commit-state does not match its declared projection kind", "projection-kind-drift");
		}
		const tree = parseTree(root, descriptor.currentCandidateTree, this.gitExecutor);
		const scope = deriveChangedScope(root, descriptor.baseTree, descriptor.currentCandidateTree, [...tree.entries, ...tree.gitlinks], this.gitExecutor);
		// A manifest SUBSUMES the sorted-path comparison rather than stacking on
		// top of it: it checks the same path set plus the mode, status, and
		// type state the path set cannot express, and it names which of those
		// drifted. Descriptors without a manifest keep the legacy check.
		if (descriptor.manifest !== undefined) {
			assertManifestMatchesGit(descriptor, deriveChangedPathManifest(root, descriptor.baseTree, descriptor.currentCandidateTree, this.gitExecutor));
		} else if (JSON.stringify(scope.paths) !== JSON.stringify([...descriptor.paths].sort())) {
			throw new CandidateViewError("native projection paths do not match Git content");
		}
		this.projections.set(key, {
			contributorRoot: root,
			baseCommit: base.commit,
			baseTree: descriptor.baseTree,
			candidateTree: descriptor.currentCandidateTree,
			committedOnly,
			intendedUntracked: Object.freeze([...descriptor.intendedUntracked]),
			paths: scope.paths,
			modes: scope.modes,
			gitlinks: scope.gitlinks,
			deletedPaths: scope.deletedPaths,
		});
	}

	/**
	 * Re-derives this lineage's FINALIZE binding from the provider's own
	 * projection, replacing a binding this session is still holding.
	 *
	 * Field defect (Engram #12547): once a bounded correction is admitted, the
	 * candidate identity legitimately moves, and the provider issues its
	 * finalize transition for that corrected target. A session that started the
	 * review still holds the START-time immutable reviewer view, so comparing
	 * it against the corrected projection reads as drift and no receipt is ever
	 * minted — while a fresh process, which restores from the native descriptor,
	 * finalizes the very same lineage successfully. This makes the in-session
	 * path behave like that already-correct fresh-process path.
	 *
	 * This is a re-derivation, not a relaxation: the replacement is
	 * materialized from Git and must match the provider descriptor exactly
	 * (base tree, projection kind, changed-path manifest), and the caller still
	 * asserts the binding afterwards. The immutable reviewer view is retired
	 * here on purpose — the lenses that consumed it finished before the
	 * correction.
	 */
	rebindForFinalizeFromNative(lineageId: string, contributorRoot: string, descriptor: NativeCandidateProjectionDescriptor): CandidateView {
		return this.restoreForFinalizeFromNative(lineageId, contributorRoot, descriptor);
	}

	/**
	 * Restores a lineage's FINALIZE binding (gentle-pi #185): the stale entry
	 * is only detached, not destroyed, so a failed restore can undo it.
	 */
	restoreForFinalizeFromNative(lineageId: string, contributorRoot: string, descriptor: NativeCandidateProjectionDescriptor): CandidateView {
		const root = this.canonicalRoot(contributorRoot);
		const key = this.lineageKey(root, lineageId);
		const staleToken = this.lineages.get(key), staleProjection = this.projections.get(key);
		this.lineages.delete(key); this.projections.delete(key);
		let projectionRestored = false;
		let record: CandidateViewRecord | undefined;
		try {
			this.restoreProjectionFromNative(lineageId, root, descriptor);
			projectionRestored = true;
			const projection = this.resolveProjection(lineageId, root);
			const matchesProjection = (candidate: CandidateViewRecord): boolean => candidate.baseTree === projection.baseTree && candidate.candidateTree === projection.candidateTree && JSON.stringify(candidate.scope.paths) === JSON.stringify(projection.paths);
			const emptyIntendedUntracked = projection.intendedUntracked?.length === 0;
			record = materializeCandidateView({ contributorRoot: root, baseRef: projection.baseCommit, committedOnly: projection.committedOnly, ...(!emptyIntendedUntracked && projection.intendedUntracked !== undefined ? { intendedUntracked: projection.intendedUntracked } : {}) }, this.gitExecutor, this.platform);
			if (!matchesProjection(record) && emptyIntendedUntracked) {
				this.remove(record);
				record = undefined;
				record = materializeCandidateView({ contributorRoot: root, baseRef: projection.baseCommit, committedOnly: projection.committedOnly, intendedUntracked: [] }, this.gitExecutor, this.platform);
			}
			if (!matchesProjection(record)) throw new CandidateViewError("live candidate does not match the native frozen projection");
			this.records.set(record.token, record);
			this.bindRecord(record.token, lineageId, []);
			const stale = staleToken === undefined ? undefined : this.records.get(staleToken);
			if (stale !== undefined) { this.remove(stale); this.forget(stale); }
			return this.expose(record);
		} catch (error) {
			if (projectionRestored) this.projections.delete(key);
			if (record !== undefined) {
				this.forget(record);
				this.remove(record);
			}
			if (staleToken !== undefined) this.lineages.set(key, staleToken);
			if (staleProjection !== undefined) this.projections.set(key, staleProjection);
			throw error;
		}
	}

	/**
	 * Mirrors the START-time dispatch registration for a lineage this
	 * controller never started (live defect 2026-08-16: a successor created
	 * by native `review recover` exists only in native authority). The
	 * authoritative STATUS descriptor supplies the frozen projection; the
	 * live candidate is re-materialized and must match it exactly before the
	 * dispatch-facing current binding is established with the provider-named
	 * pending lenses.
	 */
	restoreCurrentForDispatchFromNative(lineageId: string, contributorRoot: string, descriptor: NativeCandidateProjectionDescriptor, selectedLenses: readonly string[]): void {
		const root = this.canonicalRoot(contributorRoot);
		const key = this.lineageKey(root, lineageId);
		if (this.current.has(root)) throw new CandidateViewError("candidate view already has a current lineage binding", "current-binding-already-established");
		let projectionRestored = false;
		let record: CandidateViewRecord | undefined;
		try {
			const lenses = this.validateSelectedLenses(selectedLenses);
			this.restoreProjectionFromNative(lineageId, root, descriptor);
			projectionRestored = true;
			const projection = this.resolveProjection(lineageId, root);
			record = materializeCandidateView({ contributorRoot: root, baseRef: projection.baseCommit, committedOnly: projection.committedOnly, ...(projection.intendedUntracked === undefined ? {} : { intendedUntracked: projection.intendedUntracked }) }, this.gitExecutor, this.platform);
			if (record.baseTree !== projection.baseTree || record.candidateTree !== projection.candidateTree || JSON.stringify(record.scope.paths) !== JSON.stringify(projection.paths)) {
				throw new CandidateViewError("live candidate does not match the native frozen projection");
			}
			this.records.set(record.token, record);
			this.bindRecord(record.token, lineageId, lenses);
			this.current.set(root, { lineageId, token: record.token });
			this.lastHydrationFailures.delete(root);
		} catch (error) {
			if (projectionRestored) this.projections.delete(key);
			if (record !== undefined) {
				this.forget(record);
				this.remove(record);
			}
			this.lastHydrationFailures.set(root, {
				lineageId,
				reason: error instanceof CandidateViewError ? error.reason : "candidate-view-invalid",
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	resolveProjection(lineageId: string, contributorRoot: string): FrozenCandidateProjection {
		const key = this.lineageKey(contributorRoot, lineageId);
		const projection = this.projections.get(key);
		if (!projection) throw new CandidateViewError("candidate projection is missing, ambiguous, or belongs to a different contributor root");
		this.assertLineageRootIdentity(lineageId, contributorRoot);
		return projection;
	}

	resolveForLens(lineageId: string, lens: string, contributorRoot?: string): CandidateView {
		const key = this.requireKey(this.lineages, lineageId, contributorRoot, "candidate view context is missing, ambiguous, stale, or lens-unselected");
		const token = this.lineages.get(key);
		const record = token === undefined ? undefined : this.records.get(token);
		if (!record || record.lineageId !== lineageId || !record.selectedLenses?.includes(lens as ReviewLens)) throw new CandidateViewError("candidate view context is missing, ambiguous, stale, or lens-unselected");
		assertRecordSafe(record, this.platform);
		return this.expose(record);
	}

	private currentBinding(contributorRoot?: string): { root: string; lineageId: string; token: string } {
		if (contributorRoot !== undefined) {
			const root = this.canonicalRoot(contributorRoot);
			const binding = this.current.get(root);
			if (binding !== undefined) return { root, ...binding };
			const failure = this.lastHydrationFailures.get(root);
			if (failure !== undefined) {
				throw new CandidateViewError(
					`review subagent dispatch has no current controller-owned candidate view lineage binding: hydration for lineage ${failure.lineageId} was attempted from authoritative native status and failed (${failure.reason}): ${failure.message}`,
					"current-binding-hydration-failed",
				);
			}
			throw new CandidateViewError("review subagent dispatch has no current controller-owned candidate view lineage binding", "current-binding-missing");
		}
		if (this.current.size !== 1) {
			if (this.current.size > 1) throw new CandidateViewError("review subagent dispatch has multiple current lineage bindings across target roots; pass an explicit workspaceRoot", "current-binding-root-ambiguous");
			const failure = [...this.lastHydrationFailures.values()][0];
			if (failure !== undefined) {
				throw new CandidateViewError(
					`review subagent dispatch has no current controller-owned candidate view lineage binding: hydration for lineage ${failure.lineageId} was attempted from authoritative native status and failed (${failure.reason}): ${failure.message}`,
					"current-binding-hydration-failed",
				);
			}
			throw new CandidateViewError("review subagent dispatch has no current controller-owned candidate view lineage binding", "current-binding-missing");
		}
		const [root, binding] = this.current.entries().next().value as [string, { lineageId: string; token: string }];
		return { root, ...binding };
	}

	currentLineageId(contributorRoot?: string): string {
		return this.currentBinding(contributorRoot).lineageId;
	}

	/** The last failed dispatch-binding hydration, for controller envelopes. */
	lastDispatchHydrationFailure(contributorRoot?: string): Readonly<{ lineageId: string; reason: string; message: string }> | undefined {
		if (contributorRoot !== undefined) return this.lastHydrationFailures.get(this.canonicalRoot(contributorRoot));
		return this.lastHydrationFailures.size === 1 ? [...this.lastHydrationFailures.values()][0] : undefined;
	}

	resolveCurrentForLens(lens: string, contributorRoot?: string): CandidateView {
		return this.resolveCurrentForLenses([lens], contributorRoot)[0]!;
	}

	resolveCurrentForLenses(lenses: readonly string[], contributorRoot?: string): CandidateView[] {
		const current = this.currentBinding(contributorRoot);
		const record = this.records.get(current.token);
		if (!record || record.lineageId !== current.lineageId || this.lineages.get(this.lineageKey(current.root, current.lineageId)) !== current.token) throw new CandidateViewError("review subagent dispatch current lineage binding is stale or ambiguous", "current-binding-stale");
		assertRecordSafe(record, this.platform);
		this.assertCurrentBindingMatchesLiveCandidate(record);
		if (!lenses.every((lens) => record.selectedLenses?.includes(lens as ReviewLens))) throw new CandidateViewError("candidate view context is missing, ambiguous, stale, or lens-unselected", "current-binding-lens-unselected");
		return lenses.map(() => this.expose(record));
	}

	private assertCurrentBindingMatchesLiveCandidate(record: CandidateViewRecord): void {
		const live = materializeCandidateView({ contributorRoot: record.contributorRoot, baseRef: record.baseCommit, committedOnly: record.committedOnly, ...(record.intendedUntracked === undefined ? {} : { intendedUntracked: record.intendedUntracked }) }, this.gitExecutor, this.platform);
		try {
			if (
				live.baseCommit !== record.baseCommit ||
				live.baseTree !== record.baseTree ||
				live.candidateTree !== record.candidateTree ||
				live.committedOnly !== record.committedOnly ||
				JSON.stringify(live.scope.paths) !== JSON.stringify(record.scope.paths) ||
				JSON.stringify(live.scope.modes) !== JSON.stringify(record.scope.modes) ||
				!gitlinkMapsEqual(live.scope.gitlinks, record.scope.gitlinks) ||
				JSON.stringify(live.scope.deletedPaths) !== JSON.stringify(record.scope.deletedPaths)
			) throw new CandidateViewError("live candidate no longer matches the current controller-owned lineage binding", "current-binding-live-candidate-drift");
		} finally {
			this.remove(live);
		}
	}

	resolveForFinalize(lineageId: string, contributorRoot?: string): CandidateView {
		const key = this.requireKey(this.lineages, lineageId, contributorRoot, "candidate view context is missing or ambiguous for FINALIZE");
		const token = this.lineages.get(key);
		const record = token === undefined ? undefined : this.records.get(token);
		if (!record || record.lineageId !== lineageId) throw new CandidateViewError("candidate view context is missing or ambiguous for FINALIZE");
		assertRecordSafe(record, this.platform);
		return this.expose(record);
	}

	cleanup(token: string): void {
		const record = this.records.get(token);
		if (!record) return;
		this.remove(record);
		this.forget(record);
	}

	cleanupTerminal(lineageId: string, state: string, contributorRoot?: string): void {
		if (state !== "approved" && state !== "escalated") return;
		const key = this.uniqueKey(this.lineages, lineageId, contributorRoot);
		const token = key === undefined ? undefined : this.lineages.get(key);
		if (token) this.cleanup(token);
		if (state === "escalated" && key !== undefined) this.projections.delete(key);
	}

	private remove(record: CandidateViewRecord): void {
		if (!isWithin(record.parent, record.root)) throw new CandidateViewError("candidate view cleanup escaped its owned parent");
		removeCandidateOwner(record.owner, (args) => git(record.commonDir, args, process.env, record.gitExecutor), makeWritableForCleanup, false, this.platform);
	}

	private forget(record: CandidateViewRecord): void {
		this.records.delete(record.token);
		if (record.lineageId) {
			const key = this.lineageKey(record.contributorRoot, record.lineageId);
			if (this.lineages.get(key) === record.token) this.lineages.delete(key);
		}
		if (this.current.get(record.contributorRoot)?.token === record.token) this.current.delete(record.contributorRoot);
		for (const [replayKey, pendingToken] of this.replays) if (pendingToken === record.token) this.replays.delete(replayKey);
	}

	consumeProjection(lineageId: string, contributorRoot?: string): void {
		const key = this.uniqueKey(this.projections, lineageId, contributorRoot);
		if (key !== undefined) this.projections.delete(key);
	}

	private expose(record: CandidateViewRecord): CandidateView {
		return {
			token: record.token,
			root: record.root,
			contributorRoot: record.contributorRoot,
			baseCommit: record.baseCommit,
			baseTree: record.baseTree,
			candidateTree: record.candidateTree,
			committedOnly: record.committedOnly,
			intendedUntracked: record.intendedUntracked,
			paths: record.scope.paths,
			modes: record.scope.modes,
			gitlinks: record.scope.gitlinks,
			deletedPaths: record.scope.deletedPaths,
			verify: () => assertRecordSafe(record, this.platform),
			cleanup: () => this.cleanup(record.token),
		};
	}
}

interface MutableSubagentRunInput {
	agent?: unknown;
	agents?: unknown;
	task?: unknown;
	context?: unknown;
	mode?: unknown;
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewLens(value: string): value is ReviewLens {
	return (REVIEW_LENS as readonly string[]).includes(value);
}

function hasCandidateContextConflict(text: string, views: readonly CandidateView[]): boolean {
	return text.includes(CONTROLLER_CANDIDATE_VIEW_HEADING)
		|| views.some((view) => text.includes(view.root) || text.includes(view.candidateTree));
}

function compareCanonicalStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalStringMap(value: Readonly<Record<string, string>>): Record<string, string> {
	// Plain objects enumerate integer-like keys numerically; canonical round trips intentionally preserve that ordering.
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCanonicalStrings(left, right)));
}

function candidateScopeByMode(view: CandidateView): Record<string, string[]> {
	const grouped = new Map<string, string[]>();
	const deletedPaths = new Set(view.deletedPaths);
	for (const path of view.paths) {
		const group = deletedPaths.has(path) ? "deleted" : view.modes[path];
		if (group === undefined) throw new CandidateViewError("candidate view scope omits a changed path mode");
		const paths = grouped.get(group) ?? [];
		paths.push(path);
		grouped.set(group, paths);
	}
	return Object.fromEntries(
		[...grouped.entries()]
			.sort(([left], [right]) => compareCanonicalStrings(left, right))
			.map(([mode, paths]) => [mode, paths.sort(compareCanonicalStrings)]),
	);
}

function isCandidateContextMode(value: string): boolean {
	return (Object.values(CANDIDATE_CONTEXT_MODE) as readonly string[]).includes(value);
}

function isCanonicalStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every((item) => typeof item === "string" && isSafeCandidatePath(item))
		&& value.every((item, index, items) => index === 0 || compareCanonicalStrings(items[index - 1]!, item) < 0);
}

function hasCanonicalRecordOrder(value: Readonly<Record<string, unknown>>): boolean {
	const normalized = Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCanonicalStrings(left, right)));
	return JSON.stringify(value) === JSON.stringify(normalized);
}

function invalidCandidateContextManifest(message: string): never {
	throw new CandidateViewError(message, "candidate-context-manifest-invalid");
}

function validateCandidateContextManifest(value: unknown, bytes: Buffer): CandidateContextManifest {
	if (!isRecord(value)) return invalidCandidateContextManifest("candidate context manifest has an invalid structure");
	const keys = Object.keys(value);
	const expectedKeys = ["version", "scopeByMode", "gitlinks"];
	if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
		return invalidCandidateContextManifest("candidate context manifest has an invalid structure");
	}
	if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return invalidCandidateContextManifest("candidate context manifest is not canonical");
	if (value.version !== CANDIDATE_CONTEXT_MANIFEST.VERSION || !isRecord(value.scopeByMode) || !isRecord(value.gitlinks)) {
		return invalidCandidateContextManifest("candidate context manifest has an invalid structure");
	}
	const scopeByMode = value.scopeByMode;
	if (!hasCanonicalRecordOrder(scopeByMode)) return invalidCandidateContextManifest("candidate context manifest is not canonical");
	const scopePaths = new Set<string>();
	for (const [mode, paths] of Object.entries(scopeByMode)) {
		if (!isCandidateContextMode(mode) || !isCanonicalStringArray(paths)) return invalidCandidateContextManifest("candidate context manifest has an invalid scope");
		for (const path of paths) {
			if (scopePaths.has(path)) return invalidCandidateContextManifest("candidate context manifest has duplicate scope paths");
			scopePaths.add(path);
		}
	}
	const gitlinks = value.gitlinks;
	if (!hasCanonicalRecordOrder(gitlinks)) return invalidCandidateContextManifest("candidate context manifest is not canonical");
	for (const [path, objectId] of Object.entries(gitlinks)) {
		if (!isSafeCandidatePath(path) || typeof objectId !== "string" || !isCanonicalObjectId(objectId)) {
			return invalidCandidateContextManifest("candidate context manifest has an invalid gitlink map");
		}
	}
	const gitlinkPaths = scopeByMode["160000"];
	const canonicalGitlinkPaths = Object.keys(gitlinks).sort(compareCanonicalStrings);
	if (
		(gitlinkPaths === undefined && canonicalGitlinkPaths.length !== 0)
		|| (gitlinkPaths !== undefined && JSON.stringify(canonicalGitlinkPaths) !== JSON.stringify(gitlinkPaths))
	) return invalidCandidateContextManifest("candidate context manifest gitlinks do not match its scope");
	const manifest: CandidateContextManifest = {
		version: CANDIDATE_CONTEXT_MANIFEST.VERSION,
		scopeByMode: scopeByMode as Readonly<Record<string, readonly string[]>>,
		gitlinks: gitlinks as Readonly<Record<string, string>>,
	};
	if (!Buffer.from(JSON.stringify(manifest), "utf8").equals(bytes)) {
		return invalidCandidateContextManifest("candidate context manifest is not canonical");
	}
	return manifest;
}

export function decodeCandidateContextManifest(encoded: string, sha256: string): DecodedCandidateContextManifest {
	if (encoded.length > MAX_CANDIDATE_CONTEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[0-9a-f]{64}$/.test(sha256)) {
		throw new CandidateViewError("candidate context manifest encoding is invalid", "candidate-context-manifest-invalid");
	}
	let bytes: Buffer;
	try {
		bytes = gunzipSync(Buffer.from(encoded, "base64url"), { maxOutputLength: MAX_CANDIDATE_CONTEXT_MANIFEST_BYTES });
	} catch {
		throw new CandidateViewError("candidate context manifest cannot be decompressed", "candidate-context-manifest-invalid");
	}
	const actualSha256 = createHash("sha256").update(bytes).digest("hex");
	if (actualSha256 !== sha256) throw new CandidateViewError("candidate context manifest integrity check failed", "candidate-context-manifest-integrity");
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) return invalidCandidateContextManifest("candidate context manifest is not valid UTF-8");
	if (gzipSync(bytes, { mtime: 0 }).toString("base64url") !== encoded) {
		return invalidCandidateContextManifest("candidate context manifest transport is not canonical");
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		if (error instanceof CandidateViewError) throw error;
		return invalidCandidateContextManifest("candidate context manifest is not valid JSON");
	}
	return { manifest: validateCandidateContextManifest(value, bytes), bytes, sha256: actualSha256 };
}

export function readCandidateContextManifestPage(encoded: string, sha256: string, cursor = 0): CandidateContextPage {
	if (!Number.isSafeInteger(cursor) || cursor < 0) throw new CandidateViewError("candidate context manifest cursor is invalid", "candidate-context-cursor-invalid");
	const decoded = decodeCandidateContextManifest(encoded, sha256);
	const entries = Object.entries(decoded.manifest.scopeByMode).flatMap(([mode, paths]) => paths.map((path): CandidateContextPageEntry => ({
		path,
		mode: mode as CandidateContextMode,
		...(mode === CANDIDATE_CONTEXT_MODE.GITLINK ? { gitlinkObjectId: decoded.manifest.gitlinks[path]! } : {}),
	})));
	if (cursor > entries.length) throw new CandidateViewError("candidate context manifest cursor exceeds the changed scope", "candidate-context-cursor-invalid");
	const pageEntries: CandidateContextPageEntry[] = [];
	for (let index = cursor; index < entries.length && pageEntries.length < MAX_CANDIDATE_SCOPE_PAGE_ENTRIES; index += 1) {
		const candidateEntries = [...pageEntries, entries[index]!];
		const candidatePage: CandidateContextPage = {
			version: CANDIDATE_CONTEXT_MANIFEST.VERSION,
			sha256: decoded.sha256,
			cursor,
			totalPaths: entries.length,
			entries: candidateEntries,
			...(cursor + candidateEntries.length < entries.length ? { nextCursor: cursor + candidateEntries.length } : {}),
		};
		if (Buffer.byteLength(JSON.stringify(candidatePage), "utf8") > MAX_CANDIDATE_SCOPE_PAGE_BYTES) {
			if (pageEntries.length === 0) throw new CandidateViewError("candidate context manifest path exceeds the bounded actor response", "candidate-context-page-too-large");
			break;
		}
		pageEntries.push(entries[index]!);
	}
	return {
		version: CANDIDATE_CONTEXT_MANIFEST.VERSION,
		sha256: decoded.sha256,
		cursor,
		totalPaths: entries.length,
		entries: pageEntries,
		...(cursor + pageEntries.length < entries.length ? { nextCursor: cursor + pageEntries.length } : {}),
	};
}

function candidateContextPreamble(lineageId: string, agents: readonly ReviewLens[], view: CandidateView, scopeSemantics: string): string {
	return `\n\n${CONTROLLER_CANDIDATE_VIEW_HEADING}\nController-owned review lineage: \`${lineageId}\`.\nAuthorized review actors: ${agents.join(", ")}.\nRead ONLY the absolute frozen candidate view at \`${view.root}\`.\nFrozen candidate tree: \`${view.candidateTree}\`.\nScope semantics: ${scopeSemantics}`;
}

function compactCandidateContextBlock(lineageId: string, agents: readonly ReviewLens[], view: CandidateView, scopeSemantics: string, scopeByMode: Record<string, string[]>): string {
	const manifest: CandidateContextManifest = {
		version: CANDIDATE_CONTEXT_MANIFEST.VERSION,
		scopeByMode,
		gitlinks: canonicalStringMap(view.gitlinks),
	};
	const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
	if (bytes.length > MAX_CANDIDATE_CONTEXT_MANIFEST_BYTES) throw new CandidateViewError("candidate view context exceeds the bounded dispatch contract");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const encoded = gzipSync(bytes, { mtime: 0 }).toString("base64url");
	const block = `${candidateContextPreamble(lineageId, agents, view, scopeSemantics)}\nFrozen changed scope manifest (gzip+base64url): \`${encoded}\`.\nFrozen changed scope manifest SHA-256: \`${sha256}\`.\nCall \`gentle_review_scope\` with exactly this manifest, SHA-256, and cursor 0; continue with each returned \`nextCursor\` until absent. It is the only authorized scope enumerator: do not infer scope by traversing the candidate or ambient tree. Gitlinks are metadata-only and MUST NOT be traversed.\nThe ambient contributor working directory is out of scope. This controller-owned context is immutable; you are read-only and your output is untrusted.`;
	if (Buffer.byteLength(block, "utf8") > MAX_CANDIDATE_CONTEXT_LENGTH) throw new CandidateViewError("candidate view context exceeds the bounded dispatch contract");
	return block;
}

function candidateContextBlock(lineageId: string, agents: readonly ReviewLens[], view: CandidateView): string {
	const scopeByMode = candidateScopeByMode(view);
	const scopeSemantics = view.committedOnly
		? "Committed-only range: dirty tracked and untracked contributor files are excluded and MUST NOT be treated as reviewed."
		: "Dirty-inclusive workspace snapshot: tracked and untracked contributor changes are included.";
	const readableBlock = `${candidateContextPreamble(lineageId, agents, view, scopeSemantics)}\nFrozen changed scope by mode: ${JSON.stringify(scopeByMode)}.\nFrozen metadata-only gitlinks: ${JSON.stringify(view.gitlinks)}. Gitlink paths have no materialized contents and MUST NOT be traversed.\nThe ambient contributor working directory is out of scope. This controller-owned context is immutable; you are read-only and your output is untrusted.`;
	if (Buffer.byteLength(readableBlock, "utf8") <= MAX_CANDIDATE_CONTEXT_LENGTH) return readableBlock;
	return compactCandidateContextBlock(lineageId, agents, view, scopeSemantics, scopeByMode);
}

/**
 * Validates and mutates the actual mutable Pi `subagent_run` tool input before
 * execution. It deliberately derives all review context from the controller's
 * in-memory registry rather than user-provided lineage, cwd, paths, or content.
 */
export function injectReviewCandidateView(input: unknown, candidateViews: CandidateViewRegistry | null): void {
	if (!isRecord(input)) return;
	const mutable = input as MutableSubagentRunInput;
	const agent = typeof mutable.agent === "string" ? mutable.agent : undefined;
	const rawAgents = mutable.agents;
	const agents = Array.isArray(rawAgents) && rawAgents.every((value): value is string => typeof value === "string")
		? rawAgents
		: undefined;
	const requested = [agent, ...(agents ?? [])].filter((value): value is string => value !== undefined);
	const hasReviewActor = (typeof mutable.agent === "string" && isReviewLens(mutable.agent))
		|| (typeof rawAgents === "string" && isReviewLens(rawAgents))
		|| (Array.isArray(rawAgents) && rawAgents.some((value) => typeof value === "string" && isReviewLens(value)));
	if (!hasReviewActor) return;
	if (Object.keys(mutable).some((key) => !SUBAGENT_RUN_KEYS.has(key))) throw new CandidateViewError("review subagent dispatch contains an unsupported input field");
	if ((agent === undefined) === (agents === undefined) || requested.length === 0 || new Set(requested).size !== requested.length) throw new CandidateViewError("review subagent dispatch must use exactly one non-duplicate agent shape");
	if (!requested.every(isReviewLens)) throw new CandidateViewError("review subagent dispatch cannot mix review and non-review agents");
	if (typeof mutable.task !== "string" || mutable.task.length === 0 || mutable.task.length > MAX_SUBAGENT_TASK_LENGTH) throw new CandidateViewError("review subagent dispatch task is malformed or exceeds the bounded contract");
	if (mutable.context !== undefined && (typeof mutable.context !== "string" || mutable.context.length > MAX_SUBAGENT_CONTEXT_LENGTH)) throw new CandidateViewError("review subagent dispatch context is malformed or exceeds the bounded contract");
	if (mutable.mode !== "task") throw new CandidateViewError("review subagent dispatch requires mode task");
	if (candidateViews === null) throw new CandidateViewError("review subagent dispatch has no controller-owned candidate view registry");
	const reviewAgents = requested as ReviewLens[];
	const lineageId = candidateViews.currentLineageId();
	const views = candidateViews.resolveCurrentForLenses(reviewAgents);
	const view = views[0];
	if (!view || views.some((candidate) => candidate.root !== view.root || candidate.candidateTree !== view.candidateTree || JSON.stringify(candidate.paths) !== JSON.stringify(view.paths) || JSON.stringify(candidate.modes) !== JSON.stringify(view.modes) || !gitlinkMapsEqual(candidate.gitlinks, view.gitlinks) || JSON.stringify(candidate.deletedPaths) !== JSON.stringify(view.deletedPaths))) {
		throw new CandidateViewError("review subagent dispatch does not resolve one exact frozen candidate view");
	}
	const userText = `${mutable.task}\n${typeof mutable.context === "string" ? mutable.context : ""}`;
	if (hasCandidateContextConflict(userText, views)) throw new CandidateViewError("review subagent dispatch contains conflicting candidate-view text");
	mutable.task = `${mutable.task}${candidateContextBlock(lineageId, reviewAgents, view)}`;
}

const defaultRegistry = new CandidateViewRegistry();

export function createCandidateView(request: CreateCandidateViewRequest): CandidateView {
	return defaultRegistry.create(request);
}
