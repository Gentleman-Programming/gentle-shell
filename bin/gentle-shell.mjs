#!/usr/bin/env node
// Thin process/fs/exec glue around lib/gentle-shell-launcher.ts (built to
// runtime/gentle-shell-launcher.mjs). All decision logic — argv parsing, home
// resolution, pi resolution order, the version gate, and the pi invocation —
// lives in that pure, unit-tested module; this file only wires it to the real
// process, filesystem, and child process.
import {
	accessSync,
	closeSync,
	constants as fsConstants,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	buildPiInvocation,
	checkPiVersion,
	decideTakeOver,
	describeVersion,
	discoverLooseExtensionEntries,
	findGentlePiDeclaration,
	forceJsonFieldIfAbsentInOriginal,
	helpText,
	homeSelectorFlags,
	isSetupCapablePin,
	launcherConfigPath,
	MIN_SETUP_GENTLE_AI_VERSION,
	missingPiMessage,
	needsProvisioning,
	otherPackageInjections,
	parseLauncherArgs,
	parseLauncherConfig,
	parseRawLauncherConfig,
	planSpawn,
	POST_INSTALL_REMOVAL_SOURCES,
	postInstallRemovals,
	provisionedEntry,
	recordProvisioned,
	resolveHome,
	resolvePiRuntime,
	restoreJsonField,
	shellQuote,
} from "../runtime/gentle-shell-launcher.mjs";
import { GENTLE_AI_VERSION, gentleAiBinaryPath, PackageLocalGentleAiBinaryMissingError } from "../runtime/gentle-ai-binary.mjs";
import { DEFAULT_THEME_NAME, installIsolatedTuiModeSetting } from "../scripts/install-tui-mode-setting.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message, code) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function readJsonIfExists(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

// @earendil-works/pi-coding-agent ships as an optional peer dependency: it may
// not be installed at all, so a resolution failure here is expected, not an error.
function resolveBundledCli() {
	try {
		const require = createRequire(import.meta.url);
		const pkgJsonPath = require.resolve("@earendil-works/pi-coding-agent/package.json");
		const cliPath = join(dirname(pkgJsonPath), "dist", "bundle", "cli.js");
		return existsSync(cliPath) ? cliPath : undefined;
	} catch {
		return undefined;
	}
}

function findOnPath(name) {
	const dirs = (process.env.PATH || "").split(delimiter).filter((entry) => entry.length > 0);
	const extensions = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	for (const dir of dirs) {
		for (const extension of extensions) {
			const candidate = join(dir, `${name}${extension}`);
			try {
				accessSync(candidate, fsConstants.X_OK);
				return candidate;
			} catch {
				// keep scanning
			}
		}
	}
	return undefined;
}

function signalExitCode(signal) {
	const number = osConstants.signals[signal];
	return 128 + (typeof number === "number" ? number : 0);
}

function ownPackageVersion() {
	const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	return packageJson.version;
}

function emptyArgs() {
	return {
		link: false,
		isolated: false,
		home: undefined,
		packageRoot: undefined,
		help: false,
		version: false,
		command: undefined,
		commandArgs: [],
		passthrough: [],
		piSubcommand: undefined,
		error: undefined,
	};
}

// package.json "name" reader injected into findGentlePiDeclaration: a
// missing or unreadable package.json, or a non-string "name", is never an
// error here — it just means that path package is not gentle-pi.
function readPackageName(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return typeof pkg.name === "string" ? pkg.name : undefined;
	} catch {
		return undefined;
	}
}

// Best-effort realpath: a directory that does not exist (yet, or ever)
// cannot be realpath'd, so the take-over decision falls back to comparing
// the raw path instead of failing.
function safeRealpath(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// Used to filter the loose extension dirs a take-over re-injects: a missing
// path, or one that is not a directory (for example a stray file named
// "extensions"), is silently excluded rather than passed to pi as -e.
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

// Real-fs adapter for discoverLooseExtensionEntries (lib/gentle-shell-launcher.ts):
// statSync-based isFile/isDirectory (not readdirSync's Dirent, which uses
// lstat and so would treat a symlinked file or directory as neither) so a
// symlinked loose extension resolves the same way pi's own fs.existsSync-based
// checks would.
const looseExtensionFs = {
	readdir(dir) {
		let names;
		try {
			names = readdirSync(dir);
		} catch (error) {
			// resolveLooseExtensionEntries only calls this once isDirectory(dir)
			// has already confirmed the directory exists, so a failure here (for
			// example EACCES) is a real read failure, not a missing directory.
			// Warn instead of silently dropping every loose extension it would
			// have contributed (R4-loose-extension-enumeration-fails-silently).
			process.stderr.write(`gentle-shell: could not read loose extension directory ${dir}: ${error.message} (skipping)\n`);
			return [];
		}
		return names.map((name) => {
			const entryPath = join(dir, name);
			try {
				const entryStat = statSync(entryPath);
				return { name, isFile: entryStat.isFile(), isDirectory: entryStat.isDirectory() };
			} catch {
				return { name, isFile: false, isDirectory: false };
			}
		});
	},
	exists: existsSync,
};

// A loose extensions directory that is itself a self-contained extension —
// a package.json declaring a non-empty "pi.extensions" manifest — is passed
// through as a single -e <dir> instead of being broken into per-file
// entries: pi's own module loader (jiti) resolves that case directly,
// exactly as it would for any other explicitly configured package path. A
// root-level index.ts/index.js is deliberately NOT treated as that same
// marker: pi's own discovery loads it as just another loose file, so
// collapsing the whole directory on its presence silently dropped sibling
// loose files like extra.ts (R4-loose-index-collapses-sibling-extensions).
function readPiManifestExtensions(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : undefined;
	} catch {
		return undefined;
	}
}

function looseDirHasOwnEntryPoint(dir) {
	const manifestExtensions = readPiManifestExtensions(dir);
	return manifestExtensions !== undefined && manifestExtensions.length > 0;
}

// Resolves one candidate loose-extensions directory (<agentDir>/extensions or
// <cwd>/.pi/extensions) into the -e entries a take-over must re-inject: the
// directory itself when it is a self-contained extension, otherwise every
// loose file discoverLooseExtensionEntries finds inside it. A missing or
// non-directory candidate resolves to no entries.
function resolveLooseExtensionEntries(dir) {
	if (!isDirectory(dir)) return [];
	if (looseDirHasOwnEntryPoint(dir)) return [dir];
	return discoverLooseExtensionEntries(dir, looseExtensionFs);
}

// Test/development-only override for the launcher config.json path
// (normally launcherConfigPath(homedir())). Lets a test — or the
// packed-artifact E2E script, which also needs `--link` probes against the
// real pi home and so cannot just redirect HOME wholesale — read and write
// the `home` subcommand's and the auto-provisioning marker's config file
// without ever touching the real ~/.gentle-shell/config.json. Never
// consulted outside these two call sites; see docs/readme-reference.md.
function resolveConfigPath() {
	const override = process.env.GENTLE_SHELL_CONFIG;
	return override !== undefined && override.length > 0 ? override : launcherConfigPath(homedir());
}

// Raw config.json as a plain object (see RawLauncherConfig in
// lib/gentle-shell-launcher.ts): unlike parseLauncherConfig, this preserves
// every key, so a write (home persistence, or the provisioning marker below)
// never drops a key it does not itself understand.
function readRawConfig(configPath) {
	return parseRawLauncherConfig(readJsonIfExists(configPath));
}

// Atomic (temp file in the same directory, then rename): a crash or kill
// mid-write must never leave config.json truncated or partially written,
// since it also carries the S7 provisioning marker every plain launch reads.
function writeRawConfig(configPath, config) {
	const configDir = dirname(configPath);
	if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const tempPath = join(configDir, `.${basenameOf(configPath)}.gentle-shell-${process.pid}.tmp`);
	writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tempPath, configPath);
}

function loadConfig() {
	const text = readJsonIfExists(resolveConfigPath());
	return text === undefined ? undefined : parseLauncherConfig(text);
}

function handleHomeCommand(commandArgs) {
	if (commandArgs.length === 0) {
		const resolved = resolveHome({ args: emptyArgs(), env: process.env, homedir: homedir(), config: loadConfig() });
		process.stdout.write(`${resolved.mode} ${resolved.dir}\n`);
		process.exit(0);
	}
	if (commandArgs.length > 1) fail("gentle-shell home accepts at most one argument. Run 'gentle-shell --help'.", 2);
	const [value] = commandArgs;
	if (value.length === 0) fail("gentle-shell home requires a non-empty argument. Run 'gentle-shell --help'.", 2);

	const configPath = resolveConfigPath();
	const existing = readRawConfig(configPath);

	if (value === "link" || value === "isolated") {
		writeRawConfig(configPath, { ...existing, home: value });
		process.stdout.write(`Saved home: ${value}\n`);
		process.exit(0);
	}
	const dir = resolvePath(value);
	writeRawConfig(configPath, { ...existing, home: dir });
	process.stdout.write(`Saved home: path ${dir}\n`);
	process.exit(0);
}

// Test/development-only override for the setup subcommand's gentle-ai
// executable path. Lets a test point at a stub script (or a deliberately
// missing path) without touching the real pinned .gentle-ai/v<version>/gentle-ai
// install this package ships, and without needing to fake its release-asset
// integrity manifest. Never consulted outside `setup`; see docs/readme-reference.md.
function resolveSetupGentleAiBinary() {
	const override = process.env.GENTLE_SHELL_GENTLE_AI_BIN;
	return override !== undefined && override.length > 0 ? override : gentleAiBinaryPath();
}

// Test/development-only override for the setup subcommand's reported
// package-local gentle-ai pin. Lets a test simulate an older or newer pin
// without changing the real installed .gentle-ai/v<version> bundle. Never
// consulted outside `setup`; see docs/readme-reference.md.
function resolveSetupGentleAiPin() {
	const override = process.env.GENTLE_SHELL_GENTLE_AI_PIN;
	return override !== undefined && override.length > 0 ? override : GENTLE_AI_VERSION;
}

const SKIP_GENTLE_AI_INSTALL_ENV = "GENTLE_PI_SKIP_GENTLE_AI_INSTALL";

// Test/development-only override for the setup subcommand's self-heal
// installer script path. Lets a test point at a stub installer (one that
// creates the stub binary, or deliberately doesn't) instead of running the
// real node scripts/install-gentle-ai.mjs, whose supply-chain integrity
// checks (and real network download) a test cannot cheaply satisfy. Never
// consulted outside `setup`; see docs/readme-reference.md.
function resolveSetupGentleAiInstaller() {
	const override = process.env.GENTLE_SHELL_GENTLE_AI_INSTALLER;
	return override !== undefined && override.length > 0 ? override : join(packageRoot, "scripts", "install-gentle-ai.mjs");
}

// Spawns `command` and resolves once it exits, instead of exiting the
// process directly: the shared core the manual `setup` subcommand and the
// automatic first-run provisioning flow (S7) both drive, deciding for
// themselves whether to `process.exit` (setup) or warn and continue (auto
// mode). `stdio` lets a silent caller route the child's stdout/stderr to the
// launcher's own stderr (see runSetupFlow) while a manual `setup` keeps the
// child's stdio inherited. A `signal` on the result records that the child
// exited via signal for any reason; `interrupted: true` additionally marks
// that it happened because *this launcher itself* received
// SIGINT/SIGTERM/SIGHUP and forwarded it — as opposed to the child dying by a
// signal entirely on its own (a crash, an OOM kill, an external `kill`),
// which is an ordinary failure, not a request to stop (R3-002). Only
// `interrupted` lets a caller skip printing remediation advice and abort the
// whole launch; a plain `signal` with no `interrupted` is treated like any
// other failure. `timeoutMs`, when given, kills the child and resolves with
// `timedOut: true` instead of waiting forever on a hung gentle-ai/pi
// invocation; only the automatic first-run flow passes it (see
// AUTO_SETUP_CHILD_TIMEOUT_MS below) — manual `setup` never times out.
function spawnAndWait(command, args, env, stdio, timeoutMs) {
	return new Promise((resolve) => {
		const launchPlan = planSpawn({ command, args, platform: process.platform });
		const child = spawn(launchPlan.command, launchPlan.args, { stdio, env, shell: launchPlan.shell });
		let timedOut = false;
		let interrupted = false;
		const timer = timeoutMs !== undefined ? setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs) : undefined;
		const signalHandlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
			const handler = () => {
				interrupted = true;
				child.kill(signal);
			};
			process.on(signal, handler);
			return [signal, handler];
		});
		const cleanup = () => {
			for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
			if (timer !== undefined) clearTimeout(timer);
		};
		child.on("error", (error) => {
			cleanup();
			resolve({ ok: false, exitCode: 1, error });
		});
		child.on("exit", (code, signal) => {
			cleanup();
			if (timedOut) {
				resolve({ ok: false, exitCode: 1, timedOut: true });
				return;
			}
			if (signal) {
				resolve(
					interrupted
						? { ok: false, exitCode: signalExitCode(signal), signal, interrupted: true }
						: { ok: false, exitCode: signalExitCode(signal), signal },
				);
				return;
			}
			const exitCode = code ?? 1;
			resolve({ ok: exitCode === 0, exitCode });
		});
	});
}

// Renders `ms` as a human ceiling for a "timed out after ..." message: whole
// minutes when `ms` is an exact multiple of 60000 (matching the production
// 15-minute default and any operator-chosen whole-minute override), seconds
// otherwise — including the sub-second overrides
// GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS sets in tests. Used at every "timed out
// after ..." call site instead of a hardcoded "15 minutes"
// (R2-timeout-message-hardcoded), so the message always reflects the ceiling
// that actually fired.
function formatTimeoutCeiling(ms) {
	if (ms % 60000 === 0) {
		const minutes = ms / 60000;
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	const seconds = ms / 1000;
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// Self-heals a missing package-local gentle-ai binary before the setup flow
// gives up on it. `npm install -g <tarball>` on a machine whose npm config
// disables lifecycle scripts (`ignore-scripts=true`, this maintainer's own
// machine included) never runs the package's own postinstall
// (scripts/install-gentle-ai.mjs), so .gentle-ai/v<pin>/gentle-ai is missing
// even though the package itself installed fine. Running that same
// installer here recovers it: it downloads the pinned, sha256-verified
// release asset, exactly as postinstall would have. Skipped when
// GENTLE_PI_SKIP_GENTLE_AI_INSTALL is "1" — the same variable that already
// controls whether real postinstall provisioning runs (see
// docs/readme-reference.md) — in which case today's plain missing-binary
// failure is kept, with the variable named in the message. Returns
// {ok, exitCode, message} instead of exiting the process, so the caller
// decides whether to exit (manual setup) or warn and continue (auto mode).
//
// Signal-contract note (R2-signal-contract-cleanup-gap): unlike the two
// children spawnAndWait drives during this flow (the package-local gentle-ai
// binary in runSetupFlow, and each `pi remove` in removePostInstallSources),
// this installer runs via a *synchronous* spawnSync with no timeout and no
// launcher-interrupt tracking. A SIGINT/SIGTERM/SIGHUP reaching the launcher
// while this specific call is blocking falls back to Node's default signal
// disposition (the launcher exits immediately) instead of the
// interrupted-vs-ordinary-failure distinction spawnAndWait's callers get. The
// installer script itself is small, fast, and non-interactive in practice, so
// this gap is accepted rather than converting it to the async, timeout-bound
// spawnAndWait path.
function ensurePackageLocalGentleAi(binaryPath, pinnedVersion, stdio) {
	if (existsSync(binaryPath)) return { ok: true };
	if (process.env[SKIP_GENTLE_AI_INSTALL_ENV] === "1") {
		return {
			ok: false,
			exitCode: 1,
			message: `${new PackageLocalGentleAiBinaryMissingError(binaryPath).message} (${SKIP_GENTLE_AI_INSTALL_ENV} is set; not installing it automatically)`,
		};
	}
	process.stderr.write(
		`gentle-shell: the package-local gentle-ai v${pinnedVersion} is missing (npm lifecycle scripts may be disabled); installing it now\n`,
	);
	const installerPath = resolveSetupGentleAiInstaller();
	const result = spawnSync(process.execPath, [installerPath], { stdio });
	if (result.error) {
		return { ok: false, exitCode: 1, message: `Could not run the gentle-ai installer at ${installerPath}: ${result.error.message}` };
	}
	if (!existsSync(binaryPath)) return { ok: false, exitCode: 1, message: new PackageLocalGentleAiBinaryMissingError(binaryPath).message };
	return { ok: true };
}

// Shared env for the gentle-ai install spawn and the pi remove cleanup spawn
// below: PI_CODING_AGENT_DIR/GENTLE_PI_AGENT_HOME point both at the resolved
// home, and the resolved pi runtime's directory is prepended to PATH so
// gentle-ai's (or pi's own) preflight finds `pi` even when it is bundled or
// given through GENTLE_SHELL_PI.
function buildSetupEnv(home, runtime) {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: home.dir,
		GENTLE_PI_AGENT_HOME: home.dir,
		PATH: `${dirname(runtime.command)}${delimiter}${process.env.PATH ?? ""}`,
	};
}

// The shared Pi persona file gentle-ai writes on every install, regardless
// of the target home: its own PiPersonaConfigPath always resolves against
// the OS home, never PI_CODING_AGENT_DIR (gentle-ai internal/components/persona/inject.go),
// so a `setup` run for any home silently resets whatever persona mode the
// user already chose back to gentle-ai's default preset unless something
// snapshots and restores it. See snapshotFile/restoreFile below and
// docs/readme-reference.md's setup "Known limitation".
function sharedPersonaPath() {
	return join(homedir(), ".pi", "gentle-ai", "persona.json");
}

// Records `path`'s current state before a child process that might rewrite
// it runs: whether it exists, and if so its exact bytes and mode. Returns
// `{ path, existed: false }` for a missing file so restoreFile below knows
// to delete rather than rewrite it. Any error other than "does not exist"
// propagates — a snapshot that silently treats a permissions error as
// "missing" would then delete a file it never actually read.
function snapshotFile(path) {
	try {
		const bytes = readFileSync(path);
		const mode = statSync(path).mode & 0o777;
		return { path, existed: true, bytes, mode };
	} catch (error) {
		if (error.code === "ENOENT") return { path, existed: false };
		throw error;
	}
}

// Restores `snapshot` after the child that might have rewritten it exits,
// but only when its current state actually differs from what was recorded:
// a changed existing file is rewritten atomically (temp file in the same
// directory, then renamed, so a crash mid-restore never leaves a partial
// file) preserving the original mode; a file that did not exist before is
// removed if the child created one. Returns true when a restore/removal
// actually happened, so the caller prints exactly one notice.
function restoreFile(snapshot) {
	const { path, existed } = snapshot;
	if (!existed) {
		if (!existsSync(path)) return false;
		rmSync(path, { force: true });
		return true;
	}
	let currentBytes;
	try {
		currentBytes = readFileSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (currentBytes !== undefined && currentBytes.equals(snapshot.bytes)) return false;
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = join(dirname(path), `.${basenameOf(path)}.gentle-shell-restore-${process.pid}.tmp`);
	writeFileSync(tempPath, snapshot.bytes, { mode: snapshot.mode });
	renameSync(tempPath, path);
	return true;
}

function basenameOf(path) {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1];
}

// gentle-ai records the running binary's managed-asset bundle digest in the
// shared `~/.gentle-ai/state.json`, field managed_asset_digest (gentle-ai
// internal/cli/run.go, internal/state/state.go), regardless of which home it
// was installing into — same shared-file-outside-PI_CODING_AGENT_DIR problem
// as sharedPersonaPath above. The pinned package-local gentle-ai this setup
// flow spawns writes its own digest there, so afterward the user's own
// (unrelated, on-PATH) gentle-ai reports its managed assets as outdated and
// demands `gentle-ai sync`, even though nothing about the user's install
// changed. Unlike persona.json, state.json also carries fields the pinned
// gentle-ai is supposed to update (for example installed_agents), so this
// restores only the managed_asset_digest field via restoreJsonField
// (lib/gentle-shell-launcher.ts) instead of snapshotting the whole file. See
// docs/readme-reference.md's setup "Known limitation".
function sharedGentleAiStatePath() {
	return join(homedir(), ".gentle-ai", "state.json");
}

const MANAGED_ASSET_DIGEST_FIELD = "managed_asset_digest";

// Reads state.json's raw text before the gentle-ai spawn that might rewrite
// it, tolerating a missing or unparsable file by returning undefined: unlike
// snapshotFile (persona.json above), there is nothing worth restoring later
// in that case, so the caller skips the restore step entirely rather than
// treating "missing" as its own snapshot state.
function readParsableJsonText(path) {
	const text = readJsonIfExists(path);
	if (text === undefined) return undefined;
	try {
		JSON.parse(text);
	} catch {
		return undefined;
	}
	return text;
}

// Restores managed_asset_digest in state.json after the gentle-ai spawn.
// Deliberately does NOT delete or otherwise touch a state.json the child
// created where none existed before (unlike restoreFile's whole-file
// persona.json handling): state.json is the user's own gentle-ai global
// state file, not something gentle-shell owns end-to-end, so removing one
// the tool just created would destroy state fields unrelated to this fix —
// `originalText` is undefined for that case (see readParsableJsonText
// above), and this returns early without reading or writing anything.
// Returns true when it actually wrote a restored file, so the caller prints
// exactly one notice.
function restoreManagedAssetDigestField(path, originalText) {
	if (originalText === undefined) return false;
	const currentText = readJsonIfExists(path);
	if (currentText === undefined) return false;
	const restoredText = restoreJsonField(originalText, currentText, MANAGED_ASSET_DIGEST_FIELD);
	if (restoredText === undefined) return false;
	const mode = statSync(path).mode & 0o777;
	const tempPath = join(dirname(path), `.${basenameOf(path)}.gentle-shell-restore-${process.pid}.tmp`);
	writeFileSync(tempPath, restoredText, { mode });
	renameSync(tempPath, path);
	return true;
}

// Restores the home's own settings.json "theme" field to whatever it was
// right before the gentle-ai spawn (`originalSettingsText`) — gentle-ai's
// managed install may write its own theme into settings.json, which would
// otherwise silently replace the theme Gentle Shell had going in. This is a
// field-level snapshot/restore around the spawn, not a "only act if there
// was no theme before" check: on a brand-new home, the isolated-home
// bootstrap (installIsolatedTuiModeSetting, withIsolatedHomeDefaults in
// scripts/install-tui-mode-setting.mjs) already wrote DEFAULT_THEME_NAME
// into settings.json before this snapshot is taken, so `originalSettingsText`
// already declares a theme there too — a check that skipped restoring
// whenever the original had a theme would never fire on a fresh home and let
// gentle-ai's own theme win. When the original truly declared a theme
// (either that bootstrap default, or the user's own earlier choice),
// whatever gentle-ai changed it to afterward is restored via the pure
// restoreJsonField (lib/gentle-shell-launcher.ts). When the original had no
// theme at all, there is nothing to restore, so DEFAULT_THEME_NAME is forced
// instead via forceJsonFieldIfAbsentInOriginal, so a home still ends up
// themed. Unlike the persona/state restores above, this is not a shared file
// outside the home — it is the home's own settings.json, so no whole-file
// snapshot/restore pairing is needed, only a before/after comparison.
// Returns "restored" or "forced" when it actually wrote the file (so the
// caller can print the matching notice), or false when nothing changed.
function enforceDefaultThemeField(settingsPath, originalSettingsText) {
	if (originalSettingsText === undefined) return false;
	const currentText = readJsonIfExists(settingsPath);
	if (currentText === undefined) return false;
	let originalHadTheme;
	try {
		const originalValue = JSON.parse(originalSettingsText);
		originalHadTheme = typeof originalValue === "object" && originalValue !== null && !Array.isArray(originalValue) && Object.prototype.hasOwnProperty.call(originalValue, "theme");
	} catch {
		return false;
	}
	const newText = originalHadTheme
		? restoreJsonField(originalSettingsText, currentText, "theme")
		: forceJsonFieldIfAbsentInOriginal(originalSettingsText, currentText, "theme", DEFAULT_THEME_NAME);
	if (newText === undefined) return false;
	const mode = statSync(settingsPath).mode & 0o777;
	const tempPath = join(dirname(settingsPath), `.${basenameOf(settingsPath)}.gentle-shell-restore-${process.pid}.tmp`);
	writeFileSync(tempPath, newText, { mode });
	renameSync(tempPath, settingsPath);
	return originalHadTheme ? "restored" : "forced";
}

// Never let a snapshot/restore step itself abort setup: a persona.json or
// state.json this launcher cannot read or write for an unexpected reason
// (EACCES, ENOSPC, a path that turned into a directory, ...) must not crash
// `gentle-shell setup` or block the automatic first-run flow from still
// launching pi — it only means that one file's shared-state protection did
// not apply this run. `label` and `path` identify what failed to the user;
// the caller decides what "safe" default to fall back to.
function safely(label, path, fallback, fn) {
	try {
		return fn();
	} catch (error) {
		process.stderr.write(`gentle-shell: could not ${label} at ${path} (${error.message}); continuing\n`);
		return fallback;
	}
}

// Provisions `home` with everything `gentle-ai install --agent pi` installs
// into a regular Pi, by spawning the package-local pinned gentle-ai binary
// (never a PATH `gentle-ai`) with PI_CODING_AGENT_DIR/GENTLE_PI_AGENT_HOME set
// to `home.dir` and the resolved pi runtime's directory prepended to PATH, so
// gentle-ai's own preflight finds `pi` even when it is bundled or given
// through GENTLE_SHELL_PI, then removes any conflicting package it declared
// (see runPostInstallCleanup below). `home` and `runtime` are resolved by
// the caller exactly as a normal run resolves them (including the
// isolated/--home bootstrap and the pi version gate). Precondition: the
// package-local gentle-ai pin must be at least MIN_SETUP_GENTLE_AI_VERSION —
// the first release that honors PI_CODING_AGENT_DIR here — or this refuses
// to spawn it, since an older pin would silently provision the caller's real
// ~/.pi/agent.
//
// Returns {ok, exitCode, message?} instead of exiting the process: the
// manual `setup` subcommand (handleSetupCommand) exits on the result, and
// the automatic first-run flow (maybeAutoProvisionHome, S7) warns and
// continues the launch on failure instead. `stdio` is threaded through to
// both child spawns unchanged (see spawnAndWait and
// ensurePackageLocalGentleAi above) — "inherit" for a manual `setup`, or
// `["ignore", 2, 2]` in auto mode so every child's stdout/stderr lands on
// this launcher's own stderr and its real stdout stays clean for `--mode
// rpc`/`-p` consumers. `timeoutMs` is threaded into every child this flow
// spawns (see spawnAndWait's own doc comment) — manual `setup` never passes
// it, so it never times out; the automatic flow does (S9).
async function runSetupFlow(home, runtime, { dryRun, stdio, timeoutMs }) {
	const pinnedVersion = resolveSetupGentleAiPin();
	if (!isSetupCapablePin(pinnedVersion)) {
		return {
			ok: false,
			exitCode: 1,
			message: `gentle-shell: setup needs the package-local gentle-ai v${MIN_SETUP_GENTLE_AI_VERSION} or newer (pinned: ${pinnedVersion}); this build cannot provision a home without touching ~/.pi/agent`,
		};
	}

	const binaryPath = resolveSetupGentleAiBinary();
	const ensured = ensurePackageLocalGentleAi(binaryPath, pinnedVersion, stdio);
	if (!ensured.ok) return ensured;

	process.stderr.write(`gentle-shell: provisioning ${home.dir} with the gentle-ai companion packages\n`);

	const setupArgs = ["install", "--agent", "pi", "--scope", "global", ...(dryRun ? ["--dry-run"] : [])];
	const env = buildSetupEnv(home, runtime);
	const personaPath = sharedPersonaPath();
	const personaSnapshot = safely("snapshot your Pi persona file", personaPath, undefined, () => snapshotFile(personaPath));
	const statePath = sharedGentleAiStatePath();
	const originalStateText = safely("read your Gentle AI state file", statePath, undefined, () => readParsableJsonText(statePath));
	// Theme restore (never for --link — that home is the user's own
	// pre-existing pi agent home — and never for a --dry-run, which must
	// write nothing): snapshot the home's own settings.json theme right
	// before the spawn, so enforceDefaultThemeField can restore it
	// afterward if gentle-ai's managed install changed it — whether that
	// theme was the isolated-home bootstrap's own default or the user's own
	// earlier choice.
	const trackTheme = !dryRun && home.mode !== "link";
	const settingsPath = join(home.dir, "settings.json");
	const originalSettingsText = trackTheme ? safely("read your Pi settings file", settingsPath, undefined, () => readParsableJsonText(settingsPath)) : undefined;
	let installResult;
	try {
		installResult = await spawnAndWait(binaryPath, setupArgs, env, stdio, timeoutMs);
	} finally {
		if (personaSnapshot !== undefined && safely("restore your Pi persona file", personaPath, false, () => restoreFile(personaSnapshot))) {
			process.stderr.write(`gentle-shell: kept your Pi persona unchanged (gentle-ai rewrote ${personaPath}; tracked upstream)\n`);
		}
		if (safely("restore your Gentle AI managed-asset record", statePath, false, () => restoreManagedAssetDigestField(statePath, originalStateText))) {
			process.stderr.write(
				`gentle-shell: kept your Gentle AI managed-asset record unchanged (the pinned gentle-ai rewrote ${statePath}; tracked upstream)\n`,
			);
		}
		const themeOutcome = trackTheme ? safely("apply the default Gentle Shell theme", settingsPath, false, () => enforceDefaultThemeField(settingsPath, originalSettingsText)) : false;
		if (themeOutcome === "forced") {
			process.stderr.write(`gentle-shell: set the default ${DEFAULT_THEME_NAME} theme for ${home.dir} (no theme was set before this run)\n`);
		} else if (themeOutcome === "restored") {
			process.stderr.write(`gentle-shell: kept your Pi theme unchanged (gentle-ai rewrote ${settingsPath}; tracked upstream)\n`);
		}
	}
	if (installResult.timedOut) {
		return { ok: false, exitCode: 1, message: `gentle-shell: gentle-ai install timed out after ${formatTimeoutCeiling(timeoutMs)}` };
	}
	if (installResult.error) {
		return { ok: false, exitCode: 1, message: `Could not start the gentle-ai binary: ${installResult.error.message}` };
	}
	if (!installResult.ok) return installResult;

	return runPostInstallCleanup(home, runtime, dryRun, stdio, timeoutMs);
}

// The stderr line printed once `source` is actually removed from `home`.
// npm:gentle-pi names the running launcher's own version, so it is
// self-evident which copy stays authoritative; every other source keeps its
// original gentle-ai #4820 wording unchanged.
function postInstallRemovingMessage(source, home) {
	if (source === "npm:gentle-pi") {
		return `gentle-shell: removing ${source} from ${home.dir}: this launcher loads its own gentle-pi ${ownPackageVersion()}, so the home always matches it`;
	}
	return `gentle-shell: removing ${source} from ${home.dir}: gentle-pi ships ask_user_question and Pi refuses two providers (gentle-ai #4820)`;
}

// The --dry-run stderr line for `source`, printed unconditionally (see
// runPostInstallCleanup below). Kept byte-identical to the pre-existing
// rpiv wording; npm:gentle-pi gets its own analogous "would remove" line.
function postInstallWouldRemoveMessage(source) {
	if (source === "npm:gentle-pi") {
		return `gentle-shell: setup would then remove ${source} if the install declares it: this launcher loads its own gentle-pi ${ownPackageVersion()}, so the home always matches it`;
	}
	return `gentle-shell: setup would then remove ${source} if the install declares it (gentle-ai #4820)`;
}

// Runs once the gentle-ai install spawned by runSetupFlow above has exited
// 0. gentle-ai's managed Pi stack always declares two packages this launcher
// must remove from the just-provisioned home itself, unless this is a
// --dry-run: npm:@juicesharp/rpiv-ask-user-question, which conflicts with
// gentle-pi's own first-party ask_user_question tool (Pi refuses two
// providers for the same tool name; gentle-ai #4820, gentle-shell #1277,
// fix pending upstream), and npm:gentle-pi itself, which must never survive
// setup — this launcher always loads its own gentle-pi, never the one
// gentle-ai's stack installs. A --dry-run gentle-ai install writes nothing,
// so settings.json read afterwards would only report whatever pre-existed
// the run (e.g. the isolated-home bootstrap), never what the skipped
// install would have declared; report every known removal source
// unconditionally instead of reading settings.json at all.
async function runPostInstallCleanup(home, runtime, dryRun, stdio, timeoutMs) {
	if (dryRun) {
		for (const source of POST_INSTALL_REMOVAL_SOURCES) {
			process.stderr.write(`${postInstallWouldRemoveMessage(source)}\n`);
		}
		return { ok: true, exitCode: 0 };
	}
	const settingsText = readJsonIfExists(join(home.dir, "settings.json"));
	const removals = postInstallRemovals(settingsText);
	if (removals.length === 0) return { ok: true, exitCode: 0 };
	return removePostInstallSources(removals, 0, home, runtime, stdio, timeoutMs);
}

// Removes each declared post-install source in turn via the resolved pi
// runtime itself (never gentle-ai), stopping at the first failure so its
// exit code and actionable message are not masked by a later removal.
async function removePostInstallSources(sources, index, home, runtime, stdio, timeoutMs) {
	if (index >= sources.length) return { ok: true, exitCode: 0 };
	const source = sources[index];
	process.stderr.write(`${postInstallRemovingMessage(source, home)}\n`);
	const env = buildSetupEnv(home, runtime);
	const result = await spawnAndWait(runtime.command, [...runtime.args, "remove", source], env, stdio, timeoutMs);
	if (result.timedOut) {
		return { ok: false, exitCode: 1, message: `gentle-shell: pi remove ${source} timed out after ${formatTimeoutCeiling(timeoutMs)}` };
	}
	if (result.error) {
		return { ok: false, exitCode: 1, message: `Could not run the pi runtime to remove ${source}: ${result.error.message}` };
	}
	if (!result.ok) {
		// Only a launcher-forwarded interrupt (R3-002) skips remediation and
		// bubbles straight up; a signal death the child caused on its own is an
		// ordinary failure and gets the same remediation message as any other.
		if (result.interrupted) return result;
		const remediation = [...homeSelectorFlags(home).map(shellQuote), "remove", source].join(" ");
		return { ok: false, exitCode: result.exitCode, message: `gentle-shell: could not remove ${source}; run \`gentle-shell ${remediation}\` before starting` };
	}
	return removePostInstallSources(sources, index + 1, home, runtime, stdio, timeoutMs);
}

// CLI entry for `gentle-shell [home selectors] setup [--dry-run]`: parses
// --dry-run, runs the shared flow with the child's stdio inherited (today's
// behavior, unchanged), then exits with its result — this is the one place
// that keeps the pre-S7 exit semantics `handleSetupCommand` always had.
async function handleSetupCommand(commandArgs, home, runtime) {
	let dryRun = false;
	for (const arg of commandArgs) {
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		fail(`Unrecognized argument for 'gentle-shell setup': ${arg}\nRun 'gentle-shell --help' for usage.`, 2);
	}

	const result = await runSetupFlow(home, runtime, { dryRun, stdio: "inherit" });
	if (!result.ok && result.message !== undefined) process.stderr.write(`${result.message}\n`);
	process.exit(result.exitCode);
}

const AUTO_SETUP_OPT_OUT_ENV = "GENTLE_SHELL_NO_AUTO_SETUP";
const SETUP_LOCK_STALE_MS = 15 * 60 * 1000;

// gentle-shell never auto-provisions a home it does not itself own: the
// dedicated isolated home is always owned outright, but a `--home <path>` (or
// a persisted `home <path>` config) can just as easily name the user's real
// pi agent directory, or any other pre-existing, unrelated directory. Only a
// path home that is new (does not exist yet) or empty — or one this launcher
// has already provisioned before, per the config marker — is fair game;
// everything else (R1-001) is left alone with a one-time hint instead.
function defaultPiAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function printForeignHomeHint(home, reason) {
	const remediation = [...homeSelectorFlags(home).map(shellQuote), "setup"].join(" ");
	process.stderr.write(`gentle-shell: ${home.dir} ${reason}; run \`gentle-shell ${remediation}\` to provision it\n`);
}

// Ownership marker (R3-001): written into a home's own directory by the
// isolated/--home bootstrap (main, below) the moment gentle-shell creates
// that home — the same place it seeds settings.json with tuiMode. Lets
// homeIsForeign recognize a home gentle-shell itself created even when the
// config.json provisioning marker was never written because the *first*
// auto-provision attempt against it failed (a --home directory whose
// bootstrap already seeded settings.json otherwise looks identical to an
// unrelated non-empty directory on the next launch, and would be treated as
// foreign and never retried). Content is a one-line JSON object naming the
// launcher version that created it, purely informational — homeIsForeign
// only checks the file's existence.
const HOME_OWNERSHIP_MARKER_FILENAME = ".gentle-shell-home";

function homeOwnershipMarkerPath(home) {
	return join(home.dir, HOME_OWNERSHIP_MARKER_FILENAME);
}

function writeHomeOwnershipMarker(home) {
	const content = JSON.stringify({ createdBy: "gentle-shell", version: ownPackageVersion() });
	writeFileSync(homeOwnershipMarkerPath(home), `${content}\n`, "utf8");
}

// `homeHadContentBeforeBootstrap` must be read by the caller (main, below)
// before the isolated/--home bootstrap runs: that bootstrap itself creates
// and seeds a brand-new directory (settings.json with tuiMode, and now the
// ownership marker above), so checking directory contents from inside this
// function would always see that seeded content and wrongly call a genuinely
// fresh home "foreign".
function homeIsForeign(home, previousEntry, homeHadContentBeforeBootstrap) {
	if (home.mode !== "path") return false; // the isolated home is always owned
	if (previousEntry !== undefined) return false; // already provisioned by gentle-shell before; trust the marker
	if (safeRealpath(home.dir) === safeRealpath(defaultPiAgentDir())) return true; // never touch pi's own default home, even if empty
	if (existsSync(homeOwnershipMarkerPath(home))) return false; // gentle-shell's own bootstrap created this home (R3-001); retry it even after a failed first attempt
	return homeHadContentBeforeBootstrap;
}

// Guards concurrent first-run auto-provisioning of the same home: an
// exclusive create (`wx`) fails when the lock already exists. A lock file
// younger than SETUP_LOCK_STALE_MS means another gentle-shell process is (or
// very recently was) provisioning this home, so this run skips
// auto-provisioning entirely rather than racing gentle-ai's own installer;
// the existing lock is left untouched since this run never owned it. An
// older lock is stale — a previous run crashed or was killed before its
// `finally` released it — so it is removed here, but only after re-stating
// it immediately before the removal to confirm it is *still* stale at that
// exact moment: a concurrent process may have refreshed it (or removed and
// recreated it) between the first check and now, and a lock a racing process
// just legitimately acquired must never be deleted out from under it. If the
// post-removal retry `wx` create itself then fails (another process won the
// race to recreate it first), this run simply skips provisioning rather than
// looping. Any unexpected fs error (permissions, a vanished lock between the
// EEXIST and a stat, …) must never block the launch, so it resolves to
// "proceed" rather than failing closed.
function lockAgeMs(lockPath) {
	return Date.now() - statSync(lockPath).mtimeMs;
}

function acquireSetupLock(lockPath) {
	try {
		closeSync(openSync(lockPath, "wx"));
		return true;
	} catch (error) {
		if (error.code !== "EEXIST") return true;
		let age;
		try {
			age = lockAgeMs(lockPath);
		} catch {
			return true;
		}
		if (age < SETUP_LOCK_STALE_MS) {
			process.stderr.write(
				`gentle-shell: another gentle-shell process is already provisioning ${dirname(lockPath)}; skipping automatic setup for this run\n`,
			);
			return false;
		}
		let ageNow;
		try {
			ageNow = lockAgeMs(lockPath);
		} catch {
			return false;
		}
		if (ageNow < SETUP_LOCK_STALE_MS) return false;
		try {
			rmSync(lockPath, { force: true });
		} catch {
			return false;
		}
		try {
			closeSync(openSync(lockPath, "wx"));
			return true;
		} catch {
			return false;
		}
	}
}

function releaseSetupLock(lockPath) {
	try {
		rmSync(lockPath, { force: true });
	} catch {
		// Best-effort cleanup only: a missing or unremovable lock file must
		// never fail an otherwise-successful (or already-failed) run.
	}
}

// Ceiling for every child this flow spawns (S9): a hung pinned gentle-ai or
// pi invocation must never hang a plain `gentle-shell` launch forever.
// Test/development only: GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS overrides the
// 15-minute ceiling so a test can exercise it without actually waiting;
// documented as test/development-only in docs/readme-reference.md. Manual
// `setup` never passes a timeout at all (see handleSetupCommand).
const AUTO_SETUP_CHILD_TIMEOUT_MS = 15 * 60 * 1000;

function resolveAutoSetupTimeoutMs() {
	const override = process.env.GENTLE_SHELL_AUTO_SETUP_TIMEOUT_MS;
	const parsed = override !== undefined && override.length > 0 ? Number(override) : undefined;
	return parsed !== undefined && Number.isFinite(parsed) ? parsed : AUTO_SETUP_CHILD_TIMEOUT_MS;
}

// Runs the same flow as `gentle-shell setup` automatically before a plain
// launch, for an isolated or `--home <path>` home that was never provisioned
// or was provisioned with a different gentle-ai pin (S7). Never runs for
// `--link` (the caller only calls this for home.mode "isolated"/"path") or a
// pi subcommand (the caller only calls this when args.piSubcommand is
// undefined) — see main() below. Never blocks the launch: a failure (an
// older pin, a missing binary the self-heal could not recover, a non-zero
// gentle-ai or pi exit, a timeout, or a spawned child dying by a signal on
// its own — a crash, an OOM kill, an external `kill`, never something this
// launcher asked for) only warns and lets the plain launch continue with
// today's injection behavior, to retry automatically on a later run —
// except an interrupt (SIGINT/SIGTERM/SIGHUP) actually reaching *this
// launcher*, which forwards it to the spawned child and returns
// `{ exitCode }` instead (R3-002) so the caller (main, below) exits the
// whole launcher immediately without starting pi (S9): the user asked this
// process to stop, not to fall back to a plain launch. Returns undefined to
// mean "continue the launch normally".
async function maybeAutoProvisionHome(home, runtime, { homeHadContentBeforeBootstrap }) {
	if (process.env[AUTO_SETUP_OPT_OUT_ENV] === "1") return undefined;

	const configPath = resolveConfigPath();
	const homeKey = safeRealpath(home.dir);
	const pin = resolveSetupGentleAiPin();
	const gentlePiVersion = ownPackageVersion();
	const beforeConfig = readRawConfig(configPath);
	if (!needsProvisioning(beforeConfig, homeKey, pin, gentlePiVersion)) return undefined;

	const previous = provisionedEntry(beforeConfig, homeKey);
	if (homeIsForeign(home, previous, homeHadContentBeforeBootstrap)) {
		const reason =
			safeRealpath(home.dir) === safeRealpath(defaultPiAgentDir())
				? "is pi's own default agent home; gentle-shell never auto-provisions it"
				: "already has content and was not set up by gentle-shell";
		printForeignHomeHint(home, reason);
		return undefined;
	}

	const lockPath = join(home.dir, ".gentle-shell-setup.lock");
	if (!acquireSetupLock(lockPath)) return undefined;

	try {
		if (previous === undefined) {
			process.stderr.write(
				`gentle-shell: first run in ${home.dir}: installing the Gentle AI companion packages (one time; set ${AUTO_SETUP_OPT_OUT_ENV}=1 to skip)\n`,
			);
		} else {
			// A marker written before gentle-pi version tracking existed (S8)
			// has no `gentlePi` field: needsProvisioning above already treats
			// that as changed, so this reports "unknown" as its prior value
			// instead of "undefined".
			const gentleAiChanged = previous.gentleAi !== pin;
			const gentlePiChanged = previous.gentlePi !== gentlePiVersion;
			if (gentleAiChanged && gentlePiChanged) {
				process.stderr.write(
					`gentle-shell: gentle-ai pin changed (${previous.gentleAi} -> ${pin}) and gentle-pi changed (${previous.gentlePi ?? "unknown"} -> ${gentlePiVersion}): updating ${home.dir}\n`,
				);
			} else if (gentlePiChanged) {
				process.stderr.write(`gentle-shell: gentle-pi changed (${previous.gentlePi ?? "unknown"} -> ${gentlePiVersion}): updating ${home.dir}\n`);
			} else {
				process.stderr.write(`gentle-shell: gentle-ai pin changed (${previous.gentleAi} -> ${pin}): updating ${home.dir}\n`);
			}
		}

		const result = await runSetupFlow(home, runtime, { dryRun: false, stdio: ["ignore", 2, 2], timeoutMs: resolveAutoSetupTimeoutMs() });
		// Abort the whole launch only for a launcher-forwarded interrupt
		// (R3-002); a child that exited via signal on its own (crash, OOM kill,
		// external kill) falls through to the ordinary-failure branch below,
		// which warns and still starts pi.
		if (result.interrupted) return { exitCode: result.exitCode };
		if (!result.ok) {
			const remediation = [...homeSelectorFlags(home).map(shellQuote), "setup"].join(" ");
			process.stderr.write(
				`gentle-shell: automatic setup failed (exit ${result.exitCode}); starting anyway and retrying next run. Run \`gentle-shell ${remediation}\` to see the full output.\n`,
			);
			if (result.message !== undefined) process.stderr.write(`${result.message}\n`);
			return undefined;
		}

		writeRawConfig(configPath, recordProvisioned(readRawConfig(configPath), homeKey, pin, gentlePiVersion, new Date().toISOString()));
		return undefined;
	} finally {
		releaseSetupLock(lockPath);
	}
}

async function main() {
	const args = parseLauncherArgs(process.argv.slice(2));
	if (args.error !== undefined) fail(`${args.error}\nRun 'gentle-shell --help' for usage.`, 2);
	if (args.help) {
		process.stdout.write(`${helpText()}\n`);
		process.exit(0);
	}
	if (args.command === "home") {
		handleHomeCommand(args.commandArgs);
		return;
	}

	const config = loadConfig();
	let home = resolveHome({ args, env: process.env, homedir: homedir(), config });
	if (home.mode === "path") home = { ...home, dir: resolvePath(home.dir) };

	const runtime = resolvePiRuntime({
		env: process.env,
		resolveBundledCli,
		findOnPath,
		nodeExecPath: process.execPath,
	});
	if (runtime === undefined) fail(missingPiMessage(), 1);

	const versionProbePlan = planSpawn({ command: runtime.command, args: [...runtime.args, "--version"], platform: process.platform });
	const versionProbe = spawnSync(versionProbePlan.command, versionProbePlan.args, {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 15000,
		encoding: "utf8",
		shell: versionProbePlan.shell,
	});
	if (versionProbe.error) fail(`Could not run the pi runtime at "${runtime.command}": ${versionProbe.error.message}`, 1);
	const versionCheck = checkPiVersion(versionProbe.stdout ?? "");
	if (!versionCheck.ok) fail(versionCheck.message, 1);

	if (args.version) {
		process.stdout.write(`${describeVersion({ gentlePiVersion: ownPackageVersion(), piVersion: versionCheck.version, home })}\n`);
		process.exit(0);
	}

	// Home-ownership signal for auto-provisioning (S9, homeIsForeign): must be
	// read before the isolated-home bootstrap below creates and seeds a
	// brand-new --home directory with its own settings.json — after that
	// bootstrap runs, "did this home already have content" can no longer be
	// answered by looking at the directory.
	let homeHadContentBeforeBootstrap = false;
	if (existsSync(home.dir)) {
		try {
			homeHadContentBeforeBootstrap = readdirSync(home.dir).length > 0;
		} catch {
			homeHadContentBeforeBootstrap = false;
		}
	}

	// Isolated-home bootstrap: only on a home gentle-shell has not seen before
	// (link never bootstraps — it reuses the user's own pi agent home as-is).
	if ((home.mode === "isolated" || home.mode === "path") && !existsSync(home.dir)) {
		mkdirSync(home.dir, { recursive: true });
		await installIsolatedTuiModeSetting(home.dir);
		writeHomeOwnershipMarker(home); // R3-001: lets a failed first auto-provision attempt still be retried later
		process.stderr.write(`gentle-shell: using a separate home at ${home.dir}. Run 'gentle-shell --link' to reuse your pi sign-ins and chats.\n`);
	}

	if (args.command === "setup") {
		await handleSetupCommand(args.commandArgs, home, runtime);
		return;
	}

	// Auto-provision (S7): a plain launch against an isolated or --home home
	// (never --link) runs the same flow as `gentle-shell setup` automatically
	// before pi starts, so the maintainer's own packages install without ever
	// needing to know `setup` exists. Skipped for a pi subcommand
	// (`gentle-shell install/remove/list/...`) — argv[0] must stay the bare
	// subcommand for pi to dispatch it, same reason the declaration/take-over
	// block below skips it. Must run before that block reads settings.json,
	// so that block sees settings.json exactly as this same auto-provision run
	// (if any) left it — notably with any npm:gentle-pi declaration already
	// removed again by runPostInstallCleanup, since the home never actually
	// keeps that declaration — instead of reading stale pre-setup content
	// within the same launch. Never lets an unexpected failure here (fs
	// errors, a lock, a malformed config) block the launch itself (R4): any
	// throw is caught and only warned about, exactly like an ordinary
	// setup-flow failure.
	if ((home.mode === "isolated" || home.mode === "path") && args.piSubcommand === undefined) {
		let autoProvisionResult;
		try {
			autoProvisionResult = await maybeAutoProvisionHome(home, runtime, { homeHadContentBeforeBootstrap });
		} catch (error) {
			process.stderr.write(`gentle-shell: automatic setup failed unexpectedly (${error.message}); starting anyway and retrying next run.\n`);
			autoProvisionResult = undefined;
		}
		// Only an interrupt reaching the spawned child (SIGINT/SIGTERM/SIGHUP)
		// returns a result here: the user asked this process to stop, so it
		// exits with the same signal-derived code instead of falling through
		// to launch pi.
		if (autoProvisionResult !== undefined) process.exit(autoProvisionResult.exitCode);
	}

	const packageRootExplicit = args.packageRoot !== undefined;
	const effectivePackageRoot = packageRootExplicit ? resolvePath(args.packageRoot) : packageRoot;
	// R4-forced-package-root-unvalidated / R3-005: an unvalidated --package-root
	// forces a take-over (dropping normal extension discovery via
	// --no-extensions) and then hands pi -e/--theme/--skill/--prompt-template
	// flags pointing at directories that do not exist, turning an operator typo
	// into an obscure pi loader failure instead of a clear launcher error.
	if (packageRootExplicit && !isDirectory(effectivePackageRoot)) {
		fail(`--package-root ${args.packageRoot} does not exist or is not a directory.`, 2);
	}

	let declaration;
	let takeOver = false;
	let otherPackagePaths = [];
	let looseExtensionEntries = [];

	// Every mode consults the home's own settings.json for a gentle-pi
	// declaration, not just --link: `gentle-shell setup` installs
	// npm:gentle-pi into an isolated or --home home's settings.json, and once
	// that declaration exists the launcher must stop injecting its own copy
	// on top of it (buildPiInvocation skips injection whenever a declaration
	// is present and there is no take-over). A path declaration in a
	// non-link home follows the same take-over rules as --link. A home
	// without any declaration keeps the plain injection, unchanged.
	//
	// --package-root only forces a take-over in --link mode: an isolated or
	// --home target has no pre-existing pi installation to defer to, so
	// forcing --no-extensions there would just strip its own settings-driven
	// discovery for no benefit (see the "gated on link mode" bin test). A pi
	// subcommand skips this whole block: buildPiInvocation ignores
	// takeOver/declaration once piSubcommand is set, and running the
	// take-over/loose-dir discovery anyway would still print a misleading
	// "taking over gentle-pi..." message (and otherPackageInjections
	// warnings) for a plain `gentle-shell install npm:x` that never actually
	// takes anything over.
	if (args.piSubcommand === undefined) {
		const settingsText = readJsonIfExists(join(home.dir, "settings.json"));
		declaration = findGentlePiDeclaration(settingsText, { agentDir: home.dir, readPackageName });
		// --package-root only forces a take-over in --link mode (see below);
		// in every other mode a declared home silently keeps using its
		// declared gentle-pi and --package-root has no effect at all. Warn
		// once so an operator does not assume --package-root took effect.
		if (packageRootExplicit && home.mode !== "link" && declaration !== undefined) {
			process.stderr.write(
				`gentle-shell: --package-root only forces a take-over in --link mode; ${home.dir} declares gentle-pi, so the installed package is used and ${args.packageRoot} is ignored\n`,
			);
		}
		const realEffectivePackageRoot = safeRealpath(effectivePackageRoot);
		const realDeclaredDir = declaration?.kind === "path" ? safeRealpath(declaration.dir) : undefined;
		takeOver = decideTakeOver({
			declaration,
			realPackageRoot: realEffectivePackageRoot,
			realDeclaredDir,
			packageRootExplicit: home.mode === "link" && packageRootExplicit,
		});
		if (takeOver) {
			const skip = declaration ?? { kind: "path", dir: realEffectivePackageRoot };
			const injections = otherPackageInjections({ settingsText, agentDir: home.dir, skip, isDirectory, realpath: safeRealpath });
			otherPackagePaths = injections.paths;
			for (const warning of injections.warnings) process.stderr.write(`${warning}\n`);
			// --no-extensions drops pi's normal settings-driven extension
			// discovery, which also covers loose (non-package) extensions
			// under <agentDir>/extensions and the project-local
			// <cwd>/.pi/extensions. Re-injecting either directory wholesale
			// as `-e <dir>` does not work for a directory of loose files: pi's
			// -e flag hands the path straight to its module loader with no
			// directory-discovery pass, so a bare directory of loose files
			// fails with "Cannot find module ...". Resolve each candidate
			// into its actual loose file entries (or pass it through
			// unchanged when it is itself a self-contained extension) so a
			// take-over does not silently stop loading them.
			looseExtensionEntries = [join(home.dir, "extensions"), join(process.cwd(), ".pi", "extensions")].flatMap(resolveLooseExtensionEntries);
			const declaredFrom = declaration === undefined ? "the requested package root" : declaration.kind === "npm" ? "npm:gentle-pi" : declaration.dir;
			process.stderr.write(
				`gentle-shell: taking over gentle-pi from ${declaredFrom} for this run (settings unchanged; its skills, prompts, and themes still load alongside this launcher's).\n`,
			);
		}
	}

	const invocation = buildPiInvocation({
		runtime,
		home,
		packageRoot: effectivePackageRoot,
		declaration,
		takeOver,
		otherPackagePaths,
		looseExtensionEntries,
		passthrough: args.passthrough,
		piSubcommand: args.piSubcommand,
		baseEnv: process.env,
	});

	const launchPlan = planSpawn({ command: invocation.command, args: invocation.args, platform: process.platform });
	const child = spawn(launchPlan.command, launchPlan.args, { stdio: "inherit", env: invocation.env, shell: launchPlan.shell });
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(signal, () => child.kill(signal));
	}
	child.on("error", (error) => fail(`Could not start pi: ${error.message}`, 1));
	child.on("exit", (code, signal) => {
		process.exit(signal ? signalExitCode(signal) : (code ?? 1));
	});
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
