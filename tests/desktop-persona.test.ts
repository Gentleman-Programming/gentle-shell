import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { globalPersonaPath, projectPersonaPath, resolvePersonaMode } from "../lib/persona-config.ts";
import { loadChatUi } from "./support/chat-ui.ts";

// A project dir and an isolated Gentle Pi config home, both outside the worktree.
function personaFixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "persona-mode-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const configHome = join(root, "config");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(configHome, { recursive: true });
	const env: NodeJS.ProcessEnv = { GENTLE_PI_CONFIG_HOME: configHome };
	const writeProject = (content: string) => {
		const file = projectPersonaPath(cwd);
		mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
		writeFileSync(file, content);
	};
	const writeGlobal = (content: string) => writeFileSync(globalPersonaPath(gentlePiConfigHome(env)), content);
	return { cwd, env, writeProject, writeGlobal };
}

test("should default to gentleman when no persona file exists", (t) => {
	const { cwd, env } = personaFixture(t);
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "gentleman");
});

test("should read the global persona when the project has none", (t) => {
	const { cwd, env, writeGlobal } = personaFixture(t);
	writeGlobal(JSON.stringify({ mode: "neutral" }));
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "neutral");
});

test("should prefer the project persona over the global one", (t) => {
	const { cwd, env, writeProject, writeGlobal } = personaFixture(t);
	writeGlobal(JSON.stringify({ mode: "neutral" }));
	writeProject(JSON.stringify({ mode: "gentleman" }));
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "gentleman");
});

test("should treat a readable file with an unknown mode as gentleman", (t) => {
	const { cwd, env, writeGlobal } = personaFixture(t);
	writeGlobal(JSON.stringify({ mode: "pirate" }));
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "gentleman");
});

test("should skip a malformed project file and fall through to the global one", (t) => {
	const { cwd, env, writeProject, writeGlobal } = personaFixture(t);
	writeProject("{ not json");
	writeGlobal(JSON.stringify({ mode: "neutral" }));
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "neutral");
});

test("should skip a non-object file such as an array", (t) => {
	const { cwd, env, writeProject, writeGlobal } = personaFixture(t);
	writeProject(JSON.stringify(["neutral"]));
	writeGlobal(JSON.stringify({ mode: "neutral" }));
	assert.equal(resolvePersonaMode(cwd, gentlePiConfigHome(env)), "neutral");
});

test("should show the persona mode the feed carries as a capitalized name in the Chat header", async (t) => {
	const ui = await loadChatUi(t, "/home/dev");
	assert.equal(ui.personaLabel("gentleman"), "Gentleman");
	assert.equal(ui.personaLabel("neutral"), "Neutral");
	assert.equal(ui.personaLabel({ name: "neutral" }), "Neutral");
});

test("should leave the Chat header persona empty when the feed carries none", async (t) => {
	const ui = await loadChatUi(t, "/home/dev");
	assert.equal(ui.personaLabel(null), null);
	assert.equal(ui.personaLabel(undefined), null);
	assert.equal(ui.personaLabel(""), null);
});
