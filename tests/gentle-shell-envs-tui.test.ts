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
	assert.deepEqual(parseKeys("\x1b[D\x1b[C "), [{ name: "left" }, { name: "right" }, char(" ")]);
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
	const named = press(s0, char("n"), ...typed("perzonal"), { name: "backspace" }, { name: "backspace" }, ...typed("al"), { name: "enter" });
	assert.equal(named.effect, undefined, "a valid name opens the config form first");
	assert.equal(named.state.prompt, undefined);
	assert.equal(named.state.scope?.name, "perzonal");
	const ok = press(named.state, { name: "enter" });
	assert.deepEqual(ok.effect, { kind: "create", name: "perzonal", own: [] }, "enter with defaults shares everything, as before");
	assert.equal(ok.state.scope, undefined);
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

// --- Gentle visual identity -------------------------------------------------

const ROSE = "\x1b[38;2;255;118;195m";
const sample = () => initialEnvsState([
	env("work", { isDefault: true, packages: ["npm:gentle-engram"], providers: ["anthropic"], sessionCount: 2 }),
	env("personal"),
]);

test("the gate is branded: Gentle Shell title with version and a call to choose an env", () => {
	const text = renderEnvsScreen(sample(), 100, 24, { version: "4.2.0" }).map(stripAnsi).join("\n");
	assert.match(text, /✿ Gentle Shell/);
	assert.match(text, /v4\.2\.0/);
	assert.match(text, /Choose an environment/);
});

test("envs and details render as rounded Gentle cards with the rose title glyph", () => {
	const lines = renderEnvsScreen(sample(), 100, 24).map(stripAnsi);
	assert.ok(lines.some((line) => /╭─ ✿ Envs ─+╮/.test(line)), lines.join("\n"));
	assert.ok(lines.some((line) => /╭─ ✿ work ─+╮/.test(line)), "detail card titled with the selected env");
	assert.ok(lines.some((line) => /^╰─+╯/.test(line)));
});

test("the selected env is marked with the Gentle chevron and the default like /gentle:profiles markers", () => {
	const text = renderEnvsScreen(sample(), 100, 24).map(stripAnsi).join("\n");
	assert.match(text, /│ ❯ work \(default\)/);
	assert.doesNotMatch(text, /★/, "the default reads like /gentle:profiles markers, not a star");
	assert.match(text, /│ {3}personal/);
});

test("color uses the Gentle rose and never reverse video; monochrome emits no truecolor", () => {
	const colored = renderEnvsScreen(sample(), 100, 24, { color: true }).join("\n");
	assert.ok(colored.includes(ROSE), "rose accent");
	assert.ok(!colored.includes("\x1b[7m"), "no reverse video");
	const plain = renderEnvsScreen(sample(), 100, 24, { color: false }).join("\n");
	assert.ok(!plain.includes("\x1b[38;2;"), "no truecolor without color");
});

test("tall terminals show the Gentle rose artwork; short ones keep only the title", () => {
	const tall = renderEnvsScreen(sample(), 100, 40).map(stripAnsi).join("\n");
	assert.match(tall, /[⣀-⣿]{6}/, "braille rose shown");
	const short = renderEnvsScreen(sample(), 100, 20).map(stripAnsi).join("\n");
	assert.doesNotMatch(short, /[⣀-⣿]{6}/);
	assert.match(short, /✿ Gentle Shell/);
});

test("the gate is a centered composition: cards fit their content on wide, tall terminals", () => {
	const lines = renderEnvsScreen(sample(), 200, 60).map(stripAnsi);
	const top = lines.findIndex((line) => line.includes("╭─ ✿ Envs"));
	const bottom = lines.findIndex((line, index) => index > top && line.trimStart().startsWith("╰"));
	assert.ok(bottom - top < 20, `cards fit content, got ${bottom - top} rows`);
	assert.ok(lines[top].indexOf("╭") >= 40, "block centered horizontally");
	assert.ok(lines[top].trimEnd().length - lines[top].indexOf("╭") <= 112, "block width capped");
	assert.ok(lines.findIndex((line) => line.includes("✿ Gentle Shell")) > 5, "vertically centered, not glued to the top");
});

test("key hints wrap instead of losing actions, and sit right under the cards", () => {
	for (const width of [80, 60]) {
		const lines = renderEnvsScreen(sample(), width, 24).map(stripAnsi);
		const text = lines.join("\n");
		for (const hint of ["enter open", "n new", "d delete", "q quit"]) assert.ok(text.includes(hint), `${width}: ${hint}`);
		const bottom = lines.findLastIndex((line) => line.trimStart().startsWith("╰"));
		const hints = lines.findIndex((line) => line.includes("enter open"));
		assert.ok(hints > bottom && hints - bottom <= 3, `${width}: hints right under the cards`);
	}
});

test("every layout fills the terminal exactly within its width", () => {
	for (const [w, h] of [[160, 50], [100, 40], [80, 24], [60, 16], [40, 12], [20, 6], [10, 3]] as const) {
		for (const color of [true, false]) {
			const lines = renderEnvsScreen(sample(), w, h, { color, version: "4.2.0" });
			assert.equal(lines.length, h, `${w}x${h}`);
			for (const line of lines) assert.ok([...stripAnsi(line)].length <= w, `${w}x${h}: ${stripAnsi(line)}`);
		}
	}
});

// --- the base home (the install's own home, `--isolated`) ----------------------

const baseEntry = (extra: Partial<EnvSummary> = {}): EnvSummary => env("base", { dir: "/h/.gentle-shell/agent", base: true, ...extra });

test("base home actions carry base and never a managed env name", () => {
	const s0 = initialEnvsState([baseEntry(), env("work")]);
	assert.deepEqual(press(s0, { name: "enter" }).effect, { kind: "launch", name: "base", base: true });
	assert.deepEqual(press(s0, char("s")).effect, { kind: "set-default", name: "base", base: true });
	assert.deepEqual(press(s0, char("p")).effect, { kind: "setup", name: "base", base: true });
	assert.deepEqual(press(s0, char("a")).effect, { kind: "auth-check", name: "base", base: true });
	assert.deepEqual(press(s0, char("i"), ...typed("npm:pi-btw"), { name: "enter" }).effect, { kind: "install", name: "base", source: "npm:pi-btw", base: true });
	assert.deepEqual(press(s0, { name: "down" }, { name: "enter" }).effect, { kind: "launch", name: "work" }, "envs keep their exact effects");
});

test("the base home can be neither renamed nor deleted", () => {
	const s0 = initialEnvsState([baseEntry(), env("work")]);
	for (const key of ["r", "d"]) {
		const { state, effect } = press(s0, char(key));
		assert.equal(effect, undefined);
		assert.equal(state.prompt, undefined);
		assert.match(state.message ?? "", /base home/);
	}
});

test("an env may be named base: the base home never takes part in name checks", () => {
	const s0 = initialEnvsState([baseEntry(), env("work")]);
	assert.deepEqual(press(s0, char("n"), ...typed("base"), { name: "enter" }, { name: "enter" }).effect, { kind: "create", name: "base", own: [] });
});

test("the base home renders first with its own marker and card, starred when default", () => {
	const s0 = initialEnvsState([baseEntry({ isDefault: true }), env("work")]);
	const text = renderEnvsScreen(s0, 100, 24).map(stripAnsi).join("\n");
	assert.match(text, /│ ❯ Gentle Shell base \(default\)/);
	assert.doesNotMatch(text, /◆/, "no marker that would need a legend");
	assert.match(text, /╭─ ✿ Base home ─+╮/);
	assert.match(text, /The install's own home/);
	assert.equal(s0.selected, 0, "initial selection follows the default");
});

test("reselection never confuses the base home with an env of the same name", () => {
	const envs = [baseEntry(), env("base"), env("work")];
	assert.equal(initialEnvsState(envs, undefined, "base").selected, 1);
	assert.equal(initialEnvsState(envs, undefined, { base: true }).selected, 0);
});

test("a home that was never set up says it is set up on first open, never just 'none'", () => {
	const fresh = initialEnvsState([baseEntry({ provisioned: "not provisioned", setUp: false })]);
	const text = renderEnvsScreen(fresh, 100, 24).map(stripAnsi).join("\n");
	assert.match(text, /Setup +not set up yet/);
	assert.match(text, /Packages +installed when you first open it/);
	assert.doesNotMatch(text, /Packages +none/);
	const ready = initialEnvsState([env("work", { setUp: true })]);
	assert.match(renderEnvsScreen(ready, 100, 24).map(stripAnsi).join("\n"), /Packages +none/);
});

test("text from the user's own files never reaches the terminal as control sequences", () => {
	const evil = env("work", { dir: "/e/work\x1b]0;x\x07", packages: ["npm:a\x1b[2J"], providers: ["anth\x1b[31mropic"], provisioned: "ok\r" });
	const lines = renderEnvsScreen(initialEnvsState([evil]), 100, 24, { color: false });
	// The renderer's own SGR styling is allowed; nothing else may remain.
	for (const line of lines) assert.doesNotMatch(stripAnsi(line), /[\x00-\x1f\x7f]/, JSON.stringify(line));
	const text = lines.join("\n");
	assert.match(text, /npm:a/);
	assert.match(text, /anthropic|anth.*ropic/);
});

// --- config scope form (VS Code-like profiles) -------------------------------------

const scoped = (name: string, own: EnvSummary["own"] = [], extra: Partial<EnvSummary> = {}) => env(name, { own, ...extra });

test("the new-env form toggles categories and picks where own copies come from", () => {
	const s0 = initialEnvsState([baseEntry(), scoped("work", ["persona"]), scoped("lab")]);
	let { state } = press(s0, char("n"), ...typed("client"), { name: "enter" });
	assert.equal(state.scope?.mode, "create");
	state = press(state, { name: "down" }, char(" ")).state; // persona -> own
	state = press(state, { name: "down" }, { name: "right" }).state; // appearance -> own
	assert.deepEqual(state.scope?.own, ["persona", "appearance"]);
	// The source row cycles: base -> each other env -> empty.
	state = press(state, { name: "down" }, { name: "down" }, { name: "right" }).state;
	assert.deepEqual(state.scope?.source, { kind: "env", name: "work" });
	state = press(state, { name: "right" }, { name: "right" }).state;
	assert.deepEqual(state.scope?.source, { kind: "empty" });
	state = press(state, { name: "right" }).state;
	assert.deepEqual(state.scope?.source, { kind: "base" }, "wraps around");
	state = press(state, { name: "left" }).state;
	assert.deepEqual(state.scope?.source, { kind: "empty" });
	assert.deepEqual(press(state, { name: "enter" }).effect, { kind: "create", name: "client", own: ["persona", "appearance"], empty: true });
	const fromWork = press(state, { name: "right" }, { name: "right" }, { name: "enter" }).effect;
	assert.deepEqual(fromWork, { kind: "create", name: "client", own: ["persona", "appearance"], from: "work" });
});

test("a toggles every category own or shared, and esc cancels without creating", () => {
	const s0 = initialEnvsState([baseEntry(), scoped("work")]);
	const { state } = press(s0, char("n"), ...typed("x"), { name: "enter" }, char("a"));
	assert.deepEqual(state.scope?.own, ["models", "persona", "appearance", "behavior"]);
	assert.deepEqual(press(state, char("a")).state.scope?.own, []);
	const cancelled = press(state, { name: "escape" });
	assert.equal(cancelled.effect, undefined);
	assert.equal(cancelled.state.scope, undefined);
});

test("c edits an existing env's scope; seeding applies only to newly own categories", () => {
	const s0 = initialEnvsState([baseEntry(), scoped("work", ["persona"]), scoped("lab")], undefined, "work");
	const { state } = press(s0, char("c"));
	assert.equal(state.scope?.mode, "edit");
	assert.deepEqual(state.scope?.own, ["persona"]);
	const edited = press(state, char(" "), { name: "down" }, char(" "), { name: "enter" });
	assert.deepEqual(edited.effect, { kind: "scope", name: "work", own: ["models"], share: ["persona"] });
	assert.deepEqual(press(state, { name: "enter" }).effect, undefined, "no change, nothing to apply");
	assert.equal(press(state, { name: "enter" }).state.scope, undefined);
});

test("c on the base home explains it is the shared configuration", () => {
	const { state, effect } = press(initialEnvsState([baseEntry(), scoped("work")]), char("c"));
	assert.equal(effect, undefined);
	assert.equal(state.scope, undefined);
	assert.match(state.message ?? "", /shared configuration/);
});

test("the form renders as a Gentle card with each category's choice and the source", () => {
	const s0 = initialEnvsState([baseEntry(), scoped("work", ["persona"])]);
	const { state } = press(s0, char("n"), ...typed("client"), { name: "enter" }, { name: "down" }, char(" "));
	const text = renderEnvsScreen(state, 110, 30).map(stripAnsi).join("\n");
	assert.match(text, /╭─ ✿ New env · client ─+╮/);
	assert.match(text, /Models & profiles +Shared with base/);
	assert.match(text, /❯ Persona +Own copy/);
	assert.match(text, /New own copies from +Gentle Shell base/);
	assert.match(text, /space toggle/);
	assert.match(text, /enter create/);
});

test("the detail card names each env's config scope", () => {
	const s0 = initialEnvsState([baseEntry(), scoped("work", ["persona", "appearance"])], undefined, "work");
	assert.match(renderEnvsScreen(s0, 120, 30).map(stripAnsi).join("\n"), /Config +own persona, appearance · shares models & profiles, behavior/);
	const base = renderEnvsScreen(initialEnvsState([baseEntry(), scoped("work")], undefined, { base: true }), 120, 30).map(stripAnsi).join("\n");
	assert.match(base, /Config +the shared configuration envs can reuse/);
});
