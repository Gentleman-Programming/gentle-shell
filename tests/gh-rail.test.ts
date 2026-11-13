import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GITHUB_COMMAND, GithubRail } from "../lib/gh-rail.ts";
import { GH_TTL_MS, type GhSnapshot } from "../lib/gh-state.ts";
import { renderPanelSheet } from "../lib/shell-panel.ts";
import type { GithubRepo, IssueSummary, PullRequestSummary } from "../lib/gh-client.ts";

// The rail section is the only part of the GitHub pane visible without opening
// anything, so it has to survive a narrow rail, an empty repository, and a
// failed refresh without ever painting a row wider than the rail.

const REPO: GithubRepo = { host: "github.com", owner: "Gentleman-Programming", name: "gentle-shell" };

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

const taggedTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function pull(number: number, title = `pull ${number}`): PullRequestSummary {
	return { number, title, author: "someone", isDraft: false, headRefName: `feat/${number}`, updatedAt: "2026-11-10T09:00:00Z", labels: [], commentCount: 0, reviewDecision: null };
}

function issue(number: number, title = `issue ${number}`): IssueSummary {
	return { number, title, author: "someone", labels: [], commentCount: 0, updatedAt: "2026-11-10T09:00:00Z" };
}

function snapshot(over: Partial<GhSnapshot> = {}): GhSnapshot {
	return { repo: REPO, pullRequests: [], issues: [], status: "ready", error: null, loadedAt: 1_000_000, version: 1, ...over };
}

function railOf(snapshotValue: GhSnapshot | (() => GhSnapshot), over: { open?: () => void } = {}) {
	const current = typeof snapshotValue === "function" ? snapshotValue : () => snapshotValue;
	return new GithubRail({ theme: plainTheme, snapshot: current, now: () => 1_000_000, ...over });
}

test("the header carries both counts and the section opens with its command", () => {
	const rail = railOf(snapshot({ pullRequests: [pull(1), pull(2), pull(3)], issues: [issue(10)] }));
	const lines = rail.render(50);
	assert.match(lines[0]!, /GITHUB/);
	assert.match(lines[0]!, /3 · 1/);
	assert.equal(lines[lines.length - 1]!.trim(), GITHUB_COMMAND);
	assert.ok(lines[0]!.indexOf("GITHUB") < lines[1]!.indexOf("#1"), "header precedes its rows");
});

test("the two most recent items are what the section shows", () => {
	const rail = railOf(snapshot({ pullRequests: [pull(2841, "docs: donations"), pull(2839)], issues: [issue(2801, "[Bug]: invite")] }));
	const text = rail.render(50).join("\n");
	assert.match(text, /#2841/);
	assert.match(text, /docs: donations/);
	assert.match(text, /#2801/);
	assert.doesNotMatch(text, /#2839/, "the list is a digest, not a copy of the overlay");
});

test("nothing open says so instead of painting an empty section", () => {
	assert.match(railOf(snapshot()).render(50).join("\n"), /none open/);
});

test("while loading the section says loading rather than claiming the repository is empty", () => {
	const rail = railOf(snapshot({ status: "loading", loadedAt: null }));
	const text = rail.render(50).join("\n");
	assert.match(text, /loading/);
	assert.doesNotMatch(text, /none open/);
});

test("a failed refresh keeps the counts and adds the reason", () => {
	const rail = railOf(snapshot({ pullRequests: [pull(1)], status: "error", error: "gh: not authenticated" }));
	const text = rail.render(50).join("\n");
	assert.match(text, /1 · 0/, "a stale count beats no count");
	assert.match(text, /#1/);
	assert.match(text, /not authenticated/);
});

test("a failure with no rows to keep still explains itself", () => {
	const rail = railOf(snapshot({ status: "error", error: "gh: not installed" }));
	assert.match(rail.render(50).join("\n"), /not installed/);
});

test("no row ever exceeds the rail width, however narrow", () => {
	const long = railOf(
		snapshot({
			pullRequests: [pull(2841, "a title long enough that it cannot possibly fit in a narrow rail without being clipped")],
			issues: [issue(2801, "another title that is far too long for the rail to paint in one row")],
			status: "error",
			error: "gh: a very long failure message that would overflow a narrow rail",
		}),
	);
	for (const width of [20, 26, 34, 50]) {
		for (const line of long.render(width)) {
			assert.ok(visibleWidth(line) <= width, `row ${JSON.stringify(line)} is wider than ${width} columns`);
		}
	}
});

test("the summary is the mobile work row's one-liner", () => {
	const rail = railOf(snapshot({ pullRequests: [pull(1), pull(2)], issues: [issue(10), issue(11), issue(12)] }));
	const summary = rail.summary();
	assert.ok(summary);
	assert.equal(summary.right, "2·3");
	assert.match(summary.left, /github/i);
});

test("the digest tracks the store version and its age, so the rail cannot serve a stale frame", () => {
	let current = snapshot({ version: 1 });
	const rail = railOf(() => current);
	assert.notEqual(rail.digest(), "");
	const before = rail.digest();
	current = snapshot({ version: 2 });
	assert.notEqual(rail.digest(), before, "new data must re-render the section");
	assert.match(rail.digest(), new RegExp(`2:0`));
});

test("the section opens the overlay when it is asked to", () => {
	let opened = 0;
	const rail = railOf(snapshot(), {
		open: () => {
			opened += 1;
		},
	});
	rail.open?.();
	assert.equal(opened, 1);
});

test("the section is one of the panels /gentle:panel shows", () => {
	const rail = railOf(snapshot({ pullRequests: [pull(2841, "docs: donations")], issues: [issue(2801)] }));
	const sheet = renderPanelSheet(new Map([["github", rail]]), taggedTheme, 60, { rows: 12, scrollTop: 0 });
	const text = sheet.lines.join("\n");
	assert.match(text, /GITHUB/, "the github section must be listed in the sheet order");
	assert.match(text, /#2841/);
});

test("the sheet omits the section when nothing is registered under its key", () => {
	const sheet = renderPanelSheet(new Map(), taggedTheme, 60, { rows: 6, scrollTop: 0 });
	assert.doesNotMatch(sheet.lines.join("\n"), /GITHUB/);
});

test("the TTL the rail ages against is the store's own", () => {
	assert.equal(GH_TTL_MS, 60_000);
});
