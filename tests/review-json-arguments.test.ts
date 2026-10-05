import assert from "node:assert/strict";
import test from "node:test";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, validateToolArguments, type Model, type ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";

function registeredTools(): Map<string, any> {
	const tools = new Map<string, any>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {}, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI);
	return tools;
}

const tools = registeredTools();
function validate(name: string, args: Record<string, unknown>): any {
	return validateToolArguments(tools.get(name), { type: "toolCall", id: "json-arguments", name, arguments: args as ToolCall["arguments"] });
}

test("public Anthropic non-strict adapter preserves the complete review tool declarations", async () => {
	const model: Model<"anthropic-messages"> = {
		id: "claude-sonnet-4-20250514", name: "Payload-only model", api: "anthropic-messages", provider: "anthropic",
		baseUrl: "https://example.invalid", input: ["text"], reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024,
		compat: { supportsStrictTools: false },
	};
	let payload: any;
	let transportCalls = 0;
	const sentinel = "PAYLOAD_CAPTURED_BEFORE_TRANSPORT";
	const result = await streamAnthropic(model, normalizeContext({ messages: [{ role: "user", content: "payload only", timestamp: 0 }], tools: [...tools.values()] }), {
		apiKey: "dummy-test-key", env: {},
		onPayload(value) { payload = value; throw new Error(sentinel); },
		fetch: async () => { transportCalls++; throw new Error("TRANSPORT_MUST_NOT_RUN"); },
	}).result();
	assert.equal(transportCalls, 0);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", new RegExp(sentinel));
	assert.ok(payload, "adapter reached payload callback");
	const emitted = new Map<string, any>(payload.tools.map((tool: any) => [tool.name, tool.input_schema]));
	const controller = emitted.get("gentle_review");
	assert.equal(controller.type, "object");
	assert.deepEqual(controller.required, ["operation"]);
	assert.deepEqual(Object.keys(controller.properties).sort(), ["operation", "lineageId", "selectionBinding", "intendedUntracked", "untrackedScope", "changeName", "idempotencyKey", "transition", "input", "outputPath", "inputPath", "operationId", "lineageIds", "workspaceRoot"].sort());
	assert.ok(controller.properties.input.anyOf.some((schema: any) => schema.type === "object"));
	assert.match(controller.properties.input.description, /START\/ASSESS only/);
	assert.deepEqual(controller.properties.operation.enum, tools.get("gentle_review").parameters.properties.operation.enum);
	for (const name of ["gentle_review_capture", "gentle_review_capture_group"]) {
		const schema = emitted.get(name);
		assert.deepEqual(schema.required, tools.get(name).parameters.required);
		assert.deepEqual(schema.properties, tools.get(name).parameters.properties);
	}
	assert.ok(emitted.get("gentle_review_capture_group").properties.collectBindings.items.anyOf.some((schema: any) => schema.type === "object"));
	// Anthropic omits the root operation constraints. Even its broader nullable
	// declaration cannot grant consent, maintenance, or native execution.
	let nativeCalls = 0;
	const native = new Proxy({}, { get() { return async () => { nativeCalls++; }; } }) as NativeReviewCli;
	for (const operation of ["start", "assess", "answer-consent", "inspect", "reset", "recover"]) {
		const inputs = operation === "start" || operation === "assess" ? [null] : [null, { consentBinding: "opaque", answer: "granted" }];
		for (const input of inputs) {
			const args = validateToolArguments({ ...tools.get("gentle_review"), parameters: controller }, { type: "toolCall", id: "provider-shell", name: "gentle_review", arguments: { operation, input } });
			assert.deepEqual(args.input, input, "provider-shell validation accepts and retains this input");
			await assert.rejects(__testing.executeReviewControllerOperation(args, process.cwd(), native));
		}
	}
	assert.equal(nativeCalls, 0);
});

const binding = { name: "reviewer_result", arguments: [] };
test("registered review schemas admit START/ASSESS objects and ordered capture objects", () => {
	for (const operation of ["start", "assess"]) {
		const input = operation === "start" ? { mode: "ordinary" } : { committedOnly: true, baseRef: "HEAD" };
		assert.deepEqual(validate("gentle_review", { operation, input }).input, input);
		assert.equal(__testing.parseReviewControllerParameters(validate("gentle_review", { operation, input })).input, JSON.stringify(input));
	}
	assert.deepEqual(validate("gentle_review_capture", { lineageId: "l", collectBinding: binding }).collectBinding, binding);
	const ordered = [binding, ' { "name": "second", "arguments": [] } '];
	const args = validate("gentle_review_capture_group", { lineageId: "l", collectBindings: ordered });
	assert.deepEqual(__testing.parseReviewCaptureGroupParameters(args).collectBindings, [JSON.stringify(binding), ordered[1]]);
});

test("validated ASSESS objects reach the mocked native facade with parsed fields", async () => {
	const requests: unknown[] = [];
	const native = { assess: async (request: unknown) => { requests.push(request); throw new Error("mock assessment unavailable"); } } as unknown as NativeReviewCli;
	for (const input of [{ baseRef: "HEAD", committedOnly: true, nativeReviewOutcome: "unknown" }, ' { "baseRef": "HEAD", "committedOnly": true, "nativeReviewOutcome": "unknown" } ']) {
		await __testing.executeReviewControllerOperation(validate("gentle_review", { operation: "assess", input }), process.cwd(), native);
	}
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0], { cwd: process.cwd(), baseRef: "HEAD", committedOnly: true });
	assert.deepEqual(requests[1], requests[0]);
});

test("serialized inputs remain byte-for-byte unchanged at validation and facade parsing", () => {
	const input = ' \n{ "mode" : "ordinary" }\t';
	for (const operation of ["start", "assess", "answer-consent", "reset", "recover"]) {
		assert.equal(__testing.parseReviewControllerParameters(validate("gentle_review", { operation, input })).input, input);
	}
	const collectBinding = ' { "name": "reviewer_result", "arguments": [] }\n';
	assert.equal(__testing.parseReviewCaptureParameters(validate("gentle_review_capture", { lineageId: "l", collectBinding })).collectBinding, collectBinding);
});

test("actual validation rejects arrays, null and coerced primitives rather than admitting native calls", () => {
	for (const value of [[], null, 123, true, false, "123", "null", "[]"]) {
		for (const operation of ["start", "assess", "answer-consent", "inspect", "reset", "recover"]) {
			assert.throws(() => validate("gentle_review", { operation, input: value }), /Validation failed/);
		}
		assert.throws(() => validate("gentle_review_capture", { lineageId: "l", collectBinding: value }), /Validation failed/);
		assert.throws(() => validate("gentle_review_capture_group", { lineageId: "l", collectBindings: [binding, value] }), /Validation failed/);
	}
});

test("all other controller operations keep object input fail-closed in schema and facade", async () => {
	const operations = tools.get("gentle_review").parameters.anyOf[1].properties.operation.enum;
	let calls = 0;
	const native = new Proxy({}, { get() { return async () => { calls++; throw new Error("unexpected native execution"); }; } }) as NativeReviewCli;
	for (const operation of operations) {
		const args = { operation, lineageId: "l", input: { consentBinding: "opaque", answer: "granted" } };
		assert.throws(() => validate("gentle_review", args), /Validation failed/);
		await assert.rejects(__testing.executeReviewControllerOperation(args, process.cwd(), native));
	}
	assert.equal(calls, 0);
});

test("facade rejects non-JSON runtime objects without lossy serialization or native execution", async () => {
	const cyclic: any = {}; cyclic.self = cyclic;
	const accessor = Object.defineProperty({}, "mode", { enumerable: true, get() { throw new Error("getter must not execute"); } });
	const hidden = Object.defineProperty({}, "hidden", { value: 1 });
	const extended: any[] = [1]; Object.assign(extended, { extra: 1 });
	const invalid = [null, [], 1, true, undefined, new Date(), cyclic, accessor, hidden, new Proxy({}, {}), { x: new Proxy({}, {}) },
		{ x: undefined }, { x: NaN }, { x: Infinity }, { x: -0 }, { x: 1n }, { x() {} },
		{ [Symbol("x")]: 1 }, { x: new Array(2) }, { x: extended }, { toJSON() { return {}; } }];
	let calls = 0;
	const native = new Proxy({}, { get() { return async () => { calls++; }; } }) as NativeReviewCli;
	for (const input of invalid) {
		for (const operation of ["start", "assess"]) {
			await assert.rejects(__testing.executeReviewControllerOperation({ operation, input }, process.cwd(), native), /Review JSON argument/);
		}
		assert.throws(() => __testing.parseReviewCaptureParameters({ lineageId: "l", collectBinding: input }), /Review JSON argument/);
		assert.throws(() => __testing.parseReviewCaptureGroupParameters({ lineageId: "l", collectBindings: [binding, input] }), /Review JSON argument/);
	}
	assert.equal(calls, 0);
});

