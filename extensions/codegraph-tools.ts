import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exploreViaDaemon, type DaemonCallResult } from "../lib/codegraph-daemon.ts";
import { seedWorktreeIndex } from "../lib/codegraph-seed.ts";
import { CHILD_ENV, maybeRewarm, prepareReadiness, runCodegraph, syncBeforeSearch, warmUpDaemon, type SearchSyncInput, type SessionStartReason } from "../lib/codegraph-readiness.ts";

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
const PROCESS_MAX_BUFFER = MAX_OUTPUT_CHARS * 2;
const FALLBACK_INSTRUCTIONS = "Use read, grep, and find for this exploration.";
// each daemon query attempt is bounded, so a hung daemon on a slow filesystem (for example a
// WSL /mnt mount) cannot block the turn indefinitely (#1901); init is the legitimately slow
// first index, so only the user's signal bounds it.
const CODEGRAPH_QUERY_TIMEOUT_MS = 180_000;
const execFileAsync = promisify(execFile);
const GIT_ROOT_REQUIRED = "CodeGraph requires a real Git project root equal to the current workspace.";
const GIT_DIAGNOSTIC_MAX_CHARS = 1_000;

/**
 * Compare two directories by file identity, not path spelling. On Windows a mapped
 * drive (`X:\repo`) and the UNC path Git reports for it (`\\server\share\repo`) name
 * the same directory but never compare equal as strings (#2558).
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

function resolveWorkspaceCwd(cwd: string): string {
	const resolved = realpathSync(cwd);
	if (!lstatSync(resolved).isDirectory()) {
		throw new Error("CodeGraph can run only in the current workspace directory.");
	}
	if (resolved === realpathSync(homedir()) || resolved === realpathSync(tmpdir())) {
		throw new Error("CodeGraph requires a real Git project root equal to the current workspace, not HOME or a temporary directory.");
	}
	try {
		const root = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: resolved,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		}).trim());
		if (!isSameDirectory(root, resolved)) {
			throw gitRootRequiredError(resolved, "git toplevel", root);
		}
		return resolved;
	} catch (error) {
		if (error instanceof Error && /real Git project root/.test(error.message)) throw error;
		throw gitRootRequiredError(resolved, "git", gitFailureDetail(error));
	}
}

function assertSafeIndexDirectory(cwd: string): void {
	try {
		const index = lstatSync(join(cwd, ".codegraph"));
		if (index.isSymbolicLink() || !index.isDirectory()) {
			throw new Error("CodeGraph .codegraph must be a real directory when it already exists.");
		}
	} catch (error: unknown) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

/**
 * An index is the database file, not merely the directory: a .codegraph/ left behind by a
 * partial init or a killed reindex is not a usable index. Any error, including EACCES,
 * counts as unconfirmed, so gates on this never fire on an unknown state.
 */
export function indexExists(cwd: string): boolean {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile();
	} catch {
		return false;
	}
}

/** A full re-index from bash is blocked when an index already exists; this is the reason it gets. */
const CODEGRAPH_INDEX_BLOCK_REASON = "CodeGraph: an index already exists for this workspace. Re-indexing kills the shared daemon and rebuilds it; the runtime refreshes with sync (before the first search of each prompt). If you really need a full rebuild, set GENTLE_CODEGRAPH_ALLOW_INDEX=1.";

/**
 * Whether a shell command, past its leading whitespace and env-var assignments, starts with
 * `codegraph index` or `codegraph init` — a full re-index that kills the shared daemon and
 * rebuilds the index. The word boundary keeps every other subcommand (`codegraph indexer`,
 * `sync`, `query`, `unlock`, `status`) allowed.
 */
function isCodegraphIndexCommand(command: string): boolean {
	let rest = command.trimStart();
	// Leading `FOO=1 BAR=2` assignments are shell syntax, not the command itself.
	const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
	while (assignment.test(rest)) rest = rest.replace(assignment, "");
	return /^codegraph\s+(index|init)\b/.test(rest);
}

function gitOutput(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	}).trim();
}

// CodeGraph writes .codegraph/.gitignore with `*` and `!.gitignore`, so that file
// stays untracked and enters every diff. Keep the whole index out of git through
// the worktree's local exclude file; tracked files and .gitignore are never edited.
const LOCAL_EXCLUDE_PATTERN = ".codegraph/";
const EQUIVALENT_EXCLUDE_PATTERNS = new Set([".codegraph", ".codegraph/", "/.codegraph", "/.codegraph/"]);

function excludeIndexLocally(cwd: string): CodeGraphLocalExclude | undefined {
	let path: string | undefined;
	try {
		if (gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
		// --git-path resolves the exclude file a linked worktree actually reads.
		path = resolve(cwd, gitOutput(cwd, ["rev-parse", "--git-path", "info/exclude"]));
		const current = existsSync(path) ? readFileSync(path, "utf8") : "";
		mkdirSync(dirname(path), { recursive: true });
		path = join(realpathSync(dirname(path)), basename(path));
		if (current.split(/\r?\n/).some((line) => EQUIVALENT_EXCLUDE_PATTERNS.has(line.trim()))) {
			return { status: "present", path };
		}
		const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
		appendFileSync(path, `${separator}${LOCAL_EXCLUDE_PATTERN}\n`);
		return { status: "added", path };
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
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
	switch (parameters.operation) {
		case CODEGRAPH_OPERATION.INIT:
			return [CODEGRAPH_OPERATION.INIT, cwd];
		case CODEGRAPH_OPERATION.QUERY: {
			const query = requireQuery(parameters.query);
			return [
				CODEGRAPH_OPERATION.QUERY,
				"--path",
				cwd,
				"--limit",
				String(resolveLimit(parameters.limit)),
				"--",
				query,
			];
		}
		case CODEGRAPH_OPERATION.EXPLORE: {
			const query = requireQuery(parameters.query);
			return [
				CODEGRAPH_OPERATION.EXPLORE,
				"--path",
				cwd,
				"--max-files",
				String(resolveLimit(parameters.limit)),
				"--",
				query,
			];
		}
	}
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
	const status =
		typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
			? CODEGRAPH_STATUS.UNAVAILABLE
			: CODEGRAPH_STATUS.FAILED;
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

/** Resolve the first valid CodeGraph npm entry point in Windows PATH order. */
export function findCodeGraphNodeScriptOnPath(): string | undefined {
	return codeGraphNodeScriptsOnPath().next().value;
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

/** The cwds whose index this turn's first search already refreshed in the background. */
const searchSynced = new Set<string>();

/** A new user prompt starts a new turn: its first search refreshes the index again. */
export function clearSearchSync(): void {
	searchSynced.clear();
}

/**
 * Fires the per-turn unlock+sync for `cwd` in the background and returns whether a job was
 * started: a subagent child or a cwd already refreshed this turn never starts one, so the first
 * search of a turn is neither blocked nor duplicated.
 */
export function triggerSearchSync(cwd: string, ctx: ExtensionContext, run: SearchSyncInput["run"] = runCodegraph): boolean {
	if (process.env[CHILD_ENV] === "1" || searchSynced.has(cwd)) return false;
	searchSynced.add(cwd);
	syncBeforeSearch({
		cwd,
		run,
		onFailed: (stage) => {
			if (ctx.hasUI) ctx.ui.notify(`codegraph ${stage} failed in ${cwd}`, "warning");
		},
	});
	return true;
}

export function createCodeGraphTool(
	runner: CodeGraphRunner = runCodeGraphCommand,
	{
		queryTimeoutMs = CODEGRAPH_QUERY_TIMEOUT_MS,
		daemonExplore = queryViaDaemon,
		warm = (project: string, timeoutMs: number) => warmUpDaemon(project, false, timeoutMs),
		syncRun = runCodegraph,
	}: {
		queryTimeoutMs?: number;
		daemonExplore?: DaemonExplore;
		/** Warms the daemon between the two query attempts; the default never rejects. */
		warm?: (cwd: string, timeoutMs: number) => Promise<boolean>;
		/** Runs the per-turn unlock+sync fired before the first search; injected in tests. */
		syncRun?: SearchSyncInput["run"];
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
		): Promise<{ content: { type: "text"; text: string }[]; details: { operation: CodeGraphOperation; cwd: string; args: string[]; localExclude?: CodeGraphLocalExclude; viaDaemon?: boolean; syncTriggered?: boolean } | CodeGraphFallbackDetails }> {
			const cwd = resolveWorkspaceCwd(ctx.cwd);
			assertSafeIndexDirectory(cwd);
			const args = commandArguments(parameters, cwd);
			// MCP-only query path: query and explore always go through the daemon socket (roughly 75 ms
			// local against ~590 ms, 0.5-2 s on a network share against 2.5-6 s for a CLI process),
			// so a search never spawns a CLI process of its own.
			if (parameters.operation !== CODEGRAPH_OPERATION.INIT) {
				// Lazy re-warm: if the project's daemon died mid-session, warm it in the background so the
				// next query is fast again. Never blocks this call.
				maybeRewarm(cwd);
				// One background unlock+sync per turn before the first search keeps the index fresh;
				// the search never waits for it.
				const syncTriggered = triggerSearchSync(cwd, ctx, syncRun);
				const attempt = () => daemonExplore(cwd, parameters, Math.min(queryTimeoutMs, DAEMON_ATTEMPT_TIMEOUT_MS));
				let viaDaemon = await attempt();
				if (viaDaemon?.status !== "ok") {
					// Best-effort warm-up between the two attempts: a daemon that was never started gets one.
					await warm(cwd, DAEMON_ATTEMPT_TIMEOUT_MS).catch(() => { /* best effort */ });
					viaDaemon = await attempt();
				}
				const syncDetails = syncTriggered ? { syncTriggered: true } : {};
				if (viaDaemon?.status === "ok") {
					const output = truncateOutput(viaDaemon.text);
					const localExclude = indexExists(cwd) ? excludeIndexLocally(cwd) : undefined;
					return {
						content: [{ type: "text" as const, text: withLocalExcludeNote(output || "CodeGraph completed without output.", localExclude) }],
						details: { operation: parameters.operation, cwd, args, viaDaemon: true, ...syncDetails, ...(localExclude ? { localExclude } : {}) },
					};
				}
				// Still no daemon: the search still runs — one CLI process as the last resort. The daemon
				// stays the only path while it answers; when it cannot serve (never started, died, hung, or
				// has no project loaded), a slower correct answer beats the read/grep/find dead end.
				try {
					const result = await runner(args, { cwd, signal, maxBuffer: PROCESS_MAX_BUFFER });
					const output = truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
					const localExclude = indexExists(cwd) ? excludeIndexLocally(cwd) : undefined;
					return {
						content: [{ type: "text" as const, text: withLocalExcludeNote(output || "CodeGraph completed without output.", localExclude) }],
						details: { operation: parameters.operation, cwd, args, viaDaemon: false, ...syncDetails, ...(localExclude ? { localExclude } : {}) },
					};
				} catch (error: unknown) {
					const details = codeGraphFailureDetails(error, parameters.operation, cwd);
					const localExclude = indexExists(cwd) ? excludeIndexLocally(cwd) : undefined;
					if (localExclude) details.localExclude = localExclude;
					return {
						content: [{ type: "text" as const, text: withLocalExcludeNote(codeGraphFailureMessage(details.status), localExclude) }],
						details: { ...details, ...syncDetails },
					};
				}
			}
			// init keeps its CLI path: it is the legitimately slow first index, bounded only by the user's signal.
			try {
				const result = await runner(args, { cwd, signal, maxBuffer: PROCESS_MAX_BUFFER });
				const output = truncateOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
				const localExclude = parameters.operation === CODEGRAPH_OPERATION.INIT || indexExists(cwd)
					? excludeIndexLocally(cwd)
					: undefined;
				return {
					content: [{ type: "text" as const, text: withLocalExcludeNote(output || "CodeGraph completed without output.", localExclude) }],
					details: { operation: parameters.operation, cwd, args, ...(localExclude ? { localExclude } : {}) },
				};
			} catch (error: unknown) {
				const details = codeGraphFailureDetails(error, parameters.operation, cwd);
				// A failed init can still leave a partial index behind.
				const localExclude = indexExists(cwd) ? excludeIndexLocally(cwd) : undefined;
				if (localExclude) details.localExclude = localExclude;
				return {
					content: [{ type: "text" as const, text: withLocalExcludeNote(codeGraphFailureMessage(details.status), localExclude) }],
					details,
				};
			}
		},
	};
}

export function registerCodeGraphTool(pi: ExtensionAPI): void {
	pi.registerTool(createCodeGraphTool());
}

export default function codeGraphTools(pi: ExtensionAPI): void {
	registerCodeGraphTool(pi);
	// One background unlock+sync per user prompt: the first search of every turn fires it.
	pi.on?.("turn_start", () => clearSearchSync());
	// `codegraph index`/`codegraph init` from bash rebuilds the index from scratch and kills the
	// daemon every session shares (a full rebuild once took the daemon down), while the runtime
	// already refreshes the index with sync before the first search of each prompt. When an index
	// already exists the rebuild is blocked — "if an index exists, do not re-index — only sync" —
	// and GENTLE_CODEGRAPH_ALLOW_INDEX=1 is the explicit override. The guard is total: any
	// internal error allows the call, so a broken guard can never break bash.
	pi.on?.("tool_call", (event, ctx) => {
		try {
			if (event.toolName !== "bash" && event.toolName !== "bash_background") return undefined;
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string" || !isCodegraphIndexCommand(command)) return undefined;
			if (!indexExists(ctx.cwd) || process.env.GENTLE_CODEGRAPH_ALLOW_INDEX === "1") return undefined;
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
			isProjectRoot: (workspace) => {
				try {
					return resolveWorkspaceCwd(workspace) === workspace;
				} catch {
					return false;
				}
			},
			run: runCodegraph,
			seed: (workspace) => seedWorktreeIndex({ cwd: workspace, run: runCodegraph }),
			warm: (workspace) => warmUpDaemon(workspace),
			onStart: (action) => say(
				action === "sync"
					? "syncing the CodeGraph index..."
					: "creating the CodeGraph index of this project...",
				"info",
			),
			onIndexed: (result) => {
				if (!result.ok) say(`codegraph ${result.action} failed in ${ctx.cwd}`, "warning");
				else say(result.action === "sync" ? "CodeGraph index synced" : "CodeGraph index created", "info");
			},
			onWarmStart: () => say("warming up CodeGraph...", "info"),
		})
			.then((result) => {
				if (result.warm === "ok") say("CodeGraph ready", "info");
				else if (result.warm === "failed") say(`CodeGraph warm-up failed in ${ctx.cwd}`, "warning");
			})
			.catch(() => {
				/* never surface: the session may already be gone */
			});
	});
}
