import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
	INSTALLER_VERSION,
	GENTLE_AI_WINDOWS_MINIMUM_GO_VERSION,
} from "./gentle-ai-installer.mjs";
import { goPinVersion } from "./installer-downloads.mjs";

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

/** Pi version the installer installs next to gentle-pi, and the version an older
 * Pi is updated to (never below requirements.pi; the runner asserts it).
 */
export const PI_INSTALL_VERSION = "1.0.0";

/** Runtime persisted under PNPM_HOME. Bootstrap-only Node: `pnpm runtime set
 * node <node> -g`, then `pnpm add -g npm@<npm> pnpm@<pnpm>`. Persistent Node:
 * one `pnpm add -g` of only the missing npm and/or bootstrap-only pnpm.
 * npm 11.19.0 is the npm bundled with Node 24.21.0.
 */
export const persistencePins = Object.freeze({ node: "24.21.0", npm: "11.19.0", pnpm: requirements.pnpm });

/** Go the installer downloads only to build Gentle AI, when a build needs Go and
 * the user's Go is missing or older than requirements.go (installer-downloads.mjs).
 */
export const goAcquisition = Object.freeze({ version: goPinVersion });

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
 * tool directories) and npm (a usable npm resolves there) booleans; pnpm may
 * add persistent (resolvable from the user's PATH). A bootstrap-only Node or
 * pnpm may add found: the stable version of the older or incompatible one on the
 * user's PATH that the bootstrap left in place; a pnpm probe for the user's own
 * pnpm in `$PNPM_HOME/bin` (where persisting pnpm writes) adds inGlobalBin:true
 * and reports that pnpm itself, never as found. globalBin returns { available, path, writable, onPath } for
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

const MAIN_BUILD = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-main\.[0-9a-f]{12}$/;
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
if (compareVersions(versionParts(goAcquisition.version), versionParts(requirements.go)) < 0) {
	throw new Error("Go acquisition pin is below the Go requirement");
}
function classify(observation, required, extraCheck = () => true, exact = false) {
	if (observation?.available === false) return "unavailable";
	if (observation?.available !== true) return "unknown";
	const version = versionParts(observation.version);
	if (!version) return "unknown";
	const order = compareVersions(version, versionParts(required));
	// A known version below the minimum is incompatible whether or not it runs.
	if (order < 0) return "incompatible";
	if (observation.usable !== true) return "unknown";
	if (exact && order !== 0) return "incompatible";
	const extra = extraCheck(observation);
	if (extra === false) return "incompatible";
	return extra === true ? "reusable" : "unknown";
}

/** Pure ordered intent plan, not executable commands or a readiness certificate.
 * Blocked plans contain no actions: never overwrite an incompatible/unknown tool.
 * Compatible newer Node/Pi/Shell versions remain owned by their existing install.
 */
export function planPreflight(inventory, { channel = "release" } = {}) {
	if (channel !== "release" && channel !== "main") throw new TypeError(`Unsupported installation channel: ${channel}`);
	const main = channel === "main";
	const tools = {};
	const blockers = [];
	const actions = [];
	const { platform, arch } = inventory;
	const supportedTarget = ["linux", "darwin", "win32"].includes(platform) && ["x64", "arm64"].includes(arch);
	if (!supportedTarget) {
		return { tools, blockers: [{ code: "unsupported-target", tool: "target" }], actions, ready: false };
	}
	// An installed Gentle Shell whose owner (pnpm or npm) is known is updated with
	// that package manager instead of blocking: older, unusable or main-channel
	// versions on release, and any version on main. A current pnpm-owned Shell
	// keeps the pinned-stack checks below; a current npm-owned one needs nothing.
	const shellSeen = inventory.shell;
	const ownedShell = shellSeen?.available === true && (shellSeen.owner === "pnpm" || shellSeen.owner === "npm") &&
		(versionParts(shellSeen.version) !== null || MAIN_BUILD.test(String(shellSeen.version)));
	const current = ownedShell && shellSeen.usable === true && versionParts(shellSeen.version) !== null &&
		compareVersions(versionParts(shellSeen.version), versionParts(requirements.shell)) >= 0;
	const update = ownedShell && (main || !current) ? channel : null;
	const npmCurrent = ownedShell && !update && shellSeen.owner === "npm";
	function record(name, status, required) {
		tools[name] = { status, ...(required ? { required } : {}) };
		// Gentle AI and setup are only checked for the pinned pnpm Shell, so their
		// unknown status adds nothing once that Shell blocks or is not the pinned one.
		const shellBlocks = tools.shell?.status === "incompatible" || tools.shell?.status === "unknown" || update !== null || npmCurrent;
		const derived = status === "unknown" && (name === "gentleAi" || name === "setup") && shellBlocks;
		if (!derived && (status === "unknown" || status === "incompatible")) {
			blockers.push({ code: `${status}-tool`, tool: name });
		}
	}
	record("node", classify(inventory.node, requirements.node), requirements.node);
	// An older Pi whose owner (pnpm or npm) is known is updated with that package
	// manager to PI_INSTALL_VERSION instead of blocking; the plan records the
	// found version and owner the update must still match. An older Pi neither
	// owns (mise, Homebrew, a binary) is left as it is: the installer's Pi is
	// installed alongside, exactly as when Pi is absent.
	const piSeen = inventory.pi;
	const piStatus = classify(piSeen, requirements.pi);
	if (piStatus === "incompatible" && piSeen.usable === true && (piSeen.owner === "pnpm" || piSeen.owner === "npm")) {
		tools.pi = { status: "needs-update", required: requirements.pi, version: piSeen.version, owner: piSeen.owner };
	} else if (piStatus === "incompatible" && piSeen.usable === true) {
		tools.pi = { status: "needs-install", required: requirements.pi, version: piSeen.version };
	} else {
		record("pi", piStatus, requirements.pi);
	}
	const updatePi = tools.pi.status === "needs-update";
	const installPi = tools.pi.status === "unavailable" || tools.pi.status === "needs-install";
	if (update) record("shell", "needs-update", requirements.shell);
	else if (npmCurrent) record("shell", "reusable", requirements.shell);
	else record("shell", classify(inventory.shell, requirements.shell, (o) => o.global), requirements.shell);
	// packageManager pins the acquisition choice, not a minimum supported pnpm.
	// Existing versions require explicit engine/capability evidence from the probe.
	record("pnpm", classify(inventory.pnpm, "0.0.0", (o) => o.compatible), requirements.pnpm);
	// An older Node or an incompatible pnpm on the user's PATH is left as it is: the
	// bootstrap acquired its pinned copy, which the probe reports (bootstrap-only)
	// with the user's stable version as `found`. That copy runs the installer and
	// is persisted below; the plan records both versions.
	const replacedRuntimes = [];
	for (const name of ["node", "pnpm"]) {
		const seen = inventory[name];
		const found = versionParts(seen?.found);
		const replaced = name === "node" ? found !== null && compareVersions(found, versionParts(requirements.node)) < 0 : found !== null;
		if (tools[name].status !== "reusable" || seen.persistent !== false || !replaced) continue;
		tools[name] = { ...tools[name], found: found.join("."), version: persistencePins[name] };
		replacedRuntimes.push(name);
	}
	record("gentleAi", classify(inventory.gentleAi, requirements.gentleAi, (o) => o.compatible, true), requirements.gentleAi);
	const needsNative = tools.gentleAi.status === "unavailable";
	// The main channel builds Gentle AI from source on every platform.
	// gentle-pi's postinstall may build Gentle AI from source on Windows, so a
	// Windows release update needs Go like an installation; main always does.
	const windowsBuild = platform === "win32" && (update !== null || (needsNative && !npmCurrent));
	const goStatus = windowsBuild || main ? classify(inventory.go, requirements.go) : "not-required";
	if (goStatus === "unavailable" || goStatus === "incompatible") {
		// A missing or older Go is left as it is: the build gets the installer's
		// pinned Go, downloaded after consent only when a build actually runs.
		const found = goStatus === "incompatible" ? versionParts(inventory.go.version).join(".") : null;
		tools.go = { status: "needs-acquire", required: requirements.go, version: goAcquisition.version, ...(found ? { found } : {}) };
	} else {
		record("go", goStatus, requirements.go);
	}
	// A Go that cannot be checked is neither missing nor older: main still blocks.
	if (main && tools.go.status === "unknown") blockers.push({ code: "main-requires-go", tool: "go" });
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
	// Runtimes are persisted only while installing Gentle Shell (the runner's
	// persistence variants): with an existing Shell, updated or current, a replaced
	// Node or pnpm keeps blocking as before. A setup recovery persists nothing and
	// runs with the bootstrap's copy.
	if (["needs-update", "reusable"].includes(tools.shell.status) && !recovering) {
		for (const name of replacedRuntimes) blockers.push({ code: "incompatible-tool", tool: name });
	}
	if (blockers.length) return { tools, blockers, actions, ready: false };

	function action(id, kind, target, version) {
		actions.push({ id, kind, target, ...(version ? { version } : {}) });
	}
	// The pinned Go pair, at `at`, before the first step that builds with it.
	function acquireGo(at = actions.length) {
		if (tools.go.status !== "needs-acquire") return;
		actions.splice(at, 0, { id: "acquire-go", kind: "acquire", target: "go", version: goAcquisition.version },
			{ id: "verify-go", kind: "verify", target: "go" });
	}
	// Existing Gentle Shell: update it (installing a missing Pi or updating an older
	// one first), then set it up. A current npm Shell only gets its Pi updated or
	// the installer's Pi added.
	if (update || npmCurrent) {
		// Only an update builds: main, or a Windows release postinstall.
		if (update) acquireGo();
		if (updatePi) action("update-pi", "upgrade", "pi", PI_INSTALL_VERSION);
		// A current npm Shell next to an older Pi neither manager owns gets the installer's Pi.
		if (!update && tools.pi.status === "needs-install") action("install-pi", "install-global", "pi", requirements.pi);
		if (update) {
			if (installPi) action("install-pi", "install-global", "pi", requirements.pi);
			action(`update-shell-${update}`, "upgrade", "shell");
			action("setup-shell", "normal-setup", "shell");
		}
		action("verify-readiness", "verify", "stack");
		return { tools, blockers, actions, ready: actions.length === 1 };
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
	// step needs a working npm: persist what is missing under PNPM_HOME through
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
	const goAt = actions.length;
	if (installPi) action("install-pi", "install-global", "pi", requirements.pi);
	if (updatePi) action("update-pi", "upgrade", "pi", PI_INSTALL_VERSION);
	if (missingShell) action("install-shell", "install-global", "shell", requirements.shell);
	// Global gentle-pi postinstall owns native provisioning when Shell is missing.
	// Otherwise the later runner must reuse that existing installer, not duplicate it.
	if (needsNative && !missingShell) action("provision-native", "existing-installer", "gentleAi", requirements.gentleAi);
	if (tools.setup.status !== "reusable") action("setup-shell", "normal-setup", "shell");
	action("verify-readiness", "verify", "stack");
	// Main overlays the verified release installation with both latest main commits;
	// a stack that is already set up installs nothing (`gentle-shell upgrade --channel main` switches it).
	const mainBuild = main && actions.length > 1;
	if (mainBuild) {
		action("build-gentle-ai-main", "build-native-main", "gentleAi");
		action("install-shell-main", "install-global", "shell");
		action("record-channel", "configure", "channel");
	}
	if (mainBuild || windowsBuild) acquireGo(goAt);
	return { tools, blockers, actions, ready: actions.length === 1 };
}
