// Gentle Desktop host tools: the pure contract shared by the Desktop bridge
// (`lib/desktop-host-tools-service.ts`) and its tests.
//
// A client of the Desktop RPC channel (the desktop app, later a phone) offers
// tools that run on the client itself. The agent sees them as ordinary tools;
// a call becomes a `host_tool_call` event, the client runs it on its own device
// with its own authority, and answers with `host_tool_result`. Nothing here
// runs client code: a host tool's only effect in this process is the event it
// emits and the content the client sends back.

export const DESKTOP_HOST_TOOLS_METHODS = ["set_host_tools", "host_tool_result"] as const;
export const DESKTOP_HOST_TOOLS_EVENTS = ["host_tool_call", "host_tool_cancel"] as const;

export const DESKTOP_HOST_TOOLS_LIMITS = {
	provider: 64,
	tools: 32,
	label: 64,
	description: 4096,
	/** Bytes of a tool's `parameters` JSON Schema, serialized. */
	parametersBytes: 16 * 1024,
	guidelines: 16,
	guideline: 512,
	callId: 128,
	contentItems: 64,
	/** Text bytes (UTF-8) plus base64 image characters across one result. */
	contentBytes: 8 * 1024 * 1024,
	mimeType: 128,
	/** A call no client answered fails after this long. */
	callTimeoutMs: 10 * 60 * 1000,
	/** Settled call ids remembered so a late answer is `already_answered`, not `unknown_call`. */
	settledMemory: 256,
} as const;

/** Whole `/gentle:desktop` request documents these methods may carry; every other method keeps the router's default. */
export const DESKTOP_HOST_TOOLS_REQUEST_BYTES: Readonly<Record<string, number>> = {
	set_host_tools: 1024 * 1024,
	host_tool_result: 9 * 1024 * 1024,
};

export const INVALID_SET_HOST_TOOLS = { code: "invalid_request", message: "Invalid set_host_tools parameters" } as const;
export const INVALID_HOST_TOOL_RESULT = { code: "invalid_request", message: "Invalid host_tool_result parameters" } as const;
export const HOST_TOOL_RESULT_TOO_LARGE = { code: "too_large", message: "host_tool_result content is over 8 MiB" } as const;
export const UNKNOWN_CALL = { code: "unknown_call", message: "No host tool call with this callId" } as const;
export const ALREADY_ANSWERED = { code: "already_answered", message: "This host tool call is already settled" } as const;
export const HOST_TOOLS_UNAVAILABLE = { code: "host_tools_unavailable", message: "Host tools cannot be registered in this session" } as const;

export const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIME_TYPE = /^image\/[a-z0-9][a-z0-9.+-]{0,100}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface HostToolSpec {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	guidelines: string[];
}

export interface SetHostToolsRequest {
	provider: string;
	tools: HostToolSpec[];
}

export type HostToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface HostToolResultRequest {
	callId: string;
	content: HostToolContent[];
	isError: boolean;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number, allowNewlines = false): value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) return false;
	return allowNewlines ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) : !CONTROL.test(value);
}

function invalid(message: string): { ok: false; error: { code: string; message: string } } {
	return { ok: false, error: { code: INVALID_SET_HOST_TOOLS.code, message: `${INVALID_SET_HOST_TOOLS.message}: ${message}` } };
}

function parseTool(raw: unknown, index: number): Parsed<HostToolSpec> {
	const at = `tools[${index}]`;
	if (!isPlainObject(raw) || !onlyKeys(raw, ["name", "label", "description", "parameters", "guidelines"])) return invalid(`${at} must be an object with name, label, description, parameters and optional guidelines`);
	if (typeof raw.name !== "string" || !TOOL_NAME.test(raw.name)) return invalid(`${at}.name must match ${TOOL_NAME.source}`);
	if (!text(raw.label, DESKTOP_HOST_TOOLS_LIMITS.label)) return invalid(`${at}.label must be 1-${DESKTOP_HOST_TOOLS_LIMITS.label} characters`);
	if (!text(raw.description, DESKTOP_HOST_TOOLS_LIMITS.description, true)) return invalid(`${at}.description must be 1-${DESKTOP_HOST_TOOLS_LIMITS.description} characters`);
	if (!isPlainObject(raw.parameters) || raw.parameters.type !== "object") return invalid(`${at}.parameters must be a JSON Schema object with type "object"`);
	if (Buffer.byteLength(JSON.stringify(raw.parameters), "utf8") > DESKTOP_HOST_TOOLS_LIMITS.parametersBytes) return invalid(`${at}.parameters is over ${DESKTOP_HOST_TOOLS_LIMITS.parametersBytes} bytes`);
	let guidelines: string[] = [];
	if (raw.guidelines !== undefined) {
		if (!Array.isArray(raw.guidelines) || raw.guidelines.length > DESKTOP_HOST_TOOLS_LIMITS.guidelines || !raw.guidelines.every((line) => text(line, DESKTOP_HOST_TOOLS_LIMITS.guideline))) {
			return invalid(`${at}.guidelines must be at most ${DESKTOP_HOST_TOOLS_LIMITS.guidelines} single-line strings of 1-${DESKTOP_HOST_TOOLS_LIMITS.guideline} characters`);
		}
		guidelines = raw.guidelines as string[];
	}
	return { ok: true, value: { name: raw.name, label: raw.label, description: raw.description, parameters: raw.parameters, guidelines } };
}

/** `{ provider, tools }`: the whole set one provider offers; an empty list unregisters it. */
export function parseSetHostTools(params: Record<string, unknown>): Parsed<SetHostToolsRequest> {
	if (!onlyKeys(params, ["provider", "tools"])) return invalid("only provider and tools are allowed");
	if (!text(params.provider, DESKTOP_HOST_TOOLS_LIMITS.provider)) return invalid(`provider must be 1-${DESKTOP_HOST_TOOLS_LIMITS.provider} characters`);
	if (!Array.isArray(params.tools) || params.tools.length > DESKTOP_HOST_TOOLS_LIMITS.tools) return invalid(`tools must be a list of at most ${DESKTOP_HOST_TOOLS_LIMITS.tools}`);
	const tools: HostToolSpec[] = [];
	const names = new Set<string>();
	for (const [index, raw] of params.tools.entries()) {
		const tool = parseTool(raw, index);
		if (tool.ok === false) return { ok: false, error: tool.error };
		if (names.has(tool.value.name)) return invalid(`tool ${tool.value.name} is listed twice`);
		names.add(tool.value.name);
		tools.push(tool.value);
	}
	return { ok: true, value: { provider: params.provider, tools } };
}

/** `{ callId, content, isError? }`, with the content cap counted over text bytes and base64 characters. */
export function parseHostToolResult(params: Record<string, unknown>): Parsed<HostToolResultRequest> {
	const bad = { ok: false as const, error: INVALID_HOST_TOOL_RESULT };
	if (!onlyKeys(params, ["callId", "content", "isError"])) return bad;
	if (typeof params.callId !== "string" || params.callId.length === 0 || params.callId.length > DESKTOP_HOST_TOOLS_LIMITS.callId) return bad;
	if (params.isError !== undefined && typeof params.isError !== "boolean") return bad;
	if (!Array.isArray(params.content) || params.content.length === 0 || params.content.length > DESKTOP_HOST_TOOLS_LIMITS.contentItems) return bad;
	const content: HostToolContent[] = [];
	let bytes = 0;
	for (const item of params.content) {
		if (!isPlainObject(item)) return bad;
		if (item.type === "text" && onlyKeys(item, ["type", "text"]) && typeof item.text === "string") {
			bytes += Buffer.byteLength(item.text, "utf8");
			content.push({ type: "text", text: item.text });
		} else if (item.type === "image" && onlyKeys(item, ["type", "data", "mimeType"]) && typeof item.data === "string" && item.data.length > 0
			&& typeof item.mimeType === "string" && item.mimeType.length <= DESKTOP_HOST_TOOLS_LIMITS.mimeType && MIME_TYPE.test(item.mimeType)) {
			bytes += item.data.length;
			if (bytes > DESKTOP_HOST_TOOLS_LIMITS.contentBytes) return { ok: false, error: HOST_TOOL_RESULT_TOO_LARGE };
			if (item.data.length % 4 !== 0 || !BASE64.test(item.data)) return bad;
			content.push({ type: "image", data: item.data, mimeType: item.mimeType });
		} else {
			return bad;
		}
		if (bytes > DESKTOP_HOST_TOOLS_LIMITS.contentBytes) return { ok: false, error: HOST_TOOL_RESULT_TOO_LARGE };
	}
	return { ok: true, value: { callId: params.callId, content, isError: params.isError === true } };
}

/**
 * Guidelines reach the model as flat bullets of the system prompt's rules, with
 * no tool name in front (Pi's `promptGuidelines`). One that does not name its
 * tool gets the name prefixed, so "this tool" is never ambiguous.
 */
export function modelGuidelines(tool: Pick<HostToolSpec, "name" | "guidelines">): string[] {
	return tool.guidelines.map((line) => (line.includes(tool.name) ? line : `${tool.name}: ${line}`));
}

/** The one-line entry in the system prompt's tool list: the description's first line. */
export function promptSnippet(tool: Pick<HostToolSpec, "description">): string {
	const first = tool.description.trim().split(/\r?\n/, 1)[0] ?? "";
	return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

/** What the model reads when a host tool's provider cannot run it. */
export function hostToolOfflineText(tool: string, providerLabel: string): string {
	return `${tool} runs in ${providerLabel}, which isn't connected right now.`;
}
