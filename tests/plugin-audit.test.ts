import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	PLUGINS_SCHEMA,
	buildPluginAudit,
	captureUiSetters,
	formatPluginAudit,
	readPluginOrder,
	replacedUiSetters,
} from "../lib/plugin-audit.ts";
import {
	CONTRIBUTIONS,
	CONTRACT_VERSION,
	contributionSlot,
	readContributionReport,
	readContributions,
} from "../lib/plugin-contract.ts";
import type { Contribution, PluginRail, PluginRow } from "../lib/plugin-contract.ts";
import { installContributedSidebar, readSidebarContributionReport } from "../lib/shell-sidebar.ts";
import installGentlePlugins, { PLUGINS_COMMAND_NAME } from "../extensions/gentle-plugins.ts";

// /gentle:plugins: the audit surface for community contributions. The order
// reader fails open (no file, or a broken one, means insertion order), the
// audit model is plain data, the formatter is plain bounded text, and the
// `ctx.ui` setter replacement finding is best-effort by construction.

const noop = (): void => {};

function scratch(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-plugins-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function row(): PluginRow {
	return { category: "Acme", label: "Hello", action: noop };
}

function contribution(id: string, extra: Partial<Contribution> = {}): Contribution {
	return { id, owner: id.slice(0, id.indexOf(".")), contract: CONTRACT_VERSION, ...extra };
}

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function pluginsFile(dir: string, order: readonly string[]): string {
	const path = join(dir, "plugins.json");
	writeFileSync(path, `${JSON.stringify({ schema: PLUGINS_SCHEMA, order })}\n`);
	return path;
}

/** A rail the sidebar read point refuses for its key (`todo` is read-only). */
function reservedSidebarContribution(): Contribution {
	return contribution("acme.nav", { sidebar: { key: "todo", bottom: true, rail: { render: () => ["section"] } } });
}

/** The minimal terminal the sidebar seam needs to record its refusals. */
function fakeTui(): TUI {
	return { terminal: {} } as unknown as TUI;
}

test("a missing plugins.json means no explicit order", (t) => {
	const dir = scratch(t);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: dir }), {
		order: [],
		source: "default",
		malformed: false,
		reason: "missing",
		globalFile: join(dir, "plugins.json"),
	});
});

test("a valid plugins.json supplies the owner order", (t) => {
	const dir = scratch(t);
	const path = pluginsFile(dir, ["beta", "acme"]);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: dir }), {
		order: ["beta", "acme"],
		source: "global_file",
		malformed: false,
		reason: "none",
		globalFile: path,
	});
});

test("a malformed or unreadable plugins.json reads as no explicit order and is never rewritten", (t) => {
	const dir = scratch(t);
	const path = join(dir, "plugins.json");
	const malformed: Array<[string, string]> = [
		["", "not-json"],
		["{", "not-json"],
		["[]", "wrong-shape"],
		["null", "wrong-shape"],
		[`{"schema":"${PLUGINS_SCHEMA}"}`, "wrong-shape"],
		[`{"schema":"other/v1","order":["acme"]}`, "wrong-schema"],
		[`{"schema":"${PLUGINS_SCHEMA}","order":"acme"}`, "wrong-shape"],
		[`{"schema":"${PLUGINS_SCHEMA}","order":["acme",7]}`, "wrong-shape"],
		[`{"schema":"${PLUGINS_SCHEMA}","order":["acme",""]}`, "wrong-shape"],
		[`{"schema":"${PLUGINS_SCHEMA}","order":["acme"],"extra":1}`, "wrong-shape"],
	];
	for (const [raw, reason] of malformed) {
		writeFileSync(path, raw);
		assert.deepEqual(
			readPluginOrder({ gentlePiConfigHome: dir }),
			{ order: [], source: "global_file", malformed: true, reason, globalFile: path },
			raw,
		);
		assert.equal(readFileSync(path, "utf8"), raw, "the malformed file is preserved");
	}
	// Unreadable: the path is a directory, so reading it fails with EISDIR.
	const unreadable = scratch(t);
	mkdirSync(join(unreadable, "plugins.json"));
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: unreadable }), {
		order: [],
		source: "global_file",
		malformed: true,
		reason: "unreadable",
		globalFile: join(unreadable, "plugins.json"),
	});
});

/** The audit text for a box with nothing in it, so only the order-file line can differ. */
function orderFileLines(dir: string): string[] {
	return formatPluginAudit(
		buildPluginAudit({
			contributions: [],
			report: { skipped: [], replaced: [] },
			order: readPluginOrder({ gentlePiConfigHome: dir }),
		}),
	);
}

test("a missing plugins.json is silent over an empty box and named once a contribution loads", (t) => {
	const dir = scratch(t);
	const path = join(dir, "plugins.json");

	// The optional file was never created and nothing contributes: there is no
	// ordering question, so the audit adds nothing.
	assert.deepEqual(orderFileLines(dir), [
		"Gentle plugins: 0 loaded, 0 skipped",
		"No community contributions are registered.",
	]);

	// A plugin author with a contribution expects an order: name the file that
	// is not there. A rejection of a file somebody wrote always prints.
	reset();
	t.after(reset);
	contributionSlot().set("acme.hello", contribution("acme.hello", { rows: [row()] }));
	const order = readPluginOrder({ gentlePiConfigHome: dir });
	const lines = formatPluginAudit(
		buildPluginAudit({ contributions: readContributions({ order: order.order }), report: readContributionReport(), order }),
	);
	assert.equal(lines[0], "Gentle plugins: 1 loaded, 0 skipped");
	assert.equal(lines[1], `order file: ${path} (missing; insertion order is used and the file is left untouched)`);
});

test("the audit names the order file it looked for and the condition that rejected it", (t) => {
	const dir = scratch(t);
	const path = join(dir, "plugins.json");
	const rejected = (condition: string) =>
		`order file: ${path} (${condition}; insertion order is used and the file is left untouched)`;

	writeFileSync(path, "{");
	assert.equal(orderFileLines(dir)[1], rejected("not JSON"));

	writeFileSync(path, `{"schema":"other/v1","order":["acme"]}`);
	assert.equal(orderFileLines(dir)[1], rejected(`schema is not ${PLUGINS_SCHEMA}`));

	writeFileSync(path, `{"schema":"${PLUGINS_SCHEMA}","order":["acme",7]}`);
	assert.equal(orderFileLines(dir)[1], rejected("wrong shape"));

	// Unreadable: the path is a directory.
	const unreadable = scratch(t);
	const unreadablePath = join(unreadable, "plugins.json");
	mkdirSync(unreadablePath);
	assert.equal(
		orderFileLines(unreadable)[1],
		`order file: ${unreadablePath} (unreadable; insertion order is used and the file is left untouched)`,
	);
});

test("a valid plugins.json adds no line to the audit text", (t) => {
	const dir = scratch(t);
	pluginsFile(dir, ["acme"]);
	const lines = orderFileLines(dir);
	assert.deepEqual(lines, ["Gentle plugins: 0 loaded, 0 skipped", "No community contributions are registered."]);
	assert.ok(!lines.some((line) => line.startsWith("order file:")), `a good file is silent: ${lines.join(" | ")}`);
});


test("the audit model reports loaded slots, rejected ids, duplicated ids and the effective owner order", (t) => {
	const dir = scratch(t);
	pluginsFile(dir, ["beta", "acme"]);
	const order = readPluginOrder({ gentlePiConfigHome: dir });

	reset();
	const slot = contributionSlot();
	const hello = contribution("acme.hello", { rows: [row()], palette: { command: "acme:hello", group: "Acme" } });
	slot.set("acme.hello", hello);
	slot.set("acme.hello", hello);
	slot.set("beta.v2", { id: "beta.v2", owner: "beta", contract: 2 });
	slot.set("gamma.panel", contribution("gamma.panel", { sidebar: { key: "gamma", bottom: true, rail: {} as PluginRail } }));

	const audit = buildPluginAudit({
		contributions: readContributions({ order: order.order }),
		report: readContributionReport(),
		order,
		replacedSetters: ["setHeader"],
	});

	assert.deepEqual(audit.loaded, [
		{ id: "acme.hello", owner: "acme", contract: CONTRACT_VERSION, slots: ["rows", "palette"] },
		{ id: "gamma.panel", owner: "gamma", contract: CONTRACT_VERSION, slots: ["sidebar"] },
	]);
	assert.deepEqual(audit.skipped.map((issue) => [issue.id, issue.code]), [["beta.v2", "incompatible-contract"]]);
	assert.match(audit.skipped[0].detail, /contract 2 is not 1/);
	assert.deepEqual(audit.replacedIds, ["acme.hello"]);
	assert.deepEqual(audit.owners, [
		{ owner: "acme", source: "plugins.json" },
		{ owner: "gamma", source: "insertion" },
	]);
	assert.deepEqual(audit.replacedSetters, ["setHeader"]);
	assert.deepEqual(audit.order, order);
});

test("the formatter is plain bounded text that says how many rows it omitted", (t) => {
	const dir = scratch(t);
	pluginsFile(dir, ["gamma"]);
	const order = readPluginOrder({ gentlePiConfigHome: dir });

	reset();
	const slot = contributionSlot();
	for (const id of ["alpha.a", "beta.b", "gamma.c"]) slot.set(id, contribution(id, { rows: [row()] }));
	for (const id of ["bad.one", "bad.two", "bad.three"]) slot.set(id, { id, owner: id.slice(0, id.indexOf(".")), contract: 2 });

	const audit = buildPluginAudit({
		contributions: readContributions({ order: order.order }),
		report: readContributionReport(),
		order,
	});
	const lines = formatPluginAudit(audit, { limit: 2 });
	const text = lines.join("\n");

	assert.equal(lines[0], "Gentle plugins: 3 loaded, 3 skipped");
	assert.match(text, /^loaded \(3\):$/m);
	assert.match(text, /^skipped \(3\):$/m);
	assert.match(text, /^order: gamma \(plugins\.json\), alpha \(insertion\), beta \(insertion\)$/m);
	assert.match(text, /^ {2}… and 1 more loaded$/m);
	assert.match(text, /^ {2}… and 1 more skipped$/m);
	assert.doesNotMatch(text, /\u001b\[/, "no colors in the audit text");
	assert.ok(lines.length <= 10, `bounded: ${lines.length} lines`);
});

test("an empty audit says so plainly and names nothing", (t) => {
	const dir = scratch(t);
	const audit = buildPluginAudit({
		contributions: [],
		report: { skipped: [], replaced: [] },
		order: readPluginOrder({ gentlePiConfigHome: dir }),
	});
	assert.deepEqual(formatPluginAudit(audit), [
		"Gentle plugins: 0 loaded, 0 skipped",
		"No community contributions are registered.",
	]);
});

test("a refused sidebar section is reported by its read point, not silently loaded", (t) => {
	const dir = scratch(t);
	reset();
	contributionSlot().set("acme.nav", reservedSidebarContribution());
	installContributedSidebar(fakeTui());

	const order = readPluginOrder({ gentlePiConfigHome: dir });
	const audit = buildPluginAudit({
		contributions: readContributions({ order: order.order }),
		report: readContributionReport(),
		sidebar: readSidebarContributionReport(),
		order,
	});
	const text = formatPluginAudit(audit).join("\n");

	// The contract loaded it; the sidebar seam refused only its section.
	assert.match(text, /acme\.nav · contract 1 · sidebar/);
	assert.match(text, /acme\.nav · sidebar:malformed-sidebar · sidebar key "todo" is read-only for plugins/);
});

test("a repeated sidebar refusal is listed once and the same box always prints the same lines", (t) => {
	const dir = scratch(t);
	reset();
	contributionSlot().set("acme.nav", reservedSidebarContribution());
	const tui = fakeTui();
	for (let read = 0; read < 3; read++) installContributedSidebar(tui);
	const order = readPluginOrder({ gentlePiConfigHome: dir });
	const build = () =>
		formatPluginAudit(
			buildPluginAudit({
				contributions: readContributions({ order: order.order }),
				report: readContributionReport(),
				sidebar: readSidebarContributionReport(),
				order,
			}),
		);

	const first = build();
	assert.equal(first.filter((line) => line.includes("sidebar:malformed-sidebar")).length, 1);
	assert.deepEqual(build(), first, "the same box produces the same lines on every run");

	// The same refusal reported by both read points, twice, still lists once.
	const issue = { id: "acme.nav", code: "malformed-sidebar" as const, detail: 'sidebar key "todo" is read-only for plugins' };
	const deduped = buildPluginAudit({
		contributions: readContributions({ order: order.order }),
		report: { skipped: [issue], replaced: [] },
		sidebar: { skipped: [{ ...issue }, { ...issue }], replaced: [] },
		order,
	});
	assert.equal(deduped.skipped.filter((entry) => entry.id === "acme.nav").length, 1);
	assert.deepEqual(deduped.skipped[0], { ...issue, source: "contract" });
});

test("without sidebar refusals the audit text is byte-identical to today's output", (t) => {
	const dir = scratch(t);
	reset();
	const slot = contributionSlot();
	const hello = contribution("acme.hello", { rows: [row()], palette: { command: "acme:hello", group: "Acme" } });
	slot.set("acme.hello", hello);
	slot.set("acme.hello", hello);
	slot.set("beta.v2", { id: "beta.v2", owner: "beta", contract: 2 });
	// A valid order file naming no contribution of this box: it is accepted, so
	// it adds nothing to the text this slice already printed.
	pluginsFile(dir, ["ghost"]);
	// A fresh sidebar read of this box: it carries no sidebar payload, so that
	// seam reports nothing and the audit text is the one this slice always printed.
	installContributedSidebar(fakeTui());
	const order = readPluginOrder({ gentlePiConfigHome: dir });
	const audit = buildPluginAudit({
		contributions: readContributions({ order: order.order }),
		report: readContributionReport(),
		sidebar: readSidebarContributionReport(),
		order,
	});

	assert.deepEqual(formatPluginAudit(audit), [
		"Gentle plugins: 1 loaded, 1 skipped, 1 replaced",
		"order: acme (insertion)",
		"loaded (1):",
		"  acme.hello · contract 1 · rows, palette",
		"skipped (1):",
		"  beta.v2 · incompatible-contract · contract 2 is not 1",
		"replaced ids: acme.hello",
	]);
});

test("a ctx.ui setter whose identity changed is named, an unchanged one is not", () => {
	const ui = {
		setHeader: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setEditorComponent: () => {},
		setStatus: () => {},
	};
	const snapshot = captureUiSetters(ui);
	assert.deepEqual(replacedUiSetters(snapshot, ui), []);
	ui.setHeader = () => {};
	ui.setStatus = () => {};
	assert.deepEqual(replacedUiSetters(snapshot, ui), ["setHeader", "setStatus"]);
});

type Component = { render(width: number): string[]; handleInput?(data: string): void };
type Registration = { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> };

function fakePi() {
	const commands = new Map<string, Registration>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		registerCommand: (name: string, registration: Registration) => commands.set(name, registration),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: ExtensionContext) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { pi, commands, fire };
}

function fakeContext(options: { hasUI?: boolean; mode?: "tui" | "print" } = {}) {
	const notices: string[] = [];
	const overlays: unknown[] = [];
	const renders: Array<boolean | undefined> = [];
	let component: Component | undefined;
	let closed = 0;
	const ui = {
		setHeader: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setEditorComponent: () => {},
		setStatus: () => {},
		notify: (message: string) => notices.push(message),
		custom: (
			factory: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Component,
			given: unknown,
		) => {
			overlays.push(given);
			const tui = { terminal: { rows: 20 }, requestRender: (force?: boolean) => renders.push(force) };
			const theme = { fg: (_role: string, text: string) => text };
			component = factory(tui, theme, {}, () => { closed++; });
			return Promise.resolve(null);
		},
	};
	const ctx = { hasUI: options.hasUI ?? true, mode: options.mode ?? "tui", ui } as unknown as ExtensionContext;
	return { ctx, ui, notices, overlays, renders, component: () => component, closed: () => closed };
}

test("/gentle:plugins notifies the audit text without a UI and names a swapped ctx.ui setter", async (t) => {
	const dir = scratch(t);
	reset();
	contributionSlot().set("acme.hello", contribution("acme.hello", { rows: [row()] }));

	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	assert.equal(PLUGINS_COMMAND_NAME, "gentle:plugins");
	assert.match(commands.get(PLUGINS_COMMAND_NAME)!.description, /plugin/i);

	const context = fakeContext({ hasUI: false, mode: "print" });
	await fire("session_start", context.ctx);
	context.ui.setHeader = () => {};
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);

	const text = context.notices.at(-1) ?? "";
	assert.match(text, /acme\.hello · contract 1 · rows/);
	assert.match(text, /ctx\.ui\.setHeader: replaced by another extension/);
});

test("/gentle:plugins opens a scrollable overlay over the same audit text", async (t) => {
	const dir = scratch(t);
	reset();
	contributionSlot().set("acme.hello", contribution("acme.hello", { rows: [row()] }));

	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	const context = fakeContext();
	await fire("session_start", context.ctx);
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);

	assert.deepEqual(context.overlays[0], {
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
	});
	const view = context.component()!;
	const first = view.render(80);
	assert.match(first.join("\n"), /Gentle plugins: 1 loaded, 0 skipped/);
	assert.ok(first.length <= 20, `never taller than the terminal: ${first.length}`);
	assert.doesNotMatch(view.render(80).join("\n"), /replaced by another extension/);

	view.handleInput?.("j");
	view.handleInput?.("\u001b[6~");
	assert.ok(view.render(80).length <= 20);
	view.handleInput?.("q");
	assert.equal(context.closed(), 1);
});

test("/gentle:plugins lists a sidebar refusal once, naming its read point", async (t) => {
	const dir = scratch(t);
	reset();
	contributionSlot().set("acme.nav", reservedSidebarContribution());
	const tui = fakeTui();
	installContributedSidebar(tui);
	installContributedSidebar(tui);

	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	const context = fakeContext({ hasUI: false, mode: "print" });
	await fire("session_start", context.ctx);
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);

	const text = context.notices.at(-1) ?? "";
	assert.match(text, /acme\.nav · sidebar:malformed-sidebar · sidebar key "todo" is read-only for plugins/);
	assert.equal(text.split("\n").filter((line) => line.includes("sidebar:malformed-sidebar")).length, 1);
});

test("/gentle:plugins says the box is empty instead of failing", async (t) => {
	const dir = scratch(t);
	reset();
	// Empty box, empty sidebar read: nothing for either seam to report.
	installContributedSidebar(fakeTui());
	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	const context = fakeContext({ hasUI: false, mode: "print" });
	await fire("session_start", context.ctx);
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);
	assert.match(context.notices.at(-1) ?? "", /No community contributions are registered\./);
});

test("/gentle:plugins names a rejected plugins.json and the condition that failed", async (t) => {
	const dir = scratch(t);
	reset();
	const path = join(dir, "plugins.json");
	writeFileSync(path, `{"schema":"${PLUGINS_SCHEMA}","order":"acme"}`);

	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	const context = fakeContext({ hasUI: false, mode: "print" });
	await fire("session_start", context.ctx);
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);

	const text = context.notices.at(-1) ?? "";
	assert.match(text, /^Gentle plugins: 0 loaded, 0 skipped$/m);
	assert.equal(
		text.split("\n").find((line) => line.startsWith("order file:")),
		`order file: ${path} (wrong shape; insertion order is used and the file is left untouched)`,
	);
});
