import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
	ActiveSessionClientError,
	FrameDecoder,
	SessionPresenceError,
	TransportProtocolError,
	encodeAckFrame,
	encodeNotificationFrame,
	type AckFrame,
	type PresenceRecord,
	type ReceivedNotification,
	type SessionPresenceCandidate,
	type SentNotification,
	type NotificationFrame,
} from "./agents-session-transport.ts";

export const FIXED_WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const MAX_CONTROL_BYTES = 16_384;
// The native helper caps one raw pipe request at MaxPipeBytes = 65,536. Its event
// carries that request as canonical base64, so this private envelope is bounded by
// ceil(raw / 3) * 4 plus the largest fixed, ASCII-only control fields below.
const NATIVE_PIPE_MAX_BYTES = 65_536;
const MAX_PRIVATE_WIRE_BASE64_BYTES = Math.ceil(NATIVE_PIPE_MAX_BYTES / 3) * 4;
const MAX_PRIVATE_EVENT_FIXED_BYTES = Buffer.byteLength('{"event":"notification","connectionId":"","generation":2147483647,"wire":""}', "utf8") + 128;
const MAX_PRIVATE_EVENT_BYTES = MAX_PRIVATE_WIRE_BASE64_BYTES + MAX_PRIVATE_EVENT_FIXED_BYTES;
const MAX_PENDING = 8;
const MAX_PENDING_ACK = 8;
const RPC_DEADLINE_MS = 2_000;
const STARTUP_DEADLINE_MS = 30_000;
const CALLBACK_DEADLINE_MS = 2_000;
const SHUTDOWN_GRACE_MS = 500;
const PIPE = /^\\\\\.\\pipe\\gentle-pi-[A-Za-z0-9-]{1,96}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type HostState = Readonly<{ state: "partial" }> | Readonly<{ state: "initialized"; bootstrap: "complete" }> | Readonly<{ state: "initialized"; bootstrap: "complete"; entries: number }>;
type HostReply = Readonly<{ requestId: string; ok: boolean; result?: HostState | WindowsRecord | Readonly<{ records: readonly WindowsRecord[] }>; error?: "unavailable" | "unsafe" | "busy" | "not_found" | "invalid" }>;
type HostEvent = Readonly<{ event: "startup-marker"; marker: WindowsSessionStartupMarker }> | Readonly<{ event: "notification"; connectionId: string; generation: number; frame: NotificationFrame }> | Readonly<{ event: "listener-failed"; generation: number; error: "unavailable" }>;
type Pending = { kind: "rpc" | "ack"; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type WindowsHostFailureCallback = (generation: number) => void;
type SpawnedHost = ChildProcessWithoutNullStreams;
export type WindowsHostCallback = (notification: Readonly<{ connectionId: string; id: string; senderSessionId: string; recipientSessionId: string; message: string }>) => Promise<boolean>;
export type WindowsSessionTransportHostOptions = Readonly<{
	runtimeScript?: string;
	spawnProcess?: typeof spawn;
	callback?: WindowsHostCallback;
	rpcDeadlineMs?: number;
	startupDeadlineMs?: number;
}>;
export type WindowsSessionRegistryPhase = "start" | "initialize" | "cleanup";
export type WindowsSessionStartupMarker = "script-entered" | "native-ready";
export type WindowsSessionRegistryPhaseErrorCode = "spawn" | "stream" | "process" | "exit" | "write" | "deadline" | "protocol" | "start-reply" | "stopped" | "unwritable" | "unknown";
export type WindowsSessionRegistryPhaseError = Readonly<{ class: "timed-out" | "rejected" | "unknown"; code: WindowsSessionRegistryPhaseErrorCode }>;
/** Receives one fixed, synchronous result event for an operation on this registry's own host. */
export type WindowsSessionRegistryPhaseEvent = Readonly<{ phase: WindowsSessionRegistryPhase; status: "succeeded" | "failed"; error: WindowsSessionRegistryPhaseError | null; lastStartupMarker: WindowsSessionStartupMarker | null }>;
export type WindowsSessionRegistryPhaseObserver = (event: WindowsSessionRegistryPhaseEvent) => undefined;
export type WindowsSessionRegistryObservation = Readonly<{
	availability: "unavailable" | "observed";
	provenance: "unavailable" | "ambiguous" | "owned-instance";
	restoration: "not-required";
	startCalls: number | null;
	initializeCalls: number | null;
	cleanupCalls: number | null;
	firstFailurePhase: WindowsSessionRegistryPhase | null;
	firstFailureClass: WindowsSessionRegistryPhaseError["class"] | null;
	firstFailureCode: WindowsSessionRegistryPhaseError["code"] | null;
	lastStartupMarker: WindowsSessionStartupMarker | null;
}>;

/** Pure probe-side reducer for fixed events emitted by one registry's lexical owner. */
export class WindowsSessionRegistryPhaseSequence {
	private expected: WindowsSessionRegistryPhase | "complete" = "start";
	private invalid = false;
	private startStatus?: WindowsSessionRegistryPhaseEvent["status"];
	private initializeStatus?: WindowsSessionRegistryPhaseEvent["status"];
	private cleanupStatus?: WindowsSessionRegistryPhaseEvent["status"];
	private lastStartupMarker: WindowsSessionStartupMarker | null = null;
	private firstFailure?: Readonly<{ phase: WindowsSessionRegistryPhase; class: WindowsSessionRegistryPhaseError["class"]; code: WindowsSessionRegistryPhaseError["code"] }>;
	observe(event: unknown): undefined {
		if (this.invalid || !this.validEvent(event) || event.phase !== this.expected || !this.monotonicStartupMarker(event.lastStartupMarker)) { this.invalid = true; return undefined; }
		this.lastStartupMarker = event.lastStartupMarker;
		if (event.phase === "start") this.startStatus = event.status;
		else if (event.phase === "initialize") this.initializeStatus = event.status;
		else this.cleanupStatus = event.status;
		if (event.status === "failed" && this.firstFailure === undefined) this.firstFailure = Object.freeze({ phase: event.phase, class: event.error!.class, code: event.error!.code });
		if (event.phase === "start") this.expected = event.status === "succeeded" ? "initialize" : "cleanup";
		else if (event.phase === "initialize") this.expected = "cleanup";
		else this.expected = "complete";
		return undefined;
	}
	get operationSucceeded() { return this.startStatus === "succeeded" && this.initializeStatus === "succeeded"; }
	get terminalSequenceValid() { return !this.invalid && this.expected === "complete"; }
	get cleanupComplete() { return this.terminalSequenceValid && this.cleanupStatus === "succeeded"; }
	get admitsFullSuccess() { return this.operationSucceeded && this.cleanupComplete; }
	get startupSucceeded() { return !this.invalid && this.expected === "cleanup" && this.operationSucceeded; }
	snapshot(): WindowsSessionRegistryObservation {
		if (!this.terminalSequenceValid) return Object.freeze({ availability: "unavailable", provenance: this.invalid ? "ambiguous" : "unavailable", restoration: "not-required", startCalls: null, initializeCalls: null, cleanupCalls: null, firstFailurePhase: null, firstFailureClass: null, firstFailureCode: null, lastStartupMarker: null });
		return Object.freeze({ availability: "observed", provenance: "owned-instance", restoration: "not-required", startCalls: this.startStatus === undefined ? 0 : 1, initializeCalls: this.initializeStatus === undefined ? 0 : 1, cleanupCalls: this.cleanupStatus === undefined ? 0 : 1, firstFailurePhase: this.firstFailure?.phase ?? null, firstFailureClass: this.firstFailure?.class ?? null, firstFailureCode: this.firstFailure?.code ?? null, lastStartupMarker: this.lastStartupMarker });
	}
	private monotonicStartupMarker(marker: WindowsSessionStartupMarker | null) {
		const ordinal = marker === null ? 0 : marker === "script-entered" ? 1 : 2;
		const prior = this.lastStartupMarker === null ? 0 : this.lastStartupMarker === "script-entered" ? 1 : 2;
		return ordinal >= prior;
	}
	private validEvent(event: unknown): event is WindowsSessionRegistryPhaseEvent {
		if (!event || typeof event !== "object" || Array.isArray(event) || Object.getPrototypeOf(event) !== Object.prototype || Object.keys(event).length !== 4) return false;
		const value = event as Record<string, unknown>;
		if (!(["start", "initialize", "cleanup"] as const).includes(value.phase as WindowsSessionRegistryPhase) || !(["succeeded", "failed"] as const).includes(value.status as WindowsSessionRegistryPhaseEvent["status"]) || (value.lastStartupMarker !== null && value.lastStartupMarker !== "script-entered" && value.lastStartupMarker !== "native-ready")) return false;
		if (value.status === "succeeded") return value.error === null;
		if (!value.error || typeof value.error !== "object" || Array.isArray(value.error) || Object.getPrototypeOf(value.error) !== Object.prototype || Object.keys(value.error).length !== 2) return false;
		const error = value.error as Record<string, unknown>;
		return (["timed-out", "rejected", "unknown"] as const).includes(error.class as WindowsSessionRegistryPhaseError["class"]) && (["spawn", "stream", "process", "exit", "write", "deadline", "protocol", "start-reply", "stopped", "unwritable", "unknown"] as const).includes(error.code as WindowsSessionRegistryPhaseErrorCode) && ((error.class === "timed-out") === (error.code === "deadline"));
	}
}

const defaultRuntimeScript = fileURLToPath(new URL("../runtime/windows-session-transport.ps1", import.meta.url));
const safeError = (message: string) => new Error(message);
// Diagnostics are source-defined and remain private to the phase observer: no native
// error object, message, property, or stderr is copied into the event.
const transportFailureCodes = new WeakMap<Error, WindowsSessionRegistryPhaseErrorCode>();
const transportError = (message: string, code: WindowsSessionRegistryPhaseErrorCode) => {
	const error = safeError(message);
	transportFailureCodes.set(error, code);
	return error;
};
// This sink intentionally captures no host state. It prevents a late stream error from
// becoming unhandled after bounded cleanup times out but before the child confirms close.
const lateChildErrorSink = () => {};
type DetachedChildCleanup = Readonly<{ closed: () => boolean; install: () => void; close: () => void }>;
/**
 * This state is handed to the child only after host cleanup times out. Its callbacks
 * retain the child streams and their own exact callback references, never the host.
 */
const createDetachedChildCleanup = (child: SpawnedHost): DetachedChildCleanup => {
	let closed = false;
	const removeGuards = () => {
		child.removeListener("error", lateChildErrorSink);
		child.stdin.removeListener("error", lateChildErrorSink);
		child.stdout.removeListener("error", lateChildErrorSink);
		child.stderr.removeListener("error", lateChildErrorSink);
	};
	const close = () => {
		if (closed) return;
		closed = true;
		child.removeListener("close", close);
		removeGuards();
	};
	const addGuard = (emitter: NodeJS.EventEmitter) => {
		if (closed) return;
		emitter.on("error", lateChildErrorSink);
		// An external newListener hook can synchronously close the child before on()
		// returns; remove this just-added guard rather than leaving it after close.
		if (closed) emitter.removeListener("error", lateChildErrorSink);
	};
	const install = () => {
		if (closed) return;
		child.once("close", close);
		if (closed) { child.removeListener("close", close); return; }
		addGuard(child); addGuard(child.stdin); addGuard(child.stdout); addGuard(child.stderr);
	};
	return Object.freeze({ closed: () => closed, install, close });
};
/** A syntactically valid private envelope can contain one untrusted pipe frame. */
class InvalidClientWireError extends Error {}
function controlId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value); }
function plainRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
const hostErrors = (value: unknown): value is HostReply["error"] => typeof value === "string" && ["unavailable", "unsafe", "busy", "not_found", "invalid"].includes(value);
const hasPrivateData = (value: unknown): boolean => {
	if (!value || typeof value !== "object") return false;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (/(path|sid|exception|stack|detail)/i.test(key) || hasPrivateData(child)) return true;
	}
	return false;
};
const validNotification = (value: unknown): value is NotificationFrame => {
	try { encodeNotificationFrame(value as NotificationFrame); return true; } catch { return false; }
};

/** Parse one public JSONL frame. The helper never exposes a host path, SID, or exception. */
export function parseWindowsHostFrame(line: string): HostReply {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_CONTROL_BYTES) throw safeError("invalid Windows transport frame");
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw safeError("invalid Windows transport frame"); }
	if (!value || typeof value !== "object" || Array.isArray(value) || hasPrivateData(value)) throw safeError("invalid Windows transport frame");
	const frame = value as Record<string, unknown>;
	if (!controlId(frame.requestId) || typeof frame.ok !== "boolean") throw safeError("invalid Windows transport frame");
	const keys = Object.keys(frame);
	if (frame.ok) {
		if (keys.length !== 3 || !keys.includes("result") || !frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) throw safeError("invalid Windows transport frame");
		const result = frame.result as Record<string, unknown>;
		const partial = Object.keys(result).length === 1 && result.state === "partial";
		const initialized = Object.keys(result).length === 2 && result.state === "initialized" && result.bootstrap === "complete";
		const enumerated = Object.keys(result).length === 3 && result.state === "initialized" && result.bootstrap === "complete" && typeof result.entries === "number" && Number.isSafeInteger(result.entries) && result.entries >= 0 && result.entries <= 64;
		let publicResult: HostReply["result"];
		if (partial || initialized || enumerated) publicResult = Object.freeze({ ...result }) as HostState;
		else {
			try {
				if (Object.keys(result).length === 4) publicResult = validRecord(result);
				else if (Object.keys(result).length === 1 && Array.isArray(result.records) && result.records.length <= 64) publicResult = Object.freeze({ records: Object.freeze(result.records.map((record) => validRecord(record))) });
				else throw new Error();
			} catch { throw safeError("invalid Windows transport frame"); }
		}
		return Object.freeze({ requestId: frame.requestId, ok: true, result: publicResult! });
	}
	if (keys.length !== 3 || !hostErrors(frame.error)) throw safeError("invalid Windows transport frame");
	return Object.freeze({ requestId: frame.requestId, ok: false, error: frame.error });
}

/** Decode the helper's bounded private events before allowing application acknowledgement. */
function parseWindowsHostEvent(line: string): HostEvent | undefined {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_PRIVATE_EVENT_BYTES) throw safeError("invalid Windows transport frame");
	let value: unknown;
	try { value = JSON.parse(line); } catch { throw safeError("invalid Windows transport frame"); }
	if (!value || typeof value !== "object" || Array.isArray(value) || hasPrivateData(value)) throw safeError("invalid Windows transport frame");
	const event = value as Record<string, unknown>;
	if (event.event === "startup-marker") {
		if (Object.keys(event).length !== 2 || (event.marker !== "script-entered" && event.marker !== "native-ready")) throw safeError("invalid Windows transport frame");
		return Object.freeze({ event: "startup-marker", marker: event.marker as WindowsSessionStartupMarker });
	}
	if (event.event === "listener-failed") {
		if (Object.keys(event).length !== 3 || !Number.isSafeInteger(event.generation) || (event.generation as number) < 1 || (event.generation as number) > 0x7fffffff || event.error !== "unavailable") throw safeError("invalid Windows transport frame");
		return Object.freeze({ event: "listener-failed", generation: event.generation as number, error: "unavailable" });
	}
	if (event.event !== "notification") return undefined;
	if (Object.keys(event).length !== 4 || !controlId(event.connectionId) || !Number.isSafeInteger(event.generation) || (event.generation as number) < 1 || (event.generation as number) > 0x7fffffff || typeof event.wire !== "string" || event.wire.length > MAX_PRIVATE_WIRE_BASE64_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.wire)) throw safeError("invalid Windows transport frame");
	let bytes: Buffer;
	try {
		bytes = Buffer.from(event.wire, "base64");
		if (bytes.length > NATIVE_PIPE_MAX_BYTES || bytes.toString("base64") !== event.wire) throw new Error();
	} catch { throw safeError("invalid Windows transport frame"); }
	try {
		const decoder = new FrameDecoder(); decoder.push(bytes);
		const frame = decoder.finish();
		if (frame.kind !== "notification") throw new Error();
		return Object.freeze({ event: "notification", connectionId: event.connectionId as string, generation: event.generation as number, frame });
	} catch { throw new InvalidClientWireError("invalid client wire frame"); }
}

/** Decode a notification event while preserving the existing public notification parser. */
export function parseWindowsHostNotification(line: string): Extract<HostEvent, { event: "notification" }> | undefined {
	const event = parseWindowsHostEvent(line);
	return event?.event === "notification" ? event : undefined;
}

export class WindowsSessionTransportHost {
	private readonly runtimeScript: string;
	private readonly spawnProcess: typeof spawn;
	private readonly callback?: WindowsHostCallback;
	private readonly deadline: number;
	private readonly startupDeadline: number;
	private child?: SpawnedHost;
	private started?: Promise<void>;
	private startupMarker: WindowsSessionStartupMarker | null = null;
	private startupReplyObserved = false;
	private sequence = 0;
	private output = Buffer.alloc(0);
	private readonly pending = new Map<string, Pending>();
	private pendingRpcs = 0;
	private pendingAcks = 0;
	// Every submitted Node listen reserves a strictly increasing epoch. The helper
	// accepts a newer epoch, rather than requiring contiguity, so a locally rejected
	// request or a reply/failure reordering cannot reuse an allocated epoch.
	private nextListenerGeneration = 0;
	private listenerActiveGeneration?: number;
	private listenerPendingGeneration?: number;
	private listenerActiveIdentity?: WindowsRecord;
	private listenerPendingIdentity?: Readonly<{ sessionId: string; createdAt: number }>;
	private listenerFailure?: WindowsHostFailureCallback;
	private stopped = false;
	private childClosed = false;
	private inputClosed = false;
	private childKillRequested = false;
	private cleanup?: Promise<void>;
	private resolveCleanup?: () => void;
	private rejectCleanup?: (error: Error) => void;
	private cleanupTimer?: ReturnType<typeof setTimeout>;
	private readonly onStdoutData = (chunk: Buffer) => this.onOutput(chunk);
	private readonly onStdoutError = () => this.abort("Windows transport host unavailable", true, "stream");
	private readonly onStdinError = () => this.abort("Windows transport host unavailable", true, "stream");
	private readonly onStderrError = () => this.abort("Windows transport host unavailable", true, "stream");
	private readonly onChildError = () => this.abort("Windows transport host unavailable", true, "process");
	private readonly onChildExit = () => this.abort("Windows transport host exited", false, "exit");
	private readonly onChildClose = () => this.handleChildClose();
	// Set only while handing close ownership from the host observer to detached state.
	private handoffCloseState?: DetachedChildCleanup;

	constructor(options: WindowsSessionTransportHostOptions = {}) {
		this.runtimeScript = options.runtimeScript ?? defaultRuntimeScript;
		this.spawnProcess = options.spawnProcess ?? spawn;
		this.callback = options.callback;
		this.deadline = options.rpcDeadlineMs ?? RPC_DEADLINE_MS;
		this.startupDeadline = options.startupDeadlineMs ?? STARTUP_DEADLINE_MS;
		if (!Number.isInteger(this.deadline) || this.deadline < 1 || this.deadline > RPC_DEADLINE_MS) throw new RangeError("invalid Windows transport deadline");
		if (!Number.isInteger(this.startupDeadline) || this.startupDeadline < 1 || this.startupDeadline > STARTUP_DEADLINE_MS) throw new RangeError("invalid Windows transport startup deadline");
	}

	get lastStartupMarker() { return this.startupMarker; }

	start(): Promise<void> {
		if (this.started) return this.started;
		if (this.stopped) return Promise.reject(transportError("Windows transport host exited", "stopped"));
		try {
			this.child = this.spawnProcess(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", this.runtimeScript], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as SpawnedHost;
		} catch { return Promise.reject(transportError("Windows transport host unavailable", "spawn")); }
		this.child.stdout.on("data", this.onStdoutData);
		this.child.stdout.on("error", this.onStdoutError);
		this.child.stdin.on("error", this.onStdinError);
		this.child.stderr.on("error", this.onStderrError);
		this.child.stderr.resume?.();
		this.child.once("error", this.onChildError);
		this.child.once("exit", this.onChildExit);
		this.child.once("close", this.onChildClose);
		this.started = this.requestWithDeadline("start", {}, this.startupDeadline).then((result) => {
			if (result.state !== "partial") throw transportError("Windows transport host unavailable", "start-reply");
		});
		return this.started;
	}

	request(operation: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.requestWithDeadline(operation, values, operation === "ack" ? CALLBACK_DEADLINE_MS : this.deadline);
	}

	private requestWithDeadline(operation: string, values: Record<string, unknown>, deadline: number): Promise<Record<string, unknown>> {
		const kind = operation === "ack" ? "ack" : "rpc";
		if (!/^[a-z-]{1,32}$/.test(operation) || hasPrivateData(values) || (kind === "rpc" ? this.pendingRpcs >= MAX_PENDING : this.pendingAcks >= MAX_PENDING_ACK)) return Promise.reject(safeError("Windows transport request unavailable"));
		const child = this.child;
		if (!child || this.stopped) return Promise.reject(transportError("Windows transport host exited", "stopped"));
		if (!child.stdin.writable) return Promise.reject(transportError("Windows transport host exited", "unwritable"));
		const requestId = `${operation}-${++this.sequence}`;
		const line = JSON.stringify({ requestId, operation, ...values });
		if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_BYTES) return Promise.reject(safeError("Windows transport request unavailable"));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.settle(requestId, transportError("Windows transport request timed out", "deadline")), deadline);
			this.pending.set(requestId, { kind, resolve, reject, timer });
			if (kind === "ack") this.pendingAcks++; else this.pendingRpcs++;
			try { child.stdin.write(`${line}\n`, (error) => { if (error) this.settle(requestId, transportError("Windows transport host exited", "write")); }); }
			catch { this.settle(requestId, transportError("Windows transport host exited", "write")); }
		});
	}

	setListenerFailure(callback?: WindowsHostFailureCallback) { this.listenerFailure = callback; }

	async listen(sessionId: string, createdAt = Date.now()): Promise<WindowsRecord> {
		if (this.listenerActiveGeneration !== undefined || this.listenerPendingGeneration !== undefined || this.nextListenerGeneration >= 0x7fffffff) throw safeError("Windows transport listener failed");
		const generation = ++this.nextListenerGeneration;
		this.listenerPendingGeneration = generation;
		this.listenerPendingIdentity = Object.freeze({ sessionId, createdAt });
		try {
			const result = validRecord(await this.request("listen", { sessionId, createdAt, generation }));
			if (this.listenerPendingGeneration !== generation) throw safeError("Windows transport listener failed");
			this.listenerPendingGeneration = undefined;
			this.listenerPendingIdentity = undefined;
			this.listenerActiveGeneration = generation;
			this.listenerActiveIdentity = result;
			return result;
		} catch (error) {
			if (this.listenerPendingGeneration === generation) {
				this.listenerPendingGeneration = undefined;
				this.listenerPendingIdentity = undefined;
			}
			throw error;
		}
	}

	async stopListener(record: PresenceRecord) {
		const valid = validRecord(record as unknown as Record<string, unknown>);
		const matchesPending = this.listenerPendingIdentity?.sessionId === valid.sessionId && this.listenerPendingIdentity.createdAt === valid.createdAt;
		const matchesActive = this.listenerActiveIdentity?.sessionId === valid.sessionId && this.listenerActiveIdentity.endpoint === valid.endpoint && this.listenerActiveIdentity.createdAt === valid.createdAt;
		// Revoke a matching pending epoch before awaiting the stop RPC. Its delayed
		// listen reply, notification, or failure can no longer make it active.
		if (matchesPending) {
			this.listenerPendingGeneration = undefined;
			this.listenerPendingIdentity = undefined;
		}
		if (matchesActive) {
			this.listenerActiveGeneration = undefined;
			this.listenerActiveIdentity = undefined;
		}
		await this.request("stop-listener", { record: valid });
	}

	async close() {
		this.listenerActiveGeneration = undefined;
		this.listenerPendingGeneration = undefined;
		this.listenerActiveIdentity = undefined;
		this.listenerPendingIdentity = undefined;
		if (this.cleanup) return this.cleanup;
		const child = this.child;
		if (!child) { this.stopped = true; return; }
		if (!this.stopped) {
			await this.request("shutdown", {}).catch(() => {});
			this.stopped = true;
		}
		await this.releaseOwnedChild(false);
	}

	private observeStartupMarker(marker: WindowsSessionStartupMarker) {
		const expected = this.startupMarker === null ? "script-entered" : this.startupMarker === "script-entered" ? "native-ready" : undefined;
		if (this.startupReplyObserved || marker !== expected) return false;
		this.startupMarker = marker;
		return true;
	}
	private onOutput(chunk: Buffer) {
		if (!Buffer.isBuffer(chunk)) { this.abort("Windows transport host unavailable", true, "protocol"); return; }
		const output = this.output.length === 0 ? chunk : Buffer.concat([this.output, chunk]);
		let offset = 0;
		for (;;) {
			const newline = output.indexOf(10, offset);
			if (newline < 0) {
				const partial = output.subarray(offset);
				if (partial.length > MAX_PRIVATE_EVENT_BYTES) this.abort("Windows transport host unavailable", true, "protocol");
				else this.output = Buffer.from(partial);
				return;
			}
			const bytes = output.subarray(offset, newline);
			offset = newline + 1;
			if (bytes.length > MAX_PRIVATE_EVENT_BYTES) { this.abort("Windows transport host unavailable", true, "protocol"); return; }
			let line: string;
			try {
				// Newlines are single UTF-8 bytes, so retaining only an unterminated byte
				// suffix preserves split code points without decoding partial chunks.
				line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch { this.abort("Windows transport host unavailable", true, "protocol"); return; }
			try {
				const event = parseWindowsHostEvent(line);
				if (event) {
					if (event.event === "startup-marker") {
						if (!this.observeStartupMarker(event.marker)) { this.abort("Windows transport host unavailable", true, "protocol"); return; }
					} else if (event.event === "notification") void this.acknowledge(event);
					else this.failListener(event.generation);
					continue;
				}
				const reply = parseWindowsHostFrame(line);
				if (reply.requestId === "start-1") this.startupReplyObserved = true;
				this.settle(reply.requestId, reply.ok ? undefined : transportError("Windows transport request unavailable", "protocol"), reply.result);
			} catch (error) {
				// Only a schema-validated private event can isolate its embedded client wire.
				if (error instanceof InvalidClientWireError) continue;
				this.abort("Windows transport host unavailable", true, "protocol");
				return;
			}
		}
	}

	private isCurrentListenerGeneration(generation: number) {
		// Pending replacement ownership is exclusive: old active events are stale.
		return generation === (this.listenerPendingGeneration ?? this.listenerActiveGeneration);
	}
	private async acknowledge(event: Extract<HostEvent, { event: "notification" }>) {
		if (this.stopped || !this.isCurrentListenerGeneration(event.generation)) return;
		const callback = this.callback;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), CALLBACK_DEADLINE_MS); });
		const accepted = await Promise.race([
			Promise.resolve(callback?.(Object.freeze({ connectionId: event.connectionId, id: event.frame.id, senderSessionId: event.frame.senderSessionId, recipientSessionId: event.frame.recipientSessionId, message: event.frame.message }))).then((value) => value === true, () => false),
			deadline,
		]);
		if (timer) clearTimeout(timer);
		if (this.stopped || !this.isCurrentListenerGeneration(event.generation)) return;
		// This is the sole path that lets PowerShell reply on its retained server handle.
		void this.request("ack", { connectionId: event.connectionId, generation: event.generation, id: event.frame.id, accepted }).catch(() => {});
	}
	private settle(requestId: string, error?: Error, result?: Record<string, unknown>) {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId); clearTimeout(pending.timer);
		if (pending.kind === "ack") this.pendingAcks--; else this.pendingRpcs--;
		if (error) pending.reject(error); else pending.resolve(result ?? {});
	}
	private failListener(generation: number) {
		if (this.stopped || !this.isCurrentListenerGeneration(generation)) return;
		if (this.listenerPendingGeneration === generation) {
			this.listenerPendingGeneration = undefined;
			this.listenerPendingIdentity = undefined;
		} else {
			this.listenerActiveGeneration = undefined;
			this.listenerActiveIdentity = undefined;
		}
		for (const [id, pending] of [...this.pending]) if (pending.kind === "ack") this.settle(id, safeError("Windows transport listener failed"));
		try { this.listenerFailure?.(generation); } catch {}
	}
	private detachOwnedListeners(keepClose: boolean) {
		const child = this.child;
		if (!child) return;
		child.stdout.removeListener("data", this.onStdoutData);
		child.stdout.removeListener("error", this.onStdoutError);
		child.stdin.removeListener("error", this.onStdinError);
		child.stderr.removeListener("error", this.onStderrError);
		child.removeListener("error", this.onChildError);
		child.removeListener("exit", this.onChildExit);
		if (!keepClose) child.removeListener("close", this.onChildClose);
	}
	private handOffTimedOutClose(child: SpawnedHost) {
		const detached = createDetachedChildCleanup(child);
		this.handoffCloseState = detached;
		detached.install();
		if (!detached.closed()) child.removeListener("close", this.onChildClose);
		this.handoffCloseState = undefined;
		return detached.closed();
	}
	private handleChildClose() {
		this.childClosed = true;
		if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
		this.cleanupTimer = undefined;
		this.handoffCloseState?.close();
		if (!this.stopped) this.abort("Windows transport host exited", false, "exit");
		this.detachOwnedListeners(false);
		const resolve = this.resolveCleanup;
		this.resolveCleanup = undefined;
		this.rejectCleanup = undefined;
		this.cleanup = undefined;
		this.output = Buffer.alloc(0);
		this.child = undefined;
		resolve?.();
	}
	private closeInput() {
		if (this.inputClosed) return;
		this.inputClosed = true;
		try { this.child?.stdin.end(); } catch {}
	}
	private failCleanup() {
		if (this.childClosed) return;
		this.cleanupTimer = undefined;
		const child = this.child;
		if (!child) return;
		// Timeout is not physical closure. Hand close/error safety to callbacks that
		// capture only this child and its streams, then release host protocol state.
		this.detachOwnedListeners(true);
		const closedDuringHandoff = this.handOffTimedOutClose(child);
		this.output = Buffer.alloc(0);
		this.child = undefined;
		if (closedDuringHandoff) return;
		const reject = this.rejectCleanup;
		this.resolveCleanup = undefined;
		this.rejectCleanup = undefined;
		reject?.(safeError("Windows transport host did not close"));
	}
	private requestChildKill() {
		if (this.childClosed || this.childKillRequested) return;
		this.childKillRequested = true;
		try { this.child?.kill(); } catch {}
	}
	private scheduleCleanupKill() {
		if (this.childClosed || this.childKillRequested) return;
		if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
		this.cleanupTimer = setTimeout(() => {
			this.cleanupTimer = undefined;
			this.requestChildKill();
			if (!this.childClosed) this.cleanupTimer = setTimeout(() => this.failCleanup(), SHUTDOWN_GRACE_MS);
		}, SHUTDOWN_GRACE_MS);
	}
	private releaseOwnedChild(killNow: boolean): Promise<void> {
		if (this.cleanup) return this.cleanup;
		const child = this.child;
		if (!child) return Promise.resolve();
		if (!this.cleanup) {
			if (this.childClosed) return Promise.resolve();
			this.cleanup = new Promise<void>((resolve, reject) => { this.resolveCleanup = resolve; this.rejectCleanup = reject; });
		}
		const cleanup = this.cleanup;
		this.closeInput();
		if (killNow) {
			if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
			this.cleanupTimer = undefined;
			this.requestChildKill();
			if (!this.childClosed) this.cleanupTimer = setTimeout(() => this.failCleanup(), SHUTDOWN_GRACE_MS);
		} else this.scheduleCleanupKill();
		return cleanup;
	}
	private abort(message: string, closeChild = false, code: WindowsSessionRegistryPhaseErrorCode = "unknown") {
		if (this.stopped) return;
		// Snapshot, then revoke, before either request settlement or application code.
		// This prevents a synchronous callback from observing an owned stale epoch.
		const generation = this.listenerPendingGeneration ?? this.listenerActiveGeneration;
		this.listenerPendingGeneration = undefined;
		this.listenerActiveGeneration = undefined;
		this.listenerPendingIdentity = undefined;
		this.listenerActiveIdentity = undefined;
		this.stopped = true;
		for (const id of [...this.pending.keys()]) this.settle(id, transportError(message, code));
		if (generation !== undefined) { try { this.listenerFailure?.(generation); } catch {} }
		void this.releaseOwnedChild(closeChild).catch(() => {});
	}
}

type WindowsRecord = PresenceRecord;
const validRecord = (value: unknown): WindowsRecord => {
	if (!plainRecord(value)) throw new SessionPresenceError("invalid_presence", "invalid presence record");
	const record = value;
	const keys = Object.keys(record);
	if (keys.length !== 4 || !["version", "sessionId", "endpoint", "createdAt"].every((key) => keys.includes(key)) || record.version !== 1 || typeof record.sessionId !== "string" || !SESSION.test(record.sessionId) || typeof record.endpoint !== "string" || !PIPE.test(record.endpoint) || typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) throw new SessionPresenceError("invalid_presence", "invalid presence record");
	return Object.freeze({ version: 1, sessionId: record.sessionId, endpoint: record.endpoint, createdAt: record.createdAt });
};
const registryError = (error: unknown): never => {
	if (error instanceof SessionPresenceError) throw error;
	throw new SessionPresenceError("io_error", "transport I/O failed");
};

const phaseError = (error: unknown): WindowsSessionRegistryPhaseError => {
	const code = error instanceof Error ? transportFailureCodes.get(error) ?? "unknown" : "unknown";
	return Object.freeze({ class: code === "deadline" ? "timed-out" : error instanceof Error ? "rejected" : "unknown", code });
};
class WindowsSessionRegistryObserver {
	private active = true;
	private readonly callback: WindowsSessionRegistryPhaseObserver;
	private readonly readLastStartupMarker: () => WindowsSessionStartupMarker | null;
	constructor(callback: WindowsSessionRegistryPhaseObserver, readLastStartupMarker: () => WindowsSessionStartupMarker | null) {
		this.callback = callback;
		this.readLastStartupMarker = readLastStartupMarker;
	}
	async run<T>(phase: WindowsSessionRegistryPhase, operation: () => Promise<T>): Promise<T> {
		try {
			const value = await operation();
			this.observe(Object.freeze({ phase, status: "succeeded", error: null, lastStartupMarker: this.readLastStartupMarker() }));
			return value;
		} catch (error) {
			try { this.observe(Object.freeze({ phase, status: "failed", error: phaseError(error), lastStartupMarker: this.readLastStartupMarker() })); } catch { /* the operation rejection remains primary */ }
			throw error;
		}
	}
	private observe(event: WindowsSessionRegistryPhaseEvent) {
		if (!this.active) return;
		let result: unknown;
		try { result = this.callback(event); }
		catch { this.active = false; throw safeError("Windows registry observation failed"); }
		if (result === undefined) return;
		this.active = false;
		try { Promise.resolve(result).catch(() => {}); } catch { /* invalid thenables remain observer failures */ }
		throw safeError("Windows registry observation failed");
	}
}

/** Windows metadata stays in the PowerShell owner process; Node sees only public activation records. */
export class WindowsSessionPresenceRegistry {
	readonly paths = Object.freeze({ root: "", presence: "", sockets: "" });
	private readonly host: WindowsSessionTransportHost;
	private readonly observer?: WindowsSessionRegistryObserver;
	private notification?: WindowsHostCallback;
	private listenerFailure?: WindowsHostFailureCallback;
	private constructor(host: WindowsSessionTransportHost, observer?: WindowsSessionRegistryObserver) {
		this.host = host;
		this.observer = observer;
		this.host.setListenerFailure((generation) => this.listenerFailure?.(generation));
	}
	static async create(agentHome: string, observePhase?: WindowsSessionRegistryPhaseObserver) {
		if (process.platform !== "win32") throw new SessionPresenceError("io_error", "transport I/O failed");
		if (typeof agentHome !== "string" || !/^[A-Za-z]:\\/.test(agentHome)) throw new SessionPresenceError("unsafe_path", "unsafe transport path");
		let registry: WindowsSessionPresenceRegistry | undefined;
		const host = new WindowsSessionTransportHost({ callback: async (notification) => registry?.notification?.(notification) ?? false });
		const observer = observePhase === undefined ? undefined : new WindowsSessionRegistryObserver(observePhase, () => host.lastStartupMarker);
		const run = <T>(phase: WindowsSessionRegistryPhase, operation: () => Promise<T>) => observer ? observer.run(phase, operation) : operation();
		try {
			await run("start", () => host.start());
			await run("initialize", async () => {
				const initialized = await host.request("initialize", { agentHome });
				if (initialized.state !== "initialized" || initialized.bootstrap !== "complete") throw safeError("Windows transport host unavailable");
			});
			registry = new WindowsSessionPresenceRegistry(host, observer);
			return registry;
		} catch (error) {
			try { await run("cleanup", () => host.close()); } catch { /* registry creation preserves its primary rejection */ }
			registryError(error);
		}
	}
	setNotification(callback?: WindowsHostCallback) { this.notification = callback; }
	clearNotification(callback: WindowsHostCallback) { if (this.notification === callback) this.notification = undefined; }
	setListenerFailure(callback?: WindowsHostFailureCallback) { this.listenerFailure = callback; }
	clearListenerFailure(callback: WindowsHostFailureCallback) { if (this.listenerFailure === callback) this.listenerFailure = undefined; }
	async record(sessionId: string, createdAt = Date.now()) { try { return validRecord(await this.host.request("record", { sessionId, createdAt })); } catch { registryError(undefined); } }
	presencePath(_record: PresenceRecord) { throw new SessionPresenceError("unsafe_path", "unsafe transport path"); }
	async publish(record: PresenceRecord) { try { await this.host.request("publish", { record: validRecord(record as unknown as Record<string, unknown>) }); } catch { registryError(undefined); } }
	async list(excludeSessionId?: string): Promise<readonly SessionPresenceCandidate[]> { return (await this.listActivations(excludeSessionId)).map((record) => Object.freeze({ sessionId: record.sessionId, reachability: "unknown" as const })); }
	async listActivations(excludeSessionId?: string): Promise<readonly WindowsRecord[]> { try { const value = await this.host.request("list", { ...(excludeSessionId === undefined ? {} : { excludeSessionId }) }); if (!Array.isArray(value.records) || value.records.length > 64) throw new Error(); return Object.freeze(value.records.map((record) => validRecord(record))); } catch { registryError(undefined); } }
	async resolve(sessionId: string): Promise<WindowsRecord> { try { return validRecord(await this.host.request("resolve", { sessionId })); } catch { registryError(undefined); } }
	async removeOwn(record: PresenceRecord) { try { await this.host.request("remove", { record: validRecord(record as unknown as Record<string, unknown>) }); } catch { /* identity-bound owned cleanup is intentionally best effort */ } }
	async startListener(sessionId: string): Promise<WindowsRecord> {
		// listen resolves only after the helper has atomically armed and published it.
		try { return await this.host.listen(sessionId); } catch (error) { registryError(error); }
	}
	async stopListener(record: PresenceRecord) { try { await this.host.stopListener(record); } catch { await this.removeOwn(record); } }
	async close() { await (this.observer ? this.observer.run("cleanup", () => this.host.close()) : this.host.close()); }
}

export class WindowsActiveSessionListener {
	readonly registry: WindowsSessionPresenceRegistry;
	readonly sessionID: string;
	record?: PresenceRecord;
	readonly closed: Promise<void>;
	failure?: Readonly<{ code: "io_error"; message: "listener failed" }>;
	private readonly onNotification: (notification: ReceivedNotification) => Promise<void>;
	private state: "idle" | "starting" | "active" | "closed" = "idle";
	private generation = 0;
	private resolveClosed!: () => void;
	private readonly notification = (notification: Readonly<{ connectionId: string; id: string; senderSessionId: string; recipientSessionId: string; message: string }>) => this.receive(notification);
	private listenerFailure?: WindowsHostFailureCallback;
	constructor(registry: WindowsSessionPresenceRegistry, sessionID: string, onNotification: (notification: ReceivedNotification) => Promise<void>) { this.registry = registry; this.sessionID = sessionID; this.onNotification = onNotification; this.closed = new Promise((resolve) => { this.resolveClosed = resolve; }); }
	get status() { return this.state; }
	get activeConnections() { return 0; }
	async start() {
		if (this.state !== "idle") return;
		const generation = ++this.generation;
		this.state = "starting";
		this.registry.setNotification(this.notification);
		// Host generations are shared by the helper. This closure binds its validated
		// current host generation to this object's independent local start token.
		const listenerFailure: WindowsHostFailureCallback = () => this.fail(generation);
		this.listenerFailure = listenerFailure;
		this.registry.setListenerFailure(listenerFailure);
		try {
			const record = await this.registry.startListener(this.sessionID);
			if (this.status !== "starting" || this.generation !== generation) {
				await this.registry.stopListener(record);
				const state = this.status;
				throw new SessionPresenceError("io_error", state === "closed" ? "listener is closed" : "listener failed");
			}
			this.record = record;
			this.state = "active";
		} catch (error) {
			const state = this.status;
			const failed = state === "idle" && this.generation === generation && this.failure !== undefined;
			if (state !== "closed" && this.generation === generation) this.state = "idle";
			if (failed) throw new SessionPresenceError("io_error", "listener failed");
			throw error;
		}
	}
	async receive(notification: Readonly<{ id: string; senderSessionId: string; recipientSessionId: string; message: string }>) { if ((this.state !== "starting" && this.state !== "active") || notification.recipientSessionId !== this.sessionID) return false; try { await this.onNotification(Object.freeze({ id: notification.id, senderSessionId: notification.senderSessionId, message: notification.message })); return true; } catch { return false; } }
	private fail(generation: number) {
		if ((this.state !== "starting" && this.state !== "active") || this.generation !== generation) return;
		const listenerFailure = this.listenerFailure;
		this.record = undefined;
		this.failure = Object.freeze({ code: "io_error", message: "listener failed" });
		this.state = "idle";
		this.registry.clearNotification(this.notification);
		if (listenerFailure) this.registry.clearListenerFailure(listenerFailure);
		if (this.listenerFailure === listenerFailure) this.listenerFailure = undefined;
	}
	async close() {
		if (this.state === "closed") return;
		this.generation++;
		this.state = "closed";
		const record = this.record;
		const listenerFailure = this.listenerFailure;
		this.record = undefined;
		this.listenerFailure = undefined;
		this.registry.clearNotification(this.notification);
		if (listenerFailure) this.registry.clearListenerFailure(listenerFailure);
		try { if (record) await this.registry.stopListener(record); }
		finally { try { await this.registry.close(); } finally { this.resolveClosed(); } }
	}
}

type WindowsClientScheduler = Readonly<{ setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (handle: unknown) => void }>;
export type WindowsActiveSessionClientConfig = Readonly<{ connect?: (endpoint: string) => Socket; scheduler?: WindowsClientScheduler; connectDeadlineMs?: number; ackDeadlineMs?: number }>;
type WindowsPendingOutbound = { settled: boolean; socket?: Socket; connectTimer?: unknown; ackTimer?: unknown; abort?: () => void; cleanup?: () => void; settle: (error?: ActiveSessionClientError, result?: SentNotification) => void };

export class WindowsActiveSessionClient {
	readonly registry: WindowsSessionPresenceRegistry;
	readonly senderSessionId: string;
	private readonly connect: (endpoint: string) => Socket;
	private readonly scheduler: WindowsClientScheduler;
	private readonly connectDeadlineMs: number;
	private readonly ackDeadlineMs: number;
	private stopped = false;
	private readonly pending = new Set<WindowsPendingOutbound>();
	constructor(registry: WindowsSessionPresenceRegistry, senderSessionId: string, config: WindowsActiveSessionClientConfig = {}) {
		this.registry = registry;
		this.senderSessionId = senderSessionId;
		this.connect = config.connect ?? createConnection;
		this.scheduler = config.scheduler ?? { setTimeout, clearTimeout };
		this.connectDeadlineMs = config.connectDeadlineMs ?? RPC_DEADLINE_MS;
		this.ackDeadlineMs = config.ackDeadlineMs ?? RPC_DEADLINE_MS;
		if (!Number.isInteger(this.connectDeadlineMs) || this.connectDeadlineMs < 1 || this.connectDeadlineMs > RPC_DEADLINE_MS || !Number.isInteger(this.ackDeadlineMs) || this.ackDeadlineMs < 1 || this.ackDeadlineMs > RPC_DEADLINE_MS) throw new RangeError("invalid Windows client deadline");
	}
	get pendingCount() { return this.pending.size; }
	get closed() { return this.stopped; }
	close() {
		if (this.stopped) return;
		this.stopped = true;
		for (const pending of [...this.pending]) pending.settle(new ActiveSessionClientError("closed"));
	}
	sendNotification(recipientSessionId: string, message: string, options: { id?: string; expectedActivation?: PresenceRecord; beforeConnect?: () => boolean | Promise<boolean>; signal?: AbortSignal } = {}): Promise<SentNotification> {
		if (this.stopped) return Promise.reject(new ActiveSessionClientError("closed"));
		if (recipientSessionId === this.senderSessionId) return Promise.reject(new ActiveSessionClientError("self"));
		if (this.pending.size >= MAX_PENDING) return Promise.reject(new ActiveSessionClientError("busy"));
		if (options.signal?.aborted) return Promise.reject(new ActiveSessionClientError("aborted"));
		const id = options.id ?? crypto.randomUUID().replaceAll("-", "");
		let pending!: WindowsPendingOutbound;
		return new Promise<SentNotification>((resolve, reject) => {
			pending = { settled: false, settle: (error, result) => {
				if (pending.settled) return;
				pending.settled = true;
				for (const timer of [pending.connectTimer, pending.ackTimer]) if (timer !== undefined) try { this.scheduler.clearTimeout(timer); } catch {}
				pending.connectTimer = pending.ackTimer = undefined;
				if (pending.abort) options.signal?.removeEventListener("abort", pending.abort);
				pending.cleanup?.();
				pending.cleanup = undefined;
				this.pending.delete(pending);
				pending.socket?.destroy();
				if (error) reject(error); else resolve(result!);
			} };
			this.pending.add(pending);
			pending.abort = () => pending.settle(new ActiveSessionClientError(this.stopped ? "closed" : "aborted"));
			options.signal?.addEventListener("abort", pending.abort, { once: true });
			void this.begin(pending, recipientSessionId, message, id, options);
		});
	}
	private async begin(pending: WindowsPendingOutbound, recipientSessionId: string, message: string, id: string, options: { expectedActivation?: PresenceRecord; beforeConnect?: () => boolean | Promise<boolean> }) {
		let record: PresenceRecord;
		try { record = await this.registry.resolve(recipientSessionId); }
		catch { pending.settle(new ActiveSessionClientError(options.expectedActivation ? "stale" : "not_found")); return; }
		if (pending.settled) return;
		if (this.stopped) { pending.settle(new ActiveSessionClientError("closed")); return; }
		if (options.expectedActivation && JSON.stringify(record) !== JSON.stringify(options.expectedActivation)) { pending.settle(new ActiveSessionClientError("stale")); return; }
		try { if (options.beforeConnect && !await options.beforeConnect()) { pending.settle(new ActiveSessionClientError("stale")); return; } }
		catch { pending.settle(new ActiveSessionClientError("stale")); return; }
		if (pending.settled) return;
		if (this.stopped) { pending.settle(new ActiveSessionClientError("closed")); return; }
		let request: Buffer;
		try { request = encodeNotificationFrame(Object.freeze({ version: 1, kind: "notification", id, senderSessionId: this.senderSessionId, recipientSessionId, message })); }
		catch { pending.settle(new ActiveSessionClientError("io_error")); return; }
		let socket: Socket;
		try { socket = this.connect(record.endpoint); }
		catch { pending.settle(new ActiveSessionClientError("io_error")); return; }
		if (pending.settled) { socket.destroy(); return; }
		pending.socket = socket;
		const decoder = new FrameDecoder();
		const finishAck = () => {
			if (pending.settled) return;
			try {
				const ack = decoder.finish() as AckFrame;
				if (ack.kind !== "ack" || ack.id !== id) pending.settle(new ActiveSessionClientError("invalid_ack"));
				else if (!ack.accepted) pending.settle(new ActiveSessionClientError("remote_rejected"));
				else pending.settle(undefined, Object.freeze({ id, accepted: true }));
			} catch { pending.settle(new ActiveSessionClientError("invalid_ack")); }
		};
		const onConnect = () => {
			if (pending.settled) return;
			if (pending.connectTimer !== undefined) { try { this.scheduler.clearTimeout(pending.connectTimer); } catch {} pending.connectTimer = undefined; }
			try { socket.write(request); } catch { pending.settle(new ActiveSessionClientError("io_error")); return; }
			if (pending.settled) return;
			try {
				const timer = this.scheduler.setTimeout(() => pending.settle(new ActiveSessionClientError("ack_timeout")), this.ackDeadlineMs);
				if (pending.settled) { try { this.scheduler.clearTimeout(timer); } catch {} return; }
				pending.ackTimer = timer;
			} catch { pending.settle(new ActiveSessionClientError("ack_timeout")); }
		};
		const onData = (chunk: Buffer) => { if (!pending.settled) try { decoder.push(chunk); } catch { pending.settle(new ActiveSessionClientError("invalid_ack")); } };
		const onClose = () => { if (!pending.settled) pending.settle(new ActiveSessionClientError("io_error")); };
		const onError = () => pending.settle(new ActiveSessionClientError("io_error"));
		const cleanup = () => {
			socket.removeListener("connect", onConnect);
			socket.removeListener("data", onData);
			socket.removeListener("end", finishAck);
			socket.removeListener("close", onClose);
			socket.removeListener("error", onError);
		};
		// Install cleanup before the first registration: EventEmitter-compatible fakes
		// may synchronously abort or throw after attaching an individual handler.
		pending.cleanup = cleanup;
		try {
			socket.once("connect", onConnect);
			if (pending.settled) return;
			socket.on("data", onData);
			if (pending.settled) return;
			socket.once("end", finishAck);
			if (pending.settled) return;
			socket.once("close", onClose);
			if (pending.settled) return;
			socket.once("error", onError);
			if (pending.settled) return;
			const timer = this.scheduler.setTimeout(() => pending.settle(new ActiveSessionClientError("connect_timeout")), this.connectDeadlineMs);
			if (pending.settled) { try { this.scheduler.clearTimeout(timer); } catch {} return; }
			pending.connectTimer = timer;
		} catch { pending.settle(new ActiveSessionClientError("io_error")); }
	}
}
