import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodegraphEntry, type CodegraphEntry } from "../lib/codegraph-cli-resolve.ts";
import { exploreViaDaemon, MAX_REPLY_CHARS, type DaemonCallResult } from "../lib/codegraph-daemon.ts";
import { acquireInitLock, type InitLockOutcome } from "../lib/codegraph-lease.ts";
import { seedWorktreeIndex } from "../lib/codegraph-seed.ts";
import { CHILD_ENV, firstLineOf, indexState, maybeRewarm, prepareReadiness, runCodegraph, runCodegraphSeedSync, syncBeforeSearch, warmUpDaemon, type SearchSyncInput, type SessionStartReason } from "../lib/codegraph-readiness.ts";
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

function resolveWorkspaceCwd(cwd: string, gitRun: GitRun = defaultGitRun): string {
	const resolved = realpathSync(cwd);
	if (!lstatSync(resolved).isDirectory()) {
		throw new Error("CodeGraph can run only in the current workspace directory.");
	}
	if (resolved === homeForGuard() || resolved === tmpForGuard()) {
		throw new Error("CodeGraph requires a real Git project root equal to the current workspace, not HOME or a temporary directory.");
	}
	if (workspaceVerified.has(resolved)) return resolved;
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
export function indexExists(cwd: string): boolean {
	return indexState(cwd) === "present";
}

/**
 * The git toplevel above a cwd, or undefined outside a repository or on any git error. The bash
 * re-index guard keys on this root, so a session sitting in a subdirectory of an indexed repo
 * still cannot rebuild (and kill) the shared daemon's index at the root. Never throws: the
 * guard stays total — any failure allows the call.
 */
function gitTopLevel(cwd: string, gitRun: GitRun = defaultGitRun): string | undefined {
	try {
		const root = realpathSync(gitRun(["rev-parse", "--show-toplevel"], cwd));
		return lstatSync(root).isDirectory() ? root : undefined;
	} catch {
		return undefined;
	}
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

/**
 * The executable commands of a shell command list: an unquoted `&&`, `||`, `|`, `;`, `&`, or
 * newline ends one command and starts the next, while quotes keep a separator as content — an
 * `echo "codegraph index ."` argument is not a second command. A backslash escapes the next
 * character outside single quotes, so an escaped quote never opens or closes a quoted section
 * (`echo \" ; codegraph index .` is two commands, the second a rebuild).
 * A backslash-newline pair is different: the shell removes it as a line continuation, so it is dropped here instead of escaping the newline.
 */
function shellCommandList(command: string): string[] {
	const commands: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		// A backslash outside single quotes makes the next character literal, so an escaped
		// quote is content, never a quote toggle; inside single quotes it is literal itself.
		// A backslash-newline pair, by contrast, is a line continuation the shell removes
		// before parsing, so the scanner drops it too: a continued rebuild is still the rebuild,
		// never a command hidden behind its own backslash.
		if (escaped) {
			if (char !== "\n") {
				current += "\\";
				current += char;
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
			continue;
		}
		if (char === "\n" || char === ";" || char === "&" || char === "|") {
			commands.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	commands.push(current);
	return commands.filter((part) => part.trim().length > 0);
}

/**
 * The `codegraph index`/`codegraph init` commands of a shell command list — full re-indexes that
 * kill the shared daemon and rebuild the index — each carrying the leading-assignments parse of
 * its own command, so the in-command override is recognized on the rebuild command itself and
 * not on an unrelated earlier command. Every executable command is inspected, not only the
 * first: `cd . && codegraph index .` rebuilds as surely as a bare `codegraph index .`. The word
 * boundary keeps every other subcommand (`codegraph indexer`, `sync`, `query`, `unlock`,
 * `status`) out.
 */
function codegraphIndexCommands(command: string): { allowIndexOverride: boolean }[] {
	return shellCommandList(command)
		.map((part) => leadingAssignments(part))
		.filter((parsed) => /^codegraph\s+(index|init)\b/.test(parsed.rest));
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
let codegraphEntryResolver: () => CodegraphEntry | null = resolveCodegraphEntry;

/** Test seam for the win32 ENOENT fallback: arms the resolver its failures consult and returns
 * the restore. Exercised only by the test suite; not part of the tool's runtime surface. */
export function armCodegraphEntryResolverForTest(resolver: () => CodegraphEntry | null): () => void {
	const previous = codegraphEntryResolver;
	codegraphEntryResolver = resolver;
	return () => {
		codegraphEntryResolver = previous;
	};
}

const runCodeGraphCommand: CodeGraphRunner = async (args, options) => {
	const runOptions = {
		cwd: options.cwd,
		signal: options.signal,
		maxBuffer: options.maxBuffer,
		windowsHide: true,
	};
	let unavailableError: unknown;

	try {
		const result = await execFileAsync("codegraph", [...args], runOptions);
		return { stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		// Windows npm installs only shims (codegraph.cmd/.ps1 and a shell script)
		// with no codegraph.exe, so plain execFile (CreateProcess, no shell)
		// always fails with ENOENT even when the shim is on PATH.
		if (process.platform !== "win32" || !isEnoent(error)) throw error;
		unavailableError = error;
	}

	// T1's process-lifetime resolution (S3/S11): one provable npm cmd-shim on PATH answers every
	// failure after the first with a direct node spawn — no PATH rescan per ENOENT. POSIX never
	// reaches this point, and a null resolution (no shim, unknown shape, vanished target) keeps
	// the per-call package scan below exactly as before.
	const entry = codegraphEntryResolver();
	if (entry !== null) {
		try {
			const result = await execFileAsync(entry.node, [entry.script, ...args], runOptions);
			return { stdout: result.stdout, stderr: result.stderr };
		} catch (innerError) {
			if (!isEnoent(innerError)) throw innerError;
		}
	}

	// Resolve the real package script from each npm global bin directory in PATH
	// order and run it through the current Node executable. This remains
	// shell-free, so argument boundaries are never interpreted by a shell.
	for (const script of codeGraphNodeScriptsOnPath()) {
		try {
			const result = await execFileAsync(process.execPath, [script, ...args], runOptions);
			return { stdout: result.stdout, stderr: result.stderr };
		} catch (innerError) {
			if (!isEnoent(innerError)) throw innerError;
		}
	}

	throw unavailableError;
};

/** How long the daemon attempt may take before the CLI fallback takes over. */
const DAEMON_ATTEMPT_TIMEOUT_MS = 30_000;

/** One daemon query attempt: undefined or a miss means "use the CLI path". */
export type DaemonExplore = (cwd: string, parameters: CodeGraphToolParameters, timeoutMs: number) => Promise<DaemonCallResult | undefined>;

/** The daemon speaks the same tool names as the CLI: query and explore, with their natural arguments. */
async function queryViaDaemon(cwd: string, parameters: CodeGraphToolParameters, timeoutMs: number): Promise<DaemonCallResult | undefined> {
	try {
		const query = requireQuery(parameters.query);
		const limit = resolveLimit(parameters.limit);
		return parameters.operation === CODEGRAPH_OPERATION.QUERY
			? await exploreViaDaemon(cwd, "codegraph_query", { query, limit }, timeoutMs)
			: await exploreViaDaemon(cwd, "codegraph_explore", { query, maxFiles: limit }, timeoutMs);
	} catch {
		return undefined;
	}
}

/** The cwds whose daemon was wedged this prompt (the post-warm attempt timed out): the CLI answers directly until the next prompt. */
const daemonSkipUntil = new Map<string, number>();

/** How long a wedged daemon is bypassed after its post-warm attempt times out. */
const DAEMON_SKIP_MS = 60_000;

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
	daemonSkipUntil.clear();
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
	const job = (async (): Promise<void> => {
		await syncBeforeSearch({
			cwd,
			registryDir: opts?.registryDir,
			sleep: opts?.sleep,
			run,
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
			// Only a refresh that settled with no reported failure buys freshness; a failure never
			// does, and it clears any older mark so the very next search refreshes again.
			if (failed) syncFreshAt.delete(cwd);
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
		daemonExplore = queryViaDaemon,
		// The win32 query path never awaits its warm-up (S9), so there it runs backgrounded — an
		// unref'ed warm-up cannot keep the session alive; POSIX keeps the foreground warm.
		warm = (project: string, timeoutMs: number) => warmUpDaemon(project, process.platform === "win32", timeoutMs),
		rewarm = (project: string) => maybeRewarm(project),
		syncRun = runCodegraph,
		gitRun = defaultGitRun,
		initLock = acquireInitLock,
	}: {
		queryTimeoutMs?: number;
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
				const attempt = () => daemonExplore(cwd, parameters, Math.min(queryTimeoutMs, DAEMON_ATTEMPT_TIMEOUT_MS));
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
							// background=true on win32, so it never keeps this process alive — and this query
							// falls through to the CLI at once, with no second daemon attempt even after a fast
							// warm failure. The DAEMON_SKIP_MS bypass below still spans the warm-up, so a
							// background warm that revives the daemon is picked up at the next window.
							void warm(cwd, DAEMON_ATTEMPT_TIMEOUT_MS).catch(() => { /* best effort */ });
						} else {
							// Best-effort warm-up between the two attempts: a daemon that was never started gets one.
							await raceWithAbort(signal, warm(cwd, DAEMON_ATTEMPT_TIMEOUT_MS).catch(() => { /* best effort */ }));
							if (!signal?.aborted) viaDaemon = await raceWithAbort(signal, attempt()) ?? undefined;
						}
					}
					if (viaDaemon?.status === "timeout" || viaDaemon?.status === "unavailable") {
						// The post-warm attempt still cannot serve — wedged (timeout) or refusing (unavailable,
						// e.g. no project loaded): the CLI answers until the next turn instead of re-paying
						// attempt+warm+attempt on every query.
						daemonSkipUntil.set(cwd, Date.now() + DAEMON_SKIP_MS);
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
				// Re-checked under the acquired lock: the other initializer may have finished AND
				// released while this call waited, so acquisition succeeds with the database already
				// in place — the free-lease branch is not a completion proof. Rebuilding here would
				// kill the shared daemon that finished init just serves, so the holder stands down.
				// "absent" is the only state this init still serves: "present" and "unknown" both stand
				// down — an unreadable .codegraph is never rebuilt on a guess — and the override stays
				// the one deliberate path through.
				if (indexState(cwd) !== "absent" && process.env.GENTLE_CODEGRAPH_ALLOW_INDEX !== "1") {
					return fail(new Error(CODEGRAPH_INDEX_BLOCK_REASON), { reason: CODEGRAPH_INDEX_BLOCK_REASON });
				}
				const result = await runner(args, { cwd, signal, maxBuffer: PROCESS_MAX_BUFFER });
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
			const rebuilds = codegraphIndexCommands(command);
			if (rebuilds.length === 0) return undefined;
			const repoRoot = gitTopLevel(ctx.cwd);
			if (repoRoot === undefined || !indexExists(repoRoot) || process.env.GENTLE_CODEGRAPH_ALLOW_INDEX === "1") return undefined;
			// The override must ride EVERY rebuild command: one authorized rebuild never
			// authorizes the rest of the list (`=1 codegraph index .; codegraph init`).
			if (rebuilds.every((rebuild) => rebuild.allowIndexOverride)) return undefined;
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
		const say = (text: string, level: "info" | "warning") => {
			if (ctx.hasUI) ctx.ui.notify(text, level);
		};
		void prepareReadiness({
			cwd: ctx.cwd,
			env: process.env,
			reason: reason as SessionStartReason,
			isProjectRoot: isWorkspaceProjectRoot,
			run: runCodegraph,
			seed: (workspace) => seedWorktreeIndex({ cwd: workspace, run: runCodegraphSeedSync }),
			warm: (workspace) => warmUpDaemon(workspace),
			onStart: (action) => say(
				action === "sync"
					? "syncing the CodeGraph index..."
					: "creating the CodeGraph index of this project...",
				"info",
			),
			onIndexed: (result) => {
				if (result.ok) {
					say(result.action === "sync" ? "CodeGraph index synced" : "CodeGraph index created", "info");
					return;
				}
				if (result.action === "sync") {
					const notice = codegraphSyncFailureNotice(ctx.cwd, "sync", result);
					say(notice.text, notice.level);
					return;
				}
				say(`codegraph ${result.action} failed in ${ctx.cwd}`, "warning");
			},
			onWarmStart: () => say("warming up CodeGraph...", "info"),
		})
			.then((result) => {
				if (result.warm === "ok") say("CodeGraph ready", "info");
				else if (result.warm === "failed") say(`CodeGraph warm-up failed in ${ctx.cwd}`, "warning");
				else if (result.error !== undefined) say(`CodeGraph readiness failed in ${ctx.cwd}: ${result.error}`, "warning");
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
