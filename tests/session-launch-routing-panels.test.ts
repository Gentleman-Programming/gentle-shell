// gentle-shell#1064 slice 3c: /gentle:profiles reads the routing this session's
// launches resolve (Enter binding, then the profile frozen at startup, then the
// global routing), never a pin the session did not freeze.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { PROFILES_KIND, PROFILES_VERSION } from "../lib/agent-profiles.ts";
import { PROFILE_PIN_KIND, PROFILE_PIN_VERSION, setProfilePinWorktreeResolverForTesting } from "../lib/agent-profile-pin.ts";
import { bindSessionProfile, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { resetFrozenInheritedProfilesForTesting } from "../lib/session-profile-freeze.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

initTheme("dark");

interface Panel {
	render(width: number): string[];
	handleInput(data: string): void;
}

function renderComponent(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(120).map((line) => line.replace(/[ \t]+$/g, "")).join("\n"));
}

// The table below the "Current routing (effective)" header: the profile list and
// the selected profile's own routing can show a model too.
function currentRouting(rendered: string): string {
	const header = "Current routing (effective)";
	const index = rendered.indexOf(header);
	assert.notEqual(index, -1, `missing "${header}" in:\n${rendered}`);
	return rendered.slice(index + header.length);
}

function panelFixture(t: test.TestContext) {
	resetFrozenInheritedProfilesForTesting();
	resetSessionProfileBindingsForTesting();
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-launch-routing-panels-"));
	const configHome = join(root, "global");
	const agentHome = join(root, "agent-home");
	const isolatedHome = join(root, "home");
	const pinRoot = join(root, "worktree");
	const pinCommonDir = join(root, "git-common");
	for (const dir of [configHome, isolatedHome, pinRoot, pinCommonDir, join(root, ".pi", "agents"), join(agentHome, "agents"), join(agentHome, "subagents")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nbody\n");
	const previous = {
		GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME,
		GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME,
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
	};
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	// The pin layers resolve through a Git seam; a sandbox identity keeps them
	// independent of where the test runner's directory sits.
	setProfilePinWorktreeResolverForTesting(() => ({ root: pinRoot, commonDir: pinCommonDir }));
	t.after(() => {
		setProfilePinWorktreeResolverForTesting();
		resetFrozenInheritedProfilesForTesting();
		resetSessionProfileBindingsForTesting();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool() {},
		registerCommand(name, command) { commands.set(name, command); },
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	} as unknown as ExtensionAPI);
	const fixtureTui = { terminal: { rows: 40 }, requestRender() {} };
	const panels: string[] = [];
	// Every visit closes with Esc unless a test scripts its own input.
	let onInput: (panel: Panel) => void = (panel) => panel.handleInput("\x1b");
	const ctx = {
		cwd: root,
		hasUI: true,
		sessionManager: { getSessionId: () => "session-panel" },
		modelRegistry: { getAvailable: async () => [], find: () => undefined },
		ui: {
			confirm: async () => true,
			notify() {},
			input: async () => undefined,
			custom: async (factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => Panel) => {
				let result: unknown;
				const panel = factory(fixtureTui, { fg: (_color: string, text: string) => text } as unknown as Theme, undefined, (value) => { result = value; });
				panels.push(renderComponent(panel));
				onInput(panel);
				assert.notEqual(result, undefined, "panel input must finish the interaction");
				return result;
			},
		},
	} as unknown as Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
	const storePath = join(configHome, "profiles.json");
	const globalPath = join(configHome, "models.json");
	return {
		root,
		agentHome,
		storePath,
		globalPath,
		localPinPath: join(pinCommonDir, "gentle-ai", "profile-pin.json"),
		panels,
		onInput(action: (panel: Panel) => void) { onInput = action; },
		writeStore(profiles: Record<string, unknown>, active?: string) {
			const store: Record<string, unknown> = { kind: PROFILES_KIND, version: PROFILES_VERSION, profiles };
			if (active !== undefined) store.active = active;
			writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		},
		writeGlobalRouting(routing: Record<string, unknown>) {
			writeFileSync(globalPath, `${JSON.stringify(routing, null, 2)}\n`);
		},
		writePin(path: string, profile: string) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile }, null, 2)}\n`);
		},
		run: (name: string) => commands.get(name)!.handler("", ctx),
	};
}

test("a session frozen on the active profile shows that profile as the current routing", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ team: { worker: { model: "openai/beta" } } }, "team");
	fixture.writeGlobalRouting({ worker: { model: "openai/alpha" } });
	const storeBefore = readFileSync(fixture.storePath, "utf8");
	const globalBefore = readFileSync(fixture.globalPath, "utf8");

	await fixture.run("gentle:profiles");

	assert.equal(fixture.panels.length, 1);
	const table = currentRouting(fixture.panels[0]!);
	assert.match(table, /worker\s+openai\/beta/, "launches resolve the frozen active profile");
	assert.doesNotMatch(table, /openai\/alpha/, "the global routing the frozen profile replaces is not shown as effective");
	assert.equal(readFileSync(fixture.storePath, "utf8"), storeBefore, "reading never writes profiles.json");
	assert.equal(readFileSync(fixture.globalPath, "utf8"), globalBefore, "reading never writes models.json");
});

test("a pin written after the session froze without a profile stays out of the current routing", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ fast: { worker: { model: "openai/delta" } } });
	fixture.writeGlobalRouting({ worker: { model: "openai/alpha" } });

	await fixture.run("gentle:profiles");
	assert.match(currentRouting(fixture.panels[0]!), /worker\s+openai\/alpha/, "no layer had a profile when the session froze");

	fixture.writePin(fixture.localPinPath, "fast");
	await fixture.run("gentle:profiles");

	assert.equal(fixture.panels.length, 2);
	const table = currentRouting(fixture.panels[1]!);
	assert.match(table, /worker\s+openai\/alpha/, "launches keep the global routing the session froze with");
	assert.doesNotMatch(table, /openai\/delta/, "a pin the session did not freeze does not reach its launches");
});

// #2276: with a pin at startup the rows show what launches use. Already true
// before slice 3c, kept as a regression guard.
test("a pin present when the session froze is the current routing", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ fast: { worker: { model: "openai/delta" } } });
	fixture.writeGlobalRouting({ worker: { model: "openai/alpha" } });
	fixture.writePin(fixture.localPinPath, "fast");

	await fixture.run("gentle:profiles");

	const table = currentRouting(fixture.panels[0]!);
	assert.match(table, /worker\s+openai\/delta/, "launches resolve the pinned profile");
	assert.doesNotMatch(table, /openai\/alpha/, "the global routing the pin replaces is not shown as effective");
});

// #2451: the Enter binding outranks the frozen profile and every shared layer.
test("an Enter binding outranks the frozen profile in the current routing", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ team: { worker: { model: "openai/beta" } } }, "team");
	fixture.writeGlobalRouting({ worker: { model: "openai/alpha" } });

	await fixture.run("gentle:profiles");
	assert.match(currentRouting(fixture.panels[0]!), /worker\s+openai\/beta/);

	bindSessionProfile("session-panel", "team", { worker: { model: "openai/gamma" } });
	await fixture.run("gentle:profiles");

	const table = currentRouting(fixture.panels[1]!);
	assert.match(table, /worker\s+openai\/gamma/, "launches resolve the session binding");
	assert.doesNotMatch(table, /openai\/beta/, "the frozen profile yields to the binding");
	assert.doesNotMatch(table, /openai\/alpha/, "the global routing stays out of a bound session's table");
});

test("a snapshot in a frozen session saves the routing its launches resolve", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ team: { worker: { model: "openai/beta" } } }, "team");
	fixture.writeGlobalRouting({ worker: { model: "openai/omega" }, explorer: { model: "openai/alpha" } });
	const globalBefore = readFileSync(fixture.globalPath, "utf8");
	let afterSnapshot = "";
	fixture.onInput((panel) => {
		panel.handleInput("s");
		afterSnapshot = renderComponent(panel);
		panel.handleInput("\x1b");
	});

	await fixture.run("gentle:profiles");

	assert.match(afterSnapshot, /Snapshot saved; live routing unchanged\. Profile "team" saved from current routing\./);
	const store = JSON.parse(readFileSync(fixture.storePath, "utf8"));
	assert.equal(store.active, "team", "a snapshot does not change the active profile");
	assert.deepEqual(Object.keys(store.profiles), ["team"]);
	assert.deepEqual(store.profiles.team, { worker: { model: "openai/beta" } }, "the snapshot is the frozen routing, not the global one");
	assert.equal(readFileSync(fixture.globalPath, "utf8"), globalBefore, "a snapshot never writes models.json");
});

test("a frozen profile hides the subagents.json keys it replaces from the unmatched list", async (t) => {
	const fixture = panelFixture(t);
	fixture.writeStore({ team: { worker: { model: "openai/beta" } } }, "team");
	writeFileSync(join(fixture.agentHome, "subagents.json"), `${JSON.stringify({ model_profiles: { explor: { model: "openai/alpha" } } }, null, 2)}\n`);

	await fixture.run("gentle:profiles");

	const table = currentRouting(fixture.panels[0]!);
	assert.match(table, /worker\s+openai\/beta/, "the table shows the frozen profile's own keys");
	assert.doesNotMatch(table, /Unmatched keys/, "launches route from the frozen profile, not subagents.json");
	assert.doesNotMatch(table, /explor/);
});
