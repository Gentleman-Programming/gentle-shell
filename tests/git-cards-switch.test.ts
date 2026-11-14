import assert from "node:assert/strict";
import test from "node:test";
import { SidebarGitCards } from "../lib/git-cards.ts";
import type { GitRunner } from "../lib/shell-changes.ts";

// The GIT cards must paint the last good frame while a root switch is still
// loading, exactly like SidebarTree.setRoot: a switch never flashes a loading
// or error frame over the content the user was reading.

// Identity colors keep every row measurable: the assertions read the text the
// rail actually paints, not its role markup.
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const MAIN = "/main", WT = "/wt";

function fixture() {
	const holds = new Map<string, Promise<void>>();
	const releases = new Map<string, () => void>();
	const calls: Array<{ root: string; args: string[] }> = [];
	const extra = new Set<string>();
	const failures = new Set<string>();
	const historyHolds = new Map<string, Promise<void>>();
	let releaseHistory: (() => void) | undefined;
	const holdHistory = (root: string) => historyHolds.set(root, new Promise<void>(resolve => { releaseHistory = resolve; }));
	let publishes = 0;
	const hold = (root: string) => { holds.set(root, new Promise<void>(resolve => releases.set(root, resolve))); };
	const release = (root: string) => { const resolve = releases.get(root); holds.delete(root); releases.delete(root); resolve?.(); };
	const git = (root: string): GitRunner => async args => {
		calls.push({ root, args });
		const gate = holds.get(root);
		if (gate) await gate;
		if (args[0] === "symbolic-ref") await historyHolds.get(root);
		if (failures.has(root)) return { code: 128, stdout: "" };
		const name = root === MAIN ? "main" : "wt";
		if (args[0] === "symbolic-ref") return { code: 0, stdout: `${name}\n` };
		if (args[0] === "rev-parse") return { code: 0, stdout: "abc\n" };
		if (args[0] === "-c") return { code: 0, stdout: `* \x1eabc\x1f\x1f${name} history\x1e\n` };
		if (args[0] === "status") return { code: 0, stdout: ` M ${name}.ts\0${extra.has(root) ? "?? created.ts\0" : ""}` };
		if (args[0] === "diff") return { code: 0, stdout: `3\t1\t${name}.ts\n` };
		return { code: 0, stdout: "" };
	};
	const cards = new SidebarGitCards({
		git,
		untrackedLines: () => async () => 0,
		fileRevision: () => undefined,
		publish: () => { publishes++; },
	}, { history: true, diff: true });
	const render = () => [...cards.historyRows(theme, 80, 4), ...cards.changesRows(theme, 80, 4)];
	const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
	return { cards, calls, hold, release, render, settle, extra, failures, holdHistory, releaseHistory: () => releaseHistory?.(), publishes: () => publishes };
}

test("initial pending is not an error or a reusable settled snapshot", async () => {
	const f = fixture();
	f.hold(WT);
	f.cards.enter(WT);
	assert.doesNotMatch(f.render().join("\n"), /unavailable/);
	assert.match(f.render().join("\n"), /Loading/);
	f.cards.select(MAIN);
	await f.settle();
	const main = f.render();
	f.cards.select(WT);
	assert.deepEqual(f.render(), main, "an initial placeholder is not a last-good cached frame");
	f.release(WT);
	await f.settle();
	assert.match(f.render().join("\n"), /wt history/);
});

test("an answered initial failure is visible and history refresh can recover", async () => {
	const f = fixture();
	f.failures.add(WT);
	f.cards.enter(WT);
	await f.settle();
	assert.match(f.render().join("\n"), /history unavailable/);
	assert.match(f.render().join("\n"), /Counts unavailable/);
	assert.doesNotMatch(f.render().join("\n"), /Loading/);
	f.failures.delete(WT);
	await f.cards.refreshHistory();
	await f.cards.refreshDiff();
	assert.match(f.render().join("\n"), /wt history/);
	// A failed initial status read stays unavailable until a later change adds
	// a retry scan; refresh intentionally skips a failed initial start.
	assert.match(f.render().join("\n"), /Counts unavailable/);
});

test("disabling an unanswered card settles the selected root barrier", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	f.holdHistory(MAIN);
	f.cards.select(MAIN);
	await f.settle();
	assert.equal(f.cards.paintedRoot, WT);
	f.cards.configure({ history: false, diff: true });
	assert.equal(f.cards.paintedRoot, MAIN);
	assert.match(f.cards.changesRows(theme, 80, 4).join("\n"), /main\.ts/);
	const published = f.publishes();
	f.releaseHistory();
	await f.settle();
	assert.equal(f.publishes(), published, "disabled history cannot publish a stale completion");
});

test("A to B to A and disposal discard pending completions", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	const good = f.render();
	f.hold(MAIN);
	f.cards.select(MAIN);
	await f.settle();
	f.cards.select(WT);
	await f.settle();
	const published = f.publishes();
	f.release(MAIN);
	await f.settle();
	assert.deepEqual(f.render(), good);
	assert.equal(f.publishes(), published);
	f.hold(MAIN);
	f.cards.select(MAIN);
	await f.settle();
	f.cards.dispose();
	const disposed = f.publishes();
	f.release(MAIN);
	await f.settle();
	assert.equal(f.publishes(), disposed);
});

test("a root switch keeps painting the last good cards until the new root answers", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	const lastGood = f.render();
	assert.match(lastGood.join("\n"), /wt history/);
	assert.match(lastGood.join("\n"), /wt\.ts/);
	assert.doesNotMatch(lastGood.join("\n"), /unavailable/);
	const published = f.publishes();

	f.hold(MAIN);
	f.cards.select(MAIN);
	assert.equal(f.cards.selectedRoot, MAIN);
	assert.deepEqual(f.render(), lastGood, "the intermediate frame is the last good frame");
	await f.settle();
	assert.deepEqual(f.render(), lastGood, "every frame while the new root loads is the last good frame");
	assert.doesNotMatch(f.render().join("\n"), /history unavailable|Counts unavailable/);
	assert.equal(f.publishes(), published, "a deferred switch paints no intermediate content frame");

	f.release(MAIN);
	await f.settle();
	const swapped = f.render();
	assert.notDeepEqual(swapped, lastGood);
	assert.match(swapped.join("\n"), /main history/);
	assert.match(swapped.join("\n"), /main\.ts/);
	assert.doesNotMatch(swapped.join("\n"), /wt history|wt\.ts|unavailable/);
	assert.equal(f.publishes(), published + 1, "both loads coalesce into one content-changing frame");
	assert.equal(f.cards.paintedRoot, MAIN);
});

test("switching back to a visited root paints its cached cards at once", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	f.cards.select(MAIN);
	await f.settle();
	const mainRows = f.render();
	assert.match(mainRows.join("\n"), /main history/);
	f.hold(WT);
	f.cards.select(WT);
	const painted = f.render();
	assert.match(painted.join("\n"), /wt history/, "a visited root paints its cached frame without waiting");
	assert.doesNotMatch(painted.join("\n"), /main history|unavailable/);
	f.release(WT);
	await f.settle();
});

test("repeated cached-root reversals keep last-good eligibility during a held reload", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	const cached = f.render();
	f.cards.select(MAIN);
	await f.settle();
	f.hold(WT);
	f.cards.select(WT);
	assert.deepEqual(f.render(), cached);
	await f.settle();
	f.cards.select(MAIN);
	await f.settle();
	f.cards.select(WT);
	assert.equal(f.cards.paintedRoot, WT);
	assert.deepEqual(f.render(), cached, "an interrupted reload never revokes the settled cache");
	f.release(WT);
	await f.settle();
	assert.deepEqual(f.render(), cached);
});

test("re-entering the GIT tab paints the cached cards and publishes nothing when unchanged", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	f.cards.select(MAIN);
	await f.settle();
	const mainRows = f.render();
	f.cards.leave();
	const published = f.publishes();
	f.cards.enter(MAIN);
	assert.equal(f.cards.selectedRoot, MAIN, "re-entry keeps the selected root");
	assert.deepEqual(f.render(), mainRows, "no placeholder frame on re-entry");
	await f.settle();
	assert.deepEqual(f.render(), mainRows);
	assert.equal(f.publishes(), published, "an unchanged re-entry requests no repaint");
	assert.doesNotMatch(f.render().join("\n"), /unavailable/);
});

test("steady-state refreshes publish once and keep the painted root", async () => {
	const f = fixture();
	f.cards.enter(WT);
	await f.settle();
	const rows = f.render();
	const published = f.publishes();
	await f.cards.refreshHistory();
	assert.equal(f.publishes(), published, "an unchanged history capture requests no repaint");
	assert.deepEqual(f.render(), rows);
	// A new Git status while idle still refreshes the painted card, once.
	f.extra.add(WT);
	await f.cards.refreshDiff();
	assert.equal(f.publishes(), published + 1, "a changed scan repaints exactly one frame");
	assert.match(f.render().join("\n"), /created\.ts/);
	await f.cards.refreshDiff();
	assert.equal(f.publishes(), published + 1, "a repeated identical scan repaints nothing");
	f.cards.leave();
	const callsBefore = f.calls.length;
	await f.cards.refreshHistory();
	await f.cards.refreshDiff();
	assert.equal(f.calls.length, callsBefore, "a hidden GIT tab starts no reads");
});
import { visibleWidth } from "@earendil-works/pi-tui";

test("GIT card rows fill the rail width so the tinted surface has no bare notches", async () => {
	const f = fixture();
	f.cards.enter(MAIN);
	await f.settle();
	const rows = f.render();
	assert.ok(rows.length >= 5, `both cards are populated: ${rows.join(" | ")}`);
	for (const row of rows) assert.equal(visibleWidth(row), 80, JSON.stringify(row));
	// The Changes header keeps the exact-width, glyph-first shape every card
	// header needs: no panel indent, count intact at the right edge.
	const header = rows.find(row => row.includes("▾ CHANGES"))!;
	assert.ok(header, "the changes header row is painted");
	assert.ok(!header.startsWith("  "), "the header carries no panel indent");
	assert.match(header, /\d\s*$/, "the count survives at the right edge");
});

test("Changes rows never show a zero count; the header keeps the full totals", async () => {
	// One file of each kind: an added-only (+34 / no deletions), a deleted-only
	// (-5 / no additions), a mixed (+2 -1) and an untracked file (0 0). File
	// rows must never carry a zero part; the header keeps the full totals.
	const porcelain = ["A  dir/a-only.ts", "D  dir/d-only.ts", " M dir/mixed.ts", "?? dir/new.ts"].join("\x00") + "\x00";
	const numstat = ["34\t0\tdir/a-only.ts", "0\t5\tdir/d-only.ts", "2\t1\tdir/mixed.ts"].join("\n");
	const cards = new SidebarGitCards({
		git: () => async args => ({ code: 0, stdout: args[0] === "symbolic-ref" ? "main" : args[0] === "rev-parse" ? "abc" : args[0] === "-c" ? "* \x1eabc\x1f\x1ffeat: history\x1e" : args[0] === "status" ? porcelain : args[0] === "diff" ? numstat : "" }),
		untrackedLines: () => async () => 0,
		fileRevision: () => undefined,
		publish: () => {},
	}, { history: true, diff: true });
	cards.enter(MAIN);
	for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
	const text = [...cards.historyRows(theme, 80, 2), ...cards.changesRows(theme, 80, 8)].join("\n");
	assert.doesNotMatch(text, /[-+]0\b/, "no zero part in any file row");
	for (const row of text.split("\n")) {
		if (!row.includes("[diff]") || row.includes("partial counts") || row.includes("▾")) continue;
		assert.ok(row.endsWith("[diff]"), `the diff tag sits flush on the right margin of every row: ${JSON.stringify(row)}`);
	}
	assert.match(text, /\+34 \[diff\]/, "added only shows its +");
	assert.match(text, /-5 \[diff\]/, "deleted only shows its -");
	assert.match(text, /\+2 -1 \[diff\]/, "mixed keeps both");
	assert.match(text, /new\.ts\s+\[diff\]/, "the untracked row shows no numbers");
	assert.match(text, /\+36 -6 · partial counts/, "the header keeps the full totals");
});
