import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	ODD_OPTIONAL_MODULES,
	resolveOddSlimPolicy,
	writeOddSlimPolicy,
} from "../lib/odd-slim-policy.ts";

test("odd-slim defaults to disabled with empty optional modules and persists normalized updates", (t) => {
	const home = mkdtempSync(join(tmpdir(), "odd-slim-policy-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const initial = resolveOddSlimPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(initial.policy, { enabled: false, modules: [] });
	assert.equal(initial.source, "default");

	writeOddSlimPolicy({ enabled: true, modules: ["verification", "tracking", "verification"] }, {
		gentlePiConfigHome: home,
	});
	const updated = resolveOddSlimPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(updated.policy, { enabled: true, modules: ["tracking", "verification"] });
	assert.equal(updated.source, "global_file");
	assert.deepEqual([...ODD_OPTIONAL_MODULES], ["tracking", "verification", "4r-review", "judgment-day"]);
});

test("odd-slim omits tracking and verification rules unless explicitly enabled", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "odd-slim-prompt-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");

	const renderWithPolicy = async (enabled: boolean, modules: ("tracking" | "verification")[]) => {
		writeOddSlimPolicy({ enabled, modules }, { gentlePiConfigHome: configHome });
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
			nativeReviewCli: null,
			processEnv: {
				HOME: root,
				USERPROFILE: root,
				GENTLE_PI_CONFIG_HOME: configHome,
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
			sessionManager: { getSessionId: () => `odd-slim-${enabled}-${modules.join("-")}`, getEntries: () => [], getLeafId: () => undefined },
		} as unknown as ExtensionContext);
		return event.systemPromptOptions.appendSystemPrompt;
	};

	const slimOnly = await renderWithPolicy(true, []);
	assert.ok(!slimOnly.includes("orchestrator-tracking.md"));
	assert.ok(!slimOnly.includes("**High risk**:"));
	assert.ok(slimOnly.includes("ODD-slim mode: enabled (optional modules: none)."));

	const withTracking = await renderWithPolicy(true, ["tracking"]);
	assert.ok(withTracking.includes("orchestrator-tracking.md"));
	assert.ok(!withTracking.includes("**High risk**:"));
});
