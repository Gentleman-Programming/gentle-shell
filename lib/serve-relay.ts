// A self-hostable rendezvous for reaching `gentle-shell serve` from outside its
// network (`gentle-shell relay`). Servers connect out to the relay and keep a
// control connection; a client asks the relay for a server by its certificate
// fingerprint; the relay asks that server to open one more outbound data
// connection and splices the two TCP streams. TLS runs end to end between the
// client and serve (the client pins the fingerprint), so the relay only ever
// sees ciphertext and logs byte counts, never content. Zero dependencies.
//
// Every message before the splice is one JSON object on one line ending in
// `\n` (at most 4 KiB); after the client's `{"t":"ok"}` line the connection
// carries raw bytes.

import { createHash, createPrivateKey, randomBytes, sign, timingSafeEqual, verify, X509Certificate } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { certificateFingerprint, fingerprintBytes } from "./serve-tls.ts";

export const RELAY_PROTOCOL = 1;
export const RELAY_URL_SCHEME = "gsr:";
/** What a server signs, followed by the relay's nonce (base64url text), to prove it holds the certificate's key. */
export const RELAY_SIGNATURE_PREFIX = "gentle-shell/relay-register/v1 ";

export const RELAY_LIMITS = {
	/** One handshake line, newline included. */
	lineBytes: 4096,
	/** A connection that has not finished its handshake by then is closed. */
	helloTimeoutMs: 10_000,
	/** How long a client waits for the server's data connection. */
	openTimeoutMs: 10_000,
	maxServers: 256,
	/** Spliced plus waiting connections per server. */
	maxConnectionsPerServer: 32,
	/** A spliced pair with no byte either way for this long is closed. */
	idleMs: 30 * 60_000,
	/** The relay pings each server's control connection this often... */
	pingMs: 25_000,
	/** ...and drops one that has said nothing for this long. */
	deadMs: 75_000,
	/** Per-server byte rates are logged this often while connections are open. */
	logEveryMs: 60_000,
};

export type RelayErrorCode = "bad_request" | "unsupported_version" | "unauthorized" | "full" | "offline" | "busy" | "timeout" | "refused" | "replaced";

/** `gsr://<host>:<port>`: host and port, nothing else. */
export function parseRelayUrl(value: string): { url: string; host: string; port: number } | { error: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `a relay URL looks like gsr://relay.example.com:7700 (got "${value}")` };
	}
	if (url.protocol !== RELAY_URL_SCHEME) return { error: `a relay URL starts with gsr:// (got "${value}")` };
	if (url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) return { error: `a relay URL is only gsr://<host>:<port>; the relay secret goes in GENTLE_SHELL_RELAY_SECRET or the relay-secret file (got "${value}")` };
	if (!url.port) return { error: `a relay URL needs a port, as in gsr://relay.example.com:7700 (got "${value}")` };
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return { url: `gsr://${url.host}`, host, port: Number(url.port) };
}

function send(socket: Socket, message: Record<string, unknown>): void {
	if (socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

function fail(socket: Socket, code: RelayErrorCode, message: string): void {
	if (socket.writable) socket.end(`${JSON.stringify({ t: "error", code, message })}\n`);
	else socket.destroy();
}

/** One handshake line, parsed, and the bytes that came after it. */
interface RelayLine {
	message: Record<string, unknown>;
	rest: Buffer;
}

/** Reads one handshake line; resolves with the parsed object and any bytes after it, which stay unread by the socket. */
function readLine(socket: Socket, limits: { lineBytes: number; helloTimeoutMs: number }, initial: Buffer = Buffer.alloc(0)): Promise<RelayLine> {
	const { promise, resolve, reject } = Promise.withResolvers<RelayLine>();
	let buffer = initial;
	const done = (error?: Error) => {
		clearTimeout(timer);
		socket.off("data", onData);
		socket.off("close", onClose);
		if (error) reject(error);
	};
	const parse = () => {
		const end = buffer.indexOf(0x0a);
		if (end === -1) {
			if (buffer.length >= limits.lineBytes) done(new Error("line too long"));
			return;
		}
		if (end + 1 > limits.lineBytes) return done(new Error("line too long"));
		let message: unknown;
		try { message = JSON.parse(buffer.subarray(0, end).toString("utf8")); } catch { return done(new Error("not JSON")); }
		if (!message || typeof message !== "object" || Array.isArray(message) || !("t" in message) || typeof message.t !== "string") return done(new Error("not a message"));
		socket.pause();
		done();
		resolve({ message: message as Record<string, unknown>, rest: buffer.subarray(end + 1) });
	};
	const onData = (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		parse();
	};
	const onClose = () => done(new Error("closed"));
	const timer = setTimeout(() => done(new Error("timeout")), limits.helloTimeoutMs);
	socket.on("data", onData);
	socket.once("close", onClose);
	if (buffer.length > 0) parse();
	if (socket.isPaused()) socket.resume();
	return promise;
}

/** Calls `onLine` for each line until the socket ends; a line over the limit or not JSON closes it. */
function readLines(socket: Socket, lineBytes: number, initial: Buffer, onLine: (message: Record<string, unknown>) => void): void {
	let buffer = initial;
	const drain = () => {
		for (let end = buffer.indexOf(0x0a); end !== -1; end = buffer.indexOf(0x0a)) {
			const line = buffer.subarray(0, end);
			buffer = buffer.subarray(end + 1);
			let message: unknown;
			try { message = JSON.parse(line.toString("utf8")); } catch { return void socket.destroy(); }
			if (message && typeof message === "object" && !Array.isArray(message)) onLine(message as Record<string, unknown>);
		}
		if (buffer.length >= lineBytes) socket.destroy();
	};
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		drain();
	});
	drain();
	socket.resume();
}

const sameSecret = (given: unknown, expected: string) => typeof given === "string"
	&& timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());

const shortId = (id: string) => id.slice(0, 8);

// --- the relay ---------------------------------------------------------------------

interface Pending {
	cid: string;
	key: string;
	client: Socket;
	rest: Buffer;
	helloBytes: number;
	timer: NodeJS.Timeout;
}

interface Pair {
	client: Socket;
	data: Socket;
	clientHello: number;
	dataHello: number;
	startedAt: number;
	sampledUp: number;
	sampledDown: number;
}

interface Registration {
	id: string;
	control: Socket;
	pending: Map<string, Pending>;
	pairs: Set<Pair>;
	lastHeard: number;
	ping: NodeJS.Timeout;
}

export interface RelayOptions {
	host: string;
	port: number;
	/** Servers must present it to register; without one any server may. */
	secret?: string;
	limits?: Partial<typeof RELAY_LIMITS>;
	now?: () => number;
	log?: (line: string) => void;
}

export interface Relay {
	host: string;
	port: number;
	/** Registered servers (fingerprints), for tests and status. */
	servers(): string[];
	close(): Promise<void>;
}

export function startRelay(options: RelayOptions): Promise<Relay> {
	const limits = { ...RELAY_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const registrations = new Map<string, Registration>();
	const pendingByCid = new Map<string, { registration: Registration; pending: Pending }>();
	const sockets = new Set<Socket>();

	const unregister = (registration: Registration, reason: string) => {
		if (registrations.get(registration.id) !== registration) return;
		registrations.delete(registration.id);
		clearInterval(registration.ping);
		for (const pending of registration.pending.values()) {
			clearTimeout(pending.timer);
			pendingByCid.delete(pending.cid);
			fail(pending.client, "offline", "The server left the relay");
		}
		registration.control.destroy();
		log(`relay: server ${shortId(registration.id)} left (${reason})`);
	};

	const registerServer = async (socket: Socket, hello: Record<string, unknown>, rest: Buffer) => {
		const id = typeof hello.id === "string" ? hello.id : "";
		if (!fingerprintBytes(id)) return fail(socket, "bad_request", "id must be the server certificate's base64url SHA-256 fingerprint");
		if (options.secret !== undefined && !sameSecret(hello.secret, options.secret)) {
			log(`relay: refused server ${shortId(id)} from ${socket.remoteAddress}: wrong relay secret`);
			return fail(socket, "unauthorized", "Wrong or missing relay secret");
		}
		if (!registrations.has(id) && registrations.size >= limits.maxServers) return fail(socket, "full", "This relay serves as many servers as it can");
		const nonce = randomBytes(32).toString("base64url");
		send(socket, { t: "challenge", nonce });
		const auth = await readLine(socket, limits, rest);
		if (auth.message.t !== "auth" || typeof auth.message.cert !== "string" || typeof auth.message.sig !== "string") return fail(socket, "bad_request", "Expected the auth line");
		let proven = false;
		try {
			const cert = new X509Certificate(Buffer.from(auth.message.cert, "base64url"));
			proven = certificateFingerprint(cert.raw) === id && verify("sha256", Buffer.from(`${RELAY_SIGNATURE_PREFIX}${nonce}`, "ascii"), cert.publicKey, Buffer.from(auth.message.sig, "base64url"));
		} catch { /* not a certificate or not a signature */ }
		if (!proven) {
			log(`relay: refused server ${shortId(id)} from ${socket.remoteAddress}: no proof of the certificate's key`);
			return fail(socket, "unauthorized", "The signature does not prove this certificate");
		}
		const previous = registrations.get(id);
		if (previous) {
			fail(previous.control, "replaced", "The same server registered again");
			unregister(previous, "replaced by a new connection");
		}
		if (registrations.size >= limits.maxServers) return fail(socket, "full", "This relay serves as many servers as it can");
		const registration: Registration = { id, control: socket, pending: new Map(), pairs: new Set(), lastHeard: now(), ping: setInterval(() => {
			if (now() - registration.lastHeard > limits.deadMs) return unregister(registration, "no answer to pings");
			send(socket, { t: "ping" });
		}, limits.pingMs) };
		registration.ping.unref();
		registrations.set(id, registration);
		socket.setKeepAlive(true, limits.pingMs);
		socket.once("close", () => unregister(registration, "control connection closed"));
		send(socket, { t: "ready", v: RELAY_PROTOCOL });
		log(`relay: server ${shortId(id)} registered from ${socket.remoteAddress}`);
		readLines(socket, limits.lineBytes, auth.rest, (message) => {
			registration.lastHeard = now();
			if (message.t === "refuse" && typeof message.cid === "string") {
				const pending = registration.pending.get(message.cid);
				if (!pending) return;
				registration.pending.delete(message.cid);
				pendingByCid.delete(message.cid);
				clearTimeout(pending.timer);
				fail(pending.client, "refused", "The server has nothing on that port");
			}
		});
	};

	const openForClient = (client: Socket, hello: Record<string, unknown>, rest: Buffer, helloBytes: number) => {
		const id = typeof hello.id === "string" ? hello.id : "";
		const port = hello.port;
		if (!fingerprintBytes(id)) return fail(client, "bad_request", "id must be the server certificate's base64url SHA-256 fingerprint");
		if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return fail(client, "bad_request", "port must be a whole number 1-65535");
		const registration = registrations.get(id);
		if (!registration) return fail(client, "offline", "That server is not connected to this relay");
		if (registration.pending.size + registration.pairs.size >= limits.maxConnectionsPerServer) return fail(client, "busy", "That server has as many relayed connections as it may");
		const cid = randomBytes(12).toString("base64url");
		const key = randomBytes(16).toString("base64url");
		const pending: Pending = { cid, key, client, rest, helloBytes, timer: setTimeout(() => {
			registration.pending.delete(cid);
			pendingByCid.delete(cid);
			fail(client, "timeout", "The server did not open a connection in time");
		}, limits.openTimeoutMs) };
		registration.pending.set(cid, pending);
		pendingByCid.set(cid, { registration, pending });
		client.once("close", () => {
			if (!registration.pending.delete(cid)) return;
			pendingByCid.delete(cid);
			clearTimeout(pending.timer);
		});
		send(registration.control, { t: "open", cid, key, ...(port === undefined ? {} : { port }) });
	};

	const splice = (data: Socket, hello: Record<string, unknown>, rest: Buffer, helloBytes: number) => {
		const found = typeof hello.cid === "string" ? pendingByCid.get(hello.cid) : undefined;
		if (!found || !sameSecret(hello.key, found.pending.key)) return fail(data, "unauthorized", "Unknown or expired connection");
		const { registration, pending } = found;
		registration.pending.delete(pending.cid);
		pendingByCid.delete(pending.cid);
		clearTimeout(pending.timer);
		const client = pending.client;
		if (client.destroyed) return void data.destroy();
		const pair: Pair = { client, data, clientHello: pending.helloBytes, dataHello: helloBytes, startedAt: now(), sampledUp: 0, sampledDown: 0 };
		registration.pairs.add(pair);
		const end = () => {
			if (!registration.pairs.delete(pair)) return;
			client.destroy();
			data.destroy();
			const up = Math.max(0, client.bytesRead - pair.clientHello);
			const down = Math.max(0, data.bytesRead - pair.dataHello);
			log(`relay: server ${shortId(registration.id)}: connection closed after ${Math.round((now() - pair.startedAt) / 1000)} s, ${up} B up, ${down} B down`);
		};
		for (const socket of [client, data]) {
			socket.setNoDelay(true);
			socket.setTimeout(limits.idleMs, end);
			socket.once("close", end);
		}
		client.write(`${JSON.stringify({ t: "ok" })}\n`);
		if (pending.rest.length > 0) data.write(pending.rest);
		if (rest.length > 0) client.write(rest);
		client.pipe(data);
		data.pipe(client);
		client.resume();
		data.resume();
	};

	const rates = setInterval(() => {
		for (const registration of registrations.values()) {
			if (registration.pairs.size === 0) continue;
			let up = 0;
			let down = 0;
			for (const pair of registration.pairs) {
				const u = pair.client.bytesRead;
				const d = pair.data.bytesRead;
				up += u - Math.max(pair.sampledUp, pair.clientHello);
				down += d - Math.max(pair.sampledDown, pair.dataHello);
				pair.sampledUp = u;
				pair.sampledDown = d;
			}
			const seconds = limits.logEveryMs / 1000;
			log(`relay: server ${shortId(registration.id)}: ${registration.pairs.size} connection(s), ${Math.round(up / seconds)} B/s up, ${Math.round(down / seconds)} B/s down`);
		}
	}, limits.logEveryMs);
	rates.unref();

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		readLine(socket, limits).then(({ message, rest }) => {
			const helloBytes = socket.bytesRead - rest.length;
			if (message.v !== RELAY_PROTOCOL) return fail(socket, "unsupported_version", `This relay speaks version ${RELAY_PROTOCOL}`);
			if (message.t === "gsr/server") return registerServer(socket, message, rest);
			if (message.t === "gsr/client") return openForClient(socket, message, rest, helloBytes);
			if (message.t === "gsr/data") return splice(socket, message, rest, helloBytes);
			fail(socket, "bad_request", "Unknown hello");
		}).catch(() => socket.destroy());
	});

	const { promise, resolve, reject } = Promise.withResolvers<Relay>();
	server.once("error", reject);
	server.listen(options.port, options.host.replace(/^\[|\]$/g, ""), () => {
		server.off("error", reject);
		const address = server.address();
		resolve({
			host: options.host,
			port: typeof address === "object" && address ? address.port : options.port,
			servers: () => [...registrations.keys()],
			close: async () => {
				clearInterval(rates);
				for (const registration of [...registrations.values()]) unregister(registration, "relay stopping");
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				for (const socket of sockets) socket.destroy();
				await closed.promise;
			},
		});
	});
	return promise;
}

// --- a server's link to the relay --------------------------------------------------

export interface RelayLinkOptions {
	url: string;
	secret?: string;
	/** The server's certificate (DER) and its key (PEM): the relay routes by the fingerprint and checks a signature. */
	certDer: Buffer;
	keyPem: string;
	/** Where a relayed connection for `port` goes (undefined: the API); undefined refuses it. */
	accept: (port: number | undefined) => ((socket: Socket) => void) | undefined;
	limits?: Partial<typeof RELAY_LIMITS>;
	log?: (line: string) => void;
	/** Reconnect delays: doubling from `retryMinMs` up to `retryMaxMs`. */
	retryMinMs?: number;
	retryMaxMs?: number;
}

export interface RelayLink {
	url: string;
	/** The routing id: the certificate's fingerprint. */
	id: string;
	/** Whether the relay accepted the registration and the control connection is open. */
	connected(): boolean;
	/** Resolves once registered (for tests and the CLI's first status line). */
	ready(): Promise<void>;
	close(): void;
}

/** Keeps a registration with the relay: connects out, proves the certificate, opens a data connection per client, reconnects with backoff. */
export function startRelayLink(options: RelayLinkOptions): RelayLink {
	const parsed = parseRelayUrl(options.url);
	if ("error" in parsed) throw new Error(parsed.error);
	const limits = { ...RELAY_LIMITS, ...options.limits };
	const log = options.log ?? (() => {});
	const id = certificateFingerprint(options.certDer);
	const key = createPrivateKey(options.keyPem);
	const retryMin = options.retryMinMs ?? 1000;
	const retryMax = options.retryMaxMs ?? 60_000;
	let delay = retryMin;
	let control: Socket | undefined;
	let registered = false;
	let closed = false;
	let retry: NodeJS.Timeout | undefined;
	let waiters: Array<() => void> = [];
	const dataSockets = new Set<Socket>();

	const openData = (message: Record<string, unknown>) => {
		const cid = message.cid;
		const dataKey = message.key;
		if (typeof cid !== "string" || typeof dataKey !== "string") return;
		const port = typeof message.port === "number" ? message.port : undefined;
		const target = options.accept(port);
		if (!target) {
			if (control) send(control, { t: "refuse", cid });
			return;
		}
		const data = connect({ host: parsed.host, port: parsed.port });
		dataSockets.add(data);
		data.once("close", () => dataSockets.delete(data));
		data.on("error", () => data.destroy());
		data.setTimeout(limits.openTimeoutMs, () => data.destroy());
		data.once("connect", () => {
			data.setTimeout(0);
			data.setNoDelay(true);
			data.write(`${JSON.stringify({ t: "gsr/data", v: RELAY_PROTOCOL, cid, key: dataKey })}\n`);
			target(data);
		});
	};

	const schedule = () => {
		if (closed || retry) return;
		retry = setTimeout(() => {
			retry = undefined;
			attempt();
		}, delay);
		retry.unref();
		delay = Math.min(retryMax, delay * 2);
	};

	const attempt = () => {
		if (closed) return;
		const socket = connect({ host: parsed.host, port: parsed.port });
		control = socket;
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			if (control === socket) control = undefined;
			if (registered) log(`relay: disconnected from ${parsed.url}`);
			registered = false;
			schedule();
		});
		socket.once("connect", async () => {
			try {
				socket.setNoDelay(true);
				socket.setKeepAlive(true, limits.pingMs);
				send(socket, { t: "gsr/server", v: RELAY_PROTOCOL, id, ...(options.secret === undefined ? {} : { secret: options.secret }) });
				const challenge = await readLine(socket, limits);
				if (challenge.message.t === "error") throw new Error(`${challenge.message.code}: ${challenge.message.message}`);
				if (challenge.message.t !== "challenge" || typeof challenge.message.nonce !== "string") throw new Error("unexpected answer");
				const sig = sign("sha256", Buffer.from(`${RELAY_SIGNATURE_PREFIX}${challenge.message.nonce}`, "ascii"), key);
				send(socket, { t: "auth", cert: options.certDer.toString("base64url"), sig: sig.toString("base64url") });
				const ready = await readLine(socket, limits, challenge.rest);
				if (ready.message.t === "error") throw new Error(`${ready.message.code}: ${ready.message.message}`);
				if (ready.message.t !== "ready") throw new Error("unexpected answer");
				registered = true;
				delay = retryMin;
				log(`relay: registered with ${parsed.url} as ${shortId(id)}`);
				for (const done of waiters) done();
				waiters = [];
				let heard = Date.now();
				const watchdog = setInterval(() => { if (Date.now() - heard > limits.deadMs) socket.destroy(); }, limits.pingMs);
				watchdog.unref();
				socket.once("close", () => clearInterval(watchdog));
				readLines(socket, limits.lineBytes, ready.rest, (message) => {
					heard = Date.now();
					if (message.t === "ping") send(socket, { t: "pong" });
					else if (message.t === "open") openData(message);
				});
			} catch (error) {
				log(`relay: ${parsed.url} refused the registration: ${error instanceof Error ? error.message : String(error)}`);
				socket.destroy();
			}
		});
	};

	attempt();
	return {
		url: parsed.url,
		id,
		connected: () => registered,
		ready: () => {
			if (registered) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			return promise;
		},
		close: () => {
			closed = true;
			clearTimeout(retry);
			control?.destroy();
			for (const socket of dataSockets) socket.destroy();
		},
	};
}

// --- a client through the relay ----------------------------------------------------

export class RelayError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * A TCP stream to the server with fingerprint `id` through the relay at `url`
 * (to its listener on `port`, the API when absent). The caller runs TLS over it
 * and pins `id`; the relay never sees the plaintext.
 */
export async function connectThroughRelay(url: string, id: string, options: { port?: number; timeoutMs?: number } = {}): Promise<Socket> {
	const parsed = parseRelayUrl(url);
	if ("error" in parsed) throw new RelayError("bad_request", parsed.error);
	const socket = connect({ host: parsed.host, port: parsed.port });
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	socket.once("connect", () => resolve());
	socket.once("error", reject);
	await promise;
	socket.off("error", reject);
	socket.on("error", () => socket.destroy());
	socket.setNoDelay(true);
	send(socket, { t: "gsr/client", v: RELAY_PROTOCOL, id, ...(options.port === undefined ? {} : { port: options.port }) });
	const limits = { ...RELAY_LIMITS, helloTimeoutMs: options.timeoutMs ?? RELAY_LIMITS.openTimeoutMs + 5_000 };
	let answer: RelayLine;
	try {
		answer = await readLine(socket, limits);
	} catch (error) {
		socket.destroy();
		throw new RelayError("timeout", `The relay did not answer: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (answer.message.t !== "ok") {
		socket.destroy();
		throw new RelayError(typeof answer.message.code === "string" ? answer.message.code : "bad_request", typeof answer.message.message === "string" ? answer.message.message : "The relay refused");
	}
	if (answer.rest.length > 0) socket.unshift(answer.rest);
	return socket;
}
