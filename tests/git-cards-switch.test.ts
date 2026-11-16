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
	/** When set, the git runner itself throws instead of returning a code. */
	let hardFailure = false;
	const historyHolds = new Map<string, Promise<void>>();
	let releaseHistory: (() => void) | undefined;
	const holdHistory = (root: string) => historyHolds.set(root, new Promise<void>(resolve => { releaseHistory = resolve; }));
	// Holds exactly the NEXT status call for one root: a recovery retry can hang
	// in flight while a replacement reader's scan completes normally.
	let statusHoldRoot: string | undefined;
	let heldStatus: Promise<void> | undefined;
	let releaseHeldStatus: (() => void) | undefined;
	const holdNextStatus = (root: string) => {
		statusHoldRoot = root;
		heldStatus = new Promise<void>(resolve => { releaseHeldStatus = resolve; });
	};
	let publishes = 0;
	const hold = (root: string) => { holds.set(root, new Promise<void>(resolve => releases.set(root, resolve))); };
	const release = (root: string) => { const resolve = releases.get(root); holds.delete(root); releases.delete(root); resolve?.(); };
	const git = (root: string): GitRunner => async args => {
		calls.push({ root, args });
		if (hardFailure) throw new Error("git runner crashed");
		if (args[0] === "status" && root === statusHoldRoot) {
			statusHoldRoot = undefined;
			await heldStatus;
		}
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
	return { cards, calls, hold, release, render, settle, extra, failures, holdHistory, releaseHistory: () => releaseHistory?.(), publishes: () => publishes, setHardFailure: (v: boolean) => { hardFailure = v; }, holdNextStatus, releaseHeldStatus: () => releaseHeldStatus?.(), statusCalls: (root: string) => calls.filter(c => c.root === root && c.args[0] === "status").length };
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
	// A failed initial status read recovers on the next refresh: refreshDiff
	// restarts a tracker whose start() failed instead of pinning the gap
	// (CodeRabbit finding — the old contract pinned "Counts unavailable").
	assert.match(f.render().join("\n"), /\+\d/);
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

test("a repaint failure during a diff load never marks the status unread", async () => {
	const events: string[] = [];
	let repaints = 0;
	let failing = false;
	const cards = new SidebarGitCards({
		git: () => async args => ({ code: 0, stdout: args[0] === "status" ? " M a.ts\0" : args[0] === "rev-parse" ? "main\n" : args[0] === "log" ? "* \x1eabc\x1f\x1ffeat: x\x1e\n" : "" }),
		untrackedLines: () => async () => 0,
		fileRevision: () => async () => undefined,
		publish: () => {
			repaints++;
			if (failing) throw new Error("repaint failure");
			events.push("publish");
		},
	}, { history: false, diff: true });
	cards.enter("/repo");
	// A repaint failure during settle, not during the load: enter()'s first
	// publish already ran, so arm the failure before refreshDiff() (CodeRabbit
	// finding — the armed flag must exercise the path the test claims).
	failing = true;
	await cards.refreshDiff();
	// The load succeeded; a repaint failure during settle must not mark the
	// status unread (the CodeRabbit finding): the catch guards only start().
	assert.equal(cards.statusRead, true, "a successful start() keeps statusRead true even if a repaint threw");
	assert.ok(cards.model, "the model is kept");
	assert.ok(repaints > 0, "the throwing repaint callback ran");
});

test("card.start never rejects: a repaint failure during the success path stays contained", async () => {
	const events: string[] = [];
	let failNextPublish = false;
	const cards = new SidebarGitCards({
		git: () => async args => ({ code: 0, stdout: args[0] === "status" ? " M a.ts\0" : args[0] === "rev-parse" ? "main\n" : "" }),
		untrackedLines: () => async () => 0,
		fileRevision: () => async () => undefined,
		publish: () => { if (failNextPublish) { failNextPublish = false; throw new Error("repaint failure"); } events.push("publish"); },
	}, { history: false, diff: true });
	cards.enter("/repo");
	// The first publish runs inside loadDiff's success path: a repaint failure
	// there must not reject card.start, which enter() fire-and-forgets.
	failNextPublish = true;
	const unhandled: unknown[] = [];
	const catcher = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", catcher);
	try {
		await cards.refreshDiff();
		await new Promise(resolve => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", catcher);
	}
	assert.equal(cards.statusRead, true, "the successful load keeps its status");
	assert.deepEqual(unhandled, [], "no rejection escapes card.start");
});

test("an initial runner rejection contains a throwing error-path repaint and can recover", async () => {
	let broken = true;
	let throwPaint = false;
	let throwingPaints = 0;
	const cards = new SidebarGitCards({
		git: () => async args => {
			if (broken) throw new Error("runner failed");
			return { code: 0, stdout: args[0] === "status" ? " M recovered.ts\0" : "" };
		},
		untrackedLines: () => async () => 0,
		fileRevision: () => undefined,
		publish: () => { if (throwPaint) { throwingPaints++; throw new Error("error-path repaint failed"); } },
	}, { history: false, diff: true });
	cards.enter(MAIN);
	throwPaint = true;
	await assert.doesNotReject(cards.refreshDiff());
	assert.ok(throwingPaints > 0, "the failed load actually attempted a throwing repaint");
	assert.equal(cards.statusRead, false);
	assert.equal(cards.paintedRoot, MAIN);
	assert.match(cards.changesRows(theme, 80, 4).join("\n"), /Counts unavailable/);
	broken = false;
	throwPaint = false;
	await cards.refreshDiff();
	assert.equal(cards.statusRead, true);
	assert.match(cards.changesRows(theme, 80, 4).join("\n"), /recovered\.ts/);
	cards.dispose();
});

test("changes frames cache without color work and invalidate every render input", async () => {
	const f = fixture();
	f.cards.enter(MAIN);
	await f.settle();
	let colors = 0;
	let bolds = 0;
	const counted = { fg: (_role: string, text: string) => { colors++; return text; }, bold: (text: string) => { bolds++; return text; } };
	const draw = (width = 80, viewport = 4, offset = 0, collapsed = false, hovered = false, paint = counted) => f.cards.changesRows(paint, width, viewport, offset, collapsed, hovered);
	const hit = (render: () => string[]) => {
		const first = render();
		const before = [colors, bolds];
		assert.strictEqual(render(), first, "a hit reuses the single frame");
		assert.deepEqual([colors, bolds], before, "a hit performs no theme work");
		return first;
	};
	const original = hit(() => draw());
	for (const render of [() => draw(60), () => draw(60, 3), () => draw(60, 3, 1), () => draw(60, 3, 1, true), () => draw(60, 3, 1, true, true), () => draw(60, 3, 1, true, true, { ...counted })]) {
		const before = colors;
		render();
		assert.ok(colors > before, "each changed key repaints");
	}
	assert.notStrictEqual(draw(), original, "only the most recent frame is retained");
	f.extra.add(MAIN);
	await f.cards.refreshDiff();
	assert.match(hit(() => draw()).join("\n"), /created\.ts/, "digest invalidates the frame");
	const main = draw();
	f.cards.select(WT);
	await f.settle();
	const wt = hit(() => draw());
	assert.notStrictEqual(wt, main, "roots do not share frames");
	assert.match(wt.join("\n"), /wt\.ts/);
	assert.doesNotMatch(wt.join("\n"), /main\.ts|created\.ts/);
	f.hold(MAIN);
	f.cards.select(MAIN);
	assert.strictEqual(draw(), main, "each root retains its own single frame");
	f.release(MAIN);
	await f.settle();
	f.cards.dispose();
});

test("changes cache follows placeholder settlement even without a model", async () => {
	let fail: (() => void) | undefined;
	const gate = new Promise<void>((_resolve, reject) => { fail = () => reject(new Error("runner failed")); });
	const cards = new SidebarGitCards({
		git: () => async () => { await gate; return { code: 0, stdout: "" }; },
		untrackedLines: () => async () => 0,
		fileRevision: () => undefined,
		publish: () => {},
	}, { history: false, diff: true });
	cards.enter(MAIN);
	const loading = cards.changesRows(theme, 80, 4);
	assert.match(loading.join("\n"), /Loading changes…/);
	assert.strictEqual(cards.changesRows(theme, 80, 4), loading);
	fail!();
	await cards.refreshDiff();
	const failed = cards.changesRows(theme, 80, 4);
	assert.equal(cards.model, undefined);
	assert.equal(cards.statusRead, false);
	assert.notStrictEqual(failed, loading, "settlement invalidates unchanged digest and status");
	assert.match(failed.join("\n"), /Counts unavailable/);
	assert.strictEqual(cards.changesRows(theme, 80, 4), failed);
	cards.leave();
	cards.enter(MAIN);
	assert.strictEqual(cards.changesRows(theme, 80, 4), failed, "a painted root stays settled during reload");
	await cards.refreshDiff();
	cards.dispose();
});

test("changes cache invalidates status independently of an unchanged empty digest", async () => {
	let unavailable = true;
	const cards = new SidebarGitCards({
		git: () => async () => ({ code: unavailable ? 128 : 0, stdout: "" }),
		untrackedLines: () => async () => 0,
		fileRevision: () => undefined,
		publish: () => {},
	}, { history: false, diff: true });
	cards.enter(MAIN);
	await cards.refreshDiff();
	const digest = cards.model?.digest;
	const failed = cards.changesRows(theme, 80, 4);
	assert.match(failed.join("\n"), /Counts unavailable/);
	unavailable = false;
	await cards.refreshDiff();
	assert.equal(cards.model?.digest, digest);
	assert.equal(cards.statusRead, true);
	const empty = cards.changesRows(theme, 80, 4);
	assert.notStrictEqual(empty, failed);
	assert.match(empty.join("\n"), /No changes\./);
	assert.strictEqual(cards.changesRows(theme, 80, 4), empty);
	cards.dispose();
});

test("digest-less changes models stay uncached and preserve sanitized exact-width rows", async () => {
	const f = fixture();
	f.cards.enter(MAIN);
	await f.settle();
	const model = f.cards.model!;
	const cached = f.cards.changesRows(theme, 40, 4);
	delete model.digest;
	model.files[0].path = "dir/unsafe\x1b[31m\n\tname.ts";
	model.files[0].added = 7;
	model.added = 7;
	const rows = f.cards.changesRows(theme, 40, 4);
	assert.notStrictEqual(rows, cached);
	assert.notStrictEqual(f.cards.changesRows(theme, 40, 4), rows, "no digest means no frame reuse");
	assert.match(rows[1], /\+7 -1 · partial counts/);
	assert.match(rows[2], /unsafe  name\.ts/);
	assert.doesNotMatch(rows[2], /\x1b|\n|\t/);
	assert.ok(rows[2].endsWith("+7 -1 [diff]"));
	for (const row of rows) assert.equal(visibleWidth(row), 40);
	model.files[0].path = "renamed.ts";
	assert.match(f.cards.changesRows(theme, 40, 4).join("\n"), /renamed\.ts/);
	f.cards.dispose();
});

test("a recovery retry whose start() rejects never rejects card.start", async () => {
	const f = fixture();
	f.failures.add(WT);
	f.cards.enter(WT);
	await f.settle();
	assert.equal(f.cards.statusRead, false);
	// The recovery retry itself fails hard (the runner throws instead of
	// returning a code): card.start must stay settled, never escape.
	f.setHardFailure(true);
	const unhandled: unknown[] = [];
	const catcher = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", catcher);
	try {
		await f.cards.refreshDiff().catch(() => unhandled.push("refreshDiff rejected"));
		await new Promise(resolve => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", catcher);
	}
	assert.deepEqual(unhandled, [], "no rejection escapes the retry chain");
	assert.equal(f.cards.statusRead, false, "the failed recovery leaves the status unread for the next retry");
});

test("loadDiff replaces a stale retry guard: the new reader retries its own tracker", async () => {
	const f = fixture();
	// First reader fails its initial status scan...
	f.failures.add(WT);
	f.cards.enter(WT);
	await f.settle();
	assert.equal(f.cards.statusRead, false, "precondition: the first read failed");
	// ...and its recovery retry hangs in flight (the retry guard is set).
	f.holdNextStatus(WT);
	const staleRetry = f.cards.refreshDiff();
	await new Promise(resolve => setImmediate(resolve));
	// The user switches away and back: loadDiff replaces the tracker. The stale
	// guard must not survive the replacement (CodeRabbit finding).
	f.cards.leave();
	f.cards.enter(WT);
	await f.settle();
	assert.equal(f.cards.statusRead, false, "the replacement reader's first scan also failed (Git still down)");
	// The next refresh must retry the NEW tracker, not await the stale guard:
	// raced so a regression fails fast instead of hanging the suite.
	const before = f.statusCalls(WT);
	const raced = await Promise.race([
		f.cards.refreshDiff().then(() => "retried" as const),
		new Promise<"stale"[]>(resolve => setTimeout(() => resolve(["stale"]), 100)),
	]);
	assert.notDeepEqual(raced, ["stale"], "refreshDiff must not await the stale retry guard");
	assert.ok(f.statusCalls(WT) > before, "the replacement reader started its own retry");
	assert.equal(f.cards.statusRead, false, "its retry also failed (Git is still down), leaving the status unread");
	// The stale reader unwinds harmlessly and Git recovers on its own turn.
	f.releaseHeldStatus();
	f.failures.delete(WT);
	await staleRetry.catch(() => { /* the abandoned tracker was stopped. */ });
	await f.cards.refreshDiff();
	await f.settle();
	assert.equal(f.cards.statusRead, true, "once Git recovers the replacement recovers on its own turn");
});
