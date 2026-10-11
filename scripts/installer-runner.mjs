import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
	gentleAiBinaryPath,
	gentleAiDevBinaryOverrideConfigured,
	resolveGentleAiBinary,
} from "../runtime/gentle-ai-binary.mjs";
import { PI_INSTALL_VERSION, goAcquisition, persistencePins, pnpmGlobalBin, requirements } from "./installer-preflight.mjs";
import { GENTLE_AI_REPOSITORY, MainChannelError, SHELL_REPOSITORY, installOwner, mainVersion } from "./main-channel.mjs";
import { windowsShim } from "./installer-windows.mjs";

// Standard installation runner: one fixed, consented global pnpm installation
// of Pi plus gentle-pi, then the public `gentle-shell setup`. Every adapter is
// injected by trusted local code; requests carry no commands, URLs, roots or env.
// When Node is bootstrap-only or no usable npm resolves, fixed steps first persist
// node, npm and pnpm under PNPM_HOME through pnpm itself. When an earlier run
// installed the pinned stack but stopped in setup, a fixed recovery re-verifies
// that stack and reruns only `gentle-shell setup` (and `pnpm setup`), never `add -g`.
// An older Pi that pnpm or npm owns is first updated with that package manager.
// When a build needs Go and the user's is missing or older, the installer's pinned
// Go is acquired first and given only to the build children, first on PATH.

/** Pi version installed next to gentle-pi (optional peer, resolved in one add). */
export { PI_INSTALL_VERSION };
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const SHELL_PACKAGE = "gentle-pi";

/** Every `reason` a `blocked` outcome can carry (for host guidance; no behavior). */
export const blockedReasons = Object.freeze([
	"invalid-request",
	"consent-required",
	"preflight-blocked",
	"go-required",
	"unsupported-plan",
	"pnpm-home-unknown",
	"pnpm-home-changed",
	"node-unavailable",
	"pnpm-unavailable",
	"npm-unavailable",
	"npm-shadowed",
	"global-bin-mismatch",
	"global-list-unavailable",
	"existing-stack",
	"existing-stack-unverified",
]);
/** Every `failedStep` a `failed` outcome can carry (for host guidance; no behavior). */
export const failedSteps = Object.freeze([
	"prepare-pnpm-home",
	"persist-node",
	"persist-package-managers",
	"persist-npm",
	"persist-pnpm",
	"verify-persistent-runtime",
	"verify-persistent-pnpm",
	"check-npm",
	"configure-npm-prefix",
	"acquire-go",
	"verify-go",
	"install-global",
	"verify-global-list",
	"verify-shell-bin",
	"verify-gentle-ai",
	"shell-setup",
	"persist-path",
	"build-gentle-ai-main",
	"install-shell-main",
	"record-channel",
	"install-pi",
	"update-shell",
	"verify-updated-shell",
	"update-pi",
	"verify-updated-pi",
	"verify-installed-pi",
]);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const deadlines = Object.freeze({ probe: 30 * SECOND, install: 20 * MINUTE, setup: 20 * MINUTE });

// Exact descriptors planPreflight can emit; anything else is a foreign request.
const knownActions = Object.freeze({
	"acquire-node": { kind: "acquire", target: "node", version: requirements.node },
	"verify-node": { kind: "verify", target: "node" },
	"acquire-pnpm": { kind: "acquire", target: "pnpm", version: requirements.pnpm },
	"verify-pnpm": { kind: "verify", target: "pnpm" },
	"setup-global-bin": { kind: "setup", target: "globalBin" },
	"persist-node": { kind: "persist-runtime", target: "node", version: persistencePins.node },
	"persist-package-managers": { kind: "install-global", target: "package-managers" },
	"configure-npm-prefix": { kind: "configure", target: "npm-prefix" },
	"persist-npm": { kind: "install-global", target: "npm", version: persistencePins.npm },
	"persist-pnpm": { kind: "install-global", target: "pnpm", version: persistencePins.pnpm },
	"acquire-go": { kind: "acquire", target: "go", version: goAcquisition.version },
	"verify-go": { kind: "verify", target: "go" },
	"install-pi": { kind: "install-global", target: "pi", version: requirements.pi },
	"install-shell": { kind: "install-global", target: "shell", version: requirements.shell },
	"provision-native": { kind: "existing-installer", target: "gentleAi", version: requirements.gentleAi },
	"setup-shell": { kind: "normal-setup", target: "shell" },
	"verify-readiness": { kind: "verify", target: "stack" },
	"build-gentle-ai-main": { kind: "build-native-main", target: "gentleAi" },
	"install-shell-main": { kind: "install-global", target: "shell" },
	"record-channel": { kind: "configure", target: "channel" },
	"update-shell-release": { kind: "upgrade", target: "shell" },
	"update-shell-main": { kind: "upgrade", target: "shell" },
	"update-pi": { kind: "upgrade", target: "pi", version: PI_INSTALL_VERSION },
});
// The clean-stack path: both global packages are missing.
const requiredActions = ["install-pi", "install-shell", "setup-shell", "verify-readiness"];
const optionalActions = ["setup-global-bin"];
// Pi already installed: only Gentle Shell is added (never Pi).
const shellOnlyActions = ["install-shell", "setup-shell", "verify-readiness"];
// An existing Gentle Shell: exactly one update, then setup; a missing Pi is installed first.
const updateActions = ["update-shell-release", "update-shell-main"];
// Pi alone (a current Gentle Shell): an older owned Pi's update, or the installer's
// Pi added next to an older one neither pnpm nor npm owns; then readiness.
const piOnlyVariants = Object.freeze([["update-pi", "verify-readiness"], ["install-pi", "verify-readiness"]]);
// The main channel overlay: all three after a release installation, or none.
const mainActions = ["build-gentle-ai-main", "install-shell-main", "record-channel"];
// The pinned Go: both, only when preflight recorded a missing or older Go, or none.
const goActions = ["acquire-go", "verify-go"];
// Setup recovery: the pinned stack this pnpm installed is present (planPreflight
// saw a recoverable setup), so only setup and the optional PATH step remain.
const recoveryActions = ["setup-shell", "verify-readiness"];
// Runtime persistence is one of these exact sets planPreflight emits, or nothing:
// bootstrap-only Node (with pnpm, or only npm next to a persistent pnpm), or a
// persistent Node missing npm and/or pnpm (one add -g).
const persistenceVariants = Object.freeze([
	["persist-node", "persist-package-managers", "configure-npm-prefix"],
	["persist-node", "persist-npm", "configure-npm-prefix"],
	["persist-package-managers"],
	["persist-npm"],
	["persist-pnpm"],
]);
const persistenceActions = [...new Set(persistenceVariants.flat())];

const MAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-main\.[0-9a-f]{12}$/;
function stable(version) {
	const match = typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
	return match ? match.slice(1).map(Number) : null;
}
function atLeast(version, minimum) {
	const [left, right] = [stable(version), stable(minimum)];
	if (!left || !right) return false;
	for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
	return true;
}
if (!atLeast(PI_INSTALL_VERSION, requirements.pi)) throw new Error("Pi install pin is below the peer minimum");

function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function onlyKeys(value, allowed) {
	return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

/** Accept only `{ plan, consent }` where plan is an unmodified planPreflight result. */
function validRequest(request) {
	if (!onlyKeys(request, ["plan", "consent"]) || !onlyKeys(request.plan, ["tools", "blockers", "actions", "ready"])) return false;
	const { tools, blockers, actions, ready } = request.plan;
	if (!plainObject(tools) || !Array.isArray(blockers) || !Array.isArray(actions) || typeof ready !== "boolean") return false;
	const ids = new Set();
	for (const action of actions) {
		const expected = knownActions[action?.id];
		if (!expected || ids.has(action.id) || !onlyKeys(action, ["id", "kind", "target", "version"])) return false;
		if (Object.keys(action).length !== Object.keys(expected).length + 1) return false;
		if (Object.entries(expected).some(([key, value]) => action[key] !== value)) return false;
		ids.add(action.id);
	}
	return true;
}

/** Gates that need no process: returns a blocked reason or null. */
function planGate(plan, platform) {
	if (plan.blockers.length > 0) return "preflight-blocked";
	const all = plan.actions.map((action) => action.id);
	const acquiringGo = goActions.filter((id) => all.includes(id)).length;
	if (acquiringGo === 1 || (acquiringGo === 2 && plan.tools.go?.status !== "needs-acquire")) return "unsupported-plan";
	const goReady = plan.tools.go?.status === "reusable" || acquiringGo === 2;
	const overlay = mainActions.filter((id) => all.includes(id));
	if (overlay.length > 0 && (overlay.length !== mainActions.length || !goReady)) return "unsupported-plan";
	const ids = all.filter((id) => !mainActions.includes(id) && !goActions.includes(id));
	const only = (allowed) => ids.every((id) => allowed.includes(id));
	// All or nothing, like the persistence variants: never part of an installation.
	const recovery = recoveryActions.every((id) => ids.includes(id)) && only([...recoveryActions, ...optionalActions]);
	// A Pi update needs the older, owned Pi preflight recorded, and never installs Pi as well.
	const updatingPi = ids.includes("update-pi");
	if (updatingPi && (ids.includes("install-pi") || plan.tools.pi?.status !== "needs-update")) return "unsupported-plan";
	const piOnly = overlay.length === 0 && plan.tools.shell?.status === "reusable" &&
		piOnlyVariants.some((variant) => variant.every((id) => ids.includes(id)) && only(variant)) &&
		(updatingPi || ["unavailable", "needs-install"].includes(plan.tools.pi?.status));
	// gentle-pi's postinstall may build Gentle AI from source on Windows. A recovery
	// runs no postinstall: its binary is verified. A Pi-only update touches no
	// Gentle Shell package either. Go is acquired only for a build that uses it.
	const windowsBuild = platform === "win32" && !recovery && !piOnly;
	if (acquiringGo === 2 && overlay.length === 0 && !ids.includes("update-shell-main") && !windowsBuild) return "unsupported-plan";
	if (windowsBuild && !goReady) return "go-required";
	const persisting = persistenceActions.filter((id) => ids.includes(id));
	if (persisting.length > 0 && !persistenceVariants.some((variant) =>
		variant.length === persisting.length && variant.every((id) => persisting.includes(id)))) return "unsupported-plan";
	const updating = updateActions.filter((id) => ids.includes(id));
	if (updating.length > 0) {
		const valid = updating.length === 1 && overlay.length === 0 && ["setup-shell", "verify-readiness"].every((id) => ids.includes(id)) &&
			only([...updating, "install-pi", "update-pi", "setup-shell", "verify-readiness"]) &&
			(updating[0] !== "update-shell-main" || goReady);
		return valid ? null : "unsupported-plan";
	}
	const clean = requiredActions.every((id) => ids.includes(id)) && only([...requiredActions, ...optionalActions, ...persistenceActions]);
	// The same actions as a forged recovery plus install-shell: the tools must say Shell
	// is missing and Pi reusable, or older and updated first.
	const shellOnly = shellOnlyActions.every((id) => ids.includes(id)) && !ids.includes("install-pi") &&
		plan.tools.shell?.status === "unavailable" && plan.tools.pi?.status === (updatingPi ? "needs-update" : "reusable") &&
		only([...shellOnlyActions, "update-pi", ...optionalActions, ...persistenceActions]);
	return clean || shellOnly || recovery || piOnly ? null : "unsupported-plan";
}

function pathKeyOf(env, platform) {
	return platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path" : "PATH";
}
function envValue(env, name, platform) {
	const key = platform === "win32" ? Object.keys(env).find((candidate) => candidate.toUpperCase() === name) : name;
	return key === undefined ? undefined : env[key];
}

/** Child env: the user's env plus PNPM_HOME and `$PNPM_HOME/bin` first on PATH.
 * With a private Windows PNPM_HOME (S6), pnpm's config, cache and state move into
 * it too, unless the user set those folders: pnpm otherwise keeps them under
 * %LOCALAPPDATA%, which another principal may write, and trusts its cached registry
 * metadata for exact versions. TEMP and TMP always move to its `tmp` folder
 * (created by prepare-pnpm-home), so a postinstall's os.tmpdir(), such as the
 * Gentle AI source build, stays private. Only these children get them; nothing
 * persists them.
 */
export function childEnvironment(env, platform, globalBin, { privateHome = false } = {}) {
	const path = platform === "win32" ? win32 : posix;
	const key = pathKeyOf(env, platform);
	const rest = String(env[key] ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
	const isolate = platform === "win32" && privateHome;
	const xdg = isolate ? Object.fromEntries([["XDG_CONFIG_HOME", ".config"], ["XDG_CACHE_HOME", ".cache"], ["XDG_STATE_HOME", ".state"]]
		.filter(([name]) => envValue(env, name, platform) === undefined).map(([name, folder]) => [name, win32.join(globalBin.pnpmHome, folder)])) : {};
	const temp = isolate ? win32.join(globalBin.pnpmHome, "tmp") : null;
	const kept = isolate ? Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:TEMP|TMP)$/i.test(name))) : env;
	return { ...kept, PNPM_HOME: globalBin.pnpmHome, ...xdg, ...(temp ? { TEMP: temp, TMP: temp } : {}), [key]: [globalBin.path, ...rest].join(path.delimiter) };
}

/** A build child's env: `env` with the pinned Go's bin directory first on PATH. */
export function goFirstEnvironment(env, platform, goPath) {
	const path = platform === "win32" ? win32 : posix;
	const key = pathKeyOf(env, platform);
	const rest = String(env[key] ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
	return { ...env, [key]: [path.dirname(goPath), ...rest].join(path.delimiter) };
}

/** gentle-shell setup gets no bootstrap handoff keys (case-insensitive on Windows). */
function setupEnvironment(child, platform) {
	const bootstrap = platform === "win32" ? /^GENTLE_(BOOTSTRAP|INSTALL)_/i : /^GENTLE_(BOOTSTRAP|INSTALL)_/;
	return Object.fromEntries(Object.entries(child).filter(([key]) => !bootstrap.test(key)));
}

/** pnpm comes from the bootstrap handoff, or a PATH executable on POSIX only. */
export async function pnpmInvocation(env, platform, fs) {
	const path = platform === "win32" ? win32 : posix;
	const node = env.GENTLE_INSTALL_PNPM_NODE;
	const entry = env.GENTLE_INSTALL_PNPM_ENTRY;
	if (node && entry) {
		return path.isAbsolute(node) && path.isAbsolute(entry) ? { command: node, prefix: [entry] } : null;
	}
	// A Windows .cmd shim cannot be spawned with shell:false; require the direct
	// handoff: Node plus pnpm's JS entry, or a native pnpm.exe on its own.
	if (platform === "win32") {
		const command = env.GENTLE_INSTALL_PNPM_COMMAND;
		return command && win32.isAbsolute(command) && win32.extname(command).toLowerCase() === ".exe" ? { command, prefix: [] } : null;
	}
	for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(directory)) continue;
		const candidate = path.join(directory, "pnpm");
		if (await fs.isFile(candidate)) return { command: candidate, prefix: [] };
	}
	return null;
}

/** Windows PATHEXT extensions in order: lowercased, dot-prefixed, default .com/.exe/.bat/.cmd. */
function pathExtensions(env) {
	return String(envValue(env, "PATHEXT", "win32") || ".com;.exe;.bat;.cmd").toLowerCase().split(";")
		.filter((extension) => extension.length > 0).map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
}

/** A path on a local drive (`C:\...`). UNC, `\\?\`, `\\.\` and drive-less rooted
 * paths are not: even looking one up can reach a remote share. */
const LOCAL_DRIVE = /^[A-Za-z]:\\/;

/** First `name` the way Go's exec.LookPath (used by Gentle AI) finds it: each
 * absolute PATH directory in order and, on Windows, every PATHEXT extension in
 * PATHEXT order (lowercased, dot-prefixed, default .com/.exe/.bat/.cmd). On
 * Windows only local drive directories are searched; any other one is skipped,
 * like a relative one, and never touched.
 */
export async function lookPath(name, env, platform, fs) {
	const path = platform === "win32" ? win32 : posix;
	const extensions = platform === "win32" ? pathExtensions(env) : [""];
	for (const directory of String(env[pathKeyOf(env, platform)] ?? "").split(path.delimiter)) {
		if (!path.isAbsolute(directory) || (platform === "win32" && !LOCAL_DRIVE.test(directory))) continue;
		for (const extension of extensions) {
			const candidate = path.join(directory, `${name}${extension}`);
			if (await fs.isFile(candidate)) return candidate;
		}
	}
	return null;
}

/** A Windows `.cmd`/`.bat` shim cannot run with shell:false; executables can. */
export function spawnable(file, platform) {
	return platform !== "win32" || [".exe", ".com"].includes(win32.extname(file).toLowerCase());
}

/** How a Windows command runs with shell:false, never through cmd.exe: an .exe
 * as it is, or what a known shim (windowsShim) runs, its native target or its
 * JS entry with the Node it selects (an absolute node.exe it names, its sibling
 * node.exe, else the first node on PATH, which must be an .exe). A native target
 * without an extension resolves like CMD resolves it, through PATHEXT in order,
 * and runs only when that first match is an .exe. A `pnpm.cmd` runs only pnpm's
 * own `node_modules\pnpm\bin\pnpm.[cm]js` entry (never Corepack's). npm's own
 * npm.cmd keeps its redirect: it asks npm for the global prefix (from the drive
 * root, like any probe) and runs the npm-cli.js installed there, when there is
 * one. The command, the Node and npm's prefix must be local drive paths.
 * Returns { command, prefix } or null when the command is anything else.
 */
export async function windowsInvocation(file, env, adapters) {
	const { fs } = adapters;
	if (!LOCAL_DRIVE.test(file)) return null;
	const extension = win32.extname(file).toLowerCase();
	if (extension === ".exe") return (await fs.isFile(file)) ? { command: file, prefix: [] } : null;
	if (extension !== ".cmd") return null;
	const shim = windowsShim(await fs.readText(file).catch(() => null));
	if (!shim) return null;
	const directory = win32.dirname(file);
	if (shim.exe !== undefined) {
		let exe = win32.resolve(directory, shim.exe);
		// @pnpm/exe hard-links its binary under both names; the shim may name either.
		if (win32.extname(exe) === "") {
			let first = null;
			for (const candidate of pathExtensions(env)) if (first === null && (await fs.isFile(`${exe}${candidate}`))) first = `${exe}${candidate}`;
			if (first === null) return null;
			exe = first;
		}
		return win32.extname(exe).toLowerCase() === ".exe" && (await fs.isFile(exe)) ? { command: exe, prefix: [] } : null;
	}
	const sibling = win32.join(directory, "node.exe");
	const node = shim.node ?? ((await fs.isFile(sibling)) ? sibling : await lookPath("node", env, "win32", fs));
	if (!node || !LOCAL_DRIVE.test(node) || !spawnable(node, "win32") || !(await fs.isFile(node))) return null;
	const npmCli = (root) => win32.join(root, "node_modules", "npm", "bin", "npm-cli.js");
	let entry = shim.npm ? npmCli(directory) : win32.resolve(directory, shim.entry);
	const pnpmEntry = (path) => entryShape(path, win32, "pnpm", "pnpm.cjs") || entryShape(path, win32, "pnpm", "pnpm.mjs");
	if (win32.basename(file).toLowerCase() === "pnpm.cmd" && (shim.npm || !pnpmEntry(entry))) return null;
	if (shim.npm) {
		const query = shim.npm === "prefix-js" ? [win32.join(directory, "node_modules", "npm", "bin", "npm-prefix.js")] : [entry, "prefix", "-g"];
		// Without npm-prefix.js, npm.cmd's FOR /F reads no line and keeps the bundled npm.
		if (await fs.isFile(query[0])) {
			const result = await adapters.run(node, query, { env, cwd: win32.parse(node).root, deadlineMs: deadlines.probe });
			const prefix = succeeded(result) && result.truncated !== true
				? String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) : undefined;
			if (prefix && LOCAL_DRIVE.test(prefix) && (await fs.isFile(npmCli(prefix)))) entry = npmCli(prefix);
		}
	}
	return (await fs.isFile(entry)) ? { command: node, prefix: [entry] } : null;
}

/** The user's npm as { command, prefix }: the first npm on PATH, run through
 * windowsInvocation on Windows. Null when none resolves.
 */
export async function npmInvocation(env, platform, adapters) {
	const npm = await lookPath("npm", env, platform, adapters.fs);
	if (!npm) return null;
	return platform === "win32" ? windowsInvocation(npm, env, adapters).catch(() => null) : { command: npm, prefix: [] };
}

/** runUpgrade's `invocation` adapter on Windows: npm through npmInvocation, any
 * other command (pnpm) through windowsInvocation of the first one on PATH, or,
 * with `handoff` (the wizard), pnpm from the bootstrap handoff (pnpmInvocation).
 * Never a .cmd with shell:false. Undefined on POSIX, where the command `which`
 * finds runs as it is.
 */
export function upgradeInvocation({ platform, env, run, fs, handoff = false }) {
	if (platform !== "win32") return undefined;
	const adapters = { run, fs };
	return async (name) => {
		if (name === "npm") return npmInvocation(env, platform, adapters);
		if (name === "pnpm" && handoff) return pnpmInvocation(env, platform, fs);
		const file = await lookPath(name, env, platform, fs);
		return file ? windowsInvocation(file, env, adapters).catch(() => null) : null;
	};
}

/** `.../node_modules/<name>/bin/<file>`: a package's own bin entry. */
function entryShape(entry, path, name, file) {
	const packageDir = path.dirname(path.dirname(entry));
	return path.basename(entry) === file && path.basename(path.dirname(entry)) === "bin" &&
		path.basename(packageDir) === name && path.basename(path.dirname(packageDir)) === "node_modules";
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The single `node_modules/<name>/bin/<file>` target a pnpm shim names, absolute
 * or relative to the shim directory (`$basedir/` on POSIX, `%~dp0\` or `%dp0%\`
 * on Windows).
 */
function shimTarget(text, shim, platform, name, file) {
	const path = platform === "win32" ? win32 : posix;
	const tail = `node_modules${path.sep}${name}${path.sep}bin${path.sep}${file}`;
	const pattern = platform === "win32"
		? new RegExp(`"(%~?dp0%?\\\\)?([^"%]*\\\\${escapeRegExp(tail)})"`, "gi")
		: new RegExp(`"(\\$basedir\\/)?([^"$]*\\/${escapeRegExp(tail)})"`, "g");
	const targets = new Set();
	for (const [, relative, target] of String(text).matchAll(pattern)) {
		const resolved = relative ? path.join(path.dirname(shim), target) : target;
		if (!path.isAbsolute(resolved)) return null;
		targets.add(path.normalize(resolved));
	}
	return targets.size === 1 ? [...targets][0] : null;
}

/** The package entry a pnpm global shim in `$PNPM_HOME/bin` runs: a POSIX
 * symlink to it, or the single target named in the shim text. Either way its
 * realpath must be a `<name>` bin entry inside PNPM_HOME. Returns it or null.
 */
async function globalShimEntry(shim, name, file, platform, globalBin, fs) {
	const path = platform === "win32" ? win32 : posix;
	let entry = platform === "win32" ? null : await fs.realpath(shim);
	if (entry === null || !entryShape(entry, path, name, file)) {
		const target = shimTarget(await fs.readText(shim), shim, platform, name, file);
		if (!target) return null;
		entry = await fs.realpath(target);
	}
	if (!entryShape(entry, path, name, file)) return null;
	return contains(await fs.realpath(globalBin.pnpmHome), entry, platform) ? entry : null;
}

/** The entry's package.json names `name` at `version` (any stable version when
 * null), and `node <entry> --version` prints that version.
 */
async function runsAsPackage(entry, name, version, nodePath, child, platform, adapters) {
	const path = platform === "win32" ? win32 : posix;
	if (!(await adapters.fs.isFile(entry))) return false;
	const metadata = JSON.parse(await adapters.fs.readText(path.join(path.dirname(path.dirname(entry)), "package.json")));
	if (metadata?.name !== name || !stable(metadata.version) || (version !== null && metadata.version !== version)) return false;
	const result = await adapters.run(nodePath, [entry, "--version"], { env: child, deadlineMs: deadlines.probe });
	return succeeded(result) && String(result.stdout ?? "").trim() === metadata.version;
}

function inGlobalBin(file, platform, globalBin) {
	const path = platform === "win32" ? win32 : posix;
	return globalBin !== null && samePath(path.dirname(file), globalBin.path, platform);
}

/** The npm the user runs works in the user's environment: run from the drive
 * root (`/` on POSIX) with the child env, `npm --version` prints a stable version
 * and `npm config get prefix` one absolute path. Whatever installed it (Node,
 * Homebrew, nvm, fnm, or a mise, asdf or Volta shim), this is how Gentle AI's
 * Engram step will run it. `npm` is { command, prefix }.
 */
async function worksAsNpm(npm, child, adapters, platform) {
	const path = platform === "win32" ? win32 : posix;
	const output = async (args) => {
		const result = await adapters.run(npm.command, [...npm.prefix, ...args], { env: child, cwd: path.parse(npm.command).root, deadlineMs: deadlines.probe });
		return succeeded(result) && result.truncated !== true ? String(result.stdout ?? "").trim() : null;
	};
	if (stable(await output(["--version"])) === null) return false;
	const prefix = await output(["config", "get", "prefix"]);
	return prefix !== null && path.isAbsolute(prefix) && !/[\r\n]/.test(prefix);
}

/** A usable npm: the first npm resolved in the child env.
 * Any npm outside `$PNPM_HOME/bin` that works there (worksAsNpm) is accepted as
 * { command, prefix }: on POSIX the command itself, on Windows an npm.exe (a
 * Volta or mise shim) or what a known npm.cmd runs (windowsInvocation: Node.js's
 * own npm.cmd, also behind nvm-windows or fnm, or an npm cmd-shim). For any npm
 * in `$PNPM_HOME/bin` (shim or symlink), pnpm's global npm must resolve inside
 * PNPM_HOME at the persistence pin and run, returned as { cli }.
 * Returns { command, prefix }, { cli }, "npm-shadowed" (Windows: an earlier npm
 * that is neither .cmd nor .exe wins) or false.
 */
export async function genuineNpm(child, platform, nodePath, adapters, globalBin = null) {
	const path = platform === "win32" ? win32 : posix;
	const { fs } = adapters;
	const first = await lookPath("npm", child, platform, fs);
	if (!first) return false;
	const extension = path.extname(first).toLowerCase();
	if (inGlobalBin(first, platform, globalBin)) {
		if (platform === "win32" && extension !== ".cmd") return "npm-shadowed";
		const cli = await globalShimEntry(first, "npm", "npm-cli.js", platform, globalBin, fs);
		if (!cli || !entryShape(cli, path, "npm", "npm-cli.js")) return false;
		return (await runsAsPackage(cli, "npm", persistencePins.npm, nodePath, child, platform, adapters)) ? { cli } : false;
	}
	if (platform === "win32" && ![".cmd", ".exe"].includes(extension)) return "npm-shadowed";
	const npm = platform === "win32" ? await windowsInvocation(first, child, adapters) : { command: first, prefix: [] };
	return npm !== null && (await worksAsNpm(npm, child, adapters, platform)) ? npm : false;
}

/** After adding pnpm, the first pnpm in the child env is pnpm's global shim in
 * `$PNPM_HOME/bin` for pnpm at the persistence pin, which then runs.
 */
async function persistentPnpm(child, platform, nodePath, globalBin, adapters) {
	const path = platform === "win32" ? win32 : posix;
	const first = await lookPath("pnpm", child, platform, adapters.fs);
	if (!first || !inGlobalBin(first, platform, globalBin)) return false;
	if (platform === "win32" && path.extname(first).toLowerCase() !== ".cmd") return false;
	const entry = await globalShimEntry(first, "pnpm", "pnpm.mjs", platform, globalBin, adapters.fs);
	return entry !== null && runsAsPackage(entry, "pnpm", persistencePins.pnpm, nodePath, child, platform, adapters);
}

export function succeeded(result) {
	return result?.code === 0 && !result.signal && result.timedOut !== true;
}

export function samePath(left, right, platform) {
	const path = platform === "win32" ? win32 : posix;
	const normal = (value) => path.normalize(value).replace(/(.)[\\/]+$/, "$1");
	const [a, b] = [normal(left), normal(right)];
	return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** True when `child` is strictly inside `parent` (case-insensitive on Windows). */
export function contains(parent, child, platform) {
	const path = platform === "win32" ? win32 : posix;
	const inside = path.relative(parent, child);
	return inside.length > 0 && !inside.startsWith("..") && !path.isAbsolute(inside);
}

/** How many times Pi and gentle-pi are listed across every project and
 * dependency field of a `list -g --json` output, or null when the shape is unknown.
 */
function stackListings(stdout) {
	const projects = JSON.parse(stdout);
	if (!Array.isArray(projects)) return null;
	let listed = 0;
	for (const project of projects) {
		if (!plainObject(project)) return null;
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
			const dependencies = project[field];
			if (dependencies === undefined) continue;
			if (!plainObject(dependencies)) return null;
			listed += [PI_PACKAGE, SHELL_PACKAGE].filter((name) => Object.hasOwn(dependencies, name)).length;
		}
	}
	return listed;
}

/** Shell-only (or Pi-only) pre-install `list -g --json`: true when no project
 * lists the package, "existing-stack" when one does, false when the shape is unknown.
 */
function notListed(stdout, name) {
	const projects = JSON.parse(stdout);
	if (!Array.isArray(projects) || !projects.every(plainObject)) return false;
	return projects.some((project) => ["dependencies", "devDependencies", "optionalDependencies"]
		.some((field) => plainObject(project[field]) && Object.hasOwn(project[field], name))) ? "existing-stack" : true;
}

/** The version of the Pi the launcher runs from gentle-pi at `root`: Node's
 * resolution from gentle-pi, nested in its node_modules first, then beside it
 * (where pnpm 11 links its peer). Null when neither is a readable Pi package.
 */
export async function adjacentPiVersion(root, platform, fs) {
	const path = platform === "win32" ? win32 : posix;
	const nested = path.join(root, "node_modules", PI_PACKAGE, "package.json");
	const beside = path.join(path.dirname(root), PI_PACKAGE, "package.json");
	for (const file of [nested, beside]) {
		const text = await fs.readText(file).catch(() => null);
		if (text === null) continue;
		try {
			const manifest = JSON.parse(text);
			return manifest?.name === PI_PACKAGE && typeof manifest.version === "string" ? manifest.version : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** That Pi's version when Gentle Shell can run it: a stable version at
 * requirements.pi or newer. pnpm 11 installs gentle-pi's optional peer Pi in
 * gentle-pi's own global group, at its latest version, so it may be newer than
 * PI_INSTALL_VERSION. Null otherwise (missing, unreadable, prerelease or older).
 */
async function runnablePi(root, platform, fs) {
	const version = await adjacentPiVersion(root, platform, fs);
	return stable(version) !== null && atLeast(version, requirements.pi) ? version : null;
}

/** Pre-install `list -g --json`: true when neither package is listed in any
 * project, "existing-stack" when one is, false when the shape is unknown.
 */
function noExistingStack(stdout) {
	const listed = stackListings(stdout);
	if (listed === null) return false;
	return listed === 0 ? true : "existing-stack";
}

/** Installed gentle-pi root from `list -g --json`, confined under PNPM_HOME, with
 * the version of the Pi the launcher runs from it ({ root, pi }), or null.
 * Exactly one listed project may own gentle-pi and list Pi at the pin (unless
 * only Gentle Shell was added), and that runnable Pi (runnablePi) must exist;
 * other projects (such as the persisted npm and pnpm) are ignored.
 */
async function verifiedPackageRoot(stdout, pnpmHome, platform, fs, shellVersion = requirements.shell, requirePi = true) {
	const path = platform === "win32" ? win32 : posix;
	const projects = JSON.parse(stdout);
	if (!Array.isArray(projects)) return null;
	const owners = projects.filter((project) => plainObject(project?.dependencies) && Object.hasOwn(project.dependencies, SHELL_PACKAGE));
	const dependencies = owners.length === 1 ? owners[0].dependencies : null;
	if (!plainObject(dependencies)) return null;
	const pi = dependencies[PI_PACKAGE];
	const shell = dependencies[SHELL_PACKAGE];
	if ((requirePi && pi?.version !== PI_INSTALL_VERSION) || shell?.version !== shellVersion) return null;
	if (typeof shell.path !== "string" || !path.isAbsolute(shell.path)) return null;
	const [root, home] = [await fs.realpath(shell.path), await fs.realpath(pnpmHome)];
	if (!contains(home, root, platform)) return null;
	const runs = await runnablePi(root, platform, fs);
	return runs === null ? null : { root, pi: runs };
}

/** A stack this pnpm installed whose setup may only be rerun (setup recovery):
 * Pi and gentle-pi are each listed exactly once, in the single project that
 * verifiedPackageRoot accepts (Pi at PI_INSTALL_VERSION, gentle-pi at this
 * package version, realpath confined under PNPM_HOME). Returns the root or null.
 */
export async function recoverableStackRoot(stdout, pnpmHome, platform, fs) {
	return stackListings(stdout) === 2 ? (await verifiedPackageRoot(stdout, pnpmHome, platform, fs))?.root ?? null : null;
}

/** After persistence, node and npm must resolve from `$PNPM_HOME/bin` in the
 * child env and that node must report the pinned version. Returns its path.
 */
async function persistentRuntime(child, platform, globalBin, adapters) {
	const path = platform === "win32" ? win32 : posix;
	const node = await lookPath("node", child, platform, adapters.fs);
	const npm = await lookPath("npm", child, platform, adapters.fs);
	const fromBin = (file) => file !== null && samePath(path.dirname(file), globalBin.path, platform);
	if (!fromBin(node) || !fromBin(npm) || !spawnable(node, platform)) return null;
	const result = await adapters.run(node, ["--version"], { env: child, deadlineMs: deadlines.probe });
	return succeeded(result) && String(result.stdout ?? "").trim() === `v${persistencePins.node}` ? node : null;
}

/** npm's prefix setting from the environment, which npm reads case-insensitively. */
function explicitNpmPrefix(env, platform) {
	return Object.keys(env).some((key) => key.toLowerCase() === "npm_config_prefix" ||
		(platform === "win32" ? key.toUpperCase() === "PREFIX" : key === "PREFIX"));
}

/** With a pnpm-managed node, npm's default prefix is derived from a path inside
 * pnpm's store, so `npm install -g` would write there. Only then, and only when
 * the user has no explicit prefix (otherwise npm would report it), set the
 * user-level prefix to PNPM_HOME. The store is the one `pnpm store path`
 * reports; when it is unknown the step fails. Returns "configured",
 * "unchanged" or null.
 */
async function configureNpmPrefix({ node, cli, child, platform, globalBin, adapters, storePath }) {
	const path = platform === "win32" ? win32 : posix;
	// Only the persisted npm's { cli } reaches this step ($PNPM_HOME/bin is first); anything else fails closed.
	if (typeof cli !== "string") return null;
	const npm = (args) => adapters.run(node, [cli, ...args], { env: child, deadlineMs: deadlines.probe });
	const effective = async () => {
		const result = await npm(["config", "get", "prefix"]);
		const value = String(result.stdout ?? "").trim();
		return succeeded(result) && path.isAbsolute(value) ? value : null;
	};
	const current = await effective();
	if (current === null) return null;
	if (explicitNpmPrefix(child, platform)) return "unchanged";
	const reported = await storePath();
	const value = String(reported?.stdout ?? "").trim();
	if (!succeeded(reported) || !path.isAbsolute(value) || /[\r\n]/.test(value)) return null;
	const store = await adapters.fs.realpath(value).catch(() => null);
	if (store === null) return null;
	const resolved = await adapters.fs.realpath(current).catch(() => current);
	if (!contains(store, resolved, platform)) return "unchanged";
	if (!succeeded(await npm(["config", "set", "prefix", globalBin.pnpmHome, "--location=user"]))) return null;
	const after = await effective();
	return after !== null && samePath(after, globalBin.pnpmHome, platform) ? "configured" : null;
}

/** Default integrity adapter: the package-local resolver, never a dev override.
 * `resolve` is injectable only so trusted tests can stand in for a pinned binary.
 */
export async function packageNativeGentleAi({ packageRoot, platform, env, home }, resolve = resolveGentleAiBinary) {
	const environment = { env, home };
	if (gentleAiDevBinaryOverrideConfigured(environment)) return { ok: false, reason: "development-override" };
	try {
		const binary = resolve(packageRoot, platform, readFileSync, environment);
		if (binary === gentleAiBinaryPath(packageRoot, platform)) return { ok: true };
	} catch {
		// Resolver errors name local paths; report only the classification.
	}
	return { ok: false, reason: "package-native-unverified" };
}

/** The failed steps whose sanitized detail line the outcome may carry. */
const detailSteps = Object.freeze(["shell-setup", "persist-path", "acquire-go", "install-global", "install-shell-main", "build-gentle-ai-main", "update-shell"]);

/** One displayable line from the bounded output of a failed `gentle-shell
 * setup` or `pnpm setup`: the last error line (`Error:` or a pnpm `ERR_` code),
 * else the last non-empty line.
 * Terminal escapes, control and bidi characters are removed, the user's home
 * becomes `~`, and the result has at most 300 characters. Null when nothing
 * remains. Untrusted output: the host still shows it only as text.
 */
export function setupErrorDetail(text, home, platform) {
	if (typeof text !== "string") return null;
	const lines = text.split(/\r\n|\r|\n/).map((line) => line
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
		.replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\t/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.trim()).filter((line) => line.length > 0);
	let line = lines.findLast((candidate) => /Error:|\bERR_[A-Z0-9_]+/.test(candidate)) ?? lines.at(-1);
	if (line === undefined) return null;
	const path = platform === "win32" ? win32 : posix;
	const root = typeof home === "string" && path.isAbsolute(home) ? home.replace(/[\\/]+$/, "") : "";
	if (root.length > 1) {
		// Only the whole home path, not a longer sibling such as /home/user for /home/u.
		line = line.replace(new RegExp(`${escapeRegExp(root)}(?=$|[\\\\/\\s"'():,;\\]])`, platform === "win32" ? "gi" : "g"), "~");
	}
	return Array.from(line).slice(0, 300).join("");
}

/**
 * runStandardInstall({ plan, consent }, adapters) -> { outcome, ... }
 * Outcomes: blocked (nothing installed), failed (stopped after `completed`),
 * terminal-action-required (installed; user PATH persisted, open a new
 * terminal) or ready. A failed `shell-setup`, `persist-path`, `install-global`,
 * `install-shell-main`, `build-gentle-ai-main` or `update-shell` may add `detail`, one
 * sanitized line (setupErrorDetail) of the failed command's output or of the main
 * channel's error, and a failed `acquire-go` the Go folder in its way, with the home
 * as ~; no other output is kept. When the plan persists the Node runtime, successful
 * outcomes also report npmPrefix: "configured" or "unchanged". When the Pi beside a pnpm
 * gentle-pi (the one Gentle Shell runs) is not PI_INSTALL_VERSION, they also report its
 * piVersion (pnpm 11 may install a newer peer Pi, at least requirements.pi). Adapters: platform, nodePath, env (user env), home?,
 * run(command, argv, { env, deadlineMs, stderrTail? }) with shell:false semantics returning
 * { code, signal, timedOut, stdout, stderrTail? }, fs { isFile, realpath, readText },
 * verifyGentleAi({ packageRoot, platform, env, home }) and log({ step, status }).
 * An update plan also uses locateShell() and upgradeShell({ channel, packageRoot,
 * currentVersion, goPath? }); a plan that updates an older Pi uses locatePi(), which returns
 * the single installed Pi as { root, version, owner } or null. A plan that acquires
 * Go uses acquireGo(), which returns the published pinned Go as { goPath }. A plan
 * with a private Windows PNPM_HOME (tools.pnpmHome, S6) uses preparePnpmHome(home)
 * before any command, then persists it with `pnpm setup`.
 * Nothing is ever deleted; no provisioning marker is written. A setup-recovery
 * plan replaces check-existing-stack with check-recoverable-stack and skips
 * install-global; every later step and outcome rule is the same.
 */
export async function runStandardInstall(request, adapters) {
	const { platform, env, log = () => {} } = adapters;
	const completed = [];
	const blocked = (reason) => {
		log({ step: "gate", status: "blocked", reason });
		return { outcome: "blocked", reason, completed };
	};
	if (!validRequest(request)) return blocked("invalid-request");
	if (request.consent !== true) return blocked("consent-required");
	const gate = planGate(request.plan, platform);
	if (gate) return blocked(gate);

	const path = platform === "win32" ? win32 : posix;
	const globalBin = pnpmGlobalBin({ platform, env });
	if (!globalBin) return blocked("pnpm-home-unknown");
	// A private Windows PNPM_HOME (S6): exactly the folder preflight recorded.
	const privateHome = platform === "win32" && request.plan.tools.pnpmHome?.status === "private";
	if (privateHome && !samePath(String(request.plan.tools.pnpmHome.path ?? ""), globalBin.pnpmHome, platform)) return blocked("pnpm-home-changed");
	if (!path.isAbsolute(adapters.nodePath ?? "")) return blocked("node-unavailable");
	const child = childEnvironment(env, platform, globalBin, { privateHome });
	const pnpm = await pnpmInvocation(env, platform, adapters.fs).catch(() => null);
	if (!pnpm) return blocked("pnpm-unavailable");
	const runPnpm = (args, deadlineMs, environment = child, options = {}) => adapters.run(pnpm.command, [...pnpm.prefix, ...args], { env: environment, deadlineMs, ...options });
	const home = adapters.home ?? (platform === "win32" ? env.USERPROFILE : env.HOME);
	let setupDetail = null;
	// pnpm prints its own errors, such as ERR_PNPM_UNKNOWN_SHELL or a failed postinstall, on stdout.
	const outputDetail = (result) => setupErrorDetail(result?.stderrTail, home, platform) ?? setupErrorDetail(result?.stdout, home, platform);
	// Only the main channel's own errors: their message, then the failed command's stderr tail.
	const mainChannelDetail = (error) => (error instanceof MainChannelError
		? setupErrorDetail([error.message, error.cause?.message].filter((text) => typeof text === "string").join("\n"), home, platform) : null);
	// A pnpm global add whose failure keeps pnpm's last error line as the detail.
	const addGlobal = async (args, environment) => {
		const result = await runPnpm(["add", "-g", ...args], deadlines.install, environment, { stderrTail: 4096 });
		if (succeeded(result)) return true;
		setupDetail = outputDetail(result);
		return false;
	};
	// A main-channel call whose MainChannelError becomes the detail; any other error stays hidden.
	const withMainDetail = (step) => async () => {
		try {
			return await step();
		} catch (error) {
			setupDetail = mainChannelDetail(error);
			return false;
		}
	};

	const list = () => runPnpm(["list", "-g", "--depth", "0", "--json"], deadlines.probe);
	const ids = request.plan.actions.map((action) => action.id);
	// planGate accepted either the clean-stack path or the fixed setup recovery.
	const update = ids.find((id) => updateActions.includes(id));
	// An older Pi is updated first; alone, nothing else runs (planGate: piOnlyVariants).
	const updatingPi = ids.includes("update-pi");
	const piOnly = (updatingPi || ids.includes("install-pi")) && !ids.includes("install-shell") && !update;
	const recovering = !ids.includes("install-shell") && !update && !piOnly;
	const shellOnly = ids.includes("install-shell") && !ids.includes("install-pi");
	const main = ids.includes("install-shell-main");
	// Fixed variants (planGate): runtime + both managers, or one add of the missing ones.
	const persistRuntime = ids.includes("persist-node");
	const addNpm = ids.includes("persist-package-managers") || ids.includes("persist-npm");
	const addPnpm = ids.includes("persist-package-managers") || ids.includes("persist-pnpm");
	let npmCli = null;
	const npmCheck = async () => {
		const verdict = await genuineNpm(child, platform, adapters.nodePath, adapters, globalBin);
		if (typeof verdict !== "object" || verdict === null) return verdict;
		npmCli = verdict.cli ?? null;
		return true;
	};

	// Pre-install gates: a false check or adapter exception blocks before mutation;
	// a check may return a more specific blocked reason instead of false.
	// An npm that is about to be persisted is checked only after it has been added.
	let installed = null;
	let installedPi = null;
	let npmCommand = null;
	// The Pi to update is still exactly the older one preflight recorded, from the
	// same owner: never a reinstall or downgrade. For npm, the npm on PATH must
	// install into the global root that holds it.
	const checkInstalledPi = async () => {
		const recorded = request.plan.tools.pi;
		const found = await adapters.locatePi?.();
		if (!found || !["pnpm", "npm"].includes(found.owner) || found.owner !== recorded?.owner || found.version !== recorded?.version) return false;
		if (stable(found.version) === null || atLeast(found.version, requirements.pi)) return false;
		if (typeof found.root !== "string" || !path.isAbsolute(found.root)) return false;
		if (found.owner === "npm") {
			// On Windows, what npm.cmd runs (windowsInvocation), never cmd.exe.
			const npm = await npmInvocation(env, platform, adapters);
			if (!npm) return false;
			const result = await adapters.run(npm.command, [...npm.prefix, "root", "-g"], { env, deadlineMs: deadlines.probe });
			const reported = succeeded(result) ? String(result.stdout ?? "").trim().split(/\r?\n/).at(-1).trim() : "";
			const npmRoot = path.isAbsolute(reported) ? await adapters.fs.realpath(reported) : null;
			if (installOwner({ packageRoot: found.root, pnpmHome: null, npmRoot, name: PI_PACKAGE, platform }) !== "npm") return false;
			npmCommand = npm;
		}
		installedPi = found;
		return true;
	};
	const checks = [
		...(addNpm ? [] : [["check-npm", "npm-unavailable", npmCheck]]),
		["check-global-bin", "global-bin-mismatch", async () => {
			const result = await runPnpm(["bin", "-g"], deadlines.probe);
			const reported = String(result.stdout ?? "").trim();
			return succeeded(result) && path.isAbsolute(reported) && samePath(reported, globalBin.path, platform);
		}],
		// Never rely on the caller's plan alone: an existing Pi or gentle-pi is not overwritten,
		// and a recovery still finds exactly the pinned stack this pnpm installed.
		...(piOnly ? [] : [update
			? ["check-installed-shell", "existing-stack-unverified", async () => {
				installed = await adapters.locateShell?.();
				return ["pnpm", "npm"].includes(installed?.owner) && typeof installed.root === "string" && path.isAbsolute(installed.root);
			}]
			: shellOnly
			? ["check-existing-shell", "global-list-unavailable", async () => {
				const result = await list();
				return succeeded(result) && notListed(String(result.stdout ?? ""), SHELL_PACKAGE);
			}]
			: recovering
			? ["check-recoverable-stack", "global-list-unavailable", async () => {
				const result = await list();
				if (!succeeded(result)) return false;
				const root = await recoverableStackRoot(String(result.stdout ?? ""), globalBin.pnpmHome, platform, adapters.fs)
					.catch(() => null);
				return root !== null || "existing-stack-unverified";
			}]
			: ["check-existing-stack", "global-list-unavailable", async () => {
				const result = await list();
				return succeeded(result) && noExistingStack(String(result.stdout ?? ""));
			}]]),
		...(updatingPi ? [["check-installed-pi", "existing-stack-unverified", checkInstalledPi]] : []),
		// The installer's Pi added on its own: pnpm must not list any Pi yet.
		...(piOnly && !updatingPi ? [["check-existing-pi", "global-list-unavailable", async () => {
			const result = await list();
			return succeeded(result) && notListed(String(result.stdout ?? ""), PI_PACKAGE);
		}]] : []),
	];
	// The private PNPM_HOME is claimed (or the one this flow created is kept) before
	// any pnpm command could create it with inherited permissions.
	if (privateHome) {
		const claimed = await Promise.resolve().then(() => adapters.preparePnpmHome(globalBin.pnpmHome)).then(() => true, () => false);
		if (!claimed) {
			log({ step: "prepare-pnpm-home", status: "failed" });
			return { outcome: "failed", failedStep: "prepare-pnpm-home", completed };
		}
		completed.push("prepare-pnpm-home");
		log({ step: "prepare-pnpm-home", status: "done" });
	}
	for (const [step, reason, check] of checks) {
		const verdict = await check().catch(() => false);
		if (verdict !== true) return blocked(typeof verdict === "string" ? verdict : reason);
		completed.push(step);
		log({ step, status: "done" });
	}

	// Mutating and post-install steps: a false result or exception is a failure.
	let packageRoot = null;
	// The Pi the launcher runs beside a pnpm gentle-pi, once verified.
	let runsPi = null;
	let persistentNode = null;
	let npmPrefix = null;
	// One add of only the missing managers (fixed versions only: never a blanket build approval).
	const addOnly = ids.find((id) => ["persist-package-managers", "persist-npm", "persist-pnpm"].includes(id));
	const addManagers = [addOnly, async () => succeeded(await runPnpm(["add", "-g", ...(addNpm ? [`npm@${persistencePins.npm}`] : []),
		...(addPnpm ? [`pnpm@${persistencePins.pnpm}`] : [])], deadlines.install))];
	const persistence = [
		["persist-node", async () => succeeded(await runPnpm(["runtime", "set", "node", persistencePins.node, "-g"], deadlines.install))],
		// npm, plus pnpm unless a persistent pnpm (never downgraded) is already there.
		addManagers,
		["verify-persistent-runtime", async () => (persistentNode = await persistentRuntime(child, platform, globalBin, adapters)) !== null],
		["check-npm", async () => (await npmCheck()) === true],
		["configure-npm-prefix", async () => (npmPrefix = await configureNpmPrefix({ node: persistentNode, cli: npmCli, child,
			platform, globalBin, adapters, storePath: () => runPnpm(["store", "path"], deadlines.probe) })) !== null],
	];
	// A persistent Node is never replaced: one add of only the missing managers.
	const packageManagers = [
		addManagers,
		...(addNpm ? [["check-npm", async () => (await npmCheck()) === true]] : []),
		...(addPnpm ? [["verify-persistent-pnpm", () => persistentPnpm(child, platform, adapters.nodePath, globalBin, adapters)]] : []),
	];
	// A recovery never runs `add -g`: the installed packages are verified as they are.
	// The older Pi, updated with the package manager that owns it, then found again:
	// the next probe must see a single Pi (one listed twice is located as null)
	// from the same owner at the target version, never a downgrade.
	const piSteps = updatingPi ? [
		["update-pi", async () => {
			const spec = `${PI_PACKAGE}@${PI_INSTALL_VERSION}`;
			const result = installedPi.owner === "npm"
				? await adapters.run(npmCommand.command, [...npmCommand.prefix, "install", "-g", spec], { env, deadlineMs: deadlines.install })
				: await runPnpm(["add", "-g", spec], deadlines.install);
			return succeeded(result);
		}],
		["verify-updated-pi", async () => {
			const after = await adapters.locatePi();
			if (!after || after.owner !== installedPi.owner || typeof after.root !== "string" || !path.isAbsolute(after.root)) return false;
			if (stable(after.version) === null || !atLeast(after.version, PI_INSTALL_VERSION)) return false;
			// npm replaces the package in place; pnpm 11 moves it to a new global directory.
			return after.owner === "pnpm" || samePath(after.root, installedPi.root, platform);
		}],
	] : [];
	// The installer's pinned Go, when acquired: never on the user's PATH, only first
	// on the PATH of the children that may build Gentle AI (gentle-pi's Windows
	// postinstall finds go.exe there) and passed by path to the main build.
	let pinnedGo = null;
	const buildEnv = () => (pinnedGo ? goFirstEnvironment(child, platform, pinnedGo) : child);
	const goSteps = ids.includes("acquire-go") ? [
		["acquire-go", async () => {
			try {
				pinnedGo = (await adapters.acquireGo())?.goPath ?? null;
			} catch (error) {
				// Only a folder in the way is reported, by its path with the home as ~.
				const cause = String(error?.cause?.message ?? "");
				if (cause.startsWith("Conflicting Go destination: ")) setupDetail = setupErrorDetail(cause, home, platform);
				return false;
			}
			return typeof pinnedGo === "string";
		}],
		// It runs and reports exactly the pinned version; GOTOOLCHAIN=local keeps it from switching toolchains.
		["verify-go", async () => {
			if (!path.isAbsolute(pinnedGo) || !spawnable(pinnedGo, platform)) return false;
			const result = await adapters.run(pinnedGo, ["version"], { env: { ...child, GOTOOLCHAIN: "local" }, cwd: path.dirname(pinnedGo),
				deadlineMs: deadlines.probe });
			return succeeded(result) && new RegExp(`^go version go${escapeRegExp(goAcquisition.version)} \\S+$`).test(String(result.stdout ?? "").trim());
		}],
	] : [];
	// Pi and gentle-pi stay separate pnpm groups, so `pi update` (which replaces Pi's
	// own group) never removes gentle-pi; gentle-pi gets pnpm's peer Pi beside it.
	const install = ["install-global", () => addGlobal([...(shellOnly ? [] : [`${PI_PACKAGE}@${PI_INSTALL_VERSION}`]),
		`${SHELL_PACKAGE}@${requirements.shell}`, `--allow-build=${SHELL_PACKAGE}`], buildEnv())];
	function mainSteps() {
		const channel = adapters.mainChannel;
		const ctx = { env, home };
		const runIn = (command, argv, options = {}) => adapters.run(command, argv, { env: options.env ?? child, cwd: options.cwd, deadlineMs: options.deadlineMs ?? deadlines.install,
			...(options.stderrTail === undefined ? {} : { stderrTail: options.stderrTail }) });
		let gentleAiCommit = null;
		let shellCommit = null;
		return [
			["build-gentle-ai-main", withMainDetail(async () => {
				const goPath = pinnedGo ?? await lookPath("go", env, platform, adapters.fs);
				if (!goPath || !channel) return false;
				gentleAiCommit = await channel.resolveCommit(GENTLE_AI_REPOSITORY);
				await channel.buildGentleAi({ commit: gentleAiCommit, goPath, platform, ctx, run: runIn });
				return true;
			})],
			["install-shell-main", withMainDetail(async () => {
				shellCommit = await channel.resolveCommit(SHELL_REPOSITORY);
				const tgz = await channel.packShell({ commit: shellCommit, ctx, run: runIn, pnpm, platform });
				if (!(await addGlobal([tgz, `--allow-build=${SHELL_PACKAGE}`], buildEnv()))) return false;
				const result = await list();
				if (!succeeded(result)) return false;
				const verified = await verifiedPackageRoot(String(result.stdout ?? ""), globalBin.pnpmHome, platform, adapters.fs,
					mainVersion(requirements.shell, shellCommit), !shellOnly);
				if (verified === null) return false;
				({ root: packageRoot, pi: runsPi } = verified);
				return true;
			})],
			["record-channel", async () => {
				await channel.writeChannel(ctx, { channel: "main", shellCommit, gentleAiCommit });
				return true;
			}],
		];
	}
	const steps = [
		// The pinned Go first: a failed download leaves nothing persisted or installed.
		...goSteps,
		...(persistRuntime ? persistence : addOnly ? packageManagers : []),
		...piSteps,
		...(recovering ? [] : [install]),
		["verify-global-list", async () => {
			const result = await list();
			if (!succeeded(result)) return false;
			const verified = await verifiedPackageRoot(String(result.stdout ?? ""), globalBin.pnpmHome, platform, adapters.fs, requirements.shell, !shellOnly);
			if (verified === null) return false;
			({ root: packageRoot, pi: runsPi } = verified);
			return true;
		}],
		["verify-shell-bin", () => adapters.fs.isFile(path.join(globalBin.path, platform === "win32" ? "gentle-shell.cmd" : "gentle-shell"))],
		["verify-gentle-ai", async () => (await adapters.verifyGentleAi({ packageRoot, platform, env, home }))?.ok === true],
		// Main overlays the verified release stack: Gentle AI built from the latest
		// main commit (registered as the override), then Gentle Shell packed from
		// it. Setup below then runs from the main package.
		...(main ? mainSteps() : []),
			// The setup commands are the only ones whose stderr tail is requested.
		["shell-setup", async () => {
			const result = await adapters.run(adapters.nodePath, [path.join(packageRoot, "bin", "gentle-shell.mjs"), "setup"],
				{ env: setupEnvironment(child, platform), deadlineMs: deadlines.setup, stderrTail: 4096 });
			if (succeeded(result)) return true;
			setupDetail = setupErrorDetail(result?.stderrTail, home, platform);
			return false;
		}],
	];
	if (update) {
		// Update an existing Gentle Shell with its owner's package manager (the same
		// logic as `gentle-shell upgrade`), confirm the result, then set it up.
		const channel = update === "update-shell-main" ? "main" : "release";
		const setupStep = steps.find(([name]) => name === "shell-setup");
		steps.splice(0, steps.length,
			...goSteps,
			...(ids.includes("install-pi") ? [["install-pi", async () => succeeded(await runPnpm(["add", "-g", `${PI_PACKAGE}@${PI_INSTALL_VERSION}`], deadlines.install))]] : []),
			...piSteps,
			["update-shell", withMainDetail(async () => (await adapters.upgradeShell({ channel, packageRoot: installed.root, currentVersion: installed.version,
				...(pinnedGo ? { goPath: pinnedGo } : {}) })) === true)],
			["verify-updated-shell", async () => {
				const after = await adapters.locateShell();
				const version = String(after?.version ?? "");
				const expected = channel === "main" ? MAIN_VERSION.test(version)
					: stable(version) !== null && (stable(installed.version) === null || atLeast(version, installed.version));
				if (!expected || after.owner !== installed.owner || !path.isAbsolute(after.root)) return false;
				// pnpm gives the updated gentle-pi its peer Pi beside it: the one Gentle Shell runs.
				if (after.owner === "pnpm" && (runsPi = await runnablePi(after.root, platform, adapters.fs)) === null) return false;
				packageRoot = after.root;
				return true;
			}],
			...(channel === "release" ? [["verify-gentle-ai", async () => (await adapters.verifyGentleAi({ packageRoot, platform, env, home }))?.ok === true]] : []),
			setupStep);
	}
	// A child PATH never proves a fresh terminal; persist it with pnpm's own setup.
	// globalBin.onPath was computed from the user's own PATH, not the child env.
	// pnpm setup installs @pnpm/exe over the network, so it gets the setup deadline.
	// An update keeps the PATH its existing installation already uses, except in a
	// new private PNPM_HOME, which pnpm setup must persist for new terminals.
	if (piOnly) {
		// The installer's Pi alone: the same `add -g` as install-pi, then found in pnpm's list.
		steps.splice(0, steps.length, ...(updatingPi ? piSteps : [
			["install-pi", async () => succeeded(await runPnpm(["add", "-g", `${PI_PACKAGE}@${PI_INSTALL_VERSION}`], deadlines.install))],
			["verify-installed-pi", async () => {
				const after = await adapters.locatePi();
				return after?.owner === "pnpm" && typeof after.root === "string" && path.isAbsolute(after.root) &&
					stable(after.version) !== null && atLeast(after.version, PI_INSTALL_VERSION);
			}],
		]));
	}
	const persistPath = !globalBin.onPath && (privateHome || (!update && !piOnly));
	if (persistPath) {
		steps.push(["persist-path", async () => {
			const result = await adapters.run(pnpm.command, [...pnpm.prefix, "setup"], { env: child, deadlineMs: deadlines.setup, stderrTail: 4096 });
			if (succeeded(result)) return true;
			setupDetail = outputDetail(result);
			return false;
		}]);
	}
	for (const [step, run] of steps) {
		if (!(await Promise.resolve().then(run).catch(() => false))) {
			log({ step, status: "failed" });
			const detail = detailSteps.includes(step) && setupDetail ? { detail: setupDetail } : {};
			return { outcome: "failed", failedStep: step, completed, ...detail };
		}
		completed.push(step);
		log({ step, status: "done" });
	}
	// Reported only when Gentle Shell runs a Pi other than the installer's.
	const prefix = { ...(persistRuntime ? { npmPrefix } : {}), ...(runsPi !== null && runsPi !== PI_INSTALL_VERSION ? { piVersion: runsPi } : {}) };
	if (persistPath) return { outcome: "terminal-action-required", action: "open-new-terminal", completed, ...prefix };
	return { outcome: "ready", completed, ...prefix };
}
