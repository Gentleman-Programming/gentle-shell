import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), "utf8");

test("task truth uses ordinary checkboxes without local owner-marker admission", () => {
 const tasks = asset("agents/sdd-tasks.md"), apply = asset("agents/sdd-apply.md");
 assert.match(tasks, /- \[ \] 1\. Implement and verify the behavior\./);
 assert.doesNotMatch(tasks, /<!-- sdd-owner:/);
 assert.doesNotMatch(apply, /fix-task-ownership-marker|unsupported, duplicate, or non-terminal/);
 assert.match(apply, /Preserve historical ownership comments/);
 assert.match(apply, /native task progress and authorized scope/);
 assert.match(apply, /mark each completed implementation task.*immediately after completion/);
 assert.match(apply, /Before returning, re-read the persisted tasks artifact/);
 assert.match(apply, /never overwrite completed work/);
});

test("task planning honors configured TDD rather than test availability", () => {
 const tasks = asset("agents/sdd-tasks.md");
 assert.doesNotMatch(tasks, /If tests exist or strict TDD/);
 assert.match(tasks, /Only when configured strict TDD is active/);
 assert.match(tasks, /Test availability alone does not enable TDD/);
 assert.match(tasks, /400 changed lines/);
});

test("verification reports remaining task truth without manufacturing archive authority", () => {
 const verify = asset("agents/sdd-verify.md");
 assert.doesNotMatch(verify, /mark each as a CRITICAL completeness issue and archive blocker|Archive exceptions are limited/);
 assert.match(verify, /Report the exact unchecked lines as remaining work/);
 assert.match(verify, /Do not return a clean `PASS`/);
 assert.match(verify, /Archive admission follows fresh native status and real permissions/);
});

test("selected stores preserve partial persistence and cumulative readback truth", () => {
 const apply = asset("agents/sdd-apply.md"), memory = asset("orchestrator-memory.md");
 assert.match(apply, /`openspec`\s*\/\s*`both`: write\/update/);
 assert.match(apply, /`engram`\s*\/\s*`both`: update the/);
 assert.match(apply, /read back each selected backend/);
 assert.match(apply, /not atomic/);
 assert.match(memory, /do not switch the selected store/);
 assert.doesNotMatch(memory, /return artifacts inline and\/or write OpenSpec files/);
});
