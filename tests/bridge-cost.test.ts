import assert from "node:assert/strict";
import test from "node:test";
import { priceBridgeMessage } from "../lib/bridge-cost.ts";

const OPUS = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const bridgeMessage = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5",
	usage: { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 200_000, totalTokens: 3_300_000, cost: zeroCost() },
	...overrides,
});
const catalog = (provider: string, id: string) => (provider === "anthropic" && id === "claude-opus-5-5" ? OPUS : undefined);

test("priceBridgeMessage prices a zero-cost claude-bridge message at the Anthropic list price", () => {
	const message = bridgeMessage();
	const priced = priceBridgeMessage(message, catalog);
	assert.ok(priced);
	// 1M input * $4 + 100k output * $20 + 2M cache read * $0.2 + 200k cache write * $5
	assert.deepEqual(priced.usage.cost, { input: 4, output: 2, cacheRead: 0.4, cacheWrite: 1, total: 7.4, totalFromProvider: false }, "a catalog estimate, not a provider-billed total");
	assert.equal(priced.usage.totalTokens, 3_300_000, "token counts stay as the bridge reported them");
	assert.equal(message.usage.cost.total, 0, "the original message is not mutated");
});

test("priceBridgeMessage leaves messages it must not price untouched", () => {
	assert.equal(priceBridgeMessage(bridgeMessage({ provider: "anthropic" }), catalog), undefined, "other providers price themselves");
	assert.equal(priceBridgeMessage(bridgeMessage({ role: "user" }), catalog), undefined);
	assert.equal(priceBridgeMessage(bridgeMessage({ model: "claude-unknown" }), catalog), undefined, "no catalog price, no guess");
	const alreadyPriced = bridgeMessage();
	alreadyPriced.usage.cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
	assert.equal(priceBridgeMessage(alreadyPriced, catalog), undefined, "a bridge that reports cost wins");
	assert.equal(priceBridgeMessage(bridgeMessage({ usage: undefined }), catalog), undefined);
});
