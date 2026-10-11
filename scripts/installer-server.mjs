import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { PI_INSTALL_VERSION, goAcquisition, requirements } from "./installer-preflight.mjs";

// Local wizard host: a dependency-free loopback HTTP server with a fixed route
// allowlist. The browser never sends commands, paths, plans or environment:
// plans are built here, stored here and handed to the injected runner here.

const HOST = "127.0.0.1";
const COOKIE = "gentle_install_session";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const defaultLimits = Object.freeze({
	codeTtlMs: 2 * MINUTE,
	idleMs: 30 * MINUTE,
	idleCheckMs: 15 * SECOND,
	bodyBytes: 1024,
	logEntries: 200,
	headersTimeoutMs: 10 * SECOND,
	requestTimeoutMs: 30 * SECOND,
});
const securityHeaders = Object.freeze({
	"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cross-Origin-Opener-Policy": "same-origin",
});
// Fixed asset names only: the request path never reaches the filesystem.
const assets = Object.freeze({
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/wizard.js": { file: "wizard.js", type: "text/javascript; charset=utf-8" },
	"/wizard.css": { file: "wizard.css", type: "text/css; charset=utf-8" },
});
const routes = Object.freeze({
	...Object.fromEntries(Object.keys(assets).map((path) => [path, "GET"])),
	"/session": "GET",
	"/api/plan": "GET",
	"/api/progress": "GET",
	"/api/install": "POST",
	"/api/shutdown": "POST",
});
// Served on a valid code instead of a 303: when the session URL is reached from
// the file: redirect page, a redirect chain counts as cross-site and a
// SameSite=Strict cookie could be withheld on `/`. This same-origin page starts
// the navigation, so the cookie is sent. No script or style, as the CSP requires.
const sessionPage = [
	"<!doctype html>",
	'<meta charset="utf-8">',
	'<meta http-equiv="refresh" content="0; url=/">',
	"<title>Gentle Shell installation wizard</title>",
	'<p><a href="/">Continue to the Gentle Shell installation wizard</a></p>',
	"",
].join("\n");

/** Fixed English descriptions for every action planPreflight can emit. */
export const actionDescriptions = Object.freeze({
	"acquire-node": "Download a verified Node.js runtime.",
	"verify-node": "Check that the downloaded Node.js runtime runs.",
	"acquire-pnpm": "Download a verified pnpm package manager.",
	"verify-pnpm": "Check that the downloaded pnpm runs.",
	"setup-global-bin": "Run `pnpm setup` so new terminals find globally installed commands.",
	"persist-node": "Install Node.js under PNPM_HOME with `pnpm runtime set node -g`.",
	"persist-package-managers": "Install npm and pnpm under PNPM_HOME with one `pnpm add -g`.",
	"configure-npm-prefix": "Point npm's user-level global prefix at PNPM_HOME when its default would be inside pnpm's store.",
	"persist-npm": "Install npm under PNPM_HOME with `pnpm add -g`.",
	"persist-pnpm": "Install pnpm under PNPM_HOME with `pnpm add -g`.",
	"acquire-go": "Download the installer's pinned Go from go.dev and verify it, only to build Gentle AI.",
	"verify-go": "Check that the downloaded Go runs and reports the pinned version.",
	"install-pi": "Install the Pi coding agent globally with pnpm.",
	"install-shell": `Install Gentle Shell (gentle-pi) globally with pnpm. pnpm may put a newer Pi than ${PI_INSTALL_VERSION} next to it ` +
		`(at least Pi ${requirements.pi}), and Gentle Shell runs that Pi.`,
	"provision-native": "Provision the package-native Gentle AI binary with the existing installer.",
	"setup-shell": "Run the normal `gentle-shell setup`.",
	"verify-readiness": "Verify that the installed stack is ready.",
	"build-gentle-ai-main": "Build Gentle AI from the latest commit of its `main` branch with Go, verified by Go's checksum database, and use it instead of the pinned release binary.",
	"install-shell-main": "Install Gentle Shell from the latest commit of its `main` branch with pnpm, replacing the release package.",
	"record-channel": "Remember the `main` channel, so `gentle-shell upgrade` keeps following `main`.",
	"update-shell-release": "Update Gentle Shell to the latest release with the package manager that installed it (pnpm or npm).",
	"update-shell-main": "Update Gentle Shell and Gentle AI to the latest commits of `main`, built on this computer, with the package manager that installed Gentle Shell.",
	"update-pi": "Update Pi with the package manager that installed it (pnpm or npm).",
	// The bundled install (T1c): the plan's own versions and paths come from bundledDescription.
	"bundled-prefix": "Create Gentle Shell's private folder for its own runtimes, versions and launcher.",
	"bundled-runtime": "Download Gentle Shell's pinned Node.js with its npm, and pnpm, and verify their pinned checksums.",
	"bundled-version": "Install Gentle Shell with its pinned Pi from the release's lockfile.",
	"bundled-activate": "Make this version the active one and write the `gentle-shell` launcher.",
	"bundled-path": "Make new terminals find `gentle-shell`.",
	"bundled-setup": "Run `gentle-shell setup` with the bundled launcher.",
});

const tryAgain = "Fix the cause, then run the installer again.";
/** Fixed English guidance for every runner blocked reason, failed step and preflight blocker. */
export const guidance = Object.freeze({
	blocked: Object.freeze({
		"invalid-request": "The installation request was not an unmodified plan. Reload the wizard to get a fresh plan.",
		"consent-required": "Nothing was installed because consent was not given. Review the plan and confirm to continue.",
		"preflight-blocked": "Preflight found a blocker, so nothing was installed. Resolve the listed blockers and run the installer again.",
		"go-required": `Windows needs Go ${requirements.go} or newer before Gentle AI can be provisioned, and this plan neither reuses nor downloads one. Run the installer again to check this computer again.`,
		"unsupported-plan": "This machine needs steps the wizard does not run yet, such as updating an existing installation. Use `gentle-shell upgrade` or follow the README.",
		"pnpm-home-unknown": "The pnpm home directory could not be determined. Set PNPM_HOME to an absolute directory, then run the installer again.",
		"pnpm-home-changed": "The pnpm home folder is not the one the plan was made for. Nothing was installed; run the installer again to check this computer again.",
		"node-unavailable": "The installer could not find its own Node.js executable. Run the installer again from the bootstrap script.",
		"pnpm-unavailable": "pnpm could not be started. Run the installer again from the bootstrap script so it can provide pnpm.",
		"npm-unavailable": "No working npm was found on PATH. Gentle AI needs it; check that `npm --version` works in a new terminal, then run the installer again.",
		"npm-shadowed": "Another `npm` program appears on PATH before Node.js's npm. Remove or reorder it, then run the installer again.",
		"global-bin-mismatch": "pnpm reported a different global bin directory than expected. Check PNPM_HOME, then run the installer again.",
		"global-list-unavailable": "pnpm could not list global packages. Check that `pnpm list -g` works, then run the installer again.",
		"existing-stack": "Pi or Gentle Shell is already installed globally. Nothing was changed; use `gentle-shell upgrade` instead.",
		"existing-stack-unverified": "The installed Pi and Gentle Shell changed after the plan was made, or are no longer the versions this installer set up. Nothing was changed; run the installer again to check this computer again.",
	}),
	failed: Object.freeze({
		"prepare-pnpm-home": "The private pnpm folder (%USERPROFILE%\\.pnpm) could not be created, or kept, with access for you, SYSTEM and Administrators only, or it changed after the plan was made. Nothing was installed. " +
			"If that folder holds files this installer did not put there, move them aside. Then run the installer again.",
		"persist-node": `Installing Node.js under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-package-managers": `Installing npm and pnpm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-npm": `Installing npm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"persist-pnpm": `Installing pnpm under PNPM_HOME failed. Check your network connection. ${tryAgain}`,
		"verify-persistent-runtime": `Node.js and npm were not found in the pnpm global bin directory after installation. ${tryAgain}`,
		"verify-persistent-pnpm": `pnpm was not found in the pnpm global bin directory after installation. ${tryAgain}`,
		"check-npm": `The installed npm could not be verified as genuine npm. ${tryAgain}`,
		"configure-npm-prefix": `npm's global prefix could not be checked or set to PNPM_HOME. Your npm configuration was left as it was. ${tryAgain}`,
		"acquire-go": `Go ${goAcquisition.version} could not be downloaded from go.dev and verified against its pinned checksum, so nothing was installed. Check your network connection. ${tryAgain}`,
		"verify-go": `The downloaded Go did not run or did not report Go ${goAcquisition.version}, so nothing was installed. ${tryAgain}`,
		"install-global": `Installing Pi and Gentle Shell with pnpm failed. Check your network connection. ${tryAgain}`,
		"verify-global-list": `The installed Pi and Gentle Shell packages could not be verified under PNPM_HOME. ${tryAgain}`,
		"verify-shell-bin": `The gentle-shell command was not found in the pnpm global bin directory. ${tryAgain}`,
		"verify-gentle-ai": `The package-native Gentle AI binary could not be verified. ${tryAgain}`,
		"shell-setup": "`gentle-shell setup` did not finish. Run `gentle-shell setup` in a terminal to see the details.",
		"persist-path": "`pnpm setup` could not add the global bin directory to your PATH. Run `pnpm setup` in a terminal, then open a new terminal.",
		"build-gentle-ai-main": `Gentle AI could not be built from its latest \`main\` commit. Check your network connection and that \`go\` runs in a terminal. ${tryAgain}`,
		"install-shell-main": `Gentle Shell could not be installed from its latest \`main\` commit. Check your network connection. ${tryAgain}`,
		"record-channel": "Gentle Shell is installed from `main`, but the channel could not be saved under `~/.pi/gentle-ai`. Check that folder's permissions, then run the installer again.",
		"install-pi": `Installing Pi with pnpm failed. Your existing Gentle Shell was not changed. Check your network connection. ${tryAgain}`,
		"update-shell": "Updating Gentle Shell failed. Run `gentle-shell upgrade` in a terminal to see the details.",
		"verify-updated-shell": "Gentle Shell did not report the expected version after the update. Run `gentle-shell --version`, then `gentle-shell upgrade` in a terminal.",
		"update-pi": `Updating Pi with the package manager that installed it failed. Gentle Shell was not changed. Check your network connection. ${tryAgain}`,
		"verify-updated-pi": "After the update, this installer could not find a single Pi at the expected version from the same package manager. Gentle Shell was not changed. Run `pi --version` in a terminal, then run the installer again.",
		"verify-installed-pi": "After installing Pi, this installer could not find it at the expected version in pnpm's global packages. Gentle Shell and your other Pi were not changed. Run `pnpm list -g` in a terminal, then run the installer again.",
		"claim-prefix": "Gentle Shell's private folder could not be created, or kept private to your account, so nothing was installed. If that folder holds files this installer did not put there, or another account can change it, fix that, then run the installer again.",
		"copy-npm-settings": `Your npm registry, authentication and proxy settings could not be read from your npm configuration (~/.npmrc, or NPM_CONFIG_USERCONFIG) and copied into Gentle Shell's private folder. Check that the file is readable. ${tryAgain}`,
		"install-runtime": `Gentle Shell's pinned Node.js, npm and pnpm (and Go on Windows) could not be downloaded and verified against their pinned checksums. Check your network connection. ${tryAgain}`,
		"install-version": `Installing Gentle Shell from the release's lockfile failed. Check your network connection and your npm registry and authentication settings. ${tryAgain}`,
		"activate-version": `The installed version could not be made the active one. ${tryAgain}`,
		"write-launcher": `The \`gentle-shell\` launcher could not be written in Gentle Shell's private folder. ${tryAgain}`,
		"bundled-path": "Gentle Shell is installed, but the PATH change could not be made, or it is no longer the one the plan showed, so nothing was changed. Run the installer again to see the current PATH plan.",
	}),
	blockers: Object.freeze({
		"unsupported-target": "This operating system or CPU is not supported by the wizard. Follow the README for a manual installation.",
		"unknown-tool": "A required tool could not be checked safely. Make sure it runs from a terminal, or remove the broken installation, then run the installer again.",
		"incompatible-tool": "A required tool is installed at an incompatible version. Update it, then run the installer again.",
		"main-requires-go": "The `main` channel builds Gentle AI with Go, but `go version` did not report a version this installer can check. " +
			"Make sure `go version` works in a terminal, or choose the release channel, then select Check again.",
		"untrusted-pnpm-home": "Another account can change the pnpm home folder (PNPM_HOME), where pnpm installs and runs programs, so nothing was installed. " +
			"Remove that account's write access, or set PNPM_HOME to a private folder such as %USERPROFILE%\\.pnpm, then select Check again.",
	}),
	outcomes: Object.freeze({
		ready: "Gentle Shell is installed. Run `gentle-shell` in a terminal.",
		"terminal-action-required": "Gentle Shell is installed. Open a new terminal so it picks up the updated PATH, then run `gentle-shell`.",
		"add-path-line": "Gentle Shell is installed. Add the line below to your shell profile, open a new terminal, then run `gentle-shell`.",
	}),
	// A failed install, main-channel or update step whose detail shows GitHub's anonymous API limit.
	githubRateLimit: "GitHub's limit for anonymous API requests was reached on this network, so the installation could not finish. Wait up to an hour, then run the installer again.",
	// A failed shell-setup whose detail shows GitHub's anonymous API limit.
	setupRateLimit: "`gentle-shell setup` could not finish because GitHub's limit for anonymous API requests was reached on this network. Wait up to an hour, then run the installer again.",
	// A failed acquire-go whose detail names a Go folder the installer did not publish.
	goDestinationConflict: `A Go folder from an earlier, interrupted installer run is in the way, and the installer never replaces a folder it cannot prove it published. Remove that folder (shown below), then run the installer again. Nothing was installed.`,
	// A failed persist-path whose detail shows pnpm could not tell the shell (POSIX SHELL missing or unsupported).
	persistPathShell: "`pnpm setup` could not tell which shell profile to edit because the SHELL environment variable is missing or names an unsupported shell. Open a regular terminal and run the installer again, or add `$PNPM_HOME/bin` to your PATH yourself.",
	fallback: "The installation stopped for an unexpected reason. Nothing else will run; check the terminal and run the installer again.",
});

/** The runner's setup detail, bounded again: text only, no control characters,
 * at most 300 characters. Null when nothing remains.
 */
function setupDetail(value) {
	if (typeof value !== "string") return null;
	const text = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim()).slice(0, 300).join("");
	return text.length > 0 ? text : null;
}
const rateLimited = (detail) => /rate limit/i.test(detail) || (/GitHub API/i.test(detail) && /\b403\b/.test(detail));
const unknownShell = (detail) => /ERR_PNPM_(?:UNKNOWN|UNSUPPORTED)_SHELL/.test(detail);
const goConflict = (detail) => detail.startsWith("Conflicting Go destination: ");
// The main channel's typed error when GitHub refused the latest main commit with HTTP 403.
const githubLimited = (detail) => rateLimited(detail) || (/\bmain-commit-unavailable\b/.test(detail) && /\bHTTP 403\b/.test(detail));
// Fixed steps whose sanitized last error line may reach the browser.
const detailSteps = Object.freeze({ "shell-setup": rateLimited, "install-version": () => false, "persist-path": unknownShell, "acquire-go": goConflict,
	"install-global": githubLimited, "install-shell-main": githubLimited, "build-gentle-ai-main": githubLimited, "update-shell": githubLimited });
const detailGuidance = Object.freeze({ "shell-setup": "setupRateLimit", "persist-path": "persistPathShell", "acquire-go": "goDestinationConflict",
	"install-global": "githubRateLimit", "install-shell-main": "githubRateLimit", "build-gentle-ai-main": "githubRateLimit", "update-shell": "githubRateLimit" });

const ID = /^[a-z][a-z0-9-]{0,63}$/;
function identifier(value, fallback = "unknown") {
	return typeof value === "string" && ID.test(value) ? value : fallback;
}
// Preflight tool names include camelCase keys such as gentleAi and globalBin.
const TOOL = /^[a-z][A-Za-z0-9-]{0,63}$/;
function toolName(value) {
	return typeof value === "string" && TOOL.test(value) ? value : "unknown";
}
function plainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function token(random, bytes) {
	return random(bytes).toString("base64url");
}
function sameSecret(expected, actual) {
	const [a, b] = [Buffer.from(expected), Buffer.from(String(actual))];
	return a.length === b.length && timingSafeEqual(a, b);
}
/** What must not change between review and install. The reused-folder notice
 * (tools.folders) is advisory and changes no action, so it is left out: a walk
 * that times out on re-inventory must not turn into a plan-changed loop. */
function fingerprint(collected) {
	const tools = Object.fromEntries(Object.entries(collected.plan?.tools ?? {}).filter(([name]) => name !== "folders"));
	return createHash("sha256").update(JSON.stringify({ plan: { ...collected.plan, tools }, binDir: collected.inventory?.globalBin?.path ?? null }))
		.digest("hex");
}

/** Browser view of a server-held plan: fixed descriptions, never commands. */
// Tools whose requirement is a minimum version, with their fixed labels. The
// Shell probe only inspects pnpm's global packages, so its remedy names pnpm.
const minimumTools = Object.freeze({
	node: { label: "Node.js", where: "" },
	pi: { label: "Pi", where: "" },
	shell: { label: "Gentle Shell", where: " globally with pnpm",
		remedy: (required) => `Update it with \`pnpm add -g gentle-pi@${required}\`, or remove it with \`pnpm remove -g gentle-pi\`` },
});
// A Pi whose version cannot be read, or a Gentle Shell neither pnpm nor npm manages.
const unmanaged = Object.freeze({
	pi: "Pi is already installed, but `pi --version` did not report a version this installer can check. Make sure `pi --version` works in a terminal, then select Check again.",
	shell: "Gentle Shell is already installed, but neither pnpm nor npm manages it (a linked source checkout, for example), so this installer cannot update it. Nothing was replaced. Update it the way you installed it, then select Check again.",
});
const STABLE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
function older(found, required) {
	const [a, b] = [STABLE.exec(found), STABLE.exec(required)];
	if (!a || !b) return false;
	for (let index = 1; index <= 3; index += 1) {
		if (Number(a[index]) !== Number(b[index])) return Number(a[index]) < Number(b[index]);
	}
	return false;
}
/** A user's pnpm in $PNPM_HOME/bin, where the installer would persist its own:
 * never replaced or downgraded, so the guidance says how to update an older one
 * with pnpm itself (`pnpm self-update <version>`). */
function globalBinPnpm(blocker, found, required) {
	const where = "is installed in the pnpm global bin directory, where this installer would put its own pnpm,";
	const update = `\`pnpm self-update ${required}\``;
	if (blocker.code === "unknown-tool" || !STABLE.test(found ?? "")) {
		return `A pnpm ${where} but its version could not be checked. Nothing was replaced. ` +
			`If \`pnpm --version\` reports a version older than ${required}, update it with ${update}, then select Check again.`;
	}
	const major = required.split(".")[0];
	if (older(found, required)) {
		return `pnpm ${found} ${where} but this installer needs pnpm ${required} or a newer ${major}.x. Nothing was replaced. ` +
			`Update it with ${update}, then select Check again.`;
	}
	return `pnpm ${found} ${where} but this installer only runs pnpm ${major} (${required} or a newer ${major}.x). ` +
		`Nothing was replaced, and this installer never downgrades pnpm. To use it, make a pnpm ${major} release your global pnpm the way you prefer, then select Check again.`;
}

// S6: what the storage walk found on a Windows PNPM_HOME candidate, from the
// wizard's own walk (folder, principal and rights), as one plain phrase.
function plainText(value) {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 300) : null;
}
function findingText(finding) {
	const at = plainText(finding?.at) ?? "a folder above it";
	const sid = plainText(finding?.sid);
	const account = plainText(finding?.account);
	const who = sid ? `${sid}${account ? ` (${account})` : ""}` : "another account";
	const check = String(finding?.check ?? "");
	if (check === "unchecked") return `the permissions of ${at} could not be checked`;
	if (check.endsWith("-acl-mask")) return `${who} can change ${at} (allowed rights ${plainText(finding.rights) ?? "beyond read and execute"})`;
	if (check.endsWith("-owner")) return `${at} is owned by ${who}, which this installer does not trust`;
	if (check.endsWith("-reparse")) return `${at} is a link (reparse point) to another location`;
	return `${at} did not pass the permission check`;
}
const privateRemedy = "set PNPM_HOME to a private folder such as %USERPROFILE%\\.pnpm and reinstall your global pnpm packages there";
function pnpmHomeGuidance(home) {
	const path = plainText(home?.path);
	if (!path || typeof home.untrusted !== "object" || home.untrusted === null) return guidance.blockers["untrusted-pnpm-home"];
	const found = findingText(home.untrusted);
	const at = plainText(home.untrusted.at) ?? path;
	if (home.source === "user") {
		return `PNPM_HOME is set to ${path}, but ${found}. pnpm installs and runs programs there, so nothing was installed. ` +
			`Remove that account's write access, or ${privateRemedy}, then select Check again.`;
	}
	const intro = `pnpm's default folder ${path} is not private: ${found}.`;
	if (home.installed === true) {
		return `${intro} It already holds files. This installer never runs programs from a folder another account can change, and never moves or deletes an existing installation, so nothing was installed. ` +
			`Remove that account's write access to ${at}, or ${privateRemedy}, then select Check again.`;
	}
	const own = plainText(home.private?.path);
	if (own && home.private.foreign === true) {
		return `${intro} ${own}, the private folder this installer would use instead, already holds files this installer did not create, so nothing was changed. ` +
			`Remove that account's write access to ${at}, or move ${own} aside, then select Check again.`;
	}
	if (own && typeof home.private.untrusted === "object") {
		return `${intro} ${own}, the private folder this installer would use instead, is not private either: ${findingText(home.private.untrusted)}. Nothing was changed. ` +
			"Remove the extra access shown, then select Check again.";
	}
	return `${intro} Nothing was installed. Remove that account's write access to ${at}, or ${privateRemedy}, then select Check again.`;
}

/** Names the found and required versions when an incompatible tool is simply
 * older than its minimum, and explains a Pi or Shell installed outside pnpm,
 * a pnpm in the global bin directory or a PNPM_HOME that is not private;
 * anything else keeps the fixed guidance. */
function blockerGuidance(blocker, inventory, plan) {
	const fixed = guidance.blockers[blocker.code] ?? guidance.fallback;
	if (blocker.code === "untrusted-pnpm-home") return pnpmHomeGuidance(inventory?.pnpmHome);
	if (blocker.tool === "pnpmHome" && blocker.code === "unknown-tool") {
		return "The permissions of the pnpm home folder (PNPM_HOME) could not be checked, so nothing was installed. " +
			"Make sure Windows PowerShell runs in a terminal, then select Check again.";
	}
	const pnpmRequired = plan.tools?.pnpm?.required;
	if (blocker.tool === "pnpm" && ["incompatible-tool", "unknown-tool"].includes(blocker.code) &&
		inventory?.pnpm?.inGlobalBin === true && STABLE.test(pnpmRequired ?? "")) {
		return globalBinPnpm(blocker, inventory.pnpm.version, pnpmRequired);
	}
	if (blocker.code === "unknown-tool" && Object.hasOwn(unmanaged, blocker.tool) && inventory?.[blocker.tool]?.outsidePnpm === true) {
		return unmanaged[blocker.tool];
	}
	const tool = Object.hasOwn(minimumTools, blocker.tool) ? minimumTools[blocker.tool] : null;
	if (blocker.code !== "incompatible-tool" || tool === null) return fixed;
	// An older Node left next to the bootstrap's copy is recorded in the plan.
	const found = plan.tools?.[blocker.tool]?.found ?? inventory?.[blocker.tool]?.version;
	const required = plan.tools?.[blocker.tool]?.required;
	if (typeof found !== "string" || typeof required !== "string" || !older(found, required)) return fixed;
	const version = found.replace(/^v/, "");
	const remedy = tool.remedy ? tool.remedy(required) : "Update it";
	return `${tool.label} ${version} is installed${tool.where}, but this installer needs ${required} or newer. Nothing was replaced. ${remedy}, then select Check again.`;
}

/** An older Pi's update names its found and target versions and the package
 * manager that owns it, and the installer's Pi added next to an older one names
 * both versions, from the plan's own record; anything else is fixed text. */
function actionDescription(action, plan) {
	const pi = plan.tools?.pi;
	const stable = (...versions) => versions.every((version) => typeof version === "string" && STABLE.test(version));
	const bare = (version) => version.replace(/^v/, "");
	if (action.id === "update-pi" && ["pnpm", "npm"].includes(pi?.owner) && stable(pi.version, pi.required, action.version)) {
		return `Update Pi ${bare(pi.version)} to ${bare(action.version)} with ${pi.owner}, the package manager that installed it. ` +
			`Gentle Shell needs Pi ${bare(pi.required)} or newer.`;
	}
	if (action.id === "install-pi" && pi?.status === "needs-install" && stable(pi.version)) {
		return `Install Pi ${PI_INSTALL_VERSION} globally with pnpm for Gentle Shell. The Pi ${bare(pi.version)} already on this computer ` +
			"was not installed with pnpm or npm, so it is left unchanged. Gentle Shell uses the installer's Pi; the `pi` command in a terminal may still run the older one.";
	}
	// The pinned Go: its version, the Go found (or missing), and what stays unchanged.
	const go = plan.tools?.go;
	if (action.id === "acquire-go" && go?.status === "needs-acquire" && stable(action.version, go.required)) {
		const found = stable(go.found) ? `Go ${bare(go.found)} on this computer is older than ${bare(go.required)}` : "Go is missing on this computer";
		return `${found}, so the installer downloads Go ${bare(action.version)} from go.dev, verifies its pinned SHA-256 checksum and uses it only to build Gentle AI. ` +
			"It is kept in the installer's own folder (~/.pi/gentle-ai/tools/go); your Go, PATH and shell profile are not changed.";
	}
	return actionDescriptions[action.id] ?? "Prepare the installation.";
}

/** An older Node or incompatible pnpm the plan records as left in place next to
 * the installer's pinned copy: found and pinned versions, from the plan itself.
 * Nothing promises PATH precedence: a version manager may prepend its own again.
 */
function alongsideNotes(plan) {
	const notes = [];
	const node = plan.tools?.node;
	if (STABLE.test(node?.found ?? "") && STABLE.test(node.version ?? "")) {
		notes.push(`Node.js ${node.found} on this computer is older than ${node.required}, so the installer uses its pinned Node.js ${node.version} ` +
			`and installs it under $PNPM_HOME. Your Node.js ${node.found} is left unchanged.`);
	}
	const pnpm = plan.tools?.pnpm;
	if (STABLE.test(pnpm?.found ?? "") && STABLE.test(pnpm.version ?? "")) {
		notes.push(`pnpm ${pnpm.found} on this computer is not a pnpm ${pnpm.version.split(".")[0]} release this installer can use, ` +
			`so the installer uses its pinned pnpm ${pnpm.version} and installs it under $PNPM_HOME. Your pnpm ${pnpm.found} is left unchanged.`);
	}
	if (notes.length > 0) notes.push("A version manager such as `mise activate` may still put your own versions first on PATH in new terminals.");
	return notes;
}

/** The private PNPM_HOME the plan uses instead of pnpm's default, and why. */
function privateHomeDescription(home) {
	const path = plainText(home.path);
	const fallback = plainText(home.default);
	return `pnpm's default folder ${fallback} is not private: ${findingText(home.finding)}. So the installer uses a new private folder, ${path}, as PNPM_HOME, ` +
		`which only you, SYSTEM and Administrators can change. \`pnpm setup\` will save PNPM_HOME=${path} in your user environment and add ${path}\\bin ` +
		`to your user PATH, so new terminals use it. Nothing in ${fallback} is changed. Open a new terminal afterwards. ` +
		// S13: pnpm reads its configuration folder only from XDG_CONFIG_HOME or %LOCALAPPDATA%\pnpm\config.
		"Only the installer's own pnpm steps keep pnpm's configuration, cache and state inside that private folder: pnpm commands you run later keep " +
		"pnpm's default configuration, cache and state under %LOCALAPPDATA%, which pnpm offers no safe persistent setting to move. This is an accepted risk.";
}

// S6 notice: reused tools whose folders another account can change (never a blocker).
const folderTools = Object.freeze({ node: "Node.js", npm: "npm", go: "Go", pi: "Pi", shell: "Gentle Shell" });
function sharedFoldersView(plan) {
	const reused = Array.isArray(plan.tools?.folders?.reused) ? plan.tools.folders.reused.filter((entry) => Object.hasOwn(folderTools, entry?.tool)) : [];
	if (reused.length === 0) return null;
	const found = reused.map((entry) => `${folderTools[entry.tool]}: ${findingText(entry)}`).join("; ");
	const unchecked = reused.some((entry) => entry.check === "unchecked");
	const weak = reused.some((entry) => entry.check !== "unchecked");
	const where = [weak ? "from folders another account can change" : null, unchecked ? "from folders whose permissions could not be checked" : null].filter(Boolean).join(", or ");
	const remedies = [weak ? "remove that account's write access" : null,
		unchecked ? "make sure your account can read the permissions of the paths that could not be checked, on a local drive" : null].filter(Boolean).join(", and ");
	return {
		tools: reused.map((entry) => entry.tool),
		description: `These tools are reused as they are, ${where}. ${found}. ` +
			"The installer never creates or runs its own programs there, but whoever can change those folders can change what these tools run for you, including for Gentle Shell. " +
			`This is an accepted risk and not a blocker. To remove it, ${remedies}, then select Check again.`,
	};
}

/** A bundled action's text, from the plan's own versions and paths (plain text). */
function bundledDescription(action, bundled) {
	const [root, bin, file] = [plainText(bundled.root), plainText(bundled.bin), plainText(bundled.path?.file)];
	const go = STABLE.test(bundled.go ?? "") ? ` and Go ${bundled.go}` : "";
	switch (action.id) {
	case "bundled-prefix": return `Create Gentle Shell's private folder, ${root}, for its own runtimes, its installed versions and the \`gentle-shell\` launcher.`;
	case "bundled-runtime": return `Download Gentle Shell's pinned Node.js ${plainText(bundled.node)} with its npm and pnpm ${plainText(bundled.pnpm)}${go}, verify their pinned checksums and keep them in that folder. ` +
		"Your own Node.js, npm, pnpm and Go are not used or changed.";
	case "bundled-version": return `Install Gentle Shell ${plainText(bundled.shell)} with Pi ${plainText(bundled.pi)} from the release's lockfile with \`pnpm install --frozen-lockfile\`, ` +
		"so every package is the exact version the release verified. Your npm registry, authentication and proxy settings are respected. Any Pi already on this computer is not used or changed.";
	case "bundled-path": return bundled.path?.kind === "registry" ? `Add ${bin} to your user PATH so new terminals find \`gentle-shell\`.`
		: bundled.path?.kind === "symlink" ? `Link ${file} to the \`gentle-shell\` launcher; that folder is already on your PATH.`
		: `Add one line to ${file} so new terminals find \`gentle-shell\`.`;
	case "bundled-setup": return "Run `gentle-shell setup` with the bundled launcher to set up Gentle Shell's own Pi home (~/.gentle-shell/agent).";
	default: return actionDescriptions[action.id] ?? "Prepare the installation.";
	}
}
/** The bundled plan's view: the same shape as planView's, with `bundled: true`. */
function bundledView(planId, plan) {
	const bundled = plan.bundled;
	const [root, bin, file, line] = [plainText(bundled.root), plainText(bundled.bin), plainText(bundled.path?.file), plainText(bundled.path?.line)];
	const kind = bundled.path?.kind;
	const profile = {
		symlink: `The installer links ${file} to the \`gentle-shell\` launcher. That folder is already on your PATH, so no shell profile changes.`,
		profile: `The installer adds one line to ${file} so new terminals find ${bin}. Open a new terminal afterwards.`,
		registry: `The installer adds ${bin} to your user PATH so new terminals find \`gentle-shell\`. Open a new terminal afterwards.`,
		manual: `The installer may not edit ${file} (a link, or a file it cannot write), so it changes nothing there: add this line to ${file} yourself, then open a new terminal: ${line}`,
	}[kind] ?? `Your PATH already finds ${bin}; no shell profile or PATH change is planned.`;
	const go = STABLE.test(bundled.go ?? "");
	return {
		planId,
		ready: false,
		bundled: true,
		actions: plan.actions.map((action) => ({ id: identifier(action.id), description: bundledDescription(action, bundled) })),
		blockers: [],
		profileChange: { changesProfile: ["symlink", "profile", "registry"].includes(kind), command: null, binDir: bin, description: profile },
		sharedFolders: null,
		persistence: {
			tools: ["node", "npm", "pnpm", ...(go ? ["go"] : [])],
			pnpmHome: root,
			description: `Gentle Shell installs as one self-contained product: its own pinned Node.js, npm, pnpm${go ? ", Go" : ""} and Pi, kept in ${root}. ` +
				"Your own Node.js, npm, pnpm, Go and Pi are not used or changed. Only your npm registry, authentication and proxy settings (from ~/.npmrc) are copied into that folder and respected.",
		},
	};
}

function planView(planId, { inventory, plan }) {
	if (plainObject(plan.bundled)) return bundledView(planId, plan);
	const ids = plan.actions.map((action) => action.id);
	const binDir = typeof inventory?.globalBin?.path === "string" ? inventory.globalBin.path : null;
	// A private PNPM_HOME (S6) is always persisted by `pnpm setup` (the runner's persist-path).
	const privateHome = plan.tools?.pnpmHome?.status === "private" ? plan.tools.pnpmHome : null;
	const pnpmHome = privateHome ? plainText(privateHome.path) : binDir === null ? null : dirname(binDir);
	const changesProfile = ids.includes("setup-global-bin") || (privateHome !== null && inventory?.globalBin?.onPath !== true);
	let tools = [];
	const alongside = alongsideNotes(plan);
	// A persistent pnpm next to a bootstrap-only Node is kept (persist-npm), never replaced.
	if (ids.includes("persist-node")) tools = ids.includes("persist-npm") ? ["node", "npm"] : ["node", "npm", "pnpm"];
	else if (ids.includes("persist-package-managers")) tools = ["npm", "pnpm"];
	else if (ids.includes("persist-npm")) tools = ["npm"];
	else if (ids.includes("persist-pnpm")) tools = ["pnpm"];
	// A user's pnpm in $PNPM_HOME/bin that could not be checked: kept, never run again.
	const unchecked = plan.tools?.pnpm?.unchecked === true
		? "The pnpm in the pnpm global bin directory could not be checked, so it was left as it is, and the installer uses its own verified pnpm for this installation."
		: null;
	return {
		planId,
		ready: plan.ready === true,
		actions: plan.actions.map((action) => ({
			id: identifier(action.id),
			description: actionDescription(action, plan),
		})),
		blockers: plan.blockers.map((blocker) => ({
			code: identifier(blocker.code),
			tool: toolName(blocker.tool),
			guidance: blockerGuidance(blocker, inventory, plan),
		})),
		profileChange: {
			changesProfile,
			command: "pnpm setup",
			binDir,
			description: privateHome ? privateHomeDescription(privateHome) : changesProfile
				? `\`pnpm setup\` will add ${binDir ?? "the pnpm global bin directory"} to your PATH: it edits your shell profile on macOS and Linux, or your user PATH on Windows. Open a new terminal afterwards.`
				: "Your PATH already contains the pnpm global bin directory; no shell profile or PATH change is planned.",
		},
		sharedFolders: sharedFoldersView(plan),
		persistence: {
			tools,
			pnpmHome,
			description: tools.length > 0
				? [`${tools.join(", ")} will be installed under $PNPM_HOME (${pnpmHome ?? "pnpm's home directory"}) so new terminals keep working after the temporary installer tools are removed. Existing installations are not replaced.`, ...alongside, ...(unchecked ? [unchecked] : [])].join(" ")
				: unchecked ? `No runtime needs to be installed under $PNPM_HOME. ${unchecked}`
				: "No runtime needs to be installed under $PNPM_HOME; your existing Node.js, npm and pnpm are reused.",
		},
	};
}

function outcomeView(result) {
	if (!plainObject(result) || !["ready", "terminal-action-required", "blocked", "failed"].includes(result.outcome)) {
		return { outcome: "failed", failedStep: null, completed: [], guidance: guidance.fallback };
	}
	const view = { outcome: result.outcome, completed: Array.isArray(result.completed) ? result.completed.map((step) => identifier(step)) : [] };
	if (result.outcome === "blocked") {
		view.reason = identifier(result.reason);
		view.guidance = guidance.blocked[result.reason] ?? guidance.fallback;
	} else if (result.outcome === "failed") {
		view.failedStep = identifier(result.failedStep);
		view.guidance = guidance.failed[result.failedStep] ?? guidance.fallback;
		const step = Object.hasOwn(detailSteps, result.failedStep) ? result.failedStep : null;
		const detail = step ? setupDetail(result.detail) : null;
		if (detail) {
			view.detail = detail;
			if (detailSteps[step](detail)) view.guidance = guidance[detailGuidance[step]];
		}
	} else {
		view.guidance = guidance.outcomes[result.outcome];
		// The Pi Gentle Shell runs, when pnpm put one other than the installer's next to it.
		if (typeof result.piVersion === "string" && STABLE.test(result.piVersion) && result.piVersion.replace(/^v/, "") !== PI_INSTALL_VERSION) {
			view.guidance += ` Gentle Shell runs Pi ${result.piVersion.replace(/^v/, "")}, which pnpm installed next to it.`;
		}
		if (result.action === "open-new-terminal") view.action = "open-new-terminal";
		// The bundled install's line for a profile it may not edit: plain text only.
		const pathLine = result.action === "add-path-line" && plainObject(result.pathLine) ? result.pathLine : null;
		if (pathLine) {
			view.action = "add-path-line";
			view.guidance = guidance.outcomes["add-path-line"];
			const [file, line] = [setupDetail(pathLine.file), setupDetail(pathLine.line)];
			if (file === pathLine.file && line === pathLine.line && file && line) view.pathLine = { file, line };
		}
		if (["configured", "unchanged"].includes(result.npmPrefix)) view.npmPrefix = result.npmPrefix;
	}
	return view;
}

/**
 * createInstallerServer({ collectPlan, runInstall, assetsDir, now?, random?, limits?, onRedeemed? })
 * collectPlan(channel) -> { inventory, plan } for "release" or "main" (fresh preflight, trusted local code);
 * runInstall({ plan, consent: true }, log) -> runner result; onRedeemed() runs once
 * when the one-time code is used (it must not throw). Returns
 * { listen(), close(reason), closed, checkIdle(), outcome() }.
 */
export function createInstallerServer({ collectPlan, runInstall, assetsDir, now = Date.now, random = randomBytes, limits = {},
	onRedeemed = () => {} }) {
	const limit = { ...defaultLimits, ...limits };
	const secret = token(random, 32);
	let code = token(random, 32);
	let codeExpires = 0;
	let port = 0;
	let origin = "";
	let lastActivity = now();
	let stored = null;
	const planning = { release: null, main: null };
	let installing = false;
	let lastOutcome = null;
	let seq = 0;
	const log = [];
	let idleTimer = null;
	let closing = null;
	let resolveClosed;
	const closed = new Promise((resolve) => { resolveClosed = resolve; });

	// requireHostHeader:false lets a missing Host get the same 421 as a wrong one.
	const server = createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: false }, (req, res) => {
		handle(req, res).catch(() => {
			if (!res.headersSent) reply(res, 500, { error: "internal" });
			else res.destroy();
		});
	});
	server.headersTimeout = limit.headersTimeoutMs;
	server.requestTimeout = limit.requestTimeoutMs;
	server.keepAliveTimeout = 5 * SECOND;

	function reply(res, status, body, headers = {}) {
		const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
		res.writeHead(status, {
			...securityHeaders,
			"Content-Type": "application/json; charset=utf-8",
			...headers,
			"Content-Length": Buffer.byteLength(payload),
		});
		res.end(payload);
	}

	function hasSession(req) {
		const pairs = String(req.headers.cookie ?? "").split(";").map((part) => part.trim())
			.filter((part) => part.startsWith(`${COOKIE}=`));
		return pairs.length === 1 && sameSecret(secret, pairs[0].slice(COOKIE.length + 1));
	}

	async function readJson(req, res) {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit.bodyBytes) {
			reply(res, 413, { error: "body-too-large" }, { Connection: "close" });
			return undefined;
		}
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit.bodyBytes) {
				reply(res, 413, { error: "body-too-large" }, { Connection: "close" });
				return undefined;
			}
			chunks.push(chunk);
		}
		try {
			return { value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") };
		} catch {
			return { value: undefined };
		}
	}

	function record(entry) {
		const value = plainObject(entry) ? entry : {};
		seq += 1;
		log.push({ seq, step: identifier(value.step), status: identifier(value.status),
			reason: value.reason === undefined || value.reason === null ? null : identifier(value.reason) });
		while (log.length > limit.logEntries) log.shift();
	}

	// One in-flight inventory per channel: the channels plan different steps.
	function collect(channel) {
		planning[channel] ??= Promise.resolve().then(() => collectPlan(channel)).finally(() => { planning[channel] = null; });
		return planning[channel];
	}

	async function getPlan(query, res) {
		// Only `?channel=release` or `?channel=main`; no query means release.
		const params = new URLSearchParams(query);
		const keys = [...params.keys()];
		const channel = query === "" ? "release" : params.get("channel");
		if ((query !== "" && (keys.length !== 1 || keys[0] !== "channel")) || !["release", "main"].includes(channel)) {
			reply(res, 400, { error: "invalid-request" });
			return;
		}
		// Probing while the runner mutates the machine would describe a moving target.
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		let collected;
		try {
			collected = await collect(channel);
		} catch {
			reply(res, 500, { error: "plan-unavailable" });
			return;
		}
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		stored = { planId: token(random, 18), channel, collected: structuredClone(collected), fingerprint: fingerprint(collected) };
		reply(res, 200, { ...planView(stored.planId, stored.collected), channel });
	}

	async function install(req, res) {
		const body = await readJson(req, res);
		if (body === undefined) return;
		const { value } = body;
		const keys = plainObject(value) ? Object.keys(value).sort() : [];
		if (keys.length !== 2 || keys[0] !== "consent" || keys[1] !== "planId" || value.consent !== true ||
			typeof value.planId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.planId)) {
			reply(res, 400, { error: "invalid-request" });
			return;
		}
		if (installing) {
			reply(res, 409, { error: "install-running" });
			return;
		}
		// One installation per wizard run: a final outcome is never replaced.
		if (lastOutcome !== null) {
			reply(res, 409, { error: "already-completed" });
			return;
		}
		if (stored === null || !sameSecret(stored.planId, value.planId)) {
			reply(res, 409, { error: "plan-changed" });
			return;
		}
		installing = true;
		const current = stored;
		let fresh;
		try {
			// Re-inventory: install only when the machine still matches the consented plan.
			fresh = await collect(current.channel);
		} catch {
			fresh = null;
		}
		if (fresh === null || stored !== current || fingerprint(fresh) !== current.fingerprint) {
			installing = false;
			stored = null;
			reply(res, 409, { error: "plan-changed" });
			return;
		}
		stored = null;
		const request = { plan: structuredClone(current.collected.plan), consent: true };
		// Viewing an untrusted result can throw; the installation must still end
		// with a failed outcome and release the single-flight and idle locks.
		Promise.resolve()
			.then(() => runInstall(request, record))
			.then((result) => {
				try {
					return outcomeView(result);
				} catch {
					return outcomeView(null);
				}
			}, () => outcomeView(null))
			.then((view) => {
				lastOutcome = view;
			})
			.finally(() => {
				installing = false;
				lastActivity = now();
			});
		reply(res, 202, { started: true });
	}

	function progress(query, res) {
		const params = new URLSearchParams(query);
		const keys = [...params.keys()];
		const after = params.get("after") ?? "0";
		if (keys.some((key) => key !== "after") || keys.length > 1 || !/^(0|[1-9]\d{0,15})$/.test(after)) {
			reply(res, 400, { error: "invalid-request" });
			return;
		}
		const from = Number(after);
		reply(res, 200, { entries: log.filter((entry) => entry.seq > from), running: installing, outcome: lastOutcome });
	}

	async function session(query, res) {
		const params = new URLSearchParams(query);
		const supplied = params.get("code");
		const valid = code !== null && now() <= codeExpires && [...params.keys()].length === 1 && supplied !== null && sameSecret(code, supplied);
		if (!valid) {
			reply(res, 401, { error: "unauthorized" });
			return;
		}
		code = null;
		lastActivity = now();
		try {
			onRedeemed();
		} catch {
			// Cleanup hooks are best effort and never break the session.
		}
		reply(res, 200, sessionPage, {
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": `${COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/`,
		});
	}

	async function asset(path, res) {
		let content;
		try {
			content = await readFile(join(assetsDir, assets[path].file));
		} catch {
			reply(res, 404, { error: "not-found" });
			return;
		}
		reply(res, 200, content, { "Content-Type": assets[path].type });
	}

	async function handle(req, res) {
		// Only authenticated requests (and a code redemption) count as activity.
		if (req.headers.host !== `${HOST}:${port}`) return reply(res, 421, { error: "misdirected" });
		const raw = String(req.url ?? "");
		const mark = raw.indexOf("?");
		const path = mark === -1 ? raw : raw.slice(0, mark);
		const query = mark === -1 ? "" : raw.slice(mark + 1);
		const method = routes[Object.hasOwn(routes, path) ? path : ""];
		if (method === undefined) return reply(res, 404, { error: "not-found" });
		if (req.method !== method) return reply(res, 405, { error: "method-not-allowed" }, { Allow: method });
		// Browsers send Origin on cross-origin GETs; only our own origin may.
		if (req.headers.origin !== undefined && req.headers.origin !== origin) return reply(res, 403, { error: "forbidden" });
		if (path === "/session") return session(query, res);
		if (!hasSession(req)) return reply(res, 401, { error: "unauthorized" });
		lastActivity = now();
		// A custom header makes every cross-origin API fetch need a CORS preflight, which never succeeds.
		if (path.startsWith("/api/") && req.headers["x-gentle-install"] !== "1") return reply(res, 403, { error: "forbidden" });
		if (method === "POST") {
			if (req.headers.origin !== origin) return reply(res, 403, { error: "forbidden" });
			const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
			if (type !== "application/json") return reply(res, 415, { error: "unsupported-media-type" });
		}
		if (query !== "" && path !== "/api/progress" && path !== "/api/plan") return reply(res, 400, { error: "invalid-request" });
		if (Object.hasOwn(assets, path)) return asset(path, res);
		if (path === "/api/plan") return getPlan(query, res);
		if (path === "/api/progress") return progress(query, res);
		if (path === "/api/install") return install(req, res);
		// /api/shutdown
		const body = await readJson(req, res);
		if (body === undefined) return undefined;
		if (body.value !== null && !(plainObject(body.value) && Object.keys(body.value).length === 0)) {
			return reply(res, 400, { error: "invalid-request" });
		}
		if (installing) return reply(res, 409, { error: "install-running" });
		res.once("finish", () => close("shutdown"));
		reply(res, 200, { closing: true });
		return undefined;
	}

	function checkIdle() {
		if (closing || installing || now() - lastActivity < limit.idleMs) return false;
		close("idle");
		return true;
	}

	function close(reason) {
		closing ??= new Promise((resolve) => {
			if (idleTimer) clearInterval(idleTimer);
			code = null;
			server.close(() => resolve());
			server.closeIdleConnections();
			setImmediate(() => server.closeAllConnections());
		}).then(() => {
			resolveClosed({ reason, outcome: lastOutcome });
		});
		return closing;
	}

	async function listen() {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: HOST, port: 0, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (typeof address !== "object" || address === null || address.address !== HOST || address.family !== "IPv4") {
			await close("bind-mismatch");
			throw new Error("Wizard host is not bound to 127.0.0.1");
		}
		port = address.port;
		origin = `http://${HOST}:${port}`;
		codeExpires = now() + limit.codeTtlMs;
		lastActivity = now();
		idleTimer = setInterval(checkIdle, limit.idleCheckMs);
		idleTimer.unref();
		return { port, address: address.address, origin, url: `${origin}/session?code=${code}` };
	}

	return { listen, close, closed, checkIdle, outcome: () => lastOutcome };
}
