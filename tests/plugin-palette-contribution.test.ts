import assert from "node:assert/strict";
import test from "node:test";
import { CONTRIBUTIONS, CONTRACT_VERSION, contributionSlot } from "../lib/plugin-contract.ts";
import type { PluginPaletteCommand } from "../lib/plugin-contract.ts";
import { buildCommandPaletteGroups, COMMAND_PALETTE_CATALOG } from "../lib/command-palette-catalog.ts";
import type { CommandPaletteGroup } from "../lib/command-palette.ts";

// Palette read point for community plugin contributions: `/gentle:commands`
// keeps its curated catalog exactly as it is and appends a contributed
// command only when that command is really registered. These tests are the
// S9 canary: dropping the contribution merge from buildCommandPaletteGroups
// fails them.

interface RegisteredCommand {
	name: string;
	description?: string;
}

const REGISTERED: readonly RegisteredCommand[] = [
	{ name: "gentle:profiles", description: "Configure models" },
	{ name: "acme:deploy", description: "Deploy the acme stack" },
	{ name: "gentle:changes", description: "Browse changes" },
	{ name: "gentle:status", description: "Show status" },
	{ name: "unlisted:quiet", description: "Registered, contributed by nobody" },
];

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

/** Install one contribution the way a foreign package would: through the slot. */
function contribute(id: string, palette: PluginPaletteCommand): void {
	const owner = id.slice(0, id.indexOf("."));
	contributionSlot().set(id, { id, owner, contract: CONTRACT_VERSION, palette });
}

/** Independent restatement of the catalog-only result the no-op proof compares against. */
function catalogOnly(registered: readonly RegisteredCommand[], shortcuts: Readonly<Record<string, string | undefined>>): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const groups: CommandPaletteGroup[] = [];
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items = [];
		for (const entry of group.items) {
			const found = byName.get(entry.command);
			if (!found) continue;
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command] });
		}
		if (items.length > 0) groups.push({ title: group.title, items });
	}
	return groups;
}

function commandsOf(groups: readonly CommandPaletteGroup[]): string[] {
	return groups.flatMap((group) => group.items.map((item) => item.command));
}

test("a contributed command is appended to the palette in its declared group", () => {
	reset();
	contribute("acme.deploy", { command: "acme:deploy", group: "Acme" });
	const groups = buildCommandPaletteGroups(REGISTERED, { "acme:deploy": "alt+a" });

	assert.deepEqual(groups.map((group) => group.title), ["Configuration", "Session", "Diagnostics", "Acme"]);
	const acme = groups.find((group) => group.title === "Acme");
	assert.deepEqual(acme?.items.map((item) => item.command), ["acme:deploy"]);
	assert.equal(acme?.items[0]?.label, "acme:deploy");
	assert.equal(acme?.items[0]?.description, "Deploy the acme stack");
	assert.equal(acme?.items[0]?.shortcut, "alt+a");
	// The catalog stays a static constant: the contribution is merged at build time only.
	assert.deepEqual(
		COMMAND_PALETTE_CATALOG.flatMap((group) => group.items.map((item) => item.command)).includes("acme:deploy"),
		false,
	);
});

test("an uncatalogued registered command with no contribution still never appears", () => {
	reset();
	const groups = buildCommandPaletteGroups(REGISTERED, {});
	assert.equal(commandsOf(groups).includes("unlisted:quiet"), false);
	assert.deepEqual(groups, catalogOnly(REGISTERED, {}));
});

test("a contribution pointing at an unregistered command is skipped instead of rendering a dead row", () => {
	reset();
	contribute("acme.ghost", { command: "acme:ghost", group: "Ghosts" });
	const groups = buildCommandPaletteGroups(REGISTERED, {});

	assert.equal(groups.some((group) => group.title === "Ghosts"), false);
	assert.equal(commandsOf(groups).includes("acme:ghost"), false);
	assert.deepEqual(groups, catalogOnly(REGISTERED, {}));
});

test("with an empty box the built groups are identical to the catalog-only result", () => {
	reset();
	assert.deepEqual(buildCommandPaletteGroups(REGISTERED, {}), catalogOnly(REGISTERED, {}));
	assert.deepEqual(buildCommandPaletteGroups([], {}), []);
});

test("group and entry order are reproducible across builds", () => {
	reset();
	contribute("acme.deploy", { command: "acme:deploy", group: "Acme" });
	contribute("acme.audit", { command: "unlisted:quiet", group: "Acme" });
	const first = buildCommandPaletteGroups(REGISTERED, {});
	const second = buildCommandPaletteGroups(REGISTERED, {});

	assert.deepEqual(second, first);
	assert.deepEqual(first.map((group) => group.title), ["Configuration", "Session", "Diagnostics", "Acme"]);
	assert.deepEqual(
		first.find((group) => group.title === "Acme")?.items.map((item) => item.command),
		["acme:deploy", "unlisted:quiet"],
	);
});

test("a contribution for a catalogued command never duplicates or moves it", () => {
	reset();
	contribute("acme.status", { command: "gentle:status", group: "Acme" });
	const groups = buildCommandPaletteGroups(REGISTERED, {});

	assert.equal(groups.some((group) => group.title === "Acme"), false);
	assert.equal(commandsOf(groups).filter((command) => command === "gentle:status").length, 1);
	assert.deepEqual(groups, catalogOnly(REGISTERED, {}));
});

test("a contributed command joins an existing catalog group after its catalogued entries", () => {
	reset();
	contribute("acme.deploy", { command: "acme:deploy", group: "Session" });
	const groups = buildCommandPaletteGroups(REGISTERED, {});

	assert.deepEqual(groups.map((group) => group.title), ["Configuration", "Session", "Diagnostics"]);
	assert.deepEqual(
		groups.find((group) => group.title === "Session")?.items.map((item) => item.command),
		["gentle:changes", "acme:deploy"],
	);
});

test("the first contribution in read order owns a command, so the result is deterministic", () => {
	reset();
	contribute("acme.deploy", { command: "acme:deploy", group: "First" });
	contribute("other.deploy", { command: "acme:deploy", group: "Second" });
	const groups = buildCommandPaletteGroups(REGISTERED, {});

	const owners = groups.filter((group) => group.items.some((item) => item.command === "acme:deploy"));
	assert.deepEqual(owners.map((group) => group.title), ["First"]);
	assert.equal(commandsOf(groups).filter((command) => command === "acme:deploy").length, 1);

	reset();
	contribute("other.deploy", { command: "acme:deploy", group: "Second" });
	contribute("acme.deploy", { command: "acme:deploy", group: "First" });
	assert.deepEqual(
		buildCommandPaletteGroups(REGISTERED, {}).filter((group) => group.items.some((item) => item.command === "acme:deploy")).map((group) => group.title),
		["Second"],
	);
});

test("a contribution whose palette payload is malformed contributes nothing", () => {
	reset();
	contributionSlot().set("acme.broken", {
		id: "acme.broken",
		owner: "acme",
		contract: CONTRACT_VERSION,
		palette: { command: "acme:deploy" } as unknown as PluginPaletteCommand,
	});
	const groups = buildCommandPaletteGroups(REGISTERED, {});
	assert.deepEqual(groups, catalogOnly(REGISTERED, {}));
});
