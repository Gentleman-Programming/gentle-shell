import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import type { Contribution, PluginRow } from "../lib/plugin-contract.ts";
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

test("a missing plugins.json means no explicit order", (t) => {
	const dir = scratch(t);
	assert.deepEqual(readPluginOrder({ gentlePiConfigHome: dir }), {
		order: [],
		source: "default",
		malformed: false,
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
		globalFile: path,
	});
});

test("a malformed or unreadable plugins.json reads as no explicit order and is never rewritten", (t) => {
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
		`{"schema":"${PLUGINS_SCHEMA}","order":["acme",""]}`,
		`{"schema":"${PLUGINS_SCHEMA}","order":["acme"],"extra":1}`,
	];
	for (const raw of malformed) {
		writeFileSync(path, raw);
		assert.deepEqual(
			readPluginOrder({ gentlePiConfigHome: dir }),
			{ order: [], source: "global_file", malformed: true, globalFile: path },
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
		globalFile: join(unreadable, "plugins.json"),
	});
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
	slot.set("gamma.panel", contribution("gamma.panel", { sidebar: { key: "gamma", bottom: true, rail: {} } }));

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

test("/gentle:plugins says the box is empty instead of failing", async (t) => {
	const dir = scratch(t);
	reset();
	const { pi, commands, fire } = fakePi();
	installGentlePlugins(pi, { env: { GENTLE_PI_CONFIG_HOME: dir } });
	const context = fakeContext({ hasUI: false, mode: "print" });
	await fire("session_start", context.ctx);
	await commands.get(PLUGINS_COMMAND_NAME)!.handler("", context.ctx);
	assert.match(context.notices.at(-1) ?? "", /No community contributions are registered\./);
});
