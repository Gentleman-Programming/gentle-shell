import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseRemediationPlan, type RemediationPlan, type RemediationScope } from "../lib/agents-runner.ts";

const testCwd = process.cwd();
const shellScope = (cwd: string, commands: string[]): RemediationScope => ({ cwd, commands, editPaths: [], allowedEditRoots: [cwd] });
const plan: RemediationPlan = { cwd: testCwd, commands: ["pnpm test"], runtimeHarness: { naReason: "Not applicable because this correction changes only static assets." }, rollback: { boundary: "Revert the changed asset and paired test", command: "git diff --check" } };

test("remediation plan is bounded and cannot select another working directory", () => {
	assert.throws(() => parseRemediationPlan({ ...plan, cwd: "/other" }, testCwd), /plan/);
	assert.throws(() => parseRemediationPlan({ ...plan, commands: [] }, testCwd), /plan/);
	assert.throws(() => parseRemediationPlan({ ...plan, runtimeHarness: { naReason: "N/A" } }, testCwd), /plan/);
});


test("remediation shell captures numeric exit, preserves stock errors and executes once", async () => {
	const { remediationBash } = await import("../extensions/gentle-agents.ts");
	for (const exitCode of [0, 7, null]) {
		let calls = 0;
		const shell = remediationBash(testCwd, { exec: async (command, cwd, options) => {
			calls++; assert.equal(command, "pnpm test"); assert.equal(cwd, testCwd);
			options.onData(Buffer.from("real output")); return { exitCode };
		} }, shellScope(testCwd, ["pnpm test"]));
		const run = shell.definition.execute("call", { command: "pnpm test" }, undefined, undefined, undefined);
		if (exitCode === 7) await assert.rejects(run, /code 7/); else await run;
		const patch = shell.result({ toolCallId: "call", details: { fullOutputPath: "/retained", remediationCommand: { exitCode: 99 } } } as unknown as Parameters<typeof shell.result>[0]);
		const details = patch.details as typeof patch.details & { fullOutputPath?: string };
		assert.equal(details.remediationCommand.exitCode, exitCode);
		assert.equal(details.remediationCommand.command, "pnpm test");
		assert.equal(details.remediationCommand.cwd, testCwd);
		assert.equal(details.fullOutputPath, "/retained");
		assert.equal(shell.result({ toolCallId: "call" }), undefined);
		assert.equal(calls, 1);
	}
});


test("remediation owner and packaged actor are installed through existing ownership", async () => {
	const { getPackageAssetOwner } = await import("../lib/sdd-preflight.ts");
	const { readFileSync } = await import("node:fs");
	assert.equal(getPackageAssetOwner("agents/sdd-remediate.md"), "sdd");
	assert.match(readFileSync("assets/agents/sdd-remediate.md", "utf8"), /SDD remediate executor/);
});


test("stock local shell wrapper observes real exit zero and preserves cancellation", async () => {
	const { remediationBash } = await import("../extensions/gentle-agents.ts");
	const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
	const shell = remediationBash(process.cwd(), undefined, shellScope(process.cwd(), ["printf wrapper-proof", "sleep 30"]));
	assert.deepEqual(shell.definition.parameters, createBashToolDefinition(process.cwd()).parameters);
	const result = await shell.definition.execute("real", { command: "printf wrapper-proof" }, undefined, undefined, undefined);
	const [content] = result.content;
	assert.ok(content?.type === "text");
	assert.equal(content.text, "wrapper-proof");
	assert.equal(shell.result({ toolCallId: "real", details: result.details }).details.remediationCommand.exitCode, 0);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30);
	try { await assert.rejects(shell.definition.execute("cancel", { command: "sleep 30" }, controller.signal, undefined, undefined), /aborted/); }
	finally { clearTimeout(timeout); controller.abort(); }
	assert.equal(shell.result({ toolCallId: "cancel" }), undefined);
});



test("remediation actor preserves separately authorized memory artifact tools", async () => {
	const { parseAgentDefinition } = await import("../lib/agents-config.ts");
	const { readFileSync } = await import("node:fs");
	const agent = parseAgentDefinition(readFileSync("assets/agents/sdd-remediate.md", "utf8"), "/agents/sdd-remediate.md", "global");
	assert.ok("instructions" in agent);
	for (const tool of ["mem_search", "mem_get_observation", "mem_save", "mem_update"]) assert.ok(agent.tools.includes(tool), tool);
});



test("R1 confirms exact canonical paths and commands; data, denial and symlinks grant nothing", async t => {
	const { confirmRemediationScope, remediationToolAllowed } = await import("../extensions/gentle-agents.ts");
	const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "remediation-scope-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const target = join(cwd, "allowed.ts"); writeFileSync(target, "original"); symlinkSync(target, join(cwd, "alias.ts"));
	const candidate = { ...plan, cwd, editPaths: [target] }, native = { mode: "repo-local", workspaceRoot: cwd, allowedEditRoots: [cwd] };
	let shown = "", confirmations = 0;
	const ui = { hasUI: true, ui: { confirm: async (_title: string, text: string) => { shown = text; confirmations++; return true; } } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
	const scope = await confirmRemediationScope(candidate, native, ui);
	assert.match(shown, /pnpm test/); assert.ok(shown.includes(target)); assert.ok(shown.includes(cwd));
	assert.equal(remediationToolAllowed(scope, cwd, "write", { path: target }), true);
	for (const tool of ["mem_search", "mem_get_observation", "mem_save", "mem_update"]) assert.equal(remediationToolAllowed(scope, cwd, tool, { id: 7, project: "other", content: "outside" }), false);
	assert.equal(remediationToolAllowed(scope, cwd, "write", { path: join(cwd, "other.ts") }), false);
	assert.equal(remediationToolAllowed(scope, cwd, "bash", { command: "pnpm test; touch outside" }), false);
	for (const bad of [{ ...candidate, editPaths: [join(cwd, "alias.ts")] }, { ...candidate, editPaths: [cwd] }, { ...candidate, editPaths: [target, target] }]) await assert.rejects(confirmRemediationScope(bad, native, ui));
	assert.equal(confirmations, 1);
	for (const context of [undefined, { hasUI: false, ui: ui.ui }, { hasUI: true, ui: { confirm: async () => false } }, { hasUI: true, ui: { confirm: async () => undefined } }]) await assert.rejects(confirmRemediationScope(candidate, native, context as unknown as Pick<ExtensionContext, "hasUI" | "ui">), /authorization/);
});



test("R1 child invokes only the exact confirmed command/cwd/count with distinct call IDs", async () => {
	const { remediationBash } = await import("../extensions/gentle-agents.ts");
	let executions = 0;
	const shell = remediationBash(testCwd, { exec: async () => { executions++; return { exitCode: 0 }; } }, shellScope(testCwd, ["pnpm test", "pnpm test"]));
	const execute = (id: string, command: string, cwd = testCwd) => shell.definition.execute(id, { command }, undefined, undefined, cwd === testCwd ? undefined : { cwd } as unknown as ExtensionContext);
	await assert.rejects(execute("outside", "pnpm test; touch outside"), /authorization/);
	await assert.rejects(execute("cwd", "pnpm test", "/other"), /authorization/);
	assert.equal(executions, 0);
	await execute("one", "pnpm test"); await assert.rejects(execute("one", "pnpm test"), /authorization/);
	await execute("two", "pnpm test"); await assert.rejects(execute("three", "pnpm test"), /authorization/);
	assert.equal(executions, 2);
});

test("remediation actor explains one-launch human authority and indexed command evidence", async () => {
	const { readFileSync } = await import("node:fs");
	const text = readFileSync("assets/agents/sdd-remediate.md", "utf8");
	assert.match(text, /fresh host UI confirmation/); assert.match(text, /each repeated command.*separate execution/);
	assert.match(text, /Inspect prior task\/artifact history/);
	assert.match(text, /No attempt-ledger command is required/);
});


// Runs only in the explicit producer verification lane; no default-suite skip is added.
if (process.env.SDD_TEST_PRODUCER) test("real native selection admits only its own remediation route without attempt subprocesses", async (t) => {
	const { execFileSync } = await import("node:child_process");
	const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join, resolve } = await import("node:path");
	const { NativeReviewCliV216, createNodeExecFileAdapter } = await import("../lib/native-review-cli.ts");
	const { admitManagedRemediation } = await import("../extensions/gentle-agents.ts");
	const { parseAgentDefinition } = await import("../lib/agents-config.ts");
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "no-attempt-producer-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", cwd]);
	const change = join(cwd, "openspec/changes/fix");
	mkdirSync(join(change, "specs/example"), { recursive: true });
	for (const [path, bytes] of Object.entries({ "proposal.md": "# Proposal\n", "design.md": "# Design\n", "specs/example/spec.md": "# Spec\n", "tasks.md": "- [x] Fixture complete\n" })) writeFileSync(join(change, path), bytes);
	const revision = `sha256:${"a".repeat(64)}`;
	writeFileSync(join(change, "verify-report.md"), ["```yaml", "schema: gentle-ai.verify-result/v1", `evidence_revision: ${revision}`, "verdict: fail", "blockers: 1", "critical_findings: 0", "requirements: 1/1", "scenarios: 1/1", "test_command: false", "test_exit_code: 1", `test_output_hash: sha256:${"b".repeat(64)}`, "build_command: true", "build_exit_code: 0", `build_output_hash: sha256:${"b".repeat(64)}`, "```"].join("\n"));
	const invocations: string[] = [], adapter = createNodeExecFileAdapter();
	const native = new NativeReviewCliV216(async (request) => { invocations.push(request.arguments[0]!); return adapter(request); }, process.env.SDD_TEST_PRODUCER!);
	const status = await native.sddStatus({ workspaceRoot: cwd, changeName: "fix" });
	const path = resolve("assets/agents/sdd-remediate.md"), agent = parseAgentDefinition(readFileSync(path, "utf8"), path, "global");
	assert.ok("instructions" in agent);
	let confirmations = 0;
	const context = { hasUI: true, ui: { confirm: async () => { confirmations++; return true; } } } as unknown as Pick<ExtensionContext, "hasUI" | "ui">;
	const request = { agent, cwd, sddChange: { changeName: "fix", workspaceRoot: cwd, phase: "remediate", failedEvidenceRevision: revision } } as import("../lib/agents-runner.ts").TaskRequest;
	const admission = admitManagedRemediation(request, { plan: { ...plan, cwd } }, native, context);
	if (status.nextRecommended === "remediate") {
		const admitted = await admission;
		assert.equal(admitted.sddRemediation?.failedEvidenceRevision, revision);
		assert.equal(confirmations, 1);
	} else {
		await assert.rejects(admission, /Stale remediation selection/);
		assert.equal(confirmations, 0, "a classical provider is not assigned a fabricated remediation route");
	}
	assert.deepEqual(invocations, ["sdd-status", "sdd-status"]);
});
