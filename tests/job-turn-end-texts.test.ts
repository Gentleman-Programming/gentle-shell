import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const agents = readFileSync(new URL("../extensions/gentle-agents.ts", import.meta.url), "utf8");

// turn-end-coherence S4: a blocked standalone sleep is not an instruction to end the turn.
test("the standalone-sleep rejection sends the agent to independent work before waiting", () => {
	const reason = agents.match(/Standalone sleep is blocked while background work is active[^`]*/)?.[0];
	assert.ok(reason, "the rejection reason is present");
	assert.ok(!reason.includes("End the turn now"), "ending the turn is not the first instruction");
	assert.ok(reason.includes("Continue independent in-scope work; end the turn to wait only when none remains."));
	assert.ok(reason.includes("Each completion arrives automatically as a session message and starts a new turn."));
});
