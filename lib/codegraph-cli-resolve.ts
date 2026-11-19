import { existsSync, readFileSync } from "node:fs";

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** The npm cmd-shim file the resolver targets: exactly the file cmd.exe finds for bare `codegraph`. */
const SHIM_NAME = "codegraph.cmd";

/** The direct-spawn target of a resolved npm cmd-shim. */
export interface CodegraphEntry {
	/** The node executable to run: `%dp0%\node.exe` beside the shim when one exists, else the bare "node". */
	node: string;
	/** The JS entrypoint the shim invokes, in the shim's own `%dp0%`-substituted spelling. */
	script: string;
}

/** What the resolution proved about the first `codegraph.cmd` cmd.exe would run: a proven
 * direct-spawn entry; a first shim that exists but cannot be proven (rejected — its
 * invocation carries something a direct spawn cannot reproduce, so a consumer must keep the
 * shim's own spawn and never substitute another target for it); or no shim on PATH at all
 * (miss). */
export type CodegraphShimResolution =
	| { status: "entry"; entry: CodegraphEntry }
	| { status: "rejected" }
	| { status: "miss" };

/** The process view the resolution needs; injectable so tests resolve off a Windows host. */
export interface ResolveCodegraphIo {
	/** The platform: only "win32" resolves, anything else returns null before PATH is touched. */
	platform(): NodeJS.Platform;
	/** The PATH variable (either Windows spelling); split on ";" with cmd.exe's tolerance. */
	pathEnv(): string | undefined;
	/** Whether a path exists; every existence question the resolution asks goes through here. */
	exists(path: string): boolean;
	/** The shim file's text; may throw when unreadable, which the resolution treats as unprovable. */
	read(path: string): string;
}

const defaultIo: ResolveCodegraphIo = {
	platform: () => process.platform,
	pathEnv: () => process.env.Path ?? process.env.PATH,
	exists: (path) => existsSync(path),
	read: (path) => readFileSync(path, "utf8"),
};

/** One PATH entry with cmd.exe's tolerance: surrounding whitespace and one pair of quotes off. */
function stripPathEntry(entry: string): string {
	const trimmed = entry.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
	return trimmed;
}

/** A directory spelling with its trailing separator off, so substitution cannot double it. A
 * bare drive root (`C:\`) keeps its separator: the separator IS the path. */
function withoutTrailingSeparator(dir: string): string {
	if (dir.length === 3 && dir.charCodeAt(1) === 58) return dir; // C:\
	while (dir.length > 1 && (dir.endsWith(BS) || dir.endsWith("/")) && !(dir.length === 3 && dir.charCodeAt(1) === 58)) {
		dir = dir.slice(0, -1);
	}
	return dir;
}

/** Whether a Windows path is its own target regardless of any process's cwd: drive-anchored
 * (`C:\proj`) or UNC (`\\server\share\proj`). A rooted-but-drive-relative path (`\proj`) and
 * every relative spelling resolve against whatever cwd the child gets, so they are not stable. */
function isCwdIndependentPath(path: string): boolean {
	if (path.startsWith(BS + BS) || path.startsWith("//")) return true;
	return path.length >= 3 && path.charAt(1) === ":" && (path.charAt(2) === BS || path.charAt(2) === "/");
}

/** The exact prefix npm 9+ cmd-shims put on the invocation line before "%_prog%"; older npm
 * ships the same invocation without it. */
const MODERN_INVOCATION_PREFIX = "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% |";

/** The one invocation shape a direct spawn reproduces, parsed token by token: npm's modern
 * prefix (optional), "%_prog%", exactly one quoted "%dp0%"-anchored script span, then the
 * forwarding %* and nothing else. A wrapper that inserts a fixed argument — a --profile flag
 * before or after the script — or any extra token returns undefined, so the caller keeps
 * spawning the shim through cmd.exe exactly as before. Whitespace between the tokens is free;
 * the tokens themselves are not. */
function parseInvocationLine(line: string): string | undefined {
	let rest = line.trim();
	if (rest.startsWith(MODERN_INVOCATION_PREFIX)) rest = rest.slice(MODERN_INVOCATION_PREFIX.length).trim();
	const progToken = '"%_prog%"';
	if (!rest.startsWith(progToken)) return undefined;
	rest = rest.slice(progToken.length).trim();
	const scriptOpen = '"%dp0%';
	if (!rest.startsWith(scriptOpen)) return undefined;
	const closeQuote = rest.indexOf('"', scriptOpen.length);
	if (closeQuote < 0) return undefined;
	const scriptSpan = rest.slice(1, closeQuote);
	rest = rest.slice(closeQuote + 1).trim();
	if (rest !== "%*" || scriptSpan.length === 0) return undefined;
	return scriptSpan;
}

/**
 * Parses one npm cmd-shim's text into its direct-spawn target. Every npm-generated codegraph.cmd
 * since npm 5.6 shares the shape the resolution accepts: a `SET dp0=%~dp0` mechanism that expands
 * `%dp0%` to the shim's own directory, an `IF EXIST "%dp0%\node.exe"` selection that runs a node
 * beside the shim when present and the bare `node` otherwise (`%_prog%`), and exactly one
 * invocation line forwarding `%*` to `"%_prog%"` with exactly one quoted `%dp0%`-anchored script.
 * The parse mirrors that logic literally, accepting only npm's own invocation tokens in order
 * — the modern `endLocal` prefix where npm ships it — with free whitespace between them;
 * anything else — pnpm-style shims, hand-written wrappers, a fixed argument the spawn cannot
 * reproduce, a `..`-traversal or missing target, an unstable relative spelling — is unprovable
 * and returns null, so the caller keeps spawning the shim through cmd.exe exactly as before.
 */
function parseCmdShim(text: string, shimDir: string, exists: (path: string) => boolean): CodegraphEntry | null {
	if (!text.includes("SET dp0=%~dp0")) return null;
	if (!text.includes('IF EXIST "%dp0%' + BS + 'node.exe"')) return null;
	// Exactly one invocation line may exist, and it must be the one supported shape token for
	// token: a second invocation line, a missing script, or a wrapper's fixed argument are all
	// shapes the direct spawn cannot prove it reproduces.
	let invocationLine: string | undefined;
	let invocationLines = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.includes('"%_prog%"') || !line.includes("%*")) continue;
		invocationLines += 1;
		invocationLine = line;
	}
	if (invocationLines !== 1 || invocationLine === undefined) return null;
	const scriptSpan = parseInvocationLine(invocationLine);
	if (scriptSpan === undefined) return null;
	const script = shimDir + scriptSpan.slice("%dp0%".length);
	if (!isCwdIndependentPath(script) || !exists(script)) return null;
	// The same IF EXIST the shim runs: node.exe beside the shim wins, else the bare node, whose
	// PATH search the spawn itself performs.
	const nodeBesideShim = shimDir + BS + "node.exe";
	return { node: exists(nodeBesideShim) ? nodeBesideShim : "node", script };
}

/** The resolution proper: win32-only, the first codegraph.cmd on PATH proven, rejected, or a
 * miss. Never throws. */
function resolveCodegraphEntryWith(io: ResolveCodegraphIo): CodegraphShimResolution {
	if (io.platform() !== "win32") return { status: "miss" };
	const entries = (io.pathEnv() ?? "").split(";");
	for (const entry of entries) {
		const dir = stripPathEntry(entry);
		if (dir.length === 0) continue;
		const shimDir = withoutTrailingSeparator(dir);
		const shimPath = shimDir + BS + SHIM_NAME;
		// cmd.exe runs the FIRST codegraph.cmd on PATH, never a later one, so the scan stops at
		// the first hit: an unprovable first shim is a REJECTED resolution (the caller keeps the
		// shim's own spawn) rather than a silent divergence to a different installation.
		if (!io.exists(shimPath)) continue;
		try {
			const parsed = parseCmdShim(io.read(shimPath), shimDir, io.exists);
			return parsed === null ? { status: "rejected" } : { status: "entry", entry: parsed };
		} catch {
			return { status: "rejected" };
		}
	}
	return { status: "miss" };
}

/** The process-lifetime memo: undefined means "not resolved yet"; anything else is the
 * memoized resolution, an entry, a rejection, or a miss alike. */
let cached: CodegraphShimResolution | undefined;

/**
 * Resolves what cmd.exe's first `codegraph.cmd` on PATH proves, once per process: a proven
 * shim's direct-spawn entry, a rejection when the first shim exists but cannot be proven, or
 * a miss when no shim is on PATH (and off win32). The memo holds for the whole process and
 * covers rejections and misses alike, so a PATH or shim that changes mid-run cannot produce
 * two different answers — with one exception: a memoized entry whose script has since
 * vanished is re-resolved, because serving it would start node on a removed entrypoint (a
 * module-load exit the caller cannot tell from a spawn ENOENT and so never retries around).
 */
export function resolveCodegraphShimState(io: ResolveCodegraphIo = defaultIo): CodegraphShimResolution {
	// A cached entry survives only while its entrypoint still exists; a rejection or miss has
	// nothing to revalidate and stays memoized.
	if (cached?.status === "entry" && !io.exists(cached.entry.script)) cached = undefined;
	if (cached !== undefined) return cached;
	try {
		cached = resolveCodegraphEntryWith(io);
	} catch {
		cached = { status: "miss" };
	}
	return cached;
}

/**
 * The entry projection of resolveCodegraphShimState: the proven direct-spawn target, or null.
 * Callers that only need "can I spawn directly" treat null as "keep the shim's cmd.exe spawn"; a caller
 * that must not substitute anything for the shim cmd.exe would run consults the state, whose
 * rejection says the first shim exists while its invocation stays unproven.
 */
export function resolveCodegraphEntry(io: ResolveCodegraphIo = defaultIo): CodegraphEntry | null {
	const state = resolveCodegraphShimState(io);
	return state.status === "entry" ? state.entry : null;
}

/** Drops the process-lifetime memo; the next resolution re-reads the platform, PATH, and shim. */
export function clearCodegraphResolveCache(): void {
	cached = undefined;
}
