import assert from "node:assert/strict";
import test from "node:test";
import { capReport, DEFAULT_REPORT_MAX_BYTES, isStrictJsonAgent, REPORT_TAIL_BYTES, utf8Head, utf8Tail, withReportCap } from "../lib/agents-report-cap.ts";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const validUtf8 = (value: string) => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "utf8")) === value;

test("the default report cap is 16,384 bytes", () => {
	assert.equal(DEFAULT_REPORT_MAX_BYTES, 16_384);
});

test("a report at the cap or one byte under is returned unchanged", () => {
	for (const size of [100, 99]) {
		const report = "x".repeat(size);
		const capped = capReport(report, 100, "t1");
		assert.equal(capped.text, report);
		assert.equal(capped.truncated, false);
		assert.deepEqual(withReportCap({ gentleAgents: { taskId: "t1" } }, capped), { gentleAgents: { taskId: "t1" } });
	}
});

const notice = (first: number, last: number, full: number, id: string) => `Report truncated: the first ${first} and the last ${last} of ${full} bytes were delivered. Call subagent_result with task_id ${id} for the full text.`;

test("a report over the cap keeps its head, cut at a line boundary near the cap, then the truncation line, then the end of the report", () => {
	const report = `${"a".repeat(900)}\n${"b".repeat(3000)}`;
	const capped = capReport(report, 1000, "t9");
	assert.equal(capped.text, `${"a".repeat(900)}\n\n${notice(900, 2048, 3901, "t9")}\n\n${"b".repeat(2048)}`);
	assert.deepEqual([capped.truncated, capped.reportBytes, capped.deliveredBytes], [true, 3901, 2948]);
	assert.deepEqual(withReportCap({ gentleAgents: { taskId: "t9", status: "completed" } }, capped), { gentleAgents: { taskId: "t9", status: "completed", reportTruncated: true, reportBytes: 3901, reportDeliveredBytes: 2948 } });
	// A line break farther back than the window (a quarter of the cap, at most 512 bytes) is not used: the cut stays at the cap.
	const far = capReport(`${"a".repeat(400)}\n${"b".repeat(3000)}`, 1000, "t9");
	assert.equal(far.text, `${"a".repeat(400)}\n${"b".repeat(599)}\n\n${notice(1000, 2048, 3401, "t9")}\n\n${"b".repeat(2048)}`);
});

test("head and tail state exact sizes, start and end at line boundaries, and never overlap", () => {
	const report = "row\n".repeat(2000); // 8,000 bytes
	const capped = capReport(report, 1000, "t4");
	const head = `${"row\n".repeat(249)}row`; // 999 bytes: back to the last line break inside the cap
	const tail = "row\n".repeat(511); // 2,044 bytes: after the first line break of the last 2,048
	assert.equal(capped.text, `${head}\n\n${notice(999, 2044, 8000, "t4")}\n\n${tail}`);
	assert.equal(capped.deliveredBytes, 999 + 2044);
	assert.ok(report.startsWith(head) && report.endsWith(tail) && bytes(head) + bytes(tail) < bytes(report));
});

test("a report whose part after the head fits the tail allowance is delivered whole", () => {
	const fits = `${"a".repeat(1000)}${"b".repeat(REPORT_TAIL_BYTES)}`;
	const whole = capReport(fits, 1000, "t3");
	assert.deepEqual([whole.text, whole.truncated, whole.deliveredBytes], [fits, false, 3048]);
	assert.deepEqual(withReportCap({ gentleAgents: { taskId: "t3" } }, whole), { gentleAgents: { taskId: "t3" } });
	const over = capReport(`${fits}b`, 1000, "t3");
	assert.equal(over.text, `${"a".repeat(1000)}\n\n${notice(1000, 2048, 3049, "t3")}\n\n${"b".repeat(2048)}`);
});

test("a closing block at the end of a long report arrives after the truncation line", () => {
	const closing = ["## Summary", "", "- One fact.", "- Two facts."].join("\n");
	const report = `status: completed\n${"row\n".repeat(1000)}${closing}`;
	const capped = capReport(report, 200, "t3");
	assert.ok(capped.truncated);
	assert.ok(capped.text.endsWith(`\n${closing}`));
	assert.ok(capped.deliveredBytes <= 200 + REPORT_TAIL_BYTES);
});

test("a multi-byte character or surrogate pair straddling either cut is never split", () => {
	for (const char of ["é", "€", "😀"]) {
		const report = `${"a".repeat(99)}${char}${"z".repeat(3000)}${char}${"y".repeat(2047)}`;
		const capped = capReport(report, 100, "t2");
		assert.ok(validUtf8(capped.text), `valid UTF-8 around ${char}`);
		assert.equal(capped.text, `${"a".repeat(99)}\n\n${notice(99, 2047, bytes(report), "t2")}\n\n${"y".repeat(2047)}`);
		assert.equal(utf8Head(`a${char}`, 1 + bytes(char) - 1), "a");
		assert.equal(utf8Tail(`${char}a`, 1 + bytes(char) - 1), "a");
		assert.equal(utf8Tail(`${char}a`, 1 + bytes(char)), `${char}a`);
	}
	assert.equal(utf8Tail("a\ud83d", 3), "\ud83d", "a lone surrogate counts as the 3 bytes TextEncoder writes");
});

test("a report with no line break is cut at code point boundaries at both ends", () => {
	const report = "é".repeat(5000); // 10,000 bytes
	const capped = capReport(report, 1001, "t7");
	assert.equal(capped.text, `${"é".repeat(500)}\n\n${notice(1000, 2048, 10_000, "t7")}\n\n${"é".repeat(1024)}`);
	assert.ok(validUtf8(capped.text));
});

test("a 1 MiB report delivers the default head and a 2,048-byte tail", () => {
	const report = "é".repeat(1 << 19); // 1,048,576 bytes
	const capped = capReport(report, DEFAULT_REPORT_MAX_BYTES, "big");
	assert.equal(capped.text, `${"é".repeat(8192)}\n\n${notice(16_384, 2048, 1 << 20, "big")}\n\n${"é".repeat(1024)}`);
	assert.deepEqual([capped.reportBytes, capped.deliveredBytes], [1 << 20, 16_384 + 2048]);
	const lines = capReport("line of text\n".repeat(90_000), DEFAULT_REPORT_MAX_BYTES, "big");
	assert.ok(validUtf8(lines.text) && bytes(lines.text) < 16_384 + 2048 + 200);
});

test("a small cap keeps its head: the line-break window is at most a quarter of the cap", () => {
	const early = `ab\n${"c".repeat(5000)}`;
	assert.ok(capReport(early, 64, "t8").text.startsWith(`ab\n${"c".repeat(61)}\n\n${notice(64, 2048, 5003, "t8")}`));
	const late = `${"a".repeat(60)}\n${"c".repeat(5000)}`;
	assert.ok(capReport(late, 64, "t8").text.startsWith(`${"a".repeat(60)}\n\n${notice(60, 2048, 5061, "t8")}`), "a break within 16 bytes of a 64-byte cut is used");
	assert.ok(capReport(`a\n${"c".repeat(5000)}`, 1, "t8").text.startsWith(`a\n\n${notice(1, 2048, 5002, "t8")}`));
	assert.ok(capReport(`\n${"c".repeat(5000)}`, 1, "t8").text.startsWith(`\n\n\n${notice(1, 2048, 5001, "t8")}`), "a 1-byte cap never backs up to an empty head");
});

test("the tail starts after a line break only inside its opening 512 bytes", () => {
	const near = `${"x".repeat(5000)}${"y".repeat(500)}\n${"z".repeat(1547)}`;
	assert.ok(capReport(near, 1000, "t9").text.endsWith(`of 7048 bytes were delivered. Call subagent_result with task_id t9 for the full text.\n\n${"z".repeat(1547)}`));
	const far = `${"x".repeat(5000)}${"y".repeat(600)}\n${"z".repeat(1447)}`;
	assert.ok(capReport(far, 1000, "t9").text.endsWith(`full text.\n\n${"y".repeat(600)}\n${"z".repeat(1447)}`));
});

// Verifier blocker 4: a strict-JSON report reaches the parent whole, or it would arrive as invalid JSON plus a notice.
test("strict-JSON agents and single JSON documents are never truncated; prose keeps the cap", () => {
	const json = JSON.stringify({ findings: Array.from({ length: 200 }, (_, at) => ({ id: at, text: "finding text" })) });
	assert.ok(bytes(json) > 1000);
	for (const agent of ["jd-judge-a", "jd-judge-b", "review-risk", "review-readability"]) {
		assert.equal(isStrictJsonAgent(agent), true, agent);
		const capped = capReport(`not json ${"x".repeat(4000)}`, 1000, "t5", agent);
		assert.equal(capped.truncated, false, agent);
	}
	for (const agent of ["explore", "gentle-ai-worker", "reviewer", "judge"]) assert.equal(isStrictJsonAgent(agent), false, agent);
	for (const report of [json, `\n${json}\n`, `\`\`\`json\n${json}\n\`\`\``, JSON.stringify([json])]) {
		const capped = capReport(report, 1000, "t5", "explore");
		assert.equal(capped.text, report);
		assert.equal(capped.truncated, false);
	}
	for (const report of [`${json} trailing prose`, `Summary:\n${json}`, `${json}\n${json}`, `"${"s".repeat(4000)}"`]) {
		assert.equal(capReport(report, 1000, "t5", "explore").truncated, true, report.slice(0, 40));
	}
});
