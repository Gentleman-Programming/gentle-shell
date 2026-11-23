import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import {
	DRAKONC_AI_INSTALL_METHOD,
	DRAKONC_AI_WINDOWS_SOURCE_MODULE,
	DRAKONC_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
	DRAKONC_AI_WINDOWS_SOURCE_PACKAGE_PATH,
	DRAKONC_AI_WINDOWS_SOURCE_TAG,
	INSTALLER_VERSION,
	isDrakoncAiWindowsGoVersionSupported,
	isWindowsGoSumdbSourceTarget,
	resolveDrakoncAiReleaseAsset,
} from "../scripts/drakonc-ai-installer.mjs";
import { engramPinVersion } from "../scripts/installer-downloads.mjs";
import { bundledPiConfigDir, bundledPiConfigParent, DRAKONC_SHELL_CONFIG_HOME_ENV, resolveDrakoncPiConfigHome, runningBundledPrefix } from "./drakonc-shell-bundled.ts";
import { fileURLToPath } from "node:url";

export const DRAKONC_AI_BINARY_MISSING_CODE = "package-local-binary-missing";
export const DRAKONC_AI_INSTALL_RECOVERY_COMMAND = "node scripts/install-drakonc-ai.mjs";
export const DRAKONC_AI_INSTALL_RECOVERY_INSTRUCTIONS = `If DRAKONC_PI_SKIP_DRAKONC_AI_INSTALL is set, remove or unset it before changing to the installed drakonc-pi package directory and running \`${DRAKONC_AI_INSTALL_RECOVERY_COMMAND}\`.`;
// Derived from the one authoritative pinned version in
// scripts/drakonc-ai-installer.mjs rather than repeating the literal here, so
// the two can never independently drift apart the way they once did.
export const DRAKONC_AI_VERSION = INSTALLER_VERSION;

export class PackageLocalDrakoncAiBinaryMissingError extends Error {
	readonly code = DRAKONC_AI_BINARY_MISSING_CODE;
	constructor(path: string) {
		super(
			`${DRAKONC_AI_BINARY_MISSING_CODE}: Drakonc AI v${DRAKONC_AI_VERSION} is not installed at ${path}. ${DRAKONC_AI_INSTALL_RECOVERY_INSTRUCTIONS} A missing binary can result from skipped lifecycle scripts, but does not prove install lifecycle scripts were disabled.`,
		);
		this.name = "PackageLocalDrakoncAiBinaryMissingError";
	}
}

export function drakoncAiBinaryPath(
	packageRoot = dirname(dirname(fileURLToPath(import.meta.url))),
	platform = process.platform,
): string {
	return join(
		resolve(packageRoot),
		".drakonc-ai",
		`v${DRAKONC_AI_VERSION}`,
		platform === "win32" ? "drakonc-ai.exe" : "drakonc-ai",
	);
}

// ---------------------------------------------------------------------------
// Bundled isolation (S9). The bundled launcher (bin/drakonc-shell.mjs) gives Pi
// and setup DRAKONC_SHELL_PREFIX, its prefix. Every drakonc-ai run a bundled
// drakonc-pi starts gets Drakonc AI's own variables (drakonc-ai #5462), each in
// two names: its state, backups and telemetry under <prefix>/drakonc-ai, the
// drakonc-pi config folder <prefix>/config/drakonc-ai for its persona and
// background subagent files (and, for Drakonc AI 4.0.0, DRAKONC_PI_CONFIG_HOME=
// <prefix>/config), the pinned Engram in runtime/ with no Engram acquisition or
// dependency probe, and no self-update. The second name of each pair is the one
// the pinned companion binary reads (GENTLE_*: contracts of gentle-ai 5.0.0,
// docs/brand-exceptions.md). None is ever put in Pi's own environment: the
// agent's shell inherits it, and a drakonc-ai the user runs there stays the
// user's. A drakonc-ai release without #5462 ignores the DRAKONC_* names and a
// future drakonc-ai that only reads them ignores the GENTLE_* ones.
// ---------------------------------------------------------------------------

export interface BundledDrakoncAiPaths {
	/** DRAKONC_AI_HOME. */
	home: string;
	/** DRAKONC_PI_CONFIG_HOME for Drakonc AI only: the parent Drakonc AI 4.0.0 appends drakonc-ai to. */
	piConfigParent: string;
	/** DRAKONC_AI_PI_CONFIG_DIR: drakonc-pi's own bundled config home, <piConfigParent>/drakonc-ai. */
	piConfig: string;
	/** The Engram scripts/bundled-install.mjs publishes (prefixLayout's `engram`). */
	engram: string;
}

export function bundledDrakoncAiPaths(prefix: string, platform: string = process.platform): BundledDrakoncAiPaths {
	const path = pathFor(platform);
	return {
		home: path.join(prefix, "drakonc-ai"),
		piConfigParent: bundledPiConfigParent(prefix, platform),
		piConfig: bundledPiConfigDir(prefix, platform),
		engram: path.join(prefix, "runtime", `engram-${engramPinVersion}`, platform === "win32" ? "engram.exe" : "engram"),
	};
}

function pathFor(platform: string): typeof posix {
	return platform === "win32" ? win32 : posix;
}

// The folders under the OS home that belong to another product. A companion run
// never takes its state from them, not even when it inherits the variable from
// a real gentle-ai install (S1: the first real launch wrote
// ~/.gentle-ai/state.json and ~/.pi/gentle-ai/persona.json).
const FOREIGN_HOME_FOLDERS = [".gentle-ai", ".pi", ".gentle-shell"];

function isInsideFolder(folder: string, path: string, platform: string): boolean {
	const pathModule = pathFor(platform);
	const relativePath = pathModule.relative(folder, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath));
}

/**
 * The companion's own home outside a bundled prefix: DRAKONC_AI_HOME, then the
 * inherited GENTLE_AI_HOME, then Drakonc's own default
 * (~/.drakonc-shell/drakonc-ai-home). A declared folder that is relative or
 * inside another product's home is ignored, because it would put the
 * companion's state back where this isolation removes it from. Never
 * ~/.gentle-ai.
 */
export function standaloneDrakoncAiHome(
	env: NodeJS.ProcessEnv,
	osHome: string = homedir(),
	platform: string = process.platform,
): string {
	const pathModule = pathFor(platform);
	const declared = env.DRAKONC_AI_HOME ?? env.GENTLE_AI_HOME;
	if (declared !== undefined && declared.length > 0 && pathModule.isAbsolute(declared)
		&& !FOREIGN_HOME_FOLDERS.some((folder) => isInsideFolder(pathModule.join(osHome, folder), declared, platform))) {
		return declared;
	}
	return pathModule.join(osHome, ".drakonc-shell", "drakonc-ai-home");
}

export interface DrakoncAiIsolationPaths {
	/** The companion's own home: its state, backups and telemetry. */
	home: string;
	/** drakonc-pi's config folder: where the companion writes its persona and the background-subagents policy. */
	piConfig?: string;
	/** The parent the companion appends its own folder to. */
	piConfigParent?: string;
	/** The pinned Engram binary. */
	engram?: string;
}

// D1: every isolation variable has two names, and both carry the same value:
// Drakonc's own and the ones the pinned companion binary reads. The installed
// binary is the original gentle-ai 5.0.0 (docs/brand-exceptions.md, "Variables
// GENTLE_* del binario companion"), which recognizes only GENTLE_*, so with the
// DRAKONC_* names alone it fell back to its own defaults — ~/.gentle-ai and
// ~/.pi/gentle-ai — and stayed free to self-update over the pinned checksum.
// A future drakonc-ai that reads only DRAKONC_* keeps working unchanged.
//
// NO_SELF_UPDATE=1 in every mode, because the binary is fixed by SHA-256 and a
// self-update would replace it with a release from another project (S1, S2).
// These variables go to the companion process only, never to Pi or its shell.
function drakoncAiIsolationVariables(paths: DrakoncAiIsolationPaths, platform: string): Record<string, string> {
	const variables: Record<string, string> = {
		DRAKONC_AI_HOME: paths.home,
		GENTLE_AI_HOME: paths.home,
		DRAKONC_AI_NO_SELF_UPDATE: "1",
		GENTLE_AI_NO_SELF_UPDATE: "1",
	};
	if (paths.piConfig !== undefined) {
		variables.DRAKONC_AI_PI_CONFIG_DIR = paths.piConfig;
		variables.GENTLE_AI_PI_CONFIG_DIR = paths.piConfig;
	}
	if (paths.piConfigParent !== undefined) {
		// gentle-ai 5.0.0 appends "gentle-ai" to GENTLE_PI_CONFIG_HOME: given the
		// config folder's parent, even a write that falls back to that policy stays
		// inside Drakonc's own folder (<parent>/gentle-ai), never ~/.pi/gentle-ai.
		variables.GENTLE_PI_CONFIG_HOME = paths.piConfigParent;
		// Drakonc AI 4.0.0 reads DRAKONC_PI_CONFIG_HOME as the parent of its own
		// drakonc-ai folder, so it is given only for a folder named that way.
		if (paths.piConfig !== undefined && pathFor(platform).basename(paths.piConfig) === "drakonc-ai") {
			variables.DRAKONC_PI_CONFIG_HOME = paths.piConfigParent;
		}
	}
	if (paths.engram !== undefined) {
		variables.DRAKONC_AI_ENGRAM_BIN = paths.engram;
		variables.GENTLE_AI_ENGRAM_BIN = paths.engram;
	}
	return variables;
}

/**
 * `env` plus the companion isolation variables, one pair of names each, for
 * this drakonc-pi's Drakonc AI: DRAKONC_AI_HOME/GENTLE_AI_HOME,
 * DRAKONC_AI_PI_CONFIG_DIR/GENTLE_AI_PI_CONFIG_DIR,
 * DRAKONC_AI_ENGRAM_BIN/GENTLE_AI_ENGRAM_BIN (only when the pinned Engram is
 * published), DRAKONC_AI_NO_SELF_UPDATE and GENTLE_AI_NO_SELF_UPDATE set to 1,
 * GENTLE_PI_CONFIG_HOME and — for a config folder named drakonc-ai —
 * DRAKONC_PI_CONFIG_HOME.
 *
 * Inside the valid bundled install DRAKONC_SHELL_PREFIX names
 * (runningBundledPrefix) every path is inside the prefix. In the standalone
 * launcher's isolated home (#2201) the config pair follows its marker and the
 * companion's own home is Drakonc's, outside ~/.pi and ~/.gentle-ai. Elsewhere
 * (`--link`, a custom home) it gets no config folder of its own — that home is
 * the user's — but still the companion home and no self-update, so it never
 * writes another product's state nor replaces the pinned binary.
 */
export function drakoncAiIsolationEnv(
	env: NodeJS.ProcessEnv,
	options: { packageRoot?: string; platform?: string; osHome?: string } = {},
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	const osHome = options.osHome ?? homedir();
	const prefix = runningBundledPrefix(env, { packageRoot: options.packageRoot, platform });
	if (prefix === undefined) return standaloneDrakoncAiEnv(env, platform, osHome);
	const paths = bundledDrakoncAiPaths(prefix, platform);
	let engram = false;
	try {
		engram = lstatSync(paths.engram).isFile();
	} catch {
		// Not published (a prefix from before Engram shipped): Drakonc AI gets none.
	}
	// Drakonc AI 4.0.0 ignores DRAKONC_AI_ENGRAM_BIN and looks `engram` up on PATH
	// first, then falls back to Homebrew (`brew tap`, #2105): the pinned one goes first.
	const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? (platform === "win32" ? "Path" : "PATH");
	const pathModule = pathFor(platform);
	const path = engram
		? { [pathKey]: [pathModule.dirname(paths.engram), ...(env[pathKey] ?? "").split(pathModule.delimiter).filter((entry) => entry.length > 0)].join(pathModule.delimiter) }
		: {};
	return {
		...env,
		...path,
		// A bundled install keeps Drakonc AI's state and config inside the prefix.
		...drakoncAiIsolationVariables({
			home: paths.home,
			piConfig: paths.piConfig,
			piConfigParent: paths.piConfigParent,
			...(engram ? { engram: paths.engram } : {}),
		}, platform),
	};
}

// #2201: outside a bundled prefix, the companion's own home is Drakonc's, and
// the config pair follows the folder the standalone launcher's marker names,
// when it decides the config home (resolveDrakoncPiConfigHome; an explicit
// DRAKONC_PI_CONFIG_HOME keeps its existing meaning). No other mode gets a
// config folder of its own: `--link` and a custom `--home` are the user's, and
// their documented behavior is not widened.
function standaloneDrakoncAiEnv(env: NodeJS.ProcessEnv, platform: string, osHome: string): NodeJS.ProcessEnv {
	const marker = env[DRAKONC_SHELL_CONFIG_HOME_ENV];
	const paths: DrakoncAiIsolationPaths = { home: standaloneDrakoncAiHome(env, osHome, platform) };
	if (marker !== undefined && resolveDrakoncPiConfigHome(env, osHome, { platform }) === marker) {
		paths.piConfig = marker;
		paths.piConfigParent = pathFor(platform).dirname(marker);
	}
	return { ...env, ...drakoncAiIsolationVariables(paths, platform) };
}

// ---------------------------------------------------------------------------
// Shared Pi files a companion install rewrites (S3). The companion writes its
// persona into the OS home, never into PI_CODING_AGENT_DIR
// (gentle-ai internal/components/persona/inject.go), and records the running
// binary's managed-asset bundle digest in its own global state file, so a setup
// run for any home silently resets what the user already chose. Both lists
// carry Drakonc's own file and the one the pinned gentle-ai 5.0.0 writes, which
// is not a Drakonc folder but must come back unchanged while that binary is the
// one installed.
// ---------------------------------------------------------------------------

/** The Pi persona files a companion install writes against the OS home. */
export function sharedDrakoncAiPersonaPaths(osHome: string, platform: string = process.platform): string[] {
	const path = pathFor(platform);
	return [
		path.join(osHome, ".pi", "drakonc-ai", "persona.json"),
		path.join(osHome, ".pi", "gentle-ai", "persona.json"),
	];
}

/** The companion's global state files, whose managed_asset_digest a setup run restores. */
export function sharedDrakoncAiStatePaths(osHome: string, platform: string = process.platform): string[] {
	const path = pathFor(platform);
	return [
		path.join(osHome, ".drakonc-ai", "state.json"),
		path.join(osHome, ".gentle-ai", "state.json"),
	];
}

export interface DrakoncAiPersonaSnapshotInput {
	/** The bundled prefix's drakonc-pi config folder, when setup runs from a bundled install. */
	bundledPiConfig?: string;
	/** The standalone isolated home's own config folder (standaloneConfigHome), when it has one. */
	configHome?: string;
	osHome: string;
	platform?: string;
}

/**
 * The persona files one setup run may rewrite: its own config folder's first
 * (the one this launcher gives the companion), then the shared ones. Restoring
 * an unchanged file does nothing.
 */
export function drakoncAiPersonaSnapshotPaths(input: DrakoncAiPersonaSnapshotInput): string[] {
	const platform = input.platform ?? process.platform;
	const configHome = input.bundledPiConfig ?? input.configHome;
	const own = configHome === undefined ? [] : [pathFor(platform).join(configHome, "persona.json")];
	return [...own, ...sharedDrakoncAiPersonaPaths(input.osHome, platform)];
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Dev-binary override — the maintainer field-test lane.
//
// Two explicit activation paths, in precedence order:
//   1. DRAKONC_PI_DRAKONC_AI_DEV_BINARY (session override, absolute path), then
//   2. the persistent registration file at
//      <config home>/dev-binary.json (a bundled prefix's drakonc-pi, else
//      DRAKONC_PI_CONFIG_HOME, else ~/.drakonc-shell/drakonc-ai, never the
//      standalone launcher's marker: the main channel writes it outside any
//      session, #2201) with the strict
//      shape {"schema":"drakonc-pi.dev-binary/v1","path":"<absolute path>"}.
//
// The registration deliberately pins no digest: it is the unpinned field-test
// mode, and the binary at that path changes on every rebuild. Every resolution
// re-validates the file and recomputes the sha256, so a rebuilt binary is
// followed automatically with a fresh digest and no re-registration.
//
// Guardrails per resolution: absolute path, regular non-symlink file, POSIX
// executable. Any failure — including a malformed registration document or a
// registered-but-missing binary — is a typed error naming its origin, never a
// silent fallback to the pinned binary: silently running the pin while the
// maintainer believes he is field-testing main is the worst possible outcome.
// With neither activation path present, the pinned supply-chain resolution
// below stays byte-identical.
// ---------------------------------------------------------------------------

export const DRAKONC_AI_DEV_BINARY_ENV = "DRAKONC_PI_DRAKONC_AI_DEV_BINARY";
export const DRAKONC_AI_DEV_BINARY_REGISTRATION_SCHEMA = "drakonc-pi.dev-binary/v1";
export const DRAKONC_AI_DEV_BINARY_OVERRIDE_INVALID_CODE = "dev-binary-override-invalid";

export interface DrakoncAiDevBinaryEnvironment {
	env: Record<string, string | undefined>;
	home: string;
}

export interface DrakoncAiDevBinaryOverride {
	source: "env" | "registration";
	/** The env var name or registration file path that selected this binary. */
	origin: string;
	path: string;
	sha256: string;
}

export class DrakoncAiDevBinaryOverrideError extends Error {
	readonly code = DRAKONC_AI_DEV_BINARY_OVERRIDE_INVALID_CODE;
	readonly source: "env" | "registration";
	readonly origin: string;
	constructor(source: "env" | "registration", origin: string, reason: string) {
		super(`${DRAKONC_AI_DEV_BINARY_OVERRIDE_INVALID_CODE}: ${origin} ${reason}. Fix or remove the override; the pinned binary is never used silently while an override is declared.`);
		this.name = "DrakoncAiDevBinaryOverrideError";
		this.source = source;
		this.origin = origin;
	}
}

let devBinaryEnvironmentTestingOverlay: DrakoncAiDevBinaryEnvironment | undefined;

/** Testing-only environment overlay; production code never calls this. */
export function setDrakoncAiDevBinaryEnvironmentForTesting(environment: DrakoncAiDevBinaryEnvironment | undefined): void {
	devBinaryEnvironmentTestingOverlay = environment;
}

function ambientDevBinaryEnvironment(): DrakoncAiDevBinaryEnvironment {
	return devBinaryEnvironmentTestingOverlay ?? { env: process.env, home: homedir() };
}

export function drakoncAiDevBinaryRegistrationPath(environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): string {
	const configHome = resolveDrakoncPiConfigHome(environment.env, environment.home, { launcherMarker: false });
	return join(configHome, "dev-binary.json");
}

function validateDevBinary(source: "env" | "registration", origin: string, path: string, platform: string): DrakoncAiDevBinaryOverride {
	if (typeof path !== "string" || path.length === 0) throw new DrakoncAiDevBinaryOverrideError(source, origin, "declares an empty dev binary path");
	if (!isAbsolute(path)) throw new DrakoncAiDevBinaryOverrideError(source, origin, `must name an absolute path, received "${path}"`);
	let details: ReturnType<typeof lstatSync>;
	try {
		details = lstatSync(path);
	} catch {
		throw new DrakoncAiDevBinaryOverrideError(source, origin, `names "${path}", which does not exist`);
	}
	if (!details.isFile() || details.isSymbolicLink()) throw new DrakoncAiDevBinaryOverrideError(source, origin, `names "${path}", which is not a regular non-symlink file`);
	if (platform !== "win32" && (details.mode & 0o111) === 0) throw new DrakoncAiDevBinaryOverrideError(source, origin, `names "${path}", which is not a POSIX executable`);
	let digest: string;
	try {
		digest = sha256(readFileSync(path));
	} catch {
		throw new DrakoncAiDevBinaryOverrideError(source, origin, `names "${path}", which could not be read`);
	}
	return { source, origin, path, sha256: digest };
}

function readDevBinaryRegistration(registrationPath: string): string {
	let contents: string;
	try {
		contents = readFileSync(registrationPath, "utf8");
	} catch {
		throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, "could not be read");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, "is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, "must be a JSON object");
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "schema") throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, `must carry exactly the keys "schema" and "path"`);
	if (record.schema !== DRAKONC_AI_DEV_BINARY_REGISTRATION_SCHEMA) throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, `must declare schema ${DRAKONC_AI_DEV_BINARY_REGISTRATION_SCHEMA}`);
	if (typeof record.path !== "string" || record.path.length === 0) throw new DrakoncAiDevBinaryOverrideError("registration", registrationPath, "must declare a non-empty string path");
	return record.path;
}

/**
 * Resolves the active dev-binary override, if any. Returns undefined only when
 * neither activation path is present; a present-but-invalid override always
 * throws a typed DrakoncAiDevBinaryOverrideError naming its origin.
 */
export function resolveDrakoncAiDevBinaryOverride(
	environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): DrakoncAiDevBinaryOverride | undefined {
	const envValue = environment.env[DRAKONC_AI_DEV_BINARY_ENV];
	if (envValue !== undefined && envValue.length > 0) return validateDevBinary("env", DRAKONC_AI_DEV_BINARY_ENV, envValue, platform);
	const registrationPath = drakoncAiDevBinaryRegistrationPath(environment);
	if (!existsSync(registrationPath)) return undefined;
	return validateDevBinary("registration", registrationPath, readDevBinaryRegistration(registrationPath), platform);
}

/**
 * Cheap presence probe: is a dev-binary override declared at all? Used by the
 * native CLI to select the unpinned version gate without hashing the binary.
 * Declared-but-invalid still counts as configured — the resolution path will
 * fail loudly with the typed error instead of quietly using the pin.
 */
export function drakoncAiDevBinaryOverrideConfigured(environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): boolean {
	const envValue = environment.env[DRAKONC_AI_DEV_BINARY_ENV];
	if (envValue !== undefined && envValue.length > 0) return true;
	return existsSync(drakoncAiDevBinaryRegistrationPath(environment));
}

/** Validates and persistently registers a dev binary; returns the fresh override. */
export function registerDrakoncAiDevBinary(
	path: string,
	environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): { registrationPath: string; override: DrakoncAiDevBinaryOverride } {
	const registrationPath = drakoncAiDevBinaryRegistrationPath(environment);
	const validated = validateDevBinary("registration", registrationPath, path, platform);
	mkdirSync(dirname(registrationPath), { recursive: true });
	writeFileSync(registrationPath, `${JSON.stringify({ schema: DRAKONC_AI_DEV_BINARY_REGISTRATION_SCHEMA, path })}\n`);
	return { registrationPath, override: validated };
}

/** Deletes the persistent registration; returns whether one existed. */
export function unregisterDrakoncAiDevBinary(environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): boolean {
	const registrationPath = drakoncAiDevBinaryRegistrationPath(environment);
	if (!existsSync(registrationPath)) return false;
	rmSync(registrationPath);
	return true;
}

function isConfined(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function assertRegularNonSymlink(path: string): void {
	const details = lstatSync(path);
	if (!details.isFile() || details.isSymbolicLink()) throw new Error("expected regular non-symlink file");
}

function assertPosixExecutable(path: string, platform: string): void {
	if (platform !== "win32" && (lstatSync(path).mode & 0o111) === 0) {
		throw new Error("expected executable POSIX binary");
	}
}

function signedReleaseManifest(asset: { name: string; sha256: string; binarySha256: string }): Record<string, string> {
	return { version: DRAKONC_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: asset.binarySha256 };
}

function windowsSourceManifest(manifest: Record<string, unknown>, binarySha256: string, platform: string): Record<string, string> {
	if (!isWindowsGoSumdbSourceTarget(platform, process.arch)) throw new Error("unsupported Windows source architecture");
	const architecture = process.arch === "x64" ? "x64" : "arm64";
	const goVersion = manifest.goVersion;
	if (manifest.moduleChecksum !== DRAKONC_AI_WINDOWS_SOURCE_MODULE_CHECKSUM || typeof goVersion !== "string" || !isDrakoncAiWindowsGoVersionSupported(goVersion)) throw new Error("invalid Windows source provenance");
	return {
		version: DRAKONC_AI_VERSION,
		method: DRAKONC_AI_INSTALL_METHOD.GO_SUMDB_SOURCE_BUILD,
		package: DRAKONC_AI_WINDOWS_SOURCE_PACKAGE_PATH,
		module: DRAKONC_AI_WINDOWS_SOURCE_MODULE,
		tag: DRAKONC_AI_WINDOWS_SOURCE_TAG,
		architecture,
		binarySha256,
		moduleChecksum: DRAKONC_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
		goVersion,
		goos: "windows",
		goarch: process.arch === "x64" ? "amd64" : "arm64",
		buildMode: "exe",
		compiler: "gc",
		cgoEnabled: "0",
	};
}

function expectedRuntimeManifest(platform: string, binarySha256: string, manifest: Record<string, unknown>): Record<string, string> {
	if (platform === "win32") return windowsSourceManifest(manifest, binarySha256, platform);
	const asset = resolveDrakoncAiReleaseAsset(platform, process.arch);
	if (binarySha256 !== asset.binarySha256) throw new Error("runtime binary does not match pinned release digest");
	return signedReleaseManifest(asset);
}

function isCanonicalManifest(contents: string, manifest: Record<string, unknown>, expected: Record<string, string>): boolean {
	return contents === `${JSON.stringify(expected)}\n`
		&& Object.keys(manifest).length === Object.keys(expected).length
		&& Object.entries(expected).every(([key, value]) => manifest[key] === value);
}

function sameFile(before: ReturnType<typeof lstatSync>, after: ReturnType<typeof lstatSync>): boolean {
	return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

// Reading and hashing the whole binary on every native call is expensive, and
// on Windows antivirus scans each read. The digest is reused only while the
// file keeps its full identity; any rewrite changes ctime, which callers cannot
// set, so a replaced binary is always hashed again. Keyed per reader so an
// injected reader never sees another reader's digest.
const binaryDigestCache = new WeakMap<(path: string) => Buffer, Map<string, { readonly identity: string; readonly sha256: string }>>();

function binaryIdentity(path: string): string {
	const details = lstatSync(path, { bigint: true });
	return [details.dev, details.ino, details.size, details.mtimeNs, details.ctimeNs].join(":");
}

export function binaryDigest(path: string, readBinary: (path: string) => Buffer = readFileSync): string {
	let entries = binaryDigestCache.get(readBinary);
	if (entries === undefined) binaryDigestCache.set(readBinary, entries = new Map());
	const identity = binaryIdentity(path);
	const cached = entries.get(path);
	if (cached?.identity === identity) return cached.sha256;
	const digest = sha256(readBinary(path));
	if (binaryIdentity(path) === identity) entries.set(path, { identity, sha256: digest });
	else entries.delete(path);
	return digest;
}

export function resolveDrakoncAiBinary(
	packageRoot = dirname(dirname(fileURLToPath(import.meta.url))),
	platform = process.platform,
	readBinary: (path: string) => Buffer = readFileSync,
	environment: DrakoncAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
): string {
	// The explicit dev-binary override wins over the pinned supply-chain path.
	// Its typed errors propagate: a declared override never falls back to the
	// pin. Without a declared override this call returns undefined and the
	// pinned resolution below is byte-identical to the pre-override behavior.
	const override = resolveDrakoncAiDevBinaryOverride(environment, platform);
	if (override !== undefined) return override.path;
	const binaryPath = drakoncAiBinaryPath(packageRoot, platform);
	const versionDirectory = dirname(binaryPath);
	const manifestPath = join(versionDirectory, "integrity.json");
	try {
		if (!isAbsolute(binaryPath) || !isConfined(binaryPath, versionDirectory)) throw new Error("unconfined binary");
		for (const path of [join(resolve(packageRoot), ".drakonc-ai"), versionDirectory]) {
			const details = lstatSync(path);
			if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("symlinked runtime directory");
		}
		assertRegularNonSymlink(binaryPath);
		assertPosixExecutable(binaryPath, platform);
		assertRegularNonSymlink(manifestPath);
		const beforeBinary = lstatSync(binaryPath);
		const beforeManifest = lstatSync(manifestPath);
		const manifestContents = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(manifestContents) as Record<string, unknown>;
		const binarySha256 = binaryDigest(binaryPath, readBinary);
		const expected = expectedRuntimeManifest(platform, binarySha256, manifest);
		if (!isCanonicalManifest(manifestContents, manifest, expected)) throw new Error("invalid runtime integrity manifest");
		const afterBinary = lstatSync(binaryPath);
		const afterManifest = lstatSync(manifestPath);
		if (!sameFile(beforeBinary, afterBinary) || !sameFile(beforeManifest, afterManifest)) throw new Error("runtime replaced during verification");
		assertPosixExecutable(binaryPath, platform);
		return binaryPath;
	} catch {
		throw new PackageLocalDrakoncAiBinaryMissingError(binaryPath);
	}
}
