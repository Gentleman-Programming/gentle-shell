// `gentle-shell serve`: argument parsing, the per-user server file and lock
// under `<agent home>/serve`, the foreground server, the detached daemon, the
// local CLI client (`status`, `stop`, `pair`, `devices`) that talks to the
// running server with the owner-only admin token from the server file, and
// `share`, which opens the server to the local network (answering LAN
// discovery) and prints the short pairing code plus a connection code fallback.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { INTERACTIVE_HOST_ENV } from "./rpc-host.ts";
import { DEFAULT_PAIR_SCOPES, parseScopes, readDevicesFile, ServeAuth, writeDevicesFile, type PublicDevice, type ServeScope } from "./serve-auth.ts";
import { isLoopbackHost, isUnspecified, SERVE_PROTOCOL, startServeServer, type ServeServer, type ServeTower } from "./serve-server.ts";
import { parseRelayUrl } from "./serve-relay.ts";
import { loadOrCreateServeTls, type ServeTlsIdentity } from "./serve-tls.ts";
import type { SessionLaunch } from "./serve-session.ts";
import { AUTOSTART_LABEL, autostartCommand, autostartFile, autostartInstalled, defaultShareSystem, encodeConnectionCode, firewallHint, HOST_NAME, installAutostart, ownHostNames,
	removeAutostart, SHARE_DEFAULT_PORT, SHARE_FORWARD_PORTS, SHARE_PORT_ATTEMPTS, shareAddresses, type PortRange, type ShareSystem } from "./serve-share.ts";
import type { UpgradeChannel } from "./serve-upgrade.ts";
import { openTowerServer } from "./tower-open.ts";

export const SERVE_SERVER_FILE_SCHEMA = "gentle-shell.serve.server/v1";
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 0 };
const DAEMON_START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;

// --- arguments -----------------------------------------------------------------

export type ServeArgs =
	| { action: "start"; host: string; port: number; foreground: boolean; json: boolean; allowHosts?: string[]; forwardPorts?: PortRange; noTls?: true; relay?: string }
	| { action: "status"; json: boolean }
	| { action: "stop"; endSessions: boolean }
	| { action: "pair"; scopes: ServeScope[]; json: boolean }
	| { action: "devices"; revoke?: string; json: boolean }
	| { action: "share"; port: number; always: boolean; json: boolean; noTls?: true; relay?: string }
	| { action: "share-off" }
	| { action: "help" };

export function parseListen(value: string): { host: string; port: number } | { error: string } {
	const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:\s[\]]+))?:(\d{1,5})$/.exec(value) ?? (/^\d{1,5}$/.test(value) ? [value, undefined, undefined, value] : null);
	if (!m) return { error: `--listen needs <host>:<port> (got "${value}")` };
	const port = Number(m[3]);
	if (!(port >= 0 && port <= 65535)) return { error: `--listen port must be 0-65535 (got "${m[3]}")` };
	const host = m[1] !== undefined ? m[1] : m[2] ?? DEFAULT_LISTEN.host;
	return { host: host.toLowerCase() === "localhost" ? "127.0.0.1" : host, port };
}

export function parseServeArgs(args: readonly string[]): ServeArgs | { error: string } {
	const first = args[0];
	const sub = first === "status" || first === "stop" || first === "pair" || first === "devices" || first === "share" ? first : undefined;
	const rest = sub ? args.slice(1) : args;
	let json = false;
	let foreground = false;
	let listen = DEFAULT_LISTEN;
	let revoke: string | undefined;
	let sharePort: number | undefined;
	let always = false;
	let off = false;
	let endSessions = false;
	let forwardPorts: PortRange | undefined;
	let noTls = false;
	let relay: string | undefined;
	const scopeValues: string[] = [];
	const allowHosts: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		const value = (flag: string): string | undefined => {
			if (arg === flag) return rest[(i += 1)];
			return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
		};
		if (arg === "--help" || arg === "-h") return { action: "help" };
		if (arg === "--json" && sub !== "stop") { json = true; continue; }
		if (sub === undefined && arg === "--foreground") { foreground = true; continue; }
		if ((sub === undefined || sub === "share") && arg === "--no-tls") { noTls = true; continue; }
		if ((sub === undefined || sub === "share") && (arg === "--relay" || arg.startsWith("--relay="))) {
			const parsed = parseRelayUrl(value("--relay") ?? "");
			if ("error" in parsed) return { error: `--relay: ${parsed.error}` };
			relay = parsed.url;
			continue;
		}
		if (sub === undefined && (arg === "--listen" || arg.startsWith("--listen="))) {
			const v = value("--listen");
			if (v === undefined) return { error: "--listen needs <host>:<port>" };
			const parsed = parseListen(v);
			if ("error" in parsed) return parsed;
			listen = parsed;
			continue;
		}
		if (sub === undefined && (arg === "--allow-host" || arg.startsWith("--allow-host="))) {
			const v = value("--allow-host")?.toLowerCase();
			if (v === undefined || !HOST_NAME.test(v)) return { error: `--allow-host needs a DNS name without a port (got "${v ?? ""}")` };
			if (!allowHosts.includes(v)) allowHosts.push(v);
			continue;
		}
		if (sub === undefined && (arg === "--forward-ports" || arg.startsWith("--forward-ports="))) {
			const v = value("--forward-ports");
			const parsed = v === undefined ? undefined : parsePortRange(v);
			if (!parsed) return { error: `--forward-ports needs a port range like 8800-8899 (got "${v ?? ""}")` };
			forwardPorts = parsed;
			continue;
		}
		if (sub === "pair" && (arg === "--scope" || arg.startsWith("--scope="))) {
			const v = value("--scope");
			if (v === undefined) return { error: "--scope needs a scope list" };
			scopeValues.push(v);
			continue;
		}
		if (sub === "devices" && (arg === "--revoke" || arg.startsWith("--revoke="))) {
			const v = value("--revoke");
			if (!v || !/^[A-Za-z0-9_]{1,64}$/.test(v)) return { error: "--revoke needs a device id" };
			revoke = v;
			continue;
		}
		if (sub === "share" && (arg === "--port" || arg.startsWith("--port="))) {
			const v = value("--port");
			if (v === undefined || !/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) return { error: `--port needs a port 1-65535 (got "${v ?? ""}")` };
			sharePort = Number(v);
			continue;
		}
		if (sub === "share" && arg === "--always") { always = true; continue; }
		if (sub === "share" && arg === "--off") { off = true; continue; }
		if (sub === "stop" && arg === "--sessions") { endSessions = true; continue; }
		return { error: `unknown serve${sub ? ` ${sub}` : ""} argument "${arg}"` };
	}
	if (noTls && relay !== undefined) return { error: "--relay needs TLS (the relay must only see ciphertext): leave out --no-tls" };
	const network = { ...(noTls ? { noTls: true as const } : {}), ...(relay === undefined ? {} : { relay }) };
	if (sub === "status") return { action: "status", json };
	if (sub === "stop") return { action: "stop", endSessions };
	if (sub === "devices") return { action: "devices", json, ...(revoke === undefined ? {} : { revoke }) };
	if (sub === "share") {
		if (off) return always || json || sharePort !== undefined || noTls || relay !== undefined ? { error: "serve share --off takes no other argument" } : { action: "share-off" };
		return { action: "share", port: sharePort ?? SHARE_DEFAULT_PORT, always, json, ...network };
	}
	if (sub === "pair") {
		if (scopeValues.length === 0) return { action: "pair", scopes: [...DEFAULT_PAIR_SCOPES], json };
		const parsed = parseScopes(scopeValues);
		return "error" in parsed ? parsed : { action: "pair", scopes: parsed.scopes, json };
	}
	return { action: "start", host: listen.host, port: listen.port, foreground, json, ...(allowHosts.length === 0 ? {} : { allowHosts }), ...(forwardPorts ? { forwardPorts } : {}), ...network };
}

/** `<from>-<to>`, both 1-65535, from ≤ to, at most 1000 ports. */
export function parsePortRange(value: string): PortRange | undefined {
	const m = /^(\d{1,5})-(\d{1,5})$/.exec(value);
	if (!m) return undefined;
	const from = Number(m[1]);
	const to = Number(m[2]);
	return from >= 1 && to <= 65535 && from <= to && to - from < 1000 ? { from, to } : undefined;
}

export const SERVE_HELP = [
	"Usage: gentle-shell [home selectors] serve share [--port <n>] [--always] [--no-tls] [--relay gsr://<host>:<port>] [--json]",
	"       gentle-shell [home selectors] serve share --off",
	"       gentle-shell [home selectors] serve [--listen <host>:<port>] [--allow-host <name>]... [--forward-ports <from>-<to>] [--no-tls] [--relay gsr://<host>:<port>] [--foreground] [--json]",
	"       gentle-shell [home selectors] serve status [--json]",
	"       gentle-shell [home selectors] serve stop [--sessions]",
	"       gentle-shell [home selectors] serve pair [--scope <scope,...>] [--json]",
	"       gentle-shell [home selectors] serve devices [--revoke <id>] [--json]",
	"",
	"Runs one server per agent home that owns Gentle Shell sessions (one `--mode rpc` child each)",
	"and lets paired devices drive them over HTTP + Server-Sent Events. Sessions keep running when",
	"clients disconnect. Binds 127.0.0.1 on a random port unless --listen says otherwise; every",
	"request needs a device token (there is no unauthenticated mode). A non-loopback --listen",
	"serves HTTPS with a self-signed certificate made on first run (<home>/serve/tls/); devices pin",
	"its fingerprint. This computer itself may keep using plain http://127.0.0.1.",
	"",
	"  serve share      The easy way to connect Gentle Shell GPUI from another computer on your",
	"                   network: opens the server to the network (HTTPS, port 8787 or the next",
	"                   free one; --port picks another) and prints a short code to enter in the app",
	"                   (valid 5 minutes, once). The app finds this computer on the network by itself",
	"                   (UDP broadcast on the same port); where it cannot (another subnet, a tailnet,",
	"                   client isolation, a relay), paste the long gsc1. code printed under it. Reuses",
	"                   a server already on the network; one on this computer only (or with other",
	"                   TLS or relay settings) is reopened when it runs no sessions. Pages it forwards",
	"                   to the app (dev servers, the design canvas, Gentle Tower) take ports 8800-8899.",
	"    --always       Also start that server at every login (systemd user unit on Linux, a",
	"                   LaunchAgent on macOS). 'serve share --off' turns it off and stops it.",
	"  serve            Start the server in the background (--foreground keeps it in this terminal).",
	"  serve status     Show whether the server runs, its URL and its sessions.",
	"  serve stop       Stop the server. Its sessions keep running and the next server picks them",
	"                   up (a session no server came back to stops after 24 hours); --sessions",
	"                   stops them too.",
	"  serve pair       Print a one-time pairing code (single use, 5 minutes). Scopes default to",
	"                   sessions:read,sessions:operate,terminal; leave terminal out (--scope",
	"                   sessions:read,sessions:operate) for a device that must not open shells, and",
	"                   add admin only for a device you fully trust.",
	"  serve devices    List paired devices; --revoke <id> removes one at once (its streams close).",
	"",
	"  --allow-host     One more name clients may use in the Host header, for example a tailnet",
	"                   MagicDNS name (repeatable). Names not allowed are refused (DNS rebinding).",
	"  --forward-ports  Listen ports for forwarded pages (for example 8800-8899), so a firewall can",
	"                   open one range; without it each forward takes a random port.",
	"  --no-tls         Plain HTTP on the network, as before TLS existed: tokens and traffic cross",
	"                   the network unencrypted. Only for a network that encrypts by itself.",
	"  --relay <url>    Also register with a relay (gentle-shell relay), so devices outside this",
	"                   network reach the server through it with the long code. The relay sees only",
	"                   TLS ciphertext. Its secret comes from GENTLE_SHELL_RELAY_SECRET or",
	"                   <home>/serve/relay-secret.",
	"",
	"Paired devices can also read and write files, run git and open persistent terminals here,",
	"all as the user the server runs as. Terminals run in gentle-term-host ($GENTLE_TERM_HOST,",
	"<home>/serve/bin/gentle-term-host or on PATH), which keeps them alive across clients and",
	"server restarts.",
	"",
	"Protocol, endpoints and security model: docs/serve.md.",
].join("\n");

// --- server file and lock --------------------------------------------------------

export interface ServerFile {
	schema: typeof SERVE_SERVER_FILE_SCHEMA;
	protocol: number;
	serverId: string;
	url: string;
	listen: { host: string; port: number };
	pid: number;
	startedAt: string;
	version: string;
	/** Owner-only local admin token for the CLI. */
	adminToken: string;
	/** Whether it answers LAN discovery; absent in files written before discovery existed. */
	discovery?: boolean;
	/** Listen ports forwarded pages take; absent when the OS assigns them. */
	forwardPorts?: PortRange;
	/** The certificate's fingerprint when the server serves HTTPS on the network. */
	fingerprint?: string;
	/** The relay it registers with (`gsr://host:port`). */
	relay?: string;
}

export function serveDir(agentHome: string): string {
	return join(agentHome, "serve");
}

export function serveFiles(agentHome: string) {
	const dir = serveDir(agentHome);
	return { dir, server: join(dir, "server.json"), lock: join(dir, "server.lock"), devices: join(dir, "devices.json"), log: join(dir, "server.log") };
}

function privateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { chmodSync(dir, 0o700); } catch { /* Windows: ACLs, not modes */ }
}

export function readServerFile(path: string): ServerFile | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ServerFile;
		if (parsed?.schema !== SERVE_SERVER_FILE_SCHEMA || typeof parsed.url !== "string" || typeof parsed.pid !== "number" || typeof parsed.adminToken !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function writeServerFile(path: string, file: ServerFile): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, path);
	try { chmodSync(path, 0o600); } catch { /* Windows */ }
}

export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Single instance per agent home: an exclusive create of the lock file, which
 * names its pid. A lock whose pid is gone is stale and is taken over once.
 */
export function acquireServeLock(lockPath: string, pid: number = process.pid): { acquired: true } | { heldBy: number } {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeSync(fd, `${pid}\n`);
			closeSync(fd);
			return { acquired: true };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let holder = NaN;
			try { holder = Number(readFileSync(lockPath, "utf8").trim()); } catch { /* vanished: retry */ }
			if (Number.isInteger(holder) && holder !== pid && processAlive(holder)) return { heldBy: holder };
			rmSync(lockPath, { force: true });
		}
	}
	return { heldBy: NaN };
}

function releaseServeLock(lockPath: string, pid: number = process.pid): void {
	try {
		if (Number(readFileSync(lockPath, "utf8").trim()) === pid) rmSync(lockPath, { force: true });
	} catch { /* already gone */ }
}

/** The server file of a live server, or undefined (a stale file is ignored). */
export function liveServer(agentHome: string): ServerFile | undefined {
	const file = readServerFile(serveFiles(agentHome).server);
	return file && processAlive(file.pid) ? file : undefined;
}

// --- running -----------------------------------------------------------------------

export interface ServeCommandContext {
	agentHome: string;
	/** Home selector flags that make a child resolve this same home. */
	homeFlags: string[];
	/** Absolute path of bin/gentle-shell.mjs. */
	launcher: string;
	nodePath: string;
	version: string;
	env: NodeJS.ProcessEnv;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Resolves when a foreground server should stop (defaults to SIGINT/SIGTERM). */
	untilStopped?: (stopRequested: Promise<void>) => Promise<void>;
	/** Machine facts and the command runner for `serve share` (defaults to this machine). */
	system?: ShareSystem;
	/**
	 * The launcher that runs the installed version after an upgrade, resolved then:
	 * `launcher` for an npm or pnpm install (upgraded in place), the one `current`
	 * names in a bundled install (an upgrade installs a new version beside this one).
	 */
	restartLauncher?: () => string;
	/** Test seam: the upgrade command `POST /api/upgrade` runs (defaults to `upgradeLaunch`). */
	upgradeCommand?: (channel: UpgradeChannel | undefined) => SessionLaunch;
	/** Test seam: the setup command `POST /api/setup` runs (defaults to `setupLaunch`). */
	setupCommand?: () => SessionLaunch;
}

/** The exit code that asks a service manager (systemd `Restart=on-failure`, launchd `KeepAlive`) to start the upgraded server. */
export const SERVE_RESTART_EXIT = 75;

/**
 * Whether a service manager runs this server (`serve share --always`): systemd
 * names this process in `SYSTEMD_EXEC_PID`, launchd sets its job label.
 */
export function supervisedServe(env: NodeJS.ProcessEnv, pid: number = process.pid): boolean {
	return env.SYSTEMD_EXEC_PID === String(pid) || env.XPC_SERVICE_NAME === AUTOSTART_LABEL;
}

/** `gentle-shell upgrade [--channel <channel>]`, run by this launcher outside any session, never prompting. */
export function upgradeLaunch(ctx: Pick<ServeCommandContext, "launcher" | "nodePath" | "env">, channel: UpgradeChannel | undefined): SessionLaunch {
	const env: NodeJS.ProcessEnv = { ...ctx.env, NO_COLOR: "1", FORCE_COLOR: "0", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1" };
	delete env[INTERACTIVE_HOST_ENV];
	return { command: ctx.nodePath, args: [ctx.launcher, "upgrade", ...(channel === undefined ? [] : ["--channel", channel])], cwd: homedir(), env };
}

/** `gentle-shell [home flags] setup` for this server's home, run by this launcher outside any session, never prompting. */
export function setupLaunch(ctx: Pick<ServeCommandContext, "homeFlags" | "launcher" | "nodePath" | "env">): SessionLaunch {
	const env: NodeJS.ProcessEnv = { ...ctx.env, NO_COLOR: "1", FORCE_COLOR: "0", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1" };
	delete env[INTERACTIVE_HOST_ENV];
	return { command: ctx.nodePath, args: [ctx.launcher, ...ctx.homeFlags, "setup"], cwd: homedir(), env };
}

/** The version the launcher's package now holds, read after an upgrade. */
function launcherVersion(launcher: string): string | undefined {
	try {
		const version = JSON.parse(readFileSync(join(dirname(dirname(launcher)), "package.json"), "utf8"))?.version;
		return typeof version === "string" && version.length <= 64 ? version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The child for one session: this same launcher, same home, Pi RPC mode, Desktop RPC on.
 * `sessionId` resumes by exact id (`--session-id`): the project's session with that id, or a
 * new one under it when Pi never wrote it (a conversation with no messages yet has no file).
 * `--session` would fail then, and could stop to ask about forking another project's session.
 */
export function sessionLaunch(ctx: Pick<ServeCommandContext, "homeFlags" | "launcher" | "nodePath" | "env">, input: { cwd: string; sessionId?: string }): SessionLaunch {
	const env: NodeJS.ProcessEnv = { ...ctx.env, [INTERACTIVE_HOST_ENV]: "1", GENTLE_DESIGN_OPEN_BROWSER: "0", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1" };
	return {
		command: ctx.nodePath,
		args: [ctx.launcher, ...ctx.homeFlags, "--mode", "rpc", ...(input.sessionId === undefined ? [] : ["--session-id", input.sessionId])],
		cwd: input.cwd,
		env,
	};
}

/**
 * A one-shot prompt (`POST /api/print`): this same launcher and home, run the way the app runs
 * it for commit messages (`--print --no-session --no-tools`), with the prompt on stdin. Never the
 * interactive host: nothing answers its dialogs in a one-shot run.
 */
export function printLaunch(ctx: Pick<ServeCommandContext, "homeFlags" | "launcher" | "nodePath" | "env">, input: { cwd: string; model?: string }): SessionLaunch {
	const env: NodeJS.ProcessEnv = { ...ctx.env, GENTLE_DESIGN_OPEN_BROWSER: "0", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1" };
	delete env[INTERACTIVE_HOST_ENV];
	return {
		command: ctx.nodePath,
		args: [ctx.launcher, ...ctx.homeFlags, "--print", "--no-session", "--no-tools", ...(input.model === undefined ? [] : ["--model", input.model])],
		cwd: input.cwd,
		env,
	};
}

function untilSignal(stopRequested: Promise<void>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => {
		process.off("SIGINT", done);
		process.off("SIGTERM", done);
		process.off("SIGHUP", done);
		resolve();
	};
	process.on("SIGINT", done);
	process.on("SIGTERM", done);
	if (process.platform !== "win32") process.on("SIGHUP", done);
	stopRequested.then(done);
	return promise;
}

function plainHttpWarning(host: string): string {
	return `gentle-shell serve: warning: listening on ${host} over plain HTTP (--no-tls). Device tokens and session traffic cross the network unencrypted; use it only on a network that encrypts by itself, such as a tailnet.\n`;
}

type StartArgs = { host: string; port: number; allowHosts?: readonly string[]; forwardPorts?: PortRange; noTls?: true; relay?: string };

/** The relay secret a server presents: `GENTLE_SHELL_RELAY_SECRET`, else the first line of `<home>/serve/relay-secret`. */
export function relaySecret(env: NodeJS.ProcessEnv, serveDirectory: string): string | undefined {
	const fromEnv = env.GENTLE_SHELL_RELAY_SECRET?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFileSync(join(serveDirectory, "relay-secret"), "utf8").split(/\r?\n/)[0].trim() || undefined;
	} catch {
		return undefined;
	}
}

/** HTTPS on a network listen (unless --no-tls) and always with a relay: the certificate, made on first run. */
function serverTls(ctx: ServeCommandContext, args: StartArgs, serveDirectory: string): ServeTlsIdentity | undefined {
	if (args.noTls || (isLoopbackHost(args.host) && args.relay === undefined)) return undefined;
	const system = ctx.system ?? defaultShareSystem(ctx.env);
	const name = system.hostname();
	const addresses = isUnspecified(args.host) ? shareAddresses(system.networkInterfaces(), name) : [args.host];
	return loadOrCreateServeTls(serveDirectory, {
		commonName: `gentle-shell serve ${name}`,
		dnsNames: ["localhost", ...ownHostNames(name), ...(args.allowHosts ?? [])],
		ips: ["127.0.0.1", "::1", ...addresses],
	});
}

/** Gentle Tower in this process, on 127.0.0.1 with a fresh token: what `gentle-shell tower` runs, never a browser. */
async function startTower(env: NodeJS.ProcessEnv): Promise<ServeTower> {
	const tower = await openTowerServer(env);
	return { port: tower.port, path: new URL(tower.url).pathname, close: () => tower.close() };
}

async function runForeground(ctx: ServeCommandContext, args: StartArgs & { json: boolean }): Promise<number> {
	const result = await serveForeground(ctx, args);
	if (result.restartPort === undefined) return result.code;
	return restartServer(ctx, { ...args, port: result.restartPort });
}

/** Serves until stopped; `restartPort` when it stopped for an upgrade, so the next server takes the same address. */
async function serveForeground(ctx: ServeCommandContext, args: StartArgs & { json: boolean }): Promise<{ code: number; restartPort?: number }> {
	const files = serveFiles(ctx.agentHome);
	privateDir(files.dir);
	const lock = acquireServeLock(files.lock);
	if ("heldBy" in lock) {
		const running = readServerFile(files.server);
		ctx.stderr(`gentle-shell serve: already running${Number.isNaN(lock.heldBy) ? "" : ` (pid ${lock.heldBy})`}${running ? ` at ${running.url}` : ""}\n`);
		return { code: 1 };
	}
	let server: ServeServer | undefined;
	let endSessions = false;
	let restart = false;
	try {
		const tls = serverTls(ctx, args, files.dir);
		if (!isLoopbackHost(args.host) && !tls) ctx.stderr(plainHttpWarning(args.host));
		const secret = args.relay === undefined ? undefined : relaySecret(ctx.env, files.dir);
		const adminToken = `gsa_${randomBytes(32).toString("base64url")}`;
		const auth = new ServeAuth({ devicesFile: files.devices, adminToken });
		const stop = Promise.withResolvers<void>();
		const log = (line: string) => ctx.stderr(`${new Date().toISOString()} ${line}\n`);
		server = await startServeServer({
			host: args.host,
			port: args.port,
			allowHosts: args.allowHosts ?? [],
			...(args.forwardPorts ? { forwardPorts: args.forwardPorts } : {}),
			...(tls ? { tls } : {}),
			...(args.relay === undefined ? {} : { relay: { url: args.relay, ...(secret === undefined ? {} : { secret }) } }),
			startTower: () => startTower(ctx.env),
			serveDir: files.dir,
			agentHome: ctx.agentHome,
			env: ctx.env,
			auth,
			version: ctx.version,
			launchSession: (input) => sessionLaunch(ctx, input),
			launchPrint: (input) => printLaunch(ctx, input),
			log,
			onStopRequested: (request) => { endSessions = request.endSessions; stop.resolve(); },
			upgrade: {
				launch: (channel) => (ctx.upgradeCommand ?? ((chosen: UpgradeChannel | undefined) => upgradeLaunch(ctx, chosen)))(channel),
				installedVersion: () => launcherVersion(ctx.restartLauncher?.() ?? ctx.launcher),
				// Sessions keep running under their keepers; the next server reattaches them.
				onUpgraded: () => { restart = true; stop.resolve(); },
				// Setup installs the home's companion packages, never the launcher: no restart.
				setup: () => (ctx.setupCommand ?? (() => setupLaunch(ctx)))(),
			},
		});
		const file: ServerFile = {
			schema: SERVE_SERVER_FILE_SCHEMA,
			protocol: SERVE_PROTOCOL,
			serverId: server.serverId,
			url: server.url,
			listen: { host: args.host, port: server.port },
			pid: process.pid,
			startedAt: new Date(server.startedAt).toISOString(),
			version: ctx.version,
			adminToken,
			discovery: server.discovery,
			...(args.forwardPorts ? { forwardPorts: args.forwardPorts } : {}),
			...(server.fingerprint === undefined ? {} : { fingerprint: server.fingerprint }),
			...(args.relay === undefined ? {} : { relay: args.relay }),
		};
		writeServerFile(files.server, file);
		if (tls) log(`HTTPS for the network: certificate ${tls.fingerprint}${tls.created ? " (new)" : ""}`);
		if (args.relay !== undefined && secret === undefined) log(`relay: no relay secret (GENTLE_SHELL_RELAY_SECRET or ${join(files.dir, "relay-secret")}); a relay that has one refuses this server`);
		ctx.stdout(args.json
			? `${JSON.stringify({ schema: "gentle-shell.serve/v1", url: server.url, pid: process.pid, serverId: server.serverId, ...(server.fingerprint === undefined ? {} : { fingerprint: server.fingerprint }), ...(args.relay === undefined ? {} : { relay: args.relay }) })}\n`
			: `Gentle Shell server: ${server.url} (pid ${process.pid})\n${server.fingerprint === undefined ? "" : `HTTPS on the network, certificate fingerprint ${server.fingerprint}\n`}${args.relay === undefined ? "" : `Relay: ${args.relay}\n`}Pair a device with 'gentle-shell serve pair'. Press Ctrl+C to stop.\n`);
		await (ctx.untilStopped ?? untilSignal)(stop.promise);
		log(restart ? "stopping to restart on the upgraded version" : "stopping");
		return restart ? { code: 0, restartPort: server.port } : { code: 0 };
	} catch (error) {
		ctx.stderr(`gentle-shell serve: could not start: ${error instanceof Error ? error.message : String(error)}\n`);
		return { code: 1 };
	} finally {
		await server?.close({ endSessions });
		if (readServerFile(files.server)?.pid === process.pid) rmSync(files.server, { force: true });
		releaseServeLock(files.lock);
	}
}

/**
 * After an upgrade, once this server let go of its lock and server file: a
 * service manager starts the upgraded server itself (this process exits with
 * `SERVE_RESTART_EXIT`); otherwise a detached `serve --foreground` on the new
 * version takes the same address, logging to `server.log`.
 */
function restartServer(ctx: ServeCommandContext, args: StartArgs): number {
	const stamp = () => new Date().toISOString();
	if (supervisedServe(ctx.env)) {
		ctx.stderr(`${stamp()} exiting with ${SERVE_RESTART_EXIT}: the service manager starts the upgraded server\n`);
		return SERVE_RESTART_EXIT;
	}
	const files = serveFiles(ctx.agentHome);
	const logFd = openSync(files.log, "a", 0o600);
	try {
		const child = spawn(ctx.nodePath, [ctx.restartLauncher?.() ?? ctx.launcher, ...ctx.homeFlags, ...foregroundArgs(args)], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: ctx.env,
			windowsHide: true,
		});
		child.once("error", (error) => ctx.stderr(`${stamp()} could not restart: ${error.message}\n`));
		child.unref();
		ctx.stderr(`${stamp()} restarted on the upgraded version as pid ${child.pid} (log: ${files.log})\n`);
		return 0;
	} catch (error) {
		ctx.stderr(`${stamp()} could not restart: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		closeSync(logFd);
	}
}

/** `serve --foreground` with the same listen address, hosts, forward ports, TLS choice and relay. */
function foregroundArgs(args: StartArgs): string[] {
	const listen = `${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`;
	const allow = (args.allowHosts ?? []).flatMap((name) => ["--allow-host", name]);
	const ports = args.forwardPorts ? ["--forward-ports", `${args.forwardPorts.from}-${args.forwardPorts.to}`] : [];
	const network = [...(args.noTls ? ["--no-tls"] : []), ...(args.relay === undefined ? [] : ["--relay", args.relay])];
	return ["serve", "--foreground", "--listen", listen, ...allow, ...ports, ...network];
}

async function startDaemon(ctx: ServeCommandContext, args: StartArgs & { json: boolean }): Promise<number> {
	const files = serveFiles(ctx.agentHome);
	const running = liveServer(ctx.agentHome);
	if (running) {
		ctx.stderr(`gentle-shell serve: already running at ${running.url} (pid ${running.pid})\n`);
		return 1;
	}
	const started = await spawnDaemon(ctx, args);
	if ("log" in started) {
		ctx.stderr(`gentle-shell serve: the server did not start.${started.log ? `\n${started.log}` : ""}\n`);
		return 1;
	}
	const file = started.file;
	ctx.stdout(args.json
		? `${JSON.stringify({ schema: "gentle-shell.serve/v1", url: file.url, pid: file.pid, serverId: file.serverId })}\n`
		: `Gentle Shell server: ${file.url} (pid ${file.pid})\nLog: ${files.log}\nPair a device with 'gentle-shell serve pair'; stop with 'gentle-shell serve stop'.\n`);
	return 0;
}

/** Starts `serve --foreground` detached, logging to `server.log`; on failure, the log's tail. */
async function spawnDaemon(ctx: ServeCommandContext, args: StartArgs): Promise<{ file: ServerFile } | { log: string }> {
	const files = serveFiles(ctx.agentHome);
	privateDir(files.dir);
	const logFd = openSync(files.log, "w", 0o600);
	const child = spawn(ctx.nodePath, [ctx.launcher, ...ctx.homeFlags, ...foregroundArgs(args)], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: ctx.env,
		windowsHide: true,
	});
	closeSync(logFd);
	child.unref();
	const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const file = readServerFile(files.server);
		if (file?.pid === child.pid) return { file };
		if (child.exitCode !== null || child.signalCode !== null) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	let log = "";
	try { log = readFileSync(files.log, "utf8").slice(-2000); } catch { /* no log */ }
	return { log };
}

interface ApiResult<T> {
	status: number;
	data: Partial<T> & { error?: { code?: string; message?: string } };
}

interface SessionSummary {
	id: string;
	state: string;
	name: string | null;
	cwd?: string;
	seq: number;
	subscribers: number;
	pendingDialogs: number;
}

async function api<T>(server: ServerFile, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
	const response = await fetch(`${server.url}${path}`, {
		method,
		headers: { Authorization: `Bearer ${server.adminToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(10_000),
	});
	const text = await response.text();
	let data: unknown;
	try { data = text ? JSON.parse(text) : {}; } catch { data = undefined; }
	// The server owning this home's server file answers in its own documented shapes; fields stay optional.
	const shaped = data && typeof data === "object" ? data : { error: { message: text.slice(0, 200) } };
	return { status: response.status, data: shaped as ApiResult<T>["data"] };
}

function apiFailure(ctx: ServeCommandContext, what: string, result: ApiResult<unknown>): number {
	const error = result.data.error;
	ctx.stderr(`gentle-shell serve: ${what} failed (${result.status}${error?.code ? ` ${error.code}` : ""}): ${error?.message ?? "no details"}\n`);
	return 1;
}

function formatDevices(devices: readonly PublicDevice[]): string {
	if (devices.length === 0) return "No paired devices.\n";
	return devices.map((d) => `${d.id}  ${d.name}  [${d.scopes.join(",")}]  paired ${d.createdAt}${d.lastUsedAt ? `, last used ${d.lastUsedAt}` : ""}`).join("\n") + "\n";
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return !processAlive(pid);
}

async function stopServer(ctx: ServeCommandContext, server: ServerFile, endSessions = false): Promise<boolean> {
	const result = await api(server, "POST", "/api/server/stop", { endSessions });
	if (result.status !== 202) process.kill(server.pid, "SIGTERM");
	if (await waitForExit(server.pid, STOP_TIMEOUT_MS)) return true;
	ctx.stderr(`gentle-shell serve: pid ${server.pid} is still running\n`);
	return false;
}

// --- share -------------------------------------------------------------------------

const LAN_HOST = "0.0.0.0";

function canBind(port: number, host: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const probe = createNetServer();
	probe.once("error", () => resolve(false));
	probe.listen(port, host, () => probe.close(() => resolve(true)));
	return promise;
}

/**
 * Whether nothing listens on `port` (a quick probe; the bind can still race).
 * Loopback too: macOS lets a wildcard bind share a port that another server
 * holds on 127.0.0.1, which would then answer this machine's own requests.
 */
async function portFree(port: number): Promise<boolean> {
	return (await canBind(port, LAN_HOST)) && (await canBind(port, "127.0.0.1"));
}

async function runningSessions(server: ServerFile): Promise<number> {
	const list = await api<{ sessions: SessionSummary[] }>(server, "GET", "/api/sessions");
	if (list.status !== 200 || !Array.isArray(list.data.sessions)) throw new Error(`listing its sessions failed (${list.status})`);
	return list.data.sessions.filter((s) => s.state === "running").length;
}

async function waitForServer(agentHome: string, timeoutMs: number, accept: (file: ServerFile) => boolean): Promise<ServerFile | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const file = liveServer(agentHome);
		if (file && accept(file)) return file;
		await new Promise((r) => setTimeout(r, 100));
	}
	return undefined;
}

/**
 * `serve share`: make sure this home's server listens on the local network
 * (start it, reopen a loopback one that runs no sessions, or reuse one already
 * there), mint a pairing code and print the connection code that carries it.
 */
async function runShare(ctx: ServeCommandContext, args: { port: number; always: boolean; json: boolean; noTls?: true; relay?: string }): Promise<number> {
	const system = ctx.system ?? defaultShareSystem(ctx.env);
	const files = serveFiles(ctx.agentHome);
	const fail = (message: string): number => { ctx.stderr(`gentle-shell serve share: ${message}\n`); return 1; };
	if (args.always && !autostartFile(system)) return fail(`--always (start at login) is not supported on ${system.platform === "win32" ? "Windows" : system.platform} yet; run 'gentle-shell serve share' without it.`);
	const allowHosts = ownHostNames(system.hostname());
	const autostartFor = (port: number) => autostartCommand({ nodePath: ctx.nodePath, launcher: ctx.launcher, homeFlags: ctx.homeFlags, port, allowHosts, forwardPorts: SHARE_FORWARD_PORTS,
		...(args.noTls ? { noTls: true } : {}), ...(args.relay === undefined ? {} : { relay: args.relay }), env: ctx.env, logFile: files.log });
	let server = liveServer(ctx.agentHome);
	let opened: "started" | "reopened" | "reused" = "started";
	let atLogin = false;
	try {
		if (server) {
			const lan = !isLoopbackHost(server.listen.host);
			// TLS as asked (a server from before TLS is reopened with it); the relay asked for, when one is (none asked keeps the one it has).
			const sameNetwork = (server.fingerprint !== undefined) === !args.noTls && (args.relay === undefined || server.relay === args.relay);
			atLogin = lan && autostartInstalled(system, autostartFor(server.listen.port));
			if (lan && sameNetwork && (!args.always || atLogin)) {
				opened = "reused";
			} else {
				// Reopening it on the network, or under the service manager, would end its sessions.
				const busy = await runningSessions(server);
				if (busy > 0) {
					return fail(!lan
						? `the server here is reachable from this computer only and has ${busy} running session(s); stop them or run 'gentle-shell serve stop', then run share again to open it to your network.`
						: !sameNetwork
						? `the server has ${busy} running session(s), and changing its TLS or relay settings has to restart it; stop them or run 'gentle-shell serve stop', then try again.`
						: `the server has ${busy} running session(s), and --always has to restart it; stop them or run 'gentle-shell serve stop', then try again.`);
				}
				if (!(await stopServer(ctx, server))) return 1;
				if (!lan) opened = "reopened";
				server = undefined;
			}
		}
		if (!server) {
			const ports = Array.from({ length: SHARE_PORT_ATTEMPTS }, (_, i) => args.port + i).filter((port) => port <= 65535);
			const busyPorts = `port${ports.length > 1 ? `s ${ports[0]}-${ports.at(-1)} are` : ` ${ports[0]} is`} in use; choose another with --port`;
			if (args.always) {
				let port: number | undefined;
				for (const candidate of ports) if (await portFree(candidate)) { port = candidate; break; }
				if (port === undefined) return fail(busyPorts);
				const installed = await installAutostart(system, autostartFor(port));
				if ("error" in installed) return fail(`could not turn on start at login: ${installed.error}`);
				server = await waitForServer(ctx.agentHome, DAEMON_START_TIMEOUT_MS, (file) => !isLoopbackHost(file.listen.host));
				if (!server) return fail(`start at login is on (${installed.file}), but the server did not start; see ${system.platform === "darwin" ? files.log : "journalctl --user -u gentle-shell-serve"}.`);
				atLogin = true;
			} else {
				for (const port of ports) {
					if (!(await portFree(port))) continue;
					const started = await spawnDaemon(ctx, { host: LAN_HOST, port, allowHosts, forwardPorts: SHARE_FORWARD_PORTS, ...(args.noTls ? { noTls: true } : {}), ...(args.relay === undefined ? {} : { relay: args.relay }) });
					if ("file" in started) { server = started.file; break; }
					// Taken between the probe and the bind: try the next one.
					if (!started.log.includes("EADDRINUSE")) return fail(`the server did not start.${started.log ? `\n${started.log}` : ""}`);
				}
				if (!server) return fail(busyPorts);
			}
		}

		const minted = await api<{ code: string; expiresAt: string }>(server, "POST", "/api/pairing-codes", {});
		if (minted.status !== 201 || typeof minted.data.code !== "string") return apiFailure(ctx, "pair", minted);
		const port = server.listen.port;
		const host = server.listen.host;
		const addresses = isUnspecified(host) ? shareAddresses(system.networkInterfaces(), system.hostname()) : [host.includes(":") ? `[${host}]` : host];
		const pairingCode = minted.data.code;
		const fingerprint = server.fingerprint;
		const code = encodeConnectionCode({ id: server.serverId, n: system.hostname(), p: port, a: addresses, c: pairingCode,
			...(fingerprint === undefined ? {} : { fp: fingerprint }), ...(server.relay === undefined ? {} : { r: server.relay }) });
		// A server file from before discovery existed has no flag: that server does not answer it.
		const discovery = server.discovery === true;
		if (args.json) {
			ctx.stdout(`${JSON.stringify({ code, pairingCode, port, addresses, expiresAt: minted.data.expiresAt, serverId: server.serverId, discovery, tls: fingerprint !== undefined,
				...(fingerprint === undefined ? {} : { fingerprint }), ...(server.relay === undefined ? {} : { relay: server.relay }) })}\n`);
			return 0;
		}
		const firewall = firewallHint(system.platform, port, system.has, server.forwardPorts);
		ctx.stdout([
			opened === "reused" ? `The Gentle Shell server is already open to your network on port ${port}.`
			: opened === "reopened" ? `Opened the Gentle Shell server to your network on port ${port} (it was reachable from this computer only).`
			: `Started the Gentle Shell server for your network on port ${port}.`,
			"",
			`  Code: ${pairingCode}`,
			"",
			"In Gentle Shell GPUI → Configuration → Where agents run → Gentle Shell server, enter this code. Valid for 5 minutes, once.",
			"If the app can't find this computer, paste this instead:",
			code,
			"",
			...(discovery ? [] : [`Discovery is off on this server (UDP port ${port} could not be opened), so the app cannot find this computer by itself: paste the long code.`]),
			...(server.relay === undefined ? [] : [`Outside this network the app reaches it through the relay ${server.relay} with the long code (the short code works on this network only).`]),
			fingerprint === undefined
				? "It uses plain HTTP on your network (--no-tls): share only on a network that encrypts by itself."
				: `It uses HTTPS; the app checks this computer's certificate, fingerprint ${fingerprint}.`,
			...(firewall ? [`If the app cannot find or reach this computer, or a page it opens from here, open the ports in the firewall: ${firewall}`] : []),
			...(firewall && !server.forwardPorts ? ["This server gives forwarded pages random ports; to keep them in one range (8800-8899), run 'gentle-shell serve stop' and then 'gentle-shell serve share'."] : []),
			...(atLogin ? ["It starts at every login; turn that off with 'gentle-shell serve share --off'."] : []),
			...(atLogin && system.platform === "linux" ? [`To start it at boot, before anyone logs in: sudo loginctl enable-linger ${system.user}`] : []),
			"",
		].join("\n"));
		return 0;
	} catch (error) {
		return fail(`could not reach the server${server ? ` at ${server.url}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function runShareOff(ctx: ServeCommandContext): Promise<number> {
	const system = ctx.system ?? defaultShareSystem(ctx.env);
	if (!autostartFile(system)) {
		ctx.stdout("Start at login was not on.\n");
		return 0;
	}
	const removed = await removeAutostart(system);
	ctx.stdout(removed.removed ? `Start at login is off (removed ${removed.file}); the server it started has stopped.\n` : "Start at login was not on.\n");
	return 0;
}

export async function runServeCommand(args: ServeArgs, ctx: ServeCommandContext): Promise<number> {
	if (args.action === "help") {
		ctx.stdout(`${SERVE_HELP}\n`);
		return 0;
	}
	if (args.action === "start") return args.foreground ? runForeground(ctx, args) : startDaemon(ctx, args);
	if (args.action === "share") return runShare(ctx, args);
	if (args.action === "share-off") return runShareOff(ctx);
	const files = serveFiles(ctx.agentHome);
	const server = liveServer(ctx.agentHome);

	if (args.action === "devices" && !server) {
		// Without a server the file is the whole state: list or revoke there.
		const devices = readDevicesFile(files.devices);
		if (args.revoke !== undefined) {
			if (!devices.some((d) => d.id === args.revoke)) { ctx.stderr(`gentle-shell serve: no device ${args.revoke}\n`); return 1; }
			writeDevicesFile(files.devices, devices.filter((d) => d.id !== args.revoke));
			ctx.stdout(`Revoked ${args.revoke}.\n`);
			return 0;
		}
		const list = devices.map(({ tokenHash: _h, ...d }) => d);
		ctx.stdout(args.json ? `${JSON.stringify({ devices: list })}\n` : formatDevices(list));
		return 0;
	}
	if (!server) {
		if (args.action === "status" && args.json) ctx.stdout(`${JSON.stringify({ running: false })}\n`);
		else ctx.stderr("gentle-shell serve: not running\n");
		return args.action === "stop" ? 0 : 1;
	}

	try {
		if (args.action === "status") {
			const info = await api<{ protocol: number; tls?: { fingerprint: string }; relay?: { url: string; connected: boolean } }>(server, "GET", "/api/server");
			const list = await api<{ sessions: SessionSummary[] }>(server, "GET", "/api/sessions");
			if (info.status !== 200) return apiFailure(ctx, "status", info);
			const sessions = Array.isArray(list.data.sessions) ? list.data.sessions : [];
			if (args.json) {
				ctx.stdout(`${JSON.stringify({ running: true, url: server.url, pid: server.pid, serverId: server.serverId, protocol: server.protocol, startedAt: server.startedAt, version: server.version,
					...(info.data.tls ? { tls: info.data.tls } : {}), ...(info.data.relay ? { relay: info.data.relay } : {}), sessions })}\n`);
			} else {
				ctx.stdout(`Running at ${server.url} (pid ${server.pid}, since ${server.startedAt}, protocol ${server.protocol})\n`);
				if (info.data.tls) ctx.stdout(`HTTPS on the network, certificate fingerprint ${info.data.tls.fingerprint}\n`);
				if (info.data.relay) ctx.stdout(`Relay ${info.data.relay.url}: ${info.data.relay.connected ? "connected" : "not connected (retrying)"}\n`);
				ctx.stdout(sessions.length === 0 ? "No sessions.\n" : sessions.map((s) => `${s.id}  ${s.state}  ${s.cwd ?? s.name}  seq ${s.seq}, ${s.subscribers} subscriber(s)${s.pendingDialogs ? `, ${s.pendingDialogs} dialog(s) waiting` : ""}`).join("\n") + "\n");
			}
			return 0;
		}
		if (args.action === "stop") {
			if (!(await stopServer(ctx, server, args.endSessions))) return 1;
			ctx.stdout("Stopped.\n");
			return 0;
		}
		if (args.action === "pair") {
			const result = await api<{ code: string; scopes: string[]; expiresAt: string }>(server, "POST", "/api/pairing-codes", { scopes: args.scopes });
			if (result.status !== 201) return apiFailure(ctx, "pair", result);
			const { code, scopes = [], expiresAt } = result.data;
			if (args.json) {
				ctx.stdout(`${JSON.stringify({ code, scopes, expiresAt, url: server.url })}\n`);
			} else {
				ctx.stdout([
					`Pairing code: ${code}`,
					`Server:       ${server.url}`,
					`Scopes:       ${scopes.join(", ")}`,
					`Expires:      ${expiresAt} (single use)`,
					"",
					"Redeem it from the device:",
					`  curl -X POST ${server.url}/api/pair -H 'Content-Type: application/json' -d '{"code":"${code}","name":"my-device"}'`,
					"",
				].join("\n"));
			}
			return 0;
		}
		if (args.revoke !== undefined) {
			const result = await api(server, "DELETE", `/api/devices/${args.revoke}`);
			if (result.status !== 200) return apiFailure(ctx, "revoke", result);
			ctx.stdout(`Revoked ${args.revoke}.\n`);
			return 0;
		}
		const result = await api<{ devices: PublicDevice[] }>(server, "GET", "/api/devices");
		if (result.status !== 200) return apiFailure(ctx, "devices", result);
		ctx.stdout(args.json ? `${JSON.stringify({ devices: result.data.devices ?? [] })}\n` : formatDevices(result.data.devices ?? []));
		return 0;
	} catch (error) {
		ctx.stderr(`gentle-shell serve: could not reach the server at ${server.url}: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
