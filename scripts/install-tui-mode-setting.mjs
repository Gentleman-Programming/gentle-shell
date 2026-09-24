import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// The two directory layouts Pi's own package manager creates when it installs
// a package into an agent home: the npm-backed `npm/node_modules/<package>`
// (user scope `<agent dir>/npm/node_modules/gentle-pi`, project scope
// `.pi/npm/node_modules/gentle-pi`) and the git-backed
// `git/github.com/Gentleman-Programming/<package>` layout. A path is checked
// for these sequences anywhere in its segments, not anchored to a specific
// resolved agent home — unlike installTuiModeSetting's own ownership check.
const PI_MANAGED_SEGMENT_SEQUENCES = [
	["npm", "node_modules"],
	["git", "github.com", "Gentleman-Programming"],
];

// Gentle Shell's default theme (themes/Gentleman-Cute.json, "name":
// "Gentleman-Cute"): applied by withIsolatedHomeDefaults below whenever a
// home's settings do not already declare one, never overriding a user's own
// choice.
export const DEFAULT_THEME_NAME = "Gentleman-Cute";

// Pure merge: returns `value` with fullscreen tuiMode always applied, and —
// only when `value` does not already declare a "theme" key — the default
// theme above added too. No filesystem access, so it is unit-testable
// without a tempdir; installIsolatedTuiModeSetting below is the only caller,
// applying this to a freshly bootstrapped home's settings.
export function withIsolatedHomeDefaults(value) {
	const next = { ...value, tuiMode: "fullscreen" };
	if (!("theme" in value)) next.theme = DEFAULT_THEME_NAME;
	return next;
}

function containsSequence(segments, sequence) {
	for (let start = 0; start + sequence.length <= segments.length; start += 1) {
		if (sequence.every((part, offset) => segments[start + offset] === part)) return true;
	}
	return false;
}

/** Gates the POSTINSTALL entry point only (scripts/install-gentle-ai.mjs), not
 * installTuiModeSetting or installIsolatedTuiModeSetting: true when
 * `packageDir` (the directory of the gentle-pi package actually running,
 * typically derived from that script's own import.meta.url) sits under one of
 * the directory layouts above. A plain `npm install -g gentle-pi`, a
 * development git checkout, an `npx` cache directory, or a pnpm store never
 * match, so the postinstall entry skips writing the user's global Pi settings
 * for those instead of relying solely on installTuiModeSetting's own,
 * differently-scoped ownership check.
 */
export function isPiManagedInstall(packageDir) {
	const segments = resolve(packageDir).split(sep);
	return PI_MANAGED_SEGMENT_SEQUENCES.some((sequence) => containsSequence(segments, sequence));
}

function inspect(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function sameFile(left, right) {
	return left && right && left.dev === right.dev && left.ino === right.ino;
}

function assertDirectories(paths) {
	for (const path of paths) {
		const stat = inspect(path);
		if (!stat?.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
			throw new Error(`Unsafe fullscreen settings installation path: ${path}`);
		}
	}
}

function readSettings(path) {
	const before = inspect(path);
	if (!before) return { stat: undefined, text: undefined, value: {} };
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("settings.json must be a regular, non-symlink file");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!sameFile(before, fstatSync(fd))) throw new Error("settings.json changed while opening");
		const text = readFileSync(fd, "utf8");
		const value = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json must contain a JSON object");
		return { stat: before, text, value };
	} finally { closeSync(fd); }
}

// Pi uses proper-lockfile with realpath:false: its cooperative lock is the
// settings.json.lock directory. Do not steal stale locks. Keep the synchronous
// critical section below shorter than proper-lockfile's default stale window.
async function acquireLock(path) {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			mkdirSync(path, { mode: 0o700 });
			return inspect(path);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (attempt === 9) throw new Error("Fullscreen settings lock is busy; retry installation when other settings writers finish");
			await delay(20);
		}
	}
}

/** Only physically owned global Pi npm or exact Git installs may mutate Pi settings.
 * Atomic rename protects readers from partial JSON, not arbitrary writers or
 * malicious same-user ancestor swaps. No lifecycle cwd or store symlink grants ownership.
 */
export async function installTuiModeSetting(options = {}) {
	const env = options.env ?? process.env;
	const requestedHome = resolve(env.GENTLE_PI_AGENT_HOME || env.PI_CODING_AGENT_DIR || join(options.home ?? homedir(), ".pi", "agent"));
	const packageRoot = resolve(options.packageRoot ?? dirname(dirname(fileURLToPath(import.meta.url))));
	let home;
	try { home = realpathSync(requestedHome); }
	catch (error) { if (error.code === "ENOENT") return { changed: false, recognized: false }; throw error; }
	const installations = [
		{
			packageRoot: join(home, "npm", "node_modules", "gentle-pi"),
			paths: [home, join(home, "npm"), join(home, "npm", "node_modules"), join(home, "npm", "node_modules", "gentle-pi")],
		},
		{
			packageRoot: join(home, "git", "github.com", "Gentleman-Programming", "gentle-pi"),
			paths: [home, join(home, "git"), join(home, "git", "github.com"), join(home, "git", "github.com", "Gentleman-Programming"), join(home, "git", "github.com", "Gentleman-Programming", "gentle-pi")],
		},
	];
	// Canonical agent-home aliases (including macOS /var) are supported.
	// pnpm's physical store, npm links, and Git aliases are not owned global installs.
	const installation = installations.find(({ packageRoot: expected }) => realpathSync(packageRoot) === expected);
	if (!installation) return { changed: false, recognized: false };
	assertDirectories(installation.paths);
	const settingsPath = join(home, "settings.json");
	const lockPath = `${settingsPath}.lock`;
	const lock = await acquireLock(lockPath);
	const started = Date.now();
	let staging;
	try {
		assertDirectories(installation.paths);
		const original = readSettings(settingsPath);
		if (original.value.tuiMode === "fullscreen") return { changed: false, recognized: true };
		staging = join(home, `.settings-fullscreen-${randomUUID()}.tmp`);
		const fd = openSync(staging, "wx", original.stat ? original.stat.mode & 0o777 : 0o600);
		try {
			if (original.stat) fchmodSync(fd, original.stat.mode & 0o777);
			writeFileSync(fd, `${JSON.stringify({ ...original.value, tuiMode: "fullscreen" }, null, 2)}\n`, "utf8");
			fsyncSync(fd);
		} finally { closeSync(fd); }
		assertDirectories(installation.paths);
		const latest = readSettings(settingsPath);
		if (latest.text !== original.text || (original.stat ? !sameFile(original.stat, latest.stat) : latest.stat !== undefined)) {
			throw new Error("settings.json changed concurrently; retry installation");
		}
		if (!sameFile(lock, inspect(lockPath)) || Date.now() - started >= 5000) throw new Error("Fullscreen settings lock ownership expired; retry installation");
		renameSync(staging, settingsPath);
		staging = undefined;
		return { changed: true, recognized: true };
	} finally {
		// Only clean our own artifacts while the original parent remains canonical.
		if (realpathSync(home) === home) {
			if (staging) unlinkSync(staging);
			if (sameFile(lock, inspect(lockPath))) rmdirSync(lockPath);
		}
	}
}

/** Writes tuiMode: "fullscreen" and — when the home has no theme of its own
 * yet — the default Gentle Shell theme (withIsolatedHomeDefaults,
 * DEFAULT_THEME_NAME above) into a directory gentle-shell's own isolated-home
 * bootstrap (T2) just created and owns. Unlike installTuiModeSetting, there is no
 * "physically installed under this home's npm/node_modules" ownership check to
 * satisfy: the caller already knows it created `dir` moments ago as gentle-shell's
 * dedicated agent home, so the only safety property that still matters is the one
 * every writer here needs — atomic, non-symlink, cooperative-lock-respecting.
 */
export async function installIsolatedTuiModeSetting(dir) {
	const home = realpathSync(resolve(dir));
	assertDirectories([home]);
	const settingsPath = join(home, "settings.json");
	const lockPath = `${settingsPath}.lock`;
	const lock = await acquireLock(lockPath);
	const started = Date.now();
	let staging;
	try {
		assertDirectories([home]);
		const original = readSettings(settingsPath);
		if (original.value.tuiMode === "fullscreen") return { changed: false, recognized: true };
		staging = join(home, `.settings-fullscreen-${randomUUID()}.tmp`);
		const fd = openSync(staging, "wx", original.stat ? original.stat.mode & 0o777 : 0o600);
		try {
			if (original.stat) fchmodSync(fd, original.stat.mode & 0o777);
			writeFileSync(fd, `${JSON.stringify(withIsolatedHomeDefaults(original.value), null, 2)}\n`, "utf8");
			fsyncSync(fd);
		} finally { closeSync(fd); }
		assertDirectories([home]);
		const latest = readSettings(settingsPath);
		if (latest.text !== original.text || (original.stat ? !sameFile(original.stat, latest.stat) : latest.stat !== undefined)) {
			throw new Error("settings.json changed concurrently; retry installation");
		}
		if (!sameFile(lock, inspect(lockPath)) || Date.now() - started >= 5000) throw new Error("Fullscreen settings lock ownership expired; retry installation");
		renameSync(staging, settingsPath);
		staging = undefined;
		return { changed: true, recognized: true };
	} finally {
		if (realpathSync(home) === home) {
			if (staging) unlinkSync(staging);
			if (sameFile(lock, inspect(lockPath))) rmdirSync(lockPath);
		}
	}
}
