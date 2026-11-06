import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, Theme, ThinkingLevel } from "@earendil-works/pi-coding-agent";
import { __testing } from "../extensions/gentle-ai.ts";
import { PROFILES_KIND, PROFILES_VERSION, bootstrapProfilesFile, readProfilesFileResult, type AgentProfilesFile } from "../lib/agent-profiles.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import { createSessionProfileIntegration } from "../lib/session-profile-integration.ts";
import { resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// ---------------------------------------------------------------------------
// /gentle:profiles exposes the per-profile orchestrator mode (full delegation
// mode S5) through a panel draft: `w` toggles the shown profile, every commit
// path (save, use-session) carries it, and the loop persists it with the
// routing in one atomic write.
// ---------------------------------------------------------------------------

const SCREEN_AGENTS = ["gentle-ai-explore", "gentle-ai-verify", "gentle-ai-worker"];
const PANEL_MODELS = ["nan/deepseek-v4-flash", "openai/gpt-5.5"];

type PanelResult = {
	type: string;
	name?: string;
	config?: AgentModelConfig;
	orchestratorMode?: "organic" | "full-delegation";
};

function teamRouting(): AgentModelConfig {
	return { orchestrator: { model: "openai/gpt-6.1-sol", thinking: "max" }, "gentle-ai-worker": { model: "nan/deepseek-v4-flash" } };
}

function panelFile(workflow?: Record<string, { orchestratorMode: string }>): AgentProfilesFile {
	const file = bootstrapProfilesFile({}) as AgentProfilesFile;
	file.profiles = { team: teamRouting() } as AgentProfilesFile["profiles"];
	file.active = "team";
	if (workflow !== undefined) (file as { workflow?: unknown }).workflow = workflow;
	return file;
}

function renderPanel(
	inputs: string[],
	file: AgentProfilesFile,
	results: unknown[] = [],
	width = 100,
	theme?: Theme,
	options: { fallbacks?: unknown; fastModels?: string[] } = {},
): string[] {
	const config: AgentModelConfig = JSON.parse(JSON.stringify(file.profiles["team"])) as AgentModelConfig;
	const lines = __testing.routingTablePanel(
		config,
		PANEL_MODELS,
		SCREEN_AGENTS,
		width,
		theme,
		30,
		inputs,
		[],
		results,
		{ file, profileName: "team", ...(options.fallbacks !== undefined ? { fallbacks: options.fallbacks as never } : {}), ...(options.fastModels ? { fastModels: options.fastModels } : {}) },
	);
	return lines.map(stripAnsi);
}

/** The orchestrator's own row of a rendered screen: the first line naming it (tone probes may recase it). */
function orchestratorRow(rendered: string[]): string {
	const line = rendered.find((line) => /orchestrator/i.test(line));
	assert.ok(line, "no orchestrator row on screen");
	return line;
}

test("w drafts the shown profile's mode and save carries it in the returned action", () => {
	const results: PanelResult[] = [];
	const lines = renderPanel(["w", "s"], panelFile(), results);
	assert.equal(results.length, 1, "one save action");
	assert.equal(results[0]?.type, "save");
	assert.equal(results[0]?.name, "team");
	assert.equal(results[0]?.orchestratorMode, "full-delegation");
	assert.doesNotMatch(lines.join("\n"), /Nothing to save/, "the drafted mode counts as a change");
});

test("w toggles back: a committed full-delegation profile drafts organic", () => {
	const results: PanelResult[] = [];
	renderPanel(["w", "s"], panelFile({ team: { orchestratorMode: "full-delegation" } }), results);
	assert.equal(results[0]?.type, "save");
	assert.equal(results[0]?.orchestratorMode, "organic");
});

test("esc counts a drafted mode as an unsaved change exactly like a routing edit", () => {
	const warned = renderPanel(["w", "\x1b"], panelFile());
	assert.match(warned.join("\n"), /Unsaved changes\. Press esc again to close without saving\./);
	const closed: PanelResult[] = [];
	renderPanel(["w", "\x1b", "\x1b"], panelFile(), closed);
	assert.deepEqual(closed.map((result) => result.type), ["close"]);
	// The untouched panel still closes on the first esc: the mode alone arms the warning.
	const untouched: PanelResult[] = [];
	renderPanel(["\x1b"], panelFile(), untouched);
	assert.deepEqual(untouched.map((result) => result.type), ["close"]);
});

test("s without any change stays a no-op (preserved)", () => {
	const results: PanelResult[] = [];
	const lines = renderPanel(["s"], panelFile(), results);
	assert.deepEqual(results, [], "no save without a change");
	assert.match(lines.join("\n"), /Nothing to save\./);
});

// ---- orchestrator row mode chip -------------------------------------------

const TONE_THEME = {
	// Width-neutral tone probe: dim renders lowercase, accent uppercase, so the
	// chip's tone is observable without changing the line's measured width.
	fg: (color: string, text: string) => (color === "dim" ? text.toLowerCase() : color === "accent" ? text.toUpperCase() : text),
} as unknown as Theme;

test("the orchestrator row shows the drafted mode beside the tier, in both modes", () => {
	const organic = orchestratorRow(renderPanel([], panelFile()));
	assert.match(organic, /Orchestrator\s+openai\/gpt-6\.1-sol\s+max\s+organic/, "the committed organic mode rides the orchestrator row");
	const delegated = orchestratorRow(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } })));
	assert.match(delegated, /Orchestrator\s+openai\/gpt-6\.1-sol\s+max\s+⚡ full-delegation/, "the committed full-delegation mode rides the orchestrator row");
	// The chip mirrors the draft: one `w` flips it before anything is saved.
	assert.match(orchestratorRow(renderPanel(["w"], panelFile())), /max\s+⚡ full-delegation/);
	assert.match(orchestratorRow(renderPanel(["w"], panelFile({ team: { orchestratorMode: "full-delegation" } }))), /max\s+organic/);
	// Tones: organic dim, full-delegation accent (and it is the only new row segment).
	assert.match(orchestratorRow(renderPanel([], panelFile(), [], 100, TONE_THEME)), /organic/, "organic stays lowercase under a dim tone");
	const delegatedTone = orchestratorRow(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } }), [], 100, TONE_THEME));
	assert.match(delegatedTone, /⚡ FULL-DELEGATION/, "the full-delegation chip renders in the accent tone");
	assert.doesNotMatch(delegatedTone, /organic/, "the tones differ between the two modes");
	// The chip belongs to the orchestrator row only.
	assert.doesNotMatch(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } })).join("\n"), /gentle-ai-worker\s+nan\/deepseek-v4-flash\s+inherit\s+⚡/);
});

test("the mode chip keeps the full orchestrator row intact at 100 columns", () => {
	const row = orchestratorRow(renderPanel([], panelFile()));
	assert.doesNotMatch(row, /…/, "nothing on the row is cut to make room");
	// Agent rows are untouched by the chip.
	assert.match(renderPanel([], panelFile()).join("\n"), /gentle-ai-worker\s+nan\/deepseek-v4-flash\s+inherit/);
	// With a Fast tier on the row, chip and tier share the line at 100 columns.
	const tiered = orchestratorRow(renderPanel([], panelFile(), [], 100, undefined, { fastModels: ["openai/gpt-6.1-sol"] }));
	assert.match(tiered, /Standard ▾\s+organic/);
});

test("the mode chip degrades before it disappears: full form at 100 with a tier, half form one tier-width earlier", () => {
	// The human's case: a Fast-capable orchestrator at exactly 100 columns still
	// shows the mode (here the widest form fits beside the tier).
	const tiered = orchestratorRow(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } }), [], 100, undefined, { fastModels: ["openai/gpt-6.1-sol"] }));
	assert.match(tiered, /Standard ▾\s+⚡ full-delegation/, "the mode is never gone at the default width");
	// One tier-width narrower the wide form no longer fits and the ladder steps down.
	const stepped = orchestratorRow(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } }), [], 95, undefined, { fastModels: ["openai/gpt-6.1-sol"] }));
	assert.match(stepped, /Standard ▾\s+⚡ full(?![a-z-])/, "the half-width form rides beside the tier when the wide one cannot");
	assert.doesNotMatch(stepped, /full-delegation/, "the wide form is the one that yields");
	// The organic forms share the ladder: beside a tier the full word still fits.
	const organicTiered = orchestratorRow(renderPanel([], panelFile(), [], 100, undefined, { fastModels: ["openai/gpt-6.1-sol"] }));
	assert.match(organicTiered, /Standard ▾\s+organic/);
});

test("only the last-resort form fitting renders it, and never for the wrong mode", () => {
	// At 64 columns the full and half forms do not fit; the shape remains.
	const delegated = orchestratorRow(renderPanel([], panelFile({ team: { orchestratorMode: "full-delegation" } }), [], 64));
	assert.match(delegated, /max\s+⚡\s*│/, "the last-resort full-delegation shape is still on the row");
	const organic = orchestratorRow(renderPanel([], panelFile(), [], 64));
	assert.match(organic, /max\s+○\s*│/, "the last-resort organic shape is still on the row");
	// The shape states its mode: the mapping is per form, not per width.
	assert.doesNotMatch(orchestratorRow(renderPanel([], panelFile(), [], 64, TONE_THEME)), /⚡/, "an organic profile never renders the bolt");
});

test("short space shortens or drops the fallback chain before the chip, and drops the chip last", () => {
	const fallbacks = { chain: () => [{ model: "provider/very-long-model-name-that-is-long" }], save: () => undefined };
	const roomy = orchestratorRow(renderPanel([], panelFile(), [], 100, undefined, { fallbacks }));
	assert.match(roomy, /organic/, "the chip is never given up at default width");
	assert.match(roomy, /↪ /, "the chain still fits, shortened first");
	assert.doesNotMatch(roomy, /very-long-model-name-that-is-long/, "the chain is the segment that gives way");
	// The ladder degrades before dropping: at 60 columns the last-resort shape
	// remains (and it costs the chain its slot), below that the chip is gone.
	const tight = orchestratorRow(renderPanel([], panelFile(), [], 60, undefined, { fallbacks }));
	assert.match(tight, /○(?![a-z])/, "the last-resort shape survives where the word did not");
	assert.doesNotMatch(tight, /organic|↪/, "the chain yields before the last-resort shape does");
	const dropped = orchestratorRow(renderPanel([], panelFile(), [], 50, undefined, { fallbacks }));
	assert.doesNotMatch(dropped, /organic|full-delegation|○|⚡/, "only when even the last resort cannot fit is the chip gone");
});

// ---- loop-level persistence ------------------------------------------------

interface PanelHomeFixture {
	root: string;
	configHome: string;
	storePath: string;
	writeStore: (profiles: Record<string, unknown>, extra?: Record<string, unknown>) => void;
}

function panelHomeFixture(t: test.TestContext): PanelHomeFixture {
	const root = mkdtempSync(join(tmpdir(), "profiles-panel-delegation-"));
	const configHome = join(root, "global");
	mkdirSync(configHome, { recursive: true });
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		rmSync(root, { recursive: true, force: true });
	});
	const storePath = join(configHome, "profiles.json");
	const writeStore = (profiles: Record<string, unknown>, extra?: Record<string, unknown>) => {
		writeFileSync(storePath, JSON.stringify({ kind: PROFILES_KIND, version: PROFILES_VERSION, profiles, ...extra }, null, 2));
	};
	return { root, configHome, storePath, writeStore };
}

function actionManager(root: string): SessionManager {
	const manager = SessionManager.create(root, join(root, "session-fixture"));
	manager.appendMessage({ role: "user", content: "isolated profile action", timestamp: 1 });
	createSessionProfileIntegration().start(manager, (type, data) => { manager.appendCustomEntry(type, data); }, { reason: "startup" });
	return manager;
}

const LIVE = {
	setModel: async (_model: unknown) => true,
	setThinkingLevel() {},
	getThinkingLevel: (): ThinkingLevel => "medium",
};

/** Drives the loop: scripted actions fill the panel visits; a `{ drive }` entry feeds real keys to the real panel instead. */
async function runLoop(
	fixture: PanelHomeFixture,
	scripted: Array<unknown | { drive: string[] }>,
	options: { answers?: string[] } = {},
): Promise<{ screens: string[]; notifications: string[]; actions: unknown[] }> {
	const screens: string[] = [];
	const notifications: string[] = [];
	const actions: unknown[] = [];
	const answers = options.answers ?? [];
	let answerIndex = 0;
	const manager = actionManager(fixture.root);
	const ui = {
		notify(message: string) { notifications.push(message); },
		input: async () => answers[answerIndex++],
		custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
			let result: unknown;
			const panel = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_c: string, text: string) => text }, undefined, (value: unknown) => { result = value; });
			screens.push(panel.render(100).map(stripAnsi).join("\n"));
			const visit = scripted.shift();
			if (visit !== undefined && visit !== null && typeof visit === "object" && "drive" in (visit as { drive?: unknown })) {
				for (const key of (visit as { drive: string[] }).drive) {
					panel.handleInput(key);
					panel.render(100);
				}
				screens.push(panel.render(100).map(stripAnsi).join("\n"));
				assert.notEqual(result, undefined, "driven input must finish the interaction");
				actions.push(result);
				return result;
			}
			return visit ?? { type: "close" };
		},
	};
	const ctx = {
		cwd: fixture.root,
		hasUI: true,
		ui,
		sessionManager: manager,
		modelRegistry: { getAvailable: async () => [], find: () => ({ provider: "openai", id: "gpt-6.1-sol" }) },
	} as unknown as ExtensionContext;
	await __testing.openProfilesPanelLoop(ctx, LIVE, "team");
	return { screens, notifications, actions };
}

test("save lands the mode and the routing in one write", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore({ team: { orchestrator: { model: "openai/gpt-6.1-sol" } } }, { active: "team" });
	await runLoop(fixture, [
		{ type: "save", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "full-delegation" },
		{ type: "close" },
	]);
	const saved = readProfilesFileResult(fixture.storePath);
	assert.equal(saved.status, "valid");
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.deepEqual(file?.workflow?.["team"], { orchestratorMode: "full-delegation" }, "the mode persists beside the routing");
	assert.deepEqual(JSON.parse(JSON.stringify(file?.profiles["team"])), { orchestrator: { model: "openai/gpt-6.1-sol" } }, "the routing lands in the same write");
});

test("toggling back to organic removes the workflow entry instead of persisting an explicit organic", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore(
		{ team: { orchestrator: { model: "openai/gpt-6.1-sol" } } },
		{ active: "team", workflow: { team: { orchestratorMode: "full-delegation" } } },
	);
	await runLoop(fixture, [
		{ type: "save", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "organic" },
		{ type: "close" },
	]);
	const saved = readProfilesFileResult(fixture.storePath);
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.equal(file?.workflow, undefined, "an all-organic store keeps the pre-change shape");
	assert.deepEqual(JSON.parse(JSON.stringify(file?.profiles["team"])), { orchestrator: { model: "openai/gpt-6.1-sol" } });
});

test("use-session persists a changed draft mode before binding and reports it", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore({ team: { orchestrator: { model: "openai/gpt-6.1-sol" } } }, { active: "team" });
	const before = readFileSync(fixture.storePath, "utf8");
	const { screens } = await runLoop(fixture, [
		{ type: "use-session", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "full-delegation" },
		{ type: "close" },
	]);
	const saved = readProfilesFileResult(fixture.storePath);
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.deepEqual(file?.workflow?.["team"], { orchestratorMode: "full-delegation" }, "enter never leaves a toggled mode behind");
	assert.notEqual(readFileSync(fixture.storePath, "utf8"), before, "the store was written");
	const reopened = screens.at(-1) ?? "";
	assert.match(reopened, /now keeps its orchestrator in full-delegation mode/, "the status line reports the persisted mode");
});

test("use-session with an unchanged mode writes nothing (preserved shape)", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore({ team: { orchestrator: { model: "openai/gpt-6.1-sol" } } }, { active: "team" });
	const before = readFileSync(fixture.storePath, "utf8");
	await runLoop(fixture, [
		{ type: "use-session", name: "team", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, orchestratorMode: "organic" },
		{ type: "close" },
	]);
	assert.equal(readFileSync(fixture.storePath, "utf8"), before, "an unchanged organic mode never grows a workflow key");
	const saved = readProfilesFileResult(fixture.storePath);
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.equal(file?.workflow, undefined);
});

// ---- draft-loss paths ------------------------------------------------------

test("switch-save carries the mode draft: arrowing to another tab and saving keeps it", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore(
		{ team: { orchestrator: { model: "openai/gpt-6.1-sol" } }, other: {} },
		{ active: "team" },
	);
	// w drafts the mode, → opens the switch prompt, s saves the left profile
	// (mode and routing in one write), esc closes the freshly shown profile.
	const { actions, screens } = await runLoop(fixture, [{ drive: ["w", "\x1b[C", "s", "\x1b"] }]);
	const saved = readProfilesFileResult(fixture.storePath);
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.deepEqual(file?.workflow?.["team"], { orchestratorMode: "full-delegation" }, "the switch write keeps the drafted mode");
	assert.deepEqual(JSON.parse(JSON.stringify(file?.profiles["team"])), { orchestrator: { model: "openai/gpt-6.1-sol" } });
	assert.match(screens.at(-1) ?? "", /Showing "other"/, "the switch continues to the next profile");
	assert.equal((actions.at(-1) as PanelResult | undefined)?.type, "close");
});

test("the custom model prompt round trip keeps the mode draft, and saving after it persists both", async (t) => {
	const fixture = panelHomeFixture(t);
	fixture.writeStore({ team: { orchestrator: { model: "openai/gpt-6.1-sol" } } }, { active: "team" });
	const { actions } = await runLoop(fixture, [
		{ type: "custom", target: "gentle-ai-worker", config: { orchestrator: { model: "openai/gpt-6.1-sol" } }, modeDraft: "full-delegation" },
		{ drive: ["s"] },
		{ type: "close" },
	], { answers: ["openai/beta"] });
	const savedAction = actions.find((action) => (action as PanelResult).type === "save") as PanelResult | undefined;
	assert.equal(savedAction?.orchestratorMode, "full-delegation", "the mode draft survives the reopen");
	assert.equal((savedAction?.config as Record<string, { model?: string }> | undefined)?.["gentle-ai-worker"]?.model, "openai/beta", "the routing draft survives too");
	const saved = readProfilesFileResult(fixture.storePath);
	const file = saved.status === "valid" ? saved.file : undefined;
	assert.deepEqual(file?.workflow?.["team"], { orchestratorMode: "full-delegation" });
	assert.deepEqual(
		JSON.parse(JSON.stringify(file?.profiles["team"])),
		{ orchestrator: { model: "openai/gpt-6.1-sol" }, "gentle-ai-worker": { model: "openai/beta" } },
		"the custom model and the mode land together",
	);
});
