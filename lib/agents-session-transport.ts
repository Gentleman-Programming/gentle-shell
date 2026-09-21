import { chmod, constants, link, lstat, mkdir, open, opendir, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const DIR_MODE = 0o700, FILE_MODE = 0o600, MAX_RECORD_BYTES = 8192, MAX_ENTRIES = 64, MAX_SOCKET_PATH_BYTES = 100;
const RUNTIME_TMP = "/tmp", RUNTIME_PREFIX = "gentle-pi-", PROFILE_HASH_HEX_LENGTH = 32, SOCKET_NAME_BYTES = 27;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, TOKEN = /^[A-Za-z0-9_-]{22}$/;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
type Code = "invalid_session" | "not_found" | "invalid_presence" | "unsafe_path" | "io_error" | "busy";

export type PresenceRecord = Readonly<{ version: 1; sessionId: string; endpoint: string; createdAt: number }>;
export type SessionPresenceCandidate = Readonly<{ sessionId: string; reachability: "unknown" }>;
export type TransportPaths = Readonly<{ root: string; presence: string; sockets: string }>;

export class SessionPresenceError extends Error {
	readonly code: Code;
	constructor(code: Code, message: string) { super(message); this.code = code; this.name = "SessionPresenceError"; }
}

function fail(code: Code, message: string): never { throw new SessionPresenceError(code, message); }
const uid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
const sameUser = (stat: { uid: number }) => uid() === undefined || stat.uid === uid();
function sessionId(value: unknown): string {
	if (typeof value !== "string" || !SESSION.test(value)) fail("invalid_session", "invalid session ID");
	return value;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundary(error: unknown): never {
	if (error instanceof SessionPresenceError) throw error;
	const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT") fail("not_found", "presence not found");
	if (code === "ELOOP") fail("unsafe_path", "unsafe transport path");
	fail("io_error", "transport I/O failed");
}

// The agent profile and its shared Gentle Agents parent belong to the host
// runtime. Transport may validate them but must not tighten their permissions.
async function parentDirectory(path: string) {
	try {
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !sameUser(stat)) fail("unsafe_path", "unsafe transport path");
	} catch (error) { boundary(error); }
}

async function privateDirectory(path: string, create = false) {
	try {
		if (create) await mkdir(path, { mode: DIR_MODE }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
		const stat = await lstat(path);
		if (stat.isSymbolicLink() || !stat.isDirectory() || !sameUser(stat) || (stat.mode & 0o777) !== DIR_MODE) fail("unsafe_path", "unsafe transport path");
	} catch (error) { boundary(error); }
}

type RuntimeParent = Readonly<{ mode: number; uid: number; isSymbolicLink: () => boolean; isDirectory: () => boolean }>;

export const isSafeRuntimeParent = (stat: RuntimeParent) => {
	if (stat.isSymbolicLink() || !stat.isDirectory() || (!sameUser(stat) && stat.uid !== 0)) return false;
	const mode = stat.mode & 0o7777;
	return (sameUser(stat) && (mode & 0o022) === 0) || (mode & 0o1777) === 0o1777;
};

async function runtimeSocketDirectory(agentHome: string) {
	try {
		// macOS resolves /tmp to /private/tmp. This shared parent is not ours: it
		// must be owner-only writable or a world-writable sticky tmp.
		const shared = await realpath(RUNTIME_TMP), sharedStat = await lstat(shared);
		if (!isSafeRuntimeParent(sharedStat)) fail("unsafe_path", "unsafe transport path");
		const userRoot = join(shared, `${RUNTIME_PREFIX}${uid() ?? "unknown"}`);
		await privateDirectory(userRoot, true);
		const profile = createHash("sha256").update(agentHome).digest("hex").slice(0, PROFILE_HASH_HEX_LENGTH);
		const sockets = join(userRoot, profile);
		if (Buffer.byteLength(join(sockets, `${"x".repeat(SOCKET_NAME_BYTES - 5)}.sock`)) > MAX_SOCKET_PATH_BYTES) fail("unsafe_path", "unsafe transport path");
		await privateDirectory(sockets, true);
		return sockets;
	} catch (error) { boundary(error); }
}

export class SessionPresenceRegistry {
	readonly paths: TransportPaths;

	private readonly beforeCandidateOpen?: () => Promise<void>;

	private constructor(agentHome: string, sockets: string, beforeCandidateOpen?: () => Promise<void>) {
		const root = join(agentHome, "gentle-agents", "transport");
		this.paths = Object.freeze({ root, presence: join(root, "presence"), sockets });
		this.beforeCandidateOpen = beforeCandidateOpen;
	}

	static async create(agentHome: string, beforeCandidateOpen?: () => Promise<void>) {
		if (process.platform === "win32") fail("io_error", "transport I/O failed");
		const home = resolve(agentHome);
		await parentDirectory(home);
		await parentDirectory(join(home, "gentle-agents"));
		const sockets = await runtimeSocketDirectory(home);
		const registry = new SessionPresenceRegistry(home, sockets, beforeCandidateOpen);
		await privateDirectory(registry.paths.root, true);
		await privateDirectory(registry.paths.presence, true);
		return registry;
	}

	async record(id: string, createdAt = Date.now()): Promise<PresenceRecord> {
		id = sessionId(id);
		if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail("invalid_presence", "invalid presence record");
		const endpoint = join(this.paths.sockets, `${randomBytes(16).toString("base64url")}.sock`);
		if (Buffer.byteLength(endpoint) > MAX_SOCKET_PATH_BYTES) fail("unsafe_path", "unsafe transport path");
		return Object.freeze({ version: 1, sessionId: id, endpoint, createdAt });
	}

	presencePath(record: PresenceRecord) { return join(this.paths.presence, `${sessionId(record.sessionId)}.${this.token(record.endpoint)}.json`); }

	async publish(record: PresenceRecord) {
		this.validate(record);
		const target = this.presencePath(record), temporary = join(this.paths.presence, `.${randomBytes(16).toString("hex")}.tmp`);
		try {
			await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
			await chmod(temporary, FILE_MODE);
			await link(temporary, target);
			await unlink(temporary);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("busy", "activation already exists");
			boundary(error);
		}
	}

	// The public list deliberately serializes only an ID and unknown reachability.
	// Callers that must bind a later send can keep this private activation snapshot.
	async list(excludeSessionId?: string): Promise<readonly SessionPresenceCandidate[]> {
		return (await this.listActivations(excludeSessionId)).map(({ sessionId }) => Object.freeze({ sessionId, reachability: "unknown" as const }));
	}

	async listActivations(excludeSessionId?: string): Promise<readonly PresenceRecord[]> {
		const excluded = excludeSessionId === undefined ? undefined : sessionId(excludeSessionId);
		await privateDirectory(this.paths.root);
		await privateDirectory(this.paths.presence);
		await privateDirectory(this.paths.sockets);
		const newest = new Map<string, PresenceRecord>();
		let count = 0;
		let dir;
		try {
			dir = await opendir(this.paths.presence);
			for await (const entry of dir) {
				if (++count > MAX_ENTRIES) fail("busy", "presence registry is busy");
				const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z0-9_-]{22})\.json$/.exec(entry.name);
				if (!match) continue;
				try { await this.beforeCandidateOpen?.(); } catch { fail("io_error", "transport I/O failed"); }
				try {
					const loaded = await this.read(join(this.paths.presence, entry.name), match[1], match[2]);
					const candidate = loaded?.record;
					if (!candidate || candidate.sessionId === excluded || !await this.advertises(candidate)) continue;
					const prior = newest.get(candidate.sessionId);
					if (!prior || candidate.createdAt > prior.createdAt || (candidate.createdAt === prior.createdAt && this.token(candidate.endpoint) > this.token(prior.endpoint))) newest.set(candidate.sessionId, candidate);
				} catch (error) {
					if (!(error instanceof SessionPresenceError) || !["invalid_presence", "unsafe_path", "not_found"].includes(error.code)) throw error;
				}
			}
		} catch (error) { boundary(error); }
		return [...newest.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
	}

	async resolve(id: string): Promise<PresenceRecord> {
		id = sessionId(id);
		await privateDirectory(this.paths.root);
		await privateDirectory(this.paths.presence);
		await privateDirectory(this.paths.sockets);
		let count = 0, newest: PresenceRecord | undefined, retained: SessionPresenceError | undefined;
		let dir;
		try {
			dir = await opendir(this.paths.presence);
			for await (const entry of dir) {
				if (++count > MAX_ENTRIES) fail("busy", "presence registry is busy");
				const match = new RegExp(`^${id}\\.([A-Za-z0-9_-]{22})\\.json$`).exec(entry.name);
				if (!match) continue;
				try { await this.beforeCandidateOpen?.(); } catch { fail("io_error", "transport I/O failed"); }
				try {
					const loaded = await this.read(join(this.paths.presence, entry.name), id, match[1]);
					const candidate = loaded?.record;
					if (candidate && (!newest || candidate.createdAt > newest.createdAt || (candidate.createdAt === newest.createdAt && this.token(candidate.endpoint) > this.token(newest.endpoint)))) newest = candidate;
				} catch (error) {
					if (!(error instanceof SessionPresenceError) || !["invalid_presence", "unsafe_path", "not_found"].includes(error.code)) throw error;
					if (error.code !== "not_found" && (!retained || (error.code === "unsafe_path" && retained.code !== "unsafe_path"))) retained = error;
				}
			}
		} catch (error) { boundary(error); }
		if (!newest && retained) throw retained;
		if (!newest) fail("not_found", "presence not found");
		return newest;
	}

	async removeOwn(record: PresenceRecord) {
		this.validate(record);
		const file = this.presencePath(record);
		let result;
		try { result = await this.read(file, record.sessionId, this.token(record.endpoint)); } catch (error) {
			if (error instanceof SessionPresenceError && error.code === "not_found") return;
			throw error;
		}
		if (!result || JSON.stringify(result.record) !== JSON.stringify(record)) return;
		try {
			const stat = await lstat(file);
			if (!stat.isSymbolicLink() && stat.dev === result.stat.dev && stat.ino === result.stat.ino) await unlink(file);
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") boundary(error); }
	}

	private async advertises(record: PresenceRecord) {
		try {
			const stat = await lstat(record.endpoint);
			return !stat.isSymbolicLink() && stat.isSocket() && sameUser(stat);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ELOOP") return false;
			throw error;
		}
	}

	private token(endpoint: unknown) {
		if (typeof endpoint !== "string" || dirname(endpoint) !== this.paths.sockets || resolve(endpoint) !== endpoint || Buffer.byteLength(endpoint) > MAX_SOCKET_PATH_BYTES) fail("unsafe_path", "unsafe transport path");
		const name = basename(endpoint), token = name.endsWith(".sock") ? name.slice(0, -5) : "";
		if (!TOKEN.test(token)) fail("unsafe_path", "unsafe transport path");
		return token;
	}

	private validate(value: unknown, expectedId?: string, expectedToken?: string): asserts value is PresenceRecord {
		if (!plainRecord(value)) fail("invalid_presence", "invalid presence record");
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 4 || !["version", "sessionId", "endpoint", "createdAt"].every((key) => keys.includes(key))) fail("invalid_presence", "invalid presence record");
		if (value.version !== 1 || typeof value.sessionId !== "string" || typeof value.endpoint !== "string" || typeof value.createdAt !== "number") fail("invalid_presence", "invalid presence record");
		const record: PresenceRecord = { version: 1, sessionId: value.sessionId, endpoint: value.endpoint, createdAt: value.createdAt };
		if (record.version !== 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) fail("invalid_presence", "invalid presence record");
		const id = sessionId(record.sessionId), token = this.token(record.endpoint);
		if ((expectedId && id !== expectedId) || (expectedToken && token !== expectedToken)) fail("invalid_presence", "invalid presence record");
	}

	private async read(file: string, id: string, token: string) {
		let handle;
		try {
			handle = await open(file, OPEN_FLAGS);
			const stat = await handle.stat();
			if (!stat.isFile() || !sameUser(stat) || stat.size > MAX_RECORD_BYTES) fail("invalid_presence", "invalid presence record");
			const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_RECORD_BYTES) fail("invalid_presence", "invalid presence record");
			let value: unknown;
			try { value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); } catch { fail("invalid_presence", "invalid presence record"); }
			this.validate(value, id, token);
			return { record: Object.freeze({ ...value }), stat };
		} catch (error) { boundary(error); } finally { await handle?.close().catch(() => {}); }
	}
}

// An 8 KiB control-character payload expands to about 48 KiB in JSON escapes.
export const MAX_FRAME_BYTES = 65536;
type ProtocolCode = "malformed" | "oversized" | "invalid_utf8" | "invalid_frame" | "trailing_frame";
export type NotificationFrame = Readonly<{ version: 1; kind: "notification"; id: string; senderSessionId: string; recipientSessionId: string; message: string }>;
export type AckFrame = Readonly<{ version: 1; kind: "ack"; id: string; accepted: boolean; error?: "rejected" | "duplicate" | "busy" | "timeout" }>;
export type WireFrame = NotificationFrame | AckFrame;

export class TransportProtocolError extends Error {
	readonly code: ProtocolCode;
	constructor(code: ProtocolCode) { super("invalid transport frame"); this.code = code; this.name = "TransportProtocolError"; }
}
function protocol(code: ProtocolCode): never { throw new TransportProtocolError(code); }
const own = (value: unknown, fields: string[]) => {
	if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) protocol("invalid_frame");
	const keys = Reflect.ownKeys(value);
	if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) protocol("invalid_frame");
	return value as Record<string, unknown>;
};
const wireId = (value: unknown) => typeof value === "string" && SESSION.test(value) ? value : protocol("invalid_frame");
const message = (value: unknown) => {
	if (typeof value !== "string" || Buffer.byteLength(value) > 8192) protocol("invalid_frame");
	return value;
};
type AckError = NonNullable<AckFrame["error"]>;
const ackError = (value: unknown): value is AckError => value === "rejected" || value === "duplicate" || value === "busy" || value === "timeout";
function frame(value: unknown): WireFrame {
	if (!value || typeof value !== "object") protocol("invalid_frame");
	const basic = value as Record<string, unknown>;
	if (basic.kind === "ack") {
		const fields = basic.accepted === true ? ["version", "kind", "id", "accepted"] : ["version", "kind", "id", "accepted", "error"];
		const ack = own(value, fields);
		if (ack.version !== 1 || typeof ack.accepted !== "boolean") protocol("invalid_frame");
		if (ack.accepted) return Object.freeze({ version: 1, kind: "ack", id: wireId(ack.id), accepted: true });
		const error = ack.error;
		if (!ackError(error)) protocol("invalid_frame");
		return Object.freeze({ version: 1, kind: "ack", id: wireId(ack.id), accepted: false, error });
	}
	const notification = own(value, ["version", "kind", "id", "senderSessionId", "recipientSessionId", "message"]);
	if (notification.version !== 1 || notification.kind !== "notification") protocol("invalid_frame");
	return Object.freeze({ version: 1, kind: "notification", id: wireId(notification.id), senderSessionId: wireId(notification.senderSessionId), recipientSessionId: wireId(notification.recipientSessionId), message: message(notification.message) });
}
const encode = (value: unknown, kind: WireFrame["kind"]) => {
	const parsed = frame(value);
	if (parsed.kind !== kind) protocol("invalid_frame");
	const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`);
	if (bytes.length > MAX_FRAME_BYTES) protocol("oversized");
	return bytes;
};
export const encodeNotificationFrame = (value: NotificationFrame) => encode(value, "notification");
export const encodeAckFrame = (value: AckFrame) => encode(value, "ack");

export class FrameDecoder {
	private readonly buffer = Buffer.alloc(MAX_FRAME_BYTES);
	private bytes = 0;
	private parsed?: WireFrame;
	private finished = false;

	push(chunk: Buffer) {
		if (!Buffer.isBuffer(chunk)) protocol("invalid_frame");
		if (!chunk.length) return;
		if (this.parsed || this.finished) protocol("trailing_frame");
		if (this.bytes + chunk.length > MAX_FRAME_BYTES) protocol("oversized");
		chunk.copy(this.buffer, this.bytes);
		this.bytes += chunk.length;
		const newline = this.buffer.subarray(0, this.bytes).indexOf(10);
		if (newline < 0) return;
		if (newline !== this.bytes - 1) protocol("trailing_frame");
		let text: string, value: unknown;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(0, newline)); } catch { protocol("invalid_utf8"); }
		try { value = JSON.parse(text!); } catch { protocol("invalid_frame"); }
		this.parsed = frame(value!);
	}

	get complete() { return Boolean(this.parsed); }

	finish(): WireFrame {
		if (this.finished) protocol("trailing_frame");
		this.finished = true;
		if (!this.parsed) protocol("malformed");
		return this.parsed;
	}
}

export type ReceivedNotification = Readonly<{ id: string; senderSessionId: string; message: string }>;
type ListenerState = "idle" | "starting" | "accepting" | "active" | "failed" | "closed";
type ListenerFailure = Readonly<{ code: "io_error"; message: "listener failed" }>;
type ListenerScheduler = Readonly<{ setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (handle: unknown) => void }>;
export type ActiveSessionListenerOptions = Readonly<{ callbackDeadlineMs?: number; scheduler?: ListenerScheduler; beforeEndpointCleanup?: () => Promise<void> }>;
const CALLBACK_DEADLINE_MS = 2000, MAX_CALLBACKS = 8, MAX_SEEN_NOTIFICATIONS = 64;

export class ActiveSessionListener {
	readonly registry: SessionPresenceRegistry;
	readonly sessionID: string;
	readonly onNotification: (notification: ReceivedNotification) => Promise<void>;
	readonly sockets = new Set<Socket>();
	readonly closed: Promise<void>;
	record?: PresenceRecord;
	failure?: ListenerFailure;
	private server?: Server;
	private state: ListenerState = "idle";
	private generation = 0;
	private startPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private cleanupPromise?: Promise<void>;
	private readonly settleSockets = new Map<Socket, () => void>();
	private readonly seen = new Map<string, true>();
	private readonly callbackDeadlineMs: number;
	private readonly scheduler: ListenerScheduler;
	private readonly beforeEndpointCleanup?: () => Promise<void>;
	private resolveClosed!: () => void;

	constructor(registry: SessionPresenceRegistry, sessionID: string, onNotification: (notification: ReceivedNotification) => Promise<void>, options: ActiveSessionListenerOptions = {}) {
		const deadline = options.callbackDeadlineMs ?? CALLBACK_DEADLINE_MS;
		if (!Number.isInteger(deadline) || deadline < 1 || deadline > CALLBACK_DEADLINE_MS) throw new RangeError("invalid callback deadline");
		this.registry = registry;
		this.sessionID = sessionId(sessionID);
		this.onNotification = onNotification;
		this.callbackDeadlineMs = deadline;
		this.scheduler = options.scheduler ?? { setTimeout, clearTimeout };
		this.beforeEndpointCleanup = options.beforeEndpointCleanup;
		this.closed = new Promise<void>((resolveClosed) => { this.resolveClosed = resolveClosed; });
	}

	get activeConnections() { return this.sockets.size; }
	get status() { return this.state; }

	start(): Promise<void> {
		if (this.state === "active") return Promise.resolve();
		if (this.state === "closed" || this.state === "failed") return Promise.reject(new SessionPresenceError("io_error", "listener is closed"));
		if (this.startPromise) return this.startPromise;
		const generation = ++this.generation;
		this.state = "starting";
		let operation!: Promise<void>;
		operation = this.doStart(generation).finally(() => { if (this.startPromise === operation) this.startPromise = undefined; });
		this.startPromise = operation;
		return operation;
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.state === "closed") return Promise.resolve();
		if (this.state === "failed") return this.beginClose(this.record);
		this.generation++;
		this.state = "closed";
		return this.beginClose(this.record);
	}

	private beginClose(record: PresenceRecord | undefined): Promise<void> {
		if (this.closePromise) return this.closePromise;
		const startup = this.startPromise;
		let resolve!: () => void, reject!: (error: unknown) => void;
		const completion = new Promise<void>((done, failClose) => { resolve = done; reject = failClose; });
		this.closePromise = completion;
		void this.finishClose(startup, record).then(resolve, reject);
		return completion;
	}

	private async finishClose(startup: Promise<void> | undefined, record: PresenceRecord | undefined) {
		try {
			await this.cleanup(record);
			await startup?.catch(() => {});
			await this.cleanup(this.record ?? record);
			if (record) await this.registry.removeOwn(record).catch(() => {});
		} finally { this.resolveClosed(); }
	}

	private ownsStartup(generation: number) {
		return this.generation === generation && (this.state === "starting" || this.state === "accepting");
	}

	private assertStartup(generation: number) {
		if (!this.ownsStartup(generation)) fail("io_error", "listener is closed");
	}

	private async doStart(generation: number) {
		let record: PresenceRecord | undefined;
		try {
			record = await this.registry.record(this.sessionID);
			this.assertStartup(generation);
			await lstat(record.endpoint).then(() => fail("unsafe_path", "unsafe transport path")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
			this.assertStartup(generation);
			const server = createServer((socket) => this.accept(socket));
			this.server = server;
			server.on("error", () => this.fail(record!));
			await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(record.endpoint, () => { server.off("error", rejectListen); resolveListen(); }); });
			this.assertStartup(generation);
			const stat = await lstat(record.endpoint);
			this.assertStartup(generation);
			if (stat.isSymbolicLink() || !stat.isSocket() || !sameUser(stat)) fail("unsafe_path", "unsafe transport path");
			await chmod(record.endpoint, FILE_MODE);
			this.assertStartup(generation);
			this.state = "accepting";
			await this.registry.publish(record);
			this.assertStartup(generation);
			this.record = record;
			this.state = "active";
		} catch (error) {
			await this.cleanup(record);
			if (record) await this.registry.removeOwn(record).catch(() => {});
			if (this.generation === generation && this.state !== "failed" && this.state !== "closed") {
				this.state = "idle";
				this.cleanupPromise = undefined;
			}
			boundary(error);
		}
	}

	private accept(socket: Socket) {
		if ((this.state !== "accepting" && this.state !== "active") || this.sockets.size >= MAX_CALLBACKS) { socket.destroy(); return; }
		this.sockets.add(socket);
		const decoder = new FrameDecoder();
		let settled = false, processing = false, cancelDelivery: (() => void) | undefined;
		const settle = (frame?: AckFrame) => {
			if (settled) return;
			settled = true;
			cancelDelivery?.();
			cancelDelivery = undefined;
			this.settleSockets.delete(socket);
			this.sockets.delete(socket);
			if (socket.destroyed) return;
			if (frame) socket.end(encodeAckFrame(frame)); else socket.end();
		};
		this.settleSockets.set(socket, settle);
		socket.on("data", (chunk: Buffer) => {
			if (settled || processing) return;
			try {
				decoder.push(chunk);
				if (!decoder.complete) return;
				const incoming = decoder.finish();
				if (incoming.kind !== "notification" || incoming.recipientSessionId !== this.sessionID) { settle({ version: 1, kind: "ack", id: incoming.id, accepted: false, error: "rejected" }); return; }
				if (this.remember(incoming)) { settle({ version: 1, kind: "ack", id: incoming.id, accepted: false, error: "duplicate" }); return; }
				processing = true;
				this.deliver(incoming, settle, (cancel) => { cancelDelivery = cancel; });
			} catch { settle(); }
		});
		socket.on("end", () => {
			if (settled || processing) return;
			try { decoder.finish(); } catch { settle(); }
		});
		socket.on("error", () => settle());
		socket.on("close", () => settle());
	}

	private remember(incoming: NotificationFrame) {
		const key = `${incoming.senderSessionId}\0${incoming.id}`;
		if (this.seen.has(key)) {
			this.seen.delete(key);
			this.seen.set(key, true);
			return true;
		}
		if (this.seen.size === MAX_SEEN_NOTIFICATIONS) this.seen.delete(this.seen.keys().next().value!);
		this.seen.set(key, true);
		return false;
	}

	private deliver(incoming: NotificationFrame, settle: (frame?: AckFrame) => void, setCancel: (cancel: () => void) => void) {
		const payload = Object.freeze({ id: incoming.id, senderSessionId: incoming.senderSessionId, message: incoming.message });
		let timer: unknown;
		const cancel = () => {
			if (timer === undefined) return;
			const handle = timer;
			timer = undefined;
			try { this.scheduler.clearTimeout(handle); } catch { /* a test seam cannot interrupt settlement */ }
		};
		setCancel(cancel);
		try {
			timer = this.scheduler.setTimeout(() => {
				timer = undefined;
				settle({ version: 1, kind: "ack", id: incoming.id, accepted: false, error: "timeout" });
			}, this.callbackDeadlineMs);
		} catch { settle({ version: 1, kind: "ack", id: incoming.id, accepted: false, error: "timeout" }); return; }
		void Promise.resolve().then(() => this.onNotification(payload)).then(
			() => { cancel(); settle({ version: 1, kind: "ack", id: incoming.id, accepted: true }); },
			() => { cancel(); settle({ version: 1, kind: "ack", id: incoming.id, accepted: false, error: "rejected" }); },
		);
	}

	private fail(record: PresenceRecord) {
		if (this.failure || this.state === "closed") return;
		this.generation++;
		this.failure = Object.freeze({ code: "io_error", message: "listener failed" });
		this.state = "failed";
		void this.beginClose(this.record ?? record);
	}

	private cleanup(record?: PresenceRecord) {
		if (this.cleanupPromise) return this.cleanupPromise;
		const server = this.server;
		this.cleanupPromise = (async () => {
			const sockets = [...this.sockets];
			for (const settle of this.settleSockets.values()) settle();
			for (const socket of sockets) socket.destroy();
			if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			if (record) {
				await this.registry.removeOwn(record).catch(() => {});
				try { await this.beforeEndpointCleanup?.(); } catch { /* a test seam cannot leak through cleanup */ }
			}
			if (this.server === server) this.server = undefined;
		})();
		return this.cleanupPromise;
	}
}

type ClientCode = "self" | "busy" | "closed" | "aborted" | "stale" | "not_found" | "connect_timeout" | "ack_timeout" | "remote_rejected" | "invalid_ack" | "io_error";
type ClientScheduler = Readonly<{ setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (handle: unknown) => void }>;
type ClientSocketFactory = (endpoint: string) => Socket;
export type ActiveSessionClientOptions = Readonly<{ signal?: AbortSignal; id?: string; expectedActivation?: PresenceRecord; beforeConnect?: () => boolean | Promise<boolean> }>;
export type ActiveSessionClientConfig = Readonly<{ connectDeadlineMs?: number; ackDeadlineMs?: number; scheduler?: ClientScheduler; connect?: ClientSocketFactory }>;
export type SentNotification = Readonly<{ id: string; accepted: true }>;

export class ActiveSessionClientError extends Error {
	readonly code: ClientCode;
	constructor(code: ClientCode) { super("outbound session notification failed"); this.name = "ActiveSessionClientError"; this.code = code; }
}
const clientError = (code: ClientCode) => new ActiveSessionClientError(code);
const sameActivation = (left: PresenceRecord, right: PresenceRecord) => left.version === right.version && left.sessionId === right.sessionId && left.endpoint === right.endpoint && left.createdAt === right.createdAt;
const CLIENT_CONNECT_DEADLINE_MS = 500, CLIENT_ACK_DEADLINE_MS = 2000, MAX_OUTBOUND = 8;
const clientDeadline = (value: number | undefined, fallback: number, maximum: number) => {
	const deadline = value ?? fallback;
	if (!Number.isInteger(deadline) || deadline < 1 || deadline > maximum) throw new RangeError("invalid outbound deadline");
	return deadline;
};
type PendingOutbound = { settled: boolean; socket?: Socket; connectTimer?: unknown; ackTimer?: unknown; abort?: () => void; settle: (error?: ActiveSessionClientError, result?: SentNotification) => void };

export class ActiveSessionClient {
	readonly registry: SessionPresenceRegistry;
	readonly senderSessionId: string;
	private readonly scheduler: ClientScheduler;
	private readonly connectDeadlineMs: number;
	private readonly ackDeadlineMs: number;
	private readonly connect: ClientSocketFactory;
	private readonly pending = new Set<PendingOutbound>();
	private stopped = false;

	constructor(registry: SessionPresenceRegistry, senderSessionId: string, config: ActiveSessionClientConfig = {}) {
		this.registry = registry;
		this.senderSessionId = sessionId(senderSessionId);
		this.scheduler = config.scheduler ?? { setTimeout, clearTimeout };
		this.connectDeadlineMs = clientDeadline(config.connectDeadlineMs, CLIENT_CONNECT_DEADLINE_MS, CLIENT_CONNECT_DEADLINE_MS);
		this.ackDeadlineMs = clientDeadline(config.ackDeadlineMs, CLIENT_ACK_DEADLINE_MS, CLIENT_ACK_DEADLINE_MS);
		this.connect = config.connect ?? createConnection;
	}

	get pendingCount() { return this.pending.size; }
	get closed() { return this.stopped; }

	sendNotification(recipientSessionId: string, text: string, options: ActiveSessionClientOptions = {}): Promise<SentNotification> {
		let recipient: string, id: string;
		try { recipient = sessionId(recipientSessionId); id = options.id === undefined ? randomBytes(16).toString("hex") : sessionId(options.id); }
		catch (error) { return Promise.reject(error); }
		if (recipient === this.senderSessionId) return Promise.reject(clientError("self"));
		if (this.stopped) return Promise.reject(clientError("closed"));
		if (this.pending.size >= MAX_OUTBOUND) return Promise.reject(clientError("busy"));
		if (options.signal?.aborted) return Promise.reject(clientError("aborted"));
		let pending!: PendingOutbound;
		const operation = new Promise<SentNotification>((resolve, reject) => {
			pending = { settled: false, settle: (error, result) => {
				if (pending.settled) return;
				pending.settled = true;
				for (const timer of [pending.connectTimer, pending.ackTimer]) if (timer !== undefined) try { this.scheduler.clearTimeout(timer); } catch { /* test seams cannot disrupt cleanup */ }
				pending.connectTimer = pending.ackTimer = undefined;
				if (pending.abort) options.signal?.removeEventListener("abort", pending.abort);
				this.pending.delete(pending);
				pending.socket?.destroy();
				if (error) reject(error); else resolve(result!);
			} };
			this.pending.add(pending);
			pending.abort = () => pending.settle(clientError(this.stopped ? "closed" : "aborted"));
			options.signal?.addEventListener("abort", pending.abort, { once: true });
			void this.begin(pending, recipient, text, id, options.expectedActivation, options.beforeConnect);
		});
		return operation;
	}

	close() {
		if (this.stopped) return;
		this.stopped = true;
		for (const pending of [...this.pending]) pending.settle(clientError("closed"));
	}

	private async begin(pending: PendingOutbound, recipient: string, text: string, id: string, expectedActivation: PresenceRecord | undefined, beforeConnect: (() => boolean | Promise<boolean>) | undefined) {
		let record: PresenceRecord;
		try { record = await this.registry.resolve(recipient); }
		catch (error) {
			pending.settle(clientError(expectedActivation !== undefined ? "stale" : error instanceof SessionPresenceError && error.code === "not_found" ? "not_found" : "io_error"));
			return;
		}
		if (pending.settled || this.stopped) { pending.settle(clientError("closed")); return; }
		if (expectedActivation !== undefined && !sameActivation(record, expectedActivation)) { pending.settle(clientError("stale")); return; }
		try {
			if (beforeConnect !== undefined && !await beforeConnect()) { pending.settle(clientError("stale")); return; }
		} catch { pending.settle(clientError("stale")); return; }
		if (pending.settled || this.stopped) { pending.settle(clientError("closed")); return; }
		let bytes: Buffer;
		try { bytes = encodeNotificationFrame(Object.freeze({ version: 1, kind: "notification", id, senderSessionId: this.senderSessionId, recipientSessionId: recipient, message: text })); }
		catch { pending.settle(clientError("io_error")); return; }
		let socket: Socket;
		try { socket = this.connect(record.endpoint); }
		catch { pending.settle(clientError("io_error")); return; }
		pending.socket = socket;
		const decoder = new FrameDecoder();
		let connected = false, staleCleanup: Promise<void> | undefined;
		const cancelConnect = () => {
			if (pending.connectTimer === undefined) return;
			try { this.scheduler.clearTimeout(pending.connectTimer); } catch {}
			pending.connectTimer = undefined;
		};
		const stale = (error: NodeJS.ErrnoException) => {
			if (pending.settled || staleCleanup) return;
			if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
				cancelConnect();
				staleCleanup = this.registry.removeOwn(record).catch(() => {}).then(() => { if (!pending.settled) pending.settle(clientError("io_error")); });
				socket.destroy();
			} else pending.settle(clientError("io_error"));
		};
		socket.on("error", stale);
		socket.once("connect", () => {
			if (pending.settled || staleCleanup) return;
			connected = true;
			cancelConnect();
			try { socket.write(bytes); } catch { pending.settle(clientError("io_error")); return; }
			try { pending.ackTimer = this.scheduler.setTimeout(() => pending.settle(clientError("ack_timeout")), this.ackDeadlineMs); }
			catch { pending.settle(clientError("ack_timeout")); }
		});
		const reply = () => {
			if (pending.settled || staleCleanup) return;
			try {
				const ack = decoder.finish();
				if (ack.kind !== "ack" || ack.id !== id) pending.settle(clientError("invalid_ack"));
				else if (!ack.accepted) pending.settle(clientError("remote_rejected"));
				else pending.settle(undefined, Object.freeze({ id, accepted: true }));
			} catch { pending.settle(clientError("invalid_ack")); }
		};
		socket.on("data", (chunk: Buffer) => { if (!pending.settled && !staleCleanup) try { decoder.push(chunk); } catch { pending.settle(clientError("invalid_ack")); } });
		socket.on("end", reply);
		socket.on("close", () => { if (!pending.settled && !staleCleanup) decoder.complete ? reply() : pending.settle(clientError("io_error")); });
		try { pending.connectTimer = this.scheduler.setTimeout(() => pending.settle(clientError("connect_timeout")), this.connectDeadlineMs); }
		catch { pending.settle(clientError("connect_timeout")); }
	}
}
