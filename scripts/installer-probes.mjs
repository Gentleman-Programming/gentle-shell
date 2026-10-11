import { spawn as spawnProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { gentleAiBinaryPath } from "../runtime/gentle-ai-binary.mjs";
import { pnpmGlobalBin, requirements } from "./installer-preflight.mjs";
import { installOwner } from "./main-channel.mjs";
import {
	PI_PACKAGE,
	SHELL_PACKAGE,
	childEnvironment,
	contains,
	genuineNpm,
	lookPath,
	npmInvocation,
	packageNativeGentleAi,
	pnpmInvocation,
	recoverableStackRoot,
	samePath,
	spawnable,
	succeeded,
	windowsInvocation,
} from "./installer-runner.mjs";
import { verifyWindowsStorage, verifyWindowsStorageMany } from "./installer-windows.mjs";

// Real host probes for collectInventory. Every effect goes through injected
// adapters; probes only run fixed read-only argv (`--version`, `go version`,
// `pnpm list -g`, `npm config get prefix`, `npm root -g`) and never write,
// create directories or run setup/postinstall.

const SECOND = 1000;
const deadlines = Object.freeze({ version: 10 * SECOND, list: 30 * SECOND });
const BOOTSTRAP_TOOLS = /^\.gentle-shell-bootstrap-tools\./;
const PNPM_MAJOR = Number(requirements.pnpm.split(".")[0]);

const unknown = () => ({ available: null });
const absent = () => ({ available: false });

function pathOf(platform) {
	return platform === "win32" ? win32 : posix;
}
function pathKey(env, platform) {
	return platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path" : "PATH";
}
function envValue(env, name, platform) {
	const key = platform === "win32" ? Object.keys(env).find((candidate) => candidate.toUpperCase() === name) : name;
	return key === undefined ? undefined : env[key];
}
function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactVersion(text, pattern) {
	const match = pattern.exec(String(text ?? "").trim());
	return match ? `${match[1]}.${match[2]}.${match[3] ?? "0"}` : null;
}
const NUMBER = "(0|[1-9]\\d*)";
const STABLE = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
// A main-channel Gentle Shell (scripts/main-channel.mjs): <stable>-main.<sha12>.
const MAIN_BUILD = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}-main\\.[0-9a-f]{12}$`);
const NODE_VERSION = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const GO_VERSION = new RegExp(`^go version go${NUMBER}\\.${NUMBER}(?:\\.${NUMBER})? \\S+$`);
function atLeast(version, minimum) {
	const [left, right] = [version, minimum].map((value) => value.split(".").map(Number));
	for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
	return true;
}

function normalDirectory(path, value) {
	return path.normalize(value).replace(/(.)[\\/]+$/, "$1");
}
function sameDirectory(platform, left, right) {
	const path = pathOf(platform);
	const [a, b] = [normalDirectory(path, left), normalDirectory(path, right)];
	return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Bootstrap tool roots: `GENTLE_BOOTSTRAP_TOOLS` and every PATH entry segment
 * named `.gentle-shell-bootstrap-tools.*` (the bootstrap's temporary directory).
 */
export function bootstrapRoots({ platform, env }) {
	const path = pathOf(platform);
	const roots = [];
	const add = (root) => {
		const normal = normalDirectory(path, root);
		if (!roots.some((other) => sameDirectory(platform, other, normal))) roots.push(normal);
	};
	const tools = envValue(env, "GENTLE_BOOTSTRAP_TOOLS", platform);
	if (typeof tools === "string" && path.isAbsolute(tools)) add(tools);
	const marker = platform === "win32" ? new RegExp(BOOTSTRAP_TOOLS.source, "i") : BOOTSTRAP_TOOLS;
	for (const entry of String(env[pathKey(env, platform)] ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(entry)) continue;
		const parts = path.normalize(entry).split(path.sep);
		const index = parts.findIndex((part) => marker.test(part));
		if (index > 0) add(parts.slice(0, index + 1).join(path.sep) || path.sep);
	}
	return roots;
}

/** The user's own environment: PATH without bootstrap tool directories. */
export function userEnvironment({ platform, env }) {
	const path = pathOf(platform);
	const roots = bootstrapRoots({ platform, env });
	const key = pathKey(env, platform);
	if (env[key] === undefined) return { ...env };
	const own = (entry) => !roots.some((root) => sameDirectory(platform, root, entry) || contains(root, entry, platform));
	return { ...env, [key]: String(env[key]).split(path.delimiter).filter((entry) => entry.length > 0 && own(entry)).join(path.delimiter) };
}

/** Real adapters: argv spawn without a shell, SIGKILL at the deadline, bounded
 * stdout (stderr discarded: it can hold private paths) and read-only fs checks.
 * Only a caller that passes `stderrTail: <bytes>` (a positive integer, clamped
 * to 4 KiB) gets stderr piped; the result then carries just its last bytes as
 * `stderrTail`. Callers must sanitize that text before showing it anywhere.
 * The deadline signals the direct child only, not its descendants, and settles
 * the result as timed out without waiting for the child's pipes to close.
 * An optional `cwd` sets the child's working directory.
 * `spawn` is injectable only for trusted tests.
 */
export function hostAdapters({ maxOutputBytes = 1024 * 1024, maxTextBytes = 1024 * 1024, spawn = spawnProcess } = {}) {
	const run = (command, argv, { env, cwd, deadlineMs, stderrTail }) => new Promise((resolve) => {
		let size = 0;
		let truncated = false;
		let timedOut = false;
		const chunks = [];
		const tailBytes = Number.isSafeInteger(stderrTail) && stderrTail > 0 ? Math.min(stderrTail, 4096) : 0;
		let tail = Buffer.alloc(0);
		const withTail = (result) => (tailBytes > 0 ? { ...result, stderrTail: tail.toString("utf8") } : result);
		let child;
		try {
			child = spawn(command, argv, { env, cwd, shell: false, stdio: ["ignore", "pipe", tailBytes > 0 ? "pipe" : "ignore"], windowsHide: true });
		} catch {
			resolve(withTail({ code: null, signal: null, timedOut: false, truncated: false, stdout: "" }));
			return;
		}
		let settled = false;
		const settle = (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(withTail({ code, signal, timedOut, truncated, stdout: Buffer.concat(chunks).toString("utf8") }));
		};
		// Keep only the last bytes: a long setup log never accumulates in memory.
		if (tailBytes > 0) child.stderr?.on("data", (chunk) => {
			const joined = Buffer.concat([tail, chunk]);
			tail = joined.subarray(Math.max(0, joined.length - tailBytes));
		});
		// A descendant can keep stdout open after the kill, so `close` may never come:
		// settle at the deadline and release the pipes instead of waiting for it.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
			settle(null, "SIGKILL");
		}, deadlineMs);
		child.stdout.on("data", (chunk) => {
			const room = maxOutputBytes - size;
			if (chunk.length > room) truncated = true;
			if (room > 0) {
				chunks.push(chunk.subarray(0, room));
				size += Math.min(room, chunk.length);
			}
		});
		child.once("error", () => settle(null, null));
		child.once("close", settle);
	});
	const info = (path, follow = true) => (follow ? stat(path) : lstat(path)).catch((error) => error);
	const fs = {
		isFile: async (path) => (await stat(path).catch(() => null))?.isFile() === true,
		isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() === true,
		// Only a missing entry is absent; an unreadable one exists (and is then not a writable directory).
		exists: async (path) => {
			const result = await info(path, false);
			return !(result instanceof Error) || !["ENOENT", "ENOTDIR"].includes(result.code);
		},
		realpath: (path) => realpath(path),
		readText: async (path) => {
			const result = await stat(path);
			if (!result.isFile() || result.size > maxTextBytes) throw new Error("Unreadable probe file");
			return readFile(path, "utf8");
		},
		writable: (path) => access(path, constants.W_OK).then(() => true, () => false),
		// A symbolic link, or on Windows a junction (libuv's lstat reports both as links).
		// A missing entry is no link; any other error throws.
		isLink: async (path) => {
			const result = await info(path, false);
			if (!(result instanceof Error)) return result.isSymbolicLink();
			if (["ENOENT", "ENOTDIR"].includes(result.code)) return false;
			throw result;
		},
	};
	return { run, fs };
}

/**
 * createProbes({ platform, env, run, fs, home?, verifyGentleAi?, storage?, storageMany?, pnpmHome? }) -> the eight
 * named collectInventory probes, plus `folders` (Windows only). `env` is the wizard's environment (bootstrap
 * tools first on PATH); `run` and `fs` follow hostAdapters. Each probe returns
 * the shape collectInventory documents, or { available: null } when unknown or
 * failed; errors are never thrown or retained. On Windows, `storage(file)` walks a
 * file the way the bootstrap does (verifyWindowsStorage by default), `storageMany(files)`
 * walks many in one launch (verifyWindowsStorageMany) and `pnpmHome` is the
 * wizard's PNPM_HOME decision (windowsPnpmHome).
 */
export function createProbes({ platform, env, run, fs, home, verifyGentleAi = packageNativeGentleAi,
	storage = platform === "win32" ? (file) => verifyWindowsStorage(file, env) : null,
	storageMany = platform === "win32" ? (files) => verifyWindowsStorageMany(files, env) : null, pnpmHome = null }) {
	const path = pathOf(platform);
	const user = userEnvironment({ platform, env });
	const globalBin = pnpmGlobalBin({ platform, env: user });
	// pnpm 11 global commands need `$PNPM_HOME/bin` on PATH, as in the runner.
	const privateHome = platform === "win32" && pnpmHome?.source === "private";
	const child = globalBin ? childEnvironment(env, platform, globalBin, { privateHome }) : env;
	const userChild = globalBin ? childEnvironment(user, platform, globalBin, { privateHome }) : user;
	/** Every file passes the storage walk; any failure means it is not usable. */
	const trusted = async (files) => {
		if (!storage) return true;
		try {
			for (const file of files) await storage(file);
			return true;
		} catch {
			return false;
		}
	};
	const userHome = home ?? (platform === "win32" ? env.USERPROFILE : env.HOME);
	const output = async (command, argv, runEnv, deadlineMs) => {
		const result = await run(command, argv, { env: runEnv, deadlineMs });
		return succeeded(result) && result.truncated !== true ? String(result.stdout ?? "").trim() : null;
	};
	const persistentOn = async (name) => (await lookPath(name, user, platform, fs)) !== null;
	const roots = bootstrapRoots({ platform, env });
	const marker = platform === "win32" ? new RegExp(BOOTSTRAP_TOOLS.source, "i") : BOOTSTRAP_TOOLS;
	/** A file inside the bootstrap's temporary tools directory. */
	const fromBootstrap = (file) => path.isAbsolute(file) && (roots.some((root) => contains(root, file, platform)) ||
		path.normalize(file).split(path.sep).some((part) => marker.test(part)));

	let listing;
	/** Output of the single `list -g` call, or null when it is unavailable. */
	const globalListing = () => (listing ??= (async () => {
		// A private PNPM_HOME this run has not created yet holds nothing; listing it
		// could make pnpm create it, unprotected, before consent.
		if (privateHome && globalBin && !(await fs.exists(globalBin.pnpmHome))) return "[]";
		const pnpm = globalBin ? await pnpmInvocation(env, platform, fs) : null;
		if (!pnpm) return null;
		return output(pnpm.command, [...pnpm.prefix, "list", "-g", "--depth", "0", "--json"], child, deadlines.list);
	})());
	/** pnpm-global packages by name from that listing; null entries are ambiguous. */
	const globalPackages = async () => {
		const stdout = await globalListing();
		if (stdout === null) return null;
		const projects = JSON.parse(stdout);
		if (!Array.isArray(projects)) return null;
		const packages = new Map();
		for (const project of projects) {
			if (!plainObject(project)) return null;
			for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
				const dependencies = project[field];
				if (dependencies === undefined) continue;
				if (!plainObject(dependencies)) return null;
				for (const [name, entry] of Object.entries(dependencies)) {
					packages.set(name, packages.has(name) || !plainObject(entry) ? null : entry);
				}
			}
		}
		return packages;
	};
	/** A package that is not pnpm-global but whose command resolves elsewhere is unknown, never absent. */
	const globalPackage = async (name, command) => {
		const packages = await globalPackages();
		if (!packages) return { state: "unknown" };
		if (!packages.has(name)) return (await persistentOn(command)) ? { state: "unknown", outsidePnpm: true } : { state: "absent" };
		const entry = packages.get(name);
		const version = exactVersion(entry?.version, STABLE);
		// A main-channel Shell (<stable>-main.<sha12>) is present too: it can be updated.
		const main = typeof entry?.version === "string" && MAIN_BUILD.test(entry.version) ? entry.version : null;
		return entry && (version || main) ? { state: "present", entry, version: version ?? main } : { state: "unknown" };
	};
	// Still unknown (never absent or replaced), but says the command comes from
	// another installation so the wizard can explain the blocker.
	const notPnpmGlobal = (found) => (found.outsidePnpm ? { ...unknown(), outsidePnpm: true } : unknown());
	/** How a command found on the user's PATH runs: as it is on POSIX, through
	 * windowsInvocation (never cmd.exe) on Windows. Null when it cannot run.
	 */
	const invocation = (file) => (platform === "win32" ? windowsInvocation(file, user, { run, fs }) : { command: file, prefix: [] });
	/** The package a command on the user's PATH runs from: its real root and version.
	 * With `followShim`, a Windows shim is followed to the entry it runs.
	 */
	const packageOnPath = async (command, name, followShim = false) => {
		const found = await lookPath(command, user, platform, fs);
		if (!found) return null;
		let start = found;
		if (followShim && platform === "win32") {
			const target = await invocation(found);
			if (!target) return null;
			start = target.prefix[0] ?? target.command;
		}
		let directory = path.dirname(await fs.realpath(start));
		for (let depth = 0; depth < 6; depth += 1) {
			const text = await fs.readText(path.join(directory, "package.json")).catch(() => null);
			if (text !== null) {
				let manifest = null;
				try { manifest = JSON.parse(text); } catch { manifest = null; }
				if (manifest?.name === name && typeof manifest.version === "string") return { root: directory, version: manifest.version };
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		return null;
	};
	/** Where `file` really is (realpath) and, for every link on its path (lstat:
	 * a symbolic link or junction), the real folder that holds that link: whoever
	 * can change that folder can retarget the link. A realpath that merely spells a
	 * component differently, such as an 8.3 short name (RUNNER~1), is no link.
	 * Null when the real location, or whether a component is a link, cannot be read.
	 */
	const canonicalFiles = async (file) => {
		const real = await fs.realpath(file).catch(() => null);
		if (real === null) return null;
		const result = [real];
		for (let current = file; path.dirname(current) !== current; current = path.dirname(current)) {
			let link;
			try {
				link = (await fs.isLink?.(current)) === true;
			} catch {
				return null;
			}
			if (!link) continue;
			const holder = await fs.realpath(path.dirname(current)).catch(() => null);
			if (holder === null) return null;
			if (!result.some((entry) => samePath(entry, holder, platform))) result.push(holder);
		}
		return result;
	};
	let npmRoot;
	/** `npm root -g`, real path, from the user's npm (npmInvocation). */
	const npmGlobalRoot = () => (npmRoot ??= (async () => {
		const npm = await npmInvocation(user, platform, { run, fs });
		const stdout = npm ? await output(npm.command, [...npm.prefix, "root", "-g"], user, deadlines.version) : null;
		const line = stdout?.split(/\r?\n/).at(-1)?.trim() ?? "";
		return path.isAbsolute(line) ? fs.realpath(line).catch(() => null) : null;
	})());
	const shellBin = () => path.join(globalBin.path, platform === "win32" ? "gentle-shell.cmd" : "gentle-shell");
	/** The Pi on the user's PATH outside pnpm: real root, its package version and owner (npm or null). */
	const piOnPath = async () => {
		const found = await packageOnPath("pi", PI_PACKAGE, true);
		if (!found) return null;
		return { root: found.root, version: found.version,
			owner: installOwner({ packageRoot: found.root, pnpmHome: null, npmRoot: await npmGlobalRoot(), name: PI_PACKAGE, platform }) };
	};

	const probes = {
		/** Windows (S6 notice): the folders of the tools the user's PATH resolves (Node,
		 * npm, Go, Pi, Gentle Shell), each command and what it runs, walked in one
		 * storageMany launch where they really are (canonicalFiles): links such as
		 * pnpm's global `node_modules\<pkg>` junction or a `pnpm runtime` node.exe are
		 * followed, never reported, and the folder holding each link is walked too.
		 * A real location that is not on a local drive (a mapped network drive, or a
		 * link to a UNC share) is never walked: it could not be checked, for its tool
		 * only. { node?, npm?, go?, pi?, shell? }: per tool the first concrete finding,
		 * else the first path that could not be checked ({ check: "unchecked", at });
		 * null when nothing fails or the walk cannot finish.
		 */
		async folders() {
			if (!storageMany) return null;
			const files = {};
			const unchecked = new Map();
			for (const [tool, command] of [["node", "node"], ["npm", "npm"], ["go", "go"], ["pi", "pi"], ["shell", "gentle-shell"]]) {
				const found = await lookPath(command, user, platform, fs);
				if (!found) continue;
				const runs = await Promise.resolve().then(() => invocation(found)).catch(() => null);
				files[tool] = [];
				for (const file of [found, ...(runs ? [runs.command, ...runs.prefix] : [])]) {
					const canonical = await canonicalFiles(file);
					if (canonical === null) unchecked.set(file.toLowerCase(), { check: "unchecked", at: file });
					for (const real of canonical ?? []) if (!/^[A-Za-z]:\\/.test(real)) unchecked.set(real.toLowerCase(), { check: "unchecked", at: real });
					files[tool].push(...(canonical ?? [file]));
				}
			}
			const key = (file) => file.toLowerCase();
			const paths = [...new Map(Object.values(files).flat().filter((file) => !unchecked.has(key(file))).map((file) => [key(file), file])).values()];
			if (paths.length === 0 && unchecked.size === 0) return null;
			let results;
			try {
				results = paths.length === 0 ? [] : await storageMany(paths);
			} catch {
				return null;
			}
			const byPath = new Map([...unchecked, ...paths.map((file, index) => [key(file), results[index] ?? null])]);
			const findings = Object.fromEntries(Object.entries(files).map(([tool, list]) => {
				const found = list.map((file) => byPath.get(key(file))).filter(Boolean);
				return [tool, found.find((finding) => finding.check !== "unchecked") ?? found[0]];
			}).filter(([, finding]) => finding));
			return Object.keys(findings).length > 0 ? findings : null;
		},
		/** The installed Gentle Shell for an update: real root, version and owner (pnpm, npm or null). */
		async locateShell() {
			const shell = await globalPackage(SHELL_PACKAGE, "gentle-shell");
			if (shell.state === "present" && typeof shell.entry.path === "string" && path.isAbsolute(shell.entry.path)) {
				return { root: await fs.realpath(shell.entry.path), version: shell.version, owner: "pnpm" };
			}
			if (shell.state !== "unknown" || !shell.outsidePnpm) return null;
			const found = await packageOnPath("gentle-shell", SHELL_PACKAGE, true);
			if (!found) return null;
			return { root: found.root, version: found.version, owner: installOwner({ packageRoot: found.root, pnpmHome: null, npmRoot: await npmGlobalRoot(), platform }) };
		},
		/** The single installed Pi for an update: real root, version and owner (pnpm, npm or null). */
		async locatePi() {
			const pi = await globalPackage(PI_PACKAGE, "pi");
			if (pi.state === "present" && typeof pi.entry.path === "string" && path.isAbsolute(pi.entry.path)) {
				return { root: await fs.realpath(pi.entry.path), version: pi.version, owner: "pnpm" };
			}
			return pi.state === "unknown" && pi.outsidePnpm ? piOnPath() : null;
		},
		async node() {
			const persistent = await lookPath("node", user, platform, fs);
			const bootstrap = await lookPath("node", env, platform, fs);
			let node = persistent ?? bootstrap;
			if (!node) return absent();
			if (!spawnable(node, platform)) return unknown();
			const nodeVersion = async (file) => exactVersion(await output(file, ["--version"], env, deadlines.version), NODE_VERSION);
			let version = await nodeVersion(node);
			if (!version) return unknown();
			// An older Node on the user's PATH is left as it is: the bootstrap's verified
			// Node runs the installer, so it is reported (bootstrap-only) with the older one found.
			let found = null;
			if (persistent && bootstrap && persistent !== bootstrap && !atLeast(version, requirements.node) && spawnable(bootstrap, platform)) {
				const pinned = await nodeVersion(bootstrap);
				if (pinned && atLeast(pinned, requirements.node)) [found, node, version] = [version, bootstrap, pinned];
			}
			// A usable npm must resolve without bootstrap tools, as in a fresh terminal.
			let npm = null;
			try {
				npm = typeof (await genuineNpm(userChild, platform, node, { run, fs }, globalBin)) === "object";
			} catch {
				npm = null;
			}
			return { available: true, version, usable: true, persistent: persistent !== null && found === null, npm, ...(found ? { found } : {}) };
		},
		async pnpm() {
			const pnpm = await pnpmInvocation(env, platform, fs);
			// Without the direct handoff a Windows .cmd shim cannot run with shell:false.
			if (!pnpm) return (await lookPath("pnpm", env, platform, fs)) ? unknown() : absent();
			const version = exactVersion(await output(pnpm.command, [...pnpm.prefix, "--version"], child, deadlines.version), STABLE);
			if (!version) return unknown();
			// pnpm checks its Node engine at startup; the runner's argv is verified for pnpm 11 only.
			const compatible = Number(version.split(".")[0]) === PNPM_MAJOR && atLeast(version, requirements.pnpm);
			// The bootstrap's own pnpm (POSIX PATH or Windows handoff entry) is bootstrap-only
			// even next to the user's pnpm, which it acquired because that one is incompatible.
			if (!fromBootstrap(pnpm.prefix[0] ?? pnpm.command)) {
				return { available: true, version, usable: true, compatible, persistent: await persistentOn("pnpm") };
			}
			// That pnpm's version, read in the user's environment. On Windows only when its
			// shim and what it runs pass the storage walk: an untrusted pnpm never runs.
			const own = await lookPath("pnpm", user, platform, fs);
			const ownPnpm = own ? await invocation(own) : null;
			const runnable = ownPnpm !== null && await trusted([own, ownPnpm.command, ...ownPnpm.prefix]);
			const result = runnable ? await run(ownPnpm.command, [...ownPnpm.prefix, "--version"], { env: user, cwd: path.parse(own).root, deadlineMs: deadlines.version }) : null;
			const found = succeeded(result) && result.truncated !== true ? exactVersion(result.stdout, STABLE) : null;
			const usableFound = found !== null && Number(found.split(".")[0]) === PNPM_MAJOR && atLeast(found, requirements.pnpm);
			// Persisting pnpm writes $PNPM_HOME/bin: a user's pnpm there with a stable version
			// is reported as it is (an incompatible one blocks), never replaced or downgraded.
			// One that fails the walk (untrusted), or whose shim is not recognized or whose
			// version cannot be read (unchecked), is never run again: the bootstrap's pnpm is
			// reported in its place, as persistent, so nothing is persisted over the user's.
			if (own && globalBin && samePath(path.dirname(own), globalBin.path, platform)) {
				if (found) return { available: true, version: found, usable: true, compatible: usableFound, persistent: true, inGlobalBin: true };
				return { available: true, version, usable: true, compatible, persistent: true, inGlobalBin: true,
					...(ownPnpm !== null && !runnable ? { untrusted: true } : { unchecked: true }) };
			}
			const replaced = found !== null && !usableFound;
			return { available: true, version, usable: true, compatible, persistent: false, ...(replaced ? { found } : {}) };
		},
		// Only a Pi older than the minimum reports its owner (pnpm or npm): the one the installer updates.
		async pi() {
			const pi = await globalPackage(PI_PACKAGE, "pi");
			const older = (version) => !MAIN_BUILD.test(version) && !atLeast(version, requirements.pi);
			if (pi.state === "present") return { available: true, version: pi.version, usable: true, ...(older(pi.version) ? { owner: "pnpm" } : {}) };
			if (pi.state === "absent" || !pi.outsidePnpm) return pi.state === "absent" ? absent() : unknown();
			// Another installation of Pi: reused as long as it reports a stable version.
			const command = await lookPath("pi", user, platform, fs);
			const invoked = command ? await invocation(command) : null;
			const version = invoked ? /(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/.exec(await output(invoked.command, [...invoked.prefix, "--version"], user, deadlines.version) ?? "") : null;
			if (!version) return notPnpmGlobal(pi);
			const found = { available: true, version: version[1], usable: true, external: true };
			if (!older(found.version)) return found;
			// npm owns it only when its package in npm's global root reports that same version.
			const located = await piOnPath().catch(() => null);
			return located?.owner === "npm" && located.version === found.version ? { ...found, owner: "npm" } : found;
		},
		async shell() {
			const shell = await globalPackage(SHELL_PACKAGE, "gentle-shell");
			if (shell.state === "present") return { available: true, version: shell.version, usable: await fs.isFile(shellBin()), global: true, owner: "pnpm" };
			if (shell.state === "absent" || !shell.outsidePnpm) return shell.state === "absent" ? absent() : unknown();
			// Installed by npm only when it really lives in npm's global root; a linked checkout stays unknown.
			// A Windows shim is followed to the entry it runs, as for Pi.
			const found = await packageOnPath("gentle-shell", SHELL_PACKAGE, true);
			const owner = found ? installOwner({ packageRoot: found.root, pnpmHome: null, npmRoot: await npmGlobalRoot(), platform }) : null;
			const version = found && (exactVersion(found.version, STABLE) ?? (MAIN_BUILD.test(found.version) ? found.version : null));
			return owner === "npm" && version ? { available: true, version, usable: true, global: true, owner } : notPnpmGlobal(shell);
		},
		async gentleAi() {
			const shell = await globalPackage(SHELL_PACKAGE, "gentle-shell");
			if (shell.state === "absent") return absent();
			// Only this package version's native pin is the requirement being checked.
			if (shell.state !== "present" || shell.version !== requirements.shell) return unknown();
			if (typeof shell.entry.path !== "string" || !path.isAbsolute(shell.entry.path)) return unknown();
			const [root, pnpmHome] = [await fs.realpath(shell.entry.path), await fs.realpath(globalBin.pnpmHome)];
			if (!contains(pnpmHome, root, platform)) return unknown();
			if (!(await fs.isFile(gentleAiBinaryPath(root, platform)))) return absent();
			const verdict = await verifyGentleAi({ packageRoot: root, platform, env, home: userHome });
			return verdict?.ok === true ? { available: true, version: requirements.gentleAi, usable: true, compatible: true } : unknown();
		},
		async go() {
			const go = await lookPath("go", user, platform, fs);
			if (!go) return absent();
			if (!spawnable(go, platform)) return unknown();
			const version = exactVersion(await output(go, ["version"], user, deadlines.version), GO_VERSION);
			return version ? { available: true, version, usable: true } : unknown();
		},
		async globalBin() {
			if (!globalBin) return unknown();
			// Nearest existing ancestor (or the directory itself); nothing is created.
			let current = globalBin.path;
			while (!(await fs.exists(current))) {
				const parent = path.dirname(current);
				if (parent === current) return unknown();
				current = parent;
			}
			const writable = (await fs.isDirectory(current)) && (await fs.writable(current));
			return { available: true, path: globalBin.path, writable, onPath: globalBin.onPath };
		},
		async setup() {
			// Setup readiness of an existing Shell has no read-only evidence. Only the
			// pinned stack this pnpm installed (an earlier run whose setup did not
			// finish) is recoverable: its public `gentle-shell setup` may be rerun.
			const shell = await globalPackage(SHELL_PACKAGE, "gentle-shell");
			if (shell.state === "absent") return false;
			if (shell.state !== "present") return unknown();
			const root = await recoverableStackRoot(await globalListing(), globalBin.pnpmHome, platform, fs);
			return root === null ? unknown() : { available: true, recoverable: true };
		},
	};
	return Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, async () => {
		try {
			return await probe();
		} catch {
			// Do not retain probe errors: they can contain private paths or credentials.
			return unknown();
		}
	}]));
}
