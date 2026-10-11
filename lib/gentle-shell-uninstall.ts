import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isolatedDir, launcherConfigPath, parseRawLauncherConfig, provisionedEntry, userPiHome } from "./gentle-shell-launcher.ts";

// `gentle-shell self-uninstall`: removes what Gentle Shell itself created, then
// the gentle-pi package with the package manager that owns it. Everything is
// planned and printed before anything is removed. Removal follows the
// installer's safe-deletion model (scripts/installer-downloads.mjs
// removeOwnedTools): exact paths only, lstat first, symbolic links are never
// followed or removed, and rmSync never follows links inside a directory.
// `gentle-shell uninstall <source>` stays pi's own alias for `remove`.

export const SELF_UNINSTALL_USAGE = "usage: gentle-shell self-uninstall [--dry-run] [--yes] [--include-shared]";

/** Gentle AI configuration in the config home that Pi without Gentle Shell can share. */
export const SHARED_CONFIG_FILES: readonly string[] = Object.freeze([
	"profiles.json",
	"profiles.export.json",
	"banner.json",
	"builtin-codemode-optout.json",
	"background-subagents.json",
	"double-esc-cancel.json",
	"runtime-guardrails.json",
	"persona.json",
]);

const HOME_OWNERSHIP_MARKER = ".gentle-shell-home";
// scripts/installer-downloads.mjs marks each pinned Go version folder with it.
const GO_MARKER = ".gentle-shell-go";
const GO_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PACKAGE = "gentle-pi";

export interface SelfUninstallOptions {
	dryRun: boolean;
	yes: boolean;
	includeShared: boolean;
}

export function parseSelfUninstallArgs(args: readonly string[]): SelfUninstallOptions | { error: string } {
	const options = { dryRun: false, yes: false, includeShared: false };
	for (const arg of args) {
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--yes") options.yes = true;
		else if (arg === "--include-shared") options.includeShared = true;
		else return { error: `unknown argument ${arg}; ${SELF_UNINSTALL_USAGE}` };
	}
	return options;
}

/** How the owning package manager runs: `command` with `prefix` before its own
 * arguments (on Windows, node.exe and the manager's JS entry, never a .cmd). */
export interface PackageManagerOwner {
	name: "pnpm" | "npm";
	command: string;
	prefix: string[];
}

export interface RunResult {
	code: number | null;
	timedOut?: boolean;
	signal?: string | null;
}

export interface SelfUninstallInput {
	args: readonly string[];
	env: Record<string, string | undefined>;
	homedir: string;
	platform: string;
	/** Whether a person can answer questions (stdin is a terminal). */
	interactive: boolean;
	/** The package manager that owns gentle-pi; throws an Error to refuse. */
	resolveOwner: () => Promise<PackageManagerOwner>;
	run: (command: string, argv: string[]) => Promise<RunResult>;
	/** Resolves the typed line ("" at end of input); rejects with PromptInterrupted on Ctrl-C. */
	ask: (question: string) => Promise<string>;
	out: (line: string) => void;
	err: (line: string) => void;
}

interface Removal {
	path: string;
	label: string;
	/** "link": the symbolic link itself (the bundled install's `current`), never what it points at. */
	kind: "dir" | "file" | "link";
	/** Remove the parent directory too when this leaves it empty. */
	pruneParent?: boolean;
	/** Evidence that Gentle Shell made it; without it the path is kept with this reason. */
	evidence?: { made: (path: string) => boolean; otherwise: string };
}

interface Guard {
	path: string;
	label: string;
	/** Whether lying inside `path` is refused too (being it or containing it always is). */
	inside: boolean;
}

interface NotTouched {
	path?: string;
	label: string;
}

interface Plan {
	refusals: string[];
	/** A removal would reach a protected path: the removal list is not offered at all. */
	pathRefused: boolean;
	own: Removal[];
	kept: string[];
	shared: Removal[];
	configHome: string;
	owner?: PackageManagerOwner;
	notTouched: NotTouched[];
	manual: string[];
}

function comparable(path: string, platform: string): string {
	return platform === "win32" ? path.toLowerCase() : path;
}

/** The real path, resolving the nearest existing ancestor when `path` does not exist. */
function canonical(path: string): string {
	const absolute = resolve(path);
	const rest: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			return join(realpathSync(current), ...rest);
		} catch {
			const parent = dirname(current);
			if (parent === current) return absolute;
			rest.unshift(basename(current));
			current = parent;
		}
	}
}

/** True when `child` is `parent` itself or lies inside it. */
function within(parent: string, child: string, platform: string): boolean {
	const path = relative(comparable(parent, platform), comparable(child, platform));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

type Inspection = "ok" | "missing" | "symlink" | "other";

function inspect(path: string, kind: "dir" | "file" | "link"): Inspection {
	let info;
	try {
		info = lstatSync(path);
	} catch {
		return "missing";
	}
	if (kind === "link") return info.isSymbolicLink() ? "ok" : "other";
	if (info.isSymbolicLink()) return "symlink";
	return (kind === "dir" ? info.isDirectory() : info.isFile()) ? "ok" : "other";
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** An absolute directory from `env[name]`, the fallback when unset or empty, or undefined when relative. */
function settingDirectory(env: Record<string, string | undefined>, name: string, fallback: string): string | undefined {
	const value = env[name];
	if (value === undefined || value === "") return fallback;
	return isAbsolute(value) ? value : undefined;
}

function entries(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return ["\0unreadable"];
	}
}

/** Only what the main channel writes (scripts/main-channel.mjs): gentle-ai/<commit>/gentle-ai[.exe],
 * packages/gentle-pi-*.tgz, and the .build and .source work folders. */
function mainChannelLayout(main: string): boolean {
	return entries(main).every((name) => {
		const path = join(main, name);
		if (inspect(path, "dir") !== "ok") return false;
		if (name === ".build" || name === ".source") return true;
		if (name === "packages") return entries(path).every((file) => /^gentle-pi-.+\.tgz$/.test(file) && inspect(join(path, file), "file") === "ok");
		if (name !== "gentle-ai") return false;
		return entries(path).every((commit) => COMMIT.test(commit) && inspect(join(path, commit), "dir") === "ok"
			&& entries(join(path, commit)).every((file) => ["gentle-ai", "gentle-ai.exe"].includes(file) && inspect(join(path, commit, file), "file") === "ok"));
	});
}

/** Only pinned-Go version folders, each carrying the installer's marker. */
function pinnedGoOnly(go: string): boolean {
	return entries(go).every((name) => GO_VERSION.test(name) && inspect(join(go, name), "dir") === "ok" && inspect(join(go, name, GO_MARKER), "file") === "ok");
}

/** How `real` collides with a guard: it is it, contains it, or (for guards that say so) lies inside it. */
function collision(real: string, guards: readonly Guard[], platform: string): string | undefined {
	for (const guard of guards) {
		const target = canonical(guard.path);
		const relation = comparable(real, platform) === comparable(target, platform) ? "is"
			: within(real, target, platform) ? "contains"
			: guard.inside && within(target, real, platform) ? "lies inside" : undefined;
		if (relation) return `${relation} ${guard.path} (${guard.label})`;
	}
	return undefined;
}

/** A `.pi` directory (a project's `.pi`, `.pi/gentle-ai`, or the user's `~/.pi`) is never removed or emptied. */
function piDirectoryCollision(real: string, platform: string, allowedInside: string | undefined): string | undefined {
	const segments = real.split(/[\\/]+/).filter((segment) => segment !== "");
	const isPi = (segment: string | undefined) => segment !== undefined && comparable(segment, platform) === ".pi";
	const exempt = allowedInside !== undefined && comparable(real, platform) === comparable(allowedInside, platform);
	if (!exempt && isPi(segments.at(-1))) return "is a .pi directory";
	if (!exempt && segments.slice(0, -1).some(isPi)) return "lies inside a .pi directory";
	if (inspect(join(real, ".pi"), "dir") !== "missing") return `contains a .pi directory (${join(real, ".pi")})`;
	return undefined;
}

/** Whether the main-channel override in `dev-binary.json` points at a build under `<config home>/main/gentle-ai`. */
function mainChannelRegistration(path: string, configHome: string, platform: string): boolean {
	try {
		const registration = JSON.parse(readText(path) ?? "null");
		if (typeof registration?.path !== "string") return false;
		const builds = join(configHome, "main", "gentle-ai");
		return within(builds, registration.path, platform) && resolve(registration.path) !== resolve(builds);
	} catch {
		return false;
	}
}

async function planSelfUninstall(input: SelfUninstallInput, configHome: string, isolated: string): Promise<Plan> {
	const { env, homedir, platform } = input;
	const plan: Plan = { refusals: [], pathRefused: false, own: [], kept: [], shared: [], configHome, notTouched: [], manual: [] };
	const configPath = launcherConfigPath(homedir);
	const shellDirectory = dirname(configPath);
	const launcherConfig = parseRawLauncherConfig(readText(configPath));
	const piHome = userPiHome(env, homedir);
	const gentleAiState = join(homedir, ".gentle-ai");
	const isolatedReal = canonical(isolated);

	// Every place a removal starts from is checked at its real path, so a symbolic
	// link (or a symlinked ancestor) never leads it somewhere protected.
	// Inside a Gentle Shell session PI_CODING_AGENT_DIR is the isolated home itself
	// and the user's Pi home travels in GENTLE_SHELL_USER_PI_HOME (see userPiHome).
	// Only an existing directory other than the isolated home proves that session.
	const sessionPiHome = env.GENTLE_SHELL_USER_PI_HOME ? canonical(env.GENTLE_SHELL_USER_PI_HOME) : null;
	const inSession = sessionPiHome !== null && inspect(sessionPiHome, "dir") === "ok"
		&& comparable(sessionPiHome, platform) !== comparable(isolatedReal, platform);
	const sessionAgentDir = (name: string, value: string) => name === "PI_CODING_AGENT_DIR" && inSession
		&& comparable(canonical(value), platform) === comparable(isolatedReal, platform);
	const guards: Guard[] = [
		{ path: homedir, label: "your home directory", inside: false },
		{ path: join(homedir, ".pi", "agent"), label: "Pi's default home", inside: true },
		...["PI_CODING_AGENT_DIR", "GENTLE_SHELL_USER_PI_HOME"].flatMap((name) => {
			const value = env[name];
			return value && !sessionAgentDir(name, value) ? [{ path: value, label: "your Pi home", inside: true }] : [];
		}),
		{ path: gentleAiState, label: "Gentle AI's state", inside: true },
	];
	const defaultConfigHome = canonical(join(homedir, ".pi", "gentle-ai"));
	const candidates = [
		{
			who: env.GENTLE_SHELL_HOME ? `GENTLE_SHELL_HOME points at ${isolated}` : `The isolated home ${isolated}`,
			path: isolated,
			guards: [...guards, { path: configHome, label: "the Gentle AI config home", inside: true }],
			allowedInsidePi: undefined,
		},
		{
			who: env.GENTLE_PI_CONFIG_HOME ? `GENTLE_PI_CONFIG_HOME points at ${configHome}` : `The config home ${configHome}`,
			path: configHome,
			guards,
			// Its default location, ~/.pi/gentle-ai, is the one .pi path it may be.
			allowedInsidePi: defaultConfigHome,
		},
		{ who: `The launcher folder ${shellDirectory}`, path: shellDirectory, guards, allowedInsidePi: undefined },
	];
	for (const candidate of candidates) {
		const real = canonical(candidate.path);
		const reason = collision(real, candidate.guards, platform) ?? piDirectoryCollision(real, platform, candidate.allowedInsidePi);
		if (reason === undefined) continue;
		const really = comparable(real, platform) === comparable(resolve(candidate.path), platform) ? "" : ` (really ${real})`;
		plan.refusals.push(`${candidate.who}${really}, which ${reason}; refusing to remove anything.`);
	}

	const consider = (removal: Removal) => {
		const state = inspect(removal.path, removal.kind);
		if (state === "ok" && removal.evidence && !removal.evidence.made(removal.path)) plan.kept.push(`${removal.path}: ${removal.evidence.otherwise}`);
		else if (state === "ok") plan.own.push(removal);
		else if (state === "symlink") plan.kept.push(`${removal.path}: a symbolic link, not followed`);
		else if (state === "other") plan.kept.push(`${removal.path}: not a ${removal.kind === "dir" ? "directory" : "regular file"}`);
	};
	consider({
		path: join(configHome, "main"), label: "main-channel builds", kind: "dir",
		evidence: { made: mainChannelLayout, otherwise: "not Gentle Shell's main-channel layout" },
	});
	consider({ path: join(configHome, "channel.json"), label: "recorded update channel", kind: "file" });
	const devBinary = join(configHome, "dev-binary.json");
	if (inspect(devBinary, "file") !== "ok" || mainChannelRegistration(devBinary, configHome, platform)) {
		consider({ path: devBinary, label: "main-channel Gentle AI override", kind: "file" });
	} else {
		plan.kept.push(`${devBinary}: points at a binary you registered yourself`);
	}
	consider({
		path: join(configHome, "tools", "go"), label: "Go the installer downloaded for builds", kind: "dir", pruneParent: true,
		evidence: { made: pinnedGoOnly, otherwise: `not only the installer's pinned Go (version folders marked ${GO_MARKER})` },
	});

	// The default isolated home is Gentle Shell's by location; a GENTLE_SHELL_HOME
	// directory only with the launcher's ownership marker or setup record.
	const defaultHome = resolve(isolated) === resolve(join(homedir, ".gentle-shell", "agent"));
	const owned = defaultHome || inspect(join(isolated, HOME_OWNERSHIP_MARKER), "file") === "ok"
		|| provisionedEntry(launcherConfig, isolatedReal) !== undefined;
	if (owned || inspect(isolated, "dir") !== "ok") consider({ path: isolated, label: "isolated home: its sign-ins, chats and settings", kind: "dir" });
	else plan.kept.push(`${isolated}: not created by Gentle Shell (no ${HOME_OWNERSHIP_MARKER} marker or setup record)`);
	consider({ path: configPath, label: "launcher settings", kind: "file" });

	for (const name of SHARED_CONFIG_FILES) {
		const path = join(configHome, name);
		if (inspect(path, "file") === "ok") plan.shared.push({ path, label: name, kind: "file" });
	}

	const seen = new Set([comparable(isolatedReal, platform), comparable(canonical(piHome), platform)]);
	plan.notTouched.push({ path: piHome, label: "your Pi home" });
	const customHomes = [typeof launcherConfig.home === "string" && !["link", "isolated", ""].includes(launcherConfig.home) ? launcherConfig.home : undefined];
	const provisioned = launcherConfig.provisioned;
	if (typeof provisioned === "object" && provisioned !== null && !Array.isArray(provisioned)) customHomes.push(...Object.keys(provisioned));
	for (const home of customHomes) {
		if (home === undefined || !isAbsolute(home)) continue;
		const key = comparable(canonical(home), platform);
		if (seen.has(key)) continue;
		seen.add(key);
		plan.notTouched.push({ path: home, label: "custom --home home" });
	}
	plan.notTouched.push({ path: gentleAiState, label: "Gentle AI's own state" }, { label: "Each project's .pi/gentle-ai folder" });

	// Nothing is both removed and not touched: a removal that is, holds or lies
	// inside a path listed as not touched refuses the whole run.
	if (plan.refusals.length === 0) {
		for (const removal of [...plan.own, ...plan.shared]) {
			const real = canonical(removal.path);
			for (const kept of plan.notTouched) {
				if (kept.path === undefined) continue;
				const target = canonical(kept.path);
				if (!within(real, target, platform) && !within(target, real, platform)) continue;
				plan.refusals.push(`${removal.path} would be removed, but it overlaps ${kept.path} (${kept.label}), which is not touched; refusing to remove anything.`);
			}
		}
	}
	plan.pathRefused = plan.refusals.length > 0;

	plan.manual.push(
		"Pi: pnpm remove -g @earendil-works/pi-coding-agent (or npm uninstall -g @earendil-works/pi-coding-agent)",
		"Engram, installed by Gentle AI's setup: remove the engram binary on your PATH",
		platform === "win32"
			? "The PATH entry from `pnpm setup`: remove PNPM_HOME and its PATH entry from your user environment variables"
			: "The PATH entry from `pnpm setup`: remove the PNPM_HOME lines it added to your shell profile",
	);
	if (platform === "win32") {
		plan.manual.push("%USERPROFILE%\\.pnpm, the private pnpm home the installer may have chosen: delete it after removing the packages above");
	}

	try {
		plan.owner = await input.resolveOwner();
	} catch (error) {
		plan.refusals.push(`The ${PACKAGE} package cannot be removed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return plan;
}

function removeArgv(owner: PackageManagerOwner): string[] {
	return owner.name === "pnpm" ? ["remove", "-g", PACKAGE] : ["uninstall", "-g", PACKAGE];
}

function printPlan(plan: Plan, options: SelfUninstallOptions, interactive: boolean, out: (line: string) => void) {
	out("Gentle Shell self-uninstall plan");
	out("Remove Gentle Shell data:");
	if (plan.pathRefused) out("  (refused, see below)");
	else if (plan.own.length === 0) out("  (nothing found)");
	for (const removal of plan.pathRefused ? [] : plan.own) out(`  ${removal.path}  (${removal.label})`);
	out(`Remove the ${PACKAGE} package:`);
	out(plan.owner ? `  ${plan.owner.name} ${removeArgv(plan.owner).join(" ")}` : "  (refused, see below)");
	if (plan.shared.length > 0 && !plan.pathRefused) {
		const disposition = options.includeShared
			? "removed (--include-shared)"
			: options.yes || !interactive ? "kept; pass --include-shared to remove it" : "kept unless you accept when asked";
		out(`Shared Gentle AI configuration in ${plan.configHome}, ${disposition}:`);
		for (const removal of plan.shared) out(`  ${removal.path}`);
	}
	if (plan.kept.length > 0) {
		out("Kept:");
		for (const line of plan.kept) out(`  ${line}`);
	}
	out("Not touched:");
	for (const kept of plan.notTouched) out(kept.path === undefined ? `  ${kept.label}` : `  ${kept.path}  (${kept.label})`);
	out("The installer may also have added these; remove them yourself if nothing else uses them:");
	for (const line of plan.manual) out(`  ${line}`);
}

/** Removes one planned path without following links; re-checks it right before removal. */
function remove(removal: Removal) {
	const state = inspect(removal.path, removal.kind);
	if (state === "missing") return;
	if (state !== "ok") throw new Error("it changed after the plan was made");
	if (removal.kind === "dir") rmSync(removal.path, { recursive: true });
	else rmSync(removal.path);
	if (removal.pruneParent) removeIfEmpty(dirname(removal.path));
}

function removeIfEmpty(directory: string) {
	if (inspect(directory, "dir") === "ok" && readdirSync(directory).length === 0) rmdirSync(directory);
}

/** Ctrl-C at a question: the whole uninstall stops. */
export class PromptInterrupted extends Error {
	constructor() {
		super("interrupted");
		this.name = "PromptInterrupted";
	}
}

/**
 * Asks one question on `input` and returns the typed line. End of input (Ctrl-D,
 * a closed stdin) answers "", which every question reads as No; Ctrl-C rejects
 * with PromptInterrupted. `terminal` follows readline (default: output.isTTY).
 */
export function askLine(question: string, streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; terminal?: boolean }): Promise<string> {
	const input = streams.input as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
	if (input.readableEnded === true || input.destroyed === true) return Promise.resolve("");
	return new Promise((resolveAnswer, reject) => {
		let settled = false;
		const prompt = createInterface({ input: streams.input, output: streams.output, terminal: streams.terminal });
		prompt.once("SIGINT", () => {
			if (settled) return;
			settled = true;
			prompt.close();
			reject(new PromptInterrupted());
		});
		prompt.once("close", () => {
			if (settled) return;
			settled = true;
			resolveAnswer("");
		});
		prompt.question(question, (answer) => {
			if (settled) return;
			settled = true;
			prompt.close();
			resolveAnswer(answer);
		});
	});
}

function isYes(answer: string): boolean {
	return /^(y|yes)$/i.test(answer.trim());
}

/**
 * The one confirmation both uninstalls ask: --yes skips it; without a terminal
 * it is a usage error (2); No or end of input cancels and Ctrl-C aborts (1).
 * The shared data is asked about separately, default No. Returns whether to
 * include the shared data, or the exit code.
 */
async function confirm(
	input: Pick<SelfUninstallInput, "interactive" | "ask" | "out" | "err">,
	options: SelfUninstallOptions,
	sharedPresent: boolean,
	sharedQuestion: string,
): Promise<{ includeShared: boolean } | { code: number }> {
	let includeShared = options.includeShared;
	if (options.yes) return { includeShared };
	if (!input.interactive) {
		input.err("gentle-shell self-uninstall: no terminal to confirm in; pass --yes to remove the above, or --dry-run to only show it.");
		return { code: 2 };
	}
	try {
		if (!isYes(await input.ask("Remove Gentle Shell as listed above? [y/N] "))) {
			input.out("Cancelled; nothing was removed.");
			return { code: 1 };
		}
		if (sharedPresent && !includeShared) includeShared = isYes(await input.ask(sharedQuestion));
	} catch (error) {
		if (!(error instanceof PromptInterrupted)) throw error;
		input.err("gentle-shell self-uninstall: Interrupted; nothing was removed.");
		return { code: 1 };
	}
	return { includeShared };
}

function succeeded(result: RunResult): boolean {
	return result.code === 0 && result.timedOut !== true && result.signal == null;
}

/**
 * Runs `gentle-shell self-uninstall`. Exit codes: 0 done or dry run, 1 refused,
 * cancelled or failed, 2 usage (including no terminal without --yes).
 */
export async function runSelfUninstall(input: SelfUninstallInput): Promise<number> {
	const { env, homedir, out, err } = input;
	const options = parseSelfUninstallArgs(input.args);
	if ("error" in options) {
		err(`gentle-shell self-uninstall: ${options.error}`);
		return 2;
	}
	const configHome = settingDirectory(env, "GENTLE_PI_CONFIG_HOME", join(homedir, ".pi", "gentle-ai"));
	const isolated = settingDirectory(env, "GENTLE_SHELL_HOME", isolatedDir(env, homedir));
	if (configHome === undefined || isolated === undefined) {
		const name = configHome === undefined ? "GENTLE_PI_CONFIG_HOME" : "GENTLE_SHELL_HOME";
		err(`gentle-shell self-uninstall: ${name}=${env[name]} is not an absolute path; refusing to remove anything.`);
		return 1;
	}

	const plan = await planSelfUninstall(input, configHome, isolated);
	printPlan(plan, options, input.interactive, out);
	if (plan.refusals.length > 0 || plan.owner === undefined) {
		for (const line of plan.refusals) err(`gentle-shell self-uninstall: ${line}`);
		err("Nothing was removed.");
		return 1;
	}
	if (options.dryRun) {
		out("Dry run: nothing was removed.");
		return 0;
	}
	const confirmation = await confirm(input, options, plan.shared.length > 0,
		`Also remove the shared Gentle AI configuration in ${plan.configHome} listed above? [y/N] `);
	if ("code" in confirmation) return confirmation.code;
	const { includeShared } = confirmation;

	for (const removal of [...plan.own, ...(includeShared ? plan.shared : [])]) {
		try {
			remove(removal);
		} catch (error) {
			err(`gentle-shell self-uninstall: could not remove ${removal.path}: ${error instanceof Error ? error.message : String(error)}`);
			err(`The ${PACKAGE} package and everything listed after it were kept; fix the cause and run gentle-shell self-uninstall again.`);
			return 1;
		}
	}

	const command = `${plan.owner.name} ${removeArgv(plan.owner).join(" ")}`;
	let removed = false;
	try {
		removed = succeeded(await input.run(plan.owner.command, [...plan.owner.prefix, ...removeArgv(plan.owner)]));
	} catch {
		removed = false;
	}
	if (!removed) {
		err(`gentle-shell self-uninstall: ${plan.owner.name} could not remove the ${PACKAGE} package. Gentle Shell's data was removed; remove the package yourself with: ${command}`);
		return 1;
	}
	try {
		removeIfEmpty(dirname(launcherConfigPath(homedir)));
	} catch {
		// A leftover empty ~/.gentle-shell is harmless.
	}
	out("Gentle Shell was removed.");
	return 0;
}

// ---------------------------------------------------------------------------
// The bundled install (S6, S7): `gentle-shell self-uninstall` from the bundled
// launcher removes what scripts/bundled-install.mjs wrote in its prefix and the
// one PATH entry its receipt records. The Gentle Shell home (sessions,
// sign-ins, extensions) is shared data, kept unless asked. The same planning,
// confirmation and safe-deletion rules as above apply.
// ---------------------------------------------------------------------------

/** The PATH entry a bundled install applied, read from its receipt
 * (scripts/bundled-install.mjs readPathReceipt). Only "recorded" is removed;
 * without a valid receipt the entry is named for the user, never guessed. */
export type BundledPathEntry =
	| { status: "recorded"; description: string; remove: () => { removed: boolean; note?: string } }
	| { status: "none" }
	| { status: "invalid"; reason: string };

export interface BundledSelfUninstallInput extends Pick<SelfUninstallInput, "args" | "env" | "homedir" | "platform" | "interactive" | "ask" | "out" | "err"> {
	/** The prefix of the bundled install this launcher runs from (resolveBundledInstall), a real path. */
	root: string;
	pathEntry: BundledPathEntry;
	/** This process: on Windows its node.exe and the .cmd launcher cannot be removed while it runs. */
	process: { pid: number; execPath: string };
	/** Windows: removes `files`, then `last` (the prefix marker) once nothing is left at those paths,
	 * then each of `directories` that is empty, once process `pid` exited. */
	deferRemoval?: (request: { pid: number; files: string[]; last?: string; directories: string[] }) => void;
}

// What scripts/bundled-install.mjs writes in the prefix, by name.
const BUNDLED_OWN: readonly { name: string; label: string; kind: "dir" | "file" | "current" }[] = Object.freeze([
	{ name: "bin", label: "the gentle-shell launcher", kind: "dir" },
	{ name: "current", label: "the active version", kind: "current" },
	{ name: "versions", label: "the installed Gentle Shell versions", kind: "dir" },
	{ name: "versions.history", label: "the version history", kind: "file" },
	{ name: "runtime", label: "the bundled Node.js, npm, pnpm, Go and Engram", kind: "dir" },
	{ name: "pnpm", label: "pnpm's store, cache, state and settings", kind: "dir" },
	{ name: "npm", label: "npm's cache, prefix and settings", kind: "dir" },
	{ name: "gentle-ai", label: "Gentle AI's state for this install", kind: "dir" },
	{ name: "config", label: "Gentle Shell's settings for this install (config/gentle-ai)", kind: "dir" },
	{ name: "tmp", label: "temporary files", kind: "dir" },
	{ name: "path-entry.json", label: "the PATH entry receipt", kind: "file" },
]);
// The Windows prefix's claim marker (ensureWindowsPrivateFolder, scripts/bundled-install.mjs).
const BUNDLED_WINDOWS_MARKER = Object.freeze({ name: ".gentle-shell-bundle", text: "gentle-shell bundled install" });
const BUNDLED_PROFILE_MARK = "# gentle-shell bundled install";

interface BundledPlan {
	refusals: string[];
	own: Removal[];
	shared: Removal[];
	kept: string[];
	/** Nothing foreign is in the prefix: it goes too, once nothing is left in it. */
	removeRoot: boolean;
	/** Windows: files this process holds, removed after it exits. */
	held: string[];
	notTouched: NotTouched[];
	shellHome: string;
}

function planBundledSelfUninstall(input: BundledSelfUninstallInput): BundledPlan {
	const { env, homedir, platform, root } = input;
	const windows = platform === "win32";
	const same = (a: string, b: string) => comparable(a, platform) === comparable(b, platform);
	const shellHome = join(homedir, ".gentle-shell");
	const plan: BundledPlan = { refusals: [], own: [], shared: [], kept: [], removeRoot: false, held: [], notTouched: [], shellHome };
	const refuse = (reason: string) => plan.refusals.push(`The bundled prefix ${root} ${reason}; refusing to remove anything.`);
	const piHome = userPiHome(env, homedir);
	const userGuards: Guard[] = [
		{ path: homedir, label: "your home directory", inside: false },
		{ path: join(homedir, ".pi"), label: "Pi's folder", inside: true },
		{ path: join(homedir, ".gentle-ai"), label: "Gentle AI's state", inside: true },
		{ path: join(homedir, ".engram"), label: "Engram's memory", inside: true },
	];
	const guards: Guard[] = [...userGuards, { path: piHome, label: "your Pi home", inside: true }];

	// Ours only by proof: never through a link, the Windows claim marker, or on
	// POSIX the one folder claimPrefix uses, as a real directory.
	const real = canonical(root);
	if (!same(real, resolve(root))) refuse(`is reached through a symbolic link (really ${real})`);
	const rootCollision = collision(real, userGuards, platform);
	if (rootCollision) refuse(`${rootCollision}`);
	if (windows) {
		const marker = join(root, BUNDLED_WINDOWS_MARKER.name);
		const text = inspect(marker, "file") === "ok" ? readText(marker) : undefined;
		if (text === undefined) refuse(`has no ${BUNDLED_WINDOWS_MARKER.name} marker`);
		else if (text.replace(/\r?\n$/, "") !== BUNDLED_WINDOWS_MARKER.text) refuse(`has a ${BUNDLED_WINDOWS_MARKER.name} marker that is not the bundled install's`);
	} else if (inspect(shellHome, "dir") !== "ok" || !same(canonical(shellHome), real)) {
		refuse(`is not ${shellHome}, the folder a bundled install uses, as a real directory`);
	}
	let names: string[] = [];
	try {
		names = readdirSync(root);
	} catch {
		refuse("cannot be read");
	}
	if (plan.refusals.length > 0) return plan;

	let foreign = false;
	const consider = (path: string, label: string, kind: "dir" | "file" | "current", into: Removal[]) => {
		const removalKind = kind === "current" ? (windows ? "file" : "link") : kind;
		const state = inspect(path, removalKind);
		if (state === "missing") return;
		const ours = state === "ok" && (removalKind !== "link" || /^versions\/[^/]+$/.test(readlinkSync(path)));
		if (ours) {
			into.push({ path, label, kind: removalKind });
			return;
		}
		if (same(dirname(path), root)) foreign = true;
		const what = removalKind === "link" ? "a link to an installed version" : removalKind === "dir" ? "a directory" : "a regular file";
		plan.kept.push(`${path}: ${state === "symlink" ? "a symbolic link, not followed" : `not ${what}`}`);
	};
	for (const item of BUNDLED_OWN) consider(join(root, item.name), item.label, item.kind, plan.own);
	if (windows) consider(join(root, BUNDLED_WINDOWS_MARKER.name), "the bundled install's folder marker", "file", plan.own);
	consider(join(shellHome, "agent"), "your sign-ins, chats, settings and extensions", "dir", plan.shared);
	consider(join(shellHome, "config.json"), "the launcher's settings", "file", plan.shared);
	const known = new Set([...BUNDLED_OWN.map((item) => item.name), ...(windows ? [BUNDLED_WINDOWS_MARKER.name] : []),
		...(same(canonical(shellHome), real) ? ["agent", "config.json"] : [])]);
	for (const name of names) {
		if (known.has(name)) continue;
		foreign = true;
		plan.kept.push(`${join(root, name)}: not written by the bundled install`);
	}
	plan.removeRoot = !foreign;

	for (const removal of [...plan.own, ...plan.shared]) {
		const reason = collision(canonical(removal.path), guards, platform);
		if (reason) plan.refusals.push(`${removal.path} would be removed, but it ${reason}; refusing to remove anything.`);
	}

	plan.notTouched.push({ path: piHome, label: "your Pi home" }, { path: join(homedir, ".pi", "gentle-ai"), label: "Gentle AI's configuration for Pi" },
		{ path: join(homedir, ".gentle-ai"), label: "Gentle AI's own state" }, { path: join(homedir, ".engram"), label: "Engram's memory" });
	if (env.GENTLE_SHELL_HOME && !same(canonical(env.GENTLE_SHELL_HOME), canonical(join(shellHome, "agent")))) {
		plan.notTouched.push({ path: env.GENTLE_SHELL_HOME, label: "the Gentle Shell home GENTLE_SHELL_HOME names" });
	}

	// Windows: the running node.exe, the .cmd launcher and the marker (last) wait for this process to exit.
	if (windows) {
		const candidates = [canonical(input.process.execPath), join(root, "bin", "gentle-shell.cmd"), join(root, BUNDLED_WINDOWS_MARKER.name)];
		plan.held = candidates.filter((path, index) => candidates.indexOf(path) === index && inspect(path, "file") === "ok"
			&& plan.own.some((removal) => within(removal.path, path, platform)));
	}
	return plan;
}

/** Removes `directory`'s contents except the `held` files and the folders above them. */
function removeExcept(directory: string, held: readonly string[], platform: string) {
	if (inspect(directory, "dir") !== "ok") throw new Error("it changed after the plan was made");
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (held.some((file) => comparable(file, platform) === comparable(path, platform))) continue;
		if (held.some((file) => within(path, file, platform))) removeExcept(path, held, platform);
		else rmSync(path, { recursive: true });
	}
}

/** The folders the deferred removal empties, deepest first, then the prefix when it may go. */
function heldDirectories(plan: BundledPlan, root: string, platform: string): string[] {
	const directories: string[] = [];
	for (const file of plan.held) {
		for (let folder = dirname(file); within(root, folder, platform) && comparable(folder, platform) !== comparable(root, platform); folder = dirname(folder)) {
			if (!directories.includes(folder)) directories.push(folder);
		}
	}
	const depth = (path: string) => path.split(/[\\/]+/).length;
	return [...directories.sort((a, b) => depth(b) - depth(a)), ...(plan.removeRoot ? [root] : [])];
}

function manualPathEntry(root: string, platform: string): string {
	return platform === "win32"
		? `If a new terminal still finds gentle-shell, remove ${join(root, "bin")} from your user Path (HKCU\\Environment).`
		: `If a new terminal still finds gentle-shell, remove the line ending in "${BUNDLED_PROFILE_MARK}" from your shell's startup file, `
			+ `or the gentle-shell link in ~/.local/bin to ${join(root, "bin", "gentle-shell")}.`;
}

function printBundledPlan(plan: BundledPlan, input: BundledSelfUninstallInput, options: SelfUninstallOptions) {
	const { out, pathEntry, root } = input;
	out(`Gentle Shell self-uninstall plan (bundled install in ${root})`);
	out("Remove the PATH entry:");
	out(pathEntry.status === "recorded" ? `  ${pathEntry.description}` : "  (none recorded; see below)");
	out("Remove the bundled install:");
	if (plan.refusals.length > 0) out("  (refused, see below)");
	for (const removal of plan.refusals.length > 0 ? [] : plan.own) out(`  ${removal.path}  (${removal.label})`);
	if (plan.refusals.length === 0 && plan.removeRoot) out(`  ${root} itself, once nothing else is left in it`);
	if (plan.shared.length > 0 && plan.refusals.length === 0) {
		const disposition = options.includeShared
			? "removed (--include-shared)"
			: options.yes || !input.interactive ? "kept; pass --include-shared to remove it" : "kept unless you accept when asked";
		out(`Your Gentle Shell home, shared with every Gentle Shell install, ${disposition}:`);
		for (const removal of plan.shared) out(`  ${removal.path}  (${removal.label})`);
	}
	if (plan.kept.length > 0) {
		out("Kept:");
		for (const line of plan.kept) out(`  ${line}`);
	}
	out("Not touched:");
	for (const kept of plan.notTouched) out(kept.path === undefined ? `  ${kept.label}` : `  ${kept.path}  (${kept.label})`);
	if (pathEntry.status !== "recorded") {
		out("The PATH entry was not recorded, so it is not guessed at; remove it yourself:");
		if (pathEntry.status === "invalid") out(`  ${pathEntry.reason}`);
		out(`  ${manualPathEntry(root, input.platform)}`);
	}
}

/**
 * Runs `gentle-shell self-uninstall` for the bundled install at `root`. Exit
 * codes as runSelfUninstall: 0 done or dry run, 1 refused, cancelled or failed,
 * 2 usage. Order: the recorded PATH entry, the prefix's own folders, then the
 * shared home when asked, and the prefix once nothing is left in it. On
 * Windows the files this process holds are removed after it exits.
 */
export async function runBundledSelfUninstall(input: BundledSelfUninstallInput): Promise<number> {
	const { out, err, platform, root } = input;
	const options = parseSelfUninstallArgs(input.args);
	if ("error" in options) {
		err(`gentle-shell self-uninstall: ${options.error}`);
		return 2;
	}
	const plan = planBundledSelfUninstall(input);
	printBundledPlan(plan, input, options);
	if (plan.refusals.length > 0) {
		for (const line of plan.refusals) err(`gentle-shell self-uninstall: ${line}`);
		err("Nothing was removed.");
		return 1;
	}
	if (options.dryRun) {
		out("Dry run: nothing was removed.");
		return 0;
	}
	const confirmation = await confirm(input, options, plan.shared.length > 0,
		"Also remove your Gentle Shell home (sign-ins, chats, settings and extensions) listed above? [y/N] ");
	if ("code" in confirmation) return confirmation.code;

	// A PATH entry the user changed since the install is kept, and said so at the end.
	let pathKept: string | undefined;
	if (input.pathEntry.status === "recorded") {
		try {
			const result = input.pathEntry.remove();
			if (result.removed === false) pathKept = result.note ?? input.pathEntry.description;
		} catch (error) {
			err(`gentle-shell self-uninstall: could not remove ${input.pathEntry.description}: ${error instanceof Error ? error.message : String(error)}`);
			err("Nothing else was removed; fix the cause and run gentle-shell self-uninstall again.");
			return 1;
		}
	}
	const held = (path: string) => plan.held.some((file) => comparable(file, platform) === comparable(path, platform));
	for (const removal of [...plan.own, ...(confirmation.includeShared ? plan.shared : [])]) {
		try {
			if (held(removal.path)) continue;
			if (plan.held.some((file) => within(removal.path, file, platform))) removeExcept(removal.path, plan.held, platform);
			else remove(removal);
		} catch (error) {
			err(`gentle-shell self-uninstall: could not remove ${removal.path}: ${error instanceof Error ? error.message : String(error)}`);
			err("Everything listed after it was kept; fix the cause and run gentle-shell self-uninstall again.");
			return 1;
		}
	}
	try {
		if (confirmation.includeShared) removeIfEmpty(plan.shellHome);
		if (plan.removeRoot && plan.held.length === 0) removeIfEmpty(root);
	} catch {
		// A leftover empty folder is harmless.
	}
	if (plan.held.length > 0) {
		try {
			if (!input.deferRemoval) throw new Error("no deferred removal on this system");
			// The marker goes last: while it stays, a failed removal can be retried with self-uninstall.
			const marker = join(root, BUNDLED_WINDOWS_MARKER.name);
			const isMarker = (file: string) => comparable(file, platform) === comparable(marker, platform);
			input.deferRemoval({ pid: input.process.pid, files: plan.held.filter((file) => !isMarker(file)), last: plan.held.find(isMarker),
				directories: heldDirectories(plan, root, platform) });
		} catch (error) {
			err(`gentle-shell self-uninstall: ${error instanceof Error ? error.message : String(error)}; once this command exits, delete ${root} yourself.`);
			return 1;
		}
		out(`Windows cannot remove the running Gentle Shell: ${plan.held.join(", ")} ${plan.held.length === 1 ? "is" : "are"} removed in the background after this command exits.`);
	}
	if (pathKept !== undefined) out(`The PATH entry was kept: ${pathKept}. Remove it yourself if nothing else uses it.`);
	out("Gentle Shell was removed.");
	return 0;
}
