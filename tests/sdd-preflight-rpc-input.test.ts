import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { isSddPreflightTrigger, sddPreflightDiskPath } from "../lib/sdd-preflight.ts";

// The `input` hook is syntax-only: slash SDD commands may originate preflight
// in an interactive parent, while ordinary natural-language text always reaches
// the model. Natural-language SDD selection belongs to the parent/orchestrator;
// dispatch and before_agent_start gates enforce preflight at the action boundary.
// RPC children consume the parent-rendered preflight block transported in task
// context and never originate preflight.

type InputResult = { action: "continue" | "handled" };
type InputHandler = (event: { text?: unknown }, ctx: ExtensionContext) => Promise<InputResult>;

const DELEGATED_SDD_TASK = "Implement the accepted SDD change.";

function inputHook(): InputHandler {
	const handlers = new Map<string, InputHandler>();
	const pi = {
		on(name: string, handler: InputHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const input = handlers.get("input");
	assert.equal(typeof input, "function", "the extension must register an input hook");
	return input as InputHandler;
}

function ctx(overrides: Record<string, unknown>): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "sdd-preflight-rpc-input" },
		...overrides,
	} as unknown as ExtensionContext;
}

test("natural-language SDD task text bypasses the input preflight interceptor", () => {
	assert.equal(isSddPreflightTrigger(DELEGATED_SDD_TASK), false);
});

test("an RPC child's natural-language SDD prompt is not consumed by the input hook", async () => {
	const input = inputHook();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-rpc-input-"));
	const notifications: string[] = [];
	try {
		const result = await input(
			{ text: DELEGATED_SDD_TASK },
			ctx({
				cwd,
				mode: "rpc",
				sessionManager: { getSessionId: () => "sdd-preflight-rpc-child" },
				ui: { notify: (message: string) => notifications.push(message) },
			}),
		);
		assert.deepEqual(result, { action: "continue" }, "a delegated prompt must reach the agent");
		assert.deepEqual(notifications, [], "an RPC child must not originate preflight at all");
		assert.equal(existsSync(sddPreflightDiskPath(cwd)), false, "an RPC child must not persist defaults");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an RPC child's ordinary prompt still continues", async () => {
	const input = inputHook();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-rpc-input-control-"));
	try {
		const result = await input(
			{ text: "Implement a small Rust selection type." },
			ctx({ cwd, mode: "rpc", sessionManager: { getSessionId: () => "sdd-preflight-rpc-control" } }),
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(existsSync(sddPreflightDiskPath(cwd)), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an interactive parent's natural-language SDD request has no input-hook side effect", async () => {
	const input = inputHook();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-parent-natural-input-"));
	try {
		const result = await input(
			{ text: DELEGATED_SDD_TASK },
			ctx({ cwd, hasUI: false, sessionManager: { getSessionId: () => "sdd-preflight-natural-parent" } }),
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(existsSync(sddPreflightDiskPath(cwd)), false, "text alone must not persist preflight");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("an interactive parent still resolves preflight for an explicit slash SDD command", async () => {
	const input = inputHook();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-parent-slash-input-"));
	const agentHome = await mkdtemp(join(tmpdir(), "gentle-pi-parent-agent-home-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	try {
		const result = await input(
			{ text: "/sdd-new feature" },
			ctx({ cwd, hasUI: false, sessionManager: { getSessionId: () => "sdd-preflight-slash-parent" } }),
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(existsSync(sddPreflightDiskPath(cwd)), true, "slash SDD commands still resolve preflight");
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		await rm(cwd, { recursive: true, force: true });
		await rm(agentHome, { recursive: true, force: true });
	}
});
