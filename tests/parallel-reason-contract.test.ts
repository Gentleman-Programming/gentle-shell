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

test("T29: the core parallelism reason requires launching the units together in background", () => {
	const rule = core.split("\n").find((line) => line.includes("5. **Writer rule**"));
	assert.ok(rule, "core Writer rule is missing");
	assert.ok(
		rule.includes("launched together in background, else inline"),
		"parallelism must require background launches in the same turn",
	);
});
