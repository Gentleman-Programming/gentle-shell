import { execFile, spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { windowsTaskkillPath } from "./win32-taskkill.ts";

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** The npm package the codegraph CLI ships as; every registry probe and update targets it. */
export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";

/** One bounded process run's captured outcome; a run that timed out or failed to spawn is ok:false. */
export interface ExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	/** Present only when a timed-out run's teardown could not confirm the whole process tree
	 * exited: the caller must not start another install beside a possibly-surviving one. */
	teardownUnconfirmed?: boolean;
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
/** How often a timed-out POSIX teardown re-probes the process group for confirmed emptiness. */
const TEARDOWN_POLL_MS = 250;

/** Kills a whole POSIX process group: runBounded spawns plain commands in their own group
 * precisely so a timeout takes the installer's descendants too, not only the manager PID
 * (npm's spawned children would survive a direct kill and keep mutating the global package). */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		/* the group is already gone */
	}
}

/** Whether a POSIX process group is provably empty: only ESRCH answers for gone — EPERM
 * means a live group this user may not signal, which is survival, not exit. */
function processGroupGone(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/** Kills a whole Windows process tree with taskkill and reports whether it confirmed the
 * kill. The tree kill runs before any direct kill: killing the shell wrapper first orphans
 * the tree taskkill walks, and its pid would no longer name it. The absolute System32
 * binary, spawned from System32 itself: a bare "taskkill" would resolve from the current
 * directory before PATH and vanish on a broken PATH. */
function killWindowsTree(pid: number, settled: (confirmed: boolean) => void): void {
	const taskkill = windowsTaskkillPath();
	execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { cwd: win32.dirname(taskkill), windowsHide: true, timeout: KILL_WAIT_MS }, (error) => {
		settled(error === null);
	});
}

/** Quotes one argument the way cmd.exe keeps it: backslashes exactly as written, embedded
 * quotes doubled, the whole part inside double quotes (the repo's buildWindowsCommand rule). */
function quoteForCmd(part: string): string {
	return `"${part.replaceAll("\"", "\"\"")}"`;
}

/**
 * The production BoundedExec: one spawn with piped stdio, decoded with one persistent decoder
 * per stream (a multibyte character split across Buffer chunks survives), each stream's tail
 * kept to MAX_STREAM_CHARS, and a timeout that tears down the whole process tree (taskkill
 * /T on win32, a POSIX process-group signal, SIGTERM escalating to SIGKILL after a short
 * grace, KILL_ESCALATE_MS + KILL_WAIT_MS the absolute cap) before the failed result is
 * reported — a teardown that cannot confirm exit resolves the run marked
 * teardownUnconfirmed, so callers refuse to start another install beside a possibly-
 * surviving tree — and after the deadline the leader's own close proves nothing about the
 * tree: a worker with its own stdio can outlive the close, so confirmation waits for the
 * process group to prove empty (POSIX) or for taskkill to confirm the tree (win32), and
 * only that ever marks teardown confirmed. On win32 a `.cmd` command is a batch shim Node refuses to
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
		let teardownCap: ReturnType<typeof setTimeout> | undefined;
		let teardownPoll: ReturnType<typeof setInterval> | undefined;
		let teardownConfirmed = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (escalate !== undefined) clearTimeout(escalate);
			if (teardownCap !== undefined) clearTimeout(teardownCap);
			if (teardownPoll !== undefined) clearInterval(teardownPoll);
			resolve({
				ok,
				stdout: stdoutKept,
				stderr: stderrKept,
				...(timedOut && !teardownConfirmed ? { teardownUnconfirmed: true } : {}),
			});
		};
		// Confirms a timed-out POSIX teardown by probing the process group: the leader's close
		// proves nothing about a worker that ignores SIGTERM, so confirmation waits for the
		// group to empty (the scheduled SIGKILL escalation empties it) and the teardown cap
		// reports the run unconfirmed when proof never arrives.
		const confirmTeardownWhenGroupGone = (pid: number): void => {
			if (processGroupGone(pid)) {
				teardownConfirmed = true;
				finish(false);
				return;
			}
			if (teardownPoll !== undefined) return;
			teardownPoll = setInterval(() => {
				if (processGroupGone(pid)) {
					teardownConfirmed = true;
					finish(false);
				}
			}, TEARDOWN_POLL_MS);
		};
		let timer: ReturnType<typeof setTimeout>;
		try {
			child = shell
				? spawn(command, { windowsHide: true, shell: true, stdio: ["ignore", "pipe", "pipe"] })
				: spawn(command, [...args], {
					// The shell:true branch is win32-only; every plain spawn takes its own POSIX
					// process group so a timeout can kill the whole tree (detached has no effect
					// on a win32 non-shell spawn and stays off there).
					detached: process.platform !== "win32",
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
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
			if (child?.pid === undefined) {
				finish(false);
				return;
			}
			if (process.platform === "win32") {
				killWindowsTree(child.pid, (confirmed) => {
					if (!confirmed) {
						child?.kill();
						return;
					}
					// taskkill's clean exit is the tree's own confirmation, and the leader's close may
					// already have fired — so the confirmation also settles the run.
					teardownConfirmed = true;
					finish(false);
				});
			} else {
				killProcessGroup(child.pid, "SIGTERM");
				escalate = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), KILL_ESCALATE_MS);
			}
			// The absolute cap: a teardown that cannot confirm exit inside it still resolves the
			// run (marked unconfirmed) and drops this side's process references, so a survivor
			// cannot hold the event loop or the promise open forever.
			teardownCap = setTimeout(() => {
				child?.unref();
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				finish(false);
			}, KILL_ESCALATE_MS + KILL_WAIT_MS);
		}, timeoutMs);
		child.on("error", (error: Error) => {
			stderrKept = (stderrKept.length > 0 ? `${stderrKept}\n` : "") + error.message;
			finish(false);
		});
		child.on("close", (code: number | null) => {
			if (!timedOut) {
				finish(code === 0);
				return;
			}
			// The leader's close after the deadline proves only the leader exited — a worker
			// ignoring SIGTERM, or win32 taskkill still walking the tree, keeps the tree alive.
			// Confirmation comes independently: the group-gone probe on POSIX, taskkill's
			// result on win32; the teardown cap bounds the wait and reports the run unconfirmed
			// when proof never arrives.
			const pid = child?.pid;
			if (pid === undefined) {
				finish(false);
				return;
			}
			if (process.platform === "win32") {
				if (teardownConfirmed) finish(false);
				return;
			}
			confirmTeardownWhenGroupGone(pid);
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

/** A version identifier's shape: the dotted numeric triple plus an optional dot-separated
 * prerelease suffix ("1.6.4", "1.6.4-beta.2"); build metadata never appears in the probes. */
const VERSION_IDENTIFIER = /(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/;

/** A character that can continue a version identifier past a match: digits, letters, the
 * dot between suffix segments, or the prerelease hyphen. */
const VERSION_CONTINUATION = /[0-9A-Za-z.-]/;

/** The first full version identifier in the text — triple and prerelease suffix whole — or
 * undefined when there is none. A suffix the pattern cannot spell ("1.6.4-!!") leaves the
 * version half-described, which is unparseable, and so does any identifier character
 * continuing the match ("1.6.4-beta.!"): the updater never guesses at a version it
 * cannot reproduce verbatim in a pinned install spec. */
export function parseCodegraphVersion(stdout: string): string | undefined {
	const match = VERSION_IDENTIFIER.exec(stdout);
	if (match === null) return undefined;
	// The whole token, never a valid prefix of a longer one: any identifier character right
	// after the match means the source spelled a version the pattern cannot reproduce
	// ("1.6.4-beta.!"), and a truncated pick would pin a version nobody reported.
	if (VERSION_CONTINUATION.test(stdout.charAt(match.index + match[0].length))) return undefined;
	return match[0];
}

/**
 * The version of the RUNNING codegraph binary: `codegraph --version`, first full version
 * identifier of its stdout ("1.6.4" and "codegraph 1.6.4-beta.2" alike). A failed,
 * timed-out, or unparseable probe
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

/** A whole version identifier, anchored: major.minor.patch plus an optional prerelease. */
const FULL_VERSION_IDENTIFIER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Whether `installed` differs from `latest`: anything but an exact match of the full version
 * identifiers — older OR newer, prerelease against stable — means the binary is not the
 * latest version; the update brings it back to latest. Either side unparseable or missing
 * answers false: garbage never updates. */
export function codegraphVersionDiffers(installed: string | undefined, latest: string | undefined): boolean {
	if (installed === undefined || latest === undefined) return false;
	if (!FULL_VERSION_IDENTIFIER.test(installed) || !FULL_VERSION_IDENTIFIER.test(latest)) return false;
	return installed !== latest;
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

/** pnpm's runnable entry for this PATH. POSIX always runs the bare "pnpm". On win32 the
 * bare-name probe decides: where.exe resolves "pnpm" the way a shell would — every PATHEXT
 * extension, PATH directories in order — so its first hit is the entry a command line
 * actually runs, and an earlier directory's pnpm.exe wins over a later directory's
 * pnpm.cmd, which a shim-only probe could never see. The selected entry runs as itself: a
 * ".cmd" path through the shell-handled spawn, a native executable directly. When the bare
 * probe cannot answer, the ".cmd" spelling stands and the run fails exactly as before. */
async function resolvePnpmCommand(exec: BoundedExec, platform: NodeJS.Platform): Promise<string> {
	if (platform !== "win32") return "pnpm";
	const effective = await exec("where.exe", ["pnpm"], VERSION_TIMEOUT_MS);
	if (effective.ok) {
		const entry = effective.stdout.trim().split(/\r?\n/)[0]?.trim();
		if (entry !== undefined && entry.length > 0) return entry;
	}
	return "pnpm.cmd";
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
	const pnpmEntry = await resolvePnpmCommand(exec, platform);
	const pnpmBinResult = await exec(pnpmEntry, ["bin", "-g"], VERSION_TIMEOUT_MS);
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
	/** A timed-out attempt whose process-tree teardown could not confirm exit: the caller must
	 * not start another install beside a possibly-surviving one. */
	teardownUnconfirmed?: boolean;
}

/** One manager attempt's outcome from its exec result: ok on a clean exit, otherwise the
 * first stderr line (or the command itself) as the reason and, when the attempt timed out
 * without confirming its tree exited, the flag callers refuse follow-up installs on. */
function updateRunFromResult(result: ExecResult, command: string, args: readonly string[]): UpdateRun {
	if (result.ok) return { ok: true };
	const firstStderrLine = result.stderr.trim().split("\n")[0]?.trim();
	return {
		ok: false,
		reason: firstStderrLine !== undefined && firstStderrLine.length > 0 ? firstStderrLine : `${command} ${args.join(" ")} failed`,
		...(result.teardownUnconfirmed ? { teardownUnconfirmed: true } : {}),
	};
}

/**
 * Updates the package through the detected install source, each manager in its own update
 * form (user-directed): `bun update -g <pkg> --latest` for a bun install (bun.exe spawns
 * directly on win32), `pnpm update -g <pkg> --latest` for a pnpm one, `npm update -g <pkg>`
 * for an npm one (through its `.cmd` shim on win32). A dist-tag resolution can come from the
 * manager's metadata cache - pnpm was observed answering "Already up to date" for 1.6.3
 * while the registry latest was 1.6.4 - so the caller re-probes the running binary after any
 * success and a no-op is reported as the failure it is. An unknown source runs nothing, and a
 * failed update reports its reason and keeps the current version running; neither ever throws.
 */
export async function updateCodegraphToLatest(source: CodegraphInstallSource, exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform } = {}): Promise<UpdateRun> {
	const platform = opts.platform ?? process.platform;
	if (source === "unknown") {
		return { ok: false, reason: "the codegraph install source is unknown; refusing to auto-update" };
	}
	const command = source === "bun-global"
		? "bun"
		: source === "pnpm-global"
			? await resolvePnpmCommand(exec, platform)
			: npmCommand(platform);
	const args = ["update", "-g", CODEGRAPH_PACKAGE, ...(source === "npm-global" ? [] : ["--latest"])];
	return updateRunFromResult(await exec(command, args, UPDATE_TIMEOUT_MS), command, args);
}

/** One exact-version install: the universal form when a manager's update command no-ops. */
async function installCodegraphExact(source: CodegraphInstallSource, version: string, exec: BoundedExec, platform: NodeJS.Platform): Promise<UpdateRun> {
	const spec = `${CODEGRAPH_PACKAGE}@${version}`;
	const command = source === "bun-global"
		? "bun"
		: source === "pnpm-global"
			? await resolvePnpmCommand(exec, platform)
			: npmCommand(platform);
	const args = [source === "npm-global" ? "install" : "add", "-g", spec];
	return updateRunFromResult(await exec(command, args, UPDATE_TIMEOUT_MS), command, args);
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
	/** Why nothing ran — or why a binary transition still missed the registry target — for
	 * the caller's report; absent when the update reached the registry latest or none was due. */
	reason?: string;
}

/** The process-lifetime memo of the whole update check: one check per process, shared
 * outcome — except while a deferred transition is unresolved, when the memo drops after
 * each pass so the next pass re-probes (see ensureCodegraphLatest). */
let checkMemo: Promise<CodegraphUpdateCheck> | undefined;

/** The version a timed-out update started from, held while its possibly-surviving installer
 * runs: later passes re-probe the binary against it — never starting another installer —
 * and the first observed change reports to readiness as the update's transition. */
let pendingUpdateFrom: string | undefined;

/** Drops the process-lifetime memos (the registry lookup, the whole-check memo, any settled
 * fresh-install attempt's slot, and any deferred transition); tests only. */
export function clearCodegraphUpdateCaches(): void {
	latestMemo = undefined;
	checkMemo = undefined;
	installMemo = undefined;
	pendingUpdateFrom = undefined;
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
	// A transition deferred by an unconfirmed teardown settles on a later pass: the binary is
	// re-probed — no installer may start beside the tree whose exit was never confirmed — and
	// the first observed change reports to readiness exactly like a check that ran the update.
	if (pendingUpdateFrom !== undefined) {
		const now = await installedCodegraphVersion(exec);
		if (now !== undefined && now !== pendingUpdateFrom) {
			const from = pendingUpdateFrom;
			pendingUpdateFrom = undefined;
			const latest = await latestCodegraphVersion(exec, platform);
			if (latest === undefined || now === latest) return { ran: true, version: from, from, to: now };
			return { ran: true, version: from, from, to: now, reason: `the deferred update settled at ${now}, not the registry latest ${latest}` };
		}
		return {
			ran: false,
			version: now ?? pendingUpdateFrom,
			reason: now === undefined
				? "a deferred codegraph update is still in flight; the binary version is unavailable"
				: `a deferred codegraph update is still in flight; the binary still reports ${now}`,
		};
	}
	const installed = await installedCodegraphVersion(exec);
	if (installed === undefined) return { ran: false, reason: "the running codegraph version is unavailable; the update check was skipped" };
	const latest = await latestCodegraphVersion(exec, platform);
	if (latest === undefined) return { ran: false, version: installed, reason: "the npm registry latest for codegraph is unavailable; the update check was skipped" };
	if (!codegraphVersionDiffers(installed, latest)) return { ran: false, version: installed };
	const detected = await detectCodegraphInstallSource(exec, { platform, home });
	if (detected.source === "unknown") return { ran: false, version: installed, reason: detected.reason };
	const update = await updateCodegraphToLatest(detected.source, exec, { platform });
	if (update.ok) {
		const now = await installedCodegraphVersion(exec);
		if (now === latest) return { ran: true, version: installed, from: installed, to: latest };
	}
	// A timed-out update whose process-tree teardown could not confirm exit is never followed
	// by the fallback install in the same pass: a surviving installer may still be mutating
	// the global package underneath.
	if (update.teardownUnconfirmed) {
		pendingUpdateFrom = installed;
		return { ran: false, version: installed, reason: "the timed-out update's process tree could not be confirmed gone; the exact-version fallback was skipped" };
	}
	// The manager's own update form can exit 0 without changing anything (pnpm 12 answers
	// "Already up to date" against a newer registry latest): one exact-version install is the
	// universal second chance, and the final probe decides whether anything really ran.
	const fallback = await installCodegraphExact(detected.source, latest, exec, platform);
	// A timed-out fallback whose teardown is unconfirmed defers the whole transition report:
	// the final probe could observe a binary the surviving installer is still replacing, and
	// readiness must never move the old index beside it — a later check, with the tree
	// confirmed gone, reports what the binary actually settled at.
	if (fallback.teardownUnconfirmed) {
		pendingUpdateFrom = installed;
		return { ran: false, version: installed, reason: "the timed-out exact-version install's process tree could not be confirmed gone; the observed binary transition is deferred to a later check" };
	}
	// A nonzero exit does not prove the executable unchanged — the first attempt can replace
	// the binary and still fail — so the final probe reports the observed binary transition
	// independently of the registry target: a changed binary always reaches the caller's
	// rebuild, an unchanged one leaves the index alone.
	const now = await installedCodegraphVersion(exec);
	if (now !== undefined && now !== installed) {
		if (now === latest) return { ran: true, version: installed, from: installed, to: latest };
		return {
			ran: true,
			version: installed,
			from: installed,
			to: now,
			reason: fallback.ok
				? `the update succeeded but the binary reports ${now}, not the registry latest ${latest}`
				: `the update attempts failed but the binary changed from ${installed} to ${now}`,
		};
	}
	return {
		ran: false,
		version: now ?? installed,
		reason: fallback.ok
			? `the update succeeded but the binary still reports ${now ?? "no version"}`
			: fallback.reason,
	};
}

/**
 * The once-per-process entry the session-start readiness seam calls: the first call runs the
 * check and every later call shares its outcome — one `codegraph --version`, one registry
 * lookup, and at most one update per process. The one exception is a transition deferred by
 * an unconfirmed teardown: its outcome is shared only with concurrent callers, and later
 * calls re-probe the binary until the deferred change settles and reports. A check that
 * throws (a rejecting exec) resolves { ran: false }, never rejecting: readiness must never
 * fail over the updater.
 */
export function ensureCodegraphLatest(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform; home?: string } = {}): Promise<CodegraphUpdateCheck> {
	if (checkMemo === undefined) {
		checkMemo = runCodegraphUpdateCheck(exec, opts)
			.catch((): CodegraphUpdateCheck => ({ ran: false, reason: "the codegraph update check failed unexpectedly" }))
			.then((outcome) => {
				// A deferred transition is not this process's final answer: while it stays
				// unresolved the memo drops after each pass, so a later readiness pass re-probes
				// the binary and reports the change the deferred installer eventually made.
				if (pendingUpdateFrom !== undefined) checkMemo = undefined;
				return outcome;
			});
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
	/** A timed-out install whose tree teardown could not confirm exit: the caller must not
	 * start another install — or update — beside a possibly-surviving one. */
	teardownUnconfirmed?: boolean;
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
/** The in-flight — or fenced — fresh-install attempt: concurrent readiness passes, different
 * roots but one global package, join the same run instead of racing a second installer.
 * Dropped when it settles without an unconfirmed teardown, so a later startup retries after
 * a failure instead of inheriting it; an unconfirmed-teardown outcome stays memoized as an
 * install fence for the rest of the process. */
let installMemo: Promise<InstallOutcome> | undefined;

export function ensureCodegraphInstalled(exec: BoundedExec = defaultExec, opts: { platform?: NodeJS.Platform } = {}): Promise<InstallOutcome> {
	if (installMemo === undefined) {
		installMemo = runCodegraphInstallCheck(exec, opts).then((outcome) => {
			// An unconfirmed-teardown outcome stays memoized as an install fence: every later
			// readiness pass in this process shares it instead of starting another installer
			// beside a possibly-surviving tree, and the next process — with the tree gone —
			// retries fresh. Confirmed outcomes keep the memo dropped, so ordinary failures
			// retry exactly as before.
			if (!outcome.teardownUnconfirmed) installMemo = undefined;
			return outcome;
		}, (error) => {
			installMemo = undefined;
			throw error;
		});
	}
	return installMemo;
}

async function runCodegraphInstallCheck(exec: BoundedExec, opts: { platform?: NodeJS.Platform }): Promise<InstallOutcome> {
	const platform = opts.platform ?? process.platform;
	const located = platform === "win32"
		? await exec("where.exe", ["codegraph"], VERSION_TIMEOUT_MS)
		: await exec("which", ["codegraph"], VERSION_TIMEOUT_MS);
	if (located.ok) return { installed: true };
	// Pin the exact version when the registry probe knows it (the shared, memoized lookup):
	// a dist-tag spec resolves through the manager's metadata cache, which can be stale.
	const latest = await latestCodegraphVersion(exec, platform);
	const spec = latest !== undefined ? `${CODEGRAPH_PACKAGE}@${latest}` : `${CODEGRAPH_PACKAGE}@latest`;
	for (const manager of ["bun", "npm", "pnpm"] as const) {
		const command = manager === "npm" ? npmCommand(platform) : manager === "pnpm" ? await resolvePnpmCommand(exec, platform) : manager;
		const probe = await exec(command, ["--version"], VERSION_TIMEOUT_MS);
		if (!probe.ok) continue;
		const args = [manager === "npm" ? "install" : "add", "-g", spec];
		const install = await exec(command, args, UPDATE_TIMEOUT_MS);
		if (install.ok) return { installed: true, via: manager };
		// A timed-out install whose tree teardown could not confirm exit is never followed by
		// another manager in the same pass: a surviving installer could still be mutating the
		// global package a second one would race.
		if (install.teardownUnconfirmed) {
			return { installed: false, reason: `a timed-out ${command} install's process tree could not be confirmed gone; no further manager was tried`, teardownUnconfirmed: true };
		}
	}
	return { installed: false, reason: "no available package manager (bun, npm, pnpm) could install codegraph" };
}
