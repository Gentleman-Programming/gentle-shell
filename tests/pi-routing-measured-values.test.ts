import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CONTEXT_BACKSTOP_FRACTION, CONTEXT_BACKSTOP_TOKENS } from "../lib/context-backstop.ts";

// harness-continuity T11/S10 (retained verifier probe): the mirrored Pi routing names the values the Pi runtime
// actually measures, never the unmeasured "~5" other runtimes keep. Contract text only, not model adherence.
const ROOT = join(import.meta.dirname, "..");
const MIRROR = join(ROOT, "contracts", "review-provider-contract-mirror");
const routing = (): string => {
	const { contract_semver } = JSON.parse(readFileSync(join(MIRROR, "provider-contract.lock.json"), "utf8")) as { contract_semver: string };
	return readFileSync(join(MIRROR, `v${contract_semver}`, "bundle", "routing", "pi.md"), "utf8");
};

test("S10: Pi routing names the runtime's measured exploration and backstop values, never ~5", () => {
	const text = routing();
	assert.ok(text.includes("the runtime's exploration notice fires past 3 lookups or 40,000 output bytes"));
	assert.ok(!/approximately 5 sequential lookups/.test(text));
	assert.equal(CONTEXT_BACKSTOP_TOKENS, 150_000);
	assert.equal(CONTEXT_BACKSTOP_FRACTION, 0.15);
	assert.ok(text.includes("at the lower of approximately 150k parent-context tokens or 15% of the context window"));
	assert.ok(readFileSync(join(ROOT, "lib", "exploration-budget.ts"), "utf8").includes("request.lookups <= 3 && request.bytes <= 40_000"));
});
