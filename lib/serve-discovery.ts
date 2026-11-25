// LAN discovery for `gentle-shell serve`: a server open to the network answers a
// UDP broadcast query with its id, name and HTTP port, so a client that holds
// only the short pairing code can find it. Replies carry no secrets; a client
// still checks `/.well-known/gentle-shell` at the reply's source address before
// it sends the pairing code there. Zero dependencies (node:dgram).

import { createSocket, type RemoteInfo } from "node:dgram";

export const DISCOVERY_QUERY = "gentle-shell/discover";
export const DISCOVERY_REPLY = "gentle-shell/here";
export const DISCOVERY_VERSION = 1;
/** Larger datagrams are dropped unread. */
export const DISCOVERY_MAX_DATAGRAM = 512;
export const DISCOVERY_LIMITS = { globalPerSecond: 20, perSourcePerSecond: 4 };

/** Whether `datagram` is a discovery query: `{"t":"gentle-shell/discover","v":1}` (other keys ignored). */
export function isDiscoveryQuery(datagram: Buffer): boolean {
	if (datagram.length === 0 || datagram.length > DISCOVERY_MAX_DATAGRAM) return false;
	try {
		const value = JSON.parse(datagram.toString("utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const query = value as { t?: unknown; v?: unknown };
		return query.t === DISCOVERY_QUERY && query.v === DISCOVERY_VERSION;
	} catch {
		return false;
	}
}

/** `{"t":"gentle-shell/here","v":1,"id","n","p"}`, plus `"tls":true,"fp"` when the server serves HTTPS: a hint only, the client pins what the handshake shows after a pairing proof. */
export function discoveryReply(server: { id: string; name: string; port: number; fingerprint?: string }): Buffer {
	return Buffer.from(JSON.stringify({ t: DISCOVERY_REPLY, v: DISCOVERY_VERSION, id: server.id, n: server.name, p: server.port, ...(server.fingerprint === undefined ? {} : { tls: true, fp: server.fingerprint }) }), "utf8");
}

/**
 * Replies allowed per one-second window, overall and per source address. The
 * global cap is checked first, so a window tracks at most that many sources.
 */
export class DiscoveryRateLimiter {
	private windowStart = Number.NEGATIVE_INFINITY;
	private total = 0;
	private readonly perSource = new Map<string, number>();
	private readonly limits: typeof DISCOVERY_LIMITS;
	constructor(limits: typeof DISCOVERY_LIMITS = DISCOVERY_LIMITS) {
		this.limits = limits;
	}

	allow(source: string, now: number): boolean {
		if (now - this.windowStart >= 1000 || now < this.windowStart) {
			this.windowStart = now;
			this.total = 0;
			this.perSource.clear();
		}
		if (this.total >= this.limits.globalPerSecond) return false;
		const count = this.perSource.get(source) ?? 0;
		if (count >= this.limits.perSourcePerSecond) return false;
		this.perSource.set(source, count + 1);
		this.total += 1;
		return true;
	}
}

export interface DiscoveryResponderOptions {
	/** UDP port to bind on 0.0.0.0 (the server's HTTP port). */
	port: number;
	serverId: string;
	/** HTTP port the reply advertises. */
	httpPort: number;
	name: () => string;
	/** The certificate's fingerprint when the server serves HTTPS. */
	fingerprint?: string;
	limits?: typeof DISCOVERY_LIMITS;
	now?: () => number;
	log?: (line: string) => void;
}

export interface DiscoveryResponder {
	port: number;
	close(): Promise<void>;
}

/** Binds UDP `0.0.0.0:<port>` and answers discovery queries by unicast to their sender; rejects when the bind fails. */
export function startDiscoveryResponder(options: DiscoveryResponderOptions): Promise<DiscoveryResponder> {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const limiter = new DiscoveryRateLimiter(options.limits);
	const socket = createSocket({ type: "udp4" });
	const { promise, resolve, reject } = Promise.withResolvers<DiscoveryResponder>();
	let bound = false;
	socket.on("error", (error) => {
		if (!bound) {
			socket.close();
			reject(error);
			return;
		}
		log(`discovery: ${error.message}`);
	});
	socket.on("message", (datagram: Buffer, from: RemoteInfo) => {
		if (!isDiscoveryQuery(datagram) || !limiter.allow(from.address, now())) return;
		const reply = discoveryReply({ id: options.serverId, name: options.name(), port: options.httpPort, ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }) });
		socket.send(reply, from.port, from.address, (error) => { if (error) log(`discovery: reply to ${from.address}:${from.port} failed: ${error.message}`); });
	});
	socket.bind({ port: options.port, address: "0.0.0.0", exclusive: true }, () => {
		bound = true;
		resolve({
			port: socket.address().port,
			close: () => {
				const closed = Promise.withResolvers<void>();
				socket.close(() => closed.resolve());
				return closed.promise;
			},
		});
	});
	return promise;
}
