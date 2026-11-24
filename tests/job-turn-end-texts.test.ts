import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { jobNoticeText, monitorStoppedText } from "../lib/background-jobs-tools.ts";
import type { JobRecord } from "../lib/background-jobs.ts";

const agents = readFileSync(new URL("../extensions/gentle-agents.ts", import.meta.url), "utf8");

const job = (overrides: Partial<JobRecord>): JobRecord => ({
	id: "job-1", kind: "command", label: "export", command: "make export", status: "exited", exitCode: 0,
	cwd: "/tmp", ownerSessionId: "s", startedAt: 0, endedAt: 1000, tail: [], outputPath: "/tmp/job-1.log", ...overrides,
});
const lastLine = (record: JobRecord) => jobNoticeText(record).split("\n").at(-1);

// TypeScript checks the fixture's fields; this structural check guards against bypassing that check.
test("the notice fixture does not bypass JobRecord checking with an assertion", () => {
	const fixture = readFileSync(import.meta.filename, "utf8").split(/^const job = |^const lastLine = /m)[1];
	assert.ok(fixture, "the JobRecord fixture is present");
	assert.doesNotMatch(fixture, /\bas\s+(?:unknown|JobRecord)\b/);
});

// turn-end-coherence S1: each job outcome is an obstacle, a limit or a plain result, never the same instruction.
test("a job the user stopped is reported as a limit: no restart, only independent work continues", () => {
	const line = lastLine(job({ status: "stopped", exitCode: null }));
	assert.equal(line, "The user stopped this job: that is an explicit limit on it. Do not restart it; continue only independent authorized work.");
	assert.match(jobNoticeText(job({ status: "stopped", exitCode: null })), /was stopped by the user/);
});

test("a failed job stays an obstacle and a successful one a result to continue from", () => {
	assert.match(lastLine(job({ exitCode: 7 }))!, /^This failure is an obstacle, not the end of the task:/);
	assert.match(lastLine(job({ status: "failed", exitCode: null, error: "spawn failed" }))!, /^This failure is an obstacle/);
	assert.equal(lastLine(job({})), "This result does not end the task: read it and continue the authorized work that depended on this job.");
});

test("a monitor deadline notice reports the configured limit and allows only necessary authorized watching", () => {
	const monitor = job({ kind: "monitor", label: "checks", status: "stopped", exitCode: null, timeoutSeconds: 30, events: 3 });
	assert.equal(monitorStoppedText(monitor, "timeout"),
		'Monitor job-1 ("checks") reached its 30s timeout after 3 events and ended. This is the limit you set with timeout_seconds, not a failure or a user stop. Start a new monitor only if watching is still needed for authorized work and other limits allow it.\nFull output: /tmp/job-1.log');
});

test("ordinary monitor exit and explicit user stop keep their distinct notices", () => {
	const monitor = job({ kind: "monitor", label: "checks", timeoutSeconds: 30, events: 1 });
	assert.match(jobNoticeText(monitor), /^Monitor job-1 \("checks"\) exited with code 0 after 1s, 1 event\./);
	assert.equal(lastLine(monitor), "This result does not end the task: read it and continue the authorized work that depended on this job.");
	const stopped = { ...monitor, status: "stopped" } as const;
	assert.match(jobNoticeText(stopped), /^Monitor job-1 \("checks"\) was stopped by the user/);
	assert.equal(lastLine(stopped), "The user stopped this job: that is an explicit limit on it. Do not restart it; continue only independent authorized work.");
});

// turn-end-coherence S4: a blocked standalone sleep is not an instruction to end the turn.
test("the standalone-sleep rejection sends the agent to independent work before waiting", () => {
	const reason = agents.match(/Standalone sleep is blocked while background work is active[^`]*/)?.[0];
	assert.ok(reason, "the rejection reason is present");
	assert.ok(!reason.includes("End the turn now"), "ending the turn is not the first instruction");
	assert.ok(reason.includes("Continue independent in-scope work; end the turn to wait only when none remains."));
	assert.ok(reason.includes("Each completion arrives automatically as a session message and starts a new turn."));
});
