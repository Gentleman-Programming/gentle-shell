import { spawn as spawnProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { gentleAiBinaryPath } from "../runtime/gentle-ai-binary.mjs";
import { pnpmGlobalBin, requirements } from "./installer-preflight.mjs";
import {
	PI_PACKAGE,
	SHELL_PACKAGE,
	childEnvironment,
	contains,
	genuineNpm,
	lookPath,
	packageNativeGentleAi,
	pnpmInvocation,
	recoverableStackRoot,
	spawnable,
	succeeded,
} from "./installer-runner.mjs";

// Real host probes for collectInventory. Every effect goes through injected
// adapters; probes only run fixed read-only argv (`--version`, `go version`,
// `pnpm list -g`) and never write, create directories or run setup/postinstall.

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
 * `spawn` is injectable only for trusted tests.
 */
export function hostAdapters({ maxOutputBytes = 1024 * 1024, maxTextBytes = 1024 * 1024, spawn = spawnProcess } = {}) {
	const run = (command, argv, { env, deadlineMs, stderrTail }) => new Promise((resolve) => {
		let size = 0;
		let truncated = false;
		let timedOut = false;
		const chunks = [];
		const tailBytes = Number.isSafeInteger(stderrTail) && stderrTail > 0 ? Math.min(stderrTail, 4096) : 0;
		let tail = Buffer.alloc(0);
		const withTail = (result) => (tailBytes > 0 ? { ...result, stderrTail: tail.toString("utf8") } : result);
		let child;
		try {
			child = spawn(command, argv, { env, shell: false, stdio: ["ignore", "pipe", tailBytes > 0 ? "pipe" : "ignore"], windowsHide: true });
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
	};
	return { run, fs };
}

/**
 * createProbes({ platform, env, run, fs, home?, verifyGentleAi? }) -> the eight
 * named collectInventory probes. `env` is the wizard's environment (bootstrap
 * tools first on PATH); `run` and `fs` follow hostAdapters. Each probe returns
 * the shape collectInventory documents, or { available: null } when unknown or
 * failed; errors are never thrown or retained.
 */
export function createProbes({ platform, env, run, fs, home, verifyGentleAi = packageNativeGentleAi }) {
	const path = pathOf(platform);
	const user = userEnvironment({ platform, env });
	const globalBin = pnpmGlobalBin({ platform, env: user });
	// pnpm 11 global commands need `$PNPM_HOME/bin` on PATH, as in the runner.
	const child = globalBin ? childEnvironment(env, platform, globalBin) : env;
	const userChild = globalBin ? childEnvironment(user, platform, globalBin) : user;
	const userHome = home ?? (platform === "win32" ? env.USERPROFILE : env.HOME);
	const output = async (command, argv, runEnv, deadlineMs) => {
		const result = await run(command, argv, { env: runEnv, deadlineMs });
		return succeeded(result) && result.truncated !== true ? String(result.stdout ?? "").trim() : null;
	};
	const persistentOn = async (name) => (await lookPath(name, user, platform, fs)) !== null;

	let listing;
	/** Output of the single `list -g` call, or null when it is unavailable. */
	const globalListing = () => (listing ??= (async () => {
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
		if (!packages.has(name)) return { state: (await persistentOn(command)) ? "unknown" : "absent" };
		const entry = packages.get(name);
		const version = exactVersion(entry?.version, STABLE);
		return entry && version ? { state: "present", entry, version } : { state: "unknown" };
	};
	const shellBin = () => path.join(globalBin.path, platform === "win32" ? "gentle-shell.cmd" : "gentle-shell");

	const probes = {
		async node() {
			const persistent = await lookPath("node", user, platform, fs);
			const node = persistent ?? await lookPath("node", env, platform, fs);
			if (!node) return absent();
			if (!spawnable(node, platform)) return unknown();
			const version = exactVersion(await output(node, ["--version"], env, deadlines.version), NODE_VERSION);
			if (!version) return unknown();
			// A genuine npm must resolve without bootstrap tools, as in a fresh terminal.
			let npm = null;
			try {
				npm = typeof (await genuineNpm(userChild, platform, node, { run, fs }, globalBin)) === "object";
			} catch {
				npm = null;
			}
			return { available: true, version, usable: true, persistent: persistent !== null, npm };
		},
		async pnpm() {
			const pnpm = await pnpmInvocation(env, platform, fs);
			// Without the direct handoff a Windows .cmd shim cannot run with shell:false.
			if (!pnpm) return (await lookPath("pnpm", env, platform, fs)) ? unknown() : absent();
			const version = exactVersion(await output(pnpm.command, [...pnpm.prefix, "--version"], child, deadlines.version), STABLE);
			if (!version) return unknown();
			// pnpm checks its Node engine at startup; the runner's argv is verified for pnpm 11 only.
			const compatible = Number(version.split(".")[0]) === PNPM_MAJOR && atLeast(version, requirements.pnpm);
			return { available: true, version, usable: true, compatible, persistent: await persistentOn("pnpm") };
		},
		async pi() {
			const pi = await globalPackage(PI_PACKAGE, "pi");
			if (pi.state !== "present") return pi.state === "absent" ? absent() : unknown();
			return { available: true, version: pi.version, usable: true };
		},
		async shell() {
			const shell = await globalPackage(SHELL_PACKAGE, "gentle-shell");
			if (shell.state !== "present") return shell.state === "absent" ? absent() : unknown();
			return { available: true, version: shell.version, usable: await fs.isFile(shellBin()), global: true };
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
