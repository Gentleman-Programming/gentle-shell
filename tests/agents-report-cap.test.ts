import assert from "node:assert/strict";
import test from "node:test";
import { capReport, DEFAULT_REPORT_MAX_BYTES, isStrictJsonAgent, utf8Head, withReportCap } from "../lib/agents-report-cap.ts";

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

test("a report over the cap keeps its head, cut at a line boundary in the last 512 bytes, then states sizes and the route", () => {
	const report = `${"a".repeat(900)}\n${"b".repeat(300)}`;
	const capped = capReport(report, 1000, "t9");
	assert.equal(capped.text, `${"a".repeat(900)}\n\nReport truncated: the first 900 of 1201 bytes were delivered. Call subagent_result with task_id t9 for the full text.`);
	assert.deepEqual([capped.truncated, capped.reportBytes, capped.deliveredBytes], [true, 1201, 900]);
	assert.deepEqual(withReportCap({ gentleAgents: { taskId: "t9", status: "completed" } }, capped), { gentleAgents: { taskId: "t9", status: "completed", reportTruncated: true, reportBytes: 1201, reportDeliveredBytes: 900 } });
	// A line break farther than 512 bytes back is not used: the cut stays at the cap.
	const far = capReport(`${"a".repeat(400)}\n${"b".repeat(700)}`, 1000, "t9");
	assert.equal(far.deliveredBytes, 1000);
	assert.ok(far.text.startsWith(`${"a".repeat(400)}\n${"b".repeat(599)}\n\nReport truncated: the first 1000 of 1101 bytes`));
});

test("a multi-byte character or surrogate pair straddling the cap is never split", () => {
	for (const char of ["é", "€", "😀"]) {
		const report = `${"a".repeat(99)}${char}${"z".repeat(50)}`;
		const capped = capReport(report, 100, "t2");
		assert.ok(validUtf8(capped.text), `valid UTF-8 around ${char}`);
		assert.equal(capped.deliveredBytes, 99);
		const notice = capped.text.slice(capped.text.indexOf("\n\nReport truncated"));
		assert.ok(bytes(capped.text) <= 100 + bytes(notice));
		assert.equal(utf8Head(`a${char}`, 1 + bytes(char) - 1), "a");
	}
});

test("a closing Key Learnings block within 2,048 bytes is delivered whole after the truncation line", () => {
	const learnings = "## Key Learnings\n\n- One fact.\n- Two facts.";
	const report = `status: completed\n${"row\n".repeat(400)}${learnings}`;
	const capped = capReport(report, 200, "t3");
	assert.ok(capped.truncated);
	assert.ok(capped.text.endsWith(`Call subagent_result with task_id t3 for the full text.\n\n${learnings}`));
	assert.match(capped.text, /the first \d+ of \d+ bytes were delivered, followed by its closing ## Key Learnings block\./);
	assert.ok(capped.deliveredBytes <= 200);
	// Too large for the allowance: no special case.
	const big = `${"row\n".repeat(400)}## Key Learnings\n\n${"x".repeat(2100)}`;
	assert.doesNotMatch(capReport(big, 200, "t3").text, /Key Learnings block/);
	// The body fits and the block fits its allowance: nothing is lost, nothing is marked.
	const small = `short body\n${learnings}`;
	assert.equal(capReport(small, 20, "t3").text, small);
});

// Verifier blocker 4: a strict-JSON report reaches the parent whole, or it would arrive as invalid JSON plus a notice.
test("strict-JSON agents and single JSON documents are never truncated; prose keeps the cap", () => {
	const json = JSON.stringify({ findings: Array.from({ length: 200 }, (_, at) => ({ id: at, text: "finding text" })) });
	assert.ok(bytes(json) > 1000);
	for (const agent of ["jd-judge-a", "jd-judge-b", "review-risk", "review-readability"]) {
		assert.equal(isStrictJsonAgent(agent), true, agent);
		const capped = capReport(`not json ${"x".repeat(2000)}`, 1000, "t5", agent);
		assert.equal(capped.truncated, false, agent);
	}
	for (const agent of ["explore", "gentle-ai-worker", "reviewer", "judge"]) assert.equal(isStrictJsonAgent(agent), false, agent);
	for (const report of [json, `\n${json}\n`, `\`\`\`json\n${json}\n\`\`\``, JSON.stringify([json])]) {
		const capped = capReport(report, 1000, "t5", "explore");
		assert.equal(capped.text, report);
		assert.equal(capped.truncated, false);
	}
	for (const report of [`${json} trailing prose`, `Summary:\n${json}`, `${json}\n${json}`, `"${"s".repeat(2000)}"`]) {
		assert.equal(capReport(report, 1000, "t5", "explore").truncated, true, report.slice(0, 40));
	}
});

test("a Key Learnings heading inside a code fence is not the closing block", () => {
	const report = `${"row\n".repeat(400)}\`\`\`md\n## Key Learnings\n- inside a fence\n\`\`\`\nend`;
	assert.doesNotMatch(capReport(report, 200, "t6").text, /Key Learnings block/);
	const real = `${"row\n".repeat(400)}\`\`\`md\n## Key Learnings\n\`\`\`\n## Key Learnings\n\n- real`;
	assert.ok(capReport(real, 200, "t6").text.endsWith("## Key Learnings\n\n- real"));
});
