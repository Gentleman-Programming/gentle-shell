export const DESKTOP_RPC_SCHEMA = "gentle-shell.desktop-rpc/v1";
export const DESKTOP_RPC_COMMAND = "gentle:desktop";
export const DESKTOP_RPC_WIDGET = "gentle-desktop-rpc";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_METHODS = ["capabilities", "get_snapshot"] as const;

export type DesktopRpcPublish = (line: string) => void;
export type DesktopRpcState = Record<string, unknown>;

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

/** Session-scoped protocol state. Domain operations are supplied by each slice. */
export class DesktopRpcRouter {
	private sequence = 0;
	private publisher: DesktopRpcPublish | undefined;
	private readonly methods: readonly string[];
	private readonly events: readonly string[];
	private readonly state: () => DesktopRpcState;

	constructor(
		methods: readonly string[] = DEFAULT_METHODS,
		events: readonly string[] = [],
		state: () => DesktopRpcState = () => ({}),
	) {
		this.methods = methods;
		this.events = events;
		this.state = state;
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

	handle(raw: string): void {
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
				case "get_snapshot":
					data = this.snapshot();
					break;
				default:
					publish(JSON.stringify(errorResponse(request.requestId, "unsupported_method", "Unsupported Desktop RPC method")));
					return;
			}
		} catch {
			publish(JSON.stringify(errorResponse(request.requestId, "internal_error", "Desktop RPC operation failed")));
			return;
		}
		let line: string;
		try {
			line = JSON.stringify({
				schema: DESKTOP_RPC_SCHEMA,
				kind: "response",
				requestId: request.requestId,
				ok: true,
				data,
			});
		} catch {
			publish(JSON.stringify(errorResponse(request.requestId, "internal_error", "Desktop RPC operation failed")));
			return;
		}
		publish(line);
	}
}
