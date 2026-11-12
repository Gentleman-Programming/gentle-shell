import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { CONTRIBUTIONS, CONTRACT_VERSION, contributionSlot } from "../lib/plugin-contract.ts";
import type { Contribution, PluginRow } from "../lib/plugin-contract.ts";
import { PLUGINS_SCHEMA, parsePluginOrderFile, readPluginOrder } from "../lib/plugin-order.ts";
import { installContributedSidebar } from "../lib/shell-sidebar.ts";
import type { CustomizeRow } from "../lib/visual-customize-view.ts";
import { appendPluginCustomizeRows } from "../extensions/gentle-shell.ts";

// The declared order is the whole point of `plugins.json`: the file names
// owners, never ids, and every read point must apply it at use time. These
// tests pin the one reader and the three surfaces that now honour it, so a
// refactor that drops the order from a read point fails here.

const noop = (): void => {};

function scratch(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-plugin-order-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Write the only shape the reader accepts, the way a user hand-edits it. */
function pluginsFile(dir: string, order: readonly string[]): string {
	const path = join(dir, "plugins.json");
	writeFileSync(path, `${JSON.stringify({ schema: PLUGINS_SCHEMA, order })}\n`);
	return path;
}

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function contribution(id: string, extra: Partial<Contribution>): Contribution {
	const owner = id.slice(0, id.indexOf("."));
	return { id, owner, contract: CONTRACT_VERSION, ...extra };
}

function row(label: string): PluginRow {
	return { category: "Plugins", label, action: noop };
}

function fakeTui(): TUI {
	return { terminal: {} } as unknown as TUI;
}

const REGISTERED = [
	{ name: "gentle:status", description: "Show status" },
	{ name: "zeta:first", description: "Zeta first" },
	{ name: "acme:second", description: "Acme second" },
];

/** Install the two palette contributions in an order the file can override. */
function paletteContributions(): void {
	const slot = contributionSlot();
	slot.set("zeta.first", contribution("zeta.first", { palette: { command: "zeta:first", group: "Zed" } }));
	slot.set("acme.second", contribution("acme.second", { palette: { command: "acme:second", group: "Acme" } }));
}

function paletteCommands(groups: ReturnType<typeof buildCommandPaletteGroups>): string[] {
	return groups.flatMap((group) => group.items.map((item) => item.command));
}

function customLabels(rows: readonly CustomizeRow[]): string[] {
	return rows.slice(1).map((entry) => (typeof entry.label === "function" ? entry.label() : entry.label));
}

test("a missing plugins.json means no declared order, and the reader owns the schema", (t) => {
	assert.equal(PLUGINS_SCHEMA, "gentle-pi.plugins/v1");
	const dir = scratch(t);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: dir }), {
		order: [],
		source: "default",
		malformed: false,
		globalFile: join(dir, "plugins.json"),
	});
});

test("a valid plugins.json supplies the owner order in the sequence it names", (t) => {
	const dir = scratch(t);
	const path = pluginsFile(dir, ["beta", "acme"]);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: dir }), {
		order: ["beta", "acme"],
		source: "global_file",
		malformed: false,
		globalFile: path,
	});
	assert.deepEqual(parsePluginOrderFile(readFileSync(path, "utf8")), ["beta", "acme"]);
});

test("a malformed, wrongly schemated or unreadable plugins.json reads as no order and is never rewritten", (t) => {
	const dir = scratch(t);
	const path = join(dir, "plugins.json");
	const malformed = [
		"",
		"{",
		"[]",
		"null",
		`{"schema":"${PLUGINS_SCHEMA}"}`,
		`{"schema":"other/v1","order":["acme"]}`,
		`{"schema":"${PLUGINS_SCHEMA}","order":"acme"}`,
		`{"schema":"${PLUGINS_SCHEMA}","order":["acme",7]}`,
		`{"schema":"${PLUGINS_SCHEMA}","order":["acme"],"extra":1}`,
	];
	for (const raw of malformed) {
		writeFileSync(path, raw);
		assert.equal(parsePluginOrderFile(raw), undefined, raw);
		assert.deepEqual(
			readPluginOrder({ gentlePiConfigHome: dir }),
			{ order: [], source: "global_file", malformed: true, globalFile: path },
			raw,
		);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}
	// Unreadable: the path is a directory, so reading it fails.
	const unreadable = scratch(t);
	mkdirSync(join(unreadable, "plugins.json"));
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: unreadable }), {
		order: [],
		source: "global_file",
		malformed: true,
		globalFile: join(unreadable, "plugins.json"),
	});
});

test("the injected home is the only place the reader looks", (t) => {
	const home = scratch(t);
	const other = scratch(t);
	pluginsFile(other, ["acme"]);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: home }).order, []);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: other }).order, ["acme"]);
});

test("the palette lists contributed commands in the declared owner order", (t) => {
	const dir = scratch(t);
	reset();
	t.after(reset);
	paletteContributions();

	const undeclared = buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir });
	assert.deepEqual(undeclared.map((group) => group.title), ["Diagnostics", "Zed", "Acme"]);
	assert.deepEqual(paletteCommands(undeclared), ["gentle:status", "zeta:first", "acme:second"]);

	pluginsFile(dir, ["acme"]);
	const declared = buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir });
	assert.deepEqual(declared.map((group) => group.title), ["Diagnostics", "Acme", "Zed"]);
	assert.deepEqual(paletteCommands(declared), ["gentle:status", "acme:second", "zeta:first"]);
});

test("a plugins.json naming an owner with no contribution, or a malformed one, changes nothing", (t) => {
	const dir = scratch(t);
	reset();
	t.after(reset);
	paletteContributions();

	// No file: the baseline every later comparison uses.
	const baseline = buildCommandPaletteGroups(REGISTERED, {});
	const empty = join(dir, "missing");
	mkdirSync(empty);
	assert.deepEqual(buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: empty }), baseline, "a missing file is the baseline");

	pluginsFile(dir, ["ghost"]);
	assert.deepEqual(buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir }), baseline, "an owner with no contribution changes nothing");

	writeFileSync(join(dir, "plugins.json"), `{"schema":"${PLUGINS_SCHEMA}","order":"acme"}`);
	assert.deepEqual(buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir }), baseline, "a malformed file changes nothing");
});

test("the palette re-reads plugins.json on the next build instead of caching it", (t) => {
	const dir = scratch(t);
	reset();
	t.after(reset);
	paletteContributions();

	pluginsFile(dir, ["acme"]);
	assert.deepEqual(paletteCommands(buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir })), [
		"gentle:status",
		"acme:second",
		"zeta:first",
	]);
	pluginsFile(dir, ["zeta"]);
	assert.deepEqual(paletteCommands(buildCommandPaletteGroups(REGISTERED, {}, { gentlePiConfigHome: dir })), [
		"gentle:status",
		"zeta:first",
		"acme:second",
	]);
});

test("the rail's contributed section keys follow the declared owner order", (t) => {
	const dir = scratch(t);
	reset();
	t.after(reset);
	const slot = contributionSlot();
	const rail = () => ({ render: () => ["section"], invalidate() {} });
	slot.set("zeta.nav", contribution("zeta.nav", { sidebar: { key: "plugin:zeta:nav", bottom: false, rail: rail() } }));
	slot.set("acme.nav", contribution("acme.nav", { sidebar: { key: "plugin:acme:nav", bottom: false, rail: rail() } }));

	assert.deepEqual(installContributedSidebar(fakeTui(), { gentlePiConfigHome: dir }).keys, ["plugin:zeta:nav", "plugin:acme:nav"]);
	pluginsFile(dir, ["acme"]);
	assert.deepEqual(installContributedSidebar(fakeTui(), { gentlePiConfigHome: dir }).keys, ["plugin:acme:nav", "plugin:zeta:nav"]);
});

test("the appended customize rows follow the declared owner order", (t) => {
	const dir = scratch(t);
	reset();
	t.after(reset);
	const slot = contributionSlot();
	slot.set("zeta.rows", contribution("zeta.rows", { rows: [row("Zeta row")] }));
	slot.set("acme.rows", contribution("acme.rows", { rows: [row("Acme row")] }));

	const appended = (): string[] => {
		const rows: CustomizeRow[] = [{ category: "Animations", label: "Built-in row", action: noop }];
		appendPluginCustomizeRows(rows, noop, { gentlePiConfigHome: dir });
		return customLabels(rows);
	};

	assert.deepEqual(appended(), ["Zeta row", "Acme row"]);
	pluginsFile(dir, ["acme"]);
	assert.deepEqual(appended(), ["Acme row", "Zeta row"]);
});
