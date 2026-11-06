import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { priceBridgeMessage } from "../lib/bridge-cost.ts";

const metadata = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "..", "package.json");
const version: string = JSON.parse(readFileSync(metadata, "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const [major, minor] = version.split(".").map(Number);
assert.ok(major >= 1, `Pi AI >=1.0.0 required, installed ${version}`);
const hasProviderTotal = major > 1 || (major === 1 && minor >= 5);

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
	const original = structuredClone(message);
	const priced = priceBridgeMessage(message, catalog);
	assert.ok(priced);
	// 1M input * $4 + 100k output * $20 + 2M cache read * $0.2 + 200k cache write * $5
	const cost = { input: 4, output: 2, cacheRead: 0.4, cacheWrite: 1, total: 7.4, ...(hasProviderTotal ? { totalFromProvider: false } : {}) };
	assert.deepEqual(priced.usage.cost, cost);
	assert.deepEqual(priced.usage, { ...original.usage, cost }, "all token counts stay as the bridge reported them");
	assert.deepEqual(message, original, "the original message is not mutated");
});

test("priceBridgeMessage leaves messages it must not price untouched", () => {
	const nonBridge = bridgeMessage({ provider: "anthropic" });
	const original = structuredClone(nonBridge);
	assert.equal(priceBridgeMessage(nonBridge, catalog), undefined, "other providers price themselves");
	assert.deepEqual(nonBridge, original, "other providers are not mutated");
	assert.equal(priceBridgeMessage(bridgeMessage({ role: "user" }), catalog), undefined);
	assert.equal(priceBridgeMessage(bridgeMessage({ model: "claude-unknown" }), catalog), undefined, "no catalog price, no guess");
	const alreadyPriced = bridgeMessage();
	alreadyPriced.usage.cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
	assert.equal(priceBridgeMessage(alreadyPriced, catalog), undefined, "a bridge that reports cost wins");
	assert.equal(priceBridgeMessage(bridgeMessage({ usage: undefined }), catalog), undefined);
});
