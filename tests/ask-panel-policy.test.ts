import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ASK_PANEL_DEFAULT_STATE,
	ASK_PANEL_DEFAULTS,
	ASK_PANEL_INDICATOR,
	ASK_PANEL_SCHEMA,
	parseAskPanelFile,
	resolveAskPanelPreferences,
	writeAskPanelPreferences,
} from "../lib/ask-panel-policy.ts";

const home = () => mkdtempSync(join(tmpdir(), "gentle-ask-panel-"));
const file = (dir: string) => join(dir, "ask-panel.json");

test("a missing preference file means the default panel", () => {
	const dir = home();
	assert.deepEqual(resolveAskPanelPreferences({ gentlePiConfigHome: dir }), {
		preferences: ASK_PANEL_DEFAULTS,
		source: "default",
		malformed: false,
		globalFile: file(dir),
	});
});

test("the preference round-trips through the atomic writer", () => {
	const dir = home();
	const path = writeAskPanelPreferences({ indicator: ASK_PANEL_INDICATOR.TABBED, defaultState: ASK_PANEL_DEFAULT_STATE.AUTO }, { gentlePiConfigHome: dir });
	assert.equal(path, file(dir));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		schema: ASK_PANEL_SCHEMA,
		indicator: "tabbed",
		defaultState: "auto",
	});
	assert.deepEqual(resolveAskPanelPreferences({ gentlePiConfigHome: dir }), {
		preferences: { indicator: "tabbed", defaultState: "auto" },
		source: "global_file",
		malformed: false,
		globalFile: path,
	});
	writeAskPanelPreferences({ indicator: ASK_PANEL_INDICATOR.ANSWERS, defaultState: ASK_PANEL_DEFAULT_STATE.COLLAPSED }, { gentlePiConfigHome: dir });
	assert.deepEqual(resolveAskPanelPreferences({ gentlePiConfigHome: dir }).preferences, {
		indicator: "answers",
		defaultState: "collapsed",
	});
	assert.equal(statSync(path).mode & 0o777, 0o600, "the preference file is private");
	assert.deepEqual(readdirSync(dir), ["ask-panel.json"], "no temporary file survives the rename");
});

test("the writer rejects values outside the documented domains", () => {
	const dir = home();
	assert.throws(() => writeAskPanelPreferences({ indicator: "bogus" as never, defaultState: "expanded" }, { gentlePiConfigHome: dir }), TypeError);
	assert.throws(() => writeAskPanelPreferences({ indicator: "minimal", defaultState: "bogus" as never }, { gentlePiConfigHome: dir }), TypeError);
	assert.equal(existsSync(file(dir)), false);
});

test("parseAskPanelFile accepts exactly the three expected keys with known values", () => {
	assert.deepEqual(parseAskPanelFile(JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "minimal", defaultState: "auto" })), {
		indicator: "minimal",
		defaultState: "auto",
	});
	assert.deepEqual(parseAskPanelFile(JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "answers", defaultState: "expanded" })), {
		indicator: "answers",
		defaultState: "expanded",
	});
});

test("invalid or unreadable preference files read as defaults and are never overwritten", () => {
	const malformed = [
		"",
		"{",
		"[]",
		"null",
		JSON.stringify({ schema: "other/v1", indicator: "minimal", defaultState: "expanded" }),
		JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "minimal" }),
		JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "minimal", defaultState: "expanded", extra: 1 }),
		JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "bogus", defaultState: "expanded" }),
		JSON.stringify({ schema: ASK_PANEL_SCHEMA, indicator: "minimal", defaultState: "bogus" }),
	];
	for (const raw of malformed) {
		assert.equal(parseAskPanelFile(raw), undefined, raw);
		const dir = home();
		const path = file(dir);
		writeFileSync(path, raw);
		assert.deepEqual(resolveAskPanelPreferences({ gentlePiConfigHome: dir }), {
			preferences: ASK_PANEL_DEFAULTS,
			source: "global_file",
			malformed: true,
			globalFile: path,
		}, raw);
		assert.throws(() => writeAskPanelPreferences(ASK_PANEL_DEFAULTS, { gentlePiConfigHome: dir }), /Cannot update malformed or unreadable ask panel preference/, raw);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}

	const dir = home();
	mkdirSync(file(dir));
	assert.equal(resolveAskPanelPreferences({ gentlePiConfigHome: dir }).malformed, true, "a directory in its place is unreadable, not missing");
	if (process.getuid?.() !== 0) {
		const locked = home();
		writeAskPanelPreferences(ASK_PANEL_DEFAULTS, { gentlePiConfigHome: locked });
		chmodSync(file(locked), 0o000);
		try {
			assert.deepEqual({ ...resolveAskPanelPreferences({ gentlePiConfigHome: locked }), globalFile: "" }, {
				preferences: ASK_PANEL_DEFAULTS,
				source: "global_file",
				malformed: true,
				globalFile: "",
			});
		} finally {
			chmodSync(file(locked), 0o600);
		}
	}
});
