import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellBarModel, type ShellFooterData } from "../extensions/gentle-shell.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

initTheme("dark");
const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
const footer = { getGitBranch: () => "main", getExtensionStatuses: () => new Map() } as unknown as ShellFooterData;

function sessionFixture() {
	let reads = 0;
	let projections = 0;
	let sessionId = "session-1";
	let leaf = "leaf-1";
	const entries = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
	const ctx = {
		model: { id: "model", contextWindow: 1000 },
		getContextUsage() { projections++; return { percent: 10, contextWindow: this.model.contextWindow }; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries() { reads++; return [...entries]; },
			getEntryCount: () => entries.length,
			getSessionId: () => sessionId,
			getLeafId: () => leaf,
			getCwd: () => "/repo",
			getSessionName: () => "session",
		},
	};
	return {
		ctx, entries,
		build: () => buildShellBarModel(pi, ctx as unknown as ExtensionContext, footer),
		counts: () => [reads, projections],
		branch: () => { leaf = "other-leaf"; },
		switchSession: () => { sessionId = "session-2"; },
	};
}

test("settled shell chrome scans stats once while presentation stays live", () => {
	const fixture = sessionFixture();
	assert.equal(fixture.build().costTotal, 1);
	for (let frame = 0; frame < 20; frame++) fixture.build();
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.ctx.sessionManager.getSessionName = () => "renamed";
	assert.equal(fixture.build().sessionName, "renamed");
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.entries.push(fixture.entries[0]!);
	assert.equal(fixture.build().costTotal, 2);
	fixture.branch(); fixture.build();
	fixture.switchSession(); fixture.build();
	fixture.ctx.model = { ...fixture.ctx.model, id: "new-model" }; fixture.build();
	fixture.ctx.model.contextWindow = 2000;
	assert.equal(fixture.build().contextWindow, 2000);
	assert.deepEqual(fixture.counts(), [6, 6]);
	const other = sessionFixture(); other.build();
	assert.deepEqual(other.counts(), [1, 1], "manager identities do not share statistics");
});

test("leaf-based stats work on read-only hosts without an entry-count method", () => {
	const fixture = sessionFixture();
	Reflect.deleteProperty(fixture.ctx.sessionManager, "getEntryCount");
	fixture.build(); fixture.build();
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.branch(); fixture.build();
	assert.deepEqual(fixture.counts(), [2, 2]);
});

function countingTheme() {
	let calls = 0;
	let prefix = "";
	return {
		theme: {
			fg: (_color: string, text: string) => { calls++; return prefix + text; },
			bg: (_color: string, text: string) => { calls++; return `\x1b[48;5;235m${text}\x1b[49m`; },
			bold: (text: string) => text,
		},
		calls: () => calls,
		change: () => { prefix += "!"; },
	};
}

for (const expanded of [false, true]) test(`settled tool cards cache complete rows (expanded=${expanded})`, () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls, change } = countingTheme();
		const renderer = createQuietToolRenderer("read");
		const context = { args: { path: "src/example.ts" }, state: {}, isPartial: false, executionStarted: true };
		const result = { content: [{ type: "text" as const, text: "first line\nsecond line" }], details: {} };
		const cards = [renderer.renderCall!(context.args, theme as never, context as never),
			renderer.renderResult!(result, { expanded, isPartial: false }, theme as never, context as never)];
		for (const card of cards) {
			const rows = card.render(80);
			const warm = calls();
			for (let frame = 0; frame < 20; frame++) assert.deepEqual(card.render(80), rows);
			assert.equal(calls(), warm, "warm frames do not rebuild decorated lines");
			assert.notDeepEqual(card.render(40), rows, "width invalidates layout");
			setCardStyle(CARD_STYLE.FLOAT);
			assert.notDeepEqual(card.render(80), rows, "style changes apply without host invalidation");
			setCardStyle(CARD_STYLE.NEON);
			card.render(80);
			change(); card.invalidate();
			assert.notDeepEqual(card.render(80), rows, "theme invalidation rebuilds colored content");
		}
	} finally { setCardStyle(previous); }
});

test("cached call chrome observes a result mark on its shared row state", () => {
	const { theme } = countingTheme();
	const renderer = createQuietToolRenderer("read");
	const context = { args: { path: "file.ts" }, state: {}, isPartial: true, executionStarted: true };
	const call = renderer.renderCall!(context.args, theme as never, context as never);
	const running = call.render(80);
	assert.ok(running.join("\n").includes("running"));
	renderer.renderResult!({ content: [], details: {} }, { expanded: false, isPartial: false }, theme as never, context as never);
	assert.ok(!call.render(80).join("\n").includes("running"), "result arrival removes the call's running/closing rows");
});

test("image renderers keep their live geometry instead of caching opaque components", () => {
	const { theme } = countingTheme();
	let renders = 0;
	const renderer = createQuietToolRenderer("read", undefined, undefined, () => ({
		render: () => [`image geometry ${++renders}`], invalidate() {},
	}));
	const card = renderer.renderResult!({ content: [{ type: "image", data: "", mimeType: "image/png" }], details: {} },
		{ expanded: true, isPartial: false }, theme as never, {} as never);
	assert.notDeepEqual(card.render(80), card.render(80));
});
