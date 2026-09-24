import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeModel } from "../lib/runtime-metrics.ts";

// Data-driven family-pattern normalizer (gentle-pi#968 / gentle-ai#4536). Rules:
// - non-string or empty provider or id -> {provider: "unknown", id: "unknown"};
// - id is trimmed, the LAST "/"-separated segment is kept, then lowercased; it is
//   public only when it matches the schema id pattern within its maxLength,
//   otherwise the id becomes "custom";
// - provider is trimmed and lowercased; it is kept when it matches the schema
//   provider pattern, otherwise it becomes "custom";
// - when the id is not public the provider becomes "custom" too, except for the
//   "opencode" provider, which yields "opencode"/"custom";
// - the literal "unknown"/"unknown" and "custom"/"custom" pairs pass through.
const cases: Array<[string, unknown, unknown, { provider: string; id: string }]> = [
	["open-weight family on an arbitrary provider stays public", "nan", "deepseek-v4-flash", { provider: "nan", id: "deepseek-v4-flash" }],
	["a short version suffix without a separator is still public", "nan", "glm5.3", { provider: "nan", id: "glm5.3" }],
	["multiple suffix groups without a leading separator are still public", "nan", "glm5.3-flash", { provider: "nan", id: "glm5.3-flash" }],
	["only the last '/'-separated id segment is kept", "nano-gpt", "TEE/glm-5.3", { provider: "nano-gpt", id: "glm-5.3" }],
	["a nested provider path in the id is dropped, keeping the outer provider", "openrouter", "deepseek/deepseek-v4-flash", { provider: "openrouter", id: "deepseek-v4-flash" }],
	["provider and id are lowercased", "OpenAI", "GPT-5.6-Sol", { provider: "openai", id: "gpt-5.6-sol" }],
	["a long dotted/dashed anthropic id stays public", "anthropic", "claude-sonnet-5-20260101", { provider: "anthropic", id: "claude-sonnet-5-20260101" }],
	["an id with no recognized family prefix collapses provider and id to custom", "acme", "acme-internal-finetune", { provider: "custom", id: "custom" }],
	["a public id with a non-conforming provider is emitted as custom/<id>", "Acme Corp", "gpt-5.6", { provider: "custom", id: "gpt-5.6" }],
	["an id longer than the schema maxLength collapses to custom/custom", "anthropic", `claude-${"x".repeat(64)}`, { provider: "custom", id: "custom" }],
	["opencode keeps its provider identity even for a private id", "opencode", "private-thing", { provider: "opencode", id: "custom" }],
	["empty provider and id fail closed to unknown/unknown", "", "", { provider: "unknown", id: "unknown" }],
];

for (const [name, provider, id, expected] of cases) {
	test(`normalizeRuntimeModel: ${name}`, () => {
		assert.deepEqual(normalizeRuntimeModel(provider, id), expected);
	});
}

test("non-string provider or id fails closed to unknown/unknown", () => {
	for (const [provider, id] of [[undefined, "gpt-5.6"], ["openai", undefined], [null, null], [42, "gpt-5.6"], ["openai", { id: "gpt-5.6" }]] as const) {
		assert.deepEqual(normalizeRuntimeModel(provider, id), { provider: "unknown", id: "unknown" });
	}
});

test("whitespace-only provider or id fails closed to unknown/unknown", () => {
	assert.deepEqual(normalizeRuntimeModel("   ", "gpt-5.6"), { provider: "unknown", id: "unknown" });
	assert.deepEqual(normalizeRuntimeModel("openai", "   "), { provider: "unknown", id: "unknown" });
});

test("literal unknown/unknown passes through without pattern matching", () => {
	assert.deepEqual(normalizeRuntimeModel("unknown", "unknown"), { provider: "unknown", id: "unknown" });
	assert.deepEqual(normalizeRuntimeModel("Unknown", "UNKNOWN"), { provider: "unknown", id: "unknown" });
});

test("literal custom/custom passes through", () => {
	assert.deepEqual(normalizeRuntimeModel("custom", "custom"), { provider: "custom", id: "custom" });
});

test("surrounding whitespace is trimmed before matching", () => {
	assert.deepEqual(normalizeRuntimeModel("  nan  ", "  deepseek-v4-flash  "), { provider: "nan", id: "deepseek-v4-flash" });
});

// The mirrored pattern is unambiguous (every suffix group starts with a
// mandatory separator), so a long alphanumeric run followed by an invalid
// character cannot trigger catastrophic backtracking in V8. The bound below
// is generous on purpose: it catches an exponential regression, not jitter.
test("a pathological 64-character id is rejected in linear time", () => {
	const ids = [`gpt${"a".repeat(60)}!`, `glm${"5".repeat(60)}/`, `deepseek${"x".repeat(55)}-`];
	const started = performance.now();
	for (let round = 0; round < 50; round++) for (const id of ids) {
		assert.deepEqual(normalizeRuntimeModel("nan", id), { provider: "custom", id: "custom" });
	}
	assert.ok(performance.now() - started < 500, "normalizer must not backtrack catastrophically");
});

test("attached run then separated groups stays public", () => {
	assert.deepEqual(normalizeRuntimeModel("nan", "glm5.3-flash:thinking"), { provider: "nan", id: "glm5.3-flash:thinking" });
	assert.deepEqual(normalizeRuntimeModel("nan", "gpt-1-2-3-4-5-6-7-8-9"), { provider: "custom", id: "custom" });
});
