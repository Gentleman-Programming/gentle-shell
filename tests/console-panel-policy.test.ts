import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONSOLE_PANEL_SCHEMA,
	consolePanelPath,
	defaultConsolePanelState,
	readConsolePanelState,
	resolveConsolePanelState,
	withConsoleCollapsed,
	withPanelFolded,
	writeConsolePanelState,
} from "../lib/console-panel-policy.ts";

test("el estado por defecto es la columna abierta y ningún panel plegado", () => {
	const state = defaultConsolePanelState();
	assert.equal(state.collapsed, false);
	assert.deepEqual(state.folded, []);
});

test("un archivo con otro esquema o malformado no rompe la consola", () => {
	assert.deepEqual(resolveConsolePanelState({ schema: "otro" }), defaultConsolePanelState());
	assert.deepEqual(resolveConsolePanelState("nada"), defaultConsolePanelState());
	assert.deepEqual(resolveConsolePanelState({ schema: CONSOLE_PANEL_SCHEMA, collapsed: "sí" }), {
		schema: CONSOLE_PANEL_SCHEMA,
		collapsed: false,
		folded: [],
	});
});

test("el estado se escribe atómico y se relee igual", () => {
	const dir = mkdtempSync(join(tmpdir(), "console-panel-"));
	const path = consolePanelPath(dir);
	const state = withPanelFolded(withConsoleCollapsed(defaultConsolePanelState(), true), "tree", true);
	writeConsolePanelState(state, path);

	const read = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(read.schema, CONSOLE_PANEL_SCHEMA);
	assert.equal(read.collapsed, true);
	assert.deepEqual(read.folded, ["tree"]);
	assert.deepEqual(readConsolePanelState(path), state);
});

test("un archivo inexistente o inválido devuelve los valores por defecto", () => {
	const dir = mkdtempSync(join(tmpdir(), "console-panel-"));
	assert.deepEqual(readConsolePanelState(join(dir, "no-existe.json")), defaultConsolePanelState());
	const broken = join(dir, "roto.json");
	writeFileSync(broken, "{no es json", "utf8");
	assert.deepEqual(readConsolePanelState(broken), defaultConsolePanelState());
});

test("plegar un panel es reversible y no repite claves", () => {
	let state = defaultConsolePanelState();
	state = withPanelFolded(state, "tree", true);
	state = withPanelFolded(state, "tree", true);
	assert.deepEqual(state.folded, ["tree"]);
	state = withPanelFolded(state, "tree", false);
	assert.deepEqual(state.folded, []);
});
