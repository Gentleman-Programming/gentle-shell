import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

// This is a deliberately tiny parent-owned channel for package-launched Pi
// children. It carries only a one-shot authorization question and answer; no
// review candidate, consent binding, provider vector, or session authority is
// serialized across the process boundary.

const REQUEST_TYPE = "standing-review-permission-request";
const RESPONSE_TYPE = "standing-review-permission-response";
const MAX_LINE_BYTES = 4096;
const DEFAULT_MAX_REQUESTS = 16;
export const CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SCHEMA = "gentle-pi.child-standing-review-permission/v1";
export const CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL = Symbol.for(CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SCHEMA);
export const CHILD_STANDING_REVIEW_PERMISSION_CLIENT_SCHEMA = "gentle-pi.child-standing-review-permission-client/v1";

export interface ChildStandingReviewPermissionClientHandle {
	readonly schema: typeof CHILD_STANDING_REVIEW_PERMISSION_CLIENT_SCHEMA;
	requestAuthorization(repositoryIdentity: string): Promise<boolean>;
	close(): void;
}

interface ChildPermissionRegistry {
	readonly schema: typeof CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SCHEMA;
	client: ChildStandingReviewPermissionClientHandle | undefined;
	owner: symbol | undefined;
	terminal: boolean;
}

type GlobalRegistry = Record<symbol, unknown>;

function isChildPermissionClient(value: unknown): value is ChildStandingReviewPermissionClientHandle {
	return typeof value === "object" && value !== null &&
		(value as { schema?: unknown }).schema === CHILD_STANDING_REVIEW_PERMISSION_CLIENT_SCHEMA &&
		typeof (value as { requestAuthorization?: unknown }).requestAuthorization === "function" &&
		typeof (value as { close?: unknown }).close === "function";
}

function childPermissionRegistry(): ChildPermissionRegistry | undefined {
	const globalRegistry = globalThis as GlobalRegistry;
	const current = globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL];
	if (current === undefined) {
		const created: ChildPermissionRegistry = { schema: CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SCHEMA, client: undefined, owner: undefined, terminal: false };
		globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL] = created;
		return created;
	}
	if (
		typeof current !== "object" || current === null ||
		(current as { schema?: unknown }).schema !== CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SCHEMA ||
		typeof (current as { terminal?: unknown }).terminal !== "boolean" ||
		!((current as { client?: unknown }).client === undefined || isChildPermissionClient((current as { client?: unknown }).client)) ||
		!((current as { owner?: unknown }).owner === undefined || typeof (current as { owner?: unknown }).owner === "symbol")
	) return undefined;
	return current as ChildPermissionRegistry;
}

export interface StandingReviewPermissionChannel {
	readonly readable: Readable;
	readonly writable: Writable;
}

interface Request {
	type: typeof REQUEST_TYPE;
	id: string;
	repositoryIdentity: string;
}

interface Response {
	type: typeof RESPONSE_TYPE;
	id: string;
	granted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function request(value: unknown): Request | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 3 ||
		value.type !== REQUEST_TYPE ||
		typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128 ||
		typeof value.repositoryIdentity !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.repositoryIdentity)
	) return undefined;
	return { type: REQUEST_TYPE, id: value.id, repositoryIdentity: value.repositoryIdentity };
}

function response(value: unknown): Response | undefined {
	if (!isRecord(value) || value.type !== RESPONSE_TYPE || typeof value.id !== "string" || typeof value.granted !== "boolean") return undefined;
	return { type: RESPONSE_TYPE, id: value.id, granted: value.granted };
}

function attachJsonLines(stream: Readable, onValue: (value: unknown) => void): () => void {
	let buffer = "";
	const onData = (chunk: Buffer | string) => {
		buffer += chunk.toString();
		if (buffer.length > MAX_LINE_BYTES) {
			buffer = "";
			return;
		}
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const raw of lines) {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (line.length === 0 || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
			try { onValue(JSON.parse(line)); } catch { /* Malformed child traffic is denied by silence. */ }
		}
	};
	stream.on("data", onData);
	return () => stream.off("data", onData);
}

function write(channel: Writable, value: Response | Request): boolean {
	try {
		return channel.write(`${JSON.stringify(value)}\n`);
	} catch {
		return false;
	}
}

/**
 * The parent binds this broker to one live AgentRunner task. Every request
 * calls `authorize` again, so replacement, revocation, cancellation, and a
 * dead parent session fail closed without trusting child environment state.
 */
export class ParentStandingReviewPermissionBroker {
	private closed = false;
	private acceptedRequests = 0;
	private readonly channel: StandingReviewPermissionChannel;
	private readonly detach: () => void;
	private readonly authorize: (repositoryIdentity: string) => Promise<boolean> | boolean;
	private readonly maxRequests: number;
	private readonly onChannelTerminal = () => this.close();

	constructor(channel: StandingReviewPermissionChannel, authorize: (repositoryIdentity: string) => Promise<boolean> | boolean, options: { maxRequests?: number } = {}) {
		this.channel = channel;
		this.authorize = authorize;
		this.maxRequests = Number.isSafeInteger(options.maxRequests) && options.maxRequests! > 0 ? options.maxRequests! : DEFAULT_MAX_REQUESTS;
		// These listeners deliberately outlive detach(): late pipe errors can arrive
		// after close and must stay confined to this task's broker.
		channel.readable.on("error", this.onChannelTerminal);
		channel.readable.on("close", this.onChannelTerminal);
		channel.readable.on("end", this.onChannelTerminal);
		channel.writable.on("error", this.onChannelTerminal);
		channel.writable.on("close", this.onChannelTerminal);
		this.detach = attachJsonLines(channel.readable, (value) => {
			const incoming = request(value);
			if (incoming === undefined || this.closed) return;
			if (this.acceptedRequests >= this.maxRequests) {
				this.respond({ type: RESPONSE_TYPE, id: incoming.id, granted: false });
				return;
			}
			this.acceptedRequests += 1;
			void Promise.resolve(this.authorize(incoming.repositoryIdentity))
				.then((granted) => {
					this.respond({ type: RESPONSE_TYPE, id: incoming.id, granted: granted === true });
				})
				.catch(() => {
					this.respond({ type: RESPONSE_TYPE, id: incoming.id, granted: false });
				});
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
	}

	private respond(value: Response): void {
		if (this.closed || this.channel.writable.destroyed || this.channel.writable.writableEnded) return;
		try {
			this.channel.writable.write(`${JSON.stringify(value)}\n`, (error) => {
				if (error !== undefined && error !== null) this.close();
			});
		} catch {
			this.close();
		}
	}
}

function configuredChildPermissionRegistry(processEnv: NodeJS.ProcessEnv): ChildPermissionRegistry | undefined {
	if (processEnv.GENTLE_PI_AGENTS_CHILD !== "1" || processEnv.GENTLE_PI_AGENTS_PARENT_PERMISSION_FD !== "3") return undefined;
	return childPermissionRegistry();
}

function registryClient(state: ChildPermissionRegistry): ChildStandingReviewPermissionClientHandle | undefined {
	if (state.terminal) return undefined;
	if (state.client !== undefined) return state.client;
	try {
		// Node exposes stdin/out/err but not a process.stdio array. The package
		// runner creates fd 3 as an inherited duplex pipe; wrap it once for this
		// process and let reload closures share the same reader and request state.
		const stream = new Socket({ fd: 3, readable: true, writable: true });
		let record: ChildStandingReviewPermissionClientHandle | undefined;
		const client = new ChildStandingReviewPermissionClient({ readable: stream, writable: stream }, {}, () => {
			state.terminal = true;
			if (state.client === record) state.client = undefined;
		});
		record = {
			schema: CHILD_STANDING_REVIEW_PERMISSION_CLIENT_SCHEMA,
			requestAuthorization: (repositoryIdentity) => client.requestAuthorization(repositoryIdentity),
			close: () => client.close(),
		};
		state.client = record;
		return record;
	} catch {
		// An absent or incompatible inherited descriptor is never authorization.
		return undefined;
	}
}

/** The child can ask only whether its parent currently permits a replay. */
export function createChildStandingReviewPermissionClient(
	processEnv: NodeJS.ProcessEnv = process.env,
): ChildStandingReviewPermissionClientHandle | undefined {
	const state = configuredChildPermissionRegistry(processEnv);
	return state === undefined ? undefined : registryClient(state);
}

export interface ChildStandingReviewPermissionLease {
	readonly client: ChildStandingReviewPermissionClientHandle | undefined;
	closeIfCurrent(): void;
}

/** A replacement extension becomes the sole terminal owner of the shared fd3 client. */
export function acquireChildStandingReviewPermissionClient(
	processEnv: NodeJS.ProcessEnv = process.env,
): ChildStandingReviewPermissionLease | undefined {
	const state = configuredChildPermissionRegistry(processEnv);
	if (state === undefined) return undefined;
	const client = registryClient(state);
	if (client === undefined) return { client: undefined, closeIfCurrent() {} };
	const owner = Symbol("child-standing-review-permission-owner");
	state.owner = owner;
	return {
		client,
		closeIfCurrent() {
			if (state.owner !== owner) return;
			state.owner = undefined;
			client.close();
		},
	};
}

export class ChildStandingReviewPermissionClient {
	private closed = false;
	private nextId = 0;
	private pending: { id: string; resolve: (granted: boolean) => void; cancel: () => void } | undefined;
	private readonly detach: () => void;
	private readonly onClosed = () => {
		this.closed = true;
		this.failPending();
		this.onTerminal();
	};
	private readonly channel: StandingReviewPermissionChannel;
	private readonly options: { timeoutMs?: number };
	private readonly onTerminal: () => void;

	constructor(channel: StandingReviewPermissionChannel, options: { timeoutMs?: number } = {}, onTerminal: () => void = () => {}) {
		this.channel = channel;
		this.options = options;
		this.onTerminal = onTerminal;
		this.detach = attachJsonLines(channel.readable, (value) => {
			const incoming = response(value);
			const pending = this.pending;
			if (incoming === undefined || pending === undefined || incoming.id !== pending.id) return;
			this.pending = undefined;
			pending.cancel();
			pending.resolve(incoming.granted);
		});
		channel.readable.once("close", this.onClosed);
		channel.readable.once("end", this.onClosed);
		channel.readable.once("error", this.onClosed);
	}

	requestAuthorization(repositoryIdentity: string): Promise<boolean> {
		if (this.closed || this.pending !== undefined || !/^sha256:[0-9a-f]{64}$/.test(repositoryIdentity)) return Promise.resolve(false);
		this.nextId += 1;
		const id = `p${this.nextId}`;
		return new Promise((resolve) => {
			const timeout = setTimeout(() => this.failPending(), this.options.timeoutMs ?? 5_000);
			timeout.unref?.();
			this.pending = { id, resolve, cancel: () => clearTimeout(timeout) };
			if (!write(this.channel.writable, { type: REQUEST_TYPE, id, repositoryIdentity })) this.failPending();
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		this.channel.readable.off("close", this.onClosed);
		this.channel.readable.off("end", this.onClosed);
		this.channel.readable.off("error", this.onClosed);
		this.failPending();
		this.onTerminal();
		try { this.channel.readable.destroy(); } catch { /* Closing an unavailable child fd is best effort. */ }
	}

	private failPending(): void {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		pending.cancel();
		pending.resolve(false);
	}
}
