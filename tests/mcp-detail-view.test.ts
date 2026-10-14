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
	tools: [
		{ name: "generate", description: "Generate UI from text" },
		{ name: "exposure", description: "Read the exposure" },
	],
};

const actions: McpDetailAction[] = [
	{ id: "disable", label: "Disable", hint: "saved to the global mcp.json" },
	{ id: "disable-project", label: "Disable in this project", hint: "saved to the project mcp.json" },
];

function collect(info: McpDetailInfo, inputs: string[]): McpDetailResult[] {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	for (const input of inputs) view.handleInput(input);
	return results;
}

function mouseClick(view: McpDetailView, label: string): void {
	const width = 60;
	const lines = view.render(width);
	const y = lines.findIndex((line) => line.includes(label));
	assert.ok(y >= 0, `row "${label}" renders`);
	view.handleMouse({
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

test("detail shows status, tools and actions", () => {
	const view = new McpDetailView(info, actions, () => {}, plainTheme);
	const text = view.render(60).join("\n");
	assert.match(text, /stitch/);
	assert.match(text, /Connected/);
	assert.match(text, /15 tools/);
	assert.match(text, /generate/);
	assert.match(text, /Generate UI from text/);
	assert.match(text, /Disable/);
	assert.match(text, /Disable in this project/);
});

test("enter on the first row opens the tool, escape goes back", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	view.handleInput(ENTER);
	assert.match(view.render(60).join("\n"), /Generate UI from text/);
	assert.deepEqual(results, []);
	view.handleInput(ESCAPE);
	assert.match(view.render(60).join("\n"), /Disable/);
	assert.deepEqual(results, []);
});

test("keyboard reaches actions past the tools", () => {
	assert.deepEqual(collect(info, [DOWN, DOWN, ENTER]), [{ type: "run", action: "disable" }]);
});

test("third row runs the second action", () => {
	assert.deepEqual(collect(info, [DOWN, DOWN, DOWN, ENTER]), [{ type: "run", action: "disable-project" }]);
});

test("up at the top stays on the first tool", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	view.handleInput(UP);
	view.handleInput(ENTER);
	assert.match(view.render(60).join("\n"), /Generate UI from text/);
	assert.deepEqual(results, []);
});

test("escape on the server screen closes without running", () => {
	assert.deepEqual(collect(info, [ESCAPE]), [{ type: "close" }]);
});

test("clicking an action runs it", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	mouseClick(view, "Disable in this project");
	assert.deepEqual(results, [{ type: "run", action: "disable-project" }]);
});

test("clicking a tool drills in, clicking back returns", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	mouseClick(view, "exposure");
	assert.match(view.render(60).join("\n"), /Read the exposure/);
	assert.deepEqual(results, []);
	mouseClick(view, "Back");
	assert.match(view.render(60).join("\n"), /Disable/);
	assert.deepEqual(results, []);
});

test("clicking empty space runs nothing", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	const lines = view.render(60);
	view.handleMouse({
		type: "click",
		button: "left",
		x: 2,
		y: lines.length,
		screenX: 2,
		screenY: lines.length,
		width: 60,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.deepEqual(results, []);
});
