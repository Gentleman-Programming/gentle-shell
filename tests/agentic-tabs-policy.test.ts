import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENTIC_TABS, AGENTIC_TABS_SCHEMA, normalizeAgenticTab, parseAgenticTabs, resolveAgenticTabs, writeAgenticTabs } from "../lib/agentic-tabs-policy.ts";

const CONSOLE_TABS = ["main", "git", "prof", "mem", "tree", "wt"] as const;

test("la configuración es reversible, canónica y no reemplaza datos inválidos", () => {
	const home = mkdtempSync(join(tmpdir(), "agentic-tabs-"));
	try {
		const options = { gentlePiConfigHome: home };
		// La fila numerada de la consola: MAIN siempre visible, en orden fijo.
		assert.deepEqual(AGENTIC_TABS, CONSOLE_TABS);
		assert.deepEqual(resolveAgenticTabs(options).tabs, CONSOLE_TABS);
		writeAgenticTabs(["wt", "tree", "main"], options);
		assert.deepEqual(resolveAgenticTabs(options).tabs, ["main", "tree", "wt"], "se escribe en el orden de la fila, no en el de entrada");
		assert.throws(() => writeAgenticTabs(["git", "tree"], options), /inválida/, "MAIN no se puede ocultar");
		assert.equal(parseAgenticTabs(JSON.stringify({ schema: AGENTIC_TABS_SCHEMA, tabs: ["main", "main"] })), undefined);
		assert.equal(parseAgenticTabs(JSON.stringify({ schema: AGENTIC_TABS_SCHEMA, tabs: ["tree"] })), undefined, "sin MAIN no hay preferencia válida");
		const path = join(home, "agentic-tabs.json");
		writeFileSync(path, "{no tocar");
		assert.equal(resolveAgenticTabs(options).malformed, true);
		assert.throws(() => writeAgenticTabs(CONSOLE_TABS, options), /inválida o ilegible/);
		assert.equal(readFileSync(path, "utf8"), "{no tocar");
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("un archivo con los nombres viejos se lee, se canoniza y no queda malformado", () => {
	const home = mkdtempSync(join(tmpdir(), "agentic-tabs-legacy-"));
	try {
		const options = { gentlePiConfigHome: home };
		const path = join(home, "agentic-tabs.json");
		// El archivo que dejó la fila anterior (Inicio/Git/Perfil/Memoria/Stats).
		writeFileSync(path, JSON.stringify({ schema: AGENTIC_TABS_SCHEMA, tabs: ["inicio", "git", "perfil", "memoria", "stats"] }));
		const loaded = resolveAgenticTabs(options);
		assert.equal(loaded.malformed, false, "un archivo legado es válido: no degrada ni avisa");
		// `stats` se fusionó con `main` en la consola, así que no duplica la pestaña,
		// y TREE/WT se suman: un archivo legado no pudo haber pedido ocultarlas.
		assert.deepEqual(loaded.tabs, ["main", "git", "prof", "mem", "tree", "wt"]);
		writeAgenticTabs(loaded.tabs, options);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: AGENTIC_TABS_SCHEMA, tabs: ["main", "git", "prof", "mem", "tree", "wt"] });
		// `/gentle:tab` sigue aceptando los nombres viejos.
		assert.equal(normalizeAgenticTab("inicio"), "main");
		assert.equal(normalizeAgenticTab("stats"), "main");
		assert.equal(normalizeAgenticTab("perfil"), "prof");
		assert.equal(normalizeAgenticTab("memoria"), "mem");
		assert.equal(normalizeAgenticTab(" TREE "), "tree");
		assert.equal(normalizeAgenticTab("no-existe"), undefined);
	} finally { rmSync(home, { recursive: true, force: true }); }
});
