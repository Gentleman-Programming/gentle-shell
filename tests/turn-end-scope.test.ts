import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { jobNoticeText } from "../lib/background-jobs-tools.ts";
import type { JobRecord } from "../lib/background-jobs.ts";

// turn-end-coherence S1, S3, S4: regressions found by the independent verification of 8c4f86f57..9f41dfa7b.
const stopped: JobRecord = {
	id: "job-1", kind: "command", status: "stopped", label: "Export",
	command: "make export", cwd: "/fixture", ownerSessionId: "user-session",
	outputPath: "/fixture/job-1.log", startedAt: 0, tail: [],
};

test("S1/S4: a user-stopped export is not a successful completion or an instruction to resume depending work", () => {
	const notice = jobNoticeText(stopped);
	assert.match(notice, /was stopped by the user/);
	const instruction = notice.split("\n").at(-1)!;
	assert.match(instruction, /(?:continue|resume)\b[^.\n]*\bindependent\b/i);
	assert.doesNotMatch(instruction, /continue the authorized work that depended on this job/i);
});

for (const mode of ["organic", "full-delegation"] as const) {
	test(`S3/S11: ${mode} parent recovery is worker-local and distinct from proof or native review`, () => {
		const prompt = __testing.buildGentlePrompt("gentleman", process.cwd(), ["read"], undefined, "tui", mode);
		const recovery = prompt.split("\n\n").find(block => /ends (?:that )?(?:the )?worker's cycle, not the unit/i.test(block));
		assert.ok(recovery);
		assert.match(recovery, /\bworker-local cause recurring after a real fix without a new hypothesis\b/i);
		assert.match(recovery, /partial worker execution[^.]*not[^.]*exhausted proof or a terminal native review outcome/i);
	});
}

test("S1: the standalone sleep docs describe continuation before a wait", () => {
	const guide = readFileSync(new URL("../docs/gentle-shell.md", import.meta.url), "utf8");
	const sleep = guide.split("\n").find(line => line.includes("a `bash` call that only sleeps"));
	assert.ok(sleep);
	assert.match(sleep, /(?:continue|continuing)\b[^.\n]*\bindependent\b/i);
	assert.doesNotMatch(sleep, /refused with a message to end the turn/i);
});
