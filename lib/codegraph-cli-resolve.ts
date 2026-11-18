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

/** The quoted spans of one shim line: `"%_prog%"  "%dp0%\...\cli.js" %*` holds two. */
function quotedSpans(line: string): string[] {
	const spans: string[] = [];
	for (const match of line.matchAll(/"([^"\r\n]*)"/g)) spans.push(match[1]);
	return spans;
}

/**
 * Parses one npm cmd-shim's text into its direct-spawn target. Every npm-generated codegraph.cmd
 * since npm 5.6 shares the shape the resolution accepts: a `SET dp0=%~dp0` mechanism that expands
 * `%dp0%` to the shim's own directory, an `IF EXIST "%dp0%\node.exe"` selection that runs a node
 * beside the shim when present and the bare `node` otherwise (`%_prog%`), and exactly one
 * invocation line forwarding `%*` to `"%_prog%"` with exactly one quoted `%dp0%`-anchored script.
 * The parse mirrors that logic literally; anything else — pnpm-style shims, hand-written
 * wrappers, a `..`-traversal or missing target, an unstable relative spelling — is unprovable and
 * returns null, so the caller keeps spawning the shim through cmd.exe exactly as before.
 */
function parseCmdShim(text: string, shimDir: string, exists: (path: string) => boolean): CodegraphEntry | null {
	if (!text.includes("SET dp0=%~dp0")) return null;
	if (!text.includes('IF EXIST "%dp0%' + BS + 'node.exe"')) return null;
	// Exactly one invocation line may exist, and it must carry exactly one %dp0%-anchored script:
	// zero (an absolute or %~dp0% script), two, or a second invocation line are all shapes the
	// direct spawn cannot prove it reproduces.
	let scriptSpan: string | undefined;
	let invocationLines = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.includes('"%_prog%"') || !line.includes("%*")) continue;
		invocationLines += 1;
		const dp0Spans = quotedSpans(line).filter((span) => span.startsWith("%dp0%"));
		if (dp0Spans.length === 1) scriptSpan = dp0Spans[0];
	}
	if (invocationLines !== 1 || scriptSpan === undefined) return null;
	const script = shimDir + scriptSpan.slice("%dp0%".length);
	if (!isCwdIndependentPath(script) || !exists(script)) return null;
	// The same IF EXIST the shim runs: node.exe beside the shim wins, else the bare node, whose
	// PATH search the spawn itself performs.
	const nodeBesideShim = shimDir + BS + "node.exe";
	return { node: exists(nodeBesideShim) ? nodeBesideShim : "node", script };
}

/** The resolution proper: win32-only, first codegraph.cmd on PATH, verified or null. Never throws. */
function resolveCodegraphEntryWith(io: ResolveCodegraphIo): CodegraphEntry | null {
	if (io.platform() !== "win32") return null;
	const entries = (io.pathEnv() ?? "").split(";");
	for (const entry of entries) {
		const dir = stripPathEntry(entry);
		if (dir.length === 0) continue;
		const shimDir = withoutTrailingSeparator(dir);
		const shimPath = shimDir + BS + SHIM_NAME;
		// cmd.exe runs the FIRST codegraph.cmd on PATH, never a later one, so the scan stops at
		// the first hit: an unprovable first shim is a null resolution (the caller falls back to
		// the cmd.exe string) rather than a silent divergence to a different installation.
		if (!io.exists(shimPath)) continue;
		try {
			return parseCmdShim(io.read(shimPath), shimDir, io.exists);
		} catch {
			return null;
		}
	}
	return null;
}

/** The process-lifetime memo: undefined means "not resolved yet", null means "resolved to nothing". */
let cached: CodegraphEntry | null | undefined;

/**
 * Resolves the `codegraph` npm cmd-shim to a direct-spawn target, once per process: on win32 the
 * first `codegraph.cmd` on PATH is parsed to the node executable and JS entrypoint it invokes,
 * verified to exist; every other platform (and every unprovable shim) returns null. Callers treat
 * null as "keep the cmd.exe string spawn" — the resolution can only ever remove spawns, never
 * change which codegraph installation runs. The memo holds for the whole process and covers null
 * alike, so a PATH or shim that changes mid-run cannot produce two different answers.
 */
export function resolveCodegraphEntry(io: ResolveCodegraphIo = defaultIo): CodegraphEntry | null {
	if (cached !== undefined) return cached;
	try {
		cached = resolveCodegraphEntryWith(io);
	} catch {
		cached = null;
	}
	return cached;
}

/** Drops the process-lifetime memo; the next resolution re-reads the platform, PATH, and shim. */
export function clearCodegraphResolveCache(): void {
	cached = undefined;
}
