// Persistent terminals for `gentle-shell serve`, over a native terminal host
// (`gentle-term-host`): the host owns the PTYs and keeps them alive while no
// client is connected (and across serve restarts); serve starts it on first
// use, talks to it in JSON Lines over its owner-only Unix socket (on Windows,
// loopback TCP with a token from an owner-only file), and exposes the
// terminals to paired devices over HTTP + SSE. One host connection is the
// control connection; every SSE stream gets its own, so each stream has its
// own attachment and backpressure.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { hasScope, type Principal } from "./serve-auth.ts";
import { fsHttpError, HttpError, need, ownsOrAdmin, readJsonBody, realDirectory, receiveBodyToFile, sendJson, sseEvent, startSse } from "./serve-http.ts";

export const TERM_HOST_PROTOCOL = 1;
export const TERM_HOST_BINARY = process.platform === "win32" ? "gentle-term-host.exe" : "gentle-term-host";
/** Where a host started with `--tcp` writes `{ port, token, pid }`, in its state folder. */
export const TERM_HOST_TCP_FILE = "term-host.json";
const OWNERS_SCHEMA = "gentle-shell.serve.terminals/v1";

/** How serve reaches the host: its Unix socket, or loopback TCP with the token the host wrote. */
export type TermHostEndpoint = { path: string } | { port: number; token: string };
export type TermHostTransport = "unix" | "tcp";

/** TCP on Windows (no Unix sockets for the host there); `GENTLE_TERM_HOST_TRANSPORT=tcp` picks it anywhere. */
export function termHostTransport(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): TermHostTransport {
	return platform === "win32" || env.GENTLE_TERM_HOST_TRANSPORT === "tcp" ? "tcp" : "unix";
}

const ASSET_OS: Partial<Record<NodeJS.Platform, string>> = { linux: "linux", darwin: "macos", win32: "windows" };
const ASSET_ARCHS: Partial<Record<NodeJS.Platform, readonly string[]>> = { linux: ["x64", "arm64"], darwin: ["x64", "arm64"], win32: ["x64"] };

/** The Gentle Shell GPUI release asset with the host for this system, `gentle-term-host-<os>-<arch>[.exe]`; null when none is built for it. */
export function termHostAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
	const os = ASSET_OS[platform];
	if (!os || !ASSET_ARCHS[platform]?.includes(arch)) return null;
	return `gentle-term-host-${os}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export const SERVE_TERM_LIMITS = {
	/** One request to the host. */
	requestTimeoutMs: 10_000,
	/** A freshly started host opening its socket. */
	startTimeoutMs: 5_000,
	/** `input` bodies (base64 in JSON). */
	inputBodyBytes: 4 * 1024 * 1024,
	/** A host binary sent with `PUT /api/term-host`. */
	installBytes: 64 * 1024 * 1024,
	/** Unsent bytes of one stream; past it the stream ends with `overflow`. */
	streamQueueBytes: 8 * 1024 * 1024,
	maxCols: 1000,
	maxRows: 500,
	smallBodyBytes: 64 * 1024,
};

/** An error answer from the host: `{ ok: false, error: { code, message } }`. */
export class TermHostError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

function hostHttpError(error: unknown): unknown {
	if (!(error instanceof TermHostError)) return error;
	switch (error.code) {
		case "not_found": return new HttpError(404, "not_found", "No such terminal");
		case "bad_request": return new HttpError(400, "invalid_request", error.message);
		case "exited":
		case "alive": return new HttpError(409, `terminal_${error.code}`, error.message);
		case "spawn_failed": return new HttpError(502, "term_spawn_failed", error.message);
		default: return new HttpError(502, "term_host_error", `${error.code}: ${error.message}`);
	}
}

type HostMessage = Record<string, unknown>;

/** One connection to the host: requests with ids and their replies, plus unsolicited events. */
export class HostConnection {
	private readonly socket: Socket;
	private readonly decoder = new StringDecoder("utf8");
	private buffered = "";
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: HostMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private readonly eventListeners: Array<(event: HostMessage) => void> = [];
	private readonly closeListeners: Array<() => void> = [];
	closed = false;

	private constructor(socket: Socket) {
		this.socket = socket;
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
		socket.on("error", () => { /* close follows */ });
		socket.on("close", () => {
			this.closed = true;
			for (const [id, entry] of this.pending) {
				clearTimeout(entry.timer);
				entry.reject(new HttpError(502, "term_host_gone", "The terminal host closed the connection"));
				this.pending.delete(id);
			}
			for (const listener of this.closeListeners) listener();
		});
	}

	/** Connects, and over TCP authenticates first (`{ op: "auth", token }`); rejects when the host refuses the token. */
	static open(endpoint: TermHostEndpoint, timeoutMs: number): Promise<HostConnection> {
		const { promise, resolve, reject } = Promise.withResolvers<HostConnection>();
		const socket = "path" in endpoint ? connect(endpoint.path) : connect({ host: "127.0.0.1", port: endpoint.port });
		const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })); }, timeoutMs);
		socket.once("error", (error) => { clearTimeout(timer); reject(error); });
		socket.once("connect", () => {
			clearTimeout(timer);
			const conn = new HostConnection(socket);
			if ("path" in endpoint) return resolve(conn);
			conn.request("auth", { token: endpoint.token }, timeoutMs).then(() => resolve(conn), (error: unknown) => {
				conn.close();
				reject(error);
			});
		});
		return promise;
	}

	private receive(text: string): void {
		this.buffered += text;
		let newline = this.buffered.indexOf("\n");
		while (newline !== -1) {
			const line = this.buffered.slice(0, newline).replace(/\r$/, "");
			this.buffered = this.buffered.slice(newline + 1);
			newline = this.buffered.indexOf("\n");
			if (line.trim() === "") continue;
			let message: unknown;
			try { message = JSON.parse(line); } catch { continue; }
			if (!message || typeof message !== "object" || Array.isArray(message)) continue;
			const record = message as HostMessage;
			if (typeof record.ev === "string") {
				for (const listener of this.eventListeners) listener(record);
				continue;
			}
			const entry = typeof record.id === "number" ? this.pending.get(record.id) : undefined;
			if (!entry) continue;
			this.pending.delete(record.id as number);
			clearTimeout(entry.timer);
			if (record.ok === true) entry.resolve(record);
			else {
				const error = record.error && typeof record.error === "object" ? record.error as { code?: unknown; message?: unknown } : {};
				entry.reject(new TermHostError(typeof error.code === "string" ? error.code : "error", typeof error.message === "string" ? error.message : "The terminal host refused the request"));
			}
		}
	}

	request(op: string, params: HostMessage, timeoutMs: number): Promise<HostMessage> {
		if (this.closed) return Promise.reject(new HttpError(502, "term_host_gone", "The terminal host closed the connection"));
		const { promise, resolve, reject } = Promise.withResolvers<HostMessage>();
		const id = this.nextId++;
		const timer = setTimeout(() => {
			this.pending.delete(id);
			reject(new HttpError(504, "term_host_timeout", `The terminal host did not answer ${op} in time`));
		}, timeoutMs);
		this.pending.set(id, { resolve, reject, timer });
		this.socket.write(`${JSON.stringify({ ...params, id, op })}\n`);
		return promise;
	}

	onEvent(listener: (event: HostMessage) => void): void {
		this.eventListeners.push(listener);
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	close(): void {
		this.socket.destroy();
	}
}

/** Whether `path` is a file this process may execute. */
function executable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

interface TermStream {
	deviceId: string;
	res: ServerResponse;
	conn: HostConnection;
}

export interface TerminalServiceOptions {
	/** `<agent home>/serve`: the socket (or `term/term-host.json` over TCP), the installed binary, the ownership file and the host's log live here. */
	serveDir: string;
	/** The environment the host starts with, and where `GENTLE_TERM_HOST`, `GENTLE_TERM_HOST_TRANSPORT` and `PATH` are read. */
	env: NodeJS.ProcessEnv;
	limits?: Partial<typeof SERVE_TERM_LIMITS>;
	log?: (line: string) => void;
}

export class TerminalService {
	private readonly serveDir: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly limits: typeof SERVE_TERM_LIMITS;
	private readonly log: (line: string) => void;
	readonly transport: TermHostTransport;
	readonly socketPath: string;
	private readonly stateDir: string;
	/** Where a TCP host writes its port and token. */
	private readonly tcpFile: string;
	private readonly ownersFile: string;
	/** Which device opened each terminal; kept on disk because terminals outlive this process. */
	private owners: Record<string, string>;
	private control?: HostConnection;
	private hello?: HostMessage;
	private connecting?: Promise<HostConnection>;
	private readonly streams = new Set<TermStream>();
	private closed = false;

	constructor(options: TerminalServiceOptions) {
		this.serveDir = options.serveDir;
		this.env = options.env;
		this.limits = { ...SERVE_TERM_LIMITS, ...options.limits };
		this.log = options.log ?? (() => {});
		this.transport = termHostTransport(this.env);
		this.socketPath = join(this.serveDir, "term.sock");
		this.stateDir = join(this.serveDir, "term");
		this.tcpFile = join(this.stateDir, TERM_HOST_TCP_FILE);
		this.ownersFile = join(this.serveDir, "terminals.json");
		this.owners = this.readOwners();
	}

	/** Where the installed binary goes. */
	installPath(): string {
		return join(this.serveDir, "bin", TERM_HOST_BINARY);
	}

	/** The host binary: `$GENTLE_TERM_HOST`, else the installed one, else the first on `PATH`; undefined when there is none. */
	binary(): string | undefined {
		const configured = this.env.GENTLE_TERM_HOST;
		if (configured) return executable(configured) ? configured : undefined;
		if (executable(this.installPath())) return this.installPath();
		for (const dir of (this.env.PATH ?? "").split(delimiter)) {
			if (dir && executable(join(dir, TERM_HOST_BINARY))) return join(dir, TERM_HOST_BINARY);
		}
		return undefined;
	}

	/** Where the host is reached: its socket, or the port and token it wrote (undefined before it has). */
	private endpoint(): TermHostEndpoint | undefined {
		if (this.transport === "unix") return { path: this.socketPath };
		try {
			const parsed = JSON.parse(readFileSync(this.tcpFile, "utf8")) as { port?: unknown; token?: unknown };
			const port = parsed.port;
			if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || typeof parsed.token !== "string" || parsed.token === "") return undefined;
			return { port, token: parsed.token };
		} catch {
			return undefined;
		}
	}

	/** Whether a host may be running: its socket or its port file is there. */
	private hostMayRun(): boolean {
		return existsSync(this.transport === "unix" ? this.socketPath : this.tcpFile);
	}

	private readOwners(): Record<string, string> {
		try {
			const parsed = JSON.parse(readFileSync(this.ownersFile, "utf8")) as { schema?: unknown; owners?: unknown };
			if (parsed.schema !== OWNERS_SCHEMA || !parsed.owners || typeof parsed.owners !== "object") return {};
			return Object.fromEntries(Object.entries(parsed.owners).filter((e): e is [string, string] => typeof e[1] === "string"));
		} catch {
			return {};
		}
	}

	private saveOwners(): void {
		mkdirSync(this.serveDir, { recursive: true, mode: 0o700 });
		const temp = `${this.ownersFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ schema: OWNERS_SCHEMA, owners: this.owners }, null, "\t")}\n`, { mode: 0o600 });
		renameSync(temp, this.ownersFile);
	}

	/** The control connection, starting the host when nothing answers on the socket (or port). */
	private ensureHost(): Promise<HostConnection> {
		if (this.closed) return Promise.reject(new HttpError(503, "shutting_down", "The server is stopping"));
		if (this.control && !this.control.closed) return Promise.resolve(this.control);
		this.connecting ??= this.connectOrStart().finally(() => { this.connecting = undefined; });
		return this.connecting;
	}

	private async connectOrStart(): Promise<HostConnection> {
		let stale = false;
		const endpoint = this.endpoint();
		let conn = endpoint && await HostConnection.open(endpoint, this.limits.requestTimeoutMs).catch((error: NodeJS.ErrnoException) => {
			stale = error.code === "ECONNREFUSED" || error instanceof TermHostError;
			return undefined;
		});
		if (!conn) {
			const bin = this.binary();
			if (!bin) throw new HttpError(501, "term_host_missing", `No terminal host on the server: install ${TERM_HOST_BINARY} (PUT /api/term-host) or set GENTLE_TERM_HOST`);
			// A socket nothing listens on, or a port file whose host is gone (or refuses its token), is left from a host that died.
			if (stale) rmSync(this.transport === "unix" ? this.socketPath : this.tcpFile, { force: true });
			conn = await this.start(bin);
		}
		const hello = await conn.request("hello", {}, this.limits.requestTimeoutMs);
		if (hello.protocol !== TERM_HOST_PROTOCOL) {
			conn.close();
			throw new HttpError(502, "term_host_protocol", `The terminal host speaks protocol ${String(hello.protocol)}, not ${TERM_HOST_PROTOCOL}`);
		}
		this.hello = hello;
		this.control = conn;
		conn.onClose(() => {
			if (this.control === conn) {
				this.control = undefined;
				this.hello = undefined;
			}
		});
		return conn;
	}

	/** Starts the host detached (it outlives this server) and waits for its socket (or port file). */
	private async start(bin: string): Promise<HostConnection> {
		mkdirSync(this.serveDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
		// The host keeps its own log in the state folder; this catches what it prints before it opens it.
		const logPath = join(this.stateDir, "term-host.log");
		const logFd = openSync(logPath, "a", 0o600);
		const listen = this.transport === "unix" ? ["--socket", this.socketPath] : ["--tcp"];
		const child = spawn(bin, [...listen, "--state-dir", this.stateDir], { detached: true, stdio: ["ignore", logFd, logFd], env: this.env, windowsHide: true });
		closeSync(logFd);
		let failure: Error | undefined;
		child.once("error", (error) => { failure = error; });
		child.unref();
		this.log(`terminal host started: ${bin} (pid ${child.pid ?? "?"})`);
		const deadline = Date.now() + this.limits.startTimeoutMs;
		while (Date.now() < deadline) {
			if (failure || child.exitCode !== null || child.signalCode !== null) break;
			const endpoint = this.endpoint();
			const conn = endpoint && await HostConnection.open(endpoint, 1000).catch(() => undefined);
			if (conn) return conn;
			await new Promise((r) => setTimeout(r, 50));
		}
		let tail = "";
		try { tail = readFileSync(logPath, "utf8").slice(-1000).trim(); } catch { /* no log */ }
		throw new HttpError(503, "term_host_failed", `The terminal host did not start${failure ? `: ${failure.message}` : ""}${tail ? `\n${tail}` : ""}`);
	}

	private async call(op: string, params: HostMessage = {}): Promise<HostMessage> {
		const conn = await this.ensureHost();
		try {
			return await conn.request(op, params, this.limits.requestTimeoutMs);
		} catch (error) {
			throw hostHttpError(error);
		}
	}

	/** `/api/term-host` and `/api/terminals/*`; false for any other path. */
	async route(req: IncomingMessage, res: ServerResponse, method: string, path: string, url: URL, principal: Principal | undefined): Promise<boolean> {
		if (path === "/api/term-host") {
			if (method === "PUT") await this.install(req, res, need(principal, "admin"));
			else if (method === "GET") await this.status(res, need(principal, "terminal"));
			else throw new HttpError(405, "method_not_allowed", "Use GET or PUT");
			return true;
		}
		if (path === "/api/terminals") {
			if (method === "GET") await this.list(res, need(principal, "terminal"));
			else if (method === "POST") await this.open(req, res, need(principal, "terminal"));
			else throw new HttpError(405, "method_not_allowed", "Use GET or POST");
			return true;
		}
		const one = /^\/api\/terminals\/(t_[A-Za-z0-9]{1,64})(?:\/(input|resize|stream))?$/.exec(path);
		if (!one) return false;
		const who = need(principal, "terminal");
		const term = one[1];
		if (!ownsOrAdmin(who, this.owners[term] ?? "")) throw new HttpError(404, "not_found", "No such terminal");
		const expect = (wanted: string) => { if (method !== wanted) throw new HttpError(405, "method_not_allowed", `Use ${wanted}`); };
		switch (one[2]) {
			case undefined: expect("DELETE"); await this.remove(res, term); break;
			case "input": expect("POST"); await this.input(req, res, term); break;
			case "resize": expect("POST"); await this.resize(req, res, term); break;
			default: expect("GET"); await this.stream(req, res, url, term, who); break;
		}
		return true;
	}

	private view(entry: HostMessage) {
		const term = String(entry.term);
		return {
			id: term,
			pid: entry.pid,
			cwd: entry.cwd,
			argv: entry.argv,
			cols: entry.cols,
			rows: entry.rows,
			title: entry.title ?? "",
			alive: entry.alive,
			...(entry.exitCode === undefined || entry.exitCode === null ? {} : { exitCode: entry.exitCode }),
			createdAt: entry.createdAt,
			offset: entry.offset,
			owner: this.owners[term] ?? null,
		};
	}

	/** Every terminal the host has, with owners no longer on the host forgotten. */
	private async hostTerms(): Promise<HostMessage[]> {
		const listed = await this.call("list");
		const terms = Array.isArray(listed.terms) ? listed.terms.filter((t): t is HostMessage => !!t && typeof t === "object" && typeof (t as HostMessage).term === "string") : [];
		const known = new Set(terms.map((t) => String(t.term)));
		const stale = Object.keys(this.owners).filter((term) => !known.has(term));
		if (stale.length > 0) {
			for (const term of stale) delete this.owners[term];
			this.saveOwners();
		}
		return terms;
	}

	private async list(res: ServerResponse, who: Principal): Promise<void> {
		const terms = await this.hostTerms();
		sendJson(res, 200, { terminals: terms.filter((t) => ownsOrAdmin(who, this.owners[String(t.term)] ?? "")).map((t) => this.view(t)) });
	}

	private async open(req: IncomingMessage, res: ServerResponse, who: Principal): Promise<void> {
		const body = await readJsonBody(req, this.limits.smallBodyBytes);
		const cwd = realDirectory(body.cwd);
		const cols = size(body.cols, "cols", this.limits.maxCols);
		const rows = size(body.rows, "rows", this.limits.maxRows);
		const params: HostMessage = { cwd, cols, rows };
		if (body.argv !== undefined) {
			if (!Array.isArray(body.argv) || body.argv.length === 0 || body.argv.length > 256 || !body.argv.every((a) => typeof a === "string" && !a.includes("\0") && a.length <= 32_768)) {
				throw new HttpError(400, "invalid_argv", "argv must be 1-256 strings without NUL");
			}
			params.argv = body.argv;
		}
		if (body.env !== undefined) {
			if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)) throw new HttpError(400, "invalid_env", "env must be an object of strings");
			const entries = Object.entries(body.env);
			if (entries.length > 128 || !entries.every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === "string" && !v.includes("\0") && v.length <= 32_768)) {
				throw new HttpError(400, "invalid_env", "env must map at most 128 variable names to strings");
			}
			params.env = body.env;
		}
		const opened = await this.call("open", params);
		const term = String(opened.term);
		this.owners[term] = who.deviceId;
		this.saveOwners();
		this.log(`terminal ${term} opened for ${who.deviceId} in ${cwd}`);
		const entry = (await this.hostTerms()).find((t) => t.term === term) ?? { term, pid: opened.pid, cwd, argv: params.argv ?? null, cols, rows, alive: true, offset: 0 };
		sendJson(res, 201, { terminal: this.view(entry) });
	}

	private async input(req: IncomingMessage, res: ServerResponse, term: string): Promise<void> {
		const body = await readJsonBody(req, this.limits.inputBodyBytes);
		if (typeof body.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new HttpError(400, "invalid_data", "data must be base64");
		await this.call("write", { term, data: body.data });
		sendJson(res, 200, { ok: true });
	}

	private async resize(req: IncomingMessage, res: ServerResponse, term: string): Promise<void> {
		const body = await readJsonBody(req, this.limits.smallBodyBytes);
		await this.call("resize", { term, cols: size(body.cols, "cols", this.limits.maxCols), rows: size(body.rows, "rows", this.limits.maxRows) });
		sendJson(res, 200, { ok: true });
	}

	/** Closes a running terminal (SIGHUP, then a kill of its process group after 3 s) or forgets an exited one. */
	private async remove(res: ServerResponse, term: string): Promise<void> {
		await this.closeTerm(term);
		sendJson(res, 200, { closed: term });
	}

	private async closeTerm(term: string): Promise<void> {
		const entry = (await this.hostTerms()).find((t) => t.term === term);
		if (entry) {
			await this.call(entry.alive === true ? "close" : "forget", { term }).catch((error: unknown) => {
				if (!(error instanceof HttpError && error.status === 404)) throw error;
			});
		}
		delete this.owners[term];
		this.saveOwners();
	}

	private async stream(req: IncomingMessage, res: ServerResponse, url: URL, term: string, who: Principal): Promise<void> {
		const raw = url.searchParams.get("from") ?? (typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null);
		let from: number | undefined;
		if (raw !== null && raw !== "") {
			if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, "invalid_from", "from must be a byte offset");
			from = Number(raw);
		}
		await this.ensureHost();
		const endpoint = this.endpoint();
		const conn = endpoint && await HostConnection.open(endpoint, this.limits.requestTimeoutMs).catch(() => undefined);
		if (!conn) throw new HttpError(502, "term_host_gone", "The terminal host is not answering");
		const entry: TermStream = { deviceId: who.deviceId, res, conn };
		// Events that arrive before the attach reply wait for it, so `attached` always comes first.
		const early: HostMessage[] = [];
		let attached = false;
		const forward = (event: HostMessage) => {
			if (event.term !== term || res.writableEnded) return;
			if (!attached) return void early.push(event);
			if (res.writableLength > this.limits.streamQueueBytes || event.ev === "overflow") {
				return this.stopStream(entry, sseEvent("overflow", { reason: event.ev === "overflow" ? "host" : "slow_client" }));
			}
			switch (event.ev) {
				case "output": res.write(sseEvent("output", { offset: event.offset, data: event.data }, String(event.offset))); break;
				case "title": res.write(sseEvent("title", { title: event.title })); break;
				case "resized": res.write(sseEvent("resized", { cols: event.cols, rows: event.rows })); break;
				case "exit": this.stopStream(entry, sseEvent("exit", { code: event.code ?? null })); break;
				default: break;
			}
		};
		conn.onEvent(forward);
		let reply: HostMessage;
		try {
			reply = await conn.request("attach", { term, ...(from === undefined ? {} : { from }) }, this.limits.requestTimeoutMs);
		} catch (error) {
			conn.close();
			throw hostHttpError(error);
		}
		this.streams.add(entry);
		startSse(req, res);
		res.write(`retry: 3000\n\n${sseEvent("attached", { offset: reply.offset, ...(typeof reply.snapshot === "string" ? { snapshot: reply.snapshot } : {}) }, String(reply.offset))}`);
		attached = true;
		for (const event of early.splice(0)) forward(event);
		conn.onClose(() => this.stopStream(entry, sseEvent("error", { code: "term_host_gone", message: "The terminal host closed the connection" })));
		res.on("close", () => this.stopStream(entry));
	}

	private stopStream(entry: TermStream, last?: string): void {
		if (!this.streams.delete(entry)) return;
		entry.conn.close();
		if (!entry.res.writableEnded) entry.res.end(last);
	}

	/** `GET /api/term-host`: whether a binary is there and whether the host runs (connecting, never starting it), and which release asset fits this server. */
	private async status(res: ServerResponse, who: Principal): Promise<void> {
		const bin = this.binary();
		if (!(this.control && !this.control.closed) && this.hostMayRun()) await this.ensureHost().catch(() => undefined);
		const running = !!(this.control && !this.control.closed);
		sendJson(res, 200, {
			available: bin !== undefined,
			// The binary's location is the server's business: only for an admin.
			...(bin !== undefined && hasScope(who, "admin") ? { path: bin } : {}),
			running,
			...(running && this.hello ? { version: this.hello.version ?? null, pid: this.hello.pid ?? null, protocol: this.hello.protocol } : {}),
			platform: process.platform,
			arch: process.arch,
			asset: termHostAsset(),
			transport: this.transport,
		});
	}

	/** `PUT /api/term-host`: installs a host binary into `<serve>/bin`, checked against `x-sha256`. */
	private async install(req: IncomingMessage, res: ServerResponse, who: Principal): Promise<void> {
		const expected = req.headers["x-sha256"];
		if (typeof expected !== "string" || !/^[0-9a-fA-F]{64}$/.test(expected)) {
			req.resume();
			throw new HttpError(400, "invalid_sha256", "The x-sha256 header must carry the binary's sha256 (64 hex digits)");
		}
		const target = this.installPath();
		const dir = join(this.serveDir, "bin");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const temp = join(dir, `.${TERM_HOST_BINARY}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			const received = await receiveBodyToFile(req, temp, this.limits.installBytes, 0o700).catch((error: unknown) => { throw fsHttpError(error, target); });
			if (received.size === 0) throw new HttpError(400, "empty", "The body is empty");
			if (received.sha256 !== expected.toLowerCase()) throw new HttpError(400, "sha256_mismatch", `The body's sha256 is ${received.sha256}`);
			await chmod(temp, 0o755);
			// Windows won't replace a running .exe but lets it be renamed: the old one moves aside, and goes on a later install once nothing runs it.
			if (process.platform === "win32") {
				for (const name of await readdir(dir)) if (name.endsWith(".old")) await rm(join(dir, name), { force: true }).catch(() => undefined);
				await rename(target, `${target}.${randomBytes(6).toString("hex")}.old`).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
			}
			await rename(temp, target);
			this.log(`terminal host installed by ${who.deviceId}: ${target} (${received.size} bytes, sha256 ${received.sha256})`);
			sendJson(res, 201, { path: target, sha256: received.sha256, size: received.size, active: this.binary() === target });
		} finally {
			await rm(temp, { force: true });
		}
	}

	heartbeat(): void {
		for (const entry of this.streams) entry.res.write(": ping\n\n");
	}

	/** A revoked device: its streams end and its terminals are closed. */
	closeDevice(deviceId: string): void {
		for (const entry of [...this.streams]) if (entry.deviceId === deviceId) this.stopStream(entry);
		// Its terminals live only in a running host: never start one just to close nothing.
		const terms = this.hostMayRun() ? Object.entries(this.owners).filter(([, owner]) => owner === deviceId).map(([term]) => term) : [];
		for (const term of terms) {
			void this.closeTerm(term).catch((error: unknown) => this.log(`terminal ${term}: close on revoke failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	}

	/** The server is stopping: streams and connections close; the host and its terminals keep running. */
	closeAll(): void {
		this.closed = true;
		for (const entry of [...this.streams]) this.stopStream(entry);
		this.control?.close();
	}
}

function size(value: unknown, name: string, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new HttpError(400, `invalid_${name}`, `${name} must be a whole number 1-${max}`);
	return value;
}
