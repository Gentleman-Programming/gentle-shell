import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellBarModel, createFooterStatusMemo, type ShellFooterData } from "../extensions/gentle-shell.ts";
import { CHANGE_STATUS } from "../lib/shell-changes.ts";
import type { RunningJobDisplay } from "../lib/jobs-sidebar-state.ts";
import type { ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import type { ProviderUsage } from "../lib/shell-usage.ts";
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

function footerMemoFixture() {
	let reads = 0;
	let projections = 0;
	let leaf = "leaf-1";
	const entries = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
	// One stable model object, replaced only by setModelId: real hosts keep the
	// model identity stable, and sessionStatsKey compares it by identity.
	let model: { id: string; contextWindow: number } = { id: "model", contextWindow: 1000 };
	const ctx = {
		get model() { return model; },
		getContextUsage() { projections++; return { percent: 10, contextWindow: 1000 }; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries() { reads++; return [...entries]; },
			getEntryCount: () => entries.length,
			getSessionId: () => "session-1",
			getLeafId: () => leaf,
			getCwd: () => "/repo",
			getSessionName: () => "session",
		},
	};
	let branch: string | null = "main";
	let statuses = new Map<string, string>();
	let usage: ProviderUsage | undefined;
	let added = 0;
	let deleted = 0;
	let unbornRoots = 0;
	let review: ReviewSidebarSnapshot | undefined;
	let jobs: RunningJobDisplay[] | undefined;
	let settings: unknown = { statusPlacement: "auto" };
	let style: unknown = "comfortable";
	const footerData = { getGitBranch: () => branch, getExtensionStatuses: () => statuses } as unknown as ShellFooterData;
	let profile: string | undefined = "team";
	const memo = createFooterStatusMemo({
		pi, ctx: ctx as unknown as ExtensionContext, footerData,
		usage: () => usage,
		profile: () => profile,
		jobs: () => jobs,
		review: () => review,
		tracker: () => ({ model: { files: [{ path: "a.ts", status: CHANGE_STATUS.MODIFIED, added, deleted }], added, deleted }, unbornRoots: Array.from({ length: unbornRoots }, () => "root") }),
		visualSettings: () => settings,
		cardStyle: () => style,
	});
	return {
		ctx: ctx as unknown as ExtensionContext & { sessionManager: { getLeafId?: () => string } },
		memo,
		counts: () => [reads, projections],
		setLeaf: (value: string) => { leaf = value; },
		spend: () => { entries[0]!.message.usage.cost.total += 1; },
		setModelId: (value: string) => { model = { ...model, id: value }; },
		setProfile: (value: string | undefined) => { profile = value; },
		setBranch: (value: string | null) => { branch = value; },
		setStatuses: (value: Map<string, string>) => { statuses = value; },
		setUsage: (value: ProviderUsage | undefined) => { usage = value; },
		setChangeCounts: (nextAdded: number, nextDeleted: number) => { added = nextAdded; deleted = nextDeleted; },
		setUnbornRoots: (value: number) => { unbornRoots = value; },
		setReview: (value: ReviewSidebarSnapshot | undefined) => { review = value; },
		setJobs: (value: RunningJobDisplay[] | undefined) => { jobs = value; },
		setSettings: (value: unknown) => { settings = value; },
		setStyle: (value: unknown) => { style = value; },
	};
}

test("the footer status memo reuses one model while live inputs hold still", () => {
	const f = footerMemoFixture();
	const first = f.memo.model();
	assert.equal(first.costTotal, 1);
	assert.deepEqual(first.changes, { files: 1, added: 0, deleted: 0 });
	for (let frame = 0; frame < 10; frame++) assert.equal(f.memo.model(), first, "stable inputs reuse the built model");
	assert.deepEqual(f.counts(), [1, 1], "warm frames never rescan the session");
});

test("the footer status digest key notices every live input the model reads", () => {
	const f = footerMemoFixture();
	const before = f.memo.key();
	assert.equal(f.memo.key(), before, "the key is deterministic while nothing moves");
	const mutations: Array<[string, () => void]> = [
		["branch", () => f.setBranch("feature")],
		["profile", () => f.setProfile("other (local)")],
		["statuses", () => f.setStatuses(new Map([["jobs", "1 running"]]))],
		["usage", () => f.setUsage({ provider: "p", plan: undefined, limits: [], fetchedAt: 1 })],
		["change counts", () => f.setChangeCounts(2, 1)],
		["unborn roots", () => f.setUnbornRoots(1)],
		["review", () => f.setReview({ state: "open", scope: undefined } as unknown as ReviewSidebarSnapshot)],
		["jobs", () => f.setJobs([{ id: "j", label: "l", startedAt: 0 }])],
		["visual settings", () => f.setSettings({ statusPlacement: "bottom" })],
		["card style", () => f.setStyle("compact")],
		["model", () => f.setModelId("new-model")],
		["cwd", () => (f.ctx.sessionManager as { getCwd(): string }).getCwd = () => "/other"],
		["session name", () => (f.ctx.sessionManager as { getSessionName(): string }).getSessionName = () => "renamed"],
		["leaf", () => f.setLeaf("leaf-2")],
	];
	let previous = before;
	for (const [name, mutate] of mutations) {
		mutate();
		const current = f.memo.key();
		assert.notEqual(current, previous, `a moved ${name} changes the digest key`);
		previous = current;
	}
	// A branch or profile move rebuilds the model without rescanning statistics:
	// the model object identity stays stable across those rebuilds.
	const settled = f.memo.model();
	const [reads, projections] = f.counts();
	f.setBranch("release");
	assert.notEqual(f.memo.model(), settled);
	assert.deepEqual(f.counts(), [reads, projections]);
});

test("a moved leaf rebuilds the footer model with fresh statistics", () => {
	const f = footerMemoFixture();
	const first = f.memo.model();
	f.setLeaf("leaf-2");
	const second = f.memo.model();
	assert.notEqual(second, first);
	assert.deepEqual(f.counts(), [2, 2]);
	assert.equal(f.memo.model(), second, "the fresh model is memoized again");
});

test("hosts without leaf identity stay honest through the digest key's values", () => {
	const f = footerMemoFixture();
	assert.equal(f.memo.key(), f.memo.key(), "the key stays deterministic on uncached hosts");
	Reflect.deleteProperty(f.ctx.sessionManager, "getLeafId");
	const first = f.memo.model();
	f.spend();
	const second = f.memo.model();
	assert.notEqual(second, first, "a changed cost value rebuilds the model without leaf identity");
	assert.equal(second.costTotal, 2);
});
