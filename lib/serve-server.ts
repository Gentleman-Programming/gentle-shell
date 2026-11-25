// `gentle-shell serve`'s HTTP API: JSON endpoints plus Server-Sent Events,
// hardened like the Tower server (lib/tower-server.ts): no cookies, a bearer
// token on every authenticated request, any foreign Origin refused, the Host
// header checked against the listen address, bounded bodies, and CSP/no-store
// headers. Zero dependencies: SSE works from browsers, phones and curl; a
// WebSocket transport can come later behind the same contract.

import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import { hasScope, isServeScope, type Principal, type ServeAuth, type ServeScope } from "./serve-auth.ts";
import { startDiscoveryResponder, type DiscoveryResponder } from "./serve-discovery.ts";
import { ServeSession, SessionError, type ServeSessionLimits, type SessionLaunch } from "./serve-session.ts";

export const SERVE_SCHEMA = "gentle-shell.serve/v1";
export const SERVE_PROTOCOL = 1;
export const SERVE_IDENTITY_SCHEMA = "gentle-shell.serve.identity/v1";
/** Public identity path: a client holding a connection code probes it to find the address that reaches this server. */
export const SERVE_IDENTITY_PATH = "/.well-known/gentle-shell";
export const SERVE_CAPABILITIES = ["sessions", "pi-rpc", "desktop-rpc", "sse", "stream-tickets", "pairing", "devices"] as const;

export const SERVE_SERVER_LIMITS = {
	heartbeatMs: 20_000,
	smallBodyBytes: 16 * 1024,
	desktopBodyBytes: 80 * 1024,
	/** Pi RPC commands may carry images. */
	rpcBodyBytes: 8 * 1024 * 1024,
	rpcTimeoutMs: 30_000,
	maxSessions: 16,
	/** Exited sessions kept (with their replay ring) until deleted. */
	keepExited: 16,
};

/** Pi RPC commands that only read; every other command needs `sessions:operate`. */
const READ_COMMANDS = new Set(["get_state", "get_messages", "get_available_models", "get_available_thinking_levels", "get_session_stats",
	"get_fork_messages", "get_entries", "get_tree", "get_last_assistant_text", "get_commands"]);

/** Desktop RPC reads (`capabilities`, `get_*`, `list_*`) need `sessions:read`; anything else operates. */
export function desktopMethodScope(method: string): ServeScope {
	return method === "capabilities" || method.startsWith("get_") || method.startsWith("list_") ? "sessions:read" : "sessions:operate";
}

export function rpcCommandScope(type: string): ServeScope {
	return READ_COMMANDS.has(type) ? "sessions:read" : "sessions:operate";
}

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export interface ServeServerOptions {
	/** Address to bind; loopback unless the operator chose otherwise. */
	host: string;
	port: number;
	/** Extra DNS names (no port) the Host header may carry, beyond those the listen address allows. */
	allowHosts?: readonly string[];
	auth: ServeAuth;
	/** Builds the child for a new session (the real CLI spawns `gentle-shell --mode rpc`). */
	launchSession: (input: { cwd: string; sessionId?: string }) => SessionLaunch;
	version: string;
	limits?: Partial<typeof SERVE_SERVER_LIMITS>;
	sessionLimits?: Partial<ServeSessionLimits>;
	now?: () => number;
	log?: (line: string) => void;
	/** `POST /api/server/stop` (admin): the owner closes the server. */
	onStopRequested?: () => void;
}

export interface ServeServer {
	serverId: string;
	host: string;
	port: number;
	/** Base URL a local client uses. */
	url: string;
	startedAt: number;
	/** Whether it answers LAN discovery (network listen only, when the UDP port could be bound). */
	discovery: boolean;
	close(): Promise<void>;
}

class HttpError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export function isLoopbackHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isUnspecified(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** The Host header values a request may carry for this listen address (DNS-rebinding guard), plus `extra` names the operator allowed. */
export function allowedHosts(bindHost: string, port: number, extra: readonly string[] = []): (host: string) => boolean {
	const named = new Set<string>();
	const add = (h: string) => named.add(`${h.toLowerCase()}:${port}`);
	const bare = bindHost.replace(/^\[|\]$/g, "");
	if (isLoopbackHost(bare) || isUnspecified(bindHost)) for (const h of ["127.0.0.1", "localhost", "[::1]"]) add(h);
	if (!isUnspecified(bindHost)) add(bare.includes(":") ? `[${bare}]` : bare);
	if (isUnspecified(bindHost)) {
		const own = hostname().toLowerCase();
		add(own);
		if (!own.endsWith(".local")) add(`${own}.local`);
	}
	for (const h of extra) add(h);
	return (value: string) => {
		const host = value.toLowerCase();
		if (named.has(host)) return true;
		// On an unspecified bind any of this machine's addresses can reach it; names other than its own cannot.
		if (!isUnspecified(bindHost)) return false;
		const m = /^(?:\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(host);
		return !!m && Number(m[1]) === port;
	};
}

function bearer(req: IncomingMessage): string | undefined {
	const header = req.headers.authorization;
	if (typeof header !== "string") return undefined;
	const m = /^Bearer\s+(\S{1,512})$/i.exec(header);
	return m ? m[1] : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...SECURITY_HEADERS });
	res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
	sendJson(res, status, { error: { code, message } });
}

function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) {
		reject(new HttpError(413, "too_large", `Body over ${limit} bytes`));
		req.resume();
		return promise;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	let over = false;
	req.on("data", (chunk: Buffer) => {
		size += chunk.length;
		if (size > limit) over = true;
		else chunks.push(chunk);
	});
	req.on("error", reject);
	req.on("end", () => {
		if (over) return reject(new HttpError(413, "too_large", `Body over ${limit} bytes`));
		if (size === 0) return resolve({});
		try {
			const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
			resolve(value);
		} catch {
			reject(new HttpError(400, "invalid_json", "The body must be one JSON object"));
		}
	});
	return promise;
}

function realDirectory(cwd: unknown): string {
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096 || cwd.includes("\0") || !isAbsolute(cwd)) {
		throw new HttpError(400, "invalid_cwd", "cwd must be an absolute path to a folder");
	}
	try {
		const real = realpathSync(cwd);
		if (!statSync(real).isDirectory()) throw new Error("not a folder");
		return real;
	} catch {
		throw new HttpError(400, "invalid_cwd", "cwd must be an absolute path to an existing folder");
	}
}

export function startServeServer(options: ServeServerOptions): Promise<ServeServer> {
	const limits = { ...SERVE_SERVER_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const serverId = `srv_${randomBytes(8).toString("hex")}`;
	const startedAt = now();
	const sessions = new Map<string, ServeSession>();
	let hostOk: (host: string) => boolean = () => false;
	let closing = false;

	options.auth.onRevoke((deviceId) => { for (const s of sessions.values()) s.dropDevice(deviceId); });

	const need = (principal: Principal | undefined, scope: ServeScope): Principal => {
		if (!principal) throw new HttpError(401, "unauthorized", "A valid bearer token is required");
		if (!hasScope(principal, scope)) throw new HttpError(403, "forbidden", `This token lacks the ${scope} scope`);
		return principal;
	};

	const sessionView = (s: ServeSession, principal: Principal) => ({
		id: s.id,
		name: basename(s.cwd) || null,
		// The absolute folder only for a token that may start sessions anyway.
		...(hasScope(principal, "sessions:operate") ? { cwd: s.cwd } : {}),
		state: s.state,
		startedAt: new Date(s.startedAt).toISOString(),
		...(s.exitedAt === undefined ? {} : { exitedAt: new Date(s.exitedAt).toISOString(), exitCode: s.exitCode, exitSignal: s.exitSignal }),
		seq: s.seq,
		subscribers: s.subscriberCount,
		pendingDialogs: s.pendingDialogs().length,
	});

	const findSession = (id: string): ServeSession => {
		const s = sessions.get(id);
		if (!s) throw new HttpError(404, "not_found", "No such session");
		return s;
	};

	const forgetExited = () => {
		const exited = [...sessions.values()].filter((s) => s.state === "exited");
		for (const s of exited.slice(0, Math.max(0, exited.length - limits.keepExited))) sessions.delete(s.id);
	};

	const startSession = (cwd: string, sessionId?: string): ServeSession => {
		if (closing) throw new HttpError(503, "shutting_down", "The server is stopping");
		const running = [...sessions.values()].filter((s) => s.state === "running").length;
		if (running >= limits.maxSessions) throw new HttpError(429, "too_many_sessions", `At most ${limits.maxSessions} sessions run at once`);
		const id = `ses_${randomBytes(8).toString("hex")}`;
		const session = new ServeSession({
			id,
			launch: options.launchSession({ cwd, ...(sessionId === undefined ? {} : { sessionId }) }),
			limits: options.sessionLimits,
			now,
			onStderr: (text) => { for (const line of text.split("\n")) if (line.trim()) log(`[${id}] ${line}`); },
			onExit: (s) => { log(`[${id}] exited (code ${s.exitCode}, signal ${s.exitSignal})`); forgetExited(); },
		});
		sessions.set(id, session);
		log(`[${id}] started`);
		return session;
	};

	const openEvents = (req: IncomingMessage, res: ServerResponse, session: ServeSession, principal: Principal, url: URL) => {
		const raw = url.searchParams.get("after") ?? (typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null);
		let after: number | undefined;
		if (raw !== null && raw !== "") {
			if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, "invalid_after", "after must be a whole number");
			after = Number(raw);
		}
		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY_HEADERS });
		res.flushHeaders();
		req.socket.setNoDelay(true);
		session.subscribe(res, principal.deviceId, after);
		res.on("close", () => session.unsubscribe(res));
	};

	const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
		const method = req.method ?? "GET";
		const path = url.pathname;
		const principal = options.auth.authenticate(bearer(req));
		if (path.length > 256) throw new HttpError(404, "not_found", "Not found");

		// Who answers here, without a token and without secrets: a client holding a
		// connection code probes each advertised address and pairs only where the id matches.
		if (path === SERVE_IDENTITY_PATH) {
			if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET");
			return sendJson(res, 200, { schema: SERVE_IDENTITY_SCHEMA, serverId, name: hostname(), protocol: SERVE_PROTOCOL, version: options.version });
		}

		if (path === "/api/pair") {
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
			const body = await readJsonBody(req, limits.smallBodyBytes);
			const result = options.auth.redeem(body.code, body.name);
			if ("error" in result) {
				const status = result.error === "rate_limited" ? 429 : result.error === "too_many_devices" ? 409 : 403;
				throw new HttpError(status, result.error, result.error === "invalid_code" ? "Unknown, used or expired pairing code" : result.error === "rate_limited" ? "Too many failed attempts; wait a minute" : "Too many paired devices; revoke one first");
			}
			log(`paired device ${result.device.id} (${result.device.scopes.join(",")})`);
			return sendJson(res, 201, { ...result.device, token: result.token });
		}

		// Streams opened by EventSource carry a single-use ticket instead of a header.
		const events = /^\/api\/sessions\/([A-Za-z0-9_]{1,64})\/events$/.exec(path);
		if (events) {
			if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET");
			const session = findSessionFor(events[1], principal, url);
			return openEvents(req, res, session.session, session.principal, url);
		}

		if (path === "/api/server") {
			if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET");
			const who = need(principal, "sessions:read");
			return sendJson(res, 200, { schema: SERVE_SCHEMA, protocol: SERVE_PROTOCOL, serverId, version: options.version, startedAt: new Date(startedAt).toISOString(),
				capabilities: SERVE_CAPABILITIES, device: { id: who.deviceId, name: who.name, scopes: who.scopes } });
		}
		if (path === "/api/server/stop") {
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
			need(principal, "admin");
			sendJson(res, 202, { stopping: true });
			setImmediate(() => options.onStopRequested?.());
			return;
		}
		if (path === "/api/pairing-codes") {
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
			need(principal, "admin");
			const body = await readJsonBody(req, limits.smallBodyBytes);
			let scopes: ServeScope[] | undefined;
			if (body.scopes !== undefined) {
				if (!Array.isArray(body.scopes) || body.scopes.length === 0 || !body.scopes.every(isServeScope)) throw new HttpError(400, "invalid_scopes", "scopes must be a non-empty list of known scopes");
				scopes = body.scopes;
			}
			const minted = options.auth.mintPairingCode(scopes);
			return sendJson(res, 201, { code: minted.code, scopes: minted.scopes, expiresAt: new Date(minted.expiresAt).toISOString() });
		}
		if (path === "/api/devices") {
			if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET");
			need(principal, "admin");
			return sendJson(res, 200, { devices: options.auth.listDevices() });
		}
		const device = /^\/api\/devices\/([A-Za-z0-9_]{1,64})$/.exec(path);
		if (device) {
			if (method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use DELETE");
			need(principal, "admin");
			if (!options.auth.revoke(device[1])) throw new HttpError(404, "not_found", "No such device");
			log(`revoked device ${device[1]}`);
			return sendJson(res, 200, { revoked: device[1] });
		}
		if (path === "/api/tickets") {
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
			const who = need(principal, "sessions:read");
			const body = await readJsonBody(req, limits.smallBodyBytes);
			if (typeof body.sessionId !== "string") throw new HttpError(400, "invalid_request", "sessionId is required");
			findSession(body.sessionId);
			const minted = options.auth.mintTicket(who, body.sessionId);
			return sendJson(res, 201, { ticket: minted.ticket, expiresAt: new Date(minted.expiresAt).toISOString() });
		}
		if (path === "/api/sessions") {
			if (method === "GET") {
				const who = need(principal, "sessions:read");
				return sendJson(res, 200, { sessions: [...sessions.values()].map((s) => sessionView(s, who)) });
			}
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use GET or POST");
			const who = need(principal, "sessions:operate");
			const body = await readJsonBody(req, limits.smallBodyBytes);
			const cwd = realDirectory(body.cwd);
			let sessionId: string | undefined;
			if (body.sessionId !== undefined) {
				// An id, never a path: Pi resolves it against its own session store.
				if (typeof body.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.sessionId)) throw new HttpError(400, "invalid_session_id", "sessionId must be a Pi session id");
				sessionId = body.sessionId;
			}
			return sendJson(res, 201, { session: sessionView(startSession(cwd, sessionId), who) });
		}
		const one = /^\/api\/sessions\/([A-Za-z0-9_]{1,64})(\/rpc|\/desktop)?$/.exec(path);
		if (one) {
			const session = findSession(one[1]);
			if (one[2] === undefined) {
				if (method === "GET") return sendJson(res, 200, { session: sessionView(session, need(principal, "sessions:read")) });
				if (method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use GET or DELETE");
				const who = need(principal, "sessions:operate");
				await session.stop();
				sessions.delete(session.id);
				return sendJson(res, 200, { session: sessionView(session, who) });
			}
			if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
			if (one[2] === "/rpc") return forwardRpc(req, res, session, principal);
			return forwardDesktop(req, res, session, principal);
		}
		throw new HttpError(404, "not_found", "Not found");
	};

	const findSessionFor = (id: string, principal: Principal | undefined, url: URL): { session: ServeSession; principal: Principal } => {
		const ticket = url.searchParams.get("ticket");
		if (ticket !== null) {
			const holder = options.auth.redeemTicket(ticket, id);
			if (!holder) throw new HttpError(401, "invalid_ticket", "Unknown, used or expired stream ticket");
			return { session: findSession(id), principal: holder };
		}
		const who = need(principal, "sessions:read");
		return { session: findSession(id), principal: who };
	};

	const forwardRpc = async (req: IncomingMessage, res: ServerResponse, session: ServeSession, principal: Principal | undefined) => {
		if (!principal) throw new HttpError(401, "unauthorized", "A valid bearer token is required");
		const command = await readJsonBody(req, limits.rpcBodyBytes);
		if (typeof command.type !== "string" || command.type.length > 64) throw new HttpError(400, "invalid_command", "A Pi RPC command needs a type");
		if (command.id !== undefined && (typeof command.id !== "string" || command.id.length > 128)) throw new HttpError(400, "invalid_command", "id must be a string up to 128 characters");
		if (command.type === "extension_ui_response") {
			need(principal, "sessions:operate");
			const outcome = session.answerDialog(command);
			if (outcome === "unknown") throw new HttpError(404, "unknown_dialog", "No pending dialog with this id");
			if (outcome === "answered") throw new HttpError(409, "dialog_answered", "Another client already answered this dialog");
			return sendJson(res, 202, { accepted: true });
		}
		need(principal, rpcCommandScope(command.type));
		const outcome = await session.rpc(command, limits.rpcTimeoutMs);
		if ("timeout" in outcome) return sendJson(res, 202, { pending: true, id: outcome.id });
		return sendJson(res, 200, outcome.response);
	};

	const forwardDesktop = async (req: IncomingMessage, res: ServerResponse, session: ServeSession, principal: Principal | undefined) => {
		if (!principal) throw new HttpError(401, "unauthorized", "A valid bearer token is required");
		const body = await readJsonBody(req, limits.desktopBodyBytes);
		if (typeof body.method !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(body.method)) throw new HttpError(400, "invalid_request", "method must be a Desktop RPC method name");
		const params = body.params ?? {};
		if (!params || typeof params !== "object" || Array.isArray(params)) throw new HttpError(400, "invalid_request", "params must be an object");
		need(principal, desktopMethodScope(body.method));
		const outcome = await session.desktop(body.method, params as Record<string, unknown>, limits.rpcTimeoutMs);
		if (outcome === undefined) throw new HttpError(504, "desktop_timeout", "The session did not answer the Desktop RPC request in time");
		if ("prompt" in outcome) return sendJson(res, 502, { error: { code: "desktop_refused", message: "The session refused the Desktop RPC request" }, response: outcome.prompt });
		return sendJson(res, 200, outcome.answer);
	};

	const handler = (req: IncomingMessage, res: ServerResponse) => {
		const host = req.headers.host;
		if (typeof host !== "string" || !hostOk(host)) return sendError(res, 421, "bad_host", "Unexpected Host header");
		// Bearer tokens, not cookies, so a foreign page cannot ride a session; only this server's own origin is accepted.
		const origin = req.headers.origin;
		if (origin !== undefined && origin.toLowerCase() !== `http://${host.toLowerCase()}`) return sendError(res, 403, "forbidden_origin", "Origin not allowed");
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://serve.invalid");
		} catch {
			return sendError(res, 400, "bad_request", "Bad request");
		}
		route(req, res, url).catch((error: unknown) => {
			if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
			if (error instanceof SessionError) return sendError(res, error.code === "session_busy" ? 503 : 409, error.code, error.message);
			log(`internal error: ${error instanceof Error ? error.message : String(error)}`);
			sendError(res, 500, "internal_error", "Server error");
		});
	};

	const server = createServer(handler);
	server.headersTimeout = 20_000;
	server.requestTimeout = 0; // SSE streams stay open
	server.keepAliveTimeout = 5_000;
	const heartbeat = setInterval(() => { for (const s of sessions.values()) s.heartbeat(); }, limits.heartbeatMs);
	heartbeat.unref();

	const { promise, resolve, reject } = Promise.withResolvers<ServeServer>();
	server.once("error", reject);
	server.listen(options.port, options.host.replace(/^\[|\]$/g, ""), async () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : options.port;
		hostOk = allowedHosts(options.host, port, options.allowHosts);
		const localHost = isUnspecified(options.host) ? "127.0.0.1" : options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host;
		const url = `http://${localHost}:${port}`;
		// On the network, also answer LAN discovery on the same port number (UDP); the HTTP server works without it.
		let discovery: DiscoveryResponder | undefined;
		if (!isLoopbackHost(options.host)) {
			try {
				discovery = await startDiscoveryResponder({ port, serverId, httpPort: port, name: hostname, log });
			} catch (error) {
				log(`discovery off: could not bind UDP 0.0.0.0:${port}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		resolve({
			serverId,
			host: options.host,
			port,
			url,
			startedAt,
			discovery: discovery !== undefined,
			close: async () => {
				closing = true;
				clearInterval(heartbeat);
				await discovery?.close();
				await Promise.all([...sessions.values()].map((s) => s.stop()));
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				server.closeAllConnections();
				await closed.promise;
			},
		});
	});
	return promise;
}
