import assert from "node:assert/strict";
import test from "node:test";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { TUI } from "@earendil-works/pi-tui";
import { CONTRIBUTIONS, CONTRACT_VERSION, contributionSlot } from "../lib/plugin-contract.ts";
import type { Contribution } from "../lib/plugin-contract.ts";
import {
	installContributedSidebar,
	readSidebarContributionReport,
	SIDEBAR_SECTION_KEYS,
	sidebarPart,
	sidebarSectionOrder,
	sidebarState,
} from "../lib/shell-sidebar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";

// Canary for the sidebar read point (spec S2/S5/S9): a refactor that drops the
// plugin seam makes these three tests fail, while an empty box stays a no-op.

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function fixture(columns = 140) {
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	const host = { mode: "fullscreen", terminal: { columns }, layoutRoot: root, requestRender() {} };
	return { host, tui: host as unknown as TUI, root };
}

function contribute(key: string, name = "notes", owner = "acme"): Contribution {
	return {
		id: `${owner}.${name}`,
		owner,
		contract: CONTRACT_VERSION,
		sidebar: { key, bottom: false, rail: { render: () => [`${name} card`], invalidate() {} } },
	};
}

test("a contributed section is appended after the known keys and paints there", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	contributionSlot().set("acme.notes", contribute("plugin:acme:notes"));
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	assert.deepEqual(sidebarSectionOrder(["plugin:acme:notes"]), [...SIDEBAR_SECTION_KEYS, "plugin:acme:notes"]);
	const applied = installContributedSidebar(f.tui);
	assert.deepEqual(applied.keys, ["plugin:acme:notes"]);
	assert.deepEqual(applied.rejected, []);
	assert.ok(sidebarState(f.tui).parts.has("plugin:acme:notes"), "the contributed rail joins the shared parts map");

	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	const footer = text.indexOf("Status");
	const contributed = text.indexOf("notes card");
	assert.ok(footer >= 0 && contributed >= 0, `both sections paint: ${text}`);
	assert.ok(footer < contributed, `the contributed section paints after the known ones: ${text}`);
});

test("a contribution claiming a core key is rejected and reported, leaving the core order and part intact", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	const coreRail = { render: () => ["Todo card"], invalidate() {} };
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, coreRail);
	contributionSlot().set("acme.notes", contribute("todo"));
	contributionSlot().set("acme.other", contribute("acme:other", "other"));

	const applied = installContributedSidebar(f.tui);
	assert.deepEqual(applied.keys, []);
	assert.deepEqual(applied.rejected.map((issue) => [issue.id, issue.code]), [
		["acme.notes", "malformed-sidebar"],
		["acme.other", "malformed-sidebar"],
	]);
	assert.deepEqual(readSidebarContributionReport().skipped.map((issue) => issue.id), ["acme.notes", "acme.other"]);
	assert.equal(sidebarState(f.tui).parts.get("todo"), coreRail, "a plugin never replaces a core part");
	assert.deepEqual(sidebarSectionOrder(applied.keys), [...SIDEBAR_SECTION_KEYS]);
});

test("an empty contribution box computes exactly the known order and installs nothing", () => {
	reset();
	const f = fixture();
	const applied = installContributedSidebar(f.tui);
	assert.deepEqual(applied, { keys: [], rejected: [] });
	assert.deepEqual(sidebarSectionOrder(applied.keys), [...SIDEBAR_SECTION_KEYS]);
	assert.deepEqual([...sidebarState(f.tui).parts.keys()], []);
	assert.deepEqual(readSidebarContributionReport().skipped, []);
});
