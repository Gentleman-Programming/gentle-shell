import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function harness(processEnv: NodeJS.ProcessEnv = {}, activeTools = ["read", "edit", "write", "subagent_run"], sddRoot?: string): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
		getFlag: () => sddRoot ? JSON.stringify({ changeName: "isolation", workspaceRoot: sddRoot, phase: "apply" }) : undefined,
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: sddRoot ? {
			sddStatus: async () => ({
				schemaName: "gentle-ai.sdd-status", schemaVersion: 2, changeName: "isolation", artifactStore: "openspec",
				planningHome: { mode: "repo-local", path: join(sddRoot, "openspec") }, changeRoot: join(sddRoot, "openspec", "changes", "isolation"),
				actionContext: { mode: "repo-local", workspaceRoot: sddRoot, allowedEditRoots: [sddRoot] },
				dependencies: { proposal: "all_done", specs: "all_done", design: "all_done", tasks: "all_done", apply: "ready", verify: "blocked", archive: "blocked" },
				phaseInstructions: { apply: [], verify: [], archive: [] }, blockedReasons: [], nextRecommended: "apply",
			}),
		} as unknown as NativeReviewCli : null,
		processEnv,
		resolveTelemetryTriggerBinary: () => "/usr/bin/true",
		telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	return handlers;
}

async function successfulMutation(handlers: Map<string, Handler>, ctx: ExtensionContext, toolName: "edit" | "write", path: string): Promise<void> {
	assert.equal(await handlers.get("tool_call")!({ toolName, input: { path } }, ctx), undefined);
	await handlers.get("tool_result")!({ toolName, toolCallId: `${toolName}-${path}`, input: { path }, isError: false }, ctx);
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "interactive",
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "odd-runtime-delegation-red" },
	} as unknown as ExtensionContext;
}

test("primary ODD runtime blocks the second distinct direct source write before mutation", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-runtime-gate-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd });
		mkdirSync(join(cwd, "src"));
		const firstPath = join(cwd, "src", "first.ts");
		const secondPath = join(cwd, "src", "second.ts");
		const handlers = harness();
		const beforeAgentStart = handlers.get("before_agent_start");
		const toolCall = handlers.get("tool_call");
		const toolResult = handlers.get("tool_result");
		assert.equal(typeof beforeAgentStart, "function");
		assert.equal(typeof toolCall, "function");
		assert.equal(typeof toolResult, "function");
		const ctx = context(cwd);

		await beforeAgentStart!({ systemPrompt: "primary" }, ctx);
		assert.equal(await toolCall!({ toolName: "edit", input: { path: firstPath } }, ctx), undefined);
		await toolResult!({
			toolName: "edit",
			toolCallId: "first-direct-edit",
			input: { path: firstPath },
			isError: false,
		}, ctx);

		const second = await toolCall!({
			toolName: "write",
			input: { path: secondPath, content: "export const second = true;\n" },
		}, ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(second?.block, true, "the second distinct direct source file must be refused before mutation");
		assert.match(second?.reason ?? "", /subagent_run/);
		assert.match(second?.reason ?? "", /gentle-ai-worker/);

		assert.equal(await toolCall!({ toolName: "edit", input: { path: firstPath } }, ctx), undefined, "same-file edits stay direct");
		assert.equal(await toolCall!({ toolName: "write", input: { path: join(cwd, "odd", "tasks", "feature.md") } }, ctx), undefined, "ODD bookkeeping is excluded");

		await beforeAgentStart!({ systemPrompt: "fresh primary turn" }, ctx);
		await toolResult!({ toolName: "write", toolCallId: "failed", input: { path: firstPath }, isError: true }, ctx);
		assert.equal(await toolCall!({ toolName: "write", input: { path: secondPath } }, ctx), undefined, "failed calls do not consume the direct-file budget");
		await successfulMutation(handlers, ctx, "write", secondPath);
		assert.equal((await toolCall!({ toolName: "write", input: { path: firstPath } }, ctx) as { block?: boolean })?.block, true);

		await beforeAgentStart!({ systemPrompt: "next primary turn" }, ctx);
		assert.equal(await toolCall!({ toolName: "write", input: { path: firstPath } }, ctx), undefined, "a primary restart resets ephemeral state");

		await beforeAgentStart!({ systemPrompt: "bookkeeping turn" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "odd", "tasks", "feature.md"));
		assert.equal(await toolCall!({ toolName: "write", input: { path: secondPath } }, ctx), undefined, "successful ODD bookkeeping consumes no budget");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the refusal stops honestly when delegation is unavailable", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-no-delegation-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd });
		const handlers = harness({}, ["edit", "write"]);
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "first.ts"));
		const refused = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "second.ts") } }, ctx) as { reason?: string };
		assert.match(refused.reason ?? "", /Stop and report that no delegation mechanism is callable/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a nested named child cannot erase its primary parent's recorded path", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-nested-child-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd });
		const handlers = harness();
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "first.ts"));
		await handlers.get("before_agent_start")!({ agentName: "gentle-ai-worker", systemPrompt: "named child" }, ctx);
		await handlers.get("agent_end")!({}, ctx);
		const resumed = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "second.ts") } }, ctx) as { block?: boolean } | undefined;
		assert.equal(resumed?.block, true, "a completed child must not disable its resumed parent's gate");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("canonical absolute targets remain inside a repository reached through a nested symlink cwd", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-odd-real-root-")));
	const aliases = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-odd-cwd-alias-")));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		mkdirSync(join(root, "workspace", "nested"), { recursive: true });
		const linkedRoot = join(aliases, "repository");
		symlinkSync(root, linkedRoot, "dir");
		const ctx = context(join(linkedRoot, "workspace", "nested"));
		const handlers = harness();
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(root, "workspace", "nested", "first.ts"));
		const second = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(root, "workspace", "nested", "second.ts") } }, ctx) as { block?: boolean } | undefined;
		assert.equal(second?.block, true, "canonical absolute targets must not be rebased through the lexical symlink cwd");
	} finally {
		rmSync(aliases, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("canonical paths collapse aliases and cannot disguise source as ODD bookkeeping", async (t) => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-canonical-path-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd });
		mkdirSync(join(cwd, "src"));
		mkdirSync(join(cwd, "odd", "tasks"), { recursive: true });
		const firstPath = join(cwd, "src", "first.ts");
		const secondPath = join(cwd, "src", "second.ts");
		writeFileSync(firstPath, "");
		writeFileSync(secondPath, "");
		symlinkSync("first.ts", join(cwd, "src", "alias.ts"));
		symlinkSync("../../src/second.ts", join(cwd, "odd", "tasks", "source.ts"));
		const handlers = harness();
		const ctx = context(cwd);
		await t.test("an alias of the recorded file remains the same canonical path", async () => {
			await handlers.get("before_agent_start")!({ systemPrompt: "primary alias turn" }, ctx);
			await successfulMutation(handlers, ctx, "write", firstPath);
			assert.equal(await handlers.get("tool_call")!({ toolName: "edit", input: { path: join(cwd, "src", "alias.ts") } }, ctx), undefined);
		});

		await t.test("a bookkeeping symlink to source remains an eligible second file", async () => {
			await handlers.get("before_agent_start")!({ systemPrompt: "primary bookkeeping turn" }, ctx);
			await successfulMutation(handlers, ctx, "write", firstPath);
			const disguised = await handlers.get("tool_call")!({ toolName: "edit", input: { path: join(cwd, "odd", "tasks", "source.ts") } }, ctx) as { block?: boolean } | undefined;
			assert.equal(disguised?.block, true);
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("delegated child actors retain multi-file write authority", async () => {
	for (const [label, processEnv, startEvent] of [
		["named", {}, { agentName: "gentle-ai-worker", systemPrompt: "named child" }],
		["SDD", {}, { agentName: "sdd-apply", systemPrompt: "SDD apply executor" }],
		["RPC", { GENTLE_PI_AGENTS_CHILD: "1" }, { systemPrompt: "owned RPC child" }],
	] as const) {
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), `gentle-pi-odd-${label}-`)));
		try {
			execFileSync("git", ["init", "--quiet"], { cwd });
			mkdirSync(join(cwd, "src"));
			const handlers = harness(processEnv, undefined, label === "SDD" ? cwd : undefined);
			const ctx = context(cwd);
			await handlers.get("before_agent_start")!(startEvent, ctx);
			await successfulMutation(handlers, ctx, "write", join(cwd, "src", "first.ts"));
			await successfulMutation(handlers, ctx, "edit", join(cwd, "src", "second.ts"));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});
