import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NATIVE_REVIEW_MODE_SOURCE } from "../lib/native-review-cli.ts";

test("omits Gentle AI RDD ownership and review disable guidance when RDD is off", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-rdd-off-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;

	createGentleAiExtension({
		nativeReviewCli: {
			reviewMode: async () => ({
				status: {
					schema: "gentle-ai.rdd-mode-status/v1",
					effective: "off",
					source: NATIVE_REVIEW_MODE_SOURCE.DEFAULT,
				},
			}),
		} as never,
		processEnv: {
			HOME: root,
			USERPROFILE: root,
			GENTLE_PI_CONFIG_HOME: join(root, "config"),
			GENTLE_PI_AGENT_HOME: join(root, "agents"),
			PI_CODING_AGENT_DIR: join(root, "pi"),
			XDG_CONFIG_HOME: join(root, "xdg"),
			GENTLE_PI_AGENTS_CHILD: "0",
			GENTLE_AI_TELEMETRY: "0",
		},
	})(pi);

	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	await handlers.get("before_agent_start")!(event, {
		cwd: root,
		hasUI: false,
		mode: "interactive",
		sessionManager: { getSessionId: () => "rdd-off-test", getEntries: () => [], getLeafId: () => undefined },
	} as unknown as ExtensionContext);

	const appended = event.systemPromptOptions.appendSystemPrompt;
	assert.ok(!appended.includes("## Gentle AI RDD ownership"), "RDD ownership section must be omitted when RDD is off");
	assert.ok(!appended.includes("review execution contract"), "review execution contract must be omitted when RDD is off");
	assert.ok(!appended.includes("gentle-ai review mode disable"), "RDD disable guidance must be omitted when RDD is already off");
});
