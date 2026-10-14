import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "extensions/gentle-agents.ts"), "utf8");
const sessionTool = source.match(/name: "orchestrator_session_id",\s*label: "[^"]+",\s*description: ("(?:[^"\\]|\\.)*")/);
assert.ok(sessionTool, "Registered session tool exposes its publication contract");
const description: string = JSON.parse(sessionTool[1]);
const guidance = readFileSync(join(root, "assets/orchestrator-delegation.md"), "utf8");
const docs = readFileSync(join(root, "docs/gentle-agents-activity.md"), "utf8");

test("shipped guidance publishes status before work and refreshes task transitions", () => {
	assert.match(description, /For work beyond small direct tasks, publish subject and current\/next status here; refresh at task changes\/completion/);
	assert.doesNotMatch(description, /Before meaningful work, publish subject/);
	assert.match(guidance, /Before work beyond small direct tasks, publish own `state` with `subject`/);
	assert.doesNotMatch(guidance, /Before meaningful work or delegation, publish own `state`/);
	assert.match(guidance, /current\/next scope and status/);
	assert.match(guidance, /Refresh at task changes\/completion/);
	assert.doesNotMatch(guidance, /when helpful, publish short explicit own `state`/);
	assert.match(guidance, /Do not require a subject declaration for small direct tasks/);
	assert.match(guidance, /no extra model turn, repeated reads or per-token\/tool updates/);
	assert.match(guidance, /Exclude private prompts, internal instructions and credentials/);
});

test("hub documentation separates busy-owner snapshots from replies and negative ownership claims", () => {
	assert.match(docs, /before work beyond small direct tasks/);
	assert.match(docs, /while the owner is busy/);
	assert.match(docs, /current and next scope/);
	assert.match(docs, /update at task changes and completion/);
	assert.match(docs, /A search with no matches does not establish that nobody else is working on the feature/);
	assert.match(docs, /state `recordedAt` and scope `resolvedAt` keep their historical meaning/);
});
