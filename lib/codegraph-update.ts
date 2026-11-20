import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** The npm package the codegraph CLI ships as; every registry probe and update targets it. */
export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";

/** One bounded process run's captured outcome; a run that timed out or failed to spawn is ok:false. */
export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Runs one command with fixed arguments under a timeout; never throws. */
export type BoundedExec = (command: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/** The budget for `codegraph --version`, `which`/`where.exe`, and `npm prefix -g`: all local, fast probes. */
export const VERSION_TIMEOUT_MS = 15_000;
/** The budget for one registry lookup (`npm view`), which can be slow on a cold network. */
export const NPM_VIEW_TIMEOUT_MS = 15_000;
/** The budget for `bun add -g` / `npm install -g`: package downloads can take minutes. */
export const UPDATE_TIMEOUT_MS = 300_000;

/** Kept tail per stream: npm's install chatter can be megabytes and only the tail is ever reported. */
const MAX_STREAM_CHARS = 8_000;
/** How long a killed command may take to be gone before the result is reported anyway. */
const KILL_WAIT_MS = 10_000;
/** Grace a timed-out command gets to obey SIGTERM before the unignorable SIGKILL ends it. */
const KILL_ESCALATE_MS = 1_000;

/** Kills the command child: on Windows taskkill takes the whole tree (the shell:true wrapper's
 * pid is not the updater's real pid), on POSIX the undetached child is the command itself. */
function killChild(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (child?.pid === undefined) return;
	if (process.platform === "win32") {
		// The tree kill is async; the direct kill bounds the shell wrapper at once.
		child.kill();
		execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
			/* already gone: the kill-wait cap reports the timeout anyway */
		});
		return;
	}
	try {
		process.kill(child.pid, signal);
	} catch {
		/* already gone */
	}
}

/** Quotes one argument the way cmd.exe keeps it: backslashes exactly as written, embedded
 * quotes doubled, the whole part inside double quotes (the repo's buildWindowsCommand rule). */
function quoteForCmd(part: string): string {
	return `"${part.replaceAll("\"", "\"\"")}"`;
}

/**
 * The production BoundedExec: one spawn with piped stdio, decoded with one persistent decoder
 * per stream (a multibyte character split across Buffer chunks survives), each stream's tail
 * kept to MAX_STREAM_CHARS, and a timeout that kills the child (SIGTERM, escalating to SIGKILL
 * after a short grace, KILL_WAIT_MS the absolute cap) before the failed result is reported — a
 * pid never outlives its own result. On win32 a `.cmd` command is a batch shim Node refuses to
 * spawn without a shell, so its fixed argument vector becomes one cmd.exe-quoted command line
 * through shell:true (the repo's codegraph spawn pattern); every other command spawns as a
 * plain argument vector. Never throws: a refused spawn or an internal error is ok:false with
 * the reason in stderr.
 */
function runBounded(command: string, args: readonly string[], timeoutMs: number, shell: boolean): Promise<ExecResult> {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		let stdoutKept = "";
		let stderrKept = "";
		let child: ChildProcess | undefined;
		let escalate: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (escalate !== undefined) clearTimeout(escalate);
			resolve({ ok, stdout: stdoutKept, stderr: stderrKept });
		};
		let timer: ReturnType<typeof setTimeout>;
		try {
			child = shell
				? spawn(command, { windowsHide: true, shell: true, stdio: ["ignore", "pipe", "pipe"] })
				: spawn(command, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
			return;
		}
		const stdoutDecoder = new StringDecoder("utf8");
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutKept = (stdoutKept + stdoutDecoder.write(chunk)).slice(-MAX_STREAM_CHARS);
		});
		const stderrDecoder = new StringDecoder("utf8");
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrKept = (stderrKept + stderrDecoder.write(chunk)).slice(-MAX_STREAM_CHARS);
		});
		timer = setTimeout(() => {
			timedOut = true;
			killChild(child);
			escalate = setTimeout(() => {
				killChild(child, "SIGKILL");
				escalate = setTimeout(() => finish(false), KILL_WAIT_MS);
			}, KILL_ESCALATE_MS);
		}, timeoutMs);
		child.on("error", (error: Error) => {
			stderrKept = (stderrKept.length > 0 ? `${stderrKept}\n` : "") + error.message;
			finish(false);
		});
		child.on("close", (code: number | null) => {
			// A zero exit counts only when the deadline did not expire first.
			finish(!timedOut && code === 0);
		});
	});
}

/** The production BoundedExec: business code speaks platform-neutral commands; this runner
 * alone owns the win32 translations — npm's `.cmd` shim and the codegraph shim itself both run
 * through one cmd.exe-quoted line, because Node cannot spawn a `.cmd` without a shell on win32
 * (a plain "codegraph" spawn would ENOENT and the whole check would silently fail open). */
export const defaultExec: BoundedExec = (command, args, timeoutMs) => {
	if (process.platform === "win32" && (command === "codegraph" || command.toLowerCase().endsWith(".cmd"))) {
		return runBounded([command, ...args.map(quoteForCmd)].join(" "), [], timeoutMs, true);
	}
	return runBounded(command, args, timeoutMs, false);
};

/** The first dotted numeric triple in the text, or undefined when there is none. */
export function parseCodegraphVersion(stdout: string): string | undefined {
	return /\d+\.\d+\.\d+/.exec(stdout)?.[0];
}

/**
 * The version of the RUNNING codegraph binary: `codegraph --version`, first dotted triple of
 * its stdout ("1.6.4" and "codegraph 1.6.4" alike). A failed, timed-out, or unparseable probe
 * is undefined — the npm package manifest is never consulted as version truth (a thin 1.6.4
 * package was observed executing a 1.6.3 platform bundle).
 */
export async function installedCodegraphVersion(exec: BoundedExec = defaultExec): Promise<string | undefined> {
	const result = await exec("codegraph", ["--version"], VERSION_TIMEOUT_MS);
	if (!result.ok) return undefined;
	return parseCodegraphVersion(result.stdout);
}

/** The process-lifetime memo of the registry lookup: one npm view per process, successes only
 * (a failed lookup is retried by the next process, and the once-per-process update check makes
 * even that rare). */
let latestMemo: string | undefined;

/** The latest published version from the npm registry, cached for the process lifetime. Any
 * failure — offline registry, unparseable output — is undefined, and the caller's whole update
 * check skips (fail-open): a missing answer never blocks readiness or updates anything. */
export async function latestCodegraphVersion(exec: BoundedExec = defaultExec, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	if (latestMemo !== undefined) return latestMemo;
	const result = await exec(npmCommand(platform), ["view", CODEGRAPH_PACKAGE, "version"], NPM_VIEW_TIMEOUT_MS);
	if (!result.ok) return undefined;
	const version = parseCodegraphVersion(result.stdout.trim());
	if (version === undefined) return undefined;
	latestMemo = version;
	return version;
}

/** A version as a numeric major.minor.patch triple, or undefined when it carries none. */
function parseVersionTriple(version: string): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (match === null) return undefined;
	const triple = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
	return triple.every(Number.isInteger) ? [...triple] : undefined;
}

/** Whether `installed` differs from `latest` (numeric triples, field by field): anything but
 * an exact match — older OR newer — means the binary is not the latest version; the update
 * brings it back to latest. Either side unparseable or missing answers false: garbage never
 * updates. */
export function codegraphVersionDiffers(installed: string | undefined, latest: string | undefined): boolean {
	if (installed === undefined || latest === undefined) return false;
	const a = parseVersionTriple(installed);
	const b = parseVersionTriple(latest);
	if (a === undefined || b === undefined) return false;
	return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
}

/** How codegraph was installed, as far as the shim's own location proves it. */
export type CodegraphInstallSource = "bun-global" | "pnpm-global" | "npm-global" | "unknown";

/** One path spelled with one separator, case-folded on win32 only, no trailing separator. */
function normalizePathForCompare(path: string, platform: NodeJS.Platform): string {
	let normalized = platform === "win32" ? path.replaceAll("/", BS) : path;
	if (platform === "win32") normalized = normalized.toLowerCase();
	// A bare drive root ("C:" + separator) keeps its separator: the separator IS the path.
	while (normalized.length > 3 && normalized.endsWith(BS)) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

/** Whether `path` lies under `dir` (or equals it), separator- and case-tolerant per platform. */
function pathUnder(path: string, dir: string, platform: NodeJS.Platform): boolean {
	const separator = platform === "win32" ? BS : "/";
	const normalizedPath = normalizePathForCompare(path, platform);
	const normalizedDir = normalizePathForCompare(dir, platform);
	return normalizedPath === normalizedDir || normalizedPath.startsWith(normalizedDir + separator);
}

/** The global roots a shim path can be classified against: pnpm's global bin dir and npm's
 * global prefix, both probed lazily by the detector and never guessed here. */
export interface ShimClassificationRoots {
	pnpmBin?: string;
	npmPrefix?: string;
}

/**
 * Classifies a resolved codegraph shim path (from `which`/`where.exe`) against the three roots
 * gentle-shell can update through: the user's bun global root (`<homedir>/.bun`, where `bun add
 * -g` placed the shim), the directory `npm prefix -g` reports, or pnpm's global bin dir
 * (`pnpm bin -g`). The first matching root wins — a bun install shadows any other on PATH — and
 * anything else is "unknown", which never auto-updates: an unprovable owner is reported, never
 * guessed. Pure so both platform families classify identically off their own hosts.
 */
export function classifyCodegraphShimPath(shimPath: string | undefined, roots: ShimClassificationRoots, home: string, platform: NodeJS.Platform): CodegraphInstallSource {
	if (shimPath === undefined || shimPath.length === 0) return "unknown";
	// The injected platform owns the separator: node:path's join() would spell the root with the
	// HOST's separators and misclassify a cross-platform fixture (or any non-native spelling).
	const bunRoot = `${home}${platform === "win32" ? BS : "/"}.bun`;
	if (pathUnder(shimPath, bunRoot, platform)) return "bun-global";
	if (roots.npmPrefix !== undefined && roots.npmPrefix.length > 0 && pathUnder(shimPath, roots.npmPrefix, platform)) return "npm-global";
	if (roots.pnpmBin !== undefined && roots.pnpmBin.length > 0 && pathUnder(shimPath, roots.pnpmBin, platform)) return "pnpm-global";
	return "unknown";
}

/** npm's command spelling: the `.cmd` shim on win32, the plain binary everywhere else. */
function npmCommand(platform: NodeJS.Platform): string {
	return platform === "win32" ? "npm.cmd" : "npm";
}

export interface InstallSourceDetection {
	source: CodegraphInstallSource;
	/** The shim path the classification ran on; present whenever one was found. */
	shimPath?: string;
	/** Why an unknown source is unknown: the report the caller surfaces. */
	reason?: string;
}

/**
 * Resolves the codegraph shim the current PATH would run (`which` on POSIX, `where.exe`'s first
 * hit on win32) and classifies it: bun-global, npm-global, pnpm-global, or unknown. The npm
 * and pnpm root probes are deferred in that order - bun, npm, pnpm - until the pure bun check
 * fails, so a bun install never spawns either. Never throws; every failure is an unknown
 * source with its reason.
 */
export async function detectCodegraphInstallSource(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform; home?: string } = {}): Promise<InstallSourceDetection> {
	const platform = opts.platform ?? process.platform;
	const home = opts.home ?? homedir();
	const located = platform === "win32"
		? await exec("where.exe", ["codegraph"], VERSION_TIMEOUT_MS)
		: await exec("which", ["codegraph"], VERSION_TIMEOUT_MS);
	if (!located.ok) return { source: "unknown", reason: "the codegraph shim was not found on PATH; its install source is unknown" };
	const shimPath = located.stdout.trim().split(/\r?\n/)[0]?.trim();
	if (shimPath === undefined || shimPath.length === 0) {
		return { source: "unknown", reason: "the codegraph shim location was empty; its install source is unknown" };
	}
	if (classifyCodegraphShimPath(shimPath, {}, home, platform) === "bun-global") {
		return { source: "bun-global", shimPath };
	}
	let npmPrefix: string | undefined;
	const prefix = await exec(npmCommand(platform), ["prefix", "-g"], VERSION_TIMEOUT_MS);
	if (prefix.ok) npmPrefix = prefix.stdout.trim().split(/\r?\n/)[0]?.trim();
	if (npmPrefix !== undefined && classifyCodegraphShimPath(shimPath, { npmPrefix }, home, platform) === "npm-global") {
		return { source: "npm-global", shimPath };
	}
	let pnpmBin: string | undefined;
	const pnpmBinResult = await exec("pnpm", ["bin", "-g"], VERSION_TIMEOUT_MS);
	// pnpm prints a project-manager warning to stderr on this call; only stdout names the dir.
	if (pnpmBinResult.ok) pnpmBin = pnpmBinResult.stdout.trim().split(/\r?\n/)[0]?.trim();
	if (pnpmBin !== undefined && classifyCodegraphShimPath(shimPath, { npmPrefix, pnpmBin }, home, platform) === "pnpm-global") {
		return { source: "pnpm-global", shimPath };
	}
	if (npmPrefix === undefined && pnpmBin === undefined) return { source: "unknown", shimPath, reason: "neither npm prefix -g nor pnpm bin -g was available; the codegraph install source is unknown" };
	if (npmPrefix === undefined) return { source: "unknown", shimPath, reason: "npm prefix -g was unavailable; the codegraph install source is unknown" };
	return { source: "unknown", shimPath, reason: `the codegraph shim (${shimPath}) is under none of <homedir>/.bun, the npm global prefix, or the pnpm global bin; its install source is unknown` };
}

export interface UpdateRun {
	ok: boolean;
	/** The first line of the failed update's stderr, or the standing reason nothing ran. */
	reason?: string;
}

/**
 * Updates the package to latest through the detected install source: `bun add -g` for a bun
 * install (bun.exe spawns directly on win32), `pnpm add -g` for a pnpm one (pnpm.exe spawns
 * directly too), `npm install -g` for an npm one (through its `.cmd` shim on win32). An unknown
 * source runs nothing — the reason says why — and a failed update reports its reason and keeps
 * the current version running; neither ever throws.
 */
export async function updateCodegraphToLatest(source: CodegraphInstallSource, exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform } = {}): Promise<UpdateRun> {
	const platform = opts.platform ?? process.platform;
	if (source === "unknown") {
		return { ok: false, reason: "the codegraph install source is unknown; refusing to auto-update" };
	}
	const [command, args] = source === "bun-global"
		? ["bun", ["add", "-g", `${CODEGRAPH_PACKAGE}@latest`]] as const
		: source === "pnpm-global"
			? ["pnpm", ["add", "-g", `${CODEGRAPH_PACKAGE}@latest`]] as const
			: [npmCommand(platform), ["install", "-g", `${CODEGRAPH_PACKAGE}@latest`]] as const;
	const result = await exec(command, args, UPDATE_TIMEOUT_MS);
	if (result.ok) return { ok: true };
	const firstStderrLine = result.stderr.trim().split("\n")[0]?.trim();
	return { ok: false, reason: firstStderrLine !== undefined && firstStderrLine.length > 0 ? firstStderrLine : `${command} ${args.join(" ")} failed` };
}

/** What the once-per-process update check concluded. */
export interface CodegraphUpdateCheck {
	/** An update ran and succeeded this process; the binary changed underneath every index. */
	ran: boolean;
	/** The running binary's version as captured this process; undefined when even that failed. */
	version?: string;
	/** The version updated from and to (present when ran). */
	from?: string;
	to?: string;
	/** Why nothing ran, for the caller's report; absent when an update ran or none was due. */
	reason?: string;
}

/** The process-lifetime memo of the whole update check: one check per process, shared outcome. */
let checkMemo: Promise<CodegraphUpdateCheck> | undefined;

/** Drops the process-lifetime memos (the registry lookup and the whole-check memo); tests only. */
export function clearCodegraphUpdateCaches(): void {
	latestMemo = undefined;
	checkMemo = undefined;
}

/**
 * The whole update check, fail-open at every step: the running binary's version first (no
 * version — no check at all), then the registry latest (unavailable — skip), then the stale
 * compare (never on garbage), then the install source (unknown — report, never update), then
 * the update itself (failure — report, keep running the current version). The outcome carries
 * the captured version so the caller can stamp an index without spawning another probe.
 */
export async function runCodegraphUpdateCheck(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform; home?: string } = {}): Promise<CodegraphUpdateCheck> {
	const platform = opts.platform ?? process.platform;
	const home = opts.home ?? homedir();
	const installed = await installedCodegraphVersion(exec);
	if (installed === undefined) return { ran: false, reason: "the running codegraph version is unavailable; the update check was skipped" };
	const latest = await latestCodegraphVersion(exec, platform);
	if (latest === undefined) return { ran: false, version: installed, reason: "the npm registry latest for codegraph is unavailable; the update check was skipped" };
	if (!codegraphVersionDiffers(installed, latest)) return { ran: false, version: installed };
	const detected = await detectCodegraphInstallSource(exec, { platform, home });
	if (detected.source === "unknown") return { ran: false, version: installed, reason: detected.reason };
	const update = await updateCodegraphToLatest(detected.source, exec, { platform });
	if (!update.ok) return { ran: false, version: installed, reason: update.reason };
	return { ran: true, version: installed, from: installed, to: latest };
}

/**
 * The once-per-process entry the session-start readiness seam calls: the first call runs the
 * check and every later call shares its outcome — one `codegraph --version`, one registry
 * lookup, and at most one update per process. A check that throws (a rejecting exec) resolves
 * { ran: false }, never rejecting: readiness must never fail over the updater.
 */
export function ensureCodegraphLatest(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform; home?: string } = {}): Promise<CodegraphUpdateCheck> {
	if (checkMemo === undefined) {
		checkMemo = runCodegraphUpdateCheck(exec, opts).catch((): CodegraphUpdateCheck => ({ ran: false, reason: "the codegraph update check failed unexpectedly" }));
	}
	return checkMemo;
}

/** The managers a fresh install may go through, in try order. */
export type CodegraphInstallManager = "bun" | "npm" | "pnpm";

/** What the install-if-missing check concluded. */
export interface InstallOutcome {
	/** The PATH resolves a codegraph shim (or one was just installed). */
	installed: boolean;
	/** The manager this call installed through; present only after a fresh install. */
	via?: CodegraphInstallManager;
	/** Why nothing installed, for the caller's report; absent on success or when already installed. */
	reason?: string;
}

/**
 * Whether the current PATH resolves a codegraph shim (`which` on POSIX, `where.exe` on win32),
 * and when it does not, one install attempt through the first available manager - bun, npm,
 * pnpm, the same order update detection classifies in. A manager counts as available when its
 * own --version probe answers; a failed install falls through to the next manager. A fresh
 * install is already the registry latest, so the update check that follows no-ops and the init
 * path builds the first index. Every failure fails open: a session that cannot install keeps
 * running exactly as before, the reason says what happened.
 */
export async function ensureCodegraphInstalled(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform } = {}): Promise<InstallOutcome> {
	const platform = opts.platform ?? process.platform;
	const located = platform === "win32"
		? await exec("where.exe", ["codegraph"], VERSION_TIMEOUT_MS)
		: await exec("which", ["codegraph"], VERSION_TIMEOUT_MS);
	if (located.ok) return { installed: true };
	for (const manager of ["bun", "npm", "pnpm"] as const) {
		const command = manager === "npm" ? npmCommand(platform) : manager;
		const probe = await exec(command, ["--version"], VERSION_TIMEOUT_MS);
		if (!probe.ok) continue;
		const args = [manager === "npm" ? "install" : "add", "-g", `${CODEGRAPH_PACKAGE}@latest`];
		const install = await exec(command, args, UPDATE_TIMEOUT_MS);
		if (install.ok) return { installed: true, via: manager };
	}
	return { installed: false, reason: "no available package manager (bun, npm, pnpm) could install codegraph" };
}
