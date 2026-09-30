import assert from "node:assert/strict";
import test from "node:test";
import {
	billableEnabled,
	buildBillableReport,
	billableAmount,
	BILLABLE_PROVENANCE,
	BILLABLE_SCHEMA,
	defaultBillableRange,
	parseRounding,
	readBillableConfig,
	roundDurationMs,
	roundMoney,
	type BillableConfig,
	type BillableSessionInput,
} from "../lib/billable-hours.ts";

// I9: the billable-hours report. Rate, currency and rounding are configurable
// and boundary-tested; the same input and rate yield the same report; rounding
// never inflates beyond its policy; derived time is never presented as measured;
// and an unreported cost still bills its hours.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const BASE = Date.parse("2026-09-01T00:00:00.000Z");

const CONFIG: BillableConfig = { hourlyRate: 50, currency: "USD", rounding: { mode: "none" } };

const SESSION_A: BillableSessionInput = {
	sessionId: "s-a",
	project: "projA",
	startedAt: BASE,
	endedAt: BASE + 3 * HOUR,
	wallClockMs: 3 * HOUR,
	toolMs: 1 * HOUR,
	modelMs: 30 * MINUTE,
	idleMs: 90 * MINUTE,
	subagentMs: 20 * MINUTE,
	costNanoUsd: 500_000_000,
	costProvenance: "measured",
};

const SESSION_B: BillableSessionInput = {
	sessionId: "s-b",
	project: "projA",
	startedAt: BASE + 4 * HOUR,
	endedAt: BASE + 5.5 * HOUR,
	wallClockMs: 90 * MINUTE,
	toolMs: 40 * MINUTE,
	modelMs: 20 * MINUTE,
	idleMs: 30 * MINUTE,
	subagentMs: 0,
	costNanoUsd: 0,
	costProvenance: "partial",
};

test("parseRounding accepts the presets and fails closed on a bad policy", () => {
	assert.deepEqual(parseRounding(undefined), { mode: "none" });
	assert.deepEqual(parseRounding(""), { mode: "none" });
	assert.deepEqual(parseRounding("none"), { mode: "none" });
	assert.deepEqual(parseRounding("nearest-6"), { mode: "nearest", minutes: 6 });
	assert.deepEqual(parseRounding("nearest:15"), { mode: "nearest", minutes: 15 });
	assert.deepEqual(parseRounding("UP-30"), { mode: "up", minutes: 30 });
	// A malformed or non-positive policy must never inflate an invoice.
	for (const bad of ["garbage", "nearest-0", "up--1", "nearest", "round-15"]) assert.deepEqual(parseRounding(bad), { mode: "none" }, bad);
});

test("readBillableConfig reads the rate, currency and rounding with safe defaults", () => {
	assert.deepEqual(readBillableConfig({}), { hourlyRate: 0, currency: "USD", rounding: { mode: "none" } });
	assert.deepEqual(readBillableConfig({ GENTLE_BILLABLE_RATE: "50.5", GENTLE_BILLABLE_CURRENCY: "eur", GENTLE_BILLABLE_ROUNDING: "nearest-6" }), { hourlyRate: 50.5, currency: "EUR", rounding: { mode: "nearest", minutes: 6 } });
	assert.equal(readBillableConfig({ GENTLE_BILLABLE_RATE: "abc" }).hourlyRate, 0, "a bad rate is zero, never NaN");
	assert.equal(readBillableConfig({ GENTLE_BILLABLE_RATE: "-5" }).hourlyRate, 0, "a negative rate is refused");
});

test("rounding is boundary-tested and never inflates beyond its policy", () => {
	assert.equal(roundDurationMs(0, { mode: "up", minutes: 15 }), 0);
	assert.equal(roundDurationMs(90 * MINUTE, { mode: "nearest", minutes: 15 }), 90 * MINUTE, "already on the step");
	assert.equal(roundDurationMs(100 * MINUTE, { mode: "nearest", minutes: 15 }), 105 * MINUTE);
	assert.equal(roundDurationMs(100 * MINUTE, { mode: "up", minutes: 15 }), 105 * MINUTE);
	assert.equal(roundDurationMs(91 * MINUTE, { mode: "up", minutes: 15 }), 105 * MINUTE, "any excess rounds to the next step");
	assert.equal(roundDurationMs(7 * MINUTE, { mode: "up", minutes: 6 }), 12 * MINUTE);

	// Table-driven property over many durations: `up` stays under one step, `nearest` under half.
	for (const minutes of [6, 15, 30]) {
		const step = minutes * MINUTE;
		for (let ms = 0; ms <= 4 * HOUR; ms += 7 * MINUTE + 1) {
			const up = roundDurationMs(ms, { mode: "up", minutes });
			const nearest = roundDurationMs(ms, { mode: "nearest", minutes });
			assert.ok(up - ms < step && up >= ms, `up ${minutes}: ${ms} -> ${up}`);
			assert.ok(Math.abs(nearest - ms) <= step / 2, `nearest ${minutes}: ${ms} -> ${nearest}`);
			assert.equal(up % step, 0);
			assert.equal(nearest % step, 0);
		}
	}
});

test("the amount is per hour and per line, rounded to cents", () => {
	assert.equal(billableAmount(3 * HOUR, 50), 150);
	assert.equal(billableAmount(90 * MINUTE, 50), 75);
	assert.equal(billableAmount(HOUR / 3, 50), 16.67, "one third of an hour at 50 rounds to cents");
	assert.equal(billableAmount(3 * HOUR, 0), 0, "no rate, no amount");
	assert.equal(roundMoney(1.006), 1.01);
	assert.equal(roundMoney(1.004), 1);
});

test("the report is reproducible and rolls up per project and per session", () => {
	const range = { from: BASE, to: BASE + 24 * HOUR };
	const report = buildBillableReport([SESSION_A, SESSION_B], CONFIG, range, 0);
	assert.deepEqual(report, buildBillableReport([SESSION_A, SESSION_B], CONFIG, range, 0), "same input, same report");
	assert.equal(report.schema, BILLABLE_SCHEMA);
	assert.deepEqual(report.sessions.map((row) => row.sessionId), ["s-a", "s-b"]);
	assert.equal(report.sessions[0]!.billableMs, 3 * HOUR);
	assert.equal(report.sessions[0]!.amount, 150);
	assert.equal(report.sessions[1]!.amount, 75);
	assert.deepEqual(report.projects, [{ project: "projA", sessions: 2, wallClockMs: 4.5 * HOUR, billableMs: 4.5 * HOUR, amount: 225, costNanoUsd: 500_000_000, costProvenance: "partial" }]);
	assert.deepEqual(report.totals, { sessions: 2, wallClockMs: 4.5 * HOUR, billableMs: 4.5 * HOUR, amount: 225, costNanoUsd: 500_000_000, costProvenance: "partial" });
});

test("an unreported cost still bills its hours, with the cost marked partial", () => {
	const report = buildBillableReport([SESSION_B], CONFIG, { from: null, to: null }, 0);
	assert.equal(report.totals.costProvenance, "partial", "the cost is partial");
	assert.equal(report.totals.billableMs, 90 * MINUTE, "the hours are unaffected by the missing cost");
	assert.equal(report.totals.amount, 75);
});

test("rounding is applied per session and the total never inflates beyond the policy", () => {
	const report = buildBillableReport([SESSION_A, SESSION_B], { ...CONFIG, rounding: { mode: "up", minutes: 15 } }, { from: null, to: null }, 0);
	assert.equal(report.sessions[0]!.billableMs, 3 * HOUR, "3h is already on the step");
	assert.equal(report.sessions[1]!.billableMs, 90 * MINUTE);
	assert.equal(report.totals.billableMs, 4.5 * HOUR);
	assert.ok(report.totals.billableMs - report.totals.wallClockMs < 2 * 15 * MINUTE, "two lines, at most one step each");
});

test("the report states which time is measured and which is derived", () => {
	const report = buildBillableReport([SESSION_A], CONFIG, { from: null, to: null }, 0);
	assert.equal(report.provenance, BILLABLE_PROVENANCE);
	assert.match(report.provenance.measured, /wall-clock/);
	assert.match(report.provenance.derived, /timestamp pairing/);
	assert.match(report.provenance.estimated, /idle/);
});

test("the billable feature is opt-in", () => {
	assert.equal(billableEnabled({}), false, "off by default: not everyone bills hours");
	assert.equal(billableEnabled({ GENTLE_BILLABLE: "1" }), true);
	assert.equal(billableEnabled({ GENTLE_BILLABLE: "0" }), false);
	assert.equal(billableEnabled({ GENTLE_BILLABLE_RATE: "45" }), true, "a configured rate enables it");
	assert.equal(billableEnabled({ GENTLE_BILLABLE: "0", GENTLE_BILLABLE_RATE: "45" }), false, "an explicit off wins over the rate");
	assert.equal(billableEnabled({ GENTLE_BILLABLE_RATE: "  " }), false, "a blank rate does not enable it");
});

test("defaultBillableRange spans the requested days up to now", () => {
	assert.deepEqual(defaultBillableRange(BASE, 7), { from: BASE - 7 * 24 * HOUR, to: BASE });
	assert.deepEqual(defaultBillableRange(BASE, 0), { from: BASE, to: BASE });
});
