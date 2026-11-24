import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jobNoticeText } from "../lib/background-jobs-tools.ts";
import type { JobRecord } from "../lib/background-jobs.ts";

const agents = readFileSync(new URL("../extensions/gentle-agents.ts", import.meta.url), "utf8");

const job = (overrides: Partial<JobRecord>): JobRecord => ({
	id: "job-1", kind: "command", label: "export", command: "make export", status: "exited", exitCode: 0,
	cwd: "/tmp", ownerSessionId: "s", startedAt: 0, endedAt: 1000, tail: [], outputPath: "/tmp/job-1.log", ...overrides,
} as unknown as JobRecord);
const lastLine = (record: JobRecord) => jobNoticeText(record).split("\n").at(-1);

// turn-end-coherence S1: each job outcome is an obstacle, a limit or a plain result, never the same instruction.
test("a job the user stopped is reported as a limit: no restart, only independent work continues", () => {
	const line = lastLine(job({ status: "stopped", exitCode: null }));
	assert.equal(line, "The user stopped this job: that is an explicit limit on it. Do not restart it; continue only independent authorized work.");
	assert.match(jobNoticeText(job({ status: "stopped", exitCode: null })), /was stopped by the user/);
});

test("a failed job stays an obstacle and a successful one a result to continue from", () => {
	assert.match(lastLine(job({ exitCode: 7 }))!, /^This failure is an obstacle, not the end of the task:/);
	assert.match(lastLine(job({ status: "failed", exitCode: null, error: "spawn failed" } as Partial<JobRecord>))!, /^This failure is an obstacle/);
	assert.equal(lastLine(job({})), "This result does not end the task: read it and continue the authorized work that depended on this job.");
});

// turn-end-coherence S4: a blocked standalone sleep is not an instruction to end the turn.
test("the standalone-sleep rejection sends the agent to independent work before waiting", () => {
	const reason = agents.match(/Standalone sleep is blocked while background work is active[^`]*/)?.[0];
	assert.ok(reason, "the rejection reason is present");
	assert.ok(!reason.includes("End the turn now"), "ending the turn is not the first instruction");
	assert.ok(reason.includes("Continue independent in-scope work; end the turn to wait only when none remains."));
	assert.ok(reason.includes("Each completion arrives automatically as a session message and starts a new turn."));
});
