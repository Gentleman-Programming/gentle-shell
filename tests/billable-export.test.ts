import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildBillableReport, type BillableConfig, type BillableSessionInput } from "../lib/billable-hours.ts";
import { exportBillableCsv, exportBillableJson, exportBillableMarkdown } from "../lib/session-export.ts";

// I9: the billable report through the I7 renderers, golden-asserted and stable.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const BASE = Date.parse("2026-09-01T00:00:00.000Z");

const CONFIG: BillableConfig = { hourlyRate: 50, currency: "USD", rounding: { mode: "nearest", minutes: 6 } };

const SESSIONS: readonly BillableSessionInput[] = [
	{ sessionId: "01a0ed23", project: "gentle-shell", startedAt: BASE, endedAt: BASE + 3 * HOUR, wallClockMs: 3 * HOUR, toolMs: 1 * HOUR, modelMs: 30 * MINUTE, idleMs: 90 * MINUTE, subagentMs: 20 * MINUTE, costNanoUsd: 500_000_000, costProvenance: "measured" },
	{ sessionId: "01a0ed55", project: "gentle-shell", startedAt: BASE + 4 * HOUR, endedAt: BASE + 5.5 * HOUR, wallClockMs: 90 * MINUTE, toolMs: 40 * MINUTE, modelMs: 20 * MINUTE, idleMs: 30 * MINUTE, subagentMs: 0, costNanoUsd: 0, costProvenance: "partial" },
];

const REPORT = buildBillableReport(SESSIONS, CONFIG, { from: BASE, to: BASE + 24 * HOUR }, 0);

function golden(name: string): string {
	return readFileSync(fileURLToPath(new URL(`./fixtures/billable/${name}`, import.meta.url)), "utf8");
}

test("the billable markdown matches its golden file", () => {
	assert.equal(exportBillableMarkdown(REPORT), golden("report.md"));
});

test("the billable csv matches its golden file", () => {
	assert.equal(exportBillableCsv(REPORT), golden("report.csv"));
});

test("the billable json matches its golden file", () => {
	assert.equal(exportBillableJson(REPORT), golden("report.json"));
});

test("the report is deterministic and the export carries the provenance statement", () => {
	assert.equal(exportBillableMarkdown(REPORT), exportBillableMarkdown(REPORT));
	const markdown = exportBillableMarkdown(REPORT);
	assert.match(markdown, /measured: session and subagent wall-clock boundaries/);
	assert.match(markdown, /derived: per-tool duration and model latency/);
	assert.match(markdown, /estimated: idle is an estimate/);
	assert.match(markdown, /225\.00 USD/, "the amount is the sum of the billed lines");
	assert.match(markdown, /\(partial\)/, "an unreported cost is marked partial, not hidden");
	assert.match(exportBillableCsv(REPORT), /api_cost_provenance/);
	const parsed = JSON.parse(exportBillableJson(REPORT)) as { schema: string; totals: { amount: number } };
	assert.equal(parsed.schema, "gentle-shell.billable-hours/v1");
	assert.equal(parsed.totals.amount, 225);
});

test("no prompt, response or path reaches a billable artifact", () => {
	const withPrivate = { ...REPORT, prompt: "SECRET_PROMPT", response: "SECRET_RESPONSE", path: "/secret/path.ts" } as unknown as typeof REPORT;
	for (const artifact of [exportBillableMarkdown(withPrivate), exportBillableCsv(withPrivate), exportBillableJson(withPrivate)]) {
		for (const secret of ["SECRET_PROMPT", "SECRET_RESPONSE", "/secret/path.ts"]) {
			assert.equal(artifact.includes(secret), false, `no artifact may carry ${secret}`);
		}
	}
});
