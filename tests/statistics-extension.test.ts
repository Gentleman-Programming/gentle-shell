import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import statistics, { BILLABLE_COMMAND_NAME, STATISTICS_COMMAND_DESCRIPTION, STATISTICS_COMMAND_NAME, type StatisticsSnapshot } from "../extensions/statistics.ts";
import { aggregateUsage } from "../lib/session-aggregate.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import type { StatisticsView } from "../lib/statistics-view.ts";

const scratch = mkdtempSync(join(tmpdir(), "gentle-billable-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// I8: the statistics command and overlay wiring. A distinct command, a TUI-only
// guard, a cached snapshot invalidated by events, and a palette row that is
// additive and safe.

const SNAPSHOT: StatisticsSnapshot = { aggregate: aggregateUsage([], { now: () => 0 }), timeline: null, generatedAt: 0 };

interface Harness {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
	readonly ctx: ExtensionContext;
	readonly notifications: string[];
	readonly components: StatisticsView[];
	overlays(): number;
	overlayOptions(): unknown;
	fire(event: string, payload?: unknown): Promise<void>;
	setMode(mode: string): void;
}

function harness(): Harness {
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const notifications: string[] = [];
	const components: StatisticsView[] = [];
	let overlays = 0;
	let overlayOptions: unknown;
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, registration: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, registration),
	} as unknown as ExtensionAPI;
	const session = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message: string) => notifications.push(message),
			custom: async (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => unknown, options?: unknown) => {
				overlays += 1;
				overlayOptions = options;
				const tui = { requestRender: () => {}, terminal: { rows: 40 } };
				const theme = { fg: (_role: string, text: string) => text };
				components.push(factory(tui, theme, {}, () => {}) as StatisticsView);
				return undefined;
			},
		},
		sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined, getEntries: () => [] },
	};
	return {
		pi,
		commands,
		ctx: session as unknown as ExtensionContext,
		notifications,
		components,
		overlays: () => overlays,
		overlayOptions: () => overlayOptions,
		setMode: (mode: string) => {
			session.mode = mode;
		},
		fire: async (event: string, payload: unknown = {}) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, session as unknown as ExtensionContext);
		},
	};
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("the statistics command is registered and distinct from /gentle:usage", () => {
	const h = harness();
	statistics(h.pi, { computeSnapshot: async () => SNAPSHOT });
	assert.equal(STATISTICS_COMMAND_NAME, "gentle:statistics");
	assert.notEqual(STATISTICS_COMMAND_NAME, "gentle:usage");
	const command = h.commands.get(STATISTICS_COMMAND_NAME);
	assert.ok(command, "the command is registered");
	assert.match(command!.description ?? "", /quota/, "the description names the distinct /gentle:usage surface");
	assert.equal(h.commands.has("gentle:usage"), false, "this extension never registers the quota command");
	assert.equal(STATISTICS_COMMAND_DESCRIPTION.length > 0, true);
});

test("the overlay is TUI-only", async () => {
	const h = harness();
	statistics(h.pi, { computeSnapshot: async () => SNAPSHOT });
	h.setMode("print");
	await h.commands.get(STATISTICS_COMMAND_NAME)!.handler("", h.ctx);
	assert.equal(h.overlays(), 0, "no overlay in print mode");
	assert.equal(h.notifications.some((message) => message.includes("TUI mode")), true);
});

test("the command opens the overlay with the overlay option in TUI mode", async () => {
	const h = harness();
	statistics(h.pi, { computeSnapshot: async () => SNAPSHOT });
	await h.commands.get(STATISTICS_COMMAND_NAME)!.handler("", h.ctx);
	assert.equal(h.overlays(), 1);
	assert.deepEqual(h.overlayOptions(), { overlay: true });
	await tick();
	assert.equal(h.components.length, 1);
	assert.equal(h.components[0]!.render(80).length > 0, true);
});

test("the snapshot is cached, events invalidate it, and render never recomputes", async () => {
	const h = harness();
	let computes = 0;
	statistics(h.pi, {
		computeSnapshot: async () => {
			computes += 1;
			return SNAPSHOT;
		},
	});
	const open = async () => {
		await h.commands.get(STATISTICS_COMMAND_NAME)!.handler("", h.ctx);
		await tick();
	};
	await open();
	assert.equal(computes, 1);
	// Rendering the cached model must not recompute.
	h.components[0]!.render(80);
	h.components[0]!.render(120);
	assert.equal(computes, 1, "render never recomputes an aggregate");
	// A second open reuses the cache.
	await open();
	assert.equal(computes, 1, "the cache is reused until an event invalidates it");
	// An event invalidates; the next open rebuilds once.
	await h.fire("turn_end");
	await open();
	assert.equal(computes, 2, "an event invalidates and the next open recomputes exactly once");
});

test("the billable command collects a period and exports through the renderers", async () => {
	const h = harness();
	let collected = 0;
	statistics(h.pi, {
		agentHome: scratch,
		computeSnapshot: async () => SNAPSHOT,
		billableConfig: { hourlyRate: 50, currency: "USD", rounding: { mode: "none" } },
		collectBillable: async () => {
			collected += 1;
			return [{ sessionId: "s1", project: "p", startedAt: 0, endedAt: 3_600_000, wallClockMs: 3_600_000, toolMs: 0, modelMs: 0, idleMs: 0, subagentMs: 0, costNanoUsd: 0, costProvenance: "measured" }];
		},
	});
	const command = h.commands.get(BILLABLE_COMMAND_NAME);
	assert.ok(command, "the billable command is registered");
	await command!.handler("--days 3", h.ctx);
	assert.equal(collected, 1);
	assert.equal(h.notifications.some((message) => message.includes("Billable report")), true);
});

test("the palette catalog row is additive and safe when the command is absent", () => {
	const withCommand = buildCommandPaletteGroups([{ name: "gentle:statistics", description: "live" }], {});
	const item = withCommand.flatMap((group) => group.items).find((entry) => entry.command === "gentle:statistics");
	assert.ok(item, "the row is shown when the command is registered");
	assert.equal(item!.description, "live", "the live description is attached");
	// With nothing registered the row disappears, so the additive catalog row merges safely.
	const withoutCommand = buildCommandPaletteGroups([], {});
	assert.equal(withoutCommand.flatMap((group) => group.items).some((entry) => entry.command === "gentle:statistics"), false);
});
