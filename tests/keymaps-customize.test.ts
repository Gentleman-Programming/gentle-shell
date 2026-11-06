import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKeymapRows, type KeymapRowsOptions } from "../lib/keymaps-customize.ts";
import type { CustomizeInline, CustomizeRow } from "../lib/visual-customize-view.ts";
import type { PiKeybindings } from "../lib/keymaps.ts";

// The Keymaps category of /gentle:customize: one row per action and palette
// command; Enter captures the next key, ⌫ disables, r restores the default.

const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

const PI_KEYS: PiKeybindings = {
	getKeys: (binding) => binding === "tui.editor.deleteToLineEnd" ? ["ctrl+k"] : [],
	getResolvedBindings: () => ({ "tui.editor.deleteToLineEnd": "ctrl+k" }),
};

function setup(env: NodeJS.ProcessEnv = {}) {
	const configHome = mkdtempSync(join(tmpdir(), "gentle-keymaps-customize-"));
	homes.push(configHome);
	const notices: Array<{ message: string; type: string }> = [];
	let reloads = 0;
	const options: KeymapRowsOptions = {
		env, configHome, keybindings: () => PI_KEYS,
		commands: [{ command: "gentle:changes", label: "Browse changes" }, { command: "gentle:design", label: "Design · HTML artboards" }],
		notify: (message, type) => notices.push({ message, type }),
		reload: () => { reloads += 1; },
	};
	const rows = buildKeymapRows(options);
	const row = (prefix: string) => rows.find((candidate) => label(candidate).startsWith(prefix))!;
	const saved = () => existsSync(join(configHome, "keymaps.json")) ? JSON.parse(readFileSync(join(configHome, "keymaps.json"), "utf8")).bindings : undefined;
	return { rows, row, notices, saved, configHome, reloads: () => reloads };
}

function label(row: CustomizeRow): string {
	return typeof row.label === "function" ? row.label() : row.label;
}

/** An inline bridge whose capture answers with `key` and whose confirm answers `yes`. */
function inline(key: string | undefined, yes = true, asked: string[] = []): CustomizeInline {
	return { capture: async () => key, confirm: async (message) => { asked.push(message); return yes; }, input: async () => undefined, disposed: false };
}

test("every action and palette command has a Keymaps row with its current key, plus a reload row", () => {
	const { rows } = setup({ GENTLE_PI_AGENTS_VIEW_KEY: "alt+w" });
	assert.ok(rows.every((row) => row.category === "Keymaps"));
	assert.deepEqual(rows.map(label), [
		"Command palette: alt+k", "Browse changes: alt+g", "Subscription usage: alt+u", "Cycle visual preset: alt+l",
		"Subagents overlay: alt+w (GENTLE_PI_AGENTS_VIEW_KEY)", "Stop active subagents: alt+s", "Collapse the agents card: ctrl+shift+a",
		"Collapse the jobs card: ctrl+shift+j", "Collapse the todo list: ctrl+shift+t", "Usage stats: none",
		"/gentle:design · Design · HTML artboards: none", "Reload now to apply keymap changes",
	]);
});

test("Enter captures a key, saves it, and tells the user to reload", async () => {
	const { row, notices, saved } = setup();
	await row("Command palette").action(inline("\x1bj"));
	assert.deepEqual(saved(), { commands: "alt+j" });
	assert.equal(label(row("Command palette")), "Command palette: alt+j");
	assert.deepEqual(notices.at(-1), { message: "Command palette: alt+j. Run /reload to apply it.", type: "info" });
	await row("/gentle:design").action(inline("\x1bd"));
	assert.deepEqual(saved(), { commands: "alt+j", "command:gentle:design": "alt+d" });
	await row("Usage stats").action(inline(undefined));
	assert.deepEqual(saved(), { commands: "alt+j", "command:gentle:design": "alt+d" }, "a cancelled capture saves nothing");
});

test("a reserved key, a typing key or an environment-controlled action is refused and saves nothing", async () => {
	const { row, notices, saved } = setup({ GENTLE_PI_AGENTS_VIEW_KEY: "alt+w" });
	await row("Command palette").action(inline("\x0b"));
	assert.deepEqual(notices.at(-1), { message: "ctrl+k is reserved by Pi (tui.editor.deleteToLineEnd); choose another key.", type: "warning" });
	await row("Command palette").action(inline("a"));
	assert.match(notices.at(-1)!.message, /a is needed for typing/);
	await row("Subagents overlay").action(inline("\x1bv"));
	assert.deepEqual(notices.at(-1), { message: "Subagents overlay is set by GENTLE_PI_AGENTS_VIEW_KEY; unset it to change the key here.", type: "warning" });
	assert.equal(saved(), undefined);
});

test("a key used by another action moves only after confirmation", async () => {
	const { row, saved } = setup();
	const asked: string[] = [];
	await row("Command palette").action(inline("\x1bg", false, asked));
	assert.deepEqual(asked, ["alt+g is used by Browse changes. Move it to Command palette?"]);
	assert.equal(saved(), undefined);
	await row("Command palette").action(inline("\x1bg", true));
	assert.deepEqual(saved(), { commands: "alt+g", changes: null });
	assert.equal(label(row("Browse changes")), "Browse changes: none");
});

test("⌫ disables a key, r restores the default, and the reload row reloads", async () => {
	const { row, saved, notices, reloads } = setup();
	const bridge = inline(undefined);
	assert.equal(row("Browse changes").key!("\x7f", bridge), true);
	assert.deepEqual(saved(), { changes: null });
	assert.deepEqual(notices.at(-1), { message: "Browse changes: none. Run /reload to apply it.", type: "info" });
	assert.equal(row("Browse changes").key!("r", bridge), true);
	assert.deepEqual(saved(), {});
	assert.equal(label(row("Browse changes")), "Browse changes: alt+g");
	assert.equal(row("Browse changes").key!("x", bridge), false, "other keys stay with the card");
	await row("Reload now").action(bridge);
	assert.equal(reloads(), 1);
});

test("a malformed keymaps.json is never overwritten", async () => {
	const { row, notices, configHome } = setup();
	writeFileSync(join(configHome, "keymaps.json"), "{");
	await row("Command palette").action(inline("\x1bj"));
	assert.equal(readFileSync(join(configHome, "keymaps.json"), "utf8"), "{");
	assert.deepEqual(notices.at(-1), { message: `Keymaps: ${join(configHome, "keymaps.json")} is unreadable or malformed; fix or delete it to change keys.`, type: "error" });
	assert.equal(row("Browse changes").key!("\x7f", inline(undefined)), true);
	assert.equal(readFileSync(join(configHome, "keymaps.json"), "utf8"), "{");
});
