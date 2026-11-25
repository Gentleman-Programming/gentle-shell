// One server-owned agent session for `gentle-shell serve`. Pi runs under a
// detached session keeper (lib/serve-session-keeper.ts) that owns its stdin and
// stdout, numbers its JSONL output with a monotonic `seq` and keeps the replay
// ring, the dialogs still waiting for an answer and the host tool calls still
// open, so a session outlives a server restart. The server holds a mirror of
// that state, fed by the keeper over a Unix socket (a named pipe on Windows),
// plus what only it knows: the SSE subscribers, the requests waiting for an
// answer and which device runs host tools. A slow subscriber is dropped (it
// resyncs) instead of ever slowing the session.

import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export interface ServeSessionLimits {
	/** A single stdout record larger than this is dropped (a marker record takes its place). */
	maxLineBytes: number;
	/** Replay ring bounds: whichever is reached first evicts the oldest records. */
	ringRecords: number;
	ringBytes: number;
	/** Unsent bytes one subscriber may hold before it is dropped with a resync marker. */
	clientBufferBytes: number;
	/** Bytes waiting on the session's input before new commands are refused. */
	stdinBufferBytes: number;
	/** How long a stop waits after closing stdin and SIGTERM before SIGKILL. */
	stopGraceMs: number;
	/** How long a dropped subscriber's final marker may take to flush. */
	dropFlushMs: number;
	/** How long a host tool call waits for its device to reopen a stream after the device's last one closed. */
	hostToolGraceMs: number;
	/** After the server reattached a session: how long its open host tool calls wait for their devices to reconnect. */
	hostToolReattachGraceMs: number;
	/** How long the server remembers a host tool call it saw (the session itself gives up after 10 minutes). */
	hostToolTrackMs: number;
	/** How long the server's own "not connected" answer may take to reach the session. */
	hostToolAnswerMs: number;
}

export const SERVE_SESSION_LIMITS: ServeSessionLimits = {
	maxLineBytes: 16 * 1024 * 1024,
	ringRecords: 2000,
	ringBytes: 8 * 1024 * 1024,
	clientBufferBytes: 4 * 1024 * 1024,
	stdinBufferBytes: 16 * 1024 * 1024,
	stopGraceMs: 5000,
	dropFlushMs: 5000,
	hostToolGraceMs: 10_000,
	hostToolReattachGraceMs: 30_000,
	hostToolTrackMs: 11 * 60 * 1000,
	hostToolAnswerMs: 30_000,
};

/** Pi RPC dialog methods: they block until one `extension_ui_response` answers them. */
export const DIALOG_METHODS: Readonly<Record<string, true>> = { select: true, confirm: true, input: true, editor: true };
export const DESKTOP_RPC_SCHEMA = "gentle-shell.desktop-rpc/v1";
export const DESKTOP_RPC_WIDGET = "gentle-desktop-rpc";
/** Desktop RPC methods that only a client's own `/desktop` request may carry (see lib/desktop-rpc-host-tools.ts). */
export const HOST_TOOL_METHODS: Readonly<Record<string, true>> = { set_host_tools: true, host_tool_result: true, host_tool_progress: true, host_message: true, set_host_context: true, set_host_activity: true };
/** The keeper protocol both ends speak; a keeper answering another one is not attached. */
export const KEEPER_PROTOCOL = 1;

// --- JSONL framing -------------------------------------------------------------

/**
 * Splits a byte stream into records on LF only (an optional CR before it is
 * stripped). Unlike `readline`, U+2028/U+2029 inside JSON strings never split a
 * record. LF never occurs inside a multi-byte UTF-8 sequence, so decoding each
 * complete record on its own is exact.
 */
export class JsonlDecoder {
	private parts: Buffer[] = [];
	private size = 0;
	private discarding = false;
	private readonly onLine: (line: string) => void;
	private readonly onOversize: () => void;
	private readonly maxLineBytes: number;

	constructor(onLine: (line: string) => void, onOversize: () => void, maxLineBytes: number = SERVE_SESSION_LIMITS.maxLineBytes) {
		this.onLine = onLine;
		this.onOversize = onOversize;
		this.maxLineBytes = maxLineBytes;
	}

	push(chunk: Buffer): void {
		let start = 0;
		while (start < chunk.length) {
			const lf = chunk.indexOf(0x0a, start);
			const end = lf === -1 ? chunk.length : lf;
			if (!this.discarding) {
				const piece = chunk.subarray(start, end);
				if (this.size + piece.length > this.maxLineBytes) {
					this.parts = [];
					this.size = 0;
					this.discarding = true;
				} else if (piece.length > 0) {
					this.parts.push(piece);
					this.size += piece.length;
				}
			}
			if (lf === -1) break;
			this.finishRecord();
			start = lf + 1;
		}
	}

	/** Called when the stream ends: a last record without LF still counts. */
	end(): void {
		if (this.size > 0 || this.discarding) this.finishRecord();
	}

	private finishRecord(): void {
		if (this.discarding) {
			this.discarding = false;
			this.onOversize();
			return;
		}
		let bytes = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
		this.parts = [];
		this.size = 0;
		if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
		if (bytes.length > 0) this.onLine(bytes.toString("utf8"));
	}
}

// --- replay ring ---------------------------------------------------------------

export interface RingRecord {
	seq: number;
	line: string;
	bytes: number;
}

export type ReplayResult = { records: RingRecord[] } | { snapshotRequired: true; oldest: number };

/** Bounded by count and bytes; the newest record is always kept. */
export class ReplayRing {
	private records: RingRecord[] = [];
	private head = 0;
	private bytes = 0;
	private readonly maxRecords: number;
	private readonly maxBytes: number;

	constructor(maxRecords: number, maxBytes: number) {
		this.maxRecords = Math.max(1, maxRecords);
		this.maxBytes = maxBytes;
	}

	get length(): number {
		return this.records.length - this.head;
	}

	/** Oldest seq still held, or undefined when empty. */
	get oldest(): number | undefined {
		return this.length === 0 ? undefined : this.records[this.head].seq;
	}

	push(record: RingRecord): void {
		this.records.push(record);
		this.bytes += record.bytes;
		while (this.length > 1 && (this.length > this.maxRecords || this.bytes > this.maxBytes)) {
			this.bytes -= this.records[this.head].bytes;
			this.head += 1;
		}
		// Compact lazily so eviction stays O(1) amortized.
		if (this.head > 1024 && this.head * 2 > this.records.length) {
			this.records = this.records.slice(this.head);
			this.head = 0;
		}
	}

	/** Every record held, oldest first. */
	all(): RingRecord[] {
		return this.records.slice(this.head);
	}

	/**
	 * Records after `after`, or `snapshotRequired` when the client's cursor is
	 * older than the ring (something it never saw was evicted) or newer than
	 * the stream (it belongs to another session lifetime).
	 */
	since(after: number, current: number): ReplayResult {
		const oldest = this.oldest ?? current + 1;
		if (!Number.isSafeInteger(after) || after < 0 || after > current || after < oldest - 1) return { snapshotRequired: true, oldest };
		const out: RingRecord[] = [];
		for (let i = this.head; i < this.records.length; i += 1) if (this.records[i].seq > after) out.push(this.records[i]);
		return { records: out };
	}
}

// --- subscribers ---------------------------------------------------------------

/** The part of an HTTP response an SSE subscriber needs (a fake in tests). */
export interface StreamSink {
	write(chunk: string): boolean;
	end(chunk?: string): void;
	destroy(): void;
	readonly writableLength: number;
	readonly destroyed?: boolean;
}

export interface Subscriber {
	sink: StreamSink;
	/** The device that opened the stream; revoking it closes the stream. */
	deviceId: string;
}

export function sseRecord(seq: number, line: string): string {
	return `id: ${seq}\ndata: ${line}\n\n`;
}

export function sseEvent(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// --- the session's record state ------------------------------------------------

export interface SessionLaunch {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type SessionState = "running" | "exited";

export interface PendingDialog {
	id: string;
	seq: number;
	line: string;
	expiresAt?: number;
}

/** A `host_tool_call` the session emitted that no `host_tool_result` or `host_tool_cancel` settled yet. */
export interface PendingHostCall {
	callId: string;
	/** In serve, always the id of the device that registered the tool. */
	provider: string;
	tool: string;
	seq: number;
	line: string;
	/** When the call was emitted, or last kept alive by a `host_tool_progress`. */
	at: number;
}

/** What a record means to the session's state and to the requests waiting on it. */
export type RecordEvent =
	| { kind: "response"; id: string }
	| { kind: "dialog"; id: string; timeout?: number }
	| { kind: "dialog_resolved"; id: string }
	| { kind: "desktop_response"; requestId: string; answer: Record<string, unknown> }
	| { kind: "host_tool_call"; callId: string; provider: string; tool: string }
	| { kind: "host_tool_cancel"; callId: string }
	| { kind: "dropped" }
	| { kind: "exited"; code: number | null; signal: string | null }
	| undefined;

/** Records the server side adds to a stream; a session child may not print them. */
export function isServerRecordType(type: unknown): boolean {
	return typeof type === "string" && type.startsWith("serve_");
}

export function classifyRecord(record: Record<string, unknown>): RecordEvent {
	switch (record.type) {
		case "response":
			return typeof record.id === "string" ? { kind: "response", id: record.id } : undefined;
		case "serve_dialog_resolved":
			return typeof record.id === "string" ? { kind: "dialog_resolved", id: record.id } : undefined;
		case "serve_record_dropped":
			return { kind: "dropped" };
		case "serve_session_exited":
			return { kind: "exited", code: typeof record.code === "number" ? record.code : null, signal: typeof record.signal === "string" ? record.signal : null };
		case "extension_ui_request":
			break;
		default:
			return undefined;
	}
	if (typeof record.id !== "string") return undefined;
	const method = record.method;
	if (typeof method === "string" && Object.hasOwn(DIALOG_METHODS, method)) {
		return { kind: "dialog", id: record.id, ...(typeof record.timeout === "number" && record.timeout > 0 ? { timeout: record.timeout } : {}) };
	}
	if (method !== "setWidget" || record.widgetKey !== DESKTOP_RPC_WIDGET || !Array.isArray(record.widgetLines) || typeof record.widgetLines[0] !== "string") return undefined;
	let answer: unknown;
	try {
		answer = JSON.parse(record.widgetLines[0]);
	} catch {
		return undefined;
	}
	if (!answer || typeof answer !== "object") return undefined;
	const a = answer as Record<string, unknown>;
	if (a.kind === "response") return typeof a.requestId === "string" ? { kind: "desktop_response", requestId: a.requestId, answer: a } : undefined;
	if (a.kind !== "event") return undefined;
	const data = a.data;
	if (!data || typeof data !== "object" || !("callId" in data) || typeof data.callId !== "string") return undefined;
	if (a.event === "host_tool_cancel") return { kind: "host_tool_cancel", callId: data.callId };
	if (a.event !== "host_tool_call" || !("provider" in data) || typeof data.provider !== "string" || !("tool" in data) || typeof data.tool !== "string") return undefined;
	return { kind: "host_tool_call", callId: data.callId, provider: data.provider, tool: data.tool };
}

/** The state a keeper hands the server when it attaches; the ring's records follow it on the wire. */
export interface SessionSnapshot {
	protocol: number;
	id: string;
	cwd: string;
	startedAt: number;
	pid: number | null;
	state: SessionState;
	exitCode: number | null;
	exitSignal: string | null;
	exitedAt: number | null;
	seq: number;
	invalidRecords: number;
	droppedRecords: number;
	dialogs: PendingDialog[];
	answered: string[];
	hostCalls: PendingHostCall[];
	/** What the server keeps with the keeper so a restarted server knows it (host tool providers, activity). */
	notes: unknown;
}

const ANSWERED_MEMORY = 256;

/**
 * The session's stream and what it implies: `seq`, the replay ring, pending
 * dialogs (with the ids answered lately) and open host tool calls, and whether
 * it exited. The keeper holds the authoritative one; the server a mirror fed
 * with the same records, so both always agree.
 */
export class SessionLog {
	seq = 0;
	state: SessionState = "running";
	exitCode: number | null = null;
	exitSignal: string | null = null;
	exitedAt?: number;
	invalidRecords = 0;
	droppedRecords = 0;
	readonly ring: ReplayRing;
	private readonly dialogs = new Map<string, PendingDialog>();
	private readonly answered: string[] = [];
	private readonly hostCalls = new Map<string, PendingHostCall>();
	private readonly limits: Pick<ServeSessionLimits, "ringRecords" | "ringBytes" | "hostToolTrackMs">;
	private readonly now: () => number;

	constructor(limits: Pick<ServeSessionLimits, "ringRecords" | "ringBytes" | "hostToolTrackMs">, now: () => number) {
		this.limits = limits;
		this.now = now;
		this.ring = new ReplayRing(limits.ringRecords, limits.ringBytes);
	}

	/** Takes `record` (the parsed `line`) as record `seq` and applies what it means. */
	push(seq: number, line: string, record: Record<string, unknown>): RecordEvent {
		this.seq = seq;
		this.ring.push({ seq, line, bytes: Buffer.byteLength(line) });
		const event = classifyRecord(record);
		switch (event?.kind) {
			case "dialog":
				if (this.state === "running") this.dialogs.set(event.id, { id: event.id, seq, line, ...(event.timeout === undefined ? {} : { expiresAt: this.now() + event.timeout }) });
				break;
			case "dialog_resolved":
				this.dialogs.delete(event.id);
				this.answered.push(event.id);
				if (this.answered.length > ANSWERED_MEMORY) this.answered.shift();
				break;
			case "host_tool_call": {
				const now = this.now();
				for (const [id, call] of this.hostCalls) if (now - call.at > this.limits.hostToolTrackMs) this.hostCalls.delete(id);
				if (this.state === "running") this.hostCalls.set(event.callId, { callId: event.callId, provider: event.provider, tool: event.tool, seq, line, at: now });
				break;
			}
			case "host_tool_cancel":
				this.hostCalls.delete(event.callId);
				break;
			case "dropped":
				this.droppedRecords += 1;
				break;
			case "exited":
				this.state = "exited";
				this.exitCode = event.code;
				this.exitSignal = event.signal;
				this.exitedAt = this.now();
				this.dialogs.clear();
				this.hostCalls.clear();
				break;
		}
		return event;
	}

	pendingDialogs(): PendingDialog[] {
		const now = this.now();
		for (const [id, dialog] of this.dialogs) if (dialog.expiresAt !== undefined && dialog.expiresAt <= now) this.dialogs.delete(id);
		return [...this.dialogs.values()];
	}

	dialogStatus(id: string): "pending" | "answered" | "unknown" {
		if (this.pendingDialogs().some((dialog) => dialog.id === id)) return "pending";
		return this.answered.includes(id) ? "answered" : "unknown";
	}

	hostCall(callId: string): PendingHostCall | undefined {
		return this.hostCalls.get(callId);
	}

	pendingHostCalls(): PendingHostCall[] {
		return [...this.hostCalls.values()];
	}

	settle(callId: string): void {
		this.hostCalls.delete(callId);
	}

	/** A `host_tool_progress` kept the call alive: tracking it starts over. */
	progress(callId: string): void {
		const call = this.hostCalls.get(callId);
		if (call) call.at = this.now();
	}

	snapshot(): Pick<SessionSnapshot, "state" | "exitCode" | "exitSignal" | "exitedAt" | "seq" | "invalidRecords" | "droppedRecords" | "dialogs" | "answered" | "hostCalls"> {
		return {
			state: this.state,
			exitCode: this.exitCode,
			exitSignal: this.exitSignal,
			exitedAt: this.exitedAt ?? null,
			seq: this.seq,
			invalidRecords: this.invalidRecords,
			droppedRecords: this.droppedRecords,
			dialogs: this.pendingDialogs(),
			answered: [...this.answered],
			hostCalls: this.pendingHostCalls(),
		};
	}

	/** Takes over a keeper's state (its ring records are pushed into `ring` as they arrive). */
	restore(snapshot: SessionSnapshot): void {
		this.seq = snapshot.seq;
		this.state = snapshot.state;
		this.exitCode = snapshot.exitCode;
		this.exitSignal = snapshot.exitSignal;
		if (snapshot.exitedAt !== null) this.exitedAt = snapshot.exitedAt;
		this.invalidRecords = snapshot.invalidRecords;
		this.droppedRecords = snapshot.droppedRecords;
		for (const dialog of snapshot.dialogs) this.dialogs.set(dialog.id, dialog);
		this.answered.push(...snapshot.answered.slice(-ANSWERED_MEMORY));
		for (const call of snapshot.hostCalls) this.hostCalls.set(call.callId, call);
	}
}

// --- the link to a keeper --------------------------------------------------------

/**
 * Wire format, both ways one record per LF-terminated line. Keeper → server:
 * `<seq> <record>` for each stream record, or a JSON control object
 * (`{"t":"snapshot",…}` then the ring as records then `{"t":"live"}` when the
 * server attaches; `{"t":"invalid"}`, `{"t":"stderr","text"}`,
 * `{"t":"reply","rid","outcome"}`). Server → keeper: `{"op":"hello","token","protocol"}`
 * first, then `>` followed by one Pi RPC command for the session's stdin, or a
 * JSON op (`answer`, `settled`, `progressed`, `notes`, `stop`).
 */
interface LinkHandlers {
	record: (seq: number, line: string) => void;
	message: (message: Record<string, unknown>) => void;
	close: () => void;
}

export class KeeperLink {
	private readonly socket: Socket;
	private handlers?: LinkHandlers;
	private readonly early: Array<() => void> = [];
	private readonly replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private nextRid = 0;
	closed = false;

	private constructor(socket: Socket) {
		this.socket = socket;
	}

	/** Connects to a keeper and receives its state: the snapshot and the ring, then the link is live. */
	static connect(endpoint: string, token: string, options: { timeoutMs: number; maxLineBytes: number }): Promise<{ link: KeeperLink; snapshot: SessionSnapshot; ring: RingRecord[] }> {
		const { promise, resolve, reject } = Promise.withResolvers<{ link: KeeperLink; snapshot: SessionSnapshot; ring: RingRecord[] }>();
		const socket = connect(endpoint);
		const link = new KeeperLink(socket);
		let snapshot: SessionSnapshot | undefined;
		const ring: RingRecord[] = [];
		let live = false;
		const fail = (message: string) => {
			if (live) return;
			live = true;
			clearTimeout(timer);
			socket.destroy();
			reject(Object.assign(new Error(message), { code: "keeper_unavailable" }));
		};
		const timer = setTimeout(() => fail("the session keeper did not answer"), options.timeoutMs);
		const decoder = new JsonlDecoder((line) => {
			if (live) return link.receive(line);
			if (line.startsWith("{")) {
				let message: Record<string, unknown>;
				try { message = JSON.parse(line) as Record<string, unknown>; } catch { return fail("the session keeper sent a malformed line"); }
				if (message.t === "snapshot") {
					if (message.protocol !== KEEPER_PROTOCOL) return fail(`the session keeper speaks protocol ${String(message.protocol)}`);
					snapshot = message as unknown as SessionSnapshot;
					return;
				}
				if (message.t !== "live" || !snapshot) return fail("the session keeper sent an unexpected line");
				live = true;
				clearTimeout(timer);
				return resolve({ link, snapshot, ring });
			}
			const record = parseRecordLine(line);
			if (!record || !snapshot) return fail("the session keeper sent a malformed line");
			ring.push({ ...record, bytes: Buffer.byteLength(record.line) });
		}, () => fail("the session keeper sent an oversize line"), options.maxLineBytes + 64);
		socket.setNoDelay(true);
		socket.on("connect", () => socket.write(`${JSON.stringify({ op: "hello", token, protocol: KEEPER_PROTOCOL })}\n`));
		socket.on("data", (chunk: Buffer) => decoder.push(chunk));
		socket.on("error", (error) => fail(error.message));
		socket.on("close", () => {
			fail("the session keeper closed the connection");
			link.onClose();
		});
		return promise;
	}

	/** Starts delivering what arrived since the handshake, then everything live. */
	attach(handlers: LinkHandlers): void {
		this.handlers = handlers;
		for (const deliver of this.early.splice(0)) deliver();
	}

	private dispatch(deliver: () => void): void {
		if (this.handlers) deliver();
		else this.early.push(deliver);
	}

	private receive(line: string): void {
		if (!line.startsWith("{")) {
			const record = parseRecordLine(line);
			if (record) this.dispatch(() => this.handlers!.record(record.seq, record.line));
			return;
		}
		let message: Record<string, unknown>;
		try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
		if (message.t === "reply" && typeof message.rid === "number") {
			const reply = this.replies.get(message.rid);
			this.replies.delete(message.rid);
			reply?.resolve(message.outcome);
			return;
		}
		this.dispatch(() => this.handlers!.message(message));
	}

	private onClose(): void {
		this.closed = true;
		const gone = new SessionError("session_exited", "The session has exited");
		for (const reply of this.replies.values()) reply.reject(gone);
		this.replies.clear();
		this.dispatch(() => this.handlers!.close());
	}

	get writableLength(): number {
		return this.socket.writableLength;
	}

	/** One line to the keeper (a `>` stdin line or a JSON op). */
	send(line: string): void {
		if (!this.closed) this.socket.write(`${line}\n`);
	}

	/** A JSON op the keeper answers with a `reply`. */
	request(op: Record<string, unknown>): Promise<unknown> {
		if (this.closed) return Promise.reject(new SessionError("session_exited", "The session has exited"));
		this.nextRid += 1;
		const rid = this.nextRid;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.replies.set(rid, { resolve, reject });
		this.send(JSON.stringify({ ...op, rid }));
		return promise;
	}

	/** Closes the connection; the keeper and its session keep running. */
	close(): void {
		this.closed = true;
		this.socket.destroy();
	}
}

/** `<seq> <record>` → its parts. */
export function parseRecordLine(line: string): { seq: number; line: string } | undefined {
	const space = line.indexOf(" ");
	const seq = Number(line.slice(0, space));
	return space > 0 && Number.isSafeInteger(seq) && seq > 0 ? { seq, line: line.slice(space + 1) } : undefined;
}

// --- the session, as the server holds it -----------------------------------------

export type RpcOutcome = { response: Record<string, unknown> } | { timeout: true; id: string };
export type DialogAnswer = "accepted" | "unknown" | "answered";

export class SessionError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "SessionError";
	}
}

export interface ServeSessionOptions {
	/** The keeper's state at attach time; for a session listed from its record, a snapshot without a link. */
	snapshot: SessionSnapshot;
	/** The keeper's ring, oldest first. */
	ring?: readonly RingRecord[];
	/** The live link to the keeper; none for a session whose keeper already ended. */
	link?: KeeperLink;
	/** The server attached to a keeper a previous server started: open host tool calls wait for their devices to come back. */
	reattached?: boolean;
	limits?: Partial<ServeSessionLimits>;
	now?: () => number;
	/** The child's stderr, for the server log; never part of the protocol. */
	onStderr?: (text: string) => void;
	onExit?: (session: ServeSession) => void;
	/** A device's name for the model-facing "not connected" answer; the id when unknown. */
	deviceLabel?: (deviceId: string) => string | undefined;
}

interface Waiter {
	/** `undefined` means the wait was given up (timeout or cancel). */
	resolve: (record: Record<string, unknown> | undefined) => void;
	reject: (error: Error) => void;
}

/** Notes the server keeps with the keeper (see `SessionSnapshot.notes`). */
interface SessionNotes {
	/** Devices that registered host tools. */
	providers: string[];
	/** Devices that drove the session, most recent first. */
	recent: string[];
	/** The providers order last sent with `set_host_activity`, serialized. */
	sent: string;
}

function readNotes(notes: unknown): SessionNotes | undefined {
	if (!notes || typeof notes !== "object") return undefined;
	const n = notes as Record<string, unknown>;
	const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string") ? value as string[] : undefined;
	const providers = strings(n.providers);
	const recent = strings(n.recent);
	if (!providers || !recent || typeof n.sent !== "string") return undefined;
	return { providers, recent, sent: n.sent };
}

export class ServeSession {
	readonly id: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly pid: number | undefined;

	private readonly limits: ServeSessionLimits;
	private readonly now: () => number;
	private readonly log: SessionLog;
	private readonly link?: KeeperLink;
	private readonly rpcWaiters = new Map<string, Waiter>();
	private readonly desktopWaiters = new Map<string, Waiter>();
	private readonly subscribers = new Set<Subscriber>();
	private readonly exited: Promise<void>;
	private readonly markExited: () => void;
	private readonly onStderr?: (text: string) => void;
	private readonly onExit?: (session: ServeSession) => void;
	/** Request ids are unique per server run: a late response to a previous run's request never matches. */
	private readonly epoch = randomBytes(4).toString("hex");
	private nextRpc = 0;
	private nextDesktop = 0;
	private detached = false;
	/** Devices whose last stream closed while they owed host tool results, and the timer that fails those calls. */
	private readonly graceTimers = new Map<string, NodeJS.Timeout>();
	private readonly deviceLabel: (deviceId: string) => string | undefined;
	/** When each device last drove this session (an operate request). */
	private readonly activity = new Map<string, number>();
	private activitySeq = 0;
	/** Devices that registered host tools in this session: only their order matters to the session. */
	private readonly hostProviders = new Set<string>();
	/** The connected-providers order last sent with `set_host_activity`, serialized. */
	private sentActivity = "[]";
	private sentNotes = "";

	constructor(options: ServeSessionOptions) {
		const snapshot = options.snapshot;
		this.id = snapshot.id;
		this.cwd = snapshot.cwd;
		this.startedAt = snapshot.startedAt;
		this.pid = snapshot.pid ?? undefined;
		this.deviceLabel = options.deviceLabel ?? (() => undefined);
		this.limits = { ...SERVE_SESSION_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.onStderr = options.onStderr;
		this.onExit = options.onExit;
		this.log = new SessionLog(this.limits, this.now);
		this.log.restore(snapshot);
		for (const record of options.ring ?? []) this.log.ring.push(record);
		const notes = readNotes(snapshot.notes);
		if (notes) {
			for (const provider of notes.providers) this.hostProviders.add(provider);
			for (const deviceId of [...notes.recent].reverse()) this.activity.set(deviceId, (this.activitySeq += 1));
			this.sentActivity = notes.sent;
		}
		this.sentNotes = JSON.stringify(this.notes());
		const exited = Promise.withResolvers<void>();
		this.exited = exited.promise;
		this.markExited = exited.resolve;
		if (this.log.state === "exited") exited.resolve();
		this.link = options.link;
		if (this.link) {
			this.link.attach({
				record: (seq, line) => this.onRecord(seq, line),
				message: (message) => {
					if (message.t === "invalid") this.log.invalidRecords += 1;
					else if (message.t === "stderr" && typeof message.text === "string") this.onStderr?.(message.text);
				},
				close: () => this.onLinkClosed(),
			});
		} else if (this.log.state === "running") {
			this.onLinkClosed();
		}
		if (options.reattached && this.log.state === "running") {
			// Nobody is connected yet: each device gets a while to come back for the calls it owes.
			for (const provider of new Set(this.log.pendingHostCalls().map((call) => call.provider))) this.armGrace(provider, this.limits.hostToolReattachGraceMs);
		}
	}

	get state(): SessionState {
		return this.log.state;
	}

	get seq(): number {
		return this.log.seq;
	}

	get exitCode(): number | null {
		return this.log.exitCode;
	}

	get exitSignal(): string | null {
		return this.log.exitSignal;
	}

	get exitedAt(): number | undefined {
		return this.log.exitedAt;
	}

	get invalidRecords(): number {
		return this.log.invalidRecords;
	}

	get droppedRecords(): number {
		return this.log.droppedRecords;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	pendingDialogs(): PendingDialog[] {
		return this.log.pendingDialogs();
	}

	// --- output ---

	private onRecord(seq: number, line: string): void {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		const event = this.log.push(seq, line, record);
		this.broadcast(sseRecord(seq, line));
		switch (event?.kind) {
			case "response": {
				const waiter = this.rpcWaiters.get(event.id);
				if (waiter) {
					this.rpcWaiters.delete(event.id);
					waiter.resolve(record);
				}
				return;
			}
			case "desktop_response": {
				const waiter = this.desktopWaiters.get(event.requestId);
				if (waiter) {
					this.desktopWaiters.delete(event.requestId);
					waiter.resolve(event.answer);
				}
				return;
			}
			case "host_tool_call": {
				// Routed to the device that provides the tool: every subscriber sees the record (clients
				// filter by `provider`), and when that device has no open stream the server answers for it
				// at once with an error result the model can read, instead of letting the turn hang.
				const call = this.log.hostCall(event.callId);
				if (call && !this.hasStream(call.provider)) this.failHostCall(call);
				return;
			}
			case "exited":
				this.onExited();
				return;
		}
	}

	/** The keeper went away without the session's exit record: it ended (or was killed) with its session. */
	private onLinkClosed(): void {
		if (this.detached || this.log.state === "exited") return;
		const line = JSON.stringify({ type: "serve_session_exited", code: null, signal: null, error: "keeper_lost" });
		this.onRecord(this.log.seq + 1, line);
	}

	// --- host tools ---

	private hasStream(deviceId: string): boolean {
		for (const sub of this.subscribers) if (sub.deviceId === deviceId && !sub.sink.destroyed) return true;
		return false;
	}

	/** Answers the call on its device's behalf: the tool's device is not connected. */
	private failHostCall(call: PendingHostCall): void {
		if (this.log.hostCall(call.callId) !== call) return;
		this.hostCallSettled(call.callId);
		const label = this.deviceLabel(call.provider) ?? call.provider;
		const text = `${call.tool} runs in ${label}, which isn't connected right now.`;
		// A result the device sent meanwhile wins; the session answers this one `already_answered`.
		this.desktop("host_tool_result", { callId: call.callId, content: [{ type: "text", text }], isError: true }, this.limits.hostToolAnswerMs).catch(() => {});
	}

	/** A device sent an operate request (a prompt, a steer, a dialog answer, a Desktop write): it becomes the first to run host tool calls. */
	noteActivity(deviceId: string): void {
		this.activitySeq += 1;
		this.activity.set(deviceId, this.activitySeq);
		this.syncActivity();
		this.saveNotes();
	}

	/** A device registered host tools (`tools` > 0) or withdrew them all. */
	noteHostProvider(deviceId: string, tools: number): void {
		if (tools > 0) this.hostProviders.add(deviceId);
		else this.hostProviders.delete(deviceId);
		this.syncActivity();
		this.saveNotes();
	}

	/** The device that most recently drove this session, if any did. */
	lastActiveDevice(): string | undefined {
		let last: string | undefined;
		let at = 0;
		for (const [deviceId, seq] of this.activity) if (seq > at) [last, at] = [deviceId, seq];
		return last;
	}

	private notes(): SessionNotes {
		const recent = [...this.activity].sort((a, b) => b[1] - a[1]).map(([deviceId]) => deviceId);
		return { providers: [...this.hostProviders], recent, sent: this.sentActivity };
	}

	/** Hands the keeper what a restarted server must know, when it changed. */
	private saveNotes(): void {
		const notes = JSON.stringify(this.notes());
		if (notes === this.sentNotes || this.log.state !== "running") return;
		this.sentNotes = notes;
		this.link?.send(`{"op":"notes","notes":${notes}}`);
	}

	/**
	 * Tells the session which host tool providers are connected, most recently
	 * active first (`set_host_activity`), whenever that order changes: a host
	 * tool several devices provide goes to the first of them. Written to the
	 * session before any command the same request forwards, so a prompt's tool
	 * calls see its device. Sessions without host tools never get one.
	 */
	private syncActivity(): void {
		if (this.log.state !== "running" || this.detached) return;
		const connected = new Set<string>();
		for (const sub of this.subscribers) if (!sub.sink.destroyed && this.hostProviders.has(sub.deviceId)) connected.add(sub.deviceId);
		const providers = [...connected].sort((a, b) => (this.activity.get(b) ?? 0) - (this.activity.get(a) ?? 0));
		const serialized = JSON.stringify(providers);
		if (serialized === this.sentActivity) return;
		this.sentActivity = serialized;
		this.saveNotes();
		this.desktop("set_host_activity", { providers }, this.limits.hostToolAnswerMs).catch(() => {});
	}

	/** After a device's last stream closed: its calls fail unless it reconnects within the grace period (at once when revoked). */
	private deviceLeft(deviceId: string, immediately = false): void {
		this.syncActivity();
		if (this.log.state !== "running" || this.detached || this.hasStream(deviceId) || this.graceTimers.has(deviceId)) return;
		if (immediately) {
			for (const call of this.owed(deviceId)) this.failHostCall(call);
			return;
		}
		this.armGrace(deviceId, this.limits.hostToolGraceMs);
	}

	private owed(deviceId: string): PendingHostCall[] {
		return this.log.pendingHostCalls().filter((call) => call.provider === deviceId);
	}

	private armGrace(deviceId: string, ms: number): void {
		if (this.owed(deviceId).length === 0 || this.graceTimers.has(deviceId)) return;
		const timer = setTimeout(() => {
			this.graceTimers.delete(deviceId);
			if (this.hasStream(deviceId)) return;
			for (const call of this.owed(deviceId)) this.failHostCall(call);
		}, ms);
		timer.unref?.();
		this.graceTimers.set(deviceId, timer);
	}

	/** The device that must answer `callId`, if the server saw that call and it is still open. */
	hostCallProvider(callId: string): string | undefined {
		return this.log.hostCall(callId)?.provider;
	}

	/** A `host_tool_result` reached the session and settled (or could no longer settle) the call. */
	hostCallSettled(callId: string): void {
		if (!this.log.hostCall(callId)) return;
		this.log.settle(callId);
		this.link?.send(JSON.stringify({ op: "settled", callId }));
	}

	/** A `host_tool_progress` reached the session and restarted the call's deadline: keep tracking it as long. */
	hostCallProgressed(callId: string): void {
		if (!this.log.hostCall(callId)) return;
		this.log.progress(callId);
		this.link?.send(JSON.stringify({ op: "progressed", callId }));
	}

	pendingHostCalls(): PendingHostCall[] {
		return this.log.pendingHostCalls();
	}

	private broadcast(frame: string): void {
		for (const sub of this.subscribers) {
			if (sub.sink.destroyed) {
				this.subscribers.delete(sub);
				this.deviceLeft(sub.deviceId);
				continue;
			}
			if (sub.sink.writableLength > this.limits.clientBufferBytes) {
				this.drop(sub, "slow_client");
				continue;
			}
			sub.sink.write(frame);
		}
	}

	/** Ends a subscriber's stream with a resync marker; it reconnects with its last seq. */
	drop(sub: Subscriber, reason: string): void {
		if (!this.subscribers.delete(sub)) return;
		this.deviceLeft(sub.deviceId);
		try {
			sub.sink.end(sseEvent("resync", { reason, seq: this.log.seq }));
		} catch {
			sub.sink.destroy();
			return;
		}
		// A client that never reads would hold the marker (and its buffer) forever.
		const timer = setTimeout(() => sub.sink.destroy(), this.limits.dropFlushMs);
		timer.unref?.();
	}

	/** Closes every stream opened by `deviceId` (a revoked device); the host tool calls it owed fail now. */
	dropDevice(deviceId: string): void {
		for (const sub of [...this.subscribers]) {
			if (sub.deviceId !== deviceId) continue;
			this.subscribers.delete(sub);
			sub.sink.destroy();
		}
		this.deviceLeft(deviceId, true);
	}

	heartbeat(): void {
		for (const sub of this.subscribers) {
			if (sub.sink.writableLength > this.limits.clientBufferBytes) this.drop(sub, "slow_client");
			else sub.sink.write(": ping\n\n");
		}
	}

	/**
	 * Attaches an SSE subscriber: a `hello`, then either the records after
	 * `after` or `snapshot-required`, then every dialog still waiting that the
	 * replay did not carry, then (to the device that provides them) the host
	 * tool calls still waiting that the replay did not carry, then the live
	 * stream. An exited session's stream ends after that.
	 */
	subscribe(sink: StreamSink, deviceId: string, after?: number): void {
		const ring = this.log.ring;
		const hello = { session: this.id, state: this.log.state, seq: this.log.seq, oldest: ring.oldest ?? null };
		sink.write(`retry: 3000\n\n${sseEvent("hello", hello)}`);
		let replayedFrom = Number.POSITIVE_INFINITY;
		if (after !== undefined) {
			const replay = ring.since(after, this.log.seq);
			if ("snapshotRequired" in replay) {
				sink.write(sseEvent("snapshot-required", { after, oldest: replay.oldest, seq: this.log.seq }));
			} else {
				replayedFrom = after;
				for (const r of replay.records) sink.write(sseRecord(r.seq, r.line));
			}
		}
		for (const dialog of this.pendingDialogs()) {
			if (dialog.seq > replayedFrom) continue;
			sink.write(`event: dialog\ndata: ${dialog.line}\n\n`);
		}
		for (const call of this.log.pendingHostCalls()) {
			if (call.provider !== deviceId || call.seq > replayedFrom) continue;
			sink.write(`event: host_tool_call\ndata: ${call.line}\n\n`);
		}
		if (this.log.state === "exited" || this.detached) {
			sink.end();
			return;
		}
		this.subscribers.add({ sink, deviceId });
		const grace = this.graceTimers.get(deviceId);
		if (grace !== undefined) {
			clearTimeout(grace);
			this.graceTimers.delete(deviceId);
		}
		this.syncActivity();
	}

	unsubscribe(sink: StreamSink): void {
		for (const sub of this.subscribers) {
			if (sub.sink !== sink) continue;
			this.subscribers.delete(sub);
			this.deviceLeft(sub.deviceId);
		}
	}

	// --- input ---

	private write(record: Record<string, unknown>): void {
		if (this.log.state !== "running") throw new SessionError("session_exited", "The session has exited");
		const link = this.link;
		if (!link || link.closed || this.detached) throw new SessionError("session_exited", "The session's input is closed");
		if (link.writableLength > this.limits.stdinBufferBytes) throw new SessionError("session_busy", "The session is not reading its input; try again later");
		link.send(`>${JSON.stringify(record)}`);
	}

	/**
	 * Sends one Pi RPC command under a server-assigned id (clients may share a
	 * session, so their own ids could collide) and waits for its response. The
	 * caller's `id` is put back on the response it gets.
	 */
	async rpc(command: Record<string, unknown>, timeoutMs: number): Promise<RpcOutcome> {
		this.nextRpc += 1;
		const id = `serve-rpc-${this.epoch}-${this.nextRpc}`;
		const response = this.waitFor(this.rpcWaiters, id, timeoutMs);
		try {
			this.write({ ...command, id });
		} catch (error) {
			this.cancelWait(this.rpcWaiters, id);
			throw error;
		}
		const record = await response;
		if (record === undefined) return { timeout: true, id };
		const { id: _server, ...rest } = record;
		return { response: command.id === undefined ? rest : { ...rest, id: command.id } };
	}

	/** Forwards an `extension_ui_response`; only the first answer to a dialog reaches Pi (the keeper decides). */
	async answerDialog(answer: Record<string, unknown>): Promise<DialogAnswer> {
		const id = answer.id;
		if (typeof id !== "string") return "unknown";
		const status = this.log.dialogStatus(id);
		if (status !== "pending") return status;
		if (this.log.state !== "running" || !this.link || this.detached) throw new SessionError("session_exited", "The session has exited");
		const outcome = await this.link.request({ op: "answer", answer });
		return outcome === "accepted" || outcome === "answered" ? outcome : "unknown";
	}

	/**
	 * One Desktop RPC request through `/gentle:desktop`, answered by the matching
	 * `gentle-desktop-rpc` widget. Returns the Desktop RPC response object, or
	 * undefined on timeout. A refused prompt is reported as its Pi response.
	 */
	async desktop(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ answer: Record<string, unknown> } | { prompt: Record<string, unknown> } | undefined> {
		this.nextDesktop += 1;
		const requestId = `serve-desktop-${this.epoch}-${this.nextDesktop}`;
		const message = `/gentle:desktop ${JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params })}`;
		const answer = this.waitFor(this.desktopWaiters, requestId, timeoutMs);
		// The session can exit while the prompt is in flight: that rejection is rethrown below, never unhandled.
		answer.catch(() => {});
		let prompt: RpcOutcome;
		try {
			prompt = await this.rpc({ type: "prompt", message }, timeoutMs);
		} catch (error) {
			this.cancelWait(this.desktopWaiters, requestId);
			throw error;
		}
		if ("response" in prompt && prompt.response.success !== true) {
			this.cancelWait(this.desktopWaiters, requestId);
			return { prompt: prompt.response };
		}
		const result = await answer;
		return result === undefined ? undefined : { answer: result };
	}

	private waitFor(waiters: Map<string, Waiter>, id: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown> | undefined>();
		const timer = setTimeout(() => {
			waiters.delete(id);
			resolve(undefined);
		}, timeoutMs);
		timer.unref?.();
		waiters.set(id, {
			resolve: (record) => { clearTimeout(timer); resolve(record); },
			reject: (error) => { clearTimeout(timer); reject(error); },
		});
		return promise;
	}

	private cancelWait(waiters: Map<string, Waiter>, id: string): void {
		waiters.get(id)?.resolve(undefined);
		waiters.delete(id);
	}

	// --- lifecycle ---

	private failWaiters(error: Error): void {
		for (const waiters of [this.rpcWaiters, this.desktopWaiters]) {
			for (const waiter of waiters.values()) waiter.reject(error);
			waiters.clear();
		}
	}

	private onExited(): void {
		for (const timer of this.graceTimers.values()) clearTimeout(timer);
		this.graceTimers.clear();
		this.failWaiters(new SessionError("session_exited", "The session has exited"));
		for (const sub of this.subscribers) sub.sink.end();
		this.subscribers.clear();
		this.onExit?.(this);
		this.markExited();
	}

	/**
	 * Orderly stop: the keeper closes the session's stdin and sends SIGTERM
	 * together (Pi treats them as one request), then SIGKILL, and ends.
	 */
	async stop(): Promise<void> {
		if (this.log.state === "exited") return;
		if (!this.link || this.link.closed) return this.exited;
		this.link.send(JSON.stringify({ op: "stop" }));
		// A keeper that never reports the exit is given up on: the link closes and the session counts as lost.
		const timer = setTimeout(() => this.link!.close(), this.limits.stopGraceMs + 5000);
		timer.unref?.();
		await this.exited;
		clearTimeout(timer);
	}

	/**
	 * Lets go of the session without stopping it (the server is stopping and a
	 * later one reattaches): streams end (clients reconnect to the next server
	 * with their last seq), waiting requests fail, the keeper keeps running.
	 */
	detach(): void {
		if (this.detached) return;
		this.detached = true;
		for (const timer of this.graceTimers.values()) clearTimeout(timer);
		this.graceTimers.clear();
		this.failWaiters(new SessionError("shutting_down", "The server is stopping"));
		for (const sub of this.subscribers) sub.sink.end();
		this.subscribers.clear();
		this.link?.close();
	}

	whenExited(): Promise<void> {
		return this.exited;
	}
}
