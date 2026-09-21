import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { AgentRunner, type TaskRequest } from "../lib/agents-runner.ts";
import { TaskStore } from "../lib/agents-protocol.ts";
import { createNodeExecFileAdapter, NativeReviewCliV216, decodeNativeSddStatusV2, NATIVE_REVIEW_ERROR_CODE, NativeReviewCliError } from "../lib/native-review-cli.ts";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NativeReviewCli, NativeSddStatusV2 } from "../lib/native-review-cli.ts";
import { ensureSddPreflight } from "../lib/sdd-preflight.ts";
import { fakeChild } from "./agents-fake-child.ts";

const applyAgent: AgentDefinition = {
	name: "sdd-apply",
	description: "Apply the selected change.",
	filePath: "/agents/sdd-apply.md",
	scope: "global",
	instructions: "SDD apply executor",
	model: undefined,
	thinking: undefined,
	mode: undefined,
	tools: ["read"],
};

function request(sddChange: { changeName: string; workspaceRoot: string; phase: "apply" }): TaskRequest {
	return {
		agent: applyAgent,
		prompt: "Apply selected change.",
		label: undefined,
		context: undefined,
		mode: AGENT_MODE.BACKGROUND,
		cwd: sddChange.workspaceRoot,
		parentSessionId: "parent",
		model: undefined,
		thinking: undefined,
		sessionDir: "/sessions",
		resumeSessionPath: undefined,
		env: {},
		sddChange,
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function workspace(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-sdd-selection-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "openspec", "changes", "alpha"), { recursive: true });
	mkdirSync(join(root, "openspec", "changes", "beta"), { recursive: true });
	return realpathSync(root);
}

test("remediation read tools are limited to canonical relative paths inside the confirmed worktree", async (t) => {
	const { remediationToolAllowed } = await import("../extensions/gentle-agents.ts");
	const cwd = workspace(t), outside = mkdtempSync(join(tmpdir(), "gentle-pi-remediation-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	symlinkSync(outside, join(cwd, "escape"));
	const scope = { cwd, editPaths: [], commands: ["pnpm test"], allowedEditRoots: [cwd] };
	for (const tool of ["read", "grep", "find"]) {
		assert.equal(remediationToolAllowed(scope, cwd, tool, {}), true, `${tool} defaults to cwd`);
		assert.equal(remediationToolAllowed(scope, cwd, tool, { path: "openspec" }), true);
		for (const path of [join(cwd, "openspec"), "../outside", "escape", "", 7]) assert.equal(remediationToolAllowed(scope, cwd, tool, { path }), false, `${tool} denies malformed or escaping paths`);
	}
	assert.equal(remediationToolAllowed(scope, cwd, "write", { path: "openspec" }), false);
	assert.equal(remediationToolAllowed(scope, cwd, "bash", { command: "pnpm test" }), true);
	assert.equal(remediationToolAllowed(scope, cwd, "subagent_parent_message", {}), true);
});

test("selected SDD change snapshots at task construction and reaches child startup in a multi-change workspace", async (t) => {
	const root = workspace(t);
	const selection = { changeName: "alpha", workspaceRoot: root, phase: "apply" as const };
	const spawned: string[][] = [];
	const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 2, stallTimeoutMs: 1_000 }, {
		spawn: (_command, args) => {
			spawned.push(args);
			return fakeChild().child;
		},
		now: () => 1,
		schedule: () => () => {},
		pi: { command: "pi", args: [] },
	}, { askUser: async () => ({ cancelled: true }) });

	runner.run(request(selection));
	selection.changeName = "beta";
	runner.run(request({ changeName: "beta", workspaceRoot: root, phase: "apply" }));
	await tick();
	const serialized = spawned[0]![spawned[0]!.indexOf("--gentle-sdd-change") + 1]!;
	const concurrent = spawned[1]![spawned[1]!.indexOf("--gentle-sdd-change") + 1]!;
	assert.deepEqual(JSON.parse(serialized), { changeName: "alpha", workspaceRoot: root, phase: "apply" });
	assert.deepEqual(JSON.parse(concurrent), { changeName: "beta", workspaceRoot: root, phase: "apply" });
	const authority = { ...commandStatus(root), nextRecommended: "apply", blockedReasons: [],
		dependencies: { ...commandStatus(root).dependencies, apply: "ready" } };
	const startup = await nativeStartup(serialized, root, "sdd-apply", { sddStatus: async () => authority });
	assert.equal(startup.status.changeName, "alpha");
	assert.equal(startup.status.nextRecommended, "apply");
});

test("selected native v2 archive authority is injected whole without a competing local projection", async (t) => {
	const root = workspace(t);
	const serialized = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "archive" });
	const nativeAuthority = {
		schemaName: "gentle-ai.sdd-status",
		schemaVersion: 2,
		changeName: "alpha",
		artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: join(root, "openspec") },
		changeRoot: join(root, "openspec/changes/alpha"),
		actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
		dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "all_done", verify: "all_done", archive: "ready" },
		phaseInstructions: { apply: ["done"], verify: ["done"], remediate: ["failed evidence"], archive: ["archive now"] },
		blockedReasons: [],
		nextRecommended: "archive",
	};
	const nativeCalls: unknown[] = [];
	const startup = await nativeStartup(serialized, root, "sdd-archive", {
		sddStatus: async (request) => { nativeCalls.push(request); return nativeAuthority; },
	});

	assert.deepEqual(startup.selection, { changeName: "alpha", workspaceRoot: root, phase: "archive" });
	assert.equal(startup.status, nativeAuthority, "the validated native status object is injected without a local overlay");
	assert.deepEqual(nativeCalls, [{ changeName: "alpha", workspaceRoot: root }]);
});

test("selected native v2 failures fail closed without local status reconstruction", async (t) => {
	const root = workspace(t);
	const serialized = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "archive" });
	const valid = {
		schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: join(root, "openspec") }, changeRoot: join(root, "openspec/changes/alpha"),
		actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
		dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "all_done", verify: "all_done", archive: "blocked" },
		phaseInstructions: { apply: ["done"], verify: ["done"], remediate: ["failed evidence"], archive: ["blocked"] },
		blockedReasons: ["native archive blocker"], nextRecommended: "verify",
	};
	const failures: Array<{ sddStatus?: () => Promise<unknown> }> = [
		{},
		{ sddStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, "sdd-status", true, false, "native timeout"); } },
		{ sddStatus: async () => { throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "sdd-status", true, false, "native nonzero"); } },
		{ sddStatus: async () => { throw new Error("native command threw"); } },
		{ sddStatus: async () => ({}) },
		{ sddStatus: async () => ({ ...valid, schemaVersion: 1 }) },
		{ sddStatus: async () => ({ ...valid, changeName: "other" }) },
		{ sddStatus: async () => ({ ...valid, actionContext: { workspaceRoot: "/other" } }) },
		{ sddStatus: async () => ({ ...valid, dependencies: { apply: "all_done", verify: "all_done" } }) },
		{ sddStatus: async () => ({ ...valid, phaseInstructions: { apply: ["done"], verify: ["done"] } }) },
		{ sddStatus: async () => ({ ...valid, blockedReasons: "invalid" }) },
	];
	for (const native of failures) {
		await assert.rejects(() => nativeStartup(serialized, root, "sdd-archive", native), /SDD selection native status/i);
	}
	await assert.rejects(() => nativeStartup(serialized, root, "sdd-archive", { sddStatus: async () => valid }), /native status.*blocks|cannot execute/i);

});

function nativeStartup(
	serialized: unknown,
	cwd: string,
	agentName: string,
	native: { sddStatus?: (request: unknown) => Promise<unknown> },
) {
	return (__testing as unknown as {
		resolveSelectedNativeSddChangeStartup(
			serialized: unknown, cwd: string, agentName: string,
			native: { sddStatus?: (request: unknown) => Promise<unknown> },
		): Promise<{ selection: { changeName: string; workspaceRoot: string; phase: string }; status: NativeSddStatusV2 }>;
	}).resolveSelectedNativeSddChangeStartup(serialized, cwd, agentName, native);
}

function verifyRefreshAuthority(root: string, blockedReasons: readonly string[]) {
	return {
		schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: join(root, "openspec") }, changeRoot: join(root, "openspec/changes/alpha"),
		actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
		dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "all_done", verify: "ready", archive: "blocked" },
		phaseInstructions: { apply: ["done"], verify: ["rerun SDD verification"], remediate: ["failed evidence"], archive: ["blocked"] },
		blockedReasons: [...blockedReasons], nextRecommended: "verify",
	};
}

test("a native verify evidence-refresh route starts under its own blocker while every other phase stays closed", async (t) => {
	const root = workspace(t);
	const refreshReason = "failed verification evidence is incomplete; rerun SDD verification";
	const authority = verifyRefreshAuthority(root, [refreshReason]);
	const startup = await nativeStartup(
		JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "verify" }),
		root,
		"sdd-verify",
		{ sddStatus: async () => authority },
	);
	assert.deepEqual(startup.selection, { changeName: "alpha", workspaceRoot: root, phase: "verify" });
	assert.equal(startup.status, authority, "the validated native status is injected whole, blockers included");
	assert.deepEqual(startup.status.blockedReasons, [refreshReason], "the blocking reason is preserved for reporting");

	for (const phase of ["apply", "archive"] as const) {
		const gated = {
			...verifyRefreshAuthority(root, [refreshReason]),
			nextRecommended: phase,
			dependencies: { ...authority.dependencies, [phase]: "ready", verify: "all_done" },
		};
		await assert.rejects(
			() => nativeStartup(
				JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase }),
				root,
				`sdd-${phase}`,
				{ sddStatus: async () => gated },
			),
			/native status blocks phase/i,
		);
	}
});

test("a throwing SDD selection flag reader fails closed without resolving an unselected status", async (t) => {
	const root = workspace(t);
	assert.equal(__testing.readSddChangeFlag({ getFlag: () => false } as never), undefined);
	const selection = __testing.readSddChangeFlag({
		getFlag() { throw new Error("flag reader failed"); },
	} as never);
	let resolverCalls = 0;
	await assert.rejects(
		() => nativeStartup(selection, root, "sdd-apply", { sddStatus: async () => {
			resolverCalls += 1;
			throw new Error("status resolver must not run");
		} }),
		/SDD selection must be a JSON string/i,
	);
	assert.equal(resolverCalls, 0);
});

test("selected SDD startup fails closed for malformed identity, root, phase, symlink, and resolver errors", async (t) => {
	const root = workspace(t);
	const selected = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "apply" });
	const outside = mkdtempSync(join(tmpdir(), "gentle-pi-sdd-selection-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	const escaped = join(root, "escaped-root");
	symlinkSync(outside, escaped);

	for (const value of [
		undefined,
		null,
		"not-json",
		JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "apply", extra: true }),
		JSON.stringify({ changeName: "alpha", workspaceRoot: join(root, "wrong"), phase: "apply" }),
		JSON.stringify({ changeName: "alpha", workspaceRoot: escaped, phase: "apply" }),
	]) {
		await assert.rejects(() => nativeStartup(value, root, "sdd-apply", {}), /SDD selection/i);
	}
	await assert.rejects(() => nativeStartup(selected, root, "sdd-verify", {}), /phase/i);
	await assert.rejects(
		() => nativeStartup(selected, root, "sdd-apply", { sddStatus: async () => { throw new Error("resolver failed"); } }),
		/resolver failed/i,
	);
});

// Use the packaged executor body without an unsupported agent-name event field.
test("before_agent_start resolves the unnamed packaged executor and renders native v2 selection", async (t) => {
	const root = workspace(t);
	const systemPrompt = readFileSync(new URL("../assets/agents/sdd-apply.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
	const selection = { changeName: "alpha", workspaceRoot: root, phase: "apply" };
	const status = {
		schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: join(root, "openspec") }, changeRoot: join(root, "openspec/changes/alpha"),
		actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
		dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "ready", verify: "blocked", archive: "blocked" },
		phaseInstructions: { apply: ["Read proposal, specs, design, and tasks before editing."], verify: ["Verify implementation."], remediate: ["Bind failed evidence."], archive: ["Archive after verification."] },
		blockedReasons: [], nextRecommended: "apply",
	};
	let serialized: unknown = JSON.stringify(selection);
	let nativeReply: unknown = status;
	const calls: unknown[] = [];
	type Hook = (event: unknown, ctx: ExtensionContext) => Promise<{ systemPrompt: string }>;
	const hooks = new Map<string, Hook>();
	const pi = {
		on(name: string, hook: Hook) { hooks.set(name, hook); },
		events: { emit() {} }, registerCommand() {}, registerTool() {},
		getFlag: () => serialized, getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => root } } as unknown as ExtensionContext;
	await ensureSddPreflight(ctx, { pi, installAssets: () => ({ agents: 0, chains: 0, support: 0, skipped: 0 }) });
	createGentleAiExtension({
		nativeReviewCli: { sddStatus: async (request: unknown) => { calls.push(request); return nativeReply; } } as unknown as NativeReviewCli,
		processEnv: {},
		resolveTelemetryTriggerBinary: () => { throw new Error("no telemetry in hook tests"); },
	})(pi);
	const result = await hooks.get("before_agent_start")!({ systemPrompt }, ctx);
	assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
	assert.deepEqual(calls, [{ changeName: "alpha", workspaceRoot: root }]);
	assert.match(result.systemPrompt, /### apply instructions/);
	assert.ok(result.systemPrompt.includes(status.phaseInstructions.apply[0]!));
	assert.ok(result.systemPrompt.includes(JSON.stringify(status, null, 2)));
	for (const [name, event] of [
		["contradictory names", { systemPrompt, agentName: "sdd-apply", name: "sdd-verify" }],
		["contradictory named phase", { systemPrompt, agentName: "sdd-verify" }],
		["unknown explicit name", { systemPrompt, agentName: "worker" }],
		["ambiguous executor body", { systemPrompt: `${systemPrompt}\nSDD verify executor` }],
		["unknown executor body", { systemPrompt: "SDD unknown executor" }],
	] as const) {
		await t.test(name, async () => {
			calls.length = 0;
			assert.match((await hooks.get("before_agent_start")!(event, ctx)).systemPrompt, /SDD selection blocked:/);
			assert.deepEqual(calls, []);
		});
	}
	for (const invalid of [null, "not-json", { ...selection, phase: "verify" }, { ...selection, workspaceRoot: "/other" }]) {
		serialized = typeof invalid === "object" && invalid !== null ? JSON.stringify(invalid) : invalid;
		calls.length = 0;
		assert.match((await hooks.get("before_agent_start")!({ systemPrompt }, ctx)).systemPrompt, /SDD selection blocked:/);
		assert.deepEqual(calls, []);
	}
	serialized = JSON.stringify(selection);
	for (const invalid of [{ ...status, phaseInstructions: undefined }, { ...status, nextRecommended: "unknown" }]) {
		nativeReply = invalid;
		assert.match((await hooks.get("before_agent_start")!({ systemPrompt }, ctx)).systemPrompt, /SDD selection blocked:/);
	}
	serialized = undefined;
	nativeReply = status;
	calls.length = 0;
	await hooks.get("before_agent_start")!({ systemPrompt }, ctx);
	assert.deepEqual(calls, [{ changeName: undefined, workspaceRoot: root }], "unselected startup reads native discovery, never local readiness");
	const callTool = hooks.get("tool_call")! as unknown as (event: { toolName: string; input: Record<string, unknown> }, context: ExtensionContext) => Promise<{ block?: boolean } | undefined>;
	const assertStartupBlocked = async (reply: unknown) => {
		serialized = undefined; nativeReply = reply;
		assert.match((await hooks.get("before_agent_start")!({ systemPrompt }, ctx)).systemPrompt, /SDD selection blocked:/);
		for (const [toolName, input] of [["write", { path: "allowed.ts" }], ["edit", { path: "allowed.ts" }], ["bash", { command: "echo unsafe" }]] as const) {
			assert.equal((await callTool({ toolName, input }, ctx))?.block, true, `${toolName} is mechanically blocked after ambiguous native startup`);
		}
		assert.equal(await callTool({ toolName: "subagent_parent_message", input: {} }, ctx), undefined, "parent messaging remains available");
	};
	for (const invalid of [{ ...status, changeName: null }, { ...status, phaseInstructions: undefined }, { ...status, nextRecommended: "unknown" }, { ...status, nextRecommended: "propose" }, { ...status, nextRecommended: "verify" }]) await assertStartupBlocked(invalid);
	for (const phase of ["apply", "verify", "remediate", "archive"] as const) {
		const phasePrompt = readFileSync(new URL(`../assets/agents/sdd-${phase}.md`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
		serialized = undefined;
		nativeReply = { ...status, nextRecommended: phase, dependencies: { ...status.dependencies, ...(phase === "remediate" ? {} : { [phase]: "ready" }) }, ...(phase === "remediate" ? { remediationState: { required: true, complete: false, failedEvidenceRevision: `sha256:${"a".repeat(64)}` } } : {}) };
		assert.doesNotMatch((await hooks.get("before_agent_start")!({ systemPrompt: phasePrompt }, ctx)).systemPrompt, /SDD selection blocked:/);
		assert.equal((await callTool({ toolName: "read", input: {} }, ctx))?.block, undefined, `${phase} accepts its matching native recommendation`);
	}
	serialized = JSON.stringify(selection);
	for (const blockedReply of [
		{ ...status, dependencies: { ...status.dependencies, apply: "blocked" }, blockedReasons: ["missing native prerequisite"] },
		{ ...status, nextRecommended: "verify" },
	]) {
		nativeReply = blockedReply;
		const blocked = await hooks.get("before_agent_start")!({ systemPrompt }, ctx);
		assert.match(blocked.systemPrompt, /SDD selection blocked:/);
		assert.equal((await callTool({ toolName: "write", input: { path: "unsafe.ts" } }, ctx))?.block, true);
	}

});

// Opt-in controlled producer proof; never resolves or installs a global binary.
test("producer v2 preservation: selected status is read-only and retains all seven dependencies", { skip: !process.env.SDD_TEST_PRODUCER }, async (t) => {
	const root = workspace(t);
	execFileSync("git", ["init", "--quiet", root]);
	const args = ["sdd-status", "alpha", "--cwd", root, "--json", "--instructions"];
	const first = execFileSync(process.env.SDD_TEST_PRODUCER!, args, { encoding: "utf8" });
	const second = execFileSync(process.env.SDD_TEST_PRODUCER!, args, { encoding: "utf8" });
	assert.equal(first, second);
	const status = decodeNativeSddStatusV2(JSON.parse(first), { changeName: "alpha", workspaceRoot: root });
	assert.deepEqual(Object.keys(status.dependencies).sort(), ["apply", "archive", "design", "proposal", "specs", "tasks", "verify"]);
	assert.deepEqual(Object.keys(status.phaseInstructions!).sort(), "remediate" in status.phaseInstructions!
		? ["apply", "archive", "remediate", "verify"] : ["apply", "archive", "verify"]);
	assert.equal(status.nextRecommended, "propose");
	if (!("remediate" in status.phaseInstructions!)) {
		assert.throws(() => execFileSync(process.env.SDD_TEST_PRODUCER!, ["sdd-verify-validate"], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		}), (error: unknown) => error instanceof Error && "stderr" in error && /unknown command/.test(String(error.stderr)));
		const verifier = readFileSync(new URL("../assets/agents/sdd-verify.md", import.meta.url), "utf8");
		assert.doesNotMatch(verifier, /sdd-verify-validate|gentle-ai\.verify-result\/v1/);
	}
	const verbs: string[] = [];
	const adapter = createNodeExecFileAdapter();
	const native = new NativeReviewCliV216(async (request) => { verbs.push(request.arguments[0]!); return adapter(request); }, process.env.SDD_TEST_PRODUCER!);
	const h = commandHarness(root, status, true, true, native);
	await h.run("status");
	assert.deepEqual(JSON.parse(h.notices[0]!), status);
	assert.deepEqual(verbs, ["sdd-status"]);
	await h.run("continue");
	assert.deepEqual(verbs, ["sdd-status", "sdd-status", "sdd-continue"]);
	assert.equal(JSON.parse(h.notices[1]!).nextRecommended, "propose");
	assert.throws(() => readFileSync(join(root, "openspec/changes/alpha/.gentle-ai-instance")), /ENOENT/);
});

function commandHarness(root: string, status: unknown, answer?: unknown, hasUI = true, native?: NativeReviewCli) {
	const calls: string[] = [];
	const notices: string[] = [];
	const confirmations: string[] = [];
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		on() {}, events: { emit() {} }, registerTool() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, command.handler); },
		sendUserMessage() { calls.push("launch"); }, sendMessage() { calls.push("launch"); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: native ?? {
		sddStatus: async () => { calls.push("status"); return status; },
		sddContinue: async () => { calls.push("continue"); return status; },
	} as unknown as NativeReviewCli, processEnv: {} })(pi);
	const ctx = { cwd: root, hasUI, ui: {
		notify: (text: string) => notices.push(text),
		confirm: async (title: string, text: string) => { confirmations.push(`${title}\n${text}`); return answer; },
	} } as unknown as ExtensionContext;
	return { calls, notices, confirmations, ctx, run: (verb: string) => commands.get(`gentle-sdd-${verb}`)!("alpha --json", ctx) };
}

function commandStatus(root: string) {
	return {
		schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: "openspec",
		planningHome: { mode: "repo-local", path: join(root, "openspec") }, changeRoot: join(root, "openspec/changes/alpha"),
		actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] },
		dependencies: { proposal: "ready", specs: "blocked", design: "blocked", tasks: "blocked", apply: "blocked", verify: "blocked", archive: "blocked" },
		phaseInstructions: { apply: ["misleading prose: apply now"], verify: [], remediate: [], archive: [] },
		blockedReasons: ["prepare only; source roots remain ungranted"], nextRecommended: "propose",
	};
}

test("classical native instructions reach selected apply, verify and archive startup unchanged", async (t) => {
	const root = workspace(t);
	for (const phase of ["apply", "verify", "archive"] as const) {
		const legacy = commandStatus(root);
		const { remediate: _legacyOnly, ...phaseInstructions } = legacy.phaseInstructions;
		const status = { ...legacy, phaseInstructions, blockedReasons: [], nextRecommended: phase,
			dependencies: { ...legacy.dependencies, [phase]: "ready" } };
		const calls: unknown[] = [];
		const result = await nativeStartup(JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase }), root, `sdd-${phase}`, {
			sddStatus: async (request) => { calls.push(request); return status; },
		});
		assert.equal(result.status, status, "transport preserves the provider's original object");
		assert.equal("remediate" in result.status.phaseInstructions!, false, "never synthesize retired instructions");
		assert.deepEqual(calls, [{ changeName: "alpha", workspaceRoot: root }]);
	}
});

test("native instruction compatibility does not admit incomplete or foreign phase records", (t) => {
	const root = workspace(t), legacy = commandStatus(root);
	const { remediate: _legacyOnly, ...classical } = legacy.phaseInstructions;
	const request = { changeName: "alpha", workspaceRoot: root };
	assert.equal(decodeNativeSddStatusV2(legacy, request), legacy, "pinned producer remains supported");
	for (const phaseInstructions of [
		{ ...classical, verify: undefined }, { ...classical, remediate: undefined },
		{ ...classical, remediate: "not an instruction list" }, { ...classical, sync: [] },
		{ ...classical, unknown: [] },
	]) assert.throws(() => decodeNativeSddStatusV2({ ...legacy, phaseInstructions }, request));
	assert.throws(() => decodeNativeSddStatusV2({ ...legacy, phaseInstructions: classical,
		nextRecommended: "remediate", remediationState: { required: true, complete: false, failedEvidenceRevision: `sha256:${"a".repeat(64)}` },
	}, request), /remediation/i);
});

test("producer instructions reach actual selected-child startup without provider replacement", { skip: !process.env.SDD_TEST_PRODUCER }, async (t) => {
	const root = workspace(t), change = join(root, "openspec/changes/alpha");
	rmSync(join(root, "openspec/changes/beta"), { recursive: true });
	execFileSync("git", ["init", "--quiet", root]);
	mkdirSync(join(change, "specs/feature"), { recursive: true });
	for (const [path, content] of Object.entries({ "proposal.md": "# Proposal\n", "design.md": "# Design\n",
		"specs/feature/spec.md": "# Spec\n", "tasks.md": "- [ ] 1.1 Implement\n" })) writeFileSync(join(change, path), content);
	const invoked: string[] = [];
	const adapter = createNodeExecFileAdapter();
	const native = new NativeReviewCliV216(async (request) => {
		invoked.push(request.arguments[0]!);
		return adapter(request);
	}, process.env.SDD_TEST_PRODUCER!);
	t.after(() => assert.ok(invoked.every((verb) => verb === "sdd-status"), "registered startup never invokes attempt acquire/settle"));
	const status = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
	assert.equal(status.nextRecommended, "apply");
	let selection: string | undefined = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "apply" });
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<{ systemPrompt: string }>>();
	const pi = { on(name: string, hook: never) { hooks.set(name, hook); }, events: { emit() {} },
		registerCommand() {}, registerTool() {}, getFlag: () => selection, getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => root } } as unknown as ExtensionContext;
	await ensureSddPreflight(ctx, { pi, installAssets: () => ({ agents: 0, chains: 0, support: 0, skipped: 0 }) });
	createGentleAiExtension({ nativeReviewCli: native, processEnv: {},
		resolveTelemetryTriggerBinary: () => { throw new Error("no telemetry in producer test"); },
	})(pi);
	const result = await hooks.get("before_agent_start")!({ systemPrompt: "SDD apply executor" }, ctx);
	assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
	assert.ok(result.systemPrompt.includes(JSON.stringify(status, null, 2)));
	assert.match(result.systemPrompt, /### apply instructions/);
	writeFileSync(join(change, "tasks.md"), "- [x] 1.1 Implement\n");
	const completed = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
	// The current pin requests verify; the classical producer requests archive.
	// This slice consumes either producer, without changing its chosen route.
	const next = "remediate" in completed.phaseInstructions! ? "verify" : "archive";
	assert.equal(completed.nextRecommended, next);
	selection = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: next });
	const completion = await hooks.get("before_agent_start")!({ systemPrompt: `SDD ${next} executor` }, ctx);
	assert.doesNotMatch(completion.systemPrompt, /SDD selection blocked:/);
	assert.ok(completion.systemPrompt.includes(JSON.stringify(completed, null, 2)));
	for (const selected of [true, false]) {
		for (const phase of new Set([next, "verify"])) {
			selection = selected ? JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase }) : undefined;
			const result = await hooks.get("before_agent_start")!({ systemPrompt: `SDD ${phase} executor` }, ctx);
			assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
			assert.ok(result.systemPrompt.includes(JSON.stringify(completed, null, 2)));
		}
	}
	writeFileSync(join(change, "verify-report.md"), "# Verification\nPASS\n");
	const practical = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
	assert.equal(practical.nextRecommended, next, "plain PASS cannot bypass a legacy provider's emitted evidence requirements");
	if (next === "verify") assert.ok(practical.blockedReasons.some((reason) => reason.includes("verification evidence")));
	for (const selected of [true, false]) {
		selection = selected ? JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: next }) : undefined;
		const result = await hooks.get("before_agent_start")!({ systemPrompt: `SDD ${next} executor` }, ctx);
		assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
		assert.ok(result.systemPrompt.includes(JSON.stringify(practical, null, 2)), "forward exact current provider instructions, including legacy evidence requirements");
	}
	writeFileSync(join(change, "tasks.md"), "- [ ] 1.1 Implement\n");
	const partial = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
	selection = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "verify" });
	const partialVerify = await hooks.get("before_agent_start")!({ systemPrompt: "SDD verify executor" }, ctx);
	if (partial.dependencies.verify === "ready") {
		assert.doesNotMatch(partialVerify.systemPrompt, /SDD selection blocked:/);
		assert.ok(partialVerify.systemPrompt.includes(JSON.stringify(partial, null, 2)));
	} else {
		assert.match(partialVerify.systemPrompt, /SDD selection blocked:/, "do not override the pinned provider's verification readiness");
	}
	for (const selected of [true, false]) {
		selection = selected ? JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "archive" }) : undefined;
		assert.match((await hooks.get("before_agent_start")!({ systemPrompt: "SDD archive executor" }, ctx)).systemPrompt, /SDD selection blocked:/);
	}
	const outside = join(root, "..", "ungranted-source.ts");
	writeFileSync(join(change, "tasks.md"), `- [ ] Edit \`${outside}\`\n`);
	const denied = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
	assert.ok(denied.blockedReasons.some((reason) => reason.includes("edit_authority_missing")));
	assert.deepEqual(denied.actionContext.allowedEditRoots, [root]);
	selection = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "archive" });
	assert.match((await hooks.get("before_agent_start")!({ systemPrompt: "SDD archive executor" }, ctx)).systemPrompt, /SDD selection blocked:/);

	// Optional local integration proof uses the real Engram CLI, but never the
	// user's data directory. No in-memory status substitute proves persistence.
	if (process.env.SDD_TEST_ENGRAM) {
		const originalData = process.env.ENGRAM_DATA_DIR;
		const originalProject = process.env.ENGRAM_PROJECT;
		try {
			process.env.ENGRAM_PROJECT = "pi-sdd-parity-fixture";
			writeFileSync(join(root, "openspec/config.yaml"), "sdd:\n  artifact_store: engram\n");
			rmSync(join(root, "openspec/changes"), { recursive: true });
			for (const complete of [false, true]) {
				await t.test(`persisted Engram complete=${complete}`, async () => {
					process.env.ENGRAM_DATA_DIR = join(root, `memory-${complete}`);
					for (const [kind, content] of Object.entries({ proposal: "# Proposal", spec: "# Spec", design: "# Design",
						tasks: complete ? "- [x] 1.1 Implement" : "- [ ] 1.1 Implement" })) {
						execFileSync(process.env.SDD_TEST_ENGRAM!, ["save", `sdd/alpha/${kind}`, content, "--project", "pi-sdd-parity-fixture", "--scope", "project"], { cwd: root, stdio: "pipe" });
					}
					const memory = await native.sddStatus!({ workspaceRoot: root, changeName: "alpha" });
					assert.equal(memory.artifactStore, "engram");
					assert.equal(memory.nextRecommended, complete ? next : "apply");
					for (const selected of [true, false]) {
						selection = selected ? JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: memory.nextRecommended }) : undefined;
						const result = await hooks.get("before_agent_start")!({ systemPrompt: `SDD ${memory.nextRecommended} executor` }, ctx);
						assert.doesNotMatch(result.systemPrompt, /SDD selection blocked:/);
						assert.ok(result.systemPrompt.includes(JSON.stringify(memory, null, 2)));
					}
					if (!complete) {
						selection = JSON.stringify({ changeName: "alpha", workspaceRoot: root, phase: "archive" });
						assert.match((await hooks.get("before_agent_start")!({ systemPrompt: "SDD archive executor" }, ctx)).systemPrompt, /SDD selection blocked:/);
					}
				});
			}
		} finally {
			if (originalData === undefined) delete process.env.ENGRAM_DATA_DIR; else process.env.ENGRAM_DATA_DIR = originalData;
			if (originalProject === undefined) delete process.env.ENGRAM_PROJECT; else process.env.ENGRAM_PROJECT = originalProject;
		}
	}
});

test("status command renders native facts without confirmation, mutation, or phase launch", async (t) => {
	const root = workspace(t);
	const status = commandStatus(root);
	const h = commandHarness(root, status, true);
	await h.run("status");
	assert.deepEqual(h.calls, ["status"]);
	assert.deepEqual(JSON.parse(h.notices[0]!), status);
	assert.deepEqual(h.confirmations, []);
});

test("only exact marker confirmation permits continuation, never source authority or launch", async (t) => {
	const root = workspace(t);
	const status = commandStatus(root);
	const h = commandHarness(root, status, true);
	await h.run("continue");
	assert.deepEqual(h.calls, ["status", "continue"]);
	assert.equal(h.confirmations.length, 1);
	assert.ok(h.confirmations[0]!.includes(join(root, "openspec/changes/alpha/.gentle-ai-instance")));
	assert.match(h.confirmations[0]!, /no source.*no persistent/i);
	assert.deepEqual(JSON.parse(h.notices[0]!), status);
});

test("read-only, excluded-marker, cancellation and headless scope suppress every mutation", async (t) => {
	const root = workspace(t);
	for (const [answer, hasUI] of [[false, true], [undefined, true], ["yes", true], [true, false]]) {
		const h = commandHarness(root, commandStatus(root), answer, hasUI as boolean);
		await h.run("continue");
		assert.deepEqual(h.calls, ["status"]);
	}
});

test("malformed recommendation and misleading prose refuse before continuation or phase launch", async (t) => {
	const root = workspace(t);
	for (const nextRecommended of ["sdd-apply", "unknown", null]) {
		const h = commandHarness(root, { ...commandStatus(root), nextRecommended });
		await assert.rejects(() => h.run("continue"), /native SDD|recommendation|enum|expected string/i);
		assert.deepEqual(h.calls, ["status"]);
		assert.deepEqual(h.confirmations, []);
	}
});

test("continuation rejects workspace mismatch and missing UI; marker-only confirmation grants no roots", async (t) => {
	const root = workspace(t);
	const mismatch = commandHarness(root, { ...commandStatus(root), actionContext: { workspaceRoot: "/other" } }, true);
	await assert.rejects(() => mismatch.run("continue"), /workspace/);
	assert.deepEqual(mismatch.calls, ["status"]);
	const missingUI = commandHarness(root, commandStatus(root), true);
	Object.assign(missingUI.ctx, { ui: undefined });
	await missingUI.run("continue");
	assert.deepEqual(missingUI.calls, ["status"]);
	const status = commandStatus(root);
	status.actionContext.allowedEditRoots = [];
	const markerOnly = commandHarness(root, status, true);
	await assert.rejects(() => markerOnly.run("continue"), /allowed edit roots/i);
	assert.deepEqual(markerOnly.calls, ["status"]);
});

test("managed apply guidance refuses local reconstruction and preserves native authority", () => {
	const guidance = readFileSync(new URL("../assets/agents/sdd-apply.md", import.meta.url), "utf8");
	assert.doesNotMatch(guidance, /resolve-via-engram|produce the same fields|Proceed with implementation once those artifacts/);
	assert.match(guidance, /native.*v2/i);
});

test("unsafe planning context and marker symlink refuse before mutation", async (t) => {
	const root = workspace(t);
	for (const patch of [{ artifactStore: "engram" }, { actionContext: { mode: "unknown", workspaceRoot: root } }]) {
		const h = commandHarness(root, { ...commandStatus(root), ...patch }, true);
		await assert.rejects(() => h.run("continue"), /native SDD/i);
		assert.deepEqual(h.calls, ["status"]);
	}
	symlinkSync(join(root, "openspec/changes/beta"), join(root, "openspec/changes/alpha/.gentle-ai-instance"));
	const h = commandHarness(root, commandStatus(root), true);
	await assert.rejects(() => h.run("continue"), /marker/i);
	assert.deepEqual(h.calls, ["status"]);
});


test("typed remediation selection preserves native failed evidence and refuses stale binding", async (t) => {
	const root = workspace(t), revision = `sha256:${"a".repeat(64)}`;
	const selection = { changeName: "alpha", workspaceRoot: root, phase: "remediate", failedEvidenceRevision: revision };
	const fixture: NativeSddStatusV2 = { schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "alpha", artifactStore: "openspec", planningHome: { mode: "repo-local", path: join(root, "openspec") }, changeRoot: join(root, "openspec/changes/alpha"), actionContext: { mode: "repo-local", workspaceRoot: root, allowedEditRoots: [root] }, dependencies: Object.fromEntries(["proposal", "specs", "design", "tasks", "apply", "verify", "archive"].map(key => [key, "ready"])) as NativeSddStatusV2["dependencies"], phaseInstructions: { apply: [], verify: [], remediate: ["Correct failed evidence"], archive: [] }, blockedReasons: [], nextRecommended: "remediate", remediationState: { required: true, complete: false, failedEvidenceRevision: revision } };
	const result = await __testing.resolveSelectedNativeSddChangeStartup(JSON.stringify(selection), root, "sdd-remediate", { sddStatus: async () => fixture });
	assert.equal(result.selection.failedEvidenceRevision, revision);
	await assert.rejects(__testing.resolveSelectedNativeSddChangeStartup(JSON.stringify({ ...selection, failedEvidenceRevision: `sha256:${"b".repeat(64)}` }), root, "sdd-remediate", { sddStatus: async () => fixture }), /remediation/);
	assert.throws(() => decodeNativeSddStatusV2({ ...fixture, remediationState: { failedEvidenceRevision: "bad" } }, { workspaceRoot: root, changeName: "alpha" }), /remediation/);
});
