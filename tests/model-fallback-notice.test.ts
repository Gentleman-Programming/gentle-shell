import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TERMINAL_ERROR_CATEGORY as C } from "../lib/agents-protocol.ts";
import { fallbackNotice, MODEL_FALLBACK_ENTRY, profileFallbackChain } from "../lib/model-fallback-notice.ts";
import { emptyFallbacksFile, fallbacksFilePath, setChain, writeFallbacksFile } from "../lib/model-fallback-store.ts";

const prices: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
	"a/cheap": { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
	"b/pricey": { input: 5, output: 20, cacheRead: 0, cacheWrite: 0 },
};
const lookup = (model: { provider: string | undefined; id: string }) => prices[`${model.provider}/${model.id}`];

test("the notice names the agent, why it moved, where it went, and when that costs more", () => {
	assert.equal(MODEL_FALLBACK_ENTRY, "gentle-pi.model-fallback/v1");
	assert.equal(fallbackNotice({ agent: "explore", from: "a/cheap", to: "b/pricey", category: C.QUOTA }, lookup),
		"explore: a/cheap hit its usage limit; continuing on b/pricey (5.0x the price).");
	assert.equal(fallbackNotice({ agent: "orchestrator", from: "b/pricey", to: "a/cheap", category: C.RATE_LIMIT }, lookup),
		"orchestrator: b/pricey hit a rate limit; continuing on a/cheap.");
	assert.equal(fallbackNotice({ agent: "worker", from: "a/cheap", to: "x/unknown", category: C.NETWORK }, lookup),
		"worker: a/cheap hit a network error; continuing on x/unknown (price unknown).");
});

test("the chain comes from the launch's profile, else the active profile; a broken file gives none", () => {
	const home = mkdtempSync(join(tmpdir(), "fallback-notice-"));
	try {
		assert.deepEqual(profileFallbackChain(home, "work", "explore"), [], "no file, no chain");
		writeFallbacksFile(fallbacksFilePath(home), setChain(setChain(emptyFallbacksFile(), "work", "explore", [{ model: "b/pricey" }]), "home", "*", [{ model: "a/cheap" }]));
		assert.deepEqual(profileFallbackChain(home, "work", "explore"), [{ model: "b/pricey" }]);
		assert.deepEqual(profileFallbackChain(home, undefined, "explore"), [], "no profile and no active profile");
		writeFileSync(join(home, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active: "home", profiles: { home: {}, work: {} } }));
		assert.deepEqual(profileFallbackChain(home, undefined, "explore"), [{ model: "a/cheap" }], "the active profile when the launch names none");
		writeFileSync(fallbacksFilePath(home), "{ broken");
		assert.deepEqual(profileFallbackChain(home, "work", "explore"), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
