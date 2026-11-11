import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// gentle-shell#1731 T29 (L66): in the targeted bench (B, pi --mode json,
// background policy off) the parallelism reason fired for two independent
// features, but the writers ran one after the other in task mode: no
// parallelism, only subagent overhead (x5 took 10.9 min vs 4.5 inline). The
// lazy writer module already voided serial launches, but it loads only after
// the core rule fires, so the condition must live in the core Writer rule.
const core = readFileSync(join(import.meta.dirname, "..", "assets/orchestrator.md"), "utf8");

// cost-speed-painpoints S15 P5a (verdict C8, user decision L41): the reason is launching the units together in
// one turn; background is how they run when background mode is on, never a condition of the reason.
test("T29: the core parallelism reason requires launching the units together in one turn", () => {
	const rule = core.split("\n").find((line) => line.includes("5. **Writer rule**"));
	assert.ok(rule, "core Writer rule is missing");
	assert.ok(
		rule.includes("launched together in one turn (in background when background mode is on), else inline"),
		"parallelism must require launches together in the same turn, else inline",
	);
	assert.ok(!rule.includes("launched together in background, else inline"), "background must not be the condition");
});
