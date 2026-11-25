// One server-owned agent session for `gentle-shell serve`: a `--mode rpc`
// child, its JSONL output numbered with a monotonic `seq`, a bounded replay
// ring, the dialogs still waiting for an answer, and the SSE subscribers that
// follow it. A slow subscriber is dropped (it resyncs) instead of ever slowing
// the child: stdout is read continuously no matter who is listening.

import { spawn, type ChildProcess } from "node:child_process";

export interface ServeSessionLimits {
	/** A single stdout record larger than this is dropped (a marker record takes its place). */
	maxLineBytes: number;
	/** Replay ring bounds: whichever is reached first evicts the oldest records. */
	ringRecords: number;
	ringBytes: number;
	/** Unsent bytes one subscriber may hold before it is dropped with a resync marker. */
	clientBufferBytes: number;
	/** Bytes waiting on the child's stdin before new commands are refused. */
	stdinBufferBytes: number;
	/** How long a stop waits after closing stdin and SIGTERM before SIGKILL. */
	stopGraceMs: number;
	/** How long a dropped subscriber's final marker may take to flush. */
	dropFlushMs: number;
	/** How long a host tool call waits for its device to reopen a stream after the device's last one closed. */
	hostToolGraceMs: number;
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
	hostToolTrackMs: 11 * 60 * 1000,
	hostToolAnswerMs: 30_000,
};

/** Pi RPC dialog methods: they block until one `extension_ui_response` answers them. */
export const DIALOG_METHODS: Readonly<Record<string, true>> = { select: true, confirm: true, input: true, editor: true };
export const DESKTOP_RPC_SCHEMA = "gentle-shell.desktop-rpc/v1";
export const DESKTOP_RPC_WIDGET = "gentle-desktop-rpc";
/** Desktop RPC methods that only a client's own `/desktop` request may carry (see lib/desktop-rpc-host-tools.ts). */
export const HOST_TOOL_METHODS: Readonly<Record<string, true>> = { set_host_tools: true, host_tool_result: true, host_message: true, set_host_context: true };

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

	/**
	 * Records after `after`, or `snapshotRequired` when the client's cursor is
	 * older than the ring (something it never saw was evicted) or newer than
	 * the stream (it belongs to another server or session lifetime).
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

// --- the session ---------------------------------------------------------------

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
	id: string;
	launch: SessionLaunch;
	limits?: Partial<ServeSessionLimits>;
	now?: () => number;
	/** The child's stderr, for the server log; never part of the protocol. */
	onStderr?: (text: string) => void;
	onExit?: (session: ServeSession) => void;
	/** A device's name for the model-facing "not connected" answer; the id when unknown. */
	deviceLabel?: (deviceId: string) => string | undefined;
}

/** A `host_tool_call` the session emitted that no `host_tool_result` or `host_tool_cancel` settled yet. */
export interface PendingHostCall {
	callId: string;
	/** In serve, always the id of the device that registered the tool. */
	provider: string;
	tool: string;
	seq: number;
	line: string;
	at: number;
}

interface Waiter {
	/** `undefined` means the wait was given up (timeout or cancel). */
	resolve: (record: Record<string, unknown> | undefined) => void;
	reject: (error: Error) => void;
}

const ANSWERED_MEMORY = 256;

export class ServeSession {
	readonly id: string;
	readonly cwd: string;
	readonly startedAt: number;
	state: SessionState = "running";
	exitCode: number | null = null;
	exitSignal: string | null = null;
	exitedAt?: number;
	seq = 0;
	droppedRecords = 0;
	invalidRecords = 0;

	private readonly limits: ServeSessionLimits;
	private readonly now: () => number;
	private readonly ring: ReplayRing;
	private readonly dialogs = new Map<string, PendingDialog>();
	private readonly answered: string[] = [];
	private readonly rpcWaiters = new Map<string, Waiter>();
	private readonly desktopWaiters = new Map<string, Waiter>();
	private readonly subscribers = new Set<Subscriber>();
	private readonly child: ChildProcess;
	private readonly exited: Promise<void>;
	private nextRpc = 0;
	private nextDesktop = 0;
	private readonly hostCalls = new Map<string, PendingHostCall>();
	/** Devices whose last stream closed while they owed host tool results, and the timer that fails those calls. */
	private readonly graceTimers = new Map<string, NodeJS.Timeout>();
	private readonly deviceLabel: (deviceId: string) => string | undefined;

	constructor(options: ServeSessionOptions) {
		this.id = options.id;
		this.deviceLabel = options.deviceLabel ?? (() => undefined);
		this.cwd = options.launch.cwd;
		this.limits = { ...SERVE_SESSION_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.startedAt = this.now();
		this.ring = new ReplayRing(this.limits.ringRecords, this.limits.ringBytes);
		const decoder = new JsonlDecoder((line) => this.onChildLine(line), () => {
			this.droppedRecords += 1;
			this.emitServerRecord({ type: "serve_record_dropped", reason: "too_large", maxBytes: this.limits.maxLineBytes });
		}, this.limits.maxLineBytes);
		// stdin stays open for the child's whole life: closing it asks Pi to shut down.
		this.child = spawn(options.launch.command, options.launch.args, {
			cwd: options.launch.cwd,
			env: options.launch.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout!.on("data", (chunk: Buffer) => decoder.push(chunk));
		this.child.stdout!.on("end", () => decoder.end());
		this.child.stderr!.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
		// A child that exits while we write must not crash the server.
		this.child.stdin!.on("error", () => {});
		const exited = Promise.withResolvers<void>();
		this.exited = exited.promise;
		let done = false;
		const finish = (code: number | null, signal: string | null, error?: string) => {
			if (done) return;
			done = true;
			this.onChildExit(code, signal, error);
			options.onExit?.(this);
			exited.resolve();
		};
		this.child.once("error", (error) => finish(null, null, error.message));
		// `close` waits for stdout to drain, so every record lands before the exit record.
		this.child.once("close", (code, signal) => finish(code, signal));
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	pendingDialogs(): PendingDialog[] {
		this.pruneDialogs();
		return [...this.dialogs.values()];
	}

	// --- output ---

	private onChildLine(line: string): void {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			// stdout is reserved for protocol records; anything else is not forwarded.
			this.invalidRecords += 1;
			return;
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			this.invalidRecords += 1;
			return;
		}
		const seq = this.append(line);
		this.observe(record as Record<string, unknown>, seq, line);
	}

	private append(line: string): number {
		this.seq += 1;
		const seq = this.seq;
		this.ring.push({ seq, line, bytes: Buffer.byteLength(line) });
		this.broadcast(sseRecord(seq, line));
		return seq;
	}

	/** Records the server adds to the stream itself; they share the session's `seq`. */
	private emitServerRecord(record: Record<string, unknown>): void {
		this.append(JSON.stringify(record));
	}

	private observe(record: Record<string, unknown>, seq: number, line: string): void {
		if (record.type === "response" && typeof record.id === "string") {
			const waiter = this.rpcWaiters.get(record.id);
			if (waiter) {
				this.rpcWaiters.delete(record.id);
				waiter.resolve(record);
			}
			return;
		}
		if (record.type !== "extension_ui_request" || typeof record.id !== "string") return;
		const method = record.method;
		if (typeof method === "string" && Object.hasOwn(DIALOG_METHODS, method)) {
			const timeout = typeof record.timeout === "number" && record.timeout > 0 ? record.timeout : undefined;
			this.dialogs.set(record.id, { id: record.id, seq, line, ...(timeout === undefined ? {} : { expiresAt: this.now() + timeout }) });
			return;
		}
		if (method === "setWidget" && record.widgetKey === DESKTOP_RPC_WIDGET && Array.isArray(record.widgetLines) && typeof record.widgetLines[0] === "string") {
			let answer: unknown;
			try {
				answer = JSON.parse(record.widgetLines[0]);
			} catch {
				return;
			}
			if (!answer || typeof answer !== "object") return;
			const a = answer as Record<string, unknown>;
			if (a.kind === "event") {
				this.observeDesktopEvent(a, seq, line);
				return;
			}
			if (a.kind !== "response" || typeof a.requestId !== "string") return;
			const waiter = this.desktopWaiters.get(a.requestId);
			if (waiter) {
				this.desktopWaiters.delete(a.requestId);
				waiter.resolve(a);
			}
		}
	}

	// --- host tools ---

	/**
	 * A `host_tool_call` is routed to the device that provides the tool: every
	 * subscriber sees the record (clients filter by `provider`), and when that
	 * device has no open stream the server answers for it at once with an error
	 * result the model can read, instead of letting the turn hang.
	 */
	private observeDesktopEvent(event: Record<string, unknown>, seq: number, line: string): void {
		const data = event.data;
		if (!data || typeof data !== "object" || !("callId" in data) || typeof data.callId !== "string") return;
		if (event.event === "host_tool_cancel") {
			this.hostCalls.delete(data.callId);
			return;
		}
		if (event.event !== "host_tool_call" || !("provider" in data) || typeof data.provider !== "string" || !("tool" in data) || typeof data.tool !== "string") return;
		const now = this.now();
		for (const [id, call] of this.hostCalls) if (now - call.at > this.limits.hostToolTrackMs) this.hostCalls.delete(id);
		const call: PendingHostCall = { callId: data.callId, provider: data.provider, tool: data.tool, seq, line, at: now };
		this.hostCalls.set(call.callId, call);
		if (!this.hasStream(call.provider)) this.failHostCall(call);
	}

	private hasStream(deviceId: string): boolean {
		for (const sub of this.subscribers) if (sub.deviceId === deviceId && !sub.sink.destroyed) return true;
		return false;
	}

	/** Answers the call on its device's behalf: the tool's device is not connected. */
	private failHostCall(call: PendingHostCall): void {
		if (this.hostCalls.get(call.callId) !== call) return;
		this.hostCalls.delete(call.callId);
		const label = this.deviceLabel(call.provider) ?? call.provider;
		const text = `${call.tool} runs in ${label}, which isn't connected right now.`;
		// A result the device sent meanwhile wins; the session answers this one `already_answered`.
		this.desktop("host_tool_result", { callId: call.callId, content: [{ type: "text", text }], isError: true }, this.limits.hostToolAnswerMs).catch(() => {});
	}

	/** After a device's last stream closed: its calls fail unless it reconnects within the grace period (at once when revoked). */
	private deviceLeft(deviceId: string, immediately = false): void {
		if (this.state !== "running" || this.hasStream(deviceId) || this.graceTimers.has(deviceId)) return;
		const owed = () => [...this.hostCalls.values()].filter((call) => call.provider === deviceId);
		if (owed().length === 0) return;
		if (immediately) {
			for (const call of owed()) this.failHostCall(call);
			return;
		}
		const timer = setTimeout(() => {
			this.graceTimers.delete(deviceId);
			if (this.hasStream(deviceId)) return;
			for (const call of owed()) this.failHostCall(call);
		}, this.limits.hostToolGraceMs);
		timer.unref?.();
		this.graceTimers.set(deviceId, timer);
	}

	/** The device that must answer `callId`, if the server saw that call and it is still open. */
	hostCallProvider(callId: string): string | undefined {
		return this.hostCalls.get(callId)?.provider;
	}

	/** A `host_tool_result` reached the session and settled (or could no longer settle) the call. */
	hostCallSettled(callId: string): void {
		this.hostCalls.delete(callId);
	}

	pendingHostCalls(): PendingHostCall[] {
		return [...this.hostCalls.values()];
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
			sub.sink.end(sseEvent("resync", { reason, seq: this.seq }));
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
		const hello = { session: this.id, state: this.state, seq: this.seq, oldest: this.ring.oldest ?? null };
		sink.write(`retry: 3000\n\n${sseEvent("hello", hello)}`);
		let replayedFrom = Number.POSITIVE_INFINITY;
		if (after !== undefined) {
			const replay = this.ring.since(after, this.seq);
			if ("snapshotRequired" in replay) {
				sink.write(sseEvent("snapshot-required", { after, oldest: replay.oldest, seq: this.seq }));
			} else {
				replayedFrom = after;
				for (const r of replay.records) sink.write(sseRecord(r.seq, r.line));
			}
		}
		for (const dialog of this.pendingDialogs()) {
			if (dialog.seq > replayedFrom) continue;
			sink.write(`event: dialog\ndata: ${dialog.line}\n\n`);
		}
		for (const call of this.hostCalls.values()) {
			if (call.provider !== deviceId || call.seq > replayedFrom) continue;
			sink.write(`event: host_tool_call\ndata: ${call.line}\n\n`);
		}
		if (this.state === "exited") {
			sink.end();
			return;
		}
		this.subscribers.add({ sink, deviceId });
		const grace = this.graceTimers.get(deviceId);
		if (grace !== undefined) {
			clearTimeout(grace);
			this.graceTimers.delete(deviceId);
		}
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
		if (this.state !== "running") throw new SessionError("session_exited", "The session has exited");
		const stdin = this.child.stdin!;
		if (!stdin.writable) throw new SessionError("session_exited", "The session's input is closed");
		if (stdin.writableLength > this.limits.stdinBufferBytes) throw new SessionError("session_busy", "The session is not reading its input; try again later");
		stdin.write(`${JSON.stringify(record)}\n`);
	}

	/**
	 * Sends one Pi RPC command under a server-assigned id (clients may share a
	 * session, so their own ids could collide) and waits for its response. The
	 * caller's `id` is put back on the response it gets.
	 */
	async rpc(command: Record<string, unknown>, timeoutMs: number): Promise<RpcOutcome> {
		this.nextRpc += 1;
		const id = `serve-rpc-${this.nextRpc}`;
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

	/** Forwards an `extension_ui_response`; only the first answer to a dialog reaches Pi. */
	answerDialog(answer: Record<string, unknown>): DialogAnswer {
		const id = answer.id;
		if (typeof id !== "string") return "unknown";
		this.pruneDialogs();
		if (!this.dialogs.has(id)) return this.answered.includes(id) ? "answered" : "unknown";
		this.write(answer);
		this.dialogs.delete(id);
		this.answered.push(id);
		if (this.answered.length > ANSWERED_MEMORY) this.answered.shift();
		this.emitServerRecord({ type: "serve_dialog_resolved", id });
		return "accepted";
	}

	/**
	 * One Desktop RPC request through `/gentle:desktop`, answered by the matching
	 * `gentle-desktop-rpc` widget. Returns the Desktop RPC response object, or
	 * undefined on timeout. A refused prompt is reported as its Pi response.
	 */
	async desktop(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<{ answer: Record<string, unknown> } | { prompt: Record<string, unknown> } | undefined> {
		this.nextDesktop += 1;
		const requestId = `serve-desktop-${this.nextDesktop}`;
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

	private pruneDialogs(): void {
		const now = this.now();
		for (const [id, dialog] of this.dialogs) if (dialog.expiresAt !== undefined && dialog.expiresAt <= now) this.dialogs.delete(id);
	}

	// --- lifecycle ---

	private onChildExit(code: number | null, signal: string | null, error?: string): void {
		this.state = "exited";
		this.exitCode = code;
		this.exitSignal = signal;
		this.exitedAt = this.now();
		this.dialogs.clear();
		this.hostCalls.clear();
		for (const timer of this.graceTimers.values()) clearTimeout(timer);
		this.graceTimers.clear();
		this.emitServerRecord({ type: "serve_session_exited", code, signal, ...(error ? { error: "spawn_failed" } : {}) });
		const gone = new SessionError("session_exited", "The session has exited");
		for (const waiters of [this.rpcWaiters, this.desktopWaiters]) {
			for (const waiter of waiters.values()) waiter.reject(gone);
			waiters.clear();
		}
		for (const sub of this.subscribers) sub.sink.end();
		this.subscribers.clear();
	}

	/** Orderly stop: close stdin and SIGTERM together (Pi treats them as one request), then SIGKILL. */
	async stop(): Promise<void> {
		if (this.state === "exited") return;
		this.child.stdin!.end();
		this.child.kill("SIGTERM");
		const timer = setTimeout(() => { if (this.state === "running") this.child.kill("SIGKILL"); }, this.limits.stopGraceMs);
		timer.unref?.();
		await this.exited;
		clearTimeout(timer);
	}

	whenExited(): Promise<void> {
		return this.exited;
	}
}
