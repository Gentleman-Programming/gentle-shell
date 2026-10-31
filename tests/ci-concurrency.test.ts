import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("CI only cancels superseded PR runs, with unique groups for other events", () => {
	const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
	const header = workflow.slice(0, workflow.indexOf("\njobs:"));
	assert.equal((header.match(/^concurrency:$/gm) ?? []).length, 1);
	assert.ok(header.includes("  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}\n"));
	assert.ok(header.includes("  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n"));
});
