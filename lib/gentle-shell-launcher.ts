import { join, resolve as resolvePath } from "node:path";

// The gentle-shell launcher: pure, side-effect-free functions over injected
// env/fs/exec. `bin/gentle-shell.mjs` (T2) wires these into the real process,
// filesystem and child process so this module stays fully unit-testable.

export type LauncherCommand = "home" | "setup";

// pi's own package-management subcommands (see pi's cli/args.ts printHelp
// "Commands" list): each is dispatched by pi itself, before pi's own flag
// parsing, purely on argv[0]. `uninstall` is pi's alias for `remove`.
export const PI_SUBCOMMANDS = ["install", "remove", "uninstall", "update", "list", "config", "auth"] as const;

export type PiSubcommand = (typeof PI_SUBCOMMANDS)[number];

function isPiSubcommand(token: string): token is PiSubcommand {
	return (PI_SUBCOMMANDS as readonly string[]).includes(token);
}

export interface ParsedLauncherArgs {
	link: boolean;
	isolated: boolean;
	home?: string;
	packageRoot?: string;
	help: boolean;
	version: boolean;
	command?: LauncherCommand;
	commandArgs: string[];
	passthrough: string[];
	// Set when the first passthrough token is one of PI_SUBCOMMANDS (e.g.
	// `gentle-shell install npm:x`). It stays part of `passthrough` — this
	// field only tells buildPiInvocation to skip its extension injection, so
	// pi sees the bare subcommand it expects as argv[0].
	piSubcommand?: PiSubcommand;
	error?: string;
}

// Home-subcommand parsing is deliberately shallow: `home` only counts as the
// subcommand when it is argv[0], and everything after it is handed over
// untouched as commandArgs — T2 owns interpreting `home link|isolated|<path>`.
export function parseLauncherArgs(argv: string[]): ParsedLauncherArgs {
	if (argv[0] === "home") {
		return {
			link: false,
			isolated: false,
			home: undefined,
			packageRoot: undefined,
			help: false,
			version: false,
			command: "home",
			commandArgs: argv.slice(1),
			passthrough: [],
			piSubcommand: undefined,
			error: undefined,
		};
	}

	let link = false;
	let isolated = false;
	let home: string | undefined;
	let packageRoot: string | undefined;
	let help = false;
	let version = false;
	let error: string | undefined;
	let command: LauncherCommand | undefined;
	let commandArgs: string[] = [];
	let piSubcommand: PiSubcommand | undefined;
	const passthrough: string[] = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") {
			const rest = argv.slice(i + 1);
			if (passthrough.length === 0 && rest.length > 0 && isPiSubcommand(rest[0])) {
				piSubcommand = rest[0];
			}
			passthrough.push(...rest);
			break;
		}
		if (arg === "--link") {
			link = true;
			continue;
		}
		if (arg === "--isolated") {
			isolated = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--version") {
			version = true;
			continue;
		}
		if (arg.startsWith("--home=")) {
			const value = arg.slice("--home=".length);
			if (value.length === 0) {
				error = "--home requires a non-empty path argument";
				continue;
			}
			home = value;
			continue;
		}
		if (arg === "--home") {
			const value = argv[i + 1];
			if (value === undefined || value.length === 0) {
				error = "--home requires a non-empty path argument";
				if (value !== undefined) i += 1;
				continue;
			}
			home = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--package-root=")) {
			const value = arg.slice("--package-root=".length);
			if (value.length === 0) {
				error = "--package-root requires a non-empty path argument";
				continue;
			}
			packageRoot = value;
			continue;
		}
		if (arg === "--package-root") {
			const value = argv[i + 1];
			if (value === undefined || value.length === 0) {
				error = "--package-root requires a non-empty path argument";
				if (value !== undefined) i += 1;
				continue;
			}
			packageRoot = value;
			i += 1;
			continue;
		}
		// Unlike `home`, `setup` is not restricted to argv[0]: it accepts the
		// home selectors (--link, --isolated, --home <dir>) ahead of it, same
		// as a pi subcommand would, so it provisions whichever home those
		// selectors resolve to. It is only recognised as the FIRST non-flag
		// token — once a pi subcommand (or any other passthrough token) has
		// already started, a later "setup" is just an ordinary passthrough
		// argument, same as "home" is.
		if (arg === "setup" && command === undefined && passthrough.length === 0) {
			command = "setup";
			commandArgs = argv.slice(i + 1);
			break;
		}
		if (passthrough.length === 0 && isPiSubcommand(arg)) {
			piSubcommand = arg;
		}
		passthrough.push(arg);
	}

	if (error === undefined) {
		if (link && isolated) {
			error = "--link cannot be combined with --isolated";
		} else if (link && home !== undefined) {
			error = "--link cannot be combined with --home";
		} else if (isolated && home !== undefined) {
			error = "--isolated cannot be combined with --home";
		}
	}

	return { link, isolated, home, packageRoot, help, version, command, commandArgs, passthrough, piSubcommand, error };
}

// --- home resolution -------------------------------------------------------

export type HomeMode = "link" | "isolated" | "path";
export type HomeSource = "flag" | "config" | "default";

export interface ResolvedHome {
	mode: HomeMode;
	dir: string;
	source: HomeSource;
}

// A discriminated union instead of a plain `home: string` field: `resolveHome`
// switches on `mode` rather than re-parsing the raw on-disk string, and the
// `path` case carries its `dir` explicitly so a "link"/"isolated" string can
// never be mistaken for a filesystem path at the call site.
export type LauncherConfig = { mode: "link" } | { mode: "isolated" } | { mode: "path"; dir: string };

export interface ResolveHomeInput {
	args: ParsedLauncherArgs;
	env: Record<string, string | undefined>;
	homedir: string;
	config: LauncherConfig | undefined;
}

// Pi Subagents resolves `PI_CODING_AGENT_DIR || ~/.pi/agent`; `--link` reuses
// that exact home so gentle-shell never diverges from the user's own pi.
function linkDir(env: Record<string, string | undefined>, homedir: string): string {
	return env.PI_CODING_AGENT_DIR || join(homedir, ".pi", "agent");
}

function isolatedDir(env: Record<string, string | undefined>, homedir: string): string {
	return env.GENTLE_SHELL_HOME || join(homedir, ".gentle-shell", "agent");
}

export function resolveHome(input: ResolveHomeInput): ResolvedHome {
	const { args, env, homedir, config } = input;

	if (args.link) return { mode: "link", dir: linkDir(env, homedir), source: "flag" };
	if (args.isolated) return { mode: "isolated", dir: isolatedDir(env, homedir), source: "flag" };
	if (args.home !== undefined) return { mode: "path", dir: args.home, source: "flag" };

	if (config !== undefined) {
		if (config.mode === "link") return { mode: "link", dir: linkDir(env, homedir), source: "config" };
		if (config.mode === "isolated") return { mode: "isolated", dir: isolatedDir(env, homedir), source: "config" };
		return { mode: "path", dir: config.dir, source: "config" };
	}

	return { mode: "isolated", dir: isolatedDir(env, homedir), source: "default" };
}

// The flags that reproduce `home`'s resolved mode on a later `gentle-shell
// <flags> ...` invocation — used by remediation messages (e.g. "run
// `gentle-shell <flags> remove <source>`") so they point at the exact home
// setup provisioned instead of silently defaulting to the isolated home.
// Mirrors the three ResolvedHome modes one-to-one: "link" needs --link
// (PI_CODING_AGENT_DIR-derived dirs aren't reproducible as a literal path),
// "path" needs its --home <dir>, and "isolated" needs nothing since it's
// gentle-shell's own default when no selector is given.
export function homeSelectorFlags(home: ResolvedHome): string[] {
	if (home.mode === "link") return ["--link"];
	if (home.mode === "path") return ["--home", home.dir];
	return [];
}

export function launcherConfigPath(homedir: string): string {
	return join(homedir, ".gentle-shell", "config.json");
}

// Tolerant on purpose: a malformed or foreign config.json must never crash
// the launcher, it just falls through to the default isolated home.
//
// The on-disk shape stays the flat `{ "home": "link" | "isolated" | "<path>" }`
// documented in the feature scope; only the parsed, in-memory `LauncherConfig`
// is a discriminated union. Any non-empty string other than the exact literals
// "link" or "isolated" is treated as a path, including a near-miss like
// "linked" — this is deliberate: there is no separate "unrecognised mode"
// error, a typo just resolves to a (probably nonexistent) path instead.
export function parseLauncherConfig(text: string): LauncherConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const home = (parsed as Record<string, unknown>).home;
	if (typeof home !== "string" || home.length === 0) return undefined;
	if (home === "link") return { mode: "link" };
	if (home === "isolated") return { mode: "isolated" };
	return { mode: "path", dir: home };
}

// --- provisioning marker (S7 auto-provision) --------------------------------

// Raw config.json shape as actually stored on disk: a plain object that may
// carry `home` (see LauncherConfig above), `provisioned`, and any other key
// a future feature adds. Unlike parseLauncherConfig's discriminated
// LauncherConfig, these helpers operate on (and return) the whole object so
// a write never drops a field it does not itself understand — notably
// another home's provisioned marker when `gentle-shell home ...` persists a
// mode change.
export type RawLauncherConfig = Record<string, unknown>;

// Tolerant like parseLauncherConfig: a missing, malformed, or foreign
// config.json resolves to an empty object rather than throwing, so a caller
// can always merge into (and write back) whatever it finds.
export function parseRawLauncherConfig(text: string | undefined): RawLauncherConfig {
	if (text === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	return parsed as RawLauncherConfig;
}

export interface ProvisionedEntry {
	gentleAi: string;
	// Optional: a marker written before gentle-pi version tracking (S8) has
	// no `gentlePi` field at all. needsProvisioning below treats that
	// omission as "needs provisioning" rather than trusting or crashing on it.
	gentlePi?: string;
	at: string;
}

function isProvisionedEntry(value: unknown): value is ProvisionedEntry {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.gentleAi !== "string" || typeof record.at !== "string") return false;
	return record.gentlePi === undefined || typeof record.gentlePi === "string";
}

// Tolerant read of config.provisioned: a missing, non-object, or malformed
// map (or a malformed individual entry) is dropped rather than thrown, same
// tolerance policy as parseLauncherConfig above.
function provisionedMap(config: RawLauncherConfig): Record<string, ProvisionedEntry> {
	const value = config.provisioned;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const map: Record<string, ProvisionedEntry> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (isProvisionedEntry(entry)) map[key] = entry;
	}
	return map;
}

// The provisioning record for `homeDir` (the caller passes a realpath, so
// two different-looking paths to the same home never diverge), or undefined
// when that home has never been auto- or manually provisioned.
export function provisionedEntry(config: RawLauncherConfig, homeDir: string): ProvisionedEntry | undefined {
	return provisionedMap(config)[homeDir];
}

// True when `homeDir` has never been provisioned, was provisioned with a
// gentle-ai pin other than `pin`, or was provisioned against a gentle-pi
// other than `gentlePiVersion` (the running launcher's own version, from its
// package.json) — the signal bin/gentle-shell.mjs uses to decide whether a
// plain launch should run the setup flow automatically before starting pi.
// A marker written before gentle-pi version tracking existed has no
// `gentlePi` field, which never strictly-equals a real version string, so it
// always counts as needing provisioning too — see ProvisionedEntry above.
export function needsProvisioning(config: RawLauncherConfig, homeDir: string, pin: string, gentlePiVersion: string): boolean {
	const entry = provisionedEntry(config, homeDir);
	return entry === undefined || entry.gentleAi !== pin || entry.gentlePi !== gentlePiVersion;
}

// Returns a new config object recording `homeDir` as provisioned at `pin`
// and `gentlePiVersion`, preserving every other key — including every other
// home's provisioned entry — unchanged. Never mutates `config`.
export function recordProvisioned(config: RawLauncherConfig, homeDir: string, pin: string, gentlePiVersion: string, now: string): RawLauncherConfig {
	return { ...config, provisioned: { ...provisionedMap(config), [homeDir]: { gentleAi: pin, gentlePi: gentlePiVersion, at: now } } };
}

// --- pi runtime resolution ---------------------------------------------------

export type PiRuntimeKind = "env" | "bundled" | "path";

export interface PiRuntime {
	kind: PiRuntimeKind;
	command: string;
	args: string[];
}

export interface PiRuntimeDeps {
	env: Record<string, string | undefined>;
	resolveBundledCli: () => string | undefined;
	findOnPath: (name: string) => string | undefined;
	nodeExecPath: string;
}

export function resolvePiRuntime(deps: PiRuntimeDeps): PiRuntime | undefined {
	const envOverride = deps.env.GENTLE_SHELL_PI;
	if (envOverride !== undefined && envOverride.length > 0) return { kind: "env", command: envOverride, args: [] };

	const bundledCliPath = deps.resolveBundledCli();
	if (bundledCliPath !== undefined) return { kind: "bundled", command: deps.nodeExecPath, args: [bundledCliPath] };

	const onPath = deps.findOnPath("pi");
	if (onPath !== undefined) return { kind: "path", command: onPath, args: [] };

	return undefined;
}

export function missingPiMessage(): string {
	return [
		"No pi runtime could be found. Pick one of:",
		"  - Set GENTLE_SHELL_PI to the path of a pi executable.",
		"  - Install @earendil-works/pi-coding-agent next to gentle-pi (it ships as an optional peer dependency).",
		"  - Install pi and make sure it is on your PATH.",
	].join("\n");
}

// --- pi version gate ---------------------------------------------------------

export const MIN_PI_VERSION = "0.85.1";

export type PiVersionCheck = { ok: true; version: string } | { ok: false; message: string; version?: string };

const VERSION_PATTERN = /v?(\d+)\.(\d+)\.(\d+)/;

function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	for (let i = 0; i < 3; i += 1) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

export function checkPiVersion(output: string, minimum: string = MIN_PI_VERSION): PiVersionCheck {
	const match = VERSION_PATTERN.exec(output);
	if (!match) {
		return { ok: false, message: `Could not determine the pi version from "${output.trim()}" (need at least ${minimum}).` };
	}
	const version = `${match[1]}.${match[2]}.${match[3]}`;
	const minimumMatch = VERSION_PATTERN.exec(minimum);
	if (!minimumMatch) throw new Error(`invalid minimum version "${minimum}"`);
	const found: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const wanted: [number, number, number] = [Number(minimumMatch[1]), Number(minimumMatch[2]), Number(minimumMatch[3])];
	if (compareVersions(found, wanted) < 0) {
		return { ok: false, version, message: `pi version ${version} is older than the required minimum ${minimum}.` };
	}
	return { ok: true, version };
}

// --- setup subcommand's gentle-ai pin gate -----------------------------------

// The first gentle-ai release that honors PI_CODING_AGENT_DIR in its own
// `install --agent pi` provisioning. `gentle-shell setup` spawns the
// package-local pinned gentle-ai with PI_CODING_AGENT_DIR set to the
// resolved home; an older pin ignores that variable and silently provisions
// the caller's real ~/.pi/agent instead, so setup must refuse to run it.
export const MIN_SETUP_GENTLE_AI_VERSION = "3.6.0";

export function isSetupCapablePin(version: string, minimum: string = MIN_SETUP_GENTLE_AI_VERSION): boolean {
	const match = VERSION_PATTERN.exec(version);
	if (!match) return false;
	const minimumMatch = VERSION_PATTERN.exec(minimum);
	if (!minimumMatch) throw new Error(`invalid minimum version "${minimum}"`);
	const found: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const wanted: [number, number, number] = [Number(minimumMatch[1]), Number(minimumMatch[2]), Number(minimumMatch[3])];
	return compareVersions(found, wanted) >= 0;
}

// --- packaging drift guard -----------------------------------------------------

export interface PackageJsonPeerShape {
	peerDependencies?: Record<string, string>;
}

export type PeerVersionPinCheck = { ok: true; pinned: string } | { ok: false; message: string };

// Keeps the MIN_PI_VERSION drift-guard test's failure readable: a missing
// peerDependencies block, a missing peer entry, or a malformed range must
// fail with a clear assertion message, not a raw TypeError from indexing an
// undefined value the way a direct `packageJson.peerDependencies[peerName]`
// lookup would.
export function checkPeerVersionPin(packageJson: PackageJsonPeerShape, peerName: string, minVersion: string): PeerVersionPinCheck {
	const peerDependencies = packageJson.peerDependencies;
	if (peerDependencies === undefined) {
		return { ok: false, message: "package.json is missing a peerDependencies block" };
	}
	const pinned = peerDependencies[peerName];
	if (typeof pinned !== "string") {
		return { ok: false, message: `package.json peerDependencies is missing "${peerName}"` };
	}
	if (!/^>=\d+\.\d+\.\d+$/.test(pinned)) {
		return { ok: false, message: `package.json peerDependencies["${peerName}"] ("${pinned}") is not a simple >=x.y.z range` };
	}
	const version = pinned.replace(/^>=/, "");
	if (version !== minVersion) {
		return { ok: false, message: `MIN_PI_VERSION ("${minVersion}") does not match the pinned peer range ("${pinned}")` };
	}
	return { ok: true, pinned };
}

// --- settings.json package declaration detection --------------------------

// Matches the raw git URL forms pi accepts without a `git:` prefix.
const GIT_URL_PATTERN = /^(?:https?|ssh|git):\/\//;

function entrySource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry !== null && typeof entry === "object") {
		const source = (entry as Record<string, unknown>).source;
		if (typeof source === "string") return source;
	}
	return undefined;
}

export type PackageSourceKind = "npm" | "git" | "path";

// A settings `packages` entry is npm- or git-sourced only via an explicit
// `npm:`/`git:` prefix or a bare git URL; every other source (relative or
// absolute) is a local path, per pi's own package-source rules.
export function packageSourceKind(source: string): PackageSourceKind {
	if (source.startsWith("npm:")) return "npm";
	if (source.startsWith("git:")) return "git";
	if (GIT_URL_PATTERN.test(source)) return "git";
	return "path";
}

function npmSourceDeclaresGentlePi(source: string): boolean {
	return source === "npm:gentle-pi" || source.startsWith("npm:gentle-pi@");
}

// npm:<name> or npm:<name>@<version>, tolerating a scoped `@scope/name`: only
// the first `@` *after* the leading scope marker starts a version suffix.
function npmPackageName(source: string): string {
	const spec = source.slice("npm:".length);
	if (spec.startsWith("@")) {
		const versionAt = spec.indexOf("@", 1);
		return versionAt === -1 ? spec : spec.slice(0, versionAt);
	}
	const versionAt = spec.indexOf("@");
	return versionAt === -1 ? spec : spec.slice(0, versionAt);
}

function parseSettingsPackages(settingsText: string | undefined): unknown[] | undefined {
	if (settingsText === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(settingsText);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const packages = (parsed as Record<string, unknown>).packages;
	return Array.isArray(packages) ? packages : undefined;
}

function packageEntryDeclaresGentlePi(entry: unknown): boolean {
	const source = entrySource(entry);
	return source !== undefined && packageSourceKind(source) === "npm" && npmSourceDeclaresGentlePi(source);
}

// Deprecated: recognises only an `npm:gentle-pi` declaration. Kept as a thin
// compatibility wrapper over the pre-existing behaviour for any caller that
// only cares about the npm case; findGentlePiDeclaration below also detects
// a path package whose own package.json names it "gentle-pi".
export function settingsDeclareGentlePi(settingsText: string | undefined): boolean {
	const packages = parseSettingsPackages(settingsText);
	if (packages === undefined) return false;
	return packages.some(packageEntryDeclaresGentlePi);
}

// gentle-ai's own managed Pi stack still installs
// npm:@juicesharp/rpiv-ask-user-question, which conflicts with gentle-pi's
// first-party ask_user_question tool: Pi tool names are exclusive, so a
// second provider for the same name fails the whole load (see
// extensions/ask-user-question.ts). Tracked upstream as gentle-ai #4820 and
// gentle-shell #1277; the gentle-ai fix lands separately, so `gentle-shell
// setup` (bin/gentle-shell.mjs) must remove it from the provisioned home
// itself.
//
// gentle-ai's managed Pi stack also always declares npm:gentle-pi itself.
// That declaration must never survive setup either, for an unrelated reason:
// this launcher always loads its own gentle-pi (its own package root, or a
// take-over), never the one gentle-ai's stack installs, so leaving the
// declaration in place would silently let the home drift onto whatever
// gentle-pi npm last installed — or, for a developer running from a source
// checkout, onto the published npm package — instead of the running
// launcher's own copy. See docs/readme-reference.md's "setup" section.
//
// Table of every package `setup` removes after gentle-ai finishes, so a
// future addition only needs a new row here.
const POST_INSTALL_REMOVAL_PACKAGES: readonly { readonly name: string; readonly source: string }[] = [
	{ name: "@juicesharp/rpiv-ask-user-question", source: "npm:@juicesharp/rpiv-ask-user-question" },
	{ name: "gentle-pi", source: "npm:gentle-pi" },
];

// The known removal sources, exposed so a `--dry-run` caller can report what
// setup would remove *if* gentle-ai's install declares it, without reading
// settings.json itself: a dry run writes nothing, so settings.json
// afterwards would only reflect whatever pre-existed the run, not what the
// (skipped) install would have declared. See runPostInstallCleanup in
// bin/gentle-shell.mjs.
export const POST_INSTALL_REMOVAL_SOURCES: readonly string[] = POST_INSTALL_REMOVAL_PACKAGES.map((entry) => entry.source);

// Scans a settings.json `packages` list (same string/object-source parsing
// as settingsDeclareGentlePi/findGentlePiDeclaration above) for any entry
// whose npm package name matches POST_INSTALL_REMOVAL_PACKAGES, at any
// version spec. Returns each match's canonical unversioned source, deduped,
// in the order those packages first appear in `packages` — never the
// declared (possibly versioned) source text, since the caller always removes
// the bare package.
export function postInstallRemovals(settingsText: string | undefined): string[] {
	const packages = parseSettingsPackages(settingsText);
	if (packages === undefined) return [];

	const found: string[] = [];
	for (const entry of packages) {
		const source = entrySource(entry);
		if (source === undefined || packageSourceKind(source) !== "npm") continue;
		const name = npmPackageName(source);
		const match = POST_INSTALL_REMOVAL_PACKAGES.find((candidate) => candidate.name === name);
		if (match !== undefined && !found.includes(match.source)) found.push(match.source);
	}
	return found;
}

export type GentlePiDeclaration = { kind: "npm" } | { kind: "path"; dir: string };

export interface FindGentlePiDeclarationOptions {
	agentDir: string;
	// Injected fs reader: returns <dir>/package.json's "name" field, or
	// undefined when the file is missing, unreadable, or has no string name.
	readPackageName: (dir: string) => string | undefined;
}

// Detects a settings.json `packages` entry that already loads gentle-pi,
// either as `npm:gentle-pi[@version]` or as a local path (string or object
// `source`) whose own package.json declares `"name": "gentle-pi"`. Path
// entries are resolved relative to `opts.agentDir`, matching how pi itself
// resolves a settings-relative local path.
export function findGentlePiDeclaration(settingsText: string | undefined, opts: FindGentlePiDeclarationOptions): GentlePiDeclaration | undefined {
	const packages = parseSettingsPackages(settingsText);
	if (packages === undefined) return undefined;

	for (const entry of packages) {
		const source = entrySource(entry);
		if (source === undefined) continue;
		const kind = packageSourceKind(source);
		if (kind === "npm" && npmSourceDeclaresGentlePi(source)) return { kind: "npm" };
		if (kind === "path") {
			const dir = resolvePath(opts.agentDir, source);
			if (opts.readPackageName(dir) === "gentle-pi") return { kind: "path", dir };
		}
	}
	return undefined;
}

// --- take-over decision ---------------------------------------------------

export interface DecideTakeOverInput {
	declaration: GentlePiDeclaration | undefined;
	realPackageRoot: string;
	// realpath of the declared path dir, when declaration.kind === "path".
	// Falls back to the raw declared dir when the caller could not realpath
	// it (for example the directory does not exist).
	realDeclaredDir?: string;
	// True when the user passed --package-root explicitly: forces a
	// take-over even for a matching npm declaration, so a different
	// checkout can always be tested on demand.
	packageRootExplicit: boolean;
}

export function decideTakeOver(input: DecideTakeOverInput): boolean {
	if (input.packageRootExplicit) return true;
	if (input.declaration === undefined) return false;
	if (input.declaration.kind === "npm") return false;
	const realDeclaredDir = input.realDeclaredDir ?? input.declaration.dir;
	return realDeclaredDir !== input.realPackageRoot;
}

// --- other-package injection planning --------------------------------------

export interface OtherPackageInjectionsInput {
	settingsText: string | undefined;
	agentDir: string;
	// The gentle-pi declaration being taken over: its own entry is excluded
	// from the result, since it is injected separately as the launcher's
	// own packageRoot.
	skip: GentlePiDeclaration;
	// Existence check for each resolved package directory, injected so this
	// function stays pure and unit-testable without a real filesystem. A
	// declared package whose directory does not exist (a hand-edited
	// settings.json, a failed or interrupted `pi install`, or an npm store
	// laid out somewhere other than <agentDir>/npm/node_modules) is skipped
	// with a warning instead of being handed to pi as an unresolvable `-e`,
	// which pi's module loader fails on with "Cannot find module" (R3-001).
	// Defaults to always-true so a caller that only cares about the pure
	// string resolution (most existing unit tests) does not need to supply
	// a filesystem stub.
	isDirectory?: (dir: string) => boolean;
	// Realpath resolver applied to a settings path entry's resolved
	// directory before comparing it against `skip`. bin/gentle-shell.mjs's
	// --package-root take-over passes `skip.dir` as an already-realpath'd
	// directory; without also realpath'ing the settings entry here, a
	// settings path entry reaching that same physical directory through a
	// symlink is not recognised as the package being taken over and gets
	// re-injected as a second, redundant -e for it
	// (R4-forced-root-symlink-double-injection). Defaults to identity so
	// this function stays pure and existing callers keep comparing raw
	// strings.
	realpath?: (dir: string) => string;
}

export interface OtherPackageInjections {
	paths: string[];
	warnings: string[];
}

function entryFilterKeys(entry: unknown): string[] {
	if (entry === null || typeof entry !== "object") return [];
	const record = entry as Record<string, unknown>;
	const keys: string[] = [];
	if ("extensions" in record) keys.push("extensions");
	if ("autoload" in record) keys.push("autoload");
	return keys;
}

// Plans the `-e <dir>` flags a take-over must add for every OTHER settings
// package once `--no-extensions` drops normal settings-driven extension
// discovery. git-sourced packages are skipped (their install directory is
// not derivable without pi's own package manager) with a warning; object
// entries carrying `extensions`/`autoload` filters are still included, with
// a warning that the take-over cannot honour those filters (their skills,
// prompts, and themes still load through ordinary settings discovery, which
// --no-extensions does not affect).
export function otherPackageInjections(input: OtherPackageInjectionsInput): OtherPackageInjections {
	const paths: string[] = [];
	const warnings: string[] = [];
	const packages = parseSettingsPackages(input.settingsText);
	if (packages === undefined) return { paths, warnings };
	const isDirectory = input.isDirectory ?? (() => true);
	const realpath = input.realpath ?? ((dir: string) => dir);

	for (const entry of packages) {
		const source = entrySource(entry);
		if (source === undefined) continue;
		const kind = packageSourceKind(source);

		// Skip every gentle-pi entry unconditionally, not only the one
		// matching `skip`'s kind: settings can carry more than one gentle-pi
		// declaration (for example an npm:gentle-pi entry alongside the path
		// declaration actually being taken over), and re-injecting any of
		// them as an "other package" would double-load gentle-pi extensions.
		if (kind === "npm" && npmSourceDeclaresGentlePi(source)) continue;
		if (kind === "path") {
			const dir = resolvePath(input.agentDir, source);
			// Compared through realpath on BOTH sides (not the raw resolved
			// strings): skip.dir may already be a realpath itself
			// (bin/gentle-shell.mjs's --package-root take-over) or may not be
			// (a plain settings.json declaration), so only comparing one side
			// through realpath would break whichever case does not match that
			// assumption. Realpath'ing both keeps the exact-match case
			// (skip.dir derived from the very same source) trivially correct
			// while also recognising a settings entry that reaches the same
			// physical directory as skip through a symlink.
			if (input.skip.kind === "path" && realpath(dir) === realpath(input.skip.dir)) continue;
		}

		if (kind === "git") {
			warnings.push(
				`gentle-shell: skipping git-sourced package "${source}" during takeover (its install directory is not derivable without pi's own package manager).`,
			);
			continue;
		}

		const filters = entryFilterKeys(entry);
		if (filters.length > 0) {
			warnings.push(
				`gentle-shell: package "${source}" has ${filters.join("/")} filters that this takeover cannot honour for extensions; its skills, prompts, and themes still load through settings discovery.`,
			);
		}

		const dir = kind === "npm" ? join(input.agentDir, "npm", "node_modules", npmPackageName(source)) : resolvePath(input.agentDir, source);
		if (!isDirectory(dir)) {
			warnings.push(`gentle-shell: skipping declared package "${source}": ${dir} is not a directory`);
			continue;
		}
		paths.push(dir);
	}
	return { paths, warnings };
}

// --- loose extension discovery ----------------------------------------------

export interface LooseExtensionFsEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

export interface LooseExtensionFs {
	// Lists dir's direct children with cheap type info per entry. A throwing
	// readdir (missing or unreadable dir) is treated the same as an empty
	// directory by discoverLooseExtensionEntries.
	readdir: (dir: string) => LooseExtensionFsEntry[];
	// Existence check used only for a child subdirectory's index.ts/index.js.
	exists: (path: string) => boolean;
}

// scripts/build-runtime-modules.mjs rewrites every occurrence of a dot, the
// letters ts, and an immediately following closing quote (single or double)
// to end in mjs instead, when it generates runtime/gentle-shell-launcher.mjs
// — a plain `.replace(/\.ts(["'])/g, ...)` that cannot tell an import
// specifier from an ordinary string literal. Any other string ending the
// same way — a dot, the letters ts, and a closing quote right after — would
// get silently corrupted into the mjs form in the generated runtime module,
// so the three constants below are built by concatenation instead of
// written as literals that would trigger the same rewrite.
const TS_EXTENSION = `.t${"s"}`;
const INDEX_TS_FILENAME = `index${TS_EXTENSION}`;
const DECLARATION_FILE_SUFFIX = `.d${TS_EXTENSION}`;
const LOOSE_EXTENSION_FILE_PATTERN = /\.(?:ts|js|mjs)$/;

function isLooseExtensionFile(name: string): boolean {
	if (name.startsWith(".")) return false;
	if (name.endsWith(DECLARATION_FILE_SUFFIX)) return false;
	return LOOSE_EXTENSION_FILE_PATTERN.test(name);
}

// Mirrors pi's own discoverExtensionsInDir (packages/coding-agent/src/core/
// extensions/loader.ts): direct *.ts/*.js/*.mjs files, plus <subdir>/index.ts
// (falling back to <subdir>/index.js) for a child directory that has one. No
// recursion beyond that one level, matching pi's own rule that a more complex
// nested package must use a package.json manifest instead.
//
// Unlike pi's own scan, hidden entries (dotfiles, and hidden subdirectories)
// and *.d.ts files are deliberately excluded here: pi's `-e <file>` flag hands
// the path straight to its module loader with no directory-discovery pass of
// its own (see buildPiInvocation's takeOver branch), so a hidden file or a
// type-only declaration file was never a runnable extension and would only
// surface a confusing "Cannot find module"/empty-module error once injected.
//
// Returns already-resolved absolute file paths, sorted by name so the result
// (and therefore -e ordering) does not depend on the host filesystem's
// unspecified readdir order.
export function discoverLooseExtensionEntries(dir: string, fs: LooseExtensionFs): string[] {
	let entries: LooseExtensionFsEntry[];
	try {
		entries = fs.readdir(dir);
	} catch {
		return [];
	}

	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	const discovered: string[] = [];

	for (const entry of sorted) {
		if (entry.name.startsWith(".")) continue;

		if (entry.isFile) {
			if (isLooseExtensionFile(entry.name)) discovered.push(join(dir, entry.name));
			continue;
		}

		if (!entry.isDirectory) continue;
		const childDir = join(dir, entry.name);
		const indexTs = join(childDir, INDEX_TS_FILENAME);
		const indexJs = join(childDir, "index.js");
		if (fs.exists(indexTs)) discovered.push(indexTs);
		else if (fs.exists(indexJs)) discovered.push(indexJs);
	}

	return discovered;
}

// --- pi invocation builder ---------------------------------------------------

export interface BuildPiInvocationInput {
	runtime: PiRuntime;
	home: ResolvedHome;
	packageRoot: string;
	declaration: GentlePiDeclaration | undefined;
	// True when the target settings already declare a *different* gentle-pi
	// than this launcher's own packageRoot (or --package-root forces it):
	// the launcher takes over the pi invocation instead of deferring to the
	// declared package.
	takeOver: boolean;
	// Directories for every OTHER settings package, from otherPackageInjections.
	// Only consulted when takeOver is true.
	otherPackagePaths: string[];
	// Already-resolved loose extension FILE paths (never directories) that
	// normal pi discovery would otherwise have picked up from
	// <agentDir>/extensions and the project-local <cwd>/.pi/extensions before
	// --no-extensions drops that discovery — see discoverLooseExtensionEntries.
	// Only consulted when takeOver is true. The caller resolves the actual
	// file list per candidate directory (or, when a candidate directory is
	// itself a self-contained extension — its own index.ts/index.js, or a
	// pi package manifest at its root — passes that directory through
	// unchanged instead, since pi's own module loader resolves that case
	// directly).
	looseExtensionEntries?: string[];
	passthrough: string[];
	// Set when parseLauncherArgs recognised passthrough[0] as one of
	// PI_SUBCOMMANDS. pi dispatches install/remove/uninstall/update/list/
	// config/auth on argv[0] before its own flag parsing, so none of the
	// gentle-pi extension injection below may precede it.
	piSubcommand?: PiSubcommand;
	baseEnv: Record<string, string | undefined>;
}

export interface PiInvocation {
	command: string;
	args: string[];
	env: Record<string, string | undefined>;
}


// Four cases, checked in this order — `piSubcommand` first, then `takeOver`:
//   - piSubcommand: pi dispatches install/remove/uninstall/update/list/
//     config/auth on argv[0] before it even parses flags, so any injected
//     -e flag ahead of it stops pi from
//     recognising its subcommand at all — this is exactly the observed
//     2026-09-22 bug where `gentle-shell install npm:x` opened an
//     interactive pi session instead of running the package manager. No
//     injection of any kind (including a take-over's --no-extensions and
//     other-package/loose-extension -e flags) may precede it.
//   - takeOver: the target settings declare a *different* gentle-pi, or
//     --package-root forced a takeover regardless of any declaration. This
//     must win over the next two cases even when there is no declaration to
//     report, or the plain branch would silently drop --no-extensions and
//     the other-package injections while bin/gentle-shell.mjs still prints
//     the "taking over" message. `--no-extensions` drops normal
//     settings-driven extension discovery, so it is replaced by an explicit
//     `-e <dir>` for every OTHER settings package (skills/prompts/themes
//     for those packages still load through ordinary settings discovery,
//     which --no-extensions does not affect), then an explicit `-e <file>`
//     for every loose extension entry normal discovery would otherwise have
//     found under <agentDir>/extensions and the project-local
//     .pi/extensions, and finally this launcher's own packageRoot injected
//     last so it wins any conflict. Every -e path is injected at most once
//     (R3-001): a loose entry that duplicates an other-package path, or
//     repeats within looseExtensionEntries itself, is skipped rather than
//     loaded twice.
//   - Not takeOver, no declaration: inject this launcher's own packageRoot
//     once via -e; Pi discovers its extensions, skills, prompts and themes,
//     exactly as when nothing else in settings loads gentle-pi.
//   - Not takeOver, with a declaration: no injection at all — the target
//     settings already load a gentle-pi the launcher accepts as-is (the
//     `--link` case with a pi-managed install matching this launcher).
export function buildPiInvocation(input: BuildPiInvocationInput): PiInvocation {
	const args = [...input.runtime.args];

	if (input.piSubcommand !== undefined) {
		// No injection at all: pi must see the bare subcommand as argv[0].
	} else if (input.takeOver) {
		args.push("--no-extensions");
		const injected = new Set<string>();
		for (const otherPath of input.otherPackagePaths) {
			if (injected.has(otherPath)) continue;
			injected.add(otherPath);
			args.push("-e", otherPath);
		}
		for (const entry of input.looseExtensionEntries ?? []) {
			if (injected.has(entry)) continue;
			injected.add(entry);
			args.push("-e", entry);
		}
		// R3-003: the launcher's own package root must also be checked
		// against the dedupe set instead of being appended unconditionally,
		// or a settings package/loose entry that resolves to the same
		// directory as --package-root would be injected twice.
		if (!injected.has(input.packageRoot)) {
			injected.add(input.packageRoot);
			args.push("-e", input.packageRoot);
		}

	} else if (input.declaration === undefined) {
		args.push("-e", input.packageRoot);
	}

	args.push(...input.passthrough);

	return {
		command: input.runtime.command,
		args,
		env: { ...input.baseEnv, PI_CODING_AGENT_DIR: input.home.dir, GENTLE_PI_AGENT_HOME: input.home.dir },
	};
}

// --- spawn planning ------------------------------------------------------------

// R3-001: `findOnPath` can resolve a PATHEXT candidate such as a .CMD or .BAT
// shim on win32 (exactly how an npm-installed `pi` lands on PATH), and a
// GENTLE_SHELL_PI override can point at one too. Current Node releases refuse
// to spawn a batch file directly without `shell: true` (EINVAL), so both the
// version probe and the real launch route a batch shim through cmd.exe as one
// quoted command line instead of spawning it directly.
const CMD_EXE_SPECIAL_CHARS = /[\s"&|<>^%()]/;

// cmd.exe quoting is deliberately simple, not a full cmd.exe parser: wrap a
// token in double quotes when it is empty or contains whitespace or any of
// `"&|<>^%()`, and escape an inner `"` as `\"` — doubling inner quotes is not
// reliable in cmd.exe, unlike the `\"` convention Node's own Windows spawn
// helpers use.
export function quoteForCmdExe(token: string): string {
	if (token.length > 0 && !CMD_EXE_SPECIAL_CHARS.test(token)) return token;
	return `"${token.replace(/"/g, '\\"')}"`;
}

const POSIX_SHELL_SPECIAL_CHARS = /[\s"'`\\$&|;<>(){}*?[\]!#~]/;

// POSIX/bash single-quote shell quoting for a copy-pasteable command
// bin/gentle-shell.mjs prints to stderr (e.g. the setup remediation
// command): wraps a token in single quotes when it is empty or contains
// whitespace or a shell metacharacter, escaping an embedded single quote as
// `'\''` (close quote, escaped literal quote, reopen quote) — inside single
// quotes nothing else needs escaping, unlike cmd.exe's `"`-based quoting
// (quoteForCmdExe above).
export function shellQuote(value: string): string {
	if (value.length > 0 && !POSIX_SHELL_SPECIAL_CHARS.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface PlanSpawnInput {
	command: string;
	args: string[];
	platform: NodeJS.Platform;
}

export interface SpawnPlan {
	command: string;
	args: string[];
	shell: boolean;
}

export function planSpawn(input: PlanSpawnInput): SpawnPlan {
	const { command, args, platform } = input;
	if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
		return { command: [command, ...args].map(quoteForCmdExe).join(" "), args: [], shell: true };
	}
	return { command, args, shell: false };
}

// --- JSON field restore --------------------------------------------------

// Detects the indentation unit and trailing-newline presence of a JSON text,
// so restoreJsonField below can re-serialize as close to the original
// formatting as practical instead of imposing its own. `indent` is
// `undefined` for compact (no-whitespace) JSON, matching what
// `JSON.stringify(value)` (no third argument) produces.
function detectJsonFormatting(text: string): { indent: string | undefined; trailingNewline: boolean } {
	const match = text.match(/\{\r?\n([ \t]+)/);
	return { indent: match ? match[1] : undefined, trailingNewline: text.endsWith("\n") };
}

function jsonValuesEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// Pure JSON merge: restores `field` in `currentText` back to whatever it was
// in `originalText`, keeping every other field exactly as `currentText` left
// it, and formatting the result to match `originalText`'s indentation and
// trailing newline. Used by bin/gentle-shell.mjs's setup flow to restore
// `managed_asset_digest` in the user's shared `~/.gentle-ai/state.json` after
// the pinned gentle-ai spawn rewrites it (the same shared-file problem
// persona.json has — see sharedPersonaPath/snapshotFile/restoreFile in
// bin/gentle-shell.mjs — but state.json also carries fields the pinned
// gentle-ai is supposed to update, like installed_agents, so this restores
// only the one field instead of the whole file).
//
// Returns the new text, or `undefined` when either text fails to parse as a
// JSON object, or the field's presence and value are already identical on
// both sides (nothing to restore). Never called by the caller when
// `originalText` comes from a file that did not exist before the spawn —
// there is nothing to restore a nonexistent file back to.
export function restoreJsonField(originalText: string, currentText: string, field: string): string | undefined {
	let originalValue: unknown;
	let currentValue: unknown;
	try {
		originalValue = JSON.parse(originalText);
		currentValue = JSON.parse(currentText);
	} catch {
		return undefined;
	}
	if (
		typeof originalValue !== "object" ||
		originalValue === null ||
		Array.isArray(originalValue) ||
		typeof currentValue !== "object" ||
		currentValue === null ||
		Array.isArray(currentValue)
	) {
		return undefined;
	}
	const originalObj = originalValue as Record<string, unknown>;
	const currentObj = currentValue as Record<string, unknown>;
	const hadField = Object.prototype.hasOwnProperty.call(originalObj, field);
	const hasFieldNow = Object.prototype.hasOwnProperty.call(currentObj, field);
	const unchanged = hadField === hasFieldNow && (!hadField || jsonValuesEqual(originalObj[field], currentObj[field]));
	if (unchanged) return undefined;

	let restored: Record<string, unknown>;
	if (hadField) {
		restored = { ...currentObj, [field]: originalObj[field] };
	} else {
		restored = { ...currentObj };
		delete restored[field];
	}

	const { indent, trailingNewline } = detectJsonFormatting(originalText);
	const serialized = JSON.stringify(restored, null, indent);
	return trailingNewline ? `${serialized}\n` : serialized;
}

// Pure JSON merge: forces `field` in `currentText` to `value`, but only when
// `originalText` (the state from before whatever wrote `currentText`) did not
// declare that field at all — never overriding a value the original already
// had, in either direction. Keeps every other field exactly as `currentText`
// left it, and formats the result to match `currentText`'s own indentation
// and trailing newline (unlike restoreJsonField above, which matches the
// *original*'s formatting — here `currentText` is what the other writer just
// produced, so its own convention is respected instead of imposed on).
// Used by bin/gentle-shell.mjs's setup flow so a home gentle-shell provisions
// ends up with the maintainer's default theme unless the home (or the user)
// already had an opinion about it, even when gentle-ai's own managed install
// writes a *different* default theme into settings.json.
//
// Returns the new text, or `undefined` when either text fails to parse as a
// JSON object, the original text already declared `field` (nothing to
// force), or the current value already equals `value` (nothing to change).
export function forceJsonFieldIfAbsentInOriginal(originalText: string, currentText: string, field: string, value: unknown): string | undefined {
	let originalValue: unknown;
	let currentValue: unknown;
	try {
		originalValue = JSON.parse(originalText);
		currentValue = JSON.parse(currentText);
	} catch {
		return undefined;
	}
	if (typeof originalValue !== "object" || originalValue === null || Array.isArray(originalValue)) return undefined;
	if (typeof currentValue !== "object" || currentValue === null || Array.isArray(currentValue)) return undefined;
	const originalObj = originalValue as Record<string, unknown>;
	const currentObj = currentValue as Record<string, unknown>;
	if (Object.prototype.hasOwnProperty.call(originalObj, field)) return undefined;
	if (jsonValuesEqual(currentObj[field], value)) return undefined;

	const forced = { ...currentObj, [field]: value };
	const { indent, trailingNewline } = detectJsonFormatting(currentText);
	const serialized = JSON.stringify(forced, null, indent);
	return trailingNewline ? `${serialized}\n` : serialized;
}

// --- reporting ---------------------------------------------------------------

export interface DescribeVersionInput {
	gentlePiVersion: string;
	piVersion: string | undefined;
	home: ResolvedHome;
}

export function describeVersion(input: DescribeVersionInput): string {
	return [
		`gentle-shell ${input.gentlePiVersion}`,
		`pi ${input.piVersion ?? "not found"}`,
		`home ${input.home.mode} ${input.home.dir}`,
	].join("\n");
}

export function helpText(): string {
	return [
		"Usage: gentle-shell [options] [-- pi-args...]",
		"       gentle-shell home [link|isolated|<path>]",
		"       gentle-shell [home selectors] setup [--dry-run]",
		"",
		"Opens pi with the Gentle Shell package loaded, without touching your",
		"vanilla pi installation.",
		"",
		"Options:",
		"  --link           Use your existing pi agent home (never edits its settings.json).",
		"  --isolated       Use the dedicated ~/.gentle-shell/agent home (default).",
		"  --home <path>    Use a custom agent home directory.",
		"  --package-root <dir>  Force this directory as the gentle-pi package to load, taking over",
		"                        from any conflicting package the target settings.json already declares.",
		"  --help, -h       Show this help text.",
		"  --version        Show gentle-shell, pi, and home version information.",
		"",
		"Commands:",
		"  home             Print or persist the effective home mode (link, isolated, or a path).",
		"  setup            Provision the resolved home with the gentle-ai companion packages",
		"                   (runs the package-local gentle-ai 'install --agent pi --scope global').",
		"                   Accepts --dry-run, forwarded to gentle-ai. Accepts a home selector",
		"                   (--link, --isolated, --home <dir>) before it.",
		"",
		"Managing packages:",
		"  gentle-shell install npm:<pkg>   Run pi's own 'install' against the resolved home.",
		"  gentle-shell remove <source>     Run pi's own 'remove' against the resolved home.",
		"  gentle-shell list                Run pi's own 'list' against the resolved home.",
		"  gentle-shell update [target]     Run pi's own 'update' against the resolved home.",
		"  gentle-shell config              Run pi's own 'config' against the resolved home.",
		"  gentle-shell auth <command>      Run pi's own 'auth' against the resolved home.",
		"  These run pi's own commands, forwarded verbatim, against the --isolated home",
		"  (or your own pi home with --link). Running 'gentle-shell install npm:gentle-pi'",
		"  inside the isolated home is unnecessary: gentle-shell already loads the",
		"  package itself.",
		"",
		"Environment variables:",
		"  GENTLE_SHELL_PI       Path to the pi executable to run.",
		"  GENTLE_SHELL_HOME     Directory for the isolated home (default: ~/.gentle-shell/agent).",
		"  PI_CODING_AGENT_DIR   Directory for the --link home, shared with pi itself.",
		"",
		"Every other argument is forwarded to pi unchanged.",
	].join("\n");
}
