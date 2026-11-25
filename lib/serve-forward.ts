// Authenticated port forwarding for `gentle-shell serve`: a web page that
// lives on the server's loopback (the design canvas, a dev server the agent
// started, Gentle Tower) opened from another machine. Each forward is its own
// listener on the server's listen address, so the page's absolute paths keep
// working, and it proxies only to 127.0.0.1:<port> or [::1]:<port>.
//
// A forward belongs to one device. Its first request carries a single-use
// ticket (`gs_ticket`, 60 s); the listener answers with a redirect that drops
// the ticket and sets a per-forward cookie (`gs_fwd_<id>`), which every later
// request needs. Browsers share cookies across ports, so the name is the
// forward's own and the proxy strips every `gs_fwd_*` cookie and the ticket
// before the target sees the request. Zero dependencies: `http` and `net`.

import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { hashSecret } from "./serve-auth.ts";

export const SERVE_FORWARD_LIMITS = {
	ticketTtlMs: 60_000,
	maxTickets: 256,
	/** A forward with no open connection and no request for this long is closed. */
	idleMs: 12 * 60 * 60_000,
	sweepMs: 60_000,
	/** Forwards open at once, across devices. */
	maxForwards: 32,
	/** Open client connections per forward; more are refused at accept. */
	maxConnections: 64,
	/** Browser sessions (cookies) one forward keeps; the oldest is dropped past this. */
	maxCookies: 32,
	/** Connecting to the page on the server. */
	connectTimeoutMs: 10_000,
	/** The browser sending a request's headers. */
	headersTimeoutMs: 20_000,
	/** An idle keep-alive connection from the browser. */
	keepAliveTimeoutMs: 5_000,
};

export const FORWARD_TICKET_PARAM = "gs_ticket";
export const FORWARD_COOKIE_PREFIX = "gs_fwd_";

/** A session's page (closed with it), Gentle Tower, or a server-level page such as Engram (`POST /api/forwards`). */
export type ForwardKind = "session" | "tower" | "server";

export interface ForwardInfo {
	id: string;
	/** The page's port on the server's loopback. */
	port: number;
	/** The forward's own port on the server's listen address. */
	listenPort: number;
	deviceId: string;
	/** The session it belongs to; null for Gentle Tower's and server-level ones. */
	sessionId: string | null;
	kind: ForwardKind;
	createdAt: number;
	lastUsedAt: number;
}

export class ForwardError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export interface ForwardManagerOptions {
	/** The main server's bind address: forwards listen on the same one. */
	bindHost: string;
	/** The Host header check for a listener on `port` (the main server's rules). */
	hostCheck: (port: number) => (host: string) => boolean;
	/** Listen ports to take forwards from (inclusive); OS-assigned when absent. */
	portRange?: { from: number; to: number };
	now?: () => number;
	log?: (line: string) => void;
	limits?: Partial<typeof SERVE_FORWARD_LIMITS>;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1), never passed through a proxy. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

const OWN_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

type Upstream = "127.0.0.1" | "::1";
const literal = (host: Upstream) => (host === "::1" ? "[::1]" : host);

interface ForwardState {
	info: ForwardInfo;
	server: Server;
	hostOk: (host: string) => boolean;
	sockets: Set<Socket>;
	/** sha256 (hex) of each cookie secret, oldest first. */
	cookies: Set<string>;
	/** Which loopback address answered last; probed again after a refusal. */
	upstream?: Upstream;
}

interface TicketEntry {
	forwardId: string;
	deviceId: string;
	expiresAt: number;
}

/** The Connection header's own hop-by-hop names, plus the fixed ones. */
function hopHeaders(headers: IncomingMessage["headers"]): Set<string> {
	const names = new Set(HOP_BY_HOP);
	const connection = headers.connection;
	if (typeof connection === "string") for (const token of connection.split(",")) if (token.trim()) names.add(token.trim().toLowerCase());
	return names;
}

/** Every cookie except the forwards' own, joined as the browser sent them; undefined when none is left. */
export function stripForwardCookies(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const kept = header.split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith(FORWARD_COOKIE_PREFIX));
	return kept.length === 0 ? undefined : kept.join("; ");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

/** The request target without the ticket parameter, and the ticket (when present). */
export function splitTicket(rawUrl: string): { path: string; ticket?: string } {
	const q = rawUrl.indexOf("?");
	if (q === -1) return { path: rawUrl };
	let ticket: string | undefined;
	const kept: string[] = [];
	for (const param of rawUrl.slice(q + 1).split("&")) {
		if (param.startsWith(`${FORWARD_TICKET_PARAM}=`)) ticket = param.slice(FORWARD_TICKET_PARAM.length + 1);
		else if (param !== "") kept.push(param);
	}
	return { path: rawUrl.slice(0, q) + (kept.length ? `?${kept.join("&")}` : ""), ...(ticket === undefined ? {} : { ticket }) };
}

function plain(res: ServerResponse, status: number, text: string, extra: OutgoingHttpHeaders = {}): void {
	if (res.headersSent) { res.destroy(); return; }
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...OWN_HEADERS, ...extra });
	res.end(text);
}

function refuseUpgrade(socket: Socket, status: number, reason: string): void {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listenOn(server: Server, port: number, host: string): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const onError = (error: Error) => reject(error);
	server.once("error", onError);
	server.listen(port, host, () => {
		server.off("error", onError);
		const address = server.address();
		resolve(typeof address === "object" && address ? address.port : port);
	});
	return promise;
}

function canConnect(host: Upstream, port: number, timeoutMs: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ host, port });
	const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
	socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
	socket.once("error", () => { clearTimeout(timer); resolve(false); });
	return promise;
}

export class ForwardManager {
	private readonly options: ForwardManagerOptions;
	private readonly limits: typeof SERVE_FORWARD_LIMITS;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly forwards = new Map<string, ForwardState>();
	/** Keyed by the ticket's hash. */
	private readonly tickets = new Map<string, TicketEntry>();
	private readonly sweep: NodeJS.Timeout;
	private closed = false;

	constructor(options: ForwardManagerOptions) {
		this.options = options;
		this.limits = { ...SERVE_FORWARD_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.sweep = setInterval(() => this.closeIdle(), this.limits.sweepMs);
		this.sweep.unref();
	}

	/** Ports the forwards listen on: never a target (a forward to a forward loops). */
	listenPorts(): number[] {
		return [...this.forwards.values()].map((f) => f.info.listenPort);
	}

	list(filter: { deviceId?: string; sessionId?: string | null; kind?: ForwardKind } = {}): ForwardInfo[] {
		return [...this.forwards.values()].map((f) => f.info).filter((f) =>
			(filter.deviceId === undefined || f.deviceId === filter.deviceId)
			&& (filter.sessionId === undefined || f.sessionId === filter.sessionId)
			&& (filter.kind === undefined || f.kind === filter.kind));
	}

	get(id: string): ForwardInfo | undefined {
		return this.forwards.get(id)?.info;
	}

	/**
	 * The device's forward to `port` for this session (or Gentle Tower), opened
	 * when it has none. A forward belongs to one session so that it closes with it.
	 */
	async open(input: { deviceId: string; sessionId: string | null; kind: ForwardKind; port: number }): Promise<{ forward: ForwardInfo; created: boolean }> {
		if (this.closed) throw new ForwardError(503, "shutting_down", "The server is stopping");
		const existing = this.list({ deviceId: input.deviceId, sessionId: input.sessionId, kind: input.kind }).find((f) => f.port === input.port);
		if (existing) {
			existing.lastUsedAt = this.now();
			return { forward: existing, created: false };
		}
		if (this.forwards.size >= this.limits.maxForwards) throw new ForwardError(429, "too_many_forwards", `At most ${this.limits.maxForwards} forwards are open at once; close one first`);
		const id = `fwd_${randomBytes(8).toString("hex")}`;
		const state: ForwardState = {
			info: { id, port: input.port, listenPort: 0, deviceId: input.deviceId, sessionId: input.sessionId, kind: input.kind, createdAt: this.now(), lastUsedAt: this.now() },
			server: createServer(),
			hostOk: () => false,
			sockets: new Set(),
			cookies: new Set(),
		};
		const server = state.server;
		server.headersTimeout = this.limits.headersTimeoutMs;
		server.requestTimeout = 0; // streams (SSE) stay open
		server.keepAliveTimeout = this.limits.keepAliveTimeoutMs;
		server.maxConnections = this.limits.maxConnections;
		server.on("connection", (socket: Socket) => {
			state.sockets.add(socket);
			socket.on("close", () => state.sockets.delete(socket));
		});
		server.on("request", (req: IncomingMessage, res: ServerResponse) => this.handle(state, req, res));
		server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(state, req, socket, head));
		server.on("clientError", (_error, socket: Socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); else socket.destroy(); });
		const host = this.options.bindHost.replace(/^\[|\]$/g, "");
		state.info.listenPort = await this.bind(server, host);
		if (this.closed) {
			server.close();
			throw new ForwardError(503, "shutting_down", "The server is stopping");
		}
		state.hostOk = this.options.hostCheck(state.info.listenPort);
		this.forwards.set(id, state);
		this.log(`forward ${id}: :${state.info.listenPort} → loopback:${input.port} for ${input.deviceId}${input.sessionId ? ` (${input.sessionId})` : ` (${input.kind})`}`);
		return { forward: state.info, created: true };
	}

	private async bind(server: Server, host: string): Promise<number> {
		const range = this.options.portRange;
		if (!range) return listenOn(server, 0, host);
		const taken = new Set(this.listenPorts());
		for (let port = range.from; port <= range.to; port += 1) {
			if (taken.has(port)) continue;
			try {
				return await listenOn(server, port, host);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
			}
		}
		throw new ForwardError(503, "no_forward_port", `Every port in the forward range ${range.from}-${range.to} is in use`);
	}

	/** A single-use ticket for the forward's first request, bound to the forward and its device. */
	mintTicket(forwardId: string): { ticket: string; expiresAt: number } {
		const state = this.forwards.get(forwardId);
		if (!state) throw new ForwardError(404, "not_found", "No such forward");
		this.pruneTickets();
		const ticket = randomBytes(24).toString("base64url");
		const expiresAt = this.now() + this.limits.ticketTtlMs;
		this.tickets.set(hashSecret(ticket).toString("hex"), { forwardId, deviceId: state.info.deviceId, expiresAt });
		while (this.tickets.size > this.limits.maxTickets) this.tickets.delete(this.tickets.keys().next().value!);
		return { ticket, expiresAt };
	}

	/** The URL a browser opens: the host the client used, the forward's port, the page's path and the ticket. */
	urlFor(forwardId: string, clientHost: string, path: string, ticket: string): string {
		const state = this.forwards.get(forwardId);
		if (!state) throw new ForwardError(404, "not_found", "No such forward");
		const hash = path.indexOf("#");
		const target = hash === -1 ? path : path.slice(0, hash);
		const fragment = hash === -1 ? "" : path.slice(hash);
		return `http://${clientHost}:${state.info.listenPort}${target}${target.includes("?") ? "&" : "?"}${FORWARD_TICKET_PARAM}=${ticket}${fragment}`;
	}

	private redeemTicket(ticket: string, state: ForwardState): boolean {
		if (ticket.length === 0 || ticket.length > 64) return false;
		this.pruneTickets();
		const key = hashSecret(ticket).toString("hex");
		const entry = this.tickets.get(key);
		if (!entry) return false;
		this.tickets.delete(key);
		return entry.forwardId === state.info.id && entry.deviceId === state.info.deviceId;
	}

	private pruneTickets(): void {
		const now = this.now();
		for (const [key, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(key);
	}

	private cookieName(state: ForwardState): string {
		return `${FORWARD_COOKIE_PREFIX}${state.info.id}`;
	}

	private hasCookie(state: ForwardState, req: IncomingMessage): boolean {
		const value = cookieValue(req.headers.cookie, this.cookieName(state));
		if (!value || value.length > 128) return false;
		return state.cookies.has(hashSecret(value).toString("hex"));
	}

	/** Host and Origin, as the main server checks them; a message when refused. */
	private refused(state: ForwardState, req: IncomingMessage): { status: number; reason: string; message: string } | undefined {
		const host = req.headers.host;
		if (typeof host !== "string" || !state.hostOk(host)) return { status: 421, reason: "Misdirected Request", message: "Unexpected Host header" };
		// Another page (another forward on this host is the same site) never drives this one; no CORS is added either.
		const origin = req.headers.origin;
		if (origin !== undefined && origin.toLowerCase() !== `http://${host.toLowerCase()}`) return { status: 403, reason: "Forbidden", message: "Origin not allowed" };
		if (!(req.url ?? "").startsWith("/")) return { status: 400, reason: "Bad Request", message: "Bad request" };
		return undefined;
	}

	private handle(state: ForwardState, req: IncomingMessage, res: ServerResponse): void {
		const refused = this.refused(state, req);
		if (refused) return plain(res, refused.status, refused.message);
		const { path, ticket } = splitTicket(req.url ?? "/");
		if (ticket !== undefined) {
			if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "A forward link opens with GET");
			const headers: OutgoingHttpHeaders = { Location: path };
			if (this.redeemTicket(ticket, state)) {
				const secret = randomBytes(32).toString("base64url");
				state.cookies.add(hashSecret(secret).toString("hex"));
				while (state.cookies.size > this.limits.maxCookies) state.cookies.delete(state.cookies.values().next().value!);
				headers["Set-Cookie"] = `${this.cookieName(state)}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
			} else if (!this.hasCookie(state, req)) {
				return plain(res, 401, "This link expired or was already used. Open the page again from Gentle Shell.");
			}
			state.info.lastUsedAt = this.now();
			res.writeHead(303, { ...OWN_HEADERS, ...headers, "Content-Length": 0 });
			return void res.end();
		}
		if (!this.hasCookie(state, req)) return plain(res, 401, "Open this page from Gentle Shell: it needs a fresh link.");
		state.info.lastUsedAt = this.now();
		void this.proxy(state, req, res, path);
	}

	/** Which loopback address answers on the port: 127.0.0.1 first, then [::1] (servers that bound `localhost` on IPv6 only). */
	private async upstream(state: ForwardState): Promise<Upstream | undefined> {
		if (state.upstream) return state.upstream;
		for (const host of ["127.0.0.1", "::1"] as const) {
			if (await canConnect(host, state.info.port, this.limits.connectTimeoutMs)) return (state.upstream = host);
		}
		return undefined;
	}

	/** The request's headers for the page: hop-by-hop gone, Host the page's own, Origin and Referer translated, forward cookies stripped. */
	private upstreamHeaders(state: ForwardState, req: IncomingMessage, upstream: Upstream, keepUpgrade: boolean): Record<string, string | string[]> {
		const own = `http://${req.headers.host}`;
		const target = `http://${literal(upstream)}:${state.info.port}`;
		const drop = hopHeaders(req.headers);
		const headers: Record<string, string | string[]> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || name === "host" || name === "cookie") continue;
			if (drop.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
			headers[name] = value;
		}
		headers.host = `${literal(upstream)}:${state.info.port}`;
		const cookie = stripForwardCookies(req.headers.cookie);
		if (cookie !== undefined) headers.cookie = cookie;
		if (typeof headers.origin === "string") headers.origin = target;
		if (typeof headers.referer === "string" && (headers.referer === own || headers.referer.startsWith(`${own}/`))) headers.referer = target + headers.referer.slice(own.length);
		return headers;
	}

	/** The page's response headers for the browser: hop-by-hop gone, loopback redirects pointed back at the forward, no `gs_fwd_*` cookie. */
	private downstreamHeaders(state: ForwardState, req: IncomingMessage, upRes: IncomingMessage): string[] {
		const drop = hopHeaders(upRes.headers);
		const loopback = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${state.info.port}(?=[/?#]|$)`, "i");
		const out: string[] = [];
		const raw = upRes.rawHeaders;
		for (let i = 0; i + 1 < raw.length; i += 2) {
			const name = raw[i];
			let value = raw[i + 1];
			const lower = name.toLowerCase();
			if (drop.has(lower)) continue;
			if (lower === "set-cookie" && value.trimStart().startsWith(FORWARD_COOKIE_PREFIX)) continue;
			if (lower === "location" || lower === "content-location") value = value.replace(loopback, `http://${req.headers.host}`);
			out.push(name, value);
		}
		return out;
	}

	private async proxy(state: ForwardState, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
		const upstream = await this.upstream(state);
		if (res.destroyed) return;
		if (!upstream) return plain(res, 502, `Nothing answers on port ${state.info.port} of the server.`);
		const up = httpRequest({ host: upstream, port: state.info.port, method: req.method, path, headers: this.upstreamHeaders(state, req, upstream, false), agent: false });
		const connectTimer = setTimeout(() => up.destroy(new Error("connect timeout")), this.limits.connectTimeoutMs);
		up.once("socket", (socket: Socket) => {
			socket.setNoDelay(true);
			if (!socket.connecting) clearTimeout(connectTimer);
			else socket.once("connect", () => clearTimeout(connectTimer));
		});
		up.on("response", (upRes: IncomingMessage) => {
			res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, this.downstreamHeaders(state, req, upRes));
			// Headers now, so a stream (SSE) starts before its first event; the body is never buffered.
			res.flushHeaders();
			upRes.pipe(res);
			upRes.on("error", () => res.destroy());
			upRes.on("aborted", () => res.destroy());
		});
		up.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(connectTimer);
			if (error.code === "ECONNREFUSED") state.upstream = undefined;
			if (!res.headersSent) plain(res, 502, `The page on port ${state.info.port} did not answer.`);
			else res.destroy();
		});
		res.on("close", () => {
			clearTimeout(connectTimer);
			if (!res.writableFinished) up.destroy();
		});
		req.pipe(up);
	}

	private upgrade(state: ForwardState, req: IncomingMessage, socket: Socket, head: Buffer): void {
		socket.on("error", () => socket.destroy());
		const refused = this.refused(state, req);
		if (refused) return refuseUpgrade(socket, refused.status, refused.reason);
		// A WebSocket opens from a page already loaded through the forward: the cookie, never a ticket.
		if (!this.hasCookie(state, req)) return refuseUpgrade(socket, 401, "Unauthorized");
		state.info.lastUsedAt = this.now();
		const { path } = splitTicket(req.url ?? "/");
		void this.upstream(state).then((upstream) => {
			if (socket.destroyed) return;
			if (!upstream) return refuseUpgrade(socket, 502, "Bad Gateway");
			const headers = this.upstreamHeaders(state, req, upstream, true);
			const lines = [`${req.method} ${path} HTTP/1.1`];
			for (const [name, value] of Object.entries(headers)) for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
			const target = connect({ host: upstream, port: state.info.port });
			const connectTimer = setTimeout(() => target.destroy(new Error("connect timeout")), this.limits.connectTimeoutMs);
			let connected = false;
			target.once("connect", () => {
				connected = true;
				clearTimeout(connectTimer);
				target.setNoDelay(true);
				socket.setNoDelay(true);
				target.write(`${lines.join("\r\n")}\r\n\r\n`);
				if (head.length > 0) target.write(head);
				target.pipe(socket);
				socket.pipe(target);
			});
			target.on("error", (error: NodeJS.ErrnoException) => {
				clearTimeout(connectTimer);
				if (error.code === "ECONNREFUSED") state.upstream = undefined;
				if (!connected) refuseUpgrade(socket, 502, "Bad Gateway");
			});
			target.on("close", () => { if (connected) socket.destroy(); });
			socket.on("close", () => target.destroy());
		});
	}

	/** Closes one forward: its listener, its open connections (WebSockets included) and its tickets. */
	close(id: string, reason = "closed"): boolean {
		const state = this.forwards.get(id);
		if (!state) return false;
		this.forwards.delete(id);
		for (const [key, entry] of this.tickets) if (entry.forwardId === id) this.tickets.delete(key);
		state.server.close();
		for (const socket of state.sockets) socket.destroy();
		this.log(`forward ${id}: ${reason}`);
		return true;
	}

	closeWhere(predicate: (forward: ForwardInfo) => boolean, reason: string): number {
		let count = 0;
		for (const forward of this.list()) if (predicate(forward) && this.close(forward.id, reason)) count += 1;
		return count;
	}

	private closeIdle(): void {
		const now = this.now();
		for (const state of [...this.forwards.values()]) {
			if (state.sockets.size === 0 && now - state.info.lastUsedAt >= this.limits.idleMs) this.close(state.info.id, "idle");
		}
	}

	closeAll(): void {
		this.closed = true;
		clearInterval(this.sweep);
		for (const id of [...this.forwards.keys()]) this.close(id, "server stopping");
	}
}
