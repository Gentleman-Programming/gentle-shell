import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
	INSTALLER_VERSION,
	GENTLE_AI_WINDOWS_MINIMUM_GO_VERSION,
} from "./gentle-ai-installer.mjs";

// Read package metadata only: never import the launcher or execute postinstall.
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
function minimum(range) {
	if (!/^>=\d+\.\d+\.\d+$/.test(range)) throw new Error("Unsupported preflight requirement range");
	return range.slice(2);
}
export const requirements = Object.freeze({
	node: minimum(metadata.engines.node),
	pi: minimum(metadata.peerDependencies["@earendil-works/pi-coding-agent"]),
	pnpm: metadata.packageManager.replace(/^pnpm@/, ""),
	shell: metadata.version,
	gentleAi: INSTALLER_VERSION,
	go: GENTLE_AI_WINDOWS_MINIMUM_GO_VERSION,
});

/** Runtime persisted under PNPM_HOME. Bootstrap-only Node: `pnpm runtime set
 * node <node> -g`, then `pnpm add -g npm@<npm> pnpm@<pnpm>`. Persistent Node:
 * one `pnpm add -g` of only the missing npm and/or bootstrap-only pnpm.
 * npm 11.19.0 is the npm bundled with Node 24.21.0.
 */
export const persistencePins = Object.freeze({ node: "24.21.0", npm: "11.19.0", pnpm: requirements.pnpm });

/** pnpm 11 global bin directory: `$PNPM_HOME/bin`, not `$PNPM_HOME` itself.
 * PNPM_HOME is the user's existing absolute value, otherwise pnpm's documented
 * platform default. onPath compares PATH entries with that bin directory, so a
 * globalBin probe must report this path. Returns null when it is unknowable.
 */
export function pnpmGlobalBin({ platform, env }) {
	const path = platform === "win32" ? win32 : posix;
	const absolute = (value) => typeof value === "string" && value.length > 0 && path.isAbsolute(value);
	let pnpmHome = env.PNPM_HOME;
	if (pnpmHome !== undefined) {
		if (!absolute(pnpmHome)) return null;
	} else if (platform === "win32") {
		if (!absolute(env.LOCALAPPDATA)) return null;
		pnpmHome = path.join(env.LOCALAPPDATA, "pnpm");
	} else {
		if (!absolute(env.HOME)) return null;
		if (platform === "darwin") pnpmHome = path.join(env.HOME, "Library", "pnpm");
		else pnpmHome = path.join(absolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(env.HOME, ".local", "share"), "pnpm");
	}
	pnpmHome = path.normalize(pnpmHome).replace(/(.)[\\/]+$/, "$1");
	const bin = path.join(pnpmHome, "bin");
	const comparable = (value) => {
		const normal = path.normalize(value).replace(/(.)[\\/]+$/, "$1");
		return platform === "win32" ? normal.toLowerCase() : normal;
	};
	const pathKey = platform === "win32" ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") : "PATH";
	const entries = String((pathKey && env[pathKey]) ?? "").split(path.delimiter).filter(absolute);
	return { pnpmHome, path: bin, onPath: entries.some((entry) => comparable(entry) === comparable(bin)) };
}

const probeNames = ["node", "pnpm", "pi", "shell", "gentleAi", "go", "globalBin", "setup"];

/** Collect with caller-owned read-only probes; no default process/home adapters.
 * A tool probe returns { available, version, usable }; missing is available:false.
 * pnpm also needs compatible:true (runtime/capability evidence), shell global:true,
 * and Gentle AI compatible:true (normal binary resolver/integrity evidence).
 * Node may add persistent (resolvable from the user's PATH without bootstrap
 * tool directories) and npm (a genuine npm resolves there) booleans; pnpm may
 * add persistent (resolvable from the user's PATH). globalBin returns { available, path, writable, onPath } for
 * pnpmGlobalBin's `$PNPM_HOME/bin` directory; setup returns boolean, or
 * { available: true, recoverable: true } for the pinned stack this pnpm installed
 * whose setup did not finish (only its setup is then planned).
 * Version values are exact stable versions, not raw arbitrary command output.
 */
export async function collectInventory({ platform, arch, probes = {} }) {
	const inventory = { platform, arch };
	for (const name of probeNames) {
		try {
			inventory[name] = probes[name] ? await probes[name]() : { available: null };
		} catch {
			// Do not retain probe errors: they can contain private paths or credentials.
			inventory[name] = { available: null };
		}
	}
	return inventory;
}

function versionParts(version) {
	if (typeof version !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
	const parts = version.replace(/^v/, "").split(".").map(Number);
	return parts.every(Number.isSafeInteger) ? parts : null;
}
function compareVersions(left, right) {
	for (let i = 0; i < 3; i += 1) {
		if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
	}
	return 0;
}
if (compareVersions(versionParts(persistencePins.node), versionParts(requirements.node)) < 0) {
	throw new Error("Persistent Node pin is below the repository minimum");
}
function classify(observation, required, extraCheck = () => true, exact = false) {
	if (observation?.available === false) return "unavailable";
	if (observation?.available !== true) return "unknown";
	const version = versionParts(observation.version);
	if (!version || observation.usable !== true) return "unknown";
	const order = compareVersions(version, versionParts(required));
	if (order < 0 || (exact && order !== 0)) return "incompatible";
	const extra = extraCheck(observation);
	if (extra === false) return "incompatible";
	return extra === true ? "reusable" : "unknown";
}

/** Pure ordered intent plan, not executable commands or a readiness certificate.
 * Blocked plans contain no actions: never overwrite an incompatible/unknown tool.
 * Compatible newer Node/Pi/Shell versions remain owned by their existing install.
 */
export function planPreflight(inventory) {
	const tools = {};
	const blockers = [];
	const actions = [];
	const { platform, arch } = inventory;
	const supportedTarget = ["linux", "darwin", "win32"].includes(platform) && ["x64", "arm64"].includes(arch);
	if (!supportedTarget) {
		return { tools, blockers: [{ code: "unsupported-target", tool: "target" }], actions, ready: false };
	}
	function record(name, status, required) {
		tools[name] = { status, ...(required ? { required } : {}) };
		if (status === "unknown" || status === "incompatible") {
			blockers.push({ code: `${status}-tool`, tool: name });
		}
	}
	for (const name of ["node", "pi", "shell"]) {
		record(name, classify(inventory[name], requirements[name], name === "shell" ? (o) => o.global : undefined), requirements[name]);
	}
	// packageManager pins the acquisition choice, not a minimum supported pnpm.
	// Existing versions require explicit engine/capability evidence from the probe.
	record("pnpm", classify(inventory.pnpm, "0.0.0", (o) => o.compatible), requirements.pnpm);
	record("gentleAi", classify(inventory.gentleAi, requirements.gentleAi, (o) => o.compatible, true), requirements.gentleAi);
	const needsNative = tools.gentleAi.status === "unavailable";
	record("go", platform === "win32" && needsNative ? classify(inventory.go, requirements.go) : "not-required", requirements.go);
	const bin = inventory.globalBin;
	const binKnown = bin?.available === true && typeof bin.path === "string" && bin.path.trim().length > 0 &&
		bin.writable === true && typeof bin.onPath === "boolean";
	record("globalBin", bin?.available === false ? "unavailable" : binKnown ? (bin.onPath ? "reusable" : "needs-setup") : "unknown");
	const missingShell = tools.shell.status === "unavailable";
	// Setup recovery: the setup probe proved the pinned stack this pnpm installed
	// (an earlier run stopped in setup), so only the public setup is rerun.
	const recovering = inventory.setup?.available === true && inventory.setup.recoverable === true &&
		["pi", "shell", "gentleAi"].every((name) => tools[name].status === "reusable");
	let setupStatus = "unknown";
	if (missingShell || needsNative || inventory.setup === false || recovering) setupStatus = "needs-setup";
	else if (inventory.setup === true) setupStatus = "reusable";
	record("setup", setupStatus);
	if (blockers.length) return { tools, blockers, actions, ready: false };

	function action(id, kind, target, version) {
		actions.push({ id, kind, target, ...(version ? { version } : {}) });
	}
	function acquire(name) {
		if (tools[name].status !== "unavailable") return;
		action(`acquire-${name}`, "acquire", name, requirements[name]);
		action(`verify-${name}`, "verify", name);
	}
	acquire("node");
	acquire("pnpm");
	if (tools.globalBin.status !== "reusable") action("setup-global-bin", "setup", "globalBin");
	// A bootstrap Node lives in a temporary tools directory, and Gentle AI's Engram
	// step needs a genuine npm: persist what is missing under PNPM_HOME through
	// pnpm itself. A persistent Node is never replaced or shadowed. A recovery
	// never persists: the earlier run did that before installing the stack.
	const node = inventory.node;
	const persistable = tools.node.status === "reusable" && !recovering;
	if (persistable && node.persistent === false) {
		action("persist-node", "persist-runtime", "node", persistencePins.node);
		action("persist-package-managers", "install-global", "package-managers");
		action("configure-npm-prefix", "configure", "npm-prefix");
	} else if (persistable) {
		const npm = node.npm === false;
		const pnpm = inventory.pnpm?.persistent === false;
		if (npm && pnpm) action("persist-package-managers", "install-global", "package-managers");
		else if (npm) action("persist-npm", "install-global", "npm", persistencePins.npm);
		else if (pnpm) action("persist-pnpm", "install-global", "pnpm", persistencePins.pnpm);
	}
	acquire("go");
	if (tools.pi.status === "unavailable") action("install-pi", "install-global", "pi", requirements.pi);
	if (missingShell) action("install-shell", "install-global", "shell", requirements.shell);
	// Global gentle-pi postinstall owns native provisioning when Shell is missing.
	// Otherwise the later runner must reuse that existing installer, not duplicate it.
	if (needsNative && !missingShell) action("provision-native", "existing-installer", "gentleAi", requirements.gentleAi);
	if (tools.setup.status !== "reusable") action("setup-shell", "normal-setup", "shell");
	action("verify-readiness", "verify", "stack");
	return { tools, blockers, actions, ready: actions.length === 1 };
}
