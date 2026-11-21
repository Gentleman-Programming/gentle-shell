import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolvePersonaMode, writePersonaMode } from "../lib/persona-config.ts";

// lib/persona-config.ts keeps the exact precedence `/gentle:persona` always had.

function dirs(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "persona-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const cwd = join(root, "repo");
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	mkdirSync(configHome, { recursive: true });
	return { configHome, cwd, project: join(cwd, ".pi", "gentle-ai", "persona.json"), global: join(configHome, "persona.json") };
}

test("any project mode other than neutral reads as gentleman", (t) => {
	const d = dirs(t);
	writeFileSync(d.global, JSON.stringify({ mode: "neutral" }));
	writeFileSync(d.project, JSON.stringify({ mode: "x" }));
	assert.equal(resolvePersonaMode(d.cwd, d.configHome), "gentleman");
});

test("an unusable project file falls through to the global file, and nothing usable means gentleman", (t) => {
	const d = dirs(t);
	writeFileSync(d.global, JSON.stringify({ mode: "neutral" }));
	for (const content of ["[]", "null", "{ broken"]) {
		writeFileSync(d.project, content);
		assert.equal(resolvePersonaMode(d.cwd, d.configHome), "neutral", content);
	}
	rmSync(d.global);
	assert.equal(resolvePersonaMode(d.cwd, d.configHome), "gentleman");
});

test("writePersonaMode never creates a missing project file", (t) => {
	const d = dirs(t);
	assert.deepEqual(writePersonaMode(d.cwd, d.configHome, "neutral"), [d.global]);
	assert.equal(existsSync(d.project), false);
});
