import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

// The launcher in a bundled install (S5, S8): pure decisions over an injected
// filesystem. bin/gentle-shell.mjs wires them to the real one. A bundled install
// is `<prefix>/versions/<id>/` with this gentle-pi in its node_modules, marked by
// scripts/bundled-install.mjs, and `current` naming it; anything else keeps the
// launcher's ordinary behavior unchanged.

export interface BundledFs {
	// The canonical path, or undefined when it does not exist.
	realpath: (path: string) => string | undefined;
	// A regular file's text, or undefined.
	readText: (path: string) => string | undefined;
	// A symbolic link's target, or undefined.
	readLink: (path: string) => string | undefined;
}

export interface BundledInstall {
	root: string;
	id: string;
	versionDir: string;
}

type Env = Record<string, string | undefined>;

/**
 * Builds the detached shared server's environment without retaining session scratch.
 * Windows Node can reintroduce an omitted TEMP from its parent, so use the
 * original stable ancestor there; POSIX omits scratch temp settings instead.
 */
export function sharedEngramEnv(base: Env, platform: string = process.platform): Env {
	const path = pathFor(platform);
	const env: Env = {};
	const scratch = (value: string) => /^(gp|ga)[A-Za-z0-9]{6}$/.test(path.basename(path.normalize(value)));
	let stableTemp: string | undefined;
	let tempKey: string | undefined;
	for (const [key, value] of Object.entries(base)) {
		const name = platform === "win32" ? key.toUpperCase() : key;
		if (name.startsWith("ENGRAM_") || name === "GH_TOKEN" || name === "GITHUB_TOKEN") continue;
		if (["TMPDIR", "TMP", "TEMP"].includes(name) && value !== undefined && scratch(value)) {
			if (platform !== "win32") continue;
			// A drive-relative or root-relative path depends on ambient state.
			const root = win32.parse(value).root;
			if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?)$/.test(root) || value.split(/[\\/]/).includes("..")) {
				throw new Error("An absolute Windows scratch temp path is required for shared Engram.");
			}
			let stable = win32.normalize(value);
			while (scratch(stable)) {
				const parent = win32.dirname(stable);
				if (parent === stable) throw new Error("An absolute Windows scratch temp path is required for shared Engram.");
				stable = parent;
			}
			env[key] = stable;
			stableTemp ??= stable;
		} else {
			env[key] = value;
		}
		if (name === "TEMP") tempKey = key;
	}
	// Keep an existing custom TEMP, even if TMP/TMPDIR chose another root.
	if (stableTemp !== undefined && (tempKey === undefined || env[tempKey] === undefined)) env[tempKey ?? "TEMP"] = stableTemp;
	env.ENGRAM_NO_UPDATE_CHECK = "1";
	return env;
}

// The same rules scripts/bundled-install.mjs writes versions and markers with.
const VERSION_ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
const VERSION_MARKER = ".gentle-shell-version";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_BIN = "dist/bundle/cli.js";

// `gentle-shell upgrade` sets this to the version it just installed while it
// runs that version's `--version`: the check then runs in bundled mode, with
// its exact Pi, before `current` names it. Never passed on to children.
export const BUNDLED_VERIFY_ENV = "GENTLE_SHELL_VERIFY_VERSION";

const pathFor = (platform: string) => (platform === "win32" ? win32 : posix);

function inside(path: typeof posix, parent: string, child: string): boolean {
	const rest = path.relative(parent, child);
	return rest !== "" && !rest.startsWith("..") && !path.isAbsolute(rest);
}

function parseJson(text: string | undefined): any {
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// The bundled install this package runs from: the nearest `versions/<id>`
// ancestor of its real root whose marker names it, whose node_modules/gentle-pi
// is this package, and which `current` names (a relative symlink on POSIX, a
// pointer file on Windows) or `verifying` names (BUNDLED_VERIFY_ENV, for a
// `--version` check only). Undefined otherwise.
// `kept` accepts any finished version of the prefix, whether `current` names it
// or not (runningBundledPrefix; never the launcher's own choice of version).
export function resolveBundledInstall(input: { packageRoot: string; platform: string; fs: BundledFs; verifying?: string; kept?: boolean }): BundledInstall | undefined {
	const path = pathFor(input.platform);
	const real = input.fs.realpath(input.packageRoot) ?? input.packageRoot;
	for (let dir = path.dirname(real); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
		if (path.basename(path.dirname(dir)) !== "versions") continue;
		const id = path.basename(dir);
		const root = path.dirname(path.dirname(dir));
		if (!VERSION_ID.test(id) || id.includes("..")) return undefined;
		if (input.fs.readText(path.join(dir, VERSION_MARKER)) !== `${id}\n`) return undefined;
		if (input.fs.realpath(path.join(dir, "node_modules", "gentle-pi")) !== real) return undefined;
		const current = path.join(root, "current");
		const active = input.platform === "win32" ? input.fs.readText(current) === `${id}\n` : input.fs.readLink(current) === `versions/${id}`;
		return active || input.verifying === id || input.kept === true ? { root, id, versionDir: dir } : undefined;
	}
	return undefined;
}

export type BundledPi = { ok: true; cli: string; version: string } | { ok: false; message: string };

// The real filesystem behind BundledFs.
export const nodeBundledFs: BundledFs = {
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
	readText: (path) => {
		try {
			return lstatSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
		} catch {
			return undefined;
		}
	},
	readLink: (path) => {
		try {
			return readlinkSync(path);
		} catch {
			return undefined;
		}
	},
};

// The bundled launcher passes its prefix to Pi (bundledChildEnv), and so to
// every process Pi starts, the agent's shell included.
export const GENTLE_SHELL_PREFIX_ENV = "GENTLE_SHELL_PREFIX";

// This package's root, from lib/ or the generated runtime/ alike.
const ownPackageRoot = () => dirname(dirname(fileURLToPath(import.meta.url)));

let installOverlay: { root: string } | null | undefined;
const runningMemo = new Map<string, string | undefined>();

/** Testing only: the bundled install this package runs from (null: none), or undefined for the real one. */
export function setBundledInstallForTesting(install: { root: string } | null | undefined): void {
	installOverlay = install;
	runningMemo.clear();
}

/** Testing only: forget the remembered answers. */
export function resetRunningBundledPrefixForTesting(): void {
	runningMemo.clear();
}

// S9: the prefix of the bundled install this gentle-pi runs from, or
// undefined. Both must hold: GENTLE_SHELL_PREFIX is absolute and names that
// install's root, and resolveBundledInstall finds a finished version of the
// prefix around the package (its version marker). `current` need not name it:
// a subagent started after `gentle-shell upgrade` moved `current` still runs
// from the previous, kept version, and stays bundled. A gentle-pi elsewhere
// (npm, pnpm, nvm), started from the agent's shell that inherits the variable,
// gets undefined. The answer is remembered per package root and prefix value,
// so a `gentle-shell upgrade` that moves `current` while Pi runs does not
// change it mid-session; an injected filesystem is never remembered.
export function runningBundledPrefix(env: Env, options: { packageRoot?: string; platform?: string; fs?: BundledFs } = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	const prefix = env[GENTLE_SHELL_PREFIX_ENV];
	if (prefix === undefined || prefix.length === 0 || !pathFor(platform).isAbsolute(prefix)) return undefined;
	const overlay = options.packageRoot === undefined ? installOverlay : undefined;
	const packageRoot = options.packageRoot ?? ownPackageRoot();
	const fs = options.fs ?? nodeBundledFs;
	const key = `${packageRoot}\0${prefix}`;
	const remember = options.fs === undefined;
	if (remember && runningMemo.has(key)) return runningMemo.get(key);
	const install = overlay !== undefined ? overlay ?? undefined : resolveBundledInstall({ packageRoot, platform, fs, kept: true });
	const real = fs.realpath(prefix);
	const root = install !== undefined && real !== undefined && real === (fs.realpath(install.root) ?? install.root) ? install.root : undefined;
	if (remember) runningMemo.set(key, root);
	return root;
}

// The parent of gentle-pi's bundled config folder. Gentle AI 4.0.0 reads
// GENTLE_PI_CONFIG_HOME as this parent and writes <parent>/gentle-ai
// (internal/cli/pi_background.go), so only the Gentle AI processes Gentle Shell
// starts get it (gentleAiIsolationEnv).
export function bundledPiConfigParent(prefix: string, platform: string = process.platform): string {
	return pathFor(platform).join(prefix, "config");
}

// gentle-pi's config folder inside a bundled prefix: <prefix>/config/gentle-ai,
// the folder a Gentle AI given that parent writes, with or without #5462.
export function bundledPiConfigDir(prefix: string, platform: string = process.platform): string {
	return pathFor(platform).join(bundledPiConfigParent(prefix, platform), "gentle-ai");
}

// The config home of a bundled gentle-pi, or undefined outside one. It is
// derived, never exported as GENTLE_PI_CONFIG_HOME: Gentle AI 4.0.0 reads that
// variable as the parent of its own gentle-ai folder.
export function bundledGentlePiConfigHome(env: Env): string | undefined {
	const prefix = runningBundledPrefix(env);
	return prefix === undefined ? undefined : bundledPiConfigDir(prefix);
}

// #2201: the standalone launcher gives Pi this variable in its isolated home
// only, naming the config folder next to the agent dir (standaloneConfigHome:
// ~/.gentle-shell/gentle-ai by default). It is launcher-owned, never
// GENTLE_PI_CONFIG_HOME: Gentle AI 4.0.0 reads that one as the parent of its
// own gentle-ai folder, and the agent's shell would pass it to any gentle-ai.
export const GENTLE_SHELL_CONFIG_HOME_ENV = "GENTLE_SHELL_CONFIG_HOME";

// gentle-pi's config home, the one rule every reader shares: a bundled
// prefix's folder, then an explicit GENTLE_PI_CONFIG_HOME, then the launcher's
// marker (absolute only), then ~/.pi/gentle-ai. Empty values count as unset.
// `launcherMarker: false` is for install-level state written outside a session
// (the main channel's channel.json, builds and dev-binary.json): the installer
// and `gentle-shell upgrade` never see the marker, so their readers ignore it.
export function resolveGentlePiConfigHome(env: Env, home: string, options: { launcherMarker?: boolean; platform?: string } = {}): string {
	const path = pathFor(options.platform ?? process.platform);
	const bundled = bundledGentlePiConfigHome(env);
	if (bundled !== undefined) return bundled;
	if (env.GENTLE_PI_CONFIG_HOME) return env.GENTLE_PI_CONFIG_HOME;
	const marker = env[GENTLE_SHELL_CONFIG_HOME_ENV];
	if (options.launcherMarker !== false && marker && path.isAbsolute(marker)) return marker;
	return path.join(home, ".pi", "gentle-ai");
}

// The exact Pi of the version (S8): the Pi the version's package.json pins,
// installed inside the version folder with Pi's own bin entry. Never another Pi.
export function bundledPi(install: BundledInstall, input: { platform: string; fs: BundledFs }): BundledPi {
	const path = pathFor(input.platform);
	const pinned = parseJson(input.fs.readText(path.join(install.versionDir, "package.json")))?.dependencies?.[PI_PACKAGE];
	const failure = (found?: string): BundledPi => ({
		ok: false,
		message: [
			`gentle-shell: Gentle Shell ${install.id} needs its bundled Pi ${pinned ?? "(unknown pin)"} in ${install.versionDir}, ${found ? `but found Pi ${found}` : "but it is missing"}.`,
			"Run 'gentle-shell upgrade' to install the latest release, or run the Gentle Shell installer again to repair this version.",
		].join("\n"),
	});
	const dir = input.fs.realpath(path.join(install.versionDir, "node_modules", ...PI_PACKAGE.split("/")));
	if (typeof pinned !== "string" || dir === undefined || !inside(path, input.fs.realpath(install.versionDir) ?? install.versionDir, dir)) return failure();
	const metadata = parseJson(input.fs.readText(path.join(dir, "package.json")));
	if (metadata?.name !== PI_PACKAGE || metadata.bin?.pi !== PI_BIN) return failure();
	if (metadata.version !== pinned) return failure(String(metadata.version));
	const cli = path.join(dir, ...PI_BIN.split("/"));
	if (input.fs.realpath(cli) !== cli || input.fs.readText(cli) === undefined) return failure();
	return { ok: true, cli, version: pinned };
}

// The environment of a bundled Pi and its subagents: the user's own, unchanged
// (S9: Pi's tools run the user's commands in the user's projects, so its PATH,
// NODE_OPTIONS and npm settings stay the user's; Pi itself runs on our node,
// given explicitly, and its npm through the home's npmCommand setting), plus
// only no Pi override, subagents on the same node and Pi (the subagent runner
// splits GENTLE_PI_AGENTS_PI on whitespace, so a spaced path is left to its
// default, the running node and cli.js), and no Pi update check, since Pi only
// updates with Gentle Shell (S5). S9: the prefix (GENTLE_SHELL_PREFIX, from
// which gentle-pi derives its config folder and gives its own gentle-ai runs
// Gentle AI's variables, never set here because the agent's shell would pass
// them to a gentle-ai the user runs), and the published Engram as
// gentle-engram's ENGRAM_BIN unless the user chose one. With a memory decision
// (S2, S6): the startup policy, and ENGRAM_BIN is the Shell-owned guard, so no
// provider, whatever loaded it, runs an Engram binary against a store; allowed
// memory reaches the shared server through ENGRAM_URL only.
export const ENGRAM_COMPANION_SOURCE = "npm:gentle-engram@0.4.2";
export const ENGRAM_RECOVERY_NOTICE = "Engram memory disabled: Shell could not verify safe server reuse. Matching versions or updating alone do not prove compatibility. Reuse requires a server on 127.0.0.1:7437 with verified /compatibility evidence; Shell never stops or replaces a server already listening there. Back up existing Engram data before manual changes; do not delete it or bypass the safety check. Shell rechecks on every launch and remains usable without memory.";
export const ENGRAM_START_FAILED_NOTICE = "Engram memory disabled for this launch: Shell could not start the shared Engram server, or it did not report ready in time. Restart Shell to retry; if another program holds 127.0.0.1:7437, stop it first. Shell remains usable without memory.";
export const ENGRAM_NEWER_SCHEMA_NOTICE = "Engram memory disabled: ~/.engram was migrated by a newer Engram than Shell's bundled core, so Shell will not start a server on it. Start that newer Engram's server yourself (engram serve); Shell reuses a running server with verified /compatibility evidence. Back up the store; do not delete or downgrade it. Shell remains usable without memory.";
// `gentle-shell setup` publishes the verified core (ensureEngram) on every run.
export const ENGRAM_CORE_MISSING_NOTICE = "Engram memory disabled: the bundled Engram core is not installed yet. Run 'gentle-shell setup' to install the verified core, then restart Shell. Shell remains usable without memory.";
// The first Engram release whose server answers GET /compatibility (PR #1792).
export const ENGRAM_COMPATIBILITY_MIN_VERSION = "3.4.0";
export function engramOutdatedServerNotice(version: string): string {
	return `Engram memory disabled: the running Engram server reports version ${version}, which cannot prove store compatibility. Back up your Engram data, update that server to ${ENGRAM_COMPATIBILITY_MIN_VERSION} or later with the method you installed it with, and restart it; updating Shell alone does not replace a running server. Shell rechecks on every launch and remains usable without memory.`;
}
// A canonical numeric x.y.z (optionally v-prefixed, no leading zeros) older than
// the minimum. The version comes from the server, so anything else is never
// echoed to the user.
function outdatedServerVersion(version: string | undefined): string | undefined {
	const match = /^v?(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.exec(version ?? "");
	if (match === null) return undefined;
	const parts = match.slice(1).map(Number);
	const minimum = ENGRAM_COMPATIBILITY_MIN_VERSION.split(".").map(Number);
	const index = parts.findIndex((part, i) => part !== minimum[i]);
	return index >= 0 && parts[index] < minimum[index] ? parts.join(".") : undefined;
}
// The default endpoint gentle-engram uses without ENGRAM_URL or ENGRAM_PORT.
export const ENGRAM_DEFAULT_PORT = 7437;
export const ENGRAM_DEFAULT_URL = `http://127.0.0.1:${ENGRAM_DEFAULT_PORT}`;
const ENGRAM_SELECTIONS = ["ENGRAM_BIN", "ENGRAM_URL", "ENGRAM_DATA_DIR", "ENGRAM_PORT", "ENGRAM_SOCKET", "ENGRAM_DATABASE_URL", "ENGRAM_SERVER_MODE"];
const HEX32 = /^[a-f0-9]{32}$/;

export type EngramProbe = { kind: "refused" } | { kind: "unknown" } | { kind: "listening"; compatible: boolean; healthInstanceId?: string; healthVersion?: string };
// `url`: the shared server, reached explicitly once /compatibility verified it.
// `spawn`: nothing listens yet; Shell starts the bundled core's server and must
// see it verified before Pi starts, or memory is disabled for that launch.
export type EngramStartup = { policy: "allow" | "disabled"; notice?: string; url?: string; spawn?: true };

// Without an invalid policy or an explicit Engram selection, the default
// endpoint may be probed; an explicit selection is never contacted.
export function engramProbeAllowed(env: Env): boolean {
	const policy = env.ENGRAM_STARTUP_POLICY;
	return (policy === undefined || policy === "allow") && !ENGRAM_SELECTIONS.some((key) => Boolean(env[key]?.trim()));
}

// Evidence only: never run an executable, open SQLite or infer compatibility
// from versions. Like other agents' hooks, Shell shares the global server: a
// verified listener is reused, and with nothing listening the verified bundled
// core starts one on Engram's defaults, unless the default store's header
// (`userVersion`) shows a newer schema than that core's. A listener that does
// not verify is never replaced. A server version only selects the wording.
export function classifyEngramStartup(input: { env: Env; endpoint: EngramProbe; core: boolean; coreVersion: string; userVersion?: number }): EngramStartup {
	if (!engramProbeAllowed(input.env)) return { policy: "disabled", notice: ENGRAM_RECOVERY_NOTICE };
	const endpoint = input.endpoint;
	if (endpoint.kind === "listening" && endpoint.compatible) return { policy: "allow", url: ENGRAM_DEFAULT_URL };
	if (endpoint.kind === "refused") {
		if (!input.core) return { policy: "disabled", notice: ENGRAM_CORE_MISSING_NOTICE };
		if (input.userVersion !== undefined && !engramHeaderAllows(input.userVersion, bundledEngramSchema(input.coreVersion))) {
			return { policy: "disabled", notice: ENGRAM_NEWER_SCHEMA_NOTICE };
		}
		return { policy: "allow", url: ENGRAM_DEFAULT_URL, spawn: true };
	}
	const outdated = endpoint.kind === "listening" ? outdatedServerVersion(endpoint.healthVersion) : undefined;
	return { policy: "disabled", notice: outdated === undefined ? ENGRAM_RECOVERY_NOTICE : engramOutdatedServerNotice(outdated) };
}

// The exact contract a startup-verified store reports (Engram GET /compatibility).
export function isReadyCompatibility(text: string): boolean {
	const body = parseJson(text);
	return typeof body === "object" && body !== null && !Array.isArray(body) && body.status === "ready" && body.active_reuse_authorized === true &&
		body.capability === "startup-verified-store-v1" && body.revision === 1 && body.source === "active" && body.offline_automatic_opening_authorized !== true &&
		typeof body.instance_id === "string" && HEX32.test(body.instance_id) && typeof body.runtime_id === "string" && HEX32.test(body.runtime_id);
}

const PROBE_BODY_LIMIT = 16 * 1024;
type LocalAnswer = { kind: "refused" } | { kind: "unknown" } | { kind: "response"; status: number; body: string };

// One bounded GET on a direct loopback socket: no agent, proxy, redirects or
// credentials (ENGRAM_HTTP_TOKEN belongs to the user's server, never sent).
function localGet(port: number, path: string, timeoutMs: number): Promise<LocalAnswer> {
	return new Promise((resolve) => {
		let settled = false;
		let socket: ReturnType<typeof createConnection> | undefined;
		const finish = (answer: LocalAnswer) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.destroy();
			socket?.destroy();
			resolve(answer);
		};
		const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "application/json" },
			createConnection: () => (socket = createConnection({ host: "127.0.0.1", port })) }, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > PROBE_BODY_LIMIT) finish({ kind: "response", status: 0, body: "" });
				else chunks.push(chunk);
			});
			response.on("end", () => finish({ kind: "response", status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			response.on("error", () => finish({ kind: "unknown" }));
		});
		const timer = setTimeout(() => finish({ kind: "unknown" }), timeoutMs);
		request.on("error", (error: NodeJS.ErrnoException) => finish({ kind: error.code === "ECONNREFUSED" ? "refused" : "unknown" }));
		request.end();
	});
}

// Read-only probe of the default endpoint: /compatibility, then /health for
// the running instance and version. Never inferred from /health alone.
export async function probeEngramEndpoint(input: { port?: number; timeoutMs?: number } = {}): Promise<EngramProbe> {
	const port = input.port ?? ENGRAM_DEFAULT_PORT;
	const timeoutMs = input.timeoutMs ?? 1000;
	const compatibility = await localGet(port, "/compatibility", timeoutMs);
	if (compatibility.kind !== "response") return compatibility;
	if (compatibility.status === 200 && isReadyCompatibility(compatibility.body)) return { kind: "listening", compatible: true };
	const health = await localGet(port, "/health", timeoutMs);
	const body = health.kind === "response" && health.status === 200 ? parseJson(health.body) : undefined;
	const identified = typeof body?.instance_id === "string" && HEX32.test(body.instance_id) && typeof body.version === "string";
	return { kind: "listening", compatible: false, healthInstanceId: identified ? body.instance_id : undefined, healthVersion: identified ? body.version : undefined };
}

// Shell's record of a store an earlier Shell provisioned with its bundled core,
// read only by the explicit `gentle-shell memory migrate` recovery.
export type EngramProvenance = { schema: 1; dataDir: string; instanceId: string; coreSha256: string };

export function engramProvenancePath(prefix: string, platform: string = process.platform): string {
	return pathFor(platform).join(bundledPiConfigParent(prefix, platform), "engram-provenance.json");
}

export function parseEngramProvenance(text: string | undefined): EngramProvenance | undefined {
	const record = parseJson(text);
	if (record?.schema !== 1 || typeof record.dataDir !== "string" || !(posix.isAbsolute(record.dataDir) || win32.isAbsolute(record.dataDir)) ||
		typeof record.instanceId !== "string" || !HEX32.test(record.instanceId) || typeof record.coreSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.coreSha256)) return undefined;
	return { schema: 1, dataDir: record.dataDir, instanceId: record.instanceId, coreSha256: record.coreSha256 };
}

// The bundled core's own schema (SQLite user_version), verified from the
// tagged sources v3.3.2, v3.4.0 and v3.5.2: internal/store/store.go `const schemaVersion = 1`.
// A pin without a verified entry leaves the header check unavailable.
const BUNDLED_ENGRAM_SCHEMA: Record<string, number> = { "3.3.2": 1, "3.4.0": 1, "3.5.2": 1 };

export function bundledEngramSchema(coreVersion: string): number | undefined {
	return Object.hasOwn(BUNDLED_ENGRAM_SCHEMA, coreVersion) ? BUNDLED_ENGRAM_SCHEMA[coreVersion] : undefined;
}

// SQLite's user_version from the raw database header (bytes 60-63), or
// undefined for anything that is not a well-formed rollback or WAL database.
export function sqliteHeaderUserVersion(header: Uint8Array, size: number): number | undefined {
	if (header.length < 100 || Buffer.from(header.subarray(0, 16)).toString("latin1") !== "SQLite format 3\0") return undefined;
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const raw = view.getUint16(16);
	const pageSize = raw === 1 ? 65536 : raw;
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || size < pageSize || size % pageSize !== 0) return undefined;
	if (![1, 2].includes(header[18]) || ![1, 2].includes(header[19])) return undefined;
	return view.getUint32(60);
}

// A tripwire, not a compatibility proof: a header newer than the bundled
// schema means another Engram migrated the store. Equal or lower (including a
// stale 0 before a WAL checkpoint) is no signal either way.
export function engramHeaderAllows(userVersion: number | undefined, bundledSchema: number | undefined): boolean {
	return userVersion !== undefined && bundledSchema !== undefined && userVersion <= bundledSchema;
}

// Pi 1.1.0 options that always take the next token as their value (cli/args.js);
// options that skip a dash-led next token never hide a version or help flag.
const PI_VALUE_OPTIONS = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session",
	"--session-id", "--fork", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e",
	"--skill", "--prompt-template", "--theme"]);

// Whether Pi reads its arguments as a version or help request: such a token in
// flag position, before Pi's own `--` and not as another option's value.
export function piVersionOrHelpRequested(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") return false;
		if (arg === "--version" || arg === "-v" || arg === "--help" || arg === "-h") return true;
		if (PI_VALUE_OPTIONS.has(arg)) i += 1;
	}
	return false;
}

export function supportsEngramStartupPolicy(metadata: string | undefined): boolean {
	const pkg = parseJson(metadata);
	return pkg?.name === "gentle-engram" && pkg.engram?.startupPolicy === 1;
}

export function bundledChildEnv(base: Env, input: { node: string; cli: string; prefix: string; engram?: string; guard?: string; memory?: EngramStartup }): Env {
	const env: Env = { ...base, PI_SKIP_VERSION_CHECK: "1", [GENTLE_SHELL_PREFIX_ENV]: input.prefix };
	delete env.GENTLE_SHELL_PI;
	delete env[BUNDLED_VERIFY_ENV];
	if (/\s/.test(`${input.node}${input.cli}`)) delete env.GENTLE_PI_AGENTS_PI;
	else env.GENTLE_PI_AGENTS_PI = `${input.node} ${input.cli}`;
	const memory = input.memory;
	if (memory === undefined) {
		if (input.engram !== undefined && !base.ENGRAM_BIN?.trim()) env.ENGRAM_BIN = input.engram;
		return env;
	}
	if (input.guard === undefined) throw new Error("A memory decision needs the Engram guard path.");
	env.ENGRAM_STARTUP_POLICY = memory.policy;
	if (memory.notice) env.ENGRAM_STARTUP_NOTICE = [memory.notice, base.ENGRAM_STARTUP_NOTICE].filter(Boolean).join(" ");
	// An explicit ENGRAM_BIN or ENGRAM_URL is the user's choice: never replaced.
	// An explicit URL alone still gets the verified core (or the guard), never PATH.
	if (base.ENGRAM_BIN?.trim()) return env;
	if (base.ENGRAM_URL?.trim()) {
		env.ENGRAM_BIN = input.engram ?? input.guard;
		return env;
	}
	if (memory.url !== undefined) env.ENGRAM_URL = memory.url;
	env.ENGRAM_BIN = input.guard;
	return env;
}

// `gentle-shell setup` in a bundled install: the child environment with `dirs`
// (our node's folder, then the version's node_modules/.bin) ahead of the user's
// PATH. Setup runs Gentle AI, which finds `pi` on PATH, and pnpm's `.bin/pi`
// runs the first `node` on PATH, so both must be ours there.
export function bundledSetupEnv(env: Env, input: { dirs: string[]; platform: string }): Env {
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? (input.platform === "win32" ? "Path" : "PATH");
	const rest = (env[key] ?? "").split(pathFor(input.platform).delimiter).filter((entry) => entry.length > 0);
	return { ...env, [key]: [...input.dirs, ...rest].join(pathFor(input.platform).delimiter) };
}

export type BundledNpmCommandEdit = { status: "unchanged" } | { status: "malformed" } | { status: "write"; text: string };

// The agent home's settings.json with `npmCommand` set to the bundled npm
// (scripts/bundled-install.mjs bundledNpmCommand), every other key kept in
// order and the file's indentation and final newline kept. A file that already
// holds exactly that command is left as it is; one that is not a JSON object
// is never rewritten.
export function withBundledNpmCommand(settingsText: string | undefined, command: string[]): BundledNpmCommandEdit {
	const settings = settingsText === undefined ? {} : parseJson(settingsText);
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { status: "malformed" };
	const current = settings.npmCommand;
	if (Array.isArray(current) && current.length === command.length && current.every((part, index) => part === command[index])) return { status: "unchanged" };
	const indent = settingsText?.match(/\{\r?\n([ \t]+)/)?.[1] ?? "  ";
	const serialized = JSON.stringify({ ...settings, npmCommand: command }, null, indent);
	return { status: "write", text: settingsText === undefined || settingsText.endsWith("\n") ? `${serialized}\n` : serialized };
}

export type BundledNpmCommandRemoval = { status: "unchanged" } | { status: "malformed" } | { status: "removed"; text: string };

// settings.json without `npmCommand`: every other key kept in order and the
// file's indentation and final newline kept.
function settingsWithoutNpmCommand(settingsText: string, settings: Record<string, unknown>): string {
	const indent = settingsText.match(/\{\r?\n([ \t]+)/)?.[1] ?? "  ";
	const { npmCommand: _removed, ...rest } = settings;
	const serialized = JSON.stringify(rest, null, indent);
	return settingsText.endsWith("\n") ? `${serialized}\n` : serialized;
}

// The agent home's settings.json without a `npmCommand` naming the prefix a
// bundled self-uninstall removed (gentle-shell-uninstall.ts): one absolute
// entry inside `withinRemoved` drops the whole key, every other key kept in
// order and the file's indentation and final newline kept. A file that is not
// a JSON object is never rewritten; a command naming nothing inside it stays.
export function withoutBundledNpmCommand(settingsText: string | undefined, withinRemoved: (path: string) => boolean): BundledNpmCommandRemoval {
	if (settingsText === undefined) return { status: "unchanged" };
	const settings = parseJson(settingsText);
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { status: "malformed" };
	const current = settings.npmCommand;
	if (!Array.isArray(current) || !current.some((part) => typeof part === "string" && isAbsolute(part) && withinRemoved(part))) return { status: "unchanged" };
	return { status: "removed", text: settingsWithoutNpmCommand(settingsText, settings) };
}

// An `npmCommand` a bundled install wrote (scripts/bundled-install.mjs
// bundledNpmCommand, with npm-cli.js and --prefix in earlier releases): our
// node in runtime/node-<v>, then npm's settings and cache flags, and
// --update-notifier=false last. A command the user chose never matches, even
// when its program is missing.
export function isBundledNpmCommand(command: readonly unknown[]): boolean {
	const [node] = command;
	return typeof node === "string" && /[\\/]runtime[\\/]node-[^\\/]+[\\/](node\.exe|bin[\\/]node)$/.test(node)
		&& ["--userconfig=", "--globalconfig=", "--cache="].every((flag) => command.some((part) => typeof part === "string" && part.startsWith(flag)))
		&& command[command.length - 1] === "--update-notifier=false";
}

// The agent home's settings.json without an `npmCommand` a bundled install
// wrote whose executable (its first entry) no longer exists, as after a
// bundled self-uninstall that kept the home (#2469): Pi runs that command for
// every package install, so a key naming a deleted node.exe fails them all
// with ENOENT. A command whose executable exists, that names no absolute
// path, or that the user set themselves is never touched.
export function withoutMissingBundledNpmCommand(settingsText: string | undefined, exists: (path: string) => boolean): BundledNpmCommandRemoval {
	if (settingsText === undefined) return { status: "unchanged" };
	const settings = parseJson(settingsText);
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return { status: "malformed" };
	const executable = Array.isArray(settings.npmCommand) ? settings.npmCommand[0] : undefined;
	if (typeof executable !== "string" || !isAbsolute(executable) || exists(executable) || !isBundledNpmCommand(settings.npmCommand as unknown[])) return { status: "unchanged" };
	return { status: "removed", text: settingsWithoutNpmCommand(settingsText, settings) };
}

export interface BundledUpdatePlan {
	// Pi's own update was asked for: redirect it to `gentle-shell upgrade`.
	self: boolean;
	// `--latest` asked for the newest published Pi in place of the release's
	// verified one (scripts/bundled-install.mjs upgradePiLatest). Only set then.
	latest?: boolean;
	// What Pi still runs, if anything: the extension part of `--all`, or the
	// whole command when it never updates Pi itself.
	piArgs?: string[];
}

// `gentle-shell update [target]` in a bundled install, read the way Pi's
// package-manager-cli.js reads it: the target is Pi itself for a bare
// `update`, `--self`, or a `self`/`pi` positional, and "all" for `--all`,
// `--self --extensions` or `self`/`pi` with `--extensions`. Only Pi's own part
// is redirected; "all" still sends `update --extensions` (with the other
// flags) to Pi. `--latest` marks Pi's own part as the newest published Pi;
// with any form that is not Pi's own update it is unknown to Pi, so it passes
// through. Packages, models, help, and forms Pi refuses (conflicting or
// unknown options) reach Pi unchanged.
export function bundledUpdatePlan(passthrough: string[]): BundledUpdatePlan {
	const passThrough = { self: false, piArgs: passthrough };
	const flags: string[] = [];
	const positional: string[] = [];
	let self = false;
	let extensions = false;
	let all = false;
	let latest = false;
	for (const token of passthrough.slice(1)) {
		if (token === "--self") self = true;
		else if (token === "--latest") latest = true;
		else if (token === "--extensions") extensions = true;
		else if (token === "--all") all = true;
		else if (["--approve", "-a", "--no-approve", "-na", "--force"].includes(token)) flags.push(token);
		else if (token.startsWith("-")) return passThrough;
		else positional.push(token);
	}
	if (positional.length > 1 || (all && (self || extensions || positional.length > 0))) return passThrough;
	if (positional.length === 1) {
		if ((positional[0] !== "self" && positional[0] !== "pi") || self) return passThrough;
		self = true;
	}
	const marked = latest ? { latest: true } : {};
	if (all || (self && extensions)) return { self: true, ...marked, piArgs: ["update", "--extensions", ...flags] };
	if (extensions) return passThrough;
	return { self: true, ...marked };
}

// What `gentle-shell update` does after the redirected upgrade or the
// `--latest` Pi update (`upgradeCode` is undefined when it did not run): with
// nothing left for Pi it exits with that code; otherwise Pi still runs, so
// `update --all` updates the extensions even when that step could not complete.
export function bundledUpdateNext(plan: BundledUpdatePlan, upgradeCode: number | undefined): { exitCode: number } | { piArgs: string[]; note?: string } {
	if (plan.piArgs === undefined) return { exitCode: upgradeCode ?? 0 };
	if (plan.self && upgradeCode !== undefined && upgradeCode !== 0) {
		const step = plan.latest ? "latest Pi update" : "Gentle Shell upgrade";
		return { piArgs: plan.piArgs, note: `gentle-shell: the ${step} did not complete; updating the extensions anyway.` };
	}
	return { piArgs: plan.piArgs };
}

export function bundledUpdateNotice(input: { piVersion: string; interactive: boolean }): string[] {
	return [
		`Pi ships pinned with Gentle Shell (Pi ${input.piVersion}): a newer Pi arrives with a Gentle Shell release.`,
		input.interactive
			? "Running 'gentle-shell upgrade'..."
			: "Run 'gentle-shell upgrade' to install the latest Gentle Shell release and its Pi.",
		"Run 'gentle-shell update --latest' to install the newest published Pi now, without the release's verified lockfile.",
	];
}

export type BundledUpgradeAction = { action: "upgrade" } | { action: "rollback" } | { error: string; usage: boolean };

export const BUNDLED_UPGRADE_USAGE = "usage: gentle-shell upgrade [--channel release] | gentle-shell upgrade --rollback";

// `gentle-shell upgrade` arguments in a bundled install, which follows the
// release channel only (the main channel builds from source).
export function parseBundledUpgradeArgs(args: string[]): BundledUpgradeAction {
	if (args.length === 0) return { action: "upgrade" };
	if (args.length === 1 && args[0] === "--rollback") return { action: "rollback" };
	const channel = args.length === 1 && args[0].startsWith("--channel=") ? args[0].slice("--channel=".length)
		: args.length === 2 && args[0] === "--channel" ? args[1] : undefined;
	if (channel === "release") return { action: "upgrade" };
	if (channel === "main") {
		return { error: "this bundled installation follows the release channel only; the main channel needs a pnpm or npm installation of Gentle Shell", usage: false };
	}
	return { error: BUNDLED_UPGRADE_USAGE, usage: true };
}
