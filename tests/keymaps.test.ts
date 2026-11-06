import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assignKeymap, checkKeymap, commandKeymapId, commandKeymapIds, effectiveKey, keyFromInput, KEYMAP_ACTIONS,
	keymapCommand, keymapSource, normalizeKeyId, readKeymaps, resetKeymap, writeKeymaps, type PiKeybindings,
} from "../lib/keymaps.ts";

// The keymap registry every Gentle shortcut reads: environment variable
// first (unchanged behavior), then the saved keymaps.json, then the default.

const DEFAULTS: Record<string, string | undefined> = {
	commands: "alt+k", changes: "alt+g", usage: "alt+u", preset: "alt+l", "agents.view": "alt+a",
	"agents.stop": "alt+s", "agents.collapse": "ctrl+shift+a", "jobs.collapse": "ctrl+shift+j", "todo.collapse": "ctrl+shift+t", "stats.view": undefined,
};

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "gentle-keymaps-"));
}

/** Pi's default bindings for the few ids the checks look at. */
const PI_KEYS: PiKeybindings = {
	getKeys: (binding) => ({ "tui.editor.deleteToLineEnd": ["ctrl+k"], "app.clear": ["ctrl+c"], "app.model.cycleBackward": ["shift+ctrl+p"] } as Record<string, string[]>)[binding] ?? [],
	getResolvedBindings: () => ({ "tui.editor.deleteToLineEnd": "ctrl+k", "app.clear": "ctrl+c", "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left"] }),
};

test("with no file and no environment every action keeps its default key", () => {
	for (const action of KEYMAP_ACTIONS) assert.equal(effectiveKey(action.id, {}, {}), DEFAULTS[action.id], action.id);
	assert.deepEqual(KEYMAP_ACTIONS.map((action) => action.id).sort(), Object.keys(DEFAULTS).sort());
});

test("a saved key replaces the default, null disables it, and the environment still wins", () => {
	const bindings = { commands: "alt+j", changes: null };
	assert.equal(effectiveKey("commands", {}, bindings), "alt+j");
	assert.equal(keymapSource("commands", {}, bindings), "saved");
	assert.equal(effectiveKey("changes", {}, bindings), undefined);
	assert.equal(effectiveKey("commands", { GENTLE_PI_COMMANDS_KEY: "alt+x" }, bindings), "alt+x");
	assert.equal(keymapSource("commands", { GENTLE_PI_COMMANDS_KEY: "alt+x" }, bindings), "env");
	assert.equal(effectiveKey("commands", { GENTLE_PI_COMMANDS_KEY: "off" }, bindings), undefined);
	assert.equal(effectiveKey("commands", { GENTLE_PI_COMMANDS_KEY: "" }, bindings), undefined);
	assert.equal(keymapSource("usage", {}, bindings), "default");
	assert.equal(keymapSource("stats.view", {}, bindings), "none");
});

test("any palette command gets a command keymap id, built-in commands reuse their action", () => {
	assert.equal(commandKeymapId("gentle:changes"), "changes");
	assert.equal(commandKeymapId("gentle:design"), "command:gentle:design");
	assert.equal(keymapCommand("command:gentle:design"), "gentle:design");
	assert.equal(keymapCommand("changes"), undefined);
	const bindings = { "command:gentle:design": "alt+d", "command:gentle:vim": null };
	assert.equal(effectiveKey("command:gentle:design", {}, bindings), "alt+d");
	assert.deepEqual(commandKeymapIds(bindings), ["command:gentle:design"]);
});

test("key ids are normalized and only modified keys or function keys can be assigned", () => {
	assert.equal(normalizeKeyId("Shift+Ctrl+A"), "ctrl+shift+a");
	assert.equal(normalizeKeyId("hyper+a"), undefined);
	assert.deepEqual(keyFromInput("\x1bj"), { key: "alt+j" });
	assert.deepEqual(keyFromInput("\x1b[97;6u"), { key: "ctrl+shift+a" });
	assert.deepEqual(keyFromInput("\x1bOP"), { key: "f1" });
	assert.match((keyFromInput("a") as { error: string }).error, /needed for typing/);
	assert.match((keyFromInput("\r") as { error: string }).error, /needed for typing/);
	assert.match((keyFromInput("\x1bK") as { error: string }).error, /not recognized/);
});

test("checks block Pi's reserved keys and environment-controlled actions, and confirm a moved key", () => {
	assert.deepEqual(checkKeymap("commands", "ctrl+k", {}, {}, PI_KEYS), { kind: "blocked", message: "ctrl+k is reserved by Pi (tui.editor.deleteToLineEnd); choose another key." });
	assert.equal(checkKeymap("commands", "ctrl+shift+p", {}, {}, PI_KEYS).kind, "blocked");
	assert.deepEqual(checkKeymap("commands", "alt+j", { GENTLE_PI_COMMANDS_KEY: "alt+k" }, {}, PI_KEYS), { kind: "blocked", message: "Command palette is set by GENTLE_PI_COMMANDS_KEY; unset it to change the key here." });
	assert.deepEqual(checkKeymap("commands", "alt+g", {}, {}, PI_KEYS), { kind: "confirm", message: "alt+g is used by Browse changes. Move it to Command palette?", displaces: "changes" });
	assert.equal(checkKeymap("command:gentle:design", "alt+d", {}, { "command:gentle:vim": "alt+d" }, PI_KEYS).kind, "confirm");
	assert.deepEqual(checkKeymap("commands", "alt+left", {}, {}, PI_KEYS), { kind: "confirm", message: "alt+left is Pi's tui.editor.cursorWordLeft. Use it for Command palette instead?" });
	assert.deepEqual(checkKeymap("commands", "alt+j", {}, {}, PI_KEYS), { kind: "ok" });
	assert.deepEqual(checkKeymap("commands", "alt+k", {}, {}, PI_KEYS), { kind: "ok" }, "its own key is not a conflict");
});

test("assigning moves a key off the displaced action, and reset restores the default", () => {
	const moved = assignKeymap({}, "commands", "alt+g", "changes");
	assert.deepEqual(moved, { commands: "alt+g", changes: null });
	assert.deepEqual(assignKeymap({}, "commands", "Shift+Ctrl+X"), { commands: "ctrl+shift+x" });
	assert.deepEqual(resetKeymap(moved, "changes"), { commands: "alt+g" });
	assert.equal(effectiveKey("changes", {}, resetKeymap(moved, "changes")), "alt+g");
});

test("keymaps.json round-trips atomically and a malformed file is reported, not used", () => {
	const home = scratch();
	try {
		assert.deepEqual(readKeymaps(home), { bindings: {}, path: join(home, "keymaps.json"), malformed: false });
		const path = writeKeymaps(home, { commands: "alt+j", changes: null });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: 1, bindings: { commands: "alt+j", changes: null } });
		assert.deepEqual(readKeymaps(home).bindings, { commands: "alt+j", changes: null });
		assert.deepEqual(readdirSync(home), ["keymaps.json"], "no temporary file is left behind");
		for (const bad of ["{", "[]", '{"schema":2,"bindings":{}}', '{"schema":1,"bindings":{"commands":3}}', '{"schema":1,"bindings":{"commands":"hyper+a"}}']) {
			writeFileSync(path, bad);
			assert.deepEqual(readKeymaps(home), { bindings: {}, path, malformed: true }, bad);
			assert.equal(readFileSync(path, "utf8"), bad, "reading never rewrites the file");
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
