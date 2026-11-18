import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildProfileCardItems,
	initialProfileIndex,
	nextProfileIndex,
	previousProfileIndex,
	profileCardActionAt,
	reconcileProfileIndex,
	renderProfileCardSection,
	type ProfileCardItem,
} from "../lib/profile-card-widget.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

const item = (name: string, markers: Partial<ProfileCardItem> = {}): ProfileCardItem => ({ name, active: false, pinned: false, session: false, ...markers });
const three = [item("alpha"), item("beta", { active: true }), item("gamma")];

test("buildProfileCardItems names the markers from the raw profiles file, session outranking pin", () => {
	const file = { profiles: { a: {}, "b (x)": {}, c: {}, d: {} }, active: "c" };
	assert.deepEqual(buildProfileCardItems(file), [
		item("a"), item("b (x)"), item("c", { active: true }), item("d"),
	]);
	assert.deepEqual(buildProfileCardItems(file, "b (x)", "c"), [
		item("a"), item("b (x)", { pinned: true }), item("c", { active: true, session: true }), item("d"),
	]);
	assert.deepEqual(buildProfileCardItems(file, "c", "c"), [
		item("a"), item("b (x)"), item("c", { active: true, session: true }), item("d"),
	], "a profile that is both bound and pinned shows the session marker only");
	assert.deepEqual(buildProfileCardItems({ profiles: {} }), []);
});

test("initial index prefers the session profile, then the active one, else 0", () => {
	assert.equal(initialProfileIndex([item("a", { active: true }), item("b", { session: true })]), 1);
	assert.equal(initialProfileIndex([item("a"), item("b", { active: true }), item("c", { pinned: true })]), 1);
	assert.equal(initialProfileIndex([item("a"), item("b", { pinned: true })]), 0);
	assert.equal(initialProfileIndex([]), 0);
});

test("next and previous wrap around at both ends", () => {
	assert.equal(nextProfileIndex(0, 3), 1);
	assert.equal(nextProfileIndex(2, 3), 0);
	assert.equal(previousProfileIndex(2, 3), 1);
	assert.equal(previousProfileIndex(0, 3), 2);
});

test("a single profile stays put and an empty list yields 0", () => {
	assert.equal(nextProfileIndex(0, 1), 0);
	assert.equal(previousProfileIndex(0, 1), 0);
	assert.equal(nextProfileIndex(0, 0), 0);
	assert.equal(previousProfileIndex(0, 0), 0);
});

test("reconcile keeps the selection by name, else clamps", () => {
	assert.equal(reconcileProfileIndex("gamma", 2, [item("gamma"), item("alpha")]), 0, "same name moved");
	assert.equal(reconcileProfileIndex("gamma", 2, [item("alpha"), item("beta")]), 1, "removed: clamp to last");
	assert.equal(reconcileProfileIndex("beta", 1, [item("alpha"), item("x"), item("y")]), 1, "removed: same slot");
	assert.equal(reconcileProfileIndex("beta", 1, []), 0);
	assert.equal(reconcileProfileIndex(undefined, 9, three), 2);
	assert.equal(reconcileProfileIndex(undefined, -4, three), 0);
});

test("renders header, navigation row and use action with exact text", () => {
	const { lines, hits } = renderProfileCardSection(three, 1, plainTheme, 40);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /^▾ PROFILE/);
	assert.equal(lines[1], `  ◀ beta (active)${" ".repeat(18)}2/3 ▶`);
	assert.equal(lines[2], "  ✓ Use in session".padEnd(40));
	for (const line of lines) assert.equal(visibleWidth(stripAnsi(line)), 40);
	assert.equal(hits.length, 3);
});

test("markers render in a fixed order", () => {
	const { lines } = renderProfileCardSection([item("p", { session: true, pinned: true, active: true })], 0, plainTheme, 50);
	assert.match(lines[1]!, /^ {2}◀ p \(active, pinned, session\) +1\/1 ▶$/);
});

test("every line respects the width at narrow sizes and the name truncates", () => {
	const long = [item("a-very-long-profile-name-indeed", { active: true }), item("b")];
	for (const width of [60, 30, 24, 18, 14, 12, 10, 8, 6, 4, 2, 1]) {
		const { lines, hits } = renderProfileCardSection(long, 0, plainTheme, width);
		for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, `w=${width}: ${line}`);
		for (const hit of hits) assert.ok(hit.x1 <= width && hit.x0 < hit.x1, `w=${width} hit ${JSON.stringify(hit)}`);
	}
	const mid = renderProfileCardSection(long, 0, plainTheme, 24).lines[1]!;
	assert.match(mid, /◀ .*… .*1\/2 ▶$/);
	assert.equal(visibleWidth(mid), 24);
});

test("hit spans land on the arrows and the use label", () => {
	const width = 40;
	const { lines, hits } = renderProfileCardSection(three, 1, plainTheme, width);
	const nav = lines[1]!;
	const use = lines[2]!;
	const prev = hits.find((h) => h.action === "previous")!;
	const next = hits.find((h) => h.action === "next")!;
	const useHit = hits.find((h) => h.action === "use")!;
	assert.deepEqual([prev.y, prev.x0, prev.x1], [1, nav.indexOf("◀"), nav.indexOf("◀") + 1]);
	assert.deepEqual([next.y, next.x0, next.x1], [1, nav.indexOf("▶"), nav.indexOf("▶") + 1]);
	assert.equal(useHit.y, 2);
	assert.equal(useHit.x0, use.indexOf("✓"));
	assert.equal(useHit.x1, use.indexOf("Use in session") + "Use in session".length);
	assert.equal(profileCardActionAt(hits, prev.x0, 1), "previous");
	assert.equal(profileCardActionAt(hits, next.x0, 1), "next");
	assert.equal(profileCardActionAt(hits, useHit.x0, 2), "use");
	assert.equal(profileCardActionAt(hits, useHit.x1 - 1, 2), "use");
	assert.equal(profileCardActionAt(hits, useHit.x1, 2), undefined);
	assert.equal(profileCardActionAt(hits, prev.x1, 1), undefined);
	assert.equal(profileCardActionAt(hits, next.x0 - 1, 1), undefined);
	assert.equal(profileCardActionAt(hits, 0, 0), undefined, "header is not an action");
	assert.equal(profileCardActionAt(hits, prev.x0, 5), undefined);
});

test("empty state is one hint line with no arrows, use action or hits", () => {
	const { lines, hits } = renderProfileCardSection([], 0, plainTheme, 50);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^▾ PROFILE/);
	assert.equal(lines[1], "  No profiles yet. Create one in /gentle:profiles".padEnd(50));
	assert.deepEqual(hits, []);
	assert.doesNotMatch(lines.join("\n"), /◀|▶|Use in session/);
	assert.equal(profileCardActionAt(hits, 2, 1), undefined);
	for (const width of [30, 10, 3]) for (const line of renderProfileCardSection([], 0, plainTheme, width).lines) assert.ok(visibleWidth(stripAnsi(line)) <= width);
});
