export const DESKTOP_RPC_SCHEMA = "gentle-shell.desktop-rpc/v1";
export const DESKTOP_RPC_COMMAND = "gentle:desktop";
export const DESKTOP_RPC_WIDGET = "gentle-desktop-rpc";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_METHODS = ["capabilities", "get_snapshot"] as const;
const INTERNAL_ERROR = { code: "internal_error", message: "Desktop RPC operation failed" } as const;

export type DesktopRpcPublish = (line: string) => void;
export type DesktopRpcState = Record<string, unknown>;

/** One domain outcome: data for a response plus at most one event published after it. */
export type DesktopRpcOutcome =
	| { ok: true; data: DesktopRpcState; event?: { name: string; data: DesktopRpcState } }
	| { ok: false; error: { code: string; message: string } };

/** Domain methods are supplied by each slice; `undefined` means "not implemented". */
export type DesktopRpcDomain = (
	method: string,
	params: Record<string, unknown>,
) => DesktopRpcOutcome | undefined | Promise<DesktopRpcOutcome | undefined>;

type DesktopRpcRequest = {
	schema: typeof DESKTOP_RPC_SCHEMA;
	requestId: string;
	method: string;
	params: Record<string, unknown>;
};

type DecodedRequest = {
	request?: DesktopRpcRequest;
	requestId: string | null;
};

function errorResponse(requestId: string | null, code: string, message: string) {
	return {
		schema: DESKTOP_RPC_SCHEMA,
		kind: "response",
		requestId,
		ok: false,
		error: { code, message },
	};
}

function validRequestId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function decodeRequest(raw: string): DecodedRequest {
	if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) return { requestId: null };
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { requestId: null };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { requestId: null };
	const candidate = value as Record<string, unknown>;
	const requestId = validRequestId(candidate.requestId) ? candidate.requestId : null;
	if (candidate.schema !== DESKTOP_RPC_SCHEMA) return { requestId };
	if (requestId === null || typeof candidate.method !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(candidate.method)) {
		return { requestId };
	}
	if (candidate.params !== undefined && (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params))) {
		return { requestId };
	}
	return {
		requestId,
		request: {
			schema: DESKTOP_RPC_SCHEMA,
			requestId,
			method: candidate.method,
			params: (candidate.params ?? {}) as Record<string, unknown>,
		},
	};
}

function isThenable(value: unknown): value is Promise<DesktopRpcOutcome | undefined> {
	return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

/** Session-scoped protocol state. Domain operations are supplied by each slice. */
export class DesktopRpcRouter {
	private sequence = 0;
	private publisher: DesktopRpcPublish | undefined;
	private readonly methods: readonly string[];
	private readonly events: readonly string[];
	private readonly state: () => DesktopRpcState;
	private readonly domain: DesktopRpcDomain | undefined;

	constructor(
		methods: readonly string[] = DEFAULT_METHODS,
		events: readonly string[] = [],
		state: () => DesktopRpcState = () => ({}),
		domain?: DesktopRpcDomain,
	) {
		this.methods = methods;
		this.events = events;
		this.state = state;
		this.domain = domain;
	}

	start(publish: DesktopRpcPublish): void {
		this.sequence = 0;
		this.publisher = publish;
	}

	stop(): void {
		this.sequence = 0;
		this.publisher = undefined;
	}

	snapshot() {
		return { schema: DESKTOP_RPC_SCHEMA, sequence: this.sequence, state: this.state() };
	}

	emit(event: string, data: Record<string, unknown>): void {
		if (!this.publisher) return;
		const sequence = this.sequence + 1;
		this.publisher(JSON.stringify({
			schema: DESKTOP_RPC_SCHEMA,
			kind: "event",
			seq: sequence,
			event,
			data,
		}));
		this.sequence = sequence;
	}

	/**
	 * Synchronous methods answer before `handle` returns; domain methods may wait
	 * for an owner. A late outcome for a replaced publisher is dropped, so a
	 * shutdown or reload never answers into the wrong session.
	 */
	handle(raw: string): void | Promise<void> {
		if (!this.publisher) return;
		const publish = this.publisher;
		const decoded = decodeRequest(raw);
		const request = decoded.request;
		if (!request) {
			publish(JSON.stringify(errorResponse(decoded.requestId, "invalid_request", "Request must be a valid JSON object")));
			return;
		}
		if (!this.methods.includes(request.method)) {
			publish(JSON.stringify(errorResponse(request.requestId, "unsupported_method", "Unsupported Desktop RPC method")));
			return;
		}
		if (request.method !== "capabilities" && request.method !== "get_snapshot") {
			if (!this.domain) {
				publish(JSON.stringify(errorResponse(request.requestId, "unsupported_method", "Unsupported Desktop RPC method")));
				return;
			}
			let outcome: DesktopRpcOutcome | undefined | Promise<DesktopRpcOutcome | undefined>;
			try {
				outcome = this.domain(request.method, request.params);
			} catch {
				this.settle(publish, request.requestId, { ok: false, error: INTERNAL_ERROR });
				return;
			}
			if (isThenable(outcome)) {
				return Promise.resolve(outcome).then(
					(value) => this.settle(publish, request.requestId, value),
					() => this.settle(publish, request.requestId, { ok: false, error: INTERNAL_ERROR }),
				);
			}
			this.settle(publish, request.requestId, outcome);
			return;
		}

		let data: Record<string, unknown>;
		try {
			switch (request.method) {
				case "capabilities":
					data = {
						schema: DESKTOP_RPC_SCHEMA,
						command: DESKTOP_RPC_COMMAND,
						widget: DESKTOP_RPC_WIDGET,
						methods: [...this.methods],
						events: [...this.events],
					};
					break;
				default:
					data = this.snapshot();
					break;
			}
		} catch {
			publish(JSON.stringify(errorResponse(request.requestId, INTERNAL_ERROR.code, INTERNAL_ERROR.message)));
			return;
		}
		this.settle(publish, request.requestId, { ok: true, data });
	}

	private settle(
		publish: DesktopRpcPublish,
		requestId: string,
		outcome: DesktopRpcOutcome | undefined,
	): void {
		if (this.publisher !== publish) return;
		if (!outcome) {
			publish(JSON.stringify(errorResponse(requestId, "unsupported_method", "Unsupported Desktop RPC method")));
			return;
		}
		if (outcome.ok === false) {
			publish(JSON.stringify(errorResponse(requestId, outcome.error.code, outcome.error.message)));
			return;
		}
		let line: string;
		try {
			line = JSON.stringify({
				schema: DESKTOP_RPC_SCHEMA,
				kind: "response",
				requestId,
				ok: true,
				data: outcome.data,
			});
		} catch {
			publish(JSON.stringify(errorResponse(requestId, INTERNAL_ERROR.code, INTERNAL_ERROR.message)));
			return;
		}
		publish(line);
		// A change event never precedes its own response; emit re-checks the publisher,
		// which is the same one captured above.
		if (outcome.event) this.emit(outcome.event.name, outcome.event.data);
	}
}
