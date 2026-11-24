// `gentle-shell serve`: argument parsing, the per-user server file and lock
// under `<agent home>/serve`, the foreground server, the detached daemon, and
// the local CLI client (`status`, `stop`, `pair`, `devices`) that talks to the
// running server with the owner-only admin token from the server file.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { INTERACTIVE_HOST_ENV } from "./rpc-host.ts";
import { DEFAULT_PAIR_SCOPES, parseScopes, readDevicesFile, ServeAuth, writeDevicesFile, type PublicDevice, type ServeScope } from "./serve-auth.ts";
import { isLoopbackHost, SERVE_PROTOCOL, startServeServer, type ServeServer } from "./serve-server.ts";
import type { SessionLaunch } from "./serve-session.ts";

export const SERVE_SERVER_FILE_SCHEMA = "gentle-shell.serve.server/v1";
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 0 };
const DAEMON_START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;

// --- arguments -----------------------------------------------------------------

export type ServeArgs =
	| { action: "start"; host: string; port: number; foreground: boolean; json: boolean; allowHosts?: string[] }
	| { action: "status"; json: boolean }
	| { action: "stop" }
	| { action: "pair"; scopes: ServeScope[]; json: boolean }
	| { action: "devices"; revoke?: string; json: boolean }
	| { action: "help" };

export function parseListen(value: string): { host: string; port: number } | { error: string } {
	const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:\s[\]]+))?:(\d{1,5})$/.exec(value) ?? (/^\d{1,5}$/.test(value) ? [value, undefined, undefined, value] : null);
	if (!m) return { error: `--listen needs <host>:<port> (got "${value}")` };
	const port = Number(m[3]);
	if (!(port >= 0 && port <= 65535)) return { error: `--listen port must be 0-65535 (got "${m[3]}")` };
	const host = m[1] !== undefined ? m[1] : m[2] ?? DEFAULT_LISTEN.host;
	return { host: host.toLowerCase() === "localhost" ? "127.0.0.1" : host, port };
}

// One DNS name (no port, no trailing dot) a client may put in the Host header,
// on top of the names the listen address already allows: a tailnet MagicDNS
// name or a LAN DNS name that is not this machine's own hostname.
const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function parseServeArgs(args: readonly string[]): ServeArgs | { error: string } {
	const first = args[0];
	const sub = first === "status" || first === "stop" || first === "pair" || first === "devices" ? first : undefined;
	const rest = sub ? args.slice(1) : args;
	let json = false;
	let foreground = false;
	let listen = DEFAULT_LISTEN;
	let revoke: string | undefined;
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
		return { error: `unknown serve${sub ? ` ${sub}` : ""} argument "${arg}"` };
	}
	if (sub === "status") return { action: "status", json };
	if (sub === "stop") return { action: "stop" };
	if (sub === "devices") return { action: "devices", json, ...(revoke === undefined ? {} : { revoke }) };
	if (sub === "pair") {
		if (scopeValues.length === 0) return { action: "pair", scopes: [...DEFAULT_PAIR_SCOPES], json };
		const parsed = parseScopes(scopeValues);
		return "error" in parsed ? parsed : { action: "pair", scopes: parsed.scopes, json };
	}
	return { action: "start", host: listen.host, port: listen.port, foreground, json, ...(allowHosts.length === 0 ? {} : { allowHosts }) };
}

export const SERVE_HELP = [
	"Usage: gentle-shell [home selectors] serve [--listen <host>:<port>] [--allow-host <name>]... [--foreground] [--json]",
	"       gentle-shell [home selectors] serve status [--json]",
	"       gentle-shell [home selectors] serve stop",
	"       gentle-shell [home selectors] serve pair [--scope <scope,...>] [--json]",
	"       gentle-shell [home selectors] serve devices [--revoke <id>] [--json]",
	"",
	"Runs one server per agent home that owns Gentle Shell sessions (one `--mode rpc` child each)",
	"and lets paired devices drive them over HTTP + Server-Sent Events. Sessions keep running when",
	"clients disconnect. Binds 127.0.0.1 on a random port unless --listen says otherwise; every",
	"request needs a device token (there is no unauthenticated mode). A non-loopback --listen",
	"serves plain HTTP: use it only on a network you trust, or reach a loopback server through",
	"ssh -L or a tunnel.",
	"",
	"  --allow-host     One more name clients may use in the Host header, for example a tailnet",
	"                   MagicDNS name (repeatable). Names not allowed are refused (DNS rebinding).",
	"",
	"  serve            Start the server in the background (--foreground keeps it in this terminal).",
	"  serve status     Show whether the server runs, its URL and its sessions.",
	"  serve stop       Stop the server and every session it owns.",
	"  serve pair       Print a one-time pairing code (single use, 5 minutes). Scopes default to",
	"                   sessions:read,sessions:operate; add admin only for a device you fully trust.",
	"  serve devices    List paired devices; --revoke <id> removes one at once (its streams close).",
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
	return `gentle-shell serve: warning: listening on ${host} over plain HTTP. Device tokens and session traffic cross the network unencrypted; use it only on a network you trust, or keep the default loopback and reach it through ssh -L or a tunnel.\n`;
}

async function runForeground(ctx: ServeCommandContext, args: { host: string; port: number; json: boolean; allowHosts?: readonly string[] }): Promise<number> {
	const files = serveFiles(ctx.agentHome);
	privateDir(files.dir);
	const lock = acquireServeLock(files.lock);
	if ("heldBy" in lock) {
		const running = readServerFile(files.server);
		ctx.stderr(`gentle-shell serve: already running${Number.isNaN(lock.heldBy) ? "" : ` (pid ${lock.heldBy})`}${running ? ` at ${running.url}` : ""}\n`);
		return 1;
	}
	let server: ServeServer | undefined;
	try {
		if (!isLoopbackHost(args.host)) ctx.stderr(plainHttpWarning(args.host));
		const adminToken = `gsa_${randomBytes(32).toString("base64url")}`;
		const auth = new ServeAuth({ devicesFile: files.devices, adminToken });
		const stop = Promise.withResolvers<void>();
		const log = (line: string) => ctx.stderr(`${new Date().toISOString()} ${line}\n`);
		server = await startServeServer({
			host: args.host,
			port: args.port,
			allowHosts: args.allowHosts ?? [],
			auth,
			version: ctx.version,
			launchSession: (input) => sessionLaunch(ctx, input),
			log,
			onStopRequested: () => stop.resolve(),
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
		};
		writeServerFile(files.server, file);
		ctx.stdout(args.json
			? `${JSON.stringify({ schema: "gentle-shell.serve/v1", url: server.url, pid: process.pid, serverId: server.serverId })}\n`
			: `Gentle Shell server: ${server.url} (pid ${process.pid})\nPair a device with 'gentle-shell serve pair'. Press Ctrl+C to stop.\n`);
		await (ctx.untilStopped ?? untilSignal)(stop.promise);
		log("stopping");
		return 0;
	} catch (error) {
		ctx.stderr(`gentle-shell serve: could not start: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		await server?.close();
		if (readServerFile(files.server)?.pid === process.pid) rmSync(files.server, { force: true });
		releaseServeLock(files.lock);
	}
}

async function startDaemon(ctx: ServeCommandContext, args: { host: string; port: number; json: boolean; allowHosts?: readonly string[] }): Promise<number> {
	const files = serveFiles(ctx.agentHome);
	const running = liveServer(ctx.agentHome);
	if (running) {
		ctx.stderr(`gentle-shell serve: already running at ${running.url} (pid ${running.pid})\n`);
		return 1;
	}
	privateDir(files.dir);
	const logFd = openSync(files.log, "w", 0o600);
	const listen = `${args.host.includes(":") ? `[${args.host}]` : args.host}:${args.port}`;
	const allow = (args.allowHosts ?? []).flatMap((name) => ["--allow-host", name]);
	const child = spawn(ctx.nodePath, [ctx.launcher, ...ctx.homeFlags, "serve", "--foreground", "--listen", listen, ...allow], {
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
		if (file?.pid === child.pid) {
			ctx.stdout(args.json
				? `${JSON.stringify({ schema: "gentle-shell.serve/v1", url: file.url, pid: file.pid, serverId: file.serverId })}\n`
				: `Gentle Shell server: ${file.url} (pid ${file.pid})\nLog: ${files.log}\nPair a device with 'gentle-shell serve pair'; stop with 'gentle-shell serve stop'.\n`);
			return 0;
		}
		if (child.exitCode !== null || child.signalCode !== null) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	let tail = "";
	try { tail = readFileSync(files.log, "utf8").slice(-2000); } catch { /* no log */ }
	ctx.stderr(`gentle-shell serve: the server did not start.${tail ? `\n${tail}` : ""}\n`);
	return 1;
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

export async function runServeCommand(args: ServeArgs, ctx: ServeCommandContext): Promise<number> {
	if (args.action === "help") {
		ctx.stdout(`${SERVE_HELP}\n`);
		return 0;
	}
	if (args.action === "start") return args.foreground ? runForeground(ctx, args) : startDaemon(ctx, args);
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
			const info = await api<{ protocol: number }>(server, "GET", "/api/server");
			const list = await api<{ sessions: SessionSummary[] }>(server, "GET", "/api/sessions");
			if (info.status !== 200) return apiFailure(ctx, "status", info);
			const sessions = Array.isArray(list.data.sessions) ? list.data.sessions : [];
			if (args.json) {
				ctx.stdout(`${JSON.stringify({ running: true, url: server.url, pid: server.pid, serverId: server.serverId, protocol: server.protocol, startedAt: server.startedAt, version: server.version, sessions })}\n`);
			} else {
				ctx.stdout(`Running at ${server.url} (pid ${server.pid}, since ${server.startedAt}, protocol ${server.protocol})\n`);
				ctx.stdout(sessions.length === 0 ? "No sessions.\n" : sessions.map((s) => `${s.id}  ${s.state}  ${s.cwd ?? s.name}  seq ${s.seq}, ${s.subscribers} subscriber(s)${s.pendingDialogs ? `, ${s.pendingDialogs} dialog(s) waiting` : ""}`).join("\n") + "\n");
			}
			return 0;
		}
		if (args.action === "stop") {
			const result = await api(server, "POST", "/api/server/stop");
			if (result.status !== 202) process.kill(server.pid, "SIGTERM");
			if (!(await waitForExit(server.pid, STOP_TIMEOUT_MS))) { ctx.stderr(`gentle-shell serve: pid ${server.pid} is still running\n`); return 1; }
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
