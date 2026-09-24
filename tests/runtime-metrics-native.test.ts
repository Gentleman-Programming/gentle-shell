import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readFileSync, realpathSync } from "node:fs";
import { setGentleAiDevBinaryEnvironmentForTesting } from "../lib/gentle-ai-binary.ts";
import * as native from "../lib/runtime-metrics-native.ts";
import { parseAgentClass, type RuntimeMetricBucket } from "../lib/runtime-metrics.ts";
import { createHash } from "node:crypto";
import schema from "../contracts/telemetry/runtime-aggregate-v1.schema.json" with { type: "json" };
import fixturePayloads from "./fixtures/runtime-metrics-native-batches.json" with { type: "json" };

function source(): RuntimeMetricBucket {
	const token = () => ({ reported: 1, unavailable: 0, unsupported: 0, sum: 7 });
	const duration = () => ({ measured: 0, unavailable: 1, unsupported: 0, sum: 0 });
	return { hostAgent: "pi", agentClass: parseAgentClass("worker")!, executor: "worker", provider: "openai", modelFamily: "gpt",
		selectedProvider: "openai", selectedModelId: "gpt-5.4", observedModelId: "private-alias", responseModelId: "gpt-5.4",
		effort: "high", providerThinkingLevel: "low", error: "none", responses: 1,
		tokens: { input: token(), output: token(), cacheRead: token(), cacheWrite: token(), reasoning: token(), totalTokens: token() },
		responseHeadersMs: duration(), fullResponseMs: duration() };
}

test("production encoder emits exact one-shot fixture with source occurrence coverage", () => {
	const payload = native.encodeNativeRuntimeEvent([source()]);
	assert.equal(typeof payload, "string", "production encoder must be enabled");
	const value = JSON.parse(payload!);
	assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort());
	assert.deepEqual(Object.keys(value.rows[0]).sort(), [...schema.$defs.row.required].sort());
	assert.equal(value.rows[0].launches, null);
	assert.equal(value.rows[0].responses, 1);
	assert.equal(value.rows[0].selected_effort, "high");
	assert.equal(value.rows[0].effective_effort, "low");
	assert.equal(value.rows[0].model_evidence, "response");
	assert.deepEqual(value.rows[0].model, { provider: "openai", id: "gpt-5.4" });
	assert.ok(!payload!.includes("private"));
	assert.ok(!payload!.includes("batch_id") && !payload!.includes("delivery_id"));
	assert.deepEqual(fixturePayloads.batches, [payload]);
	assert.equal(fixturePayloads.schema_sha256, createHash("sha256").update(readFileSync(new URL("../contracts/telemetry/runtime-aggregate-v1.schema.json", import.meta.url))).digest("hex"));
});

test("child launch occurrence retains selection evidence separately from response evidence", () => {
	const payload = native.encodeNativeRuntimeEvent([source()], [{ evidence: "launch_configuration", agentClass: parseAgentClass("worker")!,
		selectedProvider: "openai", selectedModelId: "gpt-5.4", selectedEffort: "high", launches: 1 }]);
	const rows = JSON.parse(payload!).rows;
	assert.equal(rows.length, 2);
	assert.equal(rows[0].model_evidence, "response");
	assert.equal(rows[1].model_evidence, "selected");
	assert.equal(rows[1].launches, 1);
	assert.equal(rows[1].responses, null);
	assert.equal(rows[1].selected_effort, "high");
	assert.equal(rows[1].effective_effort, "unavailable");
	for (const field of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "reasoning_tokens", "total_tokens"])
		assert.deepEqual(rows[1][field], { reported: 0, unavailable: 0, unsupported: 0, sum: 0 });
});

test("encoder bounds and invalid coverage discard whole events without splitting", () => {
	assert.equal(native.encodeNativeRuntimeEvent([]), undefined);
	assert.equal(native.encodeNativeRuntimeEvent(Array(33).fill(source())), undefined);
	const invalid = source(); invalid.tokens.input.reported = 0;
	assert.equal(native.encodeNativeRuntimeEvent([invalid]), undefined);
	invalid.tokens.input.sum = -1;
	assert.equal(native.encodeNativeRuntimeEvent([invalid]), undefined);
	const valid = source();
	assert.equal(typeof native.encodeNativeRuntimeEvent([valid]), "string");
	assert.equal(native.encodeNativeRuntimeEvent(Array(32).fill(valid)), undefined, "16 KiB bound applies even below row limit");
	valid.fullResponseMs = { measured: 1, unavailable: 0, unsupported: 0, sum: 12.5 };
	assert.deepEqual(JSON.parse(native.encodeNativeRuntimeEvent([valid])!).rows[0].duration,
		{ kind: "request", measured_count: 1, sum_ms: 12.5 });
	valid.tokens.input = { reported: 0, unavailable: 0, unsupported: 1, sum: 0 };
	assert.deepEqual(JSON.parse(native.encodeNativeRuntimeEvent([valid])!).rows[0].input_tokens, valid.tokens.input);
});

test("encoder filters custom identities and never promotes SDK model to response proof", () => {
	const row = source(); row.provider = "custom"; row.responseModelId = "private-model";
	row.agentClass = "private-agent" as any; row.effort = "private-effort" as any;
	row.error = "authentication";
	const encoded = JSON.parse(native.encodeNativeRuntimeEvent([row])!);
	// "private-model" never normalizes to a public id, so it never claims
	// response evidence; the row falls through to the still-public selection
	// (source()'s default selectedModelId "gpt-5.4") instead of leaking it or
	// collapsing a perfectly good selected identity to custom/custom.
	assert.deepEqual(encoded.rows[0].model, { provider: "openai", id: "gpt-5.4" });
	assert.equal(encoded.rows[0].model_evidence, "selected");
	assert.equal(encoded.rows[0].agent_class, "unknown");
	assert.equal(encoded.rows[0].selected_effort, "unavailable");
	assert.equal(encoded.rows[0].error_category, "auth");
	assert.ok(!JSON.stringify(encoded).includes("private"));
	row.selectedModelId = "unknown";
	const observedFallback = JSON.parse(native.encodeNativeRuntimeEvent([row])!);
	// With no public selected model either, it falls through once more, but
	// source()'s default observedModelId ("private-alias") is not public either.
	assert.equal(observedFallback.rows[0].model_evidence, "unknown");
	assert.deepEqual(observedFallback.rows[0].model, { provider: "unknown", id: "unknown" });
});

test("a public observed model is a fallback evidence tier, behind response and selected", () => {
	const row = source();
	row.responseModelId = "unknown"; row.selectedModelId = "unknown"; row.observedModelId = "glm5.3-flash"; row.provider = "nan";
	const encoded = JSON.parse(native.encodeNativeRuntimeEvent([row])!);
	assert.deepEqual(encoded.rows[0].model, { provider: "nan", id: "glm5.3-flash" });
	assert.equal(encoded.rows[0].model_evidence, "selected", "the transport has no separate observed evidence category");
	// A public response model still wins over a public observed model.
	const withResponse = source();
	withResponse.selectedModelId = "unknown"; withResponse.observedModelId = "glm5.3-flash"; withResponse.provider = "nan";
	const encodedResponse = JSON.parse(native.encodeNativeRuntimeEvent([withResponse])!);
	assert.equal(encodedResponse.rows[0].model_evidence, "response");
	// A public selected model still wins over a public observed model.
	const withSelected = source();
	withSelected.responseModelId = "unknown"; withSelected.observedModelId = "glm5.3-flash"; withSelected.provider = "nan";
	const encodedSelected = JSON.parse(native.encodeNativeRuntimeEvent([withSelected])!);
	assert.equal(encodedSelected.rows[0].model_evidence, "selected");
	assert.deepEqual(encodedSelected.rows[0].model, { provider: withSelected.selectedProvider, id: withSelected.selectedModelId });
	// A non-public observed model still falls through to unknown/unknown.
	const noEvidence = source();
	noEvidence.responseModelId = "unknown"; noEvidence.selectedModelId = "unknown"; noEvidence.observedModelId = "private-alias";
	const encodedUnknown = JSON.parse(native.encodeNativeRuntimeEvent([noEvidence])!);
	assert.deepEqual(encodedUnknown.rows[0].model, { provider: "unknown", id: "unknown" });
	assert.equal(encodedUnknown.rows[0].model_evidence, "unknown");
});

test("every encoded model satisfies the schema's anyOf, by pattern or by sentinel", () => {
	const idRule = schema.$defs.model.anyOf[0].properties.id as { pattern: string };
	const providerRule = schema.$defs.model.anyOf[0].properties.provider as { pattern: string };
	const idPattern = new RegExp(idRule.pattern);
	const providerPattern = new RegExp(providerRule.pattern);
	const sentinels = schema.$defs.model.anyOf.slice(1) as Array<{ properties: { provider: { const: string }; id: { const: string } } }>;
	function matchesSchema(model: { provider: string; id: string }): boolean {
		if (providerPattern.test(model.provider) && idPattern.test(model.id)) return true;
		return sentinels.some(({ properties }) => properties.provider.const === model.provider && properties.id.const === model.id);
	}
	// Response/selected/observed rows only ever win evidence with an id that is
	// already public, so their encoded model is either the public-pattern
	// branch or the terminal unknown/unknown sentinel. The custom/custom and
	// opencode/custom sentinels are reachable only through a launch row, which
	// (already upstream-classified, always "selected" evidence) is paired
	// through the same normalizer unconditionally.
	const rows: RuntimeMetricBucket[] = [
		source(),
		{ ...source(), provider: "nan", selectedProvider: "nan", selectedModelId: "deepseek-v4-flash", responseModelId: "unknown" },
		{ ...source(), responseModelId: "unknown", selectedModelId: "unknown", observedModelId: "unknown" },
	];
	const launches = [
		{ evidence: "launch_configuration" as const, agentClass: parseAgentClass("worker")!, selectedProvider: "opencode", selectedModelId: "custom", selectedEffort: "high" as const, launches: 1 },
		{ evidence: "launch_configuration" as const, agentClass: parseAgentClass("worker")!, selectedProvider: "custom", selectedModelId: "custom", selectedEffort: "high" as const, launches: 1 },
		{ evidence: "launch_configuration" as const, agentClass: parseAgentClass("worker")!, selectedProvider: "unknown", selectedModelId: "unknown", selectedEffort: "high" as const, launches: 1 },
	];
	const payload = native.encodeNativeRuntimeEvent(rows, launches);
	assert.ok(payload);
	const decoded = JSON.parse(payload).rows as Array<{ model: { provider: string; id: string } }>;
	assert.equal(decoded.length, rows.length + launches.length);
	for (const row of decoded) assert.ok(matchesSchema(row.model), `model ${JSON.stringify(row.model)} must satisfy $defs.model.anyOf`);
	assert.deepEqual(decoded.map(row => row.model), [
		{ provider: "openai", id: "gpt-5.4" }, { provider: "nan", id: "deepseek-v4-flash" }, { provider: "unknown", id: "unknown" },
		{ provider: "opencode", id: "custom" }, { provider: "custom", id: "custom" }, { provider: "unknown", id: "unknown" },
	]);
});

function fixture() {
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
		kill: () => { killed++; return true; }, unref() {},
	});
	let killed = 0;
	const calls: unknown[][] = [];
	let input = "";
	child.stdin.on("data", chunk => { input += chunk; });
	const deps = {
		env: {}, resolve: () => "fake-native",
		encode: () => '{"host":"pi","rows":[]}',
		spawn: (...args: unknown[]) => { calls.push(args); return child as any; },
	};
	return { deps, child, calls, input: () => input, killed: () => killed,
		close: (decision = "stored") => {
			child.stdout.write(JSON.stringify({ schema: native.NATIVE_SEND_ACK_SCHEMA, decision }));
			child.emit("close", 0, null);
		} };
}

test("one native stdin send; busy drops without another invocation or policy probe", async () => {
	const f = fixture();
	const first = native.sendNativeRuntimeEvent([], "/fixture", f.deps);
	assert.equal(f.calls.length, 1);
	assert.deepEqual(f.calls[0][1], ["telemetry", "runtime", "send", "--json"]);
	assert.equal(f.input(), '{"host":"pi","rows":[]}');
	assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", f.deps), "discarded");
	f.close();
	assert.equal(await first, "stored");
	assert.equal(f.calls.length, 1);
});

test("production encoder reaches the fake one-shot child without a test encoding override", async () => {
	const f = fixture();
	const { encode: _encode, ...deps } = f.deps;
	const first = native.sendNativeRuntimeEvent([source()], "/fixture", deps);
	assert.equal(f.calls.length, 1);
	assert.equal(f.input(), fixturePayloads.batches[0]);
	f.close(); assert.equal(await first, "stored");
});

test("validated dev override reaches the one-shot child through the production resolver", async () => {
	const file = realpathSync(process.execPath);
	setGentleAiDevBinaryEnvironmentForTesting({ env: { GENTLE_PI_GENTLE_AI_DEV_BINARY: file }, home: "/unused" });
	try {
		const f = fixture();
		const { resolve: _resolve, encode: _encode, ...deps } = f.deps;
		const pending = native.sendNativeRuntimeEvent([source()], "/fixture", deps);
		f.close();
		assert.equal(await pending, "stored");
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0][0], file);
		assert.deepEqual(f.calls[0][1], ["telemetry", "runtime", "send", "--json"]);
		assert.equal(f.input(), fixturePayloads.batches[0]);
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("invalid dev overrides fail closed without spawning or falling back", async () => {
	for (const file of ["relative-binary", realpathSync(new URL(".", import.meta.url))]) {
		setGentleAiDevBinaryEnvironmentForTesting({ env: { GENTLE_PI_GENTLE_AI_DEV_BINARY: file }, home: "/unused" });
		try {
			const f = fixture();
			const { resolve: _resolve, ...deps } = f.deps;
			assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", deps), "discarded");
			assert.equal(f.calls.length, 0);
		} finally {
			setGentleAiDevBinaryEnvironmentForTesting(undefined);
		}
	}
});

test("opt-out and pre-cancel cause zero encoding, resolution or launch", async () => {
	const f = fixture();
	f.deps.resolve = () => { throw new Error("must not resolve"); };
	f.deps.encode = () => { throw new Error("must not encode"); };
	assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", { ...f.deps, env: { DO_NOT_TRACK: "1" } }), "disabled");
	assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", { ...f.deps, signal: AbortSignal.abort() }), "discarded");
	assert.equal(f.calls.length, 0);
});

test("cancel kills once and keeps slot occupied until actual close", async () => {
	const f = fixture();
	const abort = new AbortController();
	const first = native.sendNativeRuntimeEvent([], "/fixture", { ...f.deps, signal: abort.signal });
	abort.abort(); abort.abort();
	assert.equal(f.killed(), 1);
	assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", f.deps), "discarded");
	f.close();
	assert.equal(await first, "discarded");
});

for (const decision of ["discarded", "disabled", "stored", "duplicate", "sent", "private error"]) {
	test(`native result ${decision} never triggers retry`, async () => {
		const f = fixture();
		const first = native.sendNativeRuntimeEvent([], "/fixture", f.deps);
		f.close(decision);
		assert.equal(await first, ["stored", "duplicate", "disabled"].includes(decision) ? decision : "discarded");
		assert.equal(f.calls.length, 1);
	});
}

test("metrics receiver, attempt gate and send transport have no filesystem persistence surface", () => {
	for (const path of ["../extensions/runtime-metrics.ts", "../lib/runtime-metrics-delivery.ts", "../lib/runtime-metrics-native.ts"]) {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		assert.doesNotMatch(source, /node:fs|appendEntry\s*\(|writeFile|mkdir|createWriteStream/);
	}
});

test("spawn failure silently discards", async () => {
	const f = fixture();
	let calls = 0;
	assert.equal(await native.sendNativeRuntimeEvent([], "/fixture", { ...f.deps,
		spawn: () => { calls++; throw new Error("private error"); } }), "discarded");
	assert.equal(calls, 1);
});
