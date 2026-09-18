import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { parseCodexUsage, UsageStore } from "../lib/shell-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";

// The subscriptions overlay: one framed panel listing every provider the
// store knows, with r to refetch and esc to close.

const NOW = 1_788_600_000_000;
const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
};

function payload(percent: number) {
	return { plan_type: "pro", rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 7200 } } };
}

test("UsageView frames the panel, keeps every line at width, and shows the empty state", () => {
	const store = new UsageStore();
	const events: string[] = [];
	const view = new UsageView(store, { theme: plainTheme, now: () => NOW, active: () => undefined, onRefresh: async () => events.push("refresh"), onClose: () => events.push("close"), requestRender: () => events.push("render") });
	const empty = view.render(90).map(stripAnsi);
	assert.match(empty[0], /^╭─ ✿ Subscriptions ─+╮$/);
	assert.match(empty[1], /No subscription usage yet/);
	assert.match(empty[empty.length - 2], /r refresh .* esc close/);
	assert.match(empty[empty.length - 1], /^╰─+╯$/);

	store.record(parseCodexUsage(payload(40), NOW));
	const lines = view.render(90);
	for (const line of lines) assert.equal(visibleWidth(line), 90, `"${stripAnsi(line)}" is not 90 wide`);
	const plain = lines.map(stripAnsi);
	assert.match(plain[1], /^│ openai-codex · pro · updated just now +│$/);
	assert.match(plain[2], /^│ {3}codex week +[▰▱]{16} +40% · resets in 2h 0m +│$/);
	assert.match(plain[3], /r refresh .* esc close/);
});

test("UsageView refetches on r and closes on escape or q", async () => {
	const store = new UsageStore();
	const events: string[] = [];
	const view = new UsageView(store, {
		theme: plainTheme,
		now: () => NOW,
		active: () => ({ provider: "openai-codex" }),
		onRefresh: async () => {
			store.record(parseCodexUsage(payload(55), NOW));
			events.push("refresh");
		},
		onClose: () => events.push("close"),
		requestRender: () => events.push("render"),
	});
	view.handleInput("r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(events, ["render", "refresh", "render"]);
	assert.match(stripAnsi(view.render(90)[2]), /55%/);
	assert.match(stripAnsi(view.render(90)[1]), /^│ ✿ openai-codex · pro · updated just now/);
	view.handleInput("\x1b");
	view.handleInput("q");
	assert.equal(events.filter((event) => event === "close").length, 2);
});
