import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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
