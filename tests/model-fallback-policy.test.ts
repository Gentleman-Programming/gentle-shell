import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_ERROR_CATEGORY as C } from "../lib/agents-protocol.ts";
import { COOLDOWN_MS, ModelCooldown, pickModel, sharedCooldown, shouldFallBack, syncUsageCooldown } from "../lib/model-fallback-policy.ts";

test("only quota, auth and spent transient errors move a run to its next model", () => {
	for (const category of [C.QUOTA, C.AUTH, C.RATE_LIMIT, C.PROVIDER_UNAVAILABLE, C.TIMEOUT, C.NETWORK]) assert.equal(shouldFallBack(category), true, category);
	for (const category of [C.CONTEXT_LENGTH, C.INVALID_REQUEST, C.UNAVAILABLE, undefined]) assert.equal(shouldFallBack(category), false, String(category));
});

test("a model that ran out cools down for every agent; exhausted limits wait longer than transient ones", () => {
	const cooldown = new ModelCooldown();
	cooldown.mark("anthropic/opus", C.QUOTA, 1_000);
	cooldown.mark("openai/gpt", C.RATE_LIMIT, 1_000);
	assert.equal(cooldown.available("anthropic/opus", 1_000 + COOLDOWN_MS.exhausted - 1), false);
	assert.equal(cooldown.available("anthropic/opus", 1_000 + COOLDOWN_MS.exhausted), true);
	assert.equal(cooldown.available("openai/gpt", 1_000 + COOLDOWN_MS.transient), true);
	assert.ok(COOLDOWN_MS.exhausted > COOLDOWN_MS.transient);
	assert.equal(cooldown.available("never/marked", 0), true);
	cooldown.mark("anthropic/opus", C.CONTEXT_LENGTH, 99_999_999);
	assert.equal(cooldown.available("anthropic/opus", 1_000 + COOLDOWN_MS.exhausted), true, "errors that never fall back never cool a model down");
	assert.equal(sharedCooldown(), sharedCooldown(), "one registry per process, shared by the shell and the agents");
});

test("pickModel keeps the primary while it works, then walks the chain skipping tried and cooled models", () => {
	const cooldown = new ModelCooldown();
	const chain = [{ model: "openai/gpt-5.5", thinking: "high" as const }, { model: "qwen/qwen3.8" }];
	assert.deepEqual(pickModel("anthropic/opus", chain, { cooldown, now: 0 }), { model: "anthropic/opus", fallback: false });
	cooldown.mark("anthropic/opus", C.QUOTA, 0);
	assert.deepEqual(pickModel("anthropic/opus", chain, { cooldown, now: 1 }), { model: "openai/gpt-5.5", thinking: "high", fallback: true }, "a cooled primary starts on the first fallback");
	assert.deepEqual(pickModel("anthropic/opus", chain, { cooldown, now: 1, tried: new Set(["openai/gpt-5.5"]) }), { model: "qwen/qwen3.8", fallback: true });
	cooldown.mark("qwen/qwen3.8", C.NETWORK, 1);
	assert.equal(pickModel("anthropic/opus", chain, { cooldown, now: 2, tried: new Set(["openai/gpt-5.5"]) }), undefined, "nothing left");
	assert.deepEqual(pickModel(undefined, chain, { cooldown: new ModelCooldown(), now: 0 }), { model: undefined, fallback: false }, "an inheriting agent keeps inheriting while it works");
	assert.deepEqual(pickModel("anthropic/opus", chain, { cooldown: new ModelCooldown(), now: 0, tried: new Set(["anthropic/opus"]) }), { model: "openai/gpt-5.5", thinking: "high", fallback: true }, "a primary that just failed is tried");
});

test("a full /gentle:usage window cools a whole provider until it resets, and a later fetch with room releases it", () => {
	const cooldown = new ModelCooldown();
	const window = (usedPercent: number, resetAt: number | null) => ({ label: "5h", usedPercent, windowSeconds: 18_000, resetAt });
	syncUsageCooldown({ provider: "anthropic", limits: [{ name: "plan", limitReached: false, windows: [window(100, 50_000), window(40, 90_000)] }] }, cooldown, 1_000);
	assert.equal(cooldown.available("anthropic/claude-opus-5-5", 49_999), false, "every model of the provider waits");
	assert.equal(cooldown.reason("anthropic/claude-sonnet-5-5", 2_000), C.QUOTA);
	assert.equal(cooldown.available("anthropic/claude-opus-5-5", 50_000), true, "until the full window resets");
	assert.equal(cooldown.available("openai/gpt-5.5", 2_000), true, "other providers are untouched");
	syncUsageCooldown({ provider: "openai", limits: [{ name: "plan", limitReached: true, windows: [window(80, null)] }] }, cooldown, 1_000);
	assert.equal(cooldown.available("openai/gpt-5.5", 1_000 + COOLDOWN_MS.exhausted - 1), false, "a reached limit without a reset time waits the usual time");
	syncUsageCooldown({ provider: "openai", limits: [{ name: "plan", limitReached: false, windows: [window(10, null)] }] }, cooldown, 2_000);
	assert.equal(cooldown.available("openai/gpt-5.5", 2_000), true, "room again releases the provider");
	cooldown.mark("openai/gpt-5.5", C.QUOTA, 2_000);
	syncUsageCooldown({ provider: "openai", limits: [] }, cooldown, 3_000);
	assert.equal(cooldown.available("openai/gpt-5.5", 3_000), false, "usage never clears a model's own failure");
});
