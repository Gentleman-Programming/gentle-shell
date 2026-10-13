import assert from "node:assert/strict";
import test from "node:test";
import { type EnvSummary } from "../lib/gentle-shell-envs.ts";
import { initialEnvsState, parseKeys, reduceEnvs, renderEnvsScreen, type EnvsKey, type EnvsState } from "../lib/gentle-shell-envs-tui.ts";

function env(name: string, extra: Partial<EnvSummary> = {}): EnvSummary {
	return { name, dir: `/e/${name}`, isDefault: false, packages: [], providers: [], provisioned: "not provisioned", sessionCount: 0, ...extra };
}

const char = (c: string): EnvsKey => ({ name: "char", char: c });

function press(state: EnvsState, ...keys: EnvsKey[]) {
	let effect;
	for (const key of keys) ({ state, effect } = reduceEnvs(state, key));
	return { state, effect };
}

function typed(text: string): EnvsKey[] {
	return [...text].map(char);
}

// --- key parsing -----------------------------------------------------------

test("parseKeys decodes arrows, enter, backspace, escape, ctrl-c and printable text", () => {
	assert.deepEqual(parseKeys("\x1b[A\x1b[B\r\x7fab\x03"), [
		{ name: "up" },
		{ name: "down" },
		{ name: "enter" },
		{ name: "backspace" },
		char("a"),
		char("b"),
		{ name: "ctrl-c" },
	]);
	assert.deepEqual(parseKeys("\x1b"), [{ name: "escape" }]);
	assert.deepEqual(parseKeys("\x1bOA\x1bOB"), [{ name: "up" }, { name: "down" }]);
	assert.deepEqual(parseKeys("\x1b[5~"), [], "unknown escape sequences are dropped");
});

// --- navigation and direct actions -------------------------------------------

test("selection moves with arrows and j/k and is clamped", () => {
	const s0 = initialEnvsState([env("a"), env("b")]);
	assert.equal(press(s0, { name: "down" }, char("j"), char("j")).state.selected, 1);
	assert.equal(press(s0, { name: "down" }, char("k"), { name: "up" }).state.selected, 0);
});

test("initial selection starts on the default env", () => {
	assert.equal(initialEnvsState([env("a"), env("b", { isDefault: true })]).selected, 1);
});

test("enter launches, s sets default, p sets up, a checks auth, q quits", () => {
	const s0 = initialEnvsState([env("a"), env("b")]);
	const s1 = press(s0, { name: "down" }).state;
	assert.deepEqual(press(s1, { name: "enter" }).effect, { kind: "launch", name: "b" });
	assert.deepEqual(press(s1, char("s")).effect, { kind: "set-default", name: "b" });
	assert.deepEqual(press(s1, char("p")).effect, { kind: "setup", name: "b" });
	assert.deepEqual(press(s1, char("a")).effect, { kind: "auth-check", name: "b" });
	assert.deepEqual(press(s1, char("q")).effect, { kind: "quit" });
	assert.deepEqual(press(s1, { name: "escape" }).effect, { kind: "quit" });
	assert.deepEqual(press(s1, { name: "ctrl-c" }).effect, { kind: "quit" });
});

test("env-scoped actions on an empty list do nothing but explain how to create one", () => {
	const { state, effect } = press(initialEnvsState([]), { name: "enter" });
	assert.equal(effect, undefined);
	assert.match(state.message ?? "", /n/);
});

// --- prompts ---------------------------------------------------------------

test("n opens a name prompt that validates and rejects duplicates before creating", () => {
	const s0 = initialEnvsState([env("work")]);
	const bad = press(s0, char("n"), ...typed("Work"), { name: "enter" });
	assert.equal(bad.effect, undefined);
	assert.match(bad.state.prompt?.error ?? "", /env name/);
	const dup = press(s0, char("n"), ...typed("work"), { name: "enter" });
	assert.match(dup.state.prompt?.error ?? "", /already exists/);
	const ok = press(s0, char("n"), ...typed("perzonal"), { name: "backspace" }, { name: "backspace" }, ...typed("al"), { name: "enter" });
	assert.deepEqual(ok.effect, { kind: "create", name: "perzonal".slice(0, -2) + "al" });
	assert.equal(ok.state.prompt, undefined);
});

test("keys typed into a prompt never trigger list actions", () => {
	const { state, effect } = press(initialEnvsState([env("a")]), char("n"), char("q"), char("d"), char("s"));
	assert.equal(effect, undefined);
	assert.equal(state.prompt?.value, "qds");
});

test("escape cancels a prompt without quitting", () => {
	const { state, effect } = press(initialEnvsState([env("a")]), char("n"), char("x"), { name: "escape" });
	assert.equal(effect, undefined);
	assert.equal(state.prompt, undefined);
});

test("r renames the selected env, prefilled, and a no-op rename just closes", () => {
	const s0 = initialEnvsState([env("old"), env("taken")]);
	const opened = press(s0, char("r")).state;
	assert.equal(opened.prompt?.value, "old");
	assert.equal(press(opened, { name: "enter" }).effect, undefined);
	assert.match(press(opened, ...Array(3).fill({ name: "backspace" }), ...typed("taken"), { name: "enter" }).state.prompt?.error ?? "", /already exists/);
	assert.deepEqual(press(opened, { name: "backspace" }, char("x"), { name: "enter" }).effect, { kind: "rename", from: "old", to: "olx" });
});

test("d deletes only after the env name is typed exactly", () => {
	const s0 = initialEnvsState([env("work")]);
	const wrong = press(s0, char("d"), ...typed("wor"), { name: "enter" });
	assert.equal(wrong.effect, undefined);
	assert.match(wrong.state.prompt?.error ?? "", /type "work"/);
	assert.deepEqual(press(s0, char("d"), ...typed("work"), { name: "enter" }).effect, { kind: "delete", name: "work" });
});

test("i installs a non-empty package source into the selected env", () => {
	const s0 = initialEnvsState([env("work")]);
	assert.match(press(s0, char("i"), { name: "enter" }).state.prompt?.error ?? "", /source/);
	assert.deepEqual(press(s0, char("i"), ...typed("npm:pi-btw"), { name: "enter" }).effect, { kind: "install", name: "work", source: "npm:pi-btw" });
});

// --- rendering ---------------------------------------------------------------

test("render fits the terminal exactly and shows the list, details and key hints", () => {
	const state = initialEnvsState([
		env("work", { isDefault: true, packages: ["npm:gentle-engram"], providers: ["anthropic"], sessionCount: 2, lastSessionAt: "2026-05-02T10:00:00.000Z" }),
		env("personal"),
	]);
	const lines = renderEnvsScreen(state, 80, 20);
	assert.equal(lines.length, 20);
	for (const line of lines) assert.ok(stripAnsi(line).length <= 80, `too wide: ${line}`);
	const text = lines.map(stripAnsi).join("\n");
	for (const expected of ["work", "personal", "default", "/e/work", "npm:gentle-engram", "anthropic", "2 sessions", "enter"]) {
		assert.ok(text.includes(expected), `missing ${expected}`);
	}
});

test("render shows the prompt with its error, and an empty-state hint", () => {
	const prompting = press(initialEnvsState([env("a")]), char("n"), ...typed("Bad"), { name: "enter" }).state;
	const text = renderEnvsScreen(prompting, 60, 12).map(stripAnsi).join("\n");
	assert.ok(text.includes("New env name: Bad"));
	assert.match(text, /invalid env name/);
	assert.match(renderEnvsScreen(initialEnvsState([]), 60, 12).map(stripAnsi).join("\n"), /No envs yet/);
});

test("render degrades without throwing on tiny terminals", () => {
	const lines = renderEnvsScreen(initialEnvsState([env("a")]), 10, 3);
	assert.equal(lines.length, 3);
	for (const line of lines) assert.ok(stripAnsi(line).length <= 10);
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}
