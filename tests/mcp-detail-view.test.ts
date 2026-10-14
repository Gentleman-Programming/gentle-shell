import assert from "node:assert/strict";
import test from "node:test";
import { McpDetailView, type McpDetailInfo, type McpDetailResult } from "../lib/mcp-detail-view.ts";
import { buildMcpDetailActions } from "../lib/mcp-sidebar.ts";

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

function makeInfo(enabled: boolean): McpDetailInfo {
	return {
		name: "stitch",
		statusLabel: enabled ? "Connected" : "Disabled",
		toolCount: 15,
		scopeLabel: "global",
		source: "/home/marcos/.pi/mcp.json",
		enabled,
		tools: [
			{ name: "generate", description: "Generate UI from text" },
			{ name: "exposure", description: "Read the exposure" },
		],
	};
}

const info = makeInfo(true);
const actions = buildMcpDetailActions(
	{ name: "stitch", enabled: true, scope: "global", hasOverride: false, toolCount: 15 },
	{ projectTrusted: true },
);

function open(inputs: string[], enabled = true): { view: McpDetailView; results: McpDetailResult[] } {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(makeInfo(enabled), actions, (result) => results.push(result), plainTheme);
	for (const input of inputs) view.handleInput(input);
	return { view, results };
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

test("server screen shows the menu, not the tool list", () => {
	const view = new McpDetailView(info, actions, () => {}, plainTheme);
	const text = view.render(60).join("\n");
	assert.match(text, /stitch/);
	assert.match(text, /Connected/);
	assert.match(text, /Tools — 15 tools/);
	assert.match(text, /Disable —/);
	assert.match(text, /Disable in this project/);
	assert.doesNotMatch(text, /Generate UI from text/);
});

test("enter on Tools opens the tools screen", () => {
	const { view, results } = open([ENTER]);
	const text = view.render(60).join("\n");
	assert.match(text, /Tools of stitch/);
	assert.match(text, /generate — Generate UI from text/);
	assert.deepEqual(results, []);
});

test("disabled servers get an enable-first notice instead of tools", () => {
	const { view, results } = open([ENTER], false);
	const text = view.render(60).join("\n");
	assert.match(text, /disabled — enable it first/);
	assert.doesNotMatch(text, /Generate UI from text/);
	assert.deepEqual(results, []);
});

test("tool drill and escape chain back to the server screen, then close", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	view.handleInput(ENTER);
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	assert.match(view.render(60).join("\n"), /Read the exposure/);
	view.handleInput(ESCAPE);
	assert.match(view.render(60).join("\n"), /Tools of stitch/);
	view.handleInput(ESCAPE);
	assert.match(view.render(60).join("\n"), /Disable —/);
	view.handleInput(ESCAPE);
	assert.deepEqual(results, [{ type: "close" }]);
});

test("keyboard reaches Disable past Tools", () => {
	const { results } = open([DOWN, ENTER]);
	assert.deepEqual(results, [{ type: "run", action: "disable" }]);
});

test("clicking Tools navigates, clicking a tool drills, Back returns", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	mouseClick(view, "Tools —");
	assert.match(view.render(60).join("\n"), /Tools of stitch/);
	mouseClick(view, "exposure —");
	assert.match(view.render(60).join("\n"), /Read the exposure/);
	assert.deepEqual(results, []);
	mouseClick(view, "← Back");
	assert.match(view.render(60).join("\n"), /Tools of stitch/);
	mouseClick(view, "← Back");
	assert.match(view.render(60).join("\n"), /Disable —/);
	assert.deepEqual(results, []);
});

test("clicking Disable runs it", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	mouseClick(view, "Disable —");
	assert.deepEqual(results, [{ type: "run", action: "disable" }]);
});

test("clicking empty space runs nothing", () => {	const results: McpDetailResult[] = [];
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

test("hovering never reflows the panel", () => {
	const longInfo: McpDetailInfo = {
		...info,
		tools: [{ name: "query_docs", description: "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework, even well-known ones." }],
	};
	const widths = [40, 60, 80];
	for (const width of widths) {
		const view = new McpDetailView(longInfo, actions, () => {}, plainTheme);
		const serverCounts = new Set<number>();
		for (const input of [DOWN, DOWN, DOWN, DOWN, UP, UP]) {
			view.handleInput(input);
			serverCounts.add(view.render(width).length);
		}
		assert.equal(serverCounts.size, 1, `server screen stable at width ${width}`);
		view.handleInput(ENTER);
		const toolsCounts = new Set<number>();
		for (const input of [DOWN, DOWN, UP]) {
			view.handleInput(input);
			toolsCounts.add(view.render(width).length);
		}
		assert.equal(toolsCounts.size, 1, `tools screen stable at width ${width}`);
	}
});

test("long tool rows truncate instead of wrapping", () => {
	const view = new McpDetailView(
		{
			...info,
			tools: [{ name: "query_docs", description: "Retrieves and queries up-to-date documentation and code examples from Context7." }],
		},
		actions,
		() => {},
		plainTheme,
	);
	view.handleInput(ENTER);
	const text = view.render(40).join("\n");
	assert.match(text, /query_docs — .*…/);
});

test("clicking the esc-back hint goes back", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	view.handleInput(ENTER);
	assert.match(view.render(60).join("\n"), /Tools of stitch/);
	mouseClick(view, "esc back");
	assert.match(view.render(60).join("\n"), /Disable —/);
	assert.deepEqual(results, []);
});

test("clicking the esc-close hint closes", () => {
	const results: McpDetailResult[] = [];
	const view = new McpDetailView(info, actions, (result) => results.push(result), plainTheme);
	mouseClick(view, "esc close");
	assert.deepEqual(results, [{ type: "close" }]);
});
