import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { isSddPreflightTrigger, sddPreflightDiskPath } from "../lib/sdd-preflight.ts";

// gentle-pi#1001: the natural-language SDD `input` hook called the parent-only
// preflight resolver for every matching prompt, RPC children included.
// `ensureSddPreflight` rejects RPC by design, the hook caught that rejection and
// answered `handled`, and Pi's `AgentSession.prompt()` accepts handled input and
// returns before `before_agent_start` and the model loop. A delegated child
// therefore ACKed a prompt it never ran: no agent_start, zero turns, zero tool
// calls, and a stall that only surfaced as the runner's inactivity timeout.
//
// An RPC child consumes the parent-rendered preflight block transported in its
// task context. It must never originate preflight, and the interceptor must
// never consume a delegated prompt on its behalf.

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

test("the delegated task text reaches the preflight interceptor", () => {
	// Guards the premise of the tests below: if the classifier stops matching
	// this text they would pass for the wrong reason.
	assert.equal(isSddPreflightTrigger(DELEGATED_SDD_TASK), true);
});

test("an RPC child's matching prompt is not consumed by the preflight interceptor", async () => {
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

test("an interactive parent still resolves preflight for a matching prompt", async () => {
	const input = inputHook();
	const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-parent-input-"));
	const agentHome = await mkdtemp(join(tmpdir(), "gentle-pi-parent-agent-home-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	try {
		const result = await input(
			{ text: DELEGATED_SDD_TASK },
			ctx({
				cwd,
				hasUI: false,
				sessionManager: { getSessionId: () => "sdd-preflight-interactive-parent" },
			}),
		);
		assert.deepEqual(result, { action: "continue" });
		assert.equal(
			existsSync(sddPreflightDiskPath(cwd)),
			true,
			"the parent remains the only actor that resolves and persists preflight",
		);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		await rm(cwd, { recursive: true, force: true });
		await rm(agentHome, { recursive: true, force: true });
	}
});
