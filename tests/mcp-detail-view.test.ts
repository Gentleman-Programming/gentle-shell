import assert from "node:assert/strict";
import test from "node:test";
import { McpDetailView, type McpDetailInfo, type McpDetailResult } from "../lib/mcp-detail-view.ts";
import type { McpDetailAction } from "../lib/mcp-sidebar.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

const plainTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
};

const info: McpDetailInfo = {
	name: "stitch",
	statusLabel: "Connected",
	toolCount: 15,
	scopeLabel: "global",
	source: "/home/marcos/.pi/mcp.json",
	tools: ["generate", "exposure"],
};

const actions: McpDetailAction[] = [
	{ id: "disable", label: "Disable", hint: "saved to the global mcp.json" },
	{ id: "open-manager", label: "Open /mcp manager", hint: "live status" },
];

function collect(info: McpDetailInfo, inputs: string[]): McpDetailResult[] {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	for (const input of inputs) view.handleInput(input);
	return results;
}

test("detail shows status, tools and actions", () => {
	const view = new McpDetailView(info, actions, () => {}, plainTheme);
	const text = view.render(60).join("\n");
	assert.match(text, /stitch/);
	assert.match(text, /Connected/);
	assert.match(text, /15 tools/);
	assert.match(text, /generate/);
	assert.match(text, /Disable/);
	assert.match(text, /Open \/mcp manager/);
});

test("enter runs the highlighted action", () => {
	assert.deepEqual(collect(info, [ENTER]), [{ type: "run", action: "disable" }]);
});

test("down then enter runs the second action", () => {
	assert.deepEqual(collect(info, [DOWN, ENTER]), [{ type: "run", action: "open-manager" }]);
});

test("up at the top stays on the first action", () => {
	assert.deepEqual(collect(info, [UP, ENTER]), [{ type: "run", action: "disable" }]);
});

test("escape closes without running", () => {
	assert.deepEqual(collect(info, [ESCAPE]), [{ type: "close" }]);
});
