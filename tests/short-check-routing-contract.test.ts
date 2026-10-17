import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJobRegistry } from "../lib/background-jobs.ts";
import { registerBackgroundJobTools } from "../lib/background-jobs-tools.ts";

// Guidance contract, not runtime routing or a performance guarantee.
const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
registerBackgroundJobTools({ registerTool: (tool) => tools.push(tool), registerMessageRenderer: () => {} } as unknown as ExtensionAPI, {
	registry: createJobRegistry({
		outputDir: () => { throw new Error("Guidance contracts must not write job logs"); },
		now: () => 0,
		shell: () => { throw new Error("Guidance contracts must not execute jobs"); },
		onSettled: () => {},
	}),
	sessionId: () => "contract", now: () => 0,
});
const background = tools.find((tool) => tool.name === "bash_background")!;
const core = readFileSync(new URL("../assets/orchestrator.md", import.meta.url), "utf8");
const guide = readFileSync(new URL("../docs/gentle-shell.md", import.meta.url), "utf8");

for (const [name, text] of Object.entries({ registeredDescription: background.description, guide })) {
	test(`${name}: synchronous checks have an inclusive explicit 30-second limit and safe fallback`, () => {
		for (const clause of [
			"local, finite, deterministic checks", "reasonably expected to finish within 30 seconds",
			"explicit timeout <= 30 seconds (30 included)",
			"longer or unknown duration, external waits, CI, builds, and servers",
			"Report a timeout as failure; never automatically retry, restart, or migrate it to background",
			"Preserve RED/GREEN and public-check exit codes, stdout, and stderr",
			"Engram bugfix saves and session summaries", "RDD", "not a performance guarantee",
		]) assert.ok(text.includes(clause), `${name} missing: ${clause}`);
	});
}

test("inline still means the same parent, and the public background API stays asynchronous", () => {
	assert.ok(core.includes("Small path: inline (parent; `bash_background` policy);"));
	assert.ok(guide.includes("Inline means the same parent, not necessarily synchronous bash"));
	assert.ok(core.includes("run the focused test and the suite inline, once each"));
	assert.match(background.description, /return a job id at once/);
	assert.match(background.description, /notified once, automatically/);
	assert.match(background.description, /do not poll, sleep, or delegate a subagent to wait/);
	assert.deepEqual(background.parameters, {
		type: "object", additionalProperties: false, required: ["command"], properties: {
			command: { type: "string", description: "Shell command to run in the background, in the session working directory." },
			label: { type: "string", maxLength: 80, description: "Short human-readable label, e.g. 'CI for PR 1834'." },
		},
	});
});
