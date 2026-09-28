import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

test("a second direct file is not refused based on session write history", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-direct-"));
	try {
		execFileSync("git", ["init", "--quiet"], { cwd });
		const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
		const pi = {
			on(name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
			events: { emit() {} }, registerCommand() {}, registerTool() {}, getFlag: () => undefined,
			getActiveTools: () => ["edit", "write"],
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: null, processEnv: {}, resolveTelemetryTriggerBinary: () => "/usr/bin/true", telemetryTriggerSpawn: (() => undefined) as never })(pi);
		const ctx = {
			cwd, hasUI: false, mode: "interactive", ui: { notify() {} },
			sessionManager: { getSessionId: () => "odd-direct" },
		} as unknown as ExtensionContext;
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		const first = { path: join(cwd, "first.ts") };
		assert.equal(await handlers.get("tool_call")!({ toolName: "edit", input: first }, ctx), undefined);
		await handlers.get("tool_result")!({ toolName: "edit", toolCallId: "first", input: first, isError: false }, ctx);
		assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "second.ts"), content: "export const second = true;\n" } }, ctx), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
