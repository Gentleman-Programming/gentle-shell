import assert from "node:assert/strict";
import test from "node:test";
import { TERMINAL_ERROR_CATEGORY as C } from "../lib/agents-protocol.ts";
import { COOLDOWN_MS, ModelCooldown, pickModel, sharedCooldown, shouldFallBack } from "../lib/model-fallback-policy.ts";

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
