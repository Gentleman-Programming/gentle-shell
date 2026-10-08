import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/windows-installer-diagnostic.yml", import.meta.url);
const readWorkflow = () => readFileSync(workflowPath, "utf8").replace(/\r\n/g, "\n");

// These checks validate the diagnostic definition, not the native installer.
// The selected installer file is executed only by the one authorized CI job.
test("diagnostic selects the pinned Windows source, runtime and single TAP file", () => {
	const workflow = readWorkflow();
	assert.match(workflow, /runs-on: windows-2025/);
	assert.match(workflow, /node-version: "24\.21\.0"/);
	assert.match(workflow, /ref: 41210ef5d87f6242c507b04b818801ffa9b7f49b/);
	assert.match(workflow, /path: source/);
	assert.deepEqual(workflow.match(/tests\/[\w-]+\.test\.ts/g), ["tests/installer-windows-bootstrap.test.ts"]);
	assert.match(workflow, /"--test-reporter=tap"/);
	assert.match(workflow, /"--experimental-strip-types", "--test"/);
	assert.match(workflow, /process\.version !== "v24\.21\.0"/);
	assert.match(workflow, /checkedOutSource !== sourceRef/);
	const script = workflow.match(/^\s*@'\n([\s\S]*?)^\s*'@ \| Set-Content/m)?.[1];
	assert.ok(script, "PowerShell here-string contains the diagnostic Node program");
	const checked = spawnSync(process.execPath, ["--check"], { input: script, encoding: "utf8" });
	assert.equal(checked.error, undefined);
	assert.equal(checked.status, 0, checked.stderr);
	assert.equal(checked.stdout, "");
});

test("diagnostic is branch-only, bounded and preserves failed-run evidence", () => {
	const workflow = readWorkflow();
	assert.match(workflow, /on:\n  push:\n    branches:\n      - ci\/213-windows-diagnostic\n    paths:\n      - \.github\/workflows\/windows-installer-diagnostic\.yml\n/);
	assert.doesNotMatch(workflow, /pull_request|workflow_dispatch|matrix:|pnpm|npm install|secrets\./);
	assert.match(workflow, /permissions:\n  contents: read\n/);
	assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
	assert.deepEqual([...workflow.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]), ["push", "diagnostic"]);
	assert.match(workflow, /timeout-minutes: 7/);
	assert.match(workflow, /deadlineMs = 180_000/);
	assert.match(workflow, /maxOutputBytes = 8 \* 1024 \* 1024/);
	assert.match(workflow, /"\/pid", String\(child\.pid\), "\/T", "\/F"/);
	assert.match(workflow, /exitCode: code, signal/);
	assert.match(workflow, /"stdout\.log"/);
	assert.match(workflow, /"stderr\.log"/);
	assert.match(workflow, /"result\.json"/);
	assert.match(workflow, /if: always\(\)/);
	assert.match(workflow, /path: diagnostic-output\//);
	assert.match(workflow, /retention-days: 7/);
	assert.doesNotMatch(workflow, /continue-on-error/);
});
