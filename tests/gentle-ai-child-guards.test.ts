import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { bindSessionRepositoryPreparation } from "../lib/bounded-writer-admission.ts";
import { GENTLE_AI_TIMING_ENTRY } from "../lib/gentle-ai-elapsed-store.ts";
import { REVIEW_SIDEBAR_EVENT } from "../lib/review-sidebar-state.ts";
import { YOLO_STATUS_KEY } from "../lib/yolo-session-policy.ts";

// gentle-shell#1690: the package is forwarded to delegated rpc children
// (GENTLE_PI_AGENTS_CHILD=1, where ctx.hasUI is true). Parent-owned startup
// work and shared-state writes must not run there; each case pairs the child
// with a parent control so the guard cannot pass vacuously.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function isolate(t: TestContext): { root: string; cwd: string; agentHome: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-child-guards-")));
	const cwd = join(root, "project");
	const agentHome = join(root, "agent-home");
	const configHome = join(root, "config");
	for (const path of [cwd, agentHome, configHome]) mkdirSync(path, { recursive: true });
	const previous = { agentHome: process.env.GENTLE_PI_AGENT_HOME, configHome: process.env.GENTLE_PI_CONFIG_HOME };
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previous.agentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous.agentHome;
		if (previous.configHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous.configHome;
		rmSync(root, { recursive: true, force: true });
	});
	return { root, cwd, agentHome };
}

function harness(child: boolean, cwd: string) {
	const handlers = new Map<string, Handler>();
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	const nativeAccesses: string[] = [];
	const sweeps: string[] = [];
	const prompts: string[] = [];
	const statuses: Array<[string, string | undefined]> = [];
	const emitted: Array<{ name: string; payload: unknown }> = [];
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		events: { on() {}, emit: (name: string, payload: unknown) => { emitted.push({ name, payload }); } },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		getThinkingLevel: () => "medium",
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	// Any read of the native CLI means the session reached review negotiation
	// or repository preparation.
	const nativeReviewCli = new Proxy({}, {
		get: (_target, key) => { nativeAccesses.push(String(key)); return undefined; },
	});
	const candidateViews = { sweepOrphans: (path: string) => { sweeps.push(path); }, cleanupAll() {} };
	createGentleAiExtension({
		processEnv: { GENTLE_PI_AGENTS_CHILD: child ? "1" : "0", GENTLE_AI_TELEMETRY: "0" },
		nativeReviewCli: nativeReviewCli as never,
		candidateViews: candidateViews as never,
		childStandingReviewPermissionClient: { requestAuthorization: async () => false, close() {} },
	})(pi);
	const sessionManager = { getSessionId: () => `session-${child ? "child" : "parent"}`, getCwd: () => cwd, getEntries: () => entries, getBranch: () => entries };
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: true,
		sessionManager,
		ui: {
			notify() {},
			setStatus: (key: string, text?: string) => { statuses.push([key, text]); },
			confirm: async (title: string) => { prompts.push(`confirm:${title}`); return false; },
			select: async (title: string) => { prompts.push(`select:${title}`); return undefined; },
		},
	} as unknown as ExtensionContext;
	return { handlers, entries, nativeAccesses, sweeps, prompts, statuses, emitted, tools, ctx, sessionManager };
}

function legacySettings(cwd: string): string {
	const path = join(cwd, ".pi", "settings.json");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ subagents: { agentOverrides: { worker: "openai/gpt-5" } } }, null, 2)}\n`);
	return path;
}

test("child session_start keeps local resets but skips parent-owned startup work", async (t) => {
	const { cwd, agentHome } = isolate(t);
	const settingsPath = legacySettings(cwd);
	const before = readFileSync(settingsPath, "utf8");
	const h = harness(true, cwd);
	const timings = () => h.entries.filter((entry) => entry.customType === GENTLE_AI_TIMING_ENTRY);
	await h.handlers.get("tool_execution_start")!({ toolName: "gentle_review", toolCallId: "before" }, h.ctx);
	assert.equal(timings().length, 0, "no elapsed-timing ledger exists before session_start");
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.handlers.get("tool_execution_start")!({ toolName: "gentle_review", toolCallId: "after" }, h.ctx);
	assert.equal(timings().length, 1, "the child still creates its elapsed-timing ledger");
	assert.deepEqual(readdirSync(agentHome), [], "a child must not install package assets");
	assert.equal(readFileSync(settingsPath, "utf8"), before, "a child must not migrate project model overrides");
	assert.deepEqual(h.sweeps, [], "a child must not sweep candidate views");
	assert.deepEqual(h.nativeAccesses, [], "a child must not negotiate review status or bind repository preparation");
});

test("parent session_start still runs the startup work skipped in children", async (t) => {
	const { cwd, agentHome } = isolate(t);
	const settingsPath = legacySettings(cwd);
	const before = readFileSync(settingsPath, "utf8");
	const h = harness(false, cwd);
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	assert.notDeepEqual(readdirSync(agentHome), [], "the parent installs package assets");
	assert.notEqual(readFileSync(settingsPath, "utf8"), before, "the parent migrates legacy project model overrides");
	assert.deepEqual(h.sweeps, [cwd]);
	assert.ok(h.nativeAccesses.length > 0, "the parent negotiates review status");
});

test("child session_start re-arms the reminder session for its own session manager", async (t) => {
	const { cwd } = isolate(t);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "a.ts"), "export {};\n");
	const h = harness(true, cwd);
	const next = { ...h.sessionManager, getSessionId: () => "session-child-next" };
	const nextCtx = { ...h.ctx, sessionManager: next } as unknown as ExtensionContext;
	const write = (ctx: ExtensionContext, toolCallId: string) => h.handlers.get("tool_result")!({ toolName: "write", toolCallId, isError: false, input: { path: "src/a.ts" } }, ctx);
	const mutations = () => h.entries.filter((entry) => (entry.data as { kind?: string })?.kind === "mutation");
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_shutdown")!({ reason: "new" }, h.ctx);
	await write(h.ctx, "after-shutdown");
	assert.equal(mutations().length, 0, "a shut-down session records nothing");
	await h.handlers.get("session_start")!({ reason: "new" }, nextCtx);
	await write(h.ctx, "stale-manager");
	assert.equal(mutations().length, 0, "the reminder manager moved to the new session");
	await write(nextCtx, "current-manager");
	assert.equal(mutations().length, 1, "the restarted child records its own mutation");
});

test("child session_start re-arms YOLO and the review sidebar for its own session", async (t) => {
	const { cwd } = isolate(t);
	const h = harness(true, cwd);
	const next = { ...h.sessionManager, getSessionId: () => "session-child-next" };
	const nextCtx = { ...h.ctx, sessionManager: next } as unknown as ExtensionContext;
	const yoloClears = () => h.statuses.filter(([key, text]) => key === YOLO_STATUS_KEY && text === undefined).length;
	const sidebarSessions = () => h.emitted.filter((event) => event.name === REVIEW_SIDEBAR_EVENT)
		.map((event) => (event.payload as { sessionId: string }).sessionId);
	// Any non-assess call passes through the sidebar wrapper, which publishes
	// before running; the native outcome itself is irrelevant here.
	const capture = async (ctx: ExtensionContext, toolCallId: string) => {
		try { await h.tools.get("gentle_review_capture")!.execute(toolCallId, {}, undefined, undefined, ctx as never); } catch { /* outcome irrelevant */ }
	};
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	await h.handlers.get("session_shutdown")!({ reason: "new" }, h.ctx);
	await capture(h.ctx, "after-shutdown");
	assert.deepEqual(sidebarSessions(), [], "a shut-down sidebar publishes nothing");
	const clearsBeforeRestart = yoloClears();
	await h.handlers.get("session_start")!({ reason: "new" }, nextCtx);
	assert.equal(yoloClears(), clearsBeforeRestart + 1, "the child session_start resets YOLO and clears its indicator");
	await capture(h.ctx, "stale-session");
	assert.deepEqual(sidebarSessions(), [], "the sidebar moved to the new session");
	await capture(nextCtx, "current-session");
	assert.ok(sidebarSessions().length > 0, "the restarted child sidebar publishes again");
	assert.ok(sidebarSessions().every((id) => id === "session-child-next"), JSON.stringify(sidebarSessions()));
});

async function writeToolResult(child: boolean, t: TestContext) {
	const { cwd } = isolate(t);
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "a.ts"), "export {};\n");
	const h = harness(child, cwd);
	await h.handlers.get("session_start")!({ reason: "startup" }, h.ctx);
	// Bind an observable preparation on the same session owner the parent
	// session_start would have bound, so only the tool_result guard decides.
	const preparations: string[] = [];
	const unbind = bindSessionRepositoryPreparation(h.sessionManager, cwd, async (root) => { preparations.push(root); return false; }, () => true);
	t.after(unbind);
	await h.handlers.get("tool_result")!({ toolName: "write", toolCallId: "call-1", isError: false, input: { path: "src/a.ts" } }, h.ctx);
	const mutations = h.entries.filter((entry) => (entry.data as { kind?: string })?.kind === "mutation");
	return { cwd, preparations, mutations };
}

test("child tool_result records the mutation but never prepares the bound repository", async (t) => {
	const { preparations, mutations } = await writeToolResult(true, t);
	assert.equal(mutations.length, 1, "the child keeps its own mutation receipt");
	assert.deepEqual(preparations, []);
});

test("parent tool_result still prepares the bound repository", async (t) => {
	const { cwd, preparations, mutations } = await writeToolResult(false, t);
	assert.equal(mutations.length, 1);
	assert.deepEqual(preparations, [cwd]);
});

test("child confirm-class guardrail commands ask the parent instead of running or blocking headlessly", async (t) => {
	const { cwd } = isolate(t);
	const h = harness(true, cwd);
	const result = await h.handlers.get("tool_call")!({ toolName: "bash", input: { command: "pi remove some-package" } }, h.ctx) as { block?: boolean; reason?: string } | undefined;
	assert.equal(h.prompts.length, 1, JSON.stringify(h.prompts));
	assert.equal(result?.block, true, "the declined confirmation blocks the command");
	assert.doesNotMatch(result?.reason ?? "", /requires interactive confirmation/);
});
