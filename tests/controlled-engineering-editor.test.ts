import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing } from "../extensions/gentle-ai.ts";
import { PROFILES_KIND, PROFILES_VERSION, bootstrapProfilesFile, readProfilesFileResult, type AgentProfilesFile } from "../lib/agent-profiles.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import { createSessionProfileIntegration } from "../lib/session-profile-integration.ts";
import { resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// ---------------------------------------------------------------------------
// controlled-engineering S4: `/gentle:profiles` toggles Controlled Engineering
// on the shown profile and saves it with the profile, the same way as the
// orchestrator mode: `c` drafts it, save and use-session carry it, and the
// loop persists it beside the routing in one write.
// ---------------------------------------------------------------------------

type PanelResult = {
	type: string;
	name?: string;
	config?: AgentModelConfig;
	orchestratorMode?: "organic" | "full-delegation";
	controlledEngineering?: boolean;
};

function panelFile(workflow?: Record<string, unknown>): AgentProfilesFile {
	const file = bootstrapProfilesFile({}) as AgentProfilesFile;
	file.profiles = { team: { orchestrator: { model: "openai/gpt-6.1-sol", thinking: "max" } } } as AgentProfilesFile["profiles"];
	file.active = "team";
	if (workflow !== undefined) (file as { workflow?: unknown }).workflow = { team: workflow };
	return file;
}

function renderPanel(inputs: string[], file: AgentProfilesFile, results: PanelResult[] = [], width = 100): string[] {
	const config = JSON.parse(JSON.stringify(file.profiles["team"])) as AgentModelConfig;
	return __testing.routingTablePanel(
		config, ["openai/gpt-5.5"], ["gentle-ai-worker"], width, undefined, 30, inputs, [],
		results as unknown as Parameters<typeof __testing.routingTablePanel>[8],
		{ file, profileName: "team" },
	).map(stripAnsi);
}

function orchestratorRow(rendered: string[]): string {
	const line = rendered.find((line) => /Orchestrator/.test(line));
	assert.ok(line, "no orchestrator row on screen");
	return line;
}

test("c drafts Controlled Engineering, and save and use carry it like the orchestrator mode", () => {
	const saved: PanelResult[] = [];
	const lines = renderPanel(["c", "s"], panelFile(), saved);
	assert.equal(saved[0]?.type, "save");
	assert.equal(saved[0]?.controlledEngineering, true);
	assert.equal(saved[0]?.orchestratorMode, "organic");
	assert.doesNotMatch(lines.join("\n"), /Nothing to save/, "the drafted option counts as a change");
	const used: PanelResult[] = [];
	renderPanel(["c", "u"], panelFile({ orchestratorMode: "organic", controlledEngineering: true }), used);
	assert.equal(used[0]?.type, "use-session");
	assert.equal(used[0]?.controlledEngineering, false);
	// Unsaved like a routing edit: the first esc warns.
	assert.match(renderPanel(["c", "\x1b"], panelFile()).join("\n"), /Unsaved changes\. Press esc again/);
});

test("the orchestrator row shows the option beside the mode, and the key help names it", () => {
	assert.doesNotMatch(orchestratorRow(renderPanel([], panelFile())), /controlled/, "off shows nothing new");
	assert.match(orchestratorRow(renderPanel([], panelFile({ orchestratorMode: "organic", controlledEngineering: true }))), /◎ organic · controlled/);
	assert.match(orchestratorRow(renderPanel(["c"], panelFile())), /◎ organic · controlled/, "the draft shows before saving");
	assert.match(renderPanel([], panelFile(), [], 160).join("\n"), /c controlled/);
});

test("w still drafts the mode and keeps the saved option (preserved)", () => {
	const results: PanelResult[] = [];
	renderPanel(["w", "s"], panelFile({ orchestratorMode: "organic", controlledEngineering: true }), results);
	assert.equal(results[0]?.orchestratorMode, "full-delegation");
	assert.equal(results[0]?.controlledEngineering, true);
});

// ---- loop-level persistence ------------------------------------------------

function fixture(t: test.TestContext, workflow?: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "controlled-engineering-editor-"));
	const configHome = join(root, "global");
	mkdirSync(configHome, { recursive: true });
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const storePath = join(configHome, "profiles.json");
	writeFileSync(storePath, JSON.stringify({
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active: "team",
		profiles: { team: { orchestrator: { model: "openai/gpt-6.1-sol" } }, other: {} },
		...(workflow === undefined ? {} : { workflow: { team: workflow } }),
	}, null, 2));
	const stored = () => {
		const read = readProfilesFileResult(storePath);
		return read.status === "valid" ? read.file : undefined;
	};
	return { root, storePath, stored };
}

/** Drives the loop: scripted actions fill the panel visits; `{ drive }` feeds keys to the real panel. */
async function runLoop(root: string, scripted: unknown[], answers: string[] = []): Promise<{ screens: string[]; actions: unknown[] }> {
	const screens: string[] = [];
	const actions: unknown[] = [];
	const manager = SessionManager.create(root, join(root, "session-fixture"));
	manager.appendMessage({ role: "user", content: "isolated profile action", timestamp: 1 });
	createSessionProfileIntegration().start(manager, (type, data) => { manager.appendCustomEntry(type, data); }, { reason: "startup" });
	const ui = {
		notify() {},
		input: async () => answers.shift(),
		custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
			let result: unknown;
			const panel = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: string, text: string) => text }, undefined, (value: unknown) => { result = value; });
			screens.push(panel.render(100).map(stripAnsi).join("\n"));
			const visit = scripted.shift() as { drive?: string[] } | undefined;
			if (visit?.drive) {
				for (const key of visit.drive) { panel.handleInput(key); panel.render(100); }
				screens.push(panel.render(100).map(stripAnsi).join("\n"));
				actions.push(result);
				return result;
			}
			return visit ?? { type: "close" };
		},
	};
	const ctx = {
		cwd: root,
		hasUI: true,
		ui,
		sessionManager: manager,
		modelRegistry: { getAvailable: async () => [], find: () => ({ provider: "openai", id: "gpt-6.1-sol" }) },
	} as unknown as ExtensionContext;
	await __testing.openProfilesPanelLoop(ctx, { setModel: async () => true, setThinkingLevel() {}, getThinkingLevel: () => "medium" as const }, "team");
	return { screens, actions };
}

test("save writes the option beside the mode and routing; saving it off removes the entry", async (t) => {
	const store = fixture(t, { orchestratorMode: "full-delegation" });
	await runLoop(store.root, [
		{ type: "save", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "full-delegation", controlledEngineering: true },
		{ type: "save", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "organic", controlledEngineering: true },
	]);
	assert.deepEqual(store.stored()?.workflow?.["team"], { orchestratorMode: "organic", controlledEngineering: true });
	await runLoop(store.root, [
		{ type: "save", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "organic", controlledEngineering: false },
	]);
	assert.equal(store.stored()?.workflow, undefined, "an all-default store keeps the pre-change shape");
});

test("use-session persists a changed option before binding and reports it", async (t) => {
	const store = fixture(t);
	const before = readFileSync(store.storePath, "utf8");
	const { screens } = await runLoop(store.root, [
		{ type: "use-session", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "organic", controlledEngineering: true },
	]);
	assert.notEqual(readFileSync(store.storePath, "utf8"), before);
	assert.deepEqual(store.stored()?.workflow?.["team"], { orchestratorMode: "organic", controlledEngineering: true });
	assert.match(screens.at(-1) ?? "", /"team" now has Controlled Engineering on/);
});

test("the option draft survives a save-and-switch and the custom model round trip", async (t) => {
	const switched = fixture(t);
	await runLoop(switched.root, [{ drive: ["c", "\x1b[C", "s", "\x1b"] }]);
	assert.deepEqual(switched.stored()?.workflow?.["team"], { orchestratorMode: "organic", controlledEngineering: true });
	const custom = fixture(t);
	const { actions } = await runLoop(custom.root, [
		{ type: "custom", target: "gentle-ai-worker", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, controlledEngineeringDraft: true },
		{ drive: ["s"] },
	], ["openai/beta"]);
	assert.equal((actions.find((action) => (action as PanelResult).type === "save") as PanelResult | undefined)?.controlledEngineering, true);
	assert.deepEqual(custom.stored()?.workflow?.["team"], { orchestratorMode: "organic", controlledEngineering: true });
});

test("S4: the focused Orchestrator row always names the c key, whether the option is on or off", () => {
	for (const workflow of [undefined, { orchestratorMode: "organic", controlledEngineering: true }]) {
		for (const width of [100, 120]) {
			const description = renderPanel([], panelFile(workflow), [], width).find((line) => /w switches/.test(line));
			assert.ok(description, `explainer visible at ${width}`);
			assert.match(description, /w switches · c controlled/, `c key named at ${width}`);
		}
	}
});
