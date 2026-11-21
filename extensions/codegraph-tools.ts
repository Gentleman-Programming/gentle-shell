import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodegraphShimState, type CodegraphShimResolution } from "../lib/codegraph-cli-resolve.ts";
import { exploreViaDaemon, MAX_REPLY_CHARS, type DaemonCallResult } from "../lib/codegraph-daemon.ts";
import { acquireInitLock, type InitLockOutcome } from "../lib/codegraph-lease.ts";
import { seedWorktreeIndex } from "../lib/codegraph-seed.ts";
import { CHILD_ENV, firstLineOf, indexState, maybeRewarm, prepareReadiness, runCodegraph, runCodegraphSeedSync, syncBeforeSearch, warmUpDaemon, warmUpDaemonDetailed, WARMUP_TIMEOUT_MS, type SearchSyncInput, type IndexState, type IndexAction, type SessionStartReason, type WarmUpOutcome } from "../lib/codegraph-readiness.ts";
import { ensureDirectExposureInAgentHomes, type EnsureExposureIo } from "../lib/codegraph-mcp-exposure.ts";

const CODEGRAPH_OPERATION = {
	INIT: "init",
	QUERY: "query",
	EXPLORE: "explore",
} as const;

const CODEGRAPH_STATUS = {
	UNAVAILABLE: "unavailable",
	FAILED: "failed",
} as const;

type CodeGraphOperation =
	(typeof CODEGRAPH_OPERATION)[keyof typeof CODEGRAPH_OPERATION];
type CodeGraphStatus =
	(typeof CODEGRAPH_STATUS)[keyof typeof CODEGRAPH_STATUS];

export interface CodeGraphToolParameters {
	operation: CodeGraphOperation;
	query?: string;
	limit?: number;
}

export interface CodeGraphCommandResult {
	stdout: string;
	stderr: string;
}

export interface CodeGraphRunOptions {
	cwd: string;
	signal?: AbortSignal;
	maxBuffer: number;
	/** Receives the spawned child's pid the moment it exists, so a lock holding the run can
	 * adopt the writer: a launcher that dies mid-run leaves a token whose recorded child keeps
	 * the verdict held-live while the writer still writes. */
	onSpawn?: (pid: number, proxy: boolean) => void;
}

interface CodeGraphLocalExclude {
	status: "added" | "present" | "failed";
	path?: string;
	reason?: string;
}

interface CodeGraphFallbackDetails {
	status: CodeGraphStatus;
	operation: CodeGraphOperation;
	cwd: string;
	fallback: string;
	localExclude?: CodeGraphLocalExclude;
	syncTriggered?: boolean;
}

/** The success-details shape of every codegraph tool result; failures use CodeGraphFallbackDetails. */
interface CodeGraphToolSuccessDetails {
	operation: CodeGraphOperation;
	cwd: string;
	args: string[];
	localExclude?: CodeGraphLocalExclude;
	viaDaemon?: boolean;
	syncTriggered?: boolean;
}

/** One shaped tool result: content plus success or fallback details. */
type CodeGraphToolResult = {
	content: { type: "text"; text: string }[];
	details: CodeGraphToolSuccessDetails | CodeGraphFallbackDetails;
};

export type CodeGraphRunner = (
	args: readonly string[],
	options: CodeGraphRunOptions,
) => Promise<CodeGraphCommandResult>;

const CODEGRAPH_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["operation"],
	properties: {
		operation: { type: "string", enum: Object.values(CODEGRAPH_OPERATION) },
		query: { type: "string", minLength: 1, maxLength: 2_000 },
		limit: { type: "integer", minimum: 1, maximum: 20 },
	},
} as const;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_OUTPUT_CHARS = 100_000;
// The CLI buffer matches the daemon reply cap in bytes: maxBuffer counts UTF-8 bytes while
// MAX_REPLY_CHARS counts UTF-16 code units, and the widest UTF-8 encoding of a code unit is
// 3 bytes (a surrogate pair's 4-byte sequence spans two units), so 3x the character cap
// accepts every output the daemon path accepts — Node kills a child that overruns maxBuffer
// before truncateOutput could bound it (400k CJK characters are ~1.2 MB against a 1 MB buffer).
const PROCESS_MAX_BUFFER = 3 * MAX_REPLY_CHARS;
const FALLBACK_INSTRUCTIONS = "Use read, grep, and find for this exploration.";
// A subagent child (CHILD_ENV) never starts an index operation of its own: index creation is
// parent-session-owned, so the child init guard refuses instead of reaching the CLI runner.
const CHILD_INIT_REFUSAL = "CodeGraph init is refused in a subagent child: index creation is parent-session-owned. Query and explore the shared index instead; the parent session owns init.";
// each daemon query attempt is bounded, so a hung daemon on a slow filesystem (for example a
// WSL /mnt mount) cannot block the turn indefinitely (#1901); init is the legitimately slow
// first index, so only the user's signal bounds it.
const CODEGRAPH_QUERY_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);
const GIT_ROOT_REQUIRED = "CodeGraph requires a real Git project root equal to the current workspace.";
const GIT_DIAGNOSTIC_MAX_CHARS = 1_000;

/** Races a daemon attempt (or a warm) against the caller's abort: a cancelled call stops paying for
 * further attempts instead of running out the budget. The losing promise is left to settle on its
 * own — only the wait is abandoned; its socket result, if any, is discarded. */
function raceWithAbort<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T | undefined> {
	if (!signal) return promise;
	// An already-aborted signal never fires its abort event again: a listener registered now would
	// never run, and the wait would hold until the attempt exhausted its own budget.
	if (signal.aborted) {
		promise.catch(() => { /* the losing attempt settles on its own; its rejection is expected */ });
		return Promise.resolve(undefined);
	}
	let onAbort: () => void = () => {};
	const aborted = new Promise<undefined>((resolve) => {
		onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort)) as Promise<T | undefined>;
}

/**
 * Compare two directories by file identity, not path spelling. On Windows a mapped
 * drive (`X:\repo`) and the UNC path Git reports for it (`\\server\share\repo`) name
 * the same directory but never compare equal as strings (#2558).
 *
 * Exported as a test seam: production callers are in this file only.
 */
export function isSameDirectory(left: string, right: string): boolean {
	if (left === right) return true;
	try {
		const a = statSync(left, { bigint: true });
		const b = statSync(right, { bigint: true });
		// A zero inode means the filesystem reports no identity; never treat that as a match.
		return a.isDirectory() && b.isDirectory() && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
	} catch {
		return false;
	}
}

/**
 * Keep the stable prefix and append what was compared, so a path mismatch and a Git
 * refusal (for example safe.directory on a network share) are told apart (#2558).
 */
function gitRootRequiredError(workspace: string, label: "git toplevel" | "git", detail: string): Error {
	return new Error(`${GIT_ROOT_REQUIRED}\n  workspace: ${workspace}\n  ${label}: ${detail.split(/\r?\n/).filter((line) => line.trim()).join("\n    ")}`);
}

/** Prefer Git's own stderr over Node's "Command failed" wrapper, bounded for the tool output. */
function gitFailureDetail(error: unknown): string {
	const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
	const text = (typeof stderr === "string" && stderr.trim()) || (error instanceof Error ? error.message : String(error)).trim();
	return text.length > GIT_DIAGNOSTIC_MAX_CHARS ? `${text.slice(0, GIT_DIAGNOSTIC_MAX_CHARS)}...` : text;
}

/** One git interrogation: fixed arguments for one cwd, returning trimmed stdout. */
export type GitRun = (args: readonly string[], cwd: string) => string;

const defaultGitRun: GitRun = (args, cwd) => execFileSync("git", [...args], {
	cwd,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
}).trim();

/** HOME and TMP, resolved lazily on the first workspace check and cached for the process: the
 * guard's comparisons never change while it runs. Resolution lives here, never at module
 * evaluation, so a missing or inaccessible HOME/TMP (environment overrides are allowed)
 * cannot throw during module evaluation and keep the extension from registering its tool and
 * hooks. A directory that cannot be resolved keeps its unresolved spelling — fail-closed for
 * the guard, because an existing workspace can never equal a missing directory. */
let realHome: string | undefined;
let realTmp: string | undefined;

function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function homeForGuard(): string {
	return (realHome ??= realpathOrSelf(homedir()));
}

function tmpForGuard(): string {
	return (realTmp ??= realpathOrSelf(tmpdir()));
}

/** Workspaces whose guard already passed this prompt: git is asked once per cwd per prompt. */
const workspaceVerified = new Set<string>();

/** The metadata directory a worktree-style `.git` file names, resolved the way Git reads it:
 * an absolute gitdir is taken as it is written, a relative one resolves against the `.git`
 * file's own directory. Anything without a gitdir line is not a metadata pointer. */
function gitdirTarget(resolved: string): string | undefined {
	const raw = readFileSync(join(resolved, ".git"), "utf8");
	const match = /^gitdir:[ \t]*(.+)\r?$/m.exec(raw);
	if (!match) return undefined;
	const target = match[1].trim();
	return isAbsolute(target) ? target : resolve(resolved, target);
}

/** Whether a validated workspace still carries its repository marker: a Git toplevel always
 * holds `.git` — a directory, or the file a linked worktree or submodule writes — so a
 * cached validation survives only while that marker does. A `.git` FILE names its metadata
 * directory through `gitdir:`, and that target can move independently of the worktree (the
 * main checkout a linked worktree was created from can be renamed away while the worktree's
 * `.git` file survives), so the file counts as a marker only while the metadata it names
 * still exists. An env-driven GIT_DIR repository without the marker simply re-validates on
 * every call: one extra git run, never a wrong cache hit. */
function gitRootMarkerPresent(resolved: string): boolean {
	try {
		const markerPath = join(resolved, ".git");
		if (lstatSync(markerPath).isDirectory()) return true;
		// A symlinked `.git` resolving to a directory is metadata as well; only a regular file
		// carries the gitdir pointer the cache must follow — and anything else is rejected
		// before the read: a FIFO, socket, or device is not a marker Git wrote, and reading
		// one synchronously could block the whole session on a pipe with no writer.
		const marker = statSync(markerPath);
		if (marker.isDirectory()) return true;
		if (!marker.isFile()) return false;
		const target = gitdirTarget(resolved);
		return target !== undefined && statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function resolveWorkspaceCwd(cwd: string, gitRun: GitRun = defaultGitRun): string {
	const resolved = realpathSync(cwd);
	if (!lstatSync(resolved).isDirectory()) {
		throw new Error("CodeGraph can run only in the current workspace directory.");
	}
	if (resolved === homeForGuard() || resolved === tmpForGuard()) {
		throw new Error("CodeGraph requires a real Git project root equal to the current workspace, not HOME or a temporary directory.");
	}
	if (workspaceVerified.has(resolved)) {
		// The cache holds only while the repository identity does: a checkout that lost its
		// .git mid-prompt re-runs the full root check instead of dispatching into a non-repository.
		if (gitRootMarkerPresent(resolved)) return resolved;
		workspaceVerified.delete(resolved);
	}
	try {
		const root = realpathSync(gitRun(["rev-parse", "--show-toplevel"], resolved));
		if (!isSameDirectory(root, resolved)) {
			throw gitRootRequiredError(resolved, "git toplevel", root);
		}
		workspaceVerified.add(resolved);
		return resolved;
	} catch (error) {
		if (error instanceof Error && /real Git project root/.test(error.message)) throw error;
		throw gitRootRequiredError(resolved, "git", gitFailureDetail(error));
	}
}

/**
 * Whether a workspace validates as the project root readiness may initialize: validation has
 * already compared directories by identity, so a different spelling of a valid Git root — a
 * symlink to it — counts too. Exported as a test seam: the production caller is the
 * session-start readiness wiring only.
 */
export function isWorkspaceProjectRoot(workspace: string): boolean {
	try {
		// resolveWorkspaceCwd already proved the Git root and the workspace name the same
		// directory, so a validated root counts whatever spelling it was reached through.
		resolveWorkspaceCwd(workspace);
		return true;
	} catch {
		return false;
	}
}

function assertSafeIndexDirectory(cwd: string): void {
	try {
		const index = lstatSync(join(cwd, ".codegraph"));
		if (index.isSymbolicLink() || !index.isDirectory()) {
			throw new Error("CodeGraph .codegraph must be a real directory when it already exists.");
		}
	} catch (error: unknown) {
		if (isEnoent(error)) return;
		throw error;
	}
}

/**
 * An index is the database file, not merely the directory: a .codegraph/ left behind by a
 * partial init or a killed reindex is not a usable index. Any error, including EACCES,
 * counts as unconfirmed, so gates on this never fire on an unknown state. Delegates to
 * indexState: true exactly for "present"; absent and unknown both count as no index.
 */
/** The tri-state index read the tool's gates consult: the real indexState by default. A
 * test seam because no filesystem fixture yields "unknown" on every runner — a failing stat
 * needs a self-referential symlink (privileged on Windows) or permission bits (a no-op
 * there) — so the suite arms the state instead of building it. Production never arms it. */
let indexStateRead: (cwd: string) => IndexState = indexState;

/** Test seam for the init and search gates' index reads; the restore puts the real
 * tri-state back. Exercised only by the test suite; not part of the tool's runtime surface. */
export function armIndexStateForTest(read: ((cwd: string) => IndexState) | undefined): () => void {
	const previous = indexStateRead;
	indexStateRead = read ?? indexState;
	return () => {
		indexStateRead = previous;
	};
}

export function indexExists(cwd: string): boolean {
	return indexStateRead(cwd) === "present";
}

/**
 * The shell words of a command tail, quote removal applied: whitespace outside quotes ends a
 * word, quoted stretches stay inside one word, and a backslash outside single quotes makes the
 * next character literal (inside double quotes only before the characters it really escapes).
 * A quote or backslash left open at the end leaves only the LAST word unterminated — the
 * shell would keep reading it — so every word before it is complete.
 */
function shellWords(command: string): { words: string[]; unterminated: boolean } {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote === undefined) {
			escaped = true;
			continue;
		}
		if (char === "\\" && quote === '"' && (command[index + 1] === '"' || command[index + 1] === "\\" || command[index + 1] === "$" || command[index + 1] === "`")) {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === " " || char === "\t" || char === "\n") {
			if (word.length > 0) words.push(word);
			word = "";
			continue;
		}
		word += char;
	}
	if (word.length > 0) words.push(word);
	return { words, unterminated: quote !== undefined || escaped };
}

/** The directory a `codegraph index|init` command targets: its positional path argument —
 * the CLI resolves one against the caller's cwd (`init [path]`, `index [path]`) — or the
 * caller's own cwd when the command names none. Flags precede the positional, so only the
 * first non-flag word can be it. The word is read whole — quotes and escapes keep a path with
 * spaces one argument — and a positional left unterminated by an unclosed quote or backslash
 * is a form this parser cannot place: it falls back to the caller's cwd, keeping the command
 * judged here rather than silently allowed. A caller's cwd this walk could not determine leaves a relative positional equally unplaceable; only an absolute one still pins a target. */
function rebuildTargetDir(rest: string, cwd: string | undefined): string | undefined {
	const { words, unterminated } = shellWords(rest);
	for (let index = 2; index < words.length; index += 1) {
		const word = words[index];
		if (word.startsWith("-")) continue;
		if (unterminated && index === words.length - 1) return cwd;
		// An absolute positional names its target whatever directory the command runs in; a
		// relative one is placed by that directory, and no directory leaves it unplaceable.
		return isAbsolute(word) ? word : cwd === undefined ? undefined : resolve(cwd, word);
	}
	return cwd;
}

/** Whether one `codegraph index|init` command would rebuild an existing index, located the way
 * the CLI itself locates it: `init [path]` resolves its positional (or the caller's cwd)
 * exactly and never an ancestor — an unindexed directory is a legitimate first init — while
 * `index` rebuilds the exact target when it is initialized and otherwise the nearest
 * initialized ancestor, the resolution a bare `codegraph index` performs from the cwd. A rebuild whose working directory this walk could not determine counts as a rebuild: the original directory is never proof the target is unindexed. */
function rebuildsExistingIndex(verb: "index" | "init", rest: string, cwds: ReadonlyArray<CwdPath>): boolean {
	// A target this walk cannot place is never proof that nothing existing is rebuilt: the
	// unknown directory the command runs in may hold the index the rebuild would kill. Every
	// directory the command can run in is judged, so a branch that left two paths live is
	// blocked when either of them holds an index.
	return cwds.some((cwd) => {
		const target = rebuildTargetDir(rest, cwd);
		if (target === undefined) return true;
		if (indexExists(target)) return true;
		if (verb === "init") return false;
		for (let current = dirname(target);; current = dirname(current)) {
			if (indexExists(current)) return true;
			if (dirname(current) === current) return false;
		}
	});
}

/** A full re-index from bash is blocked when an index already exists; this is the reason it gets. */
const CODEGRAPH_INDEX_BLOCK_REASON = "CodeGraph: an index already exists for this workspace. Re-indexing kills the shared daemon and rebuilds it; the runtime refreshes with sync (before every search). If you really need a full rebuild, set GENTLE_CODEGRAPH_ALLOW_INDEX=1 in the launch environment or as a leading assignment in the command.";

/**
 * The command past its leading whitespace and `FOO=1 BAR=2` assignments — shell syntax, not the
 * command itself — plus whether those assignments leave `GENTLE_CODEGRAPH_ALLOW_INDEX` at the
 * literal `1`, the in-command form of the launch-environment override. Every assignment to that
 * variable updates the state in order, so the LAST one wins exactly as the shell applies them:
 * `=1 ... =0` leaves no override, `=0 ... =1` is one. A quoted value (`FOO="a b"`) is consumed
 * whole, spaces included, so the command after it is still located. Only the exact value `1` —
 * quoted or not — overrides: any other value is an ordinary assignment and the launch
 * environment stays authoritative.
 * An assignment to any other variable leaves the current state unchanged.
 */
function leadingAssignments(command: string): { rest: string; allowIndexOverride: boolean } {
	let rest = command.trimStart();
	let allowIndexOverride = false;
	// An assignment token ends at the whitespace that separates it from the next word; a quoted
	// value may contain that whitespace, so the token spans it as one quoted stretch.
	const assignment = /^([A-Za-z_][A-Za-z0-9_]*=(?:[^\s"']|"[^"]*"|'[^']*')*)\s+/;
	for (let match = assignment.exec(rest); match !== null; match = assignment.exec(rest)) {
		// Only assignments to the override's own variable change its state — an unrelated
		// FOO=bar between the override and the rebuild changes nothing — and among that
		// variable's assignments the shell applies the LAST one, so each updates in order.
		if (match[1].slice(0, match[1].indexOf("=")) === "GENTLE_CODEGRAPH_ALLOW_INDEX") {
			allowIndexOverride = unquoteAssignment(match[1]) === "GENTLE_CODEGRAPH_ALLOW_INDEX=1";
		}
		rest = rest.slice(match[0].length);
	}
	return { rest, allowIndexOverride };
}

/** The token with shell quote removal applied to its value: an enclosing pair of quotes is
 * stripped, while quotes inside a quoted value stay literal exactly as the shell assigns
 * them — so a double-quoted '1' keeps its inner quotes and only the exact value 1 overrides. */
function unquoteAssignment(token: string): string {
	const equals = token.indexOf("=");
	if (equals === -1) return token;
	let value = "";
	let quote: '"' | "'" | undefined;
	for (let index = equals + 1; index < token.length; index += 1) {
		const char = token[index];
		if (quote === undefined && (char === '"' || char === "'")) {
			quote = char;
			continue;
		}
		if (quote === char) {
			quote = undefined;
			continue;
		}
		value += char;
	}
	return token.slice(0, equals + 1) + value;
}

/** A # begins a comment only at the start of a word: after start-of-input or any shell
 * metacharacter that ends a word. Mid-word (`echo a#b`, or right after an escaped space —
 * `cat foo\ #note` keeps the # inside the word) it is a literal character, exactly as Bash
 * reads it. The passes below track the word start through their scan instead of testing the
 * previous raw character, which cannot tell an escaped space from one that ends a word. */
const COMMENT_WORD_BOUNDARY = /[\s;&|()<>]/;

/**
 * The command with its here-document bodies removed: a `<<WORD` operator makes the lines after
 * its own line the input of the command (`cat <<'EOF'` feeds the body to cat), not commands of
 * the list — a literal `codegraph init` line inside the body is data, never a rebuild. The body
 * runs from the introducing line's newline to the closing delimiter line — a line that is
 * exactly the word, leading tabs ignored after `<<-` — and scanning continues after it; an
 * unclosed body runs to the end. `<<<` here-strings carry no body lines and stay as they are,
 * and quotes and backslashes outside the operator are respected: `echo "<<"` opens no heredoc.
 * A comment — a # at the start of a word — runs to the end of its line as comment text: its
 * quotes and << operators open nothing, exactly as Bash ignores them.
 */
function stripHeredocBodies(command: string): string {
	let out = "";
	let index = 0;
	// Whether the next character starts a shell word — the state a comment's # needs,
	// tracked through the scan instead of re-derived from the previous raw character: an
	// escaped space (`cat foo\ #note`) does not end the word, so a # after it is a literal.
	let wordStart = true;
	while (index < command.length) {
		const char = command[index];
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			const end = close === -1 ? command.length : close + 1;
			out += command.slice(index, end);
			index = end;
			wordStart = false;
			continue;
		}
		if (char === "\\") {
			out += command.slice(index, Math.min(index + 2, command.length));
			index += 2;
			// The escaped character is word content; a backslash-newline continuation is
			// transparent instead — the word (or the empty input before it) keeps its state.
			if (command[index - 1] !== "\n") wordStart = false;
			continue;
		}
		if (char === "#" && wordStart) {
			// A word-initial # comments out the rest of the line: its quotes and operators are
			// comment text, so the line is copied whole and scanning resumes on the next line.
			const lineEnd = command.indexOf("\n", index);
			const end = lineEnd === -1 ? command.length : lineEnd + 1;
			out += command.slice(index, end);
			index = end;
			wordStart = true;
			continue;
		}
		if (char === "<" && command[index + 1] === "<" && command[index + 2] === "<") {
			out += "<<<";
			index += 3;
			wordStart = true;
			continue;
		}
		if (char === "<" && command[index + 1] === "<") {
			const lineEnd = command.indexOf("\n", index);
			// No newline after the operator: there is no body to strip.
			if (lineEnd === -1) {
				out += command.slice(index);
				return out;
			}
			const delimiters = heredocDelimitersOnLine(command, index, lineEnd);
			if (delimiters.length === 0) {
				// `<<` with no delimiter word: a syntax error, copied as plain content.
				out += "<<";
				index += 2;
				wordStart = true;
				continue;
			}
			out += command.slice(index, lineEnd + 1);
			index = lineEnd + 1;
			for (const delimiter of delimiters) {
				index = endOfHeredocBody(command, index, delimiter);
			}
			wordStart = true;
			continue;
		}
		out += char;
		index += 1;
		wordStart = COMMENT_WORD_BOUNDARY.test(char);
	}
	return out;
}

/** One heredoc delimiter of an introducing line: the word itself and whether `<<-` strips
 * the body lines' leading tabs before the closing-line comparison. */
interface HeredocDelimiter {
	word: string;
	stripTabs: boolean;
}

/** Every heredoc delimiter named on one introducing line, in order: bash reads one body per
 * operator, starting at the line's newline, in the order the operators appear. The bare word
 * ends at whitespace or a shell separator exactly as the shell ends it (`<<EOF; ...` names
 * EOF, then the `;` keeps its command meaning); a quoted word's quotes are stripped, the
 * way the shell derives the delimiter from `<<'EOF'`. A comment on the introducing line
 * ends the scan: operators named only inside it read no body. */
function heredocDelimitersOnLine(command: string, from: number, lineEnd: number): HeredocDelimiter[] {
	const delimiters: HeredocDelimiter[] = [];
	let index = from;
	// The same word-start state the outer passes track: a # after an escaped space is a
	// literal inside the word, not the comment that would end the delimiter scan.
	let wordStart = true;
	while (index < lineEnd) {
		const char = command[index];
		if (char === "#" && wordStart) return delimiters;
		if (char === "'" || char === '"') {
			const close = command.indexOf(char, index + 1);
			index = close === -1 ? lineEnd : Math.min(close + 1, lineEnd);
			wordStart = false;
			continue;
		}
		if (char === "\\") {
			if (command[index + 1] !== "\n") wordStart = false;
			index += 2;
			continue;
		}
		if (char === "<" && command[index + 1] === "<" && command[index + 2] === "<") {
			index += 3;
			wordStart = true;
			continue;
		}
		if (char === "<" && command[index + 1] === "<") {
			let cursor = index + 2;
			let stripTabs = false;
			if (command[cursor] === "-") {
				stripTabs = true;
				cursor += 1;
			}
			while (cursor < lineEnd && (command[cursor] === " " || command[cursor] === "\t")) cursor += 1;
			let word = "";
			if (cursor < lineEnd && (command[cursor] === "'" || command[cursor] === '"')) {
				const quote = command[cursor];
				const close = command.indexOf(quote, cursor + 1);
				if (close !== -1 && close < lineEnd) {
					word = command.slice(cursor + 1, close);
					cursor = close + 1;
				}
			}
			if (word.length === 0) {
				const start = cursor;
				while (cursor < lineEnd && !/[\s;&|<>()]/.test(command[cursor])) cursor += 1;
				word = command.slice(start, cursor);
				if (word.length === 0) return delimiters;
			}
			delimiters.push({ word, stripTabs });
			index = cursor;
			wordStart = false;
			continue;
		}
		index += 1;
		wordStart = COMMENT_WORD_BOUNDARY.test(char);
	}
	return delimiters;
}

/** Where a heredoc body ends: after its closing delimiter line's newline, or at the end of
 * the input when the delimiter never comes (bash reads the body until EOF). */
function endOfHeredocBody(command: string, from: number, delimiter: HeredocDelimiter): number {
	let scan = from;
	for (;;) {
		const newline = command.indexOf("\n", scan);
		const line = (newline === -1 ? command.slice(scan) : command.slice(scan, newline)).replace(/\r$/, "");
		const comparable = delimiter.stripTabs ? line.replace(/^\t+/, "") : line;
		if (comparable === delimiter.word) return newline === -1 ? command.length : newline + 1;
		if (newline === -1) return command.length;
		scan = newline + 1;
	}
}

/** One executable command of a shell command list with the operator that introduced it: the
 * separator between it and the previous command, or "" for the first command. */
interface ShellListCommand {
	text: string;
	operator: string;
}

/**
 * The executable commands of a shell command list: an unquoted `&&`, `||`, `|`, `;`, `&`, or
 * newline ends one command and starts the next, while quotes keep a separator as content — an
 * `echo "codegraph index ."` argument is not a second command. A backslash escapes the next
 * character outside single quotes, so an escaped quote never opens or closes a quoted section
 * (`echo \" ; codegraph index .` is two commands, the second a rebuild).
 * A backslash-newline pair is different: the shell removes it as a line continuation, so it is dropped here instead of escaping the newline.
 * Here-document bodies are removed before the scan: a `<<WORD` operator makes the following
 * lines the input of the command, not commands of the list, and scanning resumes after the
 * closing delimiter line.
 * A comment — a # at the start of a word — is comment text to the end of its line: quotes
 * and separators inside it open and end nothing, and only its newline still ends the command.
 * Each command carries the operator that introduced it, so a conditional list's branches can
 * be told apart: a command after `&&` runs only behind a success, one after `||` only behind
 * a failure.
 */
function shellCommandList(command: string): ShellListCommand[] {
	const commands: ShellListCommand[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let comment = false;
	// The word-start state the comment boundary needs, tracked instead of re-derived from
	// the last raw character: an escaped space keeps the word open, so a # after it is literal.
	let wordStart = true;
	// The separator that introduced the command being accumulated: "" for the first command,
	// one character for `;` `&` `|` and newline, two for the doubled `&&` and `||`.
	let operator = "";
	for (const char of stripHeredocBodies(command)) {
		// Comment text: a word-initial # runs to the end of the line, and only the newline
		// that ends it still separates commands.
		if (comment && char !== "\n") {
			current += char;
			continue;
		}
		if (comment) comment = false;
		// A backslash outside single quotes makes the next character literal, so an escaped
		// quote is content, never a quote toggle; inside single quotes it is literal itself.
		// A backslash-newline pair, by contrast, is a line continuation the shell removes
		// before parsing, so the scanner drops it too: a continued rebuild is still the rebuild,
		// never a command hidden behind its own backslash.
		if (escaped) {
			if (char !== "\n") {
				current += "\\";
				current += char;
				wordStart = false;
			}
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			wordStart = false;
			continue;
		}
		// A word-initial # comments out the rest of the line: quotes and separators inside
		// the comment are text, and the comment's own newline still ends the command.
		if (char === "#" && wordStart) {
			comment = true;
			current += char;
			continue;
		}
		if (char === "\n" || char === ";" || char === "&" || char === "|") {
			// An adjacent |& is one pipeline separator that pipes stderr as well: the & following
			// an unquoted | with no command between them continues the pipeline instead of
			// starting a background command of its own.
			if (char === "&" && current === "" && operator === "|") {
				operator = "|&";
				continue;
			}
			commands.push({ text: current, operator });
			// A doubled & or | is one operator (`&&`, `||`), never two separators — but only
			// when the two characters are adjacent in the input: a command between them means
			// the previous separator introduced that command and this one stands alone
			// (`true & false & cd x` runs the cd behind the second &, not behind &&).
			const doubled = current === "" && operator === char;
			current = "";
			wordStart = true;
			operator = doubled && (char === "&" || char === "|") ? operator + char : char;
			continue;
		}
		current += char;
		wordStart = COMMENT_WORD_BOUNDARY.test(char);
	}
	commands.push({ text: current, operator });
	return commands.filter((part) => part.text.trim().length > 0);
}

/**
 * The `codegraph index`/`codegraph init` commands of a shell command list — full re-indexes that
 * kill the shared daemon and rebuild the index — each carrying the leading-assignments parse of
 * its own command (so the in-command override is recognized on the rebuild command itself, not
 * on an unrelated earlier command) and its verb, on which the CLI's own target rules key.
 * Every executable command is inspected, not only the first: `cd . && codegraph index .`
 * rebuilds as surely as a bare `codegraph index .`. The word boundary keeps every other
 * subcommand (`codegraph indexer`, `sync`, `query`, `unlock`, `status`) out. Each rebuild also
 * carries the directories its position in the list can run in, one per path this walk still
 * follows: every `cd` the list can follow moves them on the path where it succeeds while a
 * failed one leaves them untouched, conditional branches keep both outcomes with the status
 * each left behind, a pipeline decides reachability once for all of its stages, and any form
 * that can move the working directory unseen leaves them unresolvable.
 */
/** The directory after one `cd` command a flat list can follow: exactly one literal
 * argument — quote removal applied, no variable, tilde, or substitution, no extra words
 * the shell refuses — moves the tracked directory exactly as the shell resolves it (an
 * absolute path resets it, a relative one composes onto it); every other form, a bare
 * `cd` to HOME, `cd -`, or a substituted target, leaves a directory this walk cannot name. */
function cdTargetDir(rest: string, cwd: string | undefined): string | undefined {
	const { words } = shellWords(rest.slice(2).trim());
	if (words.length !== 1) return undefined;
	const word = words[0] ?? "";
	if (/[$~(`]/.test(word)) return undefined;
	// `cd -` means OLDPWD: a directory this walk cannot establish, never a child spelled "-".
	if (word === "-") return undefined;
	if (isAbsolute(word)) return word;
	return cwd === undefined ? undefined : resolve(cwd, word);
}

/** A directory a command can run in: the caller's cwd moved by every `cd` the list can
 * follow, or undefined when a form this walk cannot follow may have moved the shell somewhere
 * it cannot name. */
type CwdPath = string | undefined;

/** One rebuild command of a shell list, with the working-directory state at its position. */
interface RebuildCommand {
	rest: string;
	verb: "index" | "init";
	allowIndexOverride: boolean;
	/** Every directory the command can run in — one entry per path through the list this walk
	 * still follows, and a single undefined entry when a form it cannot read may have moved the
	 * shell somewhere it cannot name. */
	cwds: ReadonlyArray<CwdPath>;
}

/** One state the shell can be in at a position of the list: the directory it is in, and the
 * status its last executed command left - which decides whether the following `&&` or `||`
 * branch runs. A command the shell provably skips leaves the state exactly as it was. */
interface CwdState {
	dir: CwdPath;
	verdict: boolean | undefined;
}

/** A list that keeps branching past this many live states is no longer a walk this guard can
 * place commands in: one unresolvable entry stands for every state it could reach. */
const MAX_TRACKED_STATES = 4;

/** Records one live state, without duplicates: two paths that reach the same directory with the
 * same status are one state, and past {@link MAX_TRACKED_STATES} branches the walk can no longer
 * name them, so one unknown entry stands for every state the list could reach. */
function addState(states: CwdState[], state: CwdState): void {
	if (states.some((one) => one.dir === state.dir && one.verdict === state.verdict)) return;
	states.push(state);
	if (states.length > MAX_TRACKED_STATES) states.splice(0, states.length, { dir: undefined, verdict: undefined });
}

/** Whether an operator joins two stages of one pipeline: `|` and `|&` both keep the pipeline
 * alive, while every other separator starts a new one. */
function isPipelineOperator(operator: string): boolean {
	return operator === "|" || operator === "|&";
}

/** Whether one command of a list is a `cd`: the word alone, or followed by its arguments. */
function isCdCommand(rest: string): boolean {
	return rest === "cd" || rest.startsWith("cd ") || rest.startsWith("cd\t");
}

/** Commands that can move the working directory outside a literal `cd`: a leading
 * subshell or substitution runs directory changes of its own, and eval, sourcing, the
 * builtin and command wrappers, and the directory stack all move it in forms this walk
 * cannot read. */
const UNTRACKABLE_CWD_COMMAND = /^[$`]|^\(|^(?:eval|source|builtin|command|pushd|popd)\b|^\.\s/;

/** Whether one command of a list certainly succeeds or certainly fails, as far as this walk
 * can tell: only the constant-status builtins settle their branch; anything else — and
 * anything this walk reads as a directory-moving form — is unknowable. */
function staticExitStatus(rest: string): boolean | undefined {
	const command = rest.trim();
	if (command === "true") return true;
	if (command === "false") return false;
	return undefined;
}

/** The status a pipeline certainly reports, or undefined when this walk cannot prove it: without
 * pipefail the last stage's status is the pipeline's, while pipefail fails the pipeline as soon
 * as any stage fails, so only a pipeline whose stages all hold the same constant status reports
 * that status under both readings. */
function pipelineExitStatus(stageStatuses: ReadonlyArray<boolean | undefined>): boolean | undefined {
	const first = stageStatuses[0];
	return first !== undefined && stageStatuses.every((status) => status === first) ? first : undefined;
}

/** Whether a cd joined by `operator` runs, given the previous command's known verdict: the
 * list start and the unconditional operators always run, `&&` runs only behind a success
 * and `||` only behind a failure, and an unknowable verdict leaves the branch unknowable. */
function branchRuns(operator: string, previousVerdict: boolean | undefined): boolean | undefined {
	if (operator !== "&&" && operator !== "||") return true;
	if (previousVerdict === undefined) return undefined;
	return operator === "&&" ? previousVerdict : !previousVerdict;
}

function codegraphIndexCommands(command: string, startCwd: string): RebuildCommand[] {
	const rebuild = /^codegraph\s+(index|init)\b/;
	const rebuilds: RebuildCommand[] = [];
	const parts = shellCommandList(command);
	const stageStatuses = parts.map((part) => staticExitStatus(leadingAssignments(part.text).rest));
	// The pipelines of the list, each with the operator that introduced it and the status it
	// certainly reports: a stage joined by | or |& belongs to the pipeline before it, and the
	// shell reaches, skips, or reports the group as one - a later stage's success alone never
	// stands for a pipeline whose earlier stage may have failed under pipefail.
	const pipelines: Array<{ operator: string; stages: string[]; status: boolean | undefined }> = [];
	for (let index = 0; index < parts.length;) {
		const start = index;
		while (index + 1 < parts.length && isPipelineOperator(parts[index + 1]!.operator)) index += 1;
		pipelines.push({
			operator: parts[start]!.operator,
			stages: parts.slice(start, index + 1).map((part) => part.text),
			status: pipelineExitStatus(stageStatuses.slice(start, index + 1)),
		});
		index += 1;
	}
	// The states the shell can be in when the next pipeline runs, one per path this walk still
	// follows and starting at the caller's cwd: a pipeline the shell provably skips passes every
	// state through untouched, while a pipeline it runs applies its own effects to the states
	// that ran it only.
	let states: CwdState[] = [{ dir: startCwd, verdict: true }];
	for (const pipeline of pipelines) {
		// Reachability is decided once for the whole pipeline: the shell reaches it or skips it as
		// one, so a skipped group runs none of its stages - none of them moves a directory,
		// rebuilds an index, or replaces the last executed status.
		const executed = states.filter((state) => branchRuns(pipeline.operator, state.verdict) !== false);
		const next = states.filter((state) => branchRuns(pipeline.operator, state.verdict) === false);
		// Every stage starts in the parent shell's directory - a cd inside a stage moves that
		// stage's own subshell - so each rebuild of the pipeline is judged there.
		if (executed.length > 0) {
			for (const stage of pipeline.stages) {
				const parsed = leadingAssignments(stage);
				const verb = rebuild.exec(parsed.rest);
				if (verb !== null) {
					rebuilds.push({ rest: parsed.rest, verb: verb[1] as "index" | "init", allowIndexOverride: parsed.allowIndexOverride, cwds: executed.map((state) => state.dir) });
				}
			}
		}
		const lastStage = leadingAssignments(pipeline.stages[pipeline.stages.length - 1]!).rest;
		for (const state of executed) {
			if (pipeline.stages.length > 1) {
				// A stage of a pipeline runs in its own subshell, so nothing it does to its own
				// directory reaches the parent shell - except the last stage's cd when the lastpipe
				// option puts that stage in the parent, which keeps both directories possible for
				// the commands after it.
				addState(next, { dir: state.dir, verdict: pipeline.status });
				if (isCdCommand(lastStage)) addState(next, { dir: cdTargetDir(lastStage, state.dir), verdict: pipeline.status });
				else if (UNTRACKABLE_CWD_COMMAND.test(lastStage)) addState(next, { dir: undefined, verdict: pipeline.status });
				continue;
			}
			if (isCdCommand(lastStage)) {
				// A cd carries the shell to its target only when it succeeds: a target that is
				// missing, or that the shell may not enter, fails and leaves the shell where it was.
				// Both outcomes stay tracked - the destination with the success it proves, the
				// current directory with the failure - so the branch a failed cd sends the shell
				// into is judged instead of being dropped as unreachable. A form whose target this
				// walk cannot name leaves the success path unresolvable, never the destination as
				// proof of the effective directory.
				addState(next, { dir: cdTargetDir(lastStage, state.dir), verdict: true });
				addState(next, { dir: state.dir, verdict: false });
				continue;
			}
			// Any other command leaves the directory alone, on either outcome - until one that can
			// move it in a form this walk cannot follow makes every later command's directory
			// unknowable.
			addState(next, { dir: UNTRACKABLE_CWD_COMMAND.test(lastStage) ? undefined : state.dir, verdict: pipeline.status });
		}
		states = next;
	}
	return rebuilds;
}

// CodeGraph writes .codegraph/.gitignore with `*` and `!.gitignore`, so that file
// stays untracked and enters every diff. Keep the whole index out of git through
// the worktree's local exclude file; tracked files and .gitignore are never edited.
const LOCAL_EXCLUDE_PATTERN = ".codegraph/";
const EQUIVALENT_EXCLUDE_PATTERNS = new Set([".codegraph", ".codegraph/", "/.codegraph", "/.codegraph/"]);

/** The git-derived exclude path per cwd this prompt: git is asked once, the exclude file is checked on the first call. */
const excludeApplied = new Map<string, string | undefined>();
/** The cwds whose exclude file this prompt already ends with the pattern: later calls skip the re-read. */
const excludePresent = new Set<string>();

function excludeIndexLocally(cwd: string, gitRun: GitRun = defaultGitRun): CodeGraphLocalExclude | undefined {
	let path: string | undefined;
	try {
		if (!excludeApplied.has(cwd)) {
			const inside = gitRun(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
			// --git-path resolves the exclude file a linked worktree actually reads.
			const raw = inside ? resolve(cwd, gitRun(["rev-parse", "--git-path", "info/exclude"], cwd)) : undefined;
			let normalized: string | undefined;
			if (raw !== undefined) {
				mkdirSync(dirname(raw), { recursive: true });
				normalized = join(realpathSync(dirname(raw)), basename(raw));
			}
			excludeApplied.set(cwd, normalized);
		}
		path = excludeApplied.get(cwd);
		if (path === undefined) return undefined;
		if (excludePresent.has(cwd)) return { status: "present", path };
		const current = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (current.split(/\r?\n/).some((line) => EQUIVALENT_EXCLUDE_PATTERNS.has(line.trim()))) {
			excludePresent.add(cwd);
			return { status: "present", path };
		}
		const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
		appendFileSync(path, `${separator}${LOCAL_EXCLUDE_PATTERN}\n`);
		excludePresent.add(cwd);
		return { status: "added", path };
	} catch (error: unknown) {
		const reason = firstLineOf(error);
		return { status: "failed", ...(path ? { path } : {}), reason };
	}
}

function withLocalExcludeNote(text: string, localExclude: CodeGraphLocalExclude | undefined): string {
	if (localExclude?.status !== "failed") return text;
	return `${text}\n\n.codegraph/ is not excluded from git locally (${localExclude.reason}). Keep .codegraph/ out of the change.`;
}

function resolveLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new Error(`CodeGraph limit must be an integer between 1 and ${MAX_LIMIT}.`);
	}
	return limit;
}

function requireQuery(query: string | undefined): string {
	if (typeof query !== "string" || query.trim().length === 0) {
		throw new Error("CodeGraph query is required for query and explore operations.");
	}
	if (query.length > 2_000) {
		throw new Error("CodeGraph query must not exceed 2000 characters.");
	}
	return query;
}

function commandArguments(parameters: CodeGraphToolParameters, cwd: string): string[] {
	if (parameters.operation === CODEGRAPH_OPERATION.INIT) return [CODEGRAPH_OPERATION.INIT, cwd];
	// query and explore share the argument shape; only the limit flag name differs.
	const query = requireQuery(parameters.query);
	const limitFlag = parameters.operation === CODEGRAPH_OPERATION.QUERY ? "--limit" : "--max-files";
	return [parameters.operation, "--path", cwd, limitFlag, String(resolveLimit(parameters.limit)), "--", query];
}
function truncateOutput(output: string): string {
	return output.length <= MAX_OUTPUT_CHARS
		? output
		: `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[CodeGraph output truncated]`;
}

function codeGraphFailureDetails(
	error: unknown,
	operation: CodeGraphOperation,
	cwd: string,
): CodeGraphFallbackDetails {
	const status = isEnoent(error) ? CODEGRAPH_STATUS.UNAVAILABLE : CODEGRAPH_STATUS.FAILED;
	return { status, operation, cwd, fallback: FALLBACK_INSTRUCTIONS };
}

function codeGraphFailureMessage(status: CodeGraphStatus): string {
	return status === CODEGRAPH_STATUS.UNAVAILABLE
		? `CodeGraph is unavailable because the codegraph binary was not found. ${FALLBACK_INSTRUCTIONS}`
		: `CodeGraph failed to run. ${FALLBACK_INSTRUCTIONS}`;
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

/** Find `codegraph.cmd` shims in Windows PATH order. */
function* codeGraphCmdPathsOnPath(): Iterable<string> {
	const pathEnv = process.env.Path ?? process.env.PATH ?? "";
	for (const entry of pathEnv.split(";")) {
		const dir = entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
			? entry.slice(1, -1)
			: entry;
		if (!dir) continue;
		const candidate = join(dir, "codegraph.cmd");
		if (existsSync(candidate)) yield candidate;
	}
}

/**
 * Resolve the actual JS entry of the `@colbymchenry/codegraph` package from the
 * npm global bin dir (sibling of the `codegraph.cmd` shim) and run it with the
 * current Node executable. No shell involvement, so args are never interpreted.
 */
export function codeGraphNodeScript(cmdPath: string): string | undefined {
	const binDir = dirname(cmdPath);
	const pkgRoot = join(binDir, "node_modules", "@colbymchenry", "codegraph");
	const pkgJsonPath = join(pkgRoot, "package.json");
	if (!existsSync(pkgJsonPath)) return undefined;
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { bin?: unknown };
		const bin = pkg.bin;
		const target =
			typeof bin === "string"
				? bin
				: bin &&
						typeof bin === "object" &&
						"codegraph" in bin &&
						typeof (bin as Record<string, unknown>).codegraph === "string"
					? (bin as Record<string, string>).codegraph
					: undefined;
		if (typeof target !== "string" || !target) return undefined;
		const script = join(pkgRoot, target);
		return statSync(script).isFile() ? script : undefined;
	} catch {
		return undefined;
	}
}

function* codeGraphNodeScriptsOnPath(): Generator<string, undefined, unknown> {
	for (const cmdPath of codeGraphCmdPathsOnPath()) {
		const script = codeGraphNodeScript(cmdPath);
		if (script) yield script;
	}
}

/** Test seam: exercised only by the test suite; not part of the tool's runtime surface. */
/** Resolve the first valid CodeGraph npm entry point in Windows PATH order. */
export function findCodeGraphNodeScriptOnPath(): string | undefined {
	return codeGraphNodeScriptsOnPath().next().value;
}

/** The cmd-shim resolution the win32 ENOENT fallback consults: T1's process-lifetime resolver
 * by default, so the PATH scan happens once per process and every later failure is a cache hit.
 * A test seam because the real resolution needs a Windows filesystem: the suite arms a fake
 * entry to observe the fallback's consultation off Windows; production never arms it. */
let codegraphEntryResolver: () => CodegraphShimResolution = resolveCodegraphShimState;

/** Test seam for the win32 ENOENT fallback: arms the resolver its failures consult and returns
 * the restore. Exercised only by the test suite; not part of the tool's runtime surface. */
export function armCodegraphEntryResolverForTest(resolver: () => CodegraphShimResolution): () => void {
	const previous = codegraphEntryResolver;
	codegraphEntryResolver = resolver;
	return () => {
		codegraphEntryResolver = previous;
	};
}

/** The ENOENT-coded "not found" the win32 cascade throws when no proven path could serve the
 * command: the tool's unavailable classification keys on that code, whatever the host runtime
 * managed — or failed — to exec. */
function codegraphNotFound(): Error {
	return Object.assign(new Error("codegraph was not found: no resolved cmd-shim entry, no package script on PATH, and no bare executable the runtime could run"), { code: "ENOENT" });
}

/** The exec every spawn in runCodeGraphCommand goes through; undefined means the real
 * promisified execFile. A test seam so the POSIX bare spawn's ENOENT is observable on any
 * host runtime; production never arms it. */
let codegraphExec: typeof execFileAsync | undefined;

/** Test seam for runCodeGraphCommand's exec: the armed fake receives every spawn the runner
 * performs; the restore puts the real execFile back. Exercised only by the test suite. */
export function armCodegraphExecForTest(exec: typeof execFileAsync | undefined): () => void {
	const previous = codegraphExec;
	codegraphExec = exec;
	return () => {
		codegraphExec = previous;
	};
}

/** The real exec wrapped for spawn observation: resolves and rejects with exactly the
 * promisified form's shapes (the callback's error already carries its code and signal; the
 * result properties the promisified form attaches are attached here too) while handing the
 * spawned child's pid to onSpawn the moment the child exists — the callback form returns
 * the child synchronously; the promisified form never exposes it. The proxy flag mirrors
 * the readiness runner's report: every win32 spawn is reported as a cmd.exe-carrying
 * proxy pid. */
function execFileObserving(
	command: string,
	args: readonly string[],
	options: Parameters<typeof execFileAsync>[2],
	onSpawn?: (pid: number, proxy: boolean) => void,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, options, (error: Error | null, stdout: string, stderr: string) => {
			if (error !== null) {
				// The same result properties the promisified form's rejection carries.
				(error as { stdout?: string }).stdout = stdout;
				(error as { stderr?: string }).stderr = stderr;
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
		if (onSpawn !== undefined && child?.pid !== undefined) {
			try {
				onSpawn(child.pid, process.platform === "win32");
			} catch {
				/* lease bookkeeping is best effort, like the readiness runner's */
			}
		}
	});
}

const runCodeGraphCommand: CodeGraphRunner = async (args, options) => {
	const runOptions = {
		cwd: options.cwd,
		signal: options.signal,
		maxBuffer: options.maxBuffer,
		windowsHide: true,
	};
	// The armed test seam replaces the spawn entirely (and never reports a pid — a fake spawns
	// nothing); the real path runs through the observing wrapper so a lock holding the run can
	// adopt the spawned writer.
	const exec = (command: string, commandArgs: readonly string[], execOptions: typeof runOptions) =>
		codegraphExec !== undefined
			? codegraphExec(command, commandArgs, execOptions)
			: execFileObserving(command, commandArgs, execOptions, options.onSpawn);
	if (process.platform === "win32") {
		// Runtime-independent precedence, the same one spawnCodegraph uses (S3/S11). Node's
		// execFile ENOENTs for bare `codegraph` on Windows because npm installs only .cmd shims
		// and CreateProcess never runs them — but other runtimes differ: bun resolves and runs
		// the shim through cmd.exe, which used to make this whole cascade unreachable and the
		// direct-spawn optimization a silent no-op. The proven T1 resolution therefore comes
		// FIRST, the per-call package scan next, and the bare spawn is the explicit last
		// resort: whatever a runtime can exec there only ever answers after the provable,
		// faster paths had their chance, so node, bun, and whatever comes next behave alike.
		let unavailableError: unknown = codegraphNotFound();
		const resolution = codegraphEntryResolver();
		if (resolution.status === "entry") {
			try {
				const result = await exec(resolution.entry.node, [resolution.entry.script, ...args], runOptions);
				return { stdout: result.stdout, stderr: result.stderr };
			} catch (innerError) {
				if (!isEnoent(innerError)) throw innerError;
				unavailableError = innerError;
			}
		}
		// A rejected first shim — one whose invocation this process cannot reproduce — stops the
		// cascade at the shim's own spawn: the package beside it is not an equivalent (the shim's
		// fixed arguments would be dropped), so the scan is skipped and the bare spawn below, the
		// shim's cmd.exe route, is the only remaining path — a runtime that cannot run .cmd files
		// fails closed into unavailable. A genuine miss (or an entry whose spawn ENOENTed) keeps
		// the scan exactly as before.
		if (resolution.status !== "rejected") {
			// Resolve the real package script from each npm global bin directory in PATH
			// order and run it through the current executable. This remains shell-free,
			// so argument boundaries are never interpreted by a shell.
			for (const script of codeGraphNodeScriptsOnPath()) {
				try {
					const result = await exec(process.execPath, [script, ...args], runOptions);
					return { stdout: result.stdout, stderr: result.stderr };
				} catch (innerError) {
					if (!isEnoent(innerError)) throw innerError;
					unavailableError = innerError;
				}
			}
		}
		// Last resort: a real codegraph.exe the runtime can CreateProcess, or — on runtimes
		// that run .cmd shims — the shim itself. A genuine command failure surfaces as-is;
		// only a runtime-level miss maps onto the unavailable error.
		try {
			const result = await exec("codegraph", [...args], runOptions);
			return { stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			throw isEnoent(error) ? unavailableError : error;
		}
	}
	const result = await exec("codegraph", [...args], runOptions);
	return { stdout: result.stdout, stderr: result.stderr };
};


/** How long the daemon attempt may take before the CLI fallback takes over. */
const DAEMON_ATTEMPT_TIMEOUT_MS = 30_000;

/** One daemon query attempt: undefined or a miss means "use the CLI path". */
export type DaemonExplore = (cwd: string, parameters: CodeGraphToolParameters, timeoutMs: number) => Promise<DaemonCallResult | undefined>;

/** The daemon's registered MCP tools, with their natural arguments: codegraph_search — the
 * CLI query's socket name; the daemon's dispatch has no codegraph_query case, so that name
 * answers "Unknown tool" and the query could never ride the socket — and codegraph_explore.
 * Both stay callable unlisted, but only these two names are sent. */
async function queryViaDaemon(cwd: string, parameters: CodeGraphToolParameters, timeoutMs: number): Promise<DaemonCallResult | undefined> {
	try {
		const query = requireQuery(parameters.query);
		const limit = resolveLimit(parameters.limit);
		return parameters.operation === CODEGRAPH_OPERATION.QUERY
			? await exploreViaDaemon(cwd, "codegraph_search", { query, limit }, timeoutMs)
			: await exploreViaDaemon(cwd, "codegraph_explore", { query, maxFiles: limit }, timeoutMs);
	} catch {
		return undefined;
	}
}

/** The cwds whose daemon was wedged this prompt (the post-warm attempt timed out): the CLI answers directly until the next prompt. */
const daemonSkipUntil = new Map<string, number>();

/** How long a wedged daemon is bypassed after its post-warm attempt times out. */
export const DAEMON_SKIP_MS = 60_000;

/** The bypass entries a session START recorded from its own health verdict: unlike the
 * prompt-scoped failures the query path records, these survive the first
 * before_agent_start — the user was told queries use the CLI fallback — and expire on
 * their own DAEMON_SKIP_MS clock. */
const startupDaemonSkip = new Set<string>();

/** The map key a daemon bypass is recorded and read under: the same canonical spelling
 * resolveWorkspaceCwd produces, so a session started through a symlink to the project
 * still finds its recorded verdict at query time; an unresolvable workspace keeps its own
 * spelling. */
function daemonSkipKey(workspace: string): string {
	try {
		return resolveWorkspaceCwd(workspace);
	} catch {
		return workspace;
	}
}

/** Records a wedged daemon the session start itself detected: keyed canonically and
 * marked startup-owned so the first prompt boundary keeps it until its own expiry. */
function recordStartupDaemonSkip(workspace: string): void {
	const key = daemonSkipKey(workspace);
	daemonSkipUntil.set(key, Date.now() + DAEMON_SKIP_MS);
	startupDaemonSkip.add(key);
}

/** Test seam for the startup wedge verdict: records the entry the session-start warm
 * seam records and returns its restore. Exercised only by the test suite; not part of
 * the tool's runtime surface. */
export function armStartupDaemonSkipForTest(workspace: string): () => void {
	const key = daemonSkipKey(workspace);
	recordStartupDaemonSkip(workspace);
	return () => {
		daemonSkipUntil.delete(key);
		startupDaemonSkip.delete(key);
	};
}

/** The session-start say handle the lazy re-warm ready notice rides: captured when a session
 * starts so a daemon revived mid-session can announce itself, replaced by every newer session,
 * and undefined whenever no session through this module ever started - no UI, no announce. */
let warmNoticeSay: ((text: string, level: "info" | "warning") => void) | undefined;

/**
 * How long a settled pre-query sync keeps a win32 root fresh: consecutive searches inside this
 * window run no `sync -q` of their own — each one is a full CLI startup on Windows (×5 on a
 * network share). POSIX refreshes before every search exactly as before (S11).
 */
export const SYNC_FRESH_WINDOW_MS = 60_000;

/**
 * The canonical roots (resolveWorkspaceCwd already realpath'ed them) whose last pre-query sync
 * settled without failure, and when. Purely time-based — a new user prompt does not reset it:
 * the index does not go stale at a prompt boundary. Win32 only (S4/S11).
 */
const syncFreshAt = new Map<string, number>();

/**
 * One tracked refresh per cwd on win32: only the call that created the underlying job observes
 * its failure callbacks (a caller that joined an in-flight job sees none of them), so the
 * creator records the shared verdict — a joiner awaiting the same promise can never misread
 * "no failure reached me" as a successful sync.
 */
const searchSyncOutcome = new Map<string, Promise<void>>();

/** A new user prompt starts a new search window: git, the local exclusion, and the daemon are re-asked once. The index refreshes before every search on POSIX; on win32 a settled sync keeps the root fresh for SYNC_FRESH_WINDOW_MS — a time-based window a prompt boundary does not reset (S11). */
export function clearSearchWindow(): void {
	workspaceVerified.clear();
	excludeApplied.clear();
	excludePresent.clear();
	// A new prompt resets only the prompt-scoped query failures: a wedge the session START
	// detected keeps its bypass until the verdict's own 60-second expiry, so the first
	// search still honors the "queries use the CLI fallback for now" the user was told.
	const now = Date.now();
	for (const [cwd, until] of daemonSkipUntil) {
		if (startupDaemonSkip.has(cwd) && until > now) continue;
		daemonSkipUntil.delete(cwd);
		startupDaemonSkip.delete(cwd);
	}
}

/** What a failed sync knows about its own cause when the runner reported it. */
export interface CodegraphSyncFailureInfo {
	daemonAlive?: boolean;
	exitCode?: number | null;
	stderrTail?: string;
}

/**
 * The notify for a failed index refresh: beside a live daemon the file watcher keeps the index
 * fresh by itself (the CLI sync coexists with it), so that failure is information, not a warning;
 * anywhere else it stays a warning, with the command outcome when the runner reported it.
 */
export function codegraphSyncFailureNotice(
	cwd: string,
	stage: "sync" | "lease",
	info: CodegraphSyncFailureInfo,
): { text: string; level: "info" | "warning" } {
	const reason = info.exitCode === undefined ? "" : info.exitCode === null ? " — killed (timeout)" : ` — exit ${info.exitCode}`;
	const tail = info.stderrTail === undefined || info.stderrTail.length === 0 ? "" : `: ${info.stderrTail}`;
	if (stage === "lease") return { text: `codegraph sync skipped in ${cwd}: the cross-session sync lease is not acquirable`, level: "warning" };
	if (info.daemonAlive) {
		return { text: `codegraph sync failed in ${cwd} (daemon alive; its file watcher keeps the index fresh)${reason}${tail}`, level: "info" };
	}
	return { text: `codegraph sync failed in ${cwd}${reason}${tail}`, level: "warning" };
}

/**
 * The notify for one settled warm-up: every success - freshly warmed, a racing winner's daemon
 * the spawn adopted, or a live daemon the health probe already verified so no warm ran - carries
 * the same ready line, and the wedged and failed outcomes carry their warning. Every
 * WarmUpOutcome shape maps to exactly one notice, so an emitter never branches on its own.
 */
export function warmNotice(outcome: WarmUpOutcome, cwd: string): { text: string; level: "info" | "warning" } {
	if (outcome.ok) return { text: `CodeGraph ready in ${cwd}`, level: "info" };
	if (outcome.wedged) return { text: `CodeGraph daemon in ${cwd} is not answering; queries use the CLI fallback for now`, level: "warning" };
	return { text: `CodeGraph warm-up failed in ${cwd}`, level: "warning" };
}

/** Delivers a warm-up completion notice through the say handle of the session that started the
 * warm-up: a handle that is no longer the current session's belongs to a session that ended or
 * was replaced, so its completion is discarded instead of announcing through the newer session
 * and suppressing that session's own deferred start notice. */
function sayWarmNotice(
	say: ((text: string, level: "info" | "warning") => void) | undefined,
	outcome: WarmUpOutcome,
	cwd: string,
): void {
	if (say === undefined || say !== warmNoticeSay) return;
	const notice = warmNotice(outcome, cwd);
	say(notice.text, notice.level);
}

/**
 * The notify for the index action a session start is about to run: the init line announces
 * initialization before the first index is built, the sync line keeps its existing text.
 * Emitted through onStart before the index dispatch runs, so a session that will build or
 * refresh the index announces it first.
 */
export function indexStartNotice(action: "init" | "sync"): { text: string; level: "info" } {
	if (action === "sync") return { text: "syncing the CodeGraph index...", level: "info" };
	return { text: "initializing the current repo for CodeGraph...", level: "info" };
}

/**
 * The notice for one settled session-start index action: a stand-down init — the main
 * checkout is creating its own index, so this worktree still has no database — reports
 * deferral instead of creation, while sync keeps its synced line and an init that produced
 * or confirmed an index keeps the creation line. Failure notices map exactly as the
 * wiring emitted them before the mapping moved here.
 * A sequence that stopped on an unconfirmed teardown reports that stop instead of the manual init.
 */
export function indexedNotice(
	result: { action: IndexAction; ok: boolean; stoodDown?: boolean; daemonAlive?: boolean; exitCode?: number | null; stderrTail?: string; initAttempts?: number; /** Why the init retry sequence stopped early; "teardown-unconfirmed" means a writer of the failed attempt may still be running. */ initStop?: "teardown-unconfirmed" },
	cwd: string,
): { text: string; level: "info" | "warning" } | undefined {
	// "none" is reported before anything runs and carries no notice of its own.
	if (result.action === "none") return undefined;
	if (result.ok) {
		if (result.action === "sync") return { text: "CodeGraph index synced", level: "info" };
		if (result.stoodDown) return { text: `CodeGraph index creation deferred in ${cwd}: the main checkout is creating its index`, level: "info" };
		return { text: "CodeGraph index created", level: "info" };
	}
	if (result.action === "sync") return codegraphSyncFailureNotice(cwd, "sync", result);
	// A sequence stopped because an attempt's teardown could not be proved gone is not an exhausted
	// retry sequence: asking for a manual init here would start a second writer beside the one that
	// may still be writing, so the notice names the unconfirmed stop and the wait instead.
	if (result.initStop === "teardown-unconfirmed") {
		return { text: `codegraph init failed in ${cwd}: the previous attempt could not be confirmed stopped, so init was not retried; retry later once no codegraph writer is running`, level: "warning" };
	}
	// An init whose silent retries were exhausted is the one failure the user can fix by
	// hand, so the notice names the action; every other init failure keeps the plain line.
	if (result.initAttempts !== undefined && result.initAttempts > 1) {
		return { text: `codegraph init failed in ${cwd} after ${result.initAttempts - 1} retries; run "codegraph init" manually`, level: "warning" };
	}
	return { text: `codegraph ${result.action} failed in ${cwd}`, level: "warning" };
}

/** How long a session-start index notice waits before it is said. The installed pi TUI paints
 * an info-level notify as ONE transient status chat line that the next info-level notify
 * replaces in place, and the session_start emit loop fires further extension notifies right
 * after this one, so a same-instant say is overwritten before the first render ever paints it.
 * The warm-up and ready notices fire later, once the chat has settled - which is why the user
 * sees exactly those - and the same spacing keeps the index line on screen. Bounded: the say
 * either lands inside this window or a flow that already said something cancels it as stale. */
export const START_NOTICE_DELAY_MS = 250;

/**
 * Awaits the index refresh for `cwd` and returns whether one covered this search: a subagent
 * child or an unindexed workspace never refreshes, and every other search waits for its refresh
 * to settle — a call that arrives while one is in flight awaits that same job — so the query
 * reads fresh data.
 */
export async function awaitSearchSync(cwd: string, ctx: ExtensionContext, run: SearchSyncInput["run"] = runCodegraph, opts?: { indexed?: boolean; registryDir?: string; sleep?: (ms: number) => Promise<void> }): Promise<boolean> {
	if (process.env[CHILD_ENV] === "1") return false;
	// Nothing to refresh without an index: an unindexed workspace must not spawn a doomed
	// sync CLI call (plus failure notices) every query — init owns the first index.
	if (!(opts?.indexed ?? indexExists(cwd))) return false;
	// Windows pays a full CLI startup per pre-query sync (S4): a root whose last sync settled
	// successfully inside the freshness window is already served by it — straight to the query.
	// POSIX keeps its refresh-before-every-search flow exactly as it is (S11).
	const windowed = process.platform === "win32";
	const freshAt = syncFreshAt.get(cwd);
	if (windowed && freshAt !== undefined && Date.now() - freshAt < SYNC_FRESH_WINDOW_MS) return false;
	if (windowed) {
		const running = searchSyncOutcome.get(cwd);
		// A joined in-flight refresh covers this search like one's own — and its creating call
		// records the shared verdict, so a joiner never mistakes it for a fresh successful sync.
		if (running) {
			await running;
			return true;
		}
	}
	let failed = false;
	// Whether THIS session's refresh actually ran a sync: a lease held by another session
	// ("held-live") or CodeGraph's own writing lock makes the refresh run nothing here and
	// report no failure — an outcome this session never confirmed must not open the
	// freshness window, because the holder's sync may still fail.
	let ran = false;
	const observedRun: SearchSyncInput["run"] = (...runArgs: Parameters<SearchSyncInput["run"]>) => {
		ran = true;
		return run(...runArgs);
	};
	const job = (async (): Promise<void> => {
		await syncBeforeSearch({
			cwd,
			registryDir: opts?.registryDir,
			sleep: opts?.sleep,
			run: observedRun,
			onFailed: (stage, failure) => {
				failed = true;
				if (!ctx.hasUI) return;
				const notice = codegraphSyncFailureNotice(cwd, stage, failure);
				ctx.ui.notify(notice.text, notice.level);
			},
			onError: (reason) => {
				failed = true;
				if (!ctx.hasUI) return;
				ctx.ui.notify(`CodeGraph refresh failed in ${cwd}: ${reason}`, "warning");
			},
		});
		if (windowed) {
			// Only a refresh this session ran to a settled, unfailed sync buys freshness; a
			// failure never does, and neither does an outcome that ran nothing here (the holder's
			// verdict is unconfirmed) — both clear any older mark so the very next search
			// refreshes again.
			if (failed || !ran) syncFreshAt.delete(cwd);
			else syncFreshAt.set(cwd, Date.now());
		}
	})();
	if (windowed) searchSyncOutcome.set(cwd, job);
	try {
		await job;
	} finally {
		if (windowed) searchSyncOutcome.delete(cwd);
	}
	return true;
}

export function createCodeGraphTool(
	runner: CodeGraphRunner = runCodeGraphCommand,
	{
		queryTimeoutMs = CODEGRAPH_QUERY_TIMEOUT_MS,
		daemonAttemptTimeoutMs = DAEMON_ATTEMPT_TIMEOUT_MS,
		daemonExplore = queryViaDaemon,
		// The win32 query path never awaits its warm-up (S9), so there it runs backgrounded — an
		// unref'ed warm-up cannot keep the session alive; POSIX races its wait, never blocking past it.
		// A warm this path started announces its success through the same ready line the lazy
		// re-warm emits — bound to the session that started the warm-up — while failures stay
		// silent: the query path is best effort and already falls back to the CLI.
		warm = (project: string, timeoutMs: number) => {
			const say = warmNoticeSay;
			return warmUpDaemon(project, true, timeoutMs).then((warmed) => {
				if (!warmed) return false;
				sayWarmNotice(say, { ok: true }, project);
				return true;
			});
		},
		// The lazy re-warm announces only success: a daemon that stays dead is re-warmed by every
		// query, and failure notices there would be per-query noise the CLI fallback already
		// answers - one ready line when the daemon is back is the whole message.
		rewarm = (project: string) => maybeRewarm(project, (daemonProject) => {
			const say = warmNoticeSay;
			return warmUpDaemonDetailed(daemonProject, true).then((outcome) => {
				if (!outcome.ok) return false;
				sayWarmNotice(say, outcome, project);
				return true;
			});
		}),
		syncRun = runCodegraph,
		gitRun = defaultGitRun,
		initLock = acquireInitLock,
	}: {
		queryTimeoutMs?: number;
		/** Caps each daemon attempt and the raced warm-up wait on the query path; the warm itself keeps the full session-start budget. */
		daemonAttemptTimeoutMs?: number;
		daemonExplore?: DaemonExplore;
		/** Warms the daemon between the two query attempts; the default never rejects. */
		warm?: (cwd: string, timeoutMs: number) => Promise<boolean>;
		/** Lazily re-warms a daemon that died mid-session before each search; the default keeps the real behavior, tests inject a no-op so their fakes never spawn anything real. */
		rewarm?: (cwd: string) => void;
		/** Runs the refresh awaited before every search; injected in tests. */
		syncRun?: SearchSyncInput["run"];
		/** Runs every git interrogation (workspace guard, exclude detection); injected in tests. */
		gitRun?: GitRun;
		/** Acquires the cross-session init lock around the explicit init operation; injected in tests. */
		initLock?: (cwd: string) => Promise<InitLockOutcome>;
	} = {},
) {
	return {
		name: "codegraph",
		renderShell: "self" as const,
		label: "CodeGraph",
		description:
			"Initialize, search, or explore the CodeGraph index for the current Pi workspace only. This tool never accepts a project path or shell command.",
		promptSnippet: "Initialize and query CodeGraph for the current workspace without shell access",
		promptGuidelines: [
			"Use operation init before querying when the current workspace has no .codegraph index.",
			"Use query for symbol search and explore for source plus call paths. Do not use this tool to run arbitrary commands or target another directory.",
		],
		parameters: CODEGRAPH_TOOL_PARAMETERS,
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			parameters: CodeGraphToolParameters,
			signal: AbortSignal | undefined,
			_onUpdate: undefined,
			ctx: ExtensionContext,
		): Promise<CodeGraphToolResult> {
			const cwd = resolveWorkspaceCwd(ctx.cwd, gitRun);
			assertSafeIndexDirectory(cwd);
			const args = commandArguments(parameters, cwd);
			// One shaped success result: every success path truncates its output, applies the same
			// local-exclude handling, and shares the no-output line (excludeAlways: init just built
			// the index, so its exclude is not gated on indexExists).
			const finish = (output: string, extra: { viaDaemon?: boolean; excludeAlways?: boolean; syncTriggered?: boolean } = {}): CodeGraphToolResult => {
				const localExclude = extra.excludeAlways || indexExists(cwd) ? excludeIndexLocally(cwd, gitRun) : undefined;
				return {
					content: [{ type: "text" as const, text: withLocalExcludeNote(output || "CodeGraph completed without output.", localExclude) }],
					details: {
						operation: parameters.operation,
						cwd,
						args,
						...(extra.viaDaemon !== undefined ? { viaDaemon: extra.viaDaemon } : {}),
						...(extra.syncTriggered ? { syncTriggered: true } : {}),
						...(localExclude ? { localExclude } : {}),
					},
				};
			};
			// One shaped failure result: fallback details plus the same local-exclude handling.
			const fail = (error: unknown, extra: { syncTriggered?: boolean; reason?: string } = {}): CodeGraphToolResult => {
				const details = codeGraphFailureDetails(error, parameters.operation, cwd);
				const localExclude = indexExists(cwd) ? excludeIndexLocally(cwd, gitRun) : undefined;
				if (localExclude) details.localExclude = localExclude;
				return {
					content: [{ type: "text" as const, text: withLocalExcludeNote(extra.reason ?? codeGraphFailureMessage(details.status), localExclude) }],
					details: { ...details, ...(extra.syncTriggered ? { syncTriggered: true } : {}) },
				};
			};
			// MCP-only query path: query and explore always go through the daemon socket (roughly 75 ms
			// local against ~590 ms, 0.5-2 s on a network share against 2.5-6 s for a CLI process),
			// so a search never spawns a CLI process of its own.
			if (parameters.operation !== CODEGRAPH_OPERATION.INIT) {
				// A caller that already cancelled returns before any search stage runs: the re-warm, the
				// background sync, and the first daemon attempt would all be work for an answer nobody
				// waits for, and raceWithAbort cannot observe an abort that already happened.
				if (signal?.aborted) return fail(signal.reason ?? new Error("The operation was aborted"));
				// Lazy re-warm: if the project's daemon died mid-session, warm it in the background so the
				// next query is fast again. Never blocks this call. Routed through the injected adapter so
				// tests supplying the other query seams never reach the real daemon spawn.
				rewarm(cwd);
				// Every search awaits its index refresh first — the freshest data, then the query —
				// bounded by the sync timeout, skipped only for children and unindexed workspaces.
				// One indexExists per query serves the sync gate and the result paths below; a daemon
				// that answers ok confirms the same fact.
				const indexed = indexExists(cwd);
				const syncTriggered = (await raceWithAbort(signal, awaitSearchSync(cwd, ctx, syncRun, { indexed }))) ?? false;

				// A cancellation that landed during the sync wait ends the search here: raceWithAbort
				// abandons only the WAIT, so evaluating the attempt below would still open a socket and
				// run a daemon query whose answer nobody waits for. The shared refresh keeps running
				// for the callers still awaiting it.
				if (signal?.aborted) return fail(signal.reason ?? new Error("The operation was aborted"), { syncTriggered });
				const attempt = () => daemonExplore(cwd, parameters, Math.min(queryTimeoutMs, daemonAttemptTimeoutMs));
				let viaDaemon: DaemonCallResult | undefined;
				if (Date.now() >= (daemonSkipUntil.get(cwd) ?? 0)) {
					viaDaemon = await raceWithAbort(signal, attempt()) ?? undefined;
					// A retry stage is entered only while the caller still wants the answer: Node emits
					// abort once, so a listener registered on an already-aborted signal never fires, and the
					// warm-up could otherwise consume its whole budget after the cancellation.
					if (viaDaemon?.status !== "ok" && !signal?.aborted) {
						if (process.platform === "win32") {
							// A daemon-death query must never stack attempt → warm (up to 120 s) → attempt → CLI
							// (S9): the warm-up runs in the background — the default warm seam passes
							// background=true, so it never keeps this process alive — and this query
							// falls through to the CLI at once, with no second daemon attempt even after a fast
							// warm failure. The DAEMON_SKIP_MS bypass below still spans the warm-up, so a
							// background warm that revives the daemon is picked up at the next window.
							void warm(cwd, WARMUP_TIMEOUT_MS).catch(() => { /* best effort */ });
						} else {
							// Best-effort warm-up between the two attempts: a daemon that was never started gets one.
														// The warm carries the full session-start budget — a cold daemon on a slow share can outlive
							// the attempt budget and would be killed mid-handshake at 30 s — while the query still waits
							// no longer than before: a fast warm wins the race, and a slow one keeps running unref'ed
							// for the next window to adopt the daemon it leaves behind.
							await raceWithAbort(signal, Promise.race([
								warm(cwd, WARMUP_TIMEOUT_MS).catch(() => { /* best effort */ }),
								new Promise<void>((resolveDelay) => {
									const delayTimer = setTimeout(resolveDelay, daemonAttemptTimeoutMs);
									delayTimer.unref?.();
								}),
							]));
							if (!signal?.aborted) viaDaemon = await raceWithAbort(signal, attempt()) ?? undefined;
						}
					}
					if (viaDaemon?.status === "timeout" || viaDaemon?.status === "unavailable") {
						// The post-warm attempt still cannot serve — wedged (timeout) or refusing (unavailable,
						// e.g. no project loaded): the CLI answers until the next turn instead of re-paying
						// attempt+warm+attempt on every query. A search that started before session start can
						// publish its failure after the startup wedge was recorded; the startup verdict then
						// keeps its own deadline and marker instead of being demoted to a prompt-scoped
						// failure the next prompt boundary would clear — but only while that deadline still
						// runs: an expired startup entry must not block the fresh bypass this failure earns,
						// or every later search of the prompt re-runs the attempt chain the bypass skips.
						if (!(startupDaemonSkip.has(cwd) && (daemonSkipUntil.get(cwd) ?? 0) > Date.now())) {
							daemonSkipUntil.set(cwd, Date.now() + DAEMON_SKIP_MS);
							// Fresh query evidence supersedes a startup verdict: this entry is prompt-scoped.
							startupDaemonSkip.delete(cwd);
						}
					}
				}
				if (viaDaemon?.status === "ok") return finish(truncateOutput(viaDaemon.text), { viaDaemon: true, syncTriggered });
				// Still no daemon: the search still runs — one CLI process as the last resort. The daemon
				// stays the only path while it answers; when it cannot serve (never started, died, hung, or
				// has no project loaded), a slower correct answer beats the read/grep/find dead end.
				// The CLI fallback carries the same query budget as the daemon attempts (#1901): a hung
				// CLI process must not block the turn until the user aborts; init below stays signal-only.
				// A caller that already cancelled exits here instead: the fallback's fresh controller
				// must never buy the search another full budget past the cancellation.
				if (signal?.aborted) return fail(signal.reason ?? new Error("The operation was aborted"), { syncTriggered });
				try {
					const result = await (async () => {
						const cliController = new AbortController();
						// The controller starts from the caller's current abort state, so a cancellation that
						// races past the exit above can never leave it uncancelled.
						if (signal?.aborted) cliController.abort();
						const onCallerAbort = () => cliController.abort();
						signal?.addEventListener("abort", onCallerAbort, { once: true });
						let cliTimer: ReturnType<typeof setTimeout> | undefined;
						try {
							return await Promise.race([
								runner(args, { cwd, signal: cliController.signal, maxBuffer: PROCESS_MAX_BUFFER }),
								new Promise<never>((_, reject) => {
									cliTimer = setTimeout(() => {
										cliController.abort();
										reject(new Error(`CodeGraph CLI timed out after ${queryTimeoutMs} ms.`));
									}, queryTimeoutMs);
								}),
							]);
						} finally {
							clearTimeout(cliTimer);
							signal?.removeEventListener("abort", onCallerAbort);
						}
					})();
					return finish(truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n")), { viaDaemon: false, syncTriggered });
				} catch (error: unknown) {
					return fail(error, { syncTriggered });
				}
			}
			// A subagent child (CHILD_ENV) never starts an index operation of its own: index creation is
			// parent-session-owned, so init refuses here without ever invoking the CLI runner.
			if (process.env[CHILD_ENV] === "1") {
				return fail(new Error(CHILD_INIT_REFUSAL), { reason: CHILD_INIT_REFUSAL });
			}
			// init keeps its CLI path: it is the legitimately slow first index, bounded only by the user's signal.
			// The same guard the bash path enforces: an existing index is refreshed with sync, never
			// rebuilt from the tool without the explicit override — a rebuild kills the daemon every
			// session shares.
			if (indexExists(cwd) && process.env.GENTLE_CODEGRAPH_ALLOW_INDEX !== "1") {
				return fail(new Error(CODEGRAPH_INDEX_BLOCK_REASON), { reason: CODEGRAPH_INDEX_BLOCK_REASON });
			}
			// The same cross-session init lock session-start readiness and worktree seeding hold: an
			// explicit init never writes the same .codegraph target while another session's init or
			// seed is still publishing into it. A lock that stays held, or an index that appeared
			// while the lock was waited on, is reported to the caller instead of bypassing the lock.
			const lock = await initLock(cwd);
			if (lock.outcome !== "acquired") {
				const reason = lock.outcome === "present"
					? CODEGRAPH_INDEX_BLOCK_REASON
					: "CodeGraph: the init lock for this workspace is held by another session, so this init cannot run concurrently with it.";
				return fail(new Error(reason), { reason });
			}
			try {
				// Re-checked under the acquired lease: `.codegraph` may have become a link to
				// another checkout's index while this init waited — the same identity check the
				// entry ran, independent of the override, which authorizes rebuilding THIS
				// target, never an initialization redirected through a link.
				assertSafeIndexDirectory(cwd);
				// Re-checked under the acquired lock: the other initializer may have finished AND
				// released while this call waited, so acquisition succeeds with the database already
				// in place — the free-lease branch is not a completion proof. Rebuilding here would
				// kill the shared daemon that finished init just serves, so the holder stands down.
				// "absent" is the only state this init still serves: "present" and "unknown" both stand
				// down — an unreadable .codegraph is never rebuilt on a guess — and the override stays
				// the one deliberate path through.
				if (indexStateRead(cwd) !== "absent" && process.env.GENTLE_CODEGRAPH_ALLOW_INDEX !== "1") {
					return fail(new Error(CODEGRAPH_INDEX_BLOCK_REASON), { reason: CODEGRAPH_INDEX_BLOCK_REASON });
				}
				const result = await runner(args, { cwd, signal, maxBuffer: PROCESS_MAX_BUFFER, onSpawn: (pid, proxy) => lock.adopt(pid, proxy) });
				return finish(truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n")), { excludeAlways: true });
			} catch (error: unknown) {
				// A failed init can still leave a partial index behind.
				return fail(error);
			} finally {
				lock.release();
			}
		},
	};
}

export function registerCodeGraphTool(pi: ExtensionAPI): void {
	pi.registerTool(createCodeGraphTool());
}

/** The one in-process mcp.json exposure ensure: later session starts are no-ops. */
let exposureEnsured = false;

/**
 * The file io the exposure ensure runs with: undefined means the real agent-home files. A test
 * seam in the EnsureExposureIo shape, so the session-start wiring is observable without ever
 * touching a real home.
 */
let exposureIo: EnsureExposureIo | undefined;

/**
 * Test seam for the session-start exposure wiring: installs the io the next ensure runs with
 * and re-arms the once-per-process flag, so one test process can exercise both a parent and a
 * child session. Production never calls this; the default keeps the real agent-home files.
 */
export function armExposureEnsureForTest(io: EnsureExposureIo | undefined): void {
	exposureIo = io;
	exposureEnsured = false;
}

function ensureExposureOnce(): void {
	// Subagent children never patch user config; the parent session owns it once.
	if (exposureEnsured || process.env[CHILD_ENV] === "1") return;
	exposureEnsured = true;
	try {
		ensureDirectExposureInAgentHomes(homedir(), exposureIo);
	} catch {
		/* never surface: the exposure patch is best effort */
	}
}

export default function codeGraphTools(pi: ExtensionAPI): void {
	registerCodeGraphTool(pi);
	// The search-window reset binds to before_agent_start — the user-prompt boundary — not
	// turn_start, which fires for every assistant response (including each response between
	// tool calls) and would clear the 60-second daemon bypass mid-prompt. Verified in
	// the resolved @earendil-works/pi-coding-agent package: before_agent_start is emitted once
	// per run start (a submitted prompt, RPC prompt, or sendUserMessage — plus an idle custom
	// message with triggerTurn), while retries, queued continuations, and compaction inside
	// that run continue through agent.continue() without re-emitting it. The index refresh no
	// longer resets here: every search awaits its own refresh now.
	pi.on?.("before_agent_start", () => clearSearchWindow());
	// `codegraph index`/`codegraph init` from bash rebuilds the index from scratch and kills the
	// daemon every session shares (a full rebuild once took the daemon down), while the runtime
	// already refreshes the index with sync before every search. When an index
	// already exists the rebuild is blocked — "if an index exists, do not re-index — only sync" —
	// and GENTLE_CODEGRAPH_ALLOW_INDEX=1 is the explicit override. The guard is total: any
	// internal error allows the call, so a broken guard can never break bash.
	pi.on?.("tool_call", (event, ctx) => {
		try {
			if (event.toolName !== "bash" && event.toolName !== "bash_background") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;
			const rebuilds = codegraphIndexCommands(command, ctx.cwd);
			if (rebuilds.length === 0) return undefined;
			if (process.env.GENTLE_CODEGRAPH_ALLOW_INDEX === "1") return undefined;
			// The override must ride EVERY rebuild command: one authorized rebuild never
			// authorizes the rest of the list (`=1 codegraph index .; codegraph init`).
			if (rebuilds.every((rebuild) => rebuild.allowIndexOverride)) return undefined;
			// A rebuild is blocked only at the index it would actually rebuild, located the way the
			// CLI itself locates it: the exact positional target first — an index initialized below
			// the Git root is rebuilt at its own directory, which the Git root never sees — and for
			// `index` the nearest initialized ancestor above it, the resolution a bare call performs.
			// A rebuild carrying its own override is already authorized: it is excluded here, so an
			// ordinary first init elsewhere in the list never blocks on the authorized sibling's target.
			if (!rebuilds.some((rebuild) => !rebuild.allowIndexOverride && rebuildsExistingIndex(rebuild.verb, rebuild.rest, rebuild.cwds))) return undefined;
			return { block: true, reason: CODEGRAPH_INDEX_BLOCK_REASON };
		} catch {
			return undefined;
		}
	});
	// Session-start readiness: the index first (sync or init, in the background), then the daemon
	// warm-up, so the first real query of the session is fast. The session never waits for any of it.
	pi.on?.("session_start", (event, ctx) => {
		const reason = (event as { reason?: unknown }).reason;
		if (typeof reason !== "string") return;
		// Whether this session already said anything: the deferred start notice below lands only
		// while nothing newer has replaced its moment (an index run finishing inside the deferral
		// window has already said its result, and a stale "initializing..." after that would lie).
		let said = false;
		const say = (text: string, level: "info" | "warning") => {
			said = true;
			if (ctx.hasUI) ctx.ui.notify(text, level);
		};
		// The latest session owns the lazy re-warm's ready notice.
		warmNoticeSay = say;
		// The seed outcome the index notice keys on: main-busy is the benign stand-down whose
		// ok verdict must not read as a created index (the worktree still has no database).
		let seedStoodDown = false;
		void prepareReadiness({
			cwd: ctx.cwd,
			env: process.env,
			reason: reason as SessionStartReason,
			isProjectRoot: isWorkspaceProjectRoot,
			run: runCodegraph,
			seed: async (workspace) => {
				const seeded = await seedWorktreeIndex({ cwd: workspace, run: runCodegraphSeedSync });
				if (seeded.outcome === "main-busy") seedStoodDown = true;
				return seeded;
			},
			// The seam is the ready event source: every warm outcome the session can see — freshly
			// warmed, adopted winner, probe-verified live daemon, wedged, failed — is announced here
			// exactly once, on the same hasUI-gated channel.
			warm: async (workspace) => {
				const outcome = await warmUpDaemonDetailed(workspace);
				const notice = warmNotice(outcome, ctx.cwd);
				say(notice.text, notice.level);
				// A wedged daemon holds the lock and cannot serve, and a respawn would lose the lock to
				// the wedged holder — the CLI answers queries until the bypass expires.
				if (outcome.wedged) recordStartupDaemonSkip(workspace);
				return outcome.ok;
			},
			onStart: (action) => {
				// prepareReadiness reports only a planned action here: "none" returned before this
				// point, so the notice is mapped for the action that is about to run.
				if (action === "none") return;
				const notice = indexStartNotice(action);
				// onStart itself stays synchronous - it fires before the index dispatch runs, ahead of
				// the lock wait - but the say waits out the session_start notify window so the TUI
				// paints the line instead of a later extension's notify replacing it before the first
				// render. An index flow that already said something cancels the stale start line.
				const timer = setTimeout(() => {
					if (!said) say(notice.text, notice.level);
				}, START_NOTICE_DELAY_MS);
				timer.unref?.();
			},
			onIndexed: (result) => {
				const notice = indexedNotice({ ...result, stoodDown: seedStoodDown }, ctx.cwd);
				if (notice) say(notice.text, notice.level);
			},
			onWarmStart: () => say("warming up CodeGraph...", "info"),
		})
			.then((result) => {
				// The warm verdict's notices already left through the warm seam above; only an
				// unexpected mid-run exception reaches this tail unheard.
				if (result.error !== undefined) say(`CodeGraph readiness failed in ${ctx.cwd}: ${result.error}`, "warning");
			})
			.catch(() => {
				/* never surface: the session may already be gone */
			});
		// Direct MCP exposure: Pi defaults an MCP server's tools to codemode-only reach, so an
		// existing `codegraph` entry in the pi or Gentle Shell agent mcp.json gets
		// `"exposure": "direct"` once per process — only when the field is absent, never
		// overwriting an existing value, never creating an entry, and silent by contract.
		ensureExposureOnce();
	});
}
