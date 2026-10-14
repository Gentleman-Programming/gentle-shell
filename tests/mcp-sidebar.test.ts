import assert from "node:assert/strict";
import test from "node:test";
import { buildExtensionDetailActions, buildMcpDetailActions, buildMcpSidebarEntries, mergeMcpServers, normalizeMcpRow, parseMcpServers, patchMcpServersFile, renderMcpCard } from "../lib/mcp-sidebar.ts";

// Pure MCP sidebar model: configured servers joined with live tool names.
// Rendering is pure so it can be verified without a TUI.

test("connected servers report their tool count", () => {
	assert.deepEqual(
		buildMcpSidebarEntries(
			[{ name: "codegraph", enabled: true }],
			["mcp__codegraph__search"],
		),
		[{ name: "codegraph", enabled: true, toolCount: 1, status: "connected" }],
	);
});

test("disabled servers stay disabled even with tools present", () => {
	assert.deepEqual(
		buildMcpSidebarEntries(
			[{ name: "stitch", enabled: false }],
			["mcp__stitch__generate"],
		),
		[{ name: "stitch", enabled: false, toolCount: 1, status: "disabled" }],
	);
});

test("enabled servers with no tools report connecting", () => {
	assert.deepEqual(
		buildMcpSidebarEntries([{ name: "engram", enabled: true }], []),
		[{ name: "engram", enabled: true, toolCount: 0, status: "connecting" }],
	);
});

test("dashes in server names match underscore namespaces", () => {
	assert.deepEqual(
		buildMcpSidebarEntries(
			[{ name: "home-assistant", enabled: true }],
			["mcp__home_assistant__get_state"],
		),
		[{ name: "home-assistant", enabled: true, toolCount: 1, status: "connected" }],
	);
});

test("unrelated tools are ignored", () => {
	assert.deepEqual(
		buildMcpSidebarEntries([{ name: "codegraph", enabled: true }], ["read", "mcp__other__tool"]),
		[{ name: "codegraph", enabled: true, toolCount: 0, status: "connecting" }],
	);
});

const plainTheme = {
	fg(_color: string, value: string) {
		return value;
	},
	bold(value: string) {
		return value;
	},
};

test("expanded card lists every server with its status", () => {
	const lines = renderMcpCard(
		[
			{ name: "codegraph", enabled: true, toolCount: 1, status: "connected" },
			{ name: "stitch", enabled: false, toolCount: 0, status: "disabled" },
		],
		{ collapsed: false },
		plainTheme,
		50,
	).join("\n");
	assert.match(lines, /MCP/);
	assert.match(lines, /codegraph/);
	assert.match(lines, /Connected/);
	assert.match(lines, /stitch/);
	assert.match(lines, /Disabled/);
});

test("collapsed card shows a summary instead of the list", () => {
	const lines = renderMcpCard(
		[
			{ name: "codegraph", enabled: true, toolCount: 1, status: "connected" },
			{ name: "stitch", enabled: false, toolCount: 0, status: "disabled" },
		],
		{ collapsed: true },
		plainTheme,
		50,
	).join("\n");
	assert.match(lines, /MCP/);
	assert.doesNotMatch(lines, /codegraph/);
	assert.match(lines, /1 connected/);
});

test("empty entries render no card", () => {
	assert.deepEqual(renderMcpCard([], { collapsed: false }, plainTheme, 50), []);
});

test("project overrides only change enabled by default", () => {
	assert.deepEqual(
		mergeMcpServers(
			{ stitch: { enabled: true }, engram: {} },
			{ stitch: { enabled: false } },
		),
		[
			{ name: "engram", enabled: true, scope: "global", hasOverride: false },
			{ name: "stitch", enabled: false, scope: "global", hasOverride: true },
		],
	);
});

test("standalone project servers keep their scope", () => {
	assert.deepEqual(
		mergeMcpServers({}, { local: { command: "npx", args: ["x"] } }),
		[{ name: "local", enabled: true, scope: "project", hasOverride: false }],
	);
});

test("disabling writes enabled:false keeping other keys", () => {
	const raw = `{
  "mcpServers": {
    "stitch": {
      "url": "https://stitch.googleapis.com/mcp"
    }
  }
}`;
	const next = JSON.parse(patchMcpServersFile(raw, "stitch", { enabled: false }, {}));
	assert.equal(next.mcpServers.stitch.enabled, false);
	assert.equal(next.mcpServers.stitch.url, "https://stitch.googleapis.com/mcp");
});

test("enabling removes the default key", () => {
	const raw = `{"mcpServers": {"stitch": {"url": "https://x", "enabled": false}}}`;
	const next = JSON.parse(patchMcpServersFile(raw, "stitch", { enabled: true }, {}));
	assert.ok(!("enabled" in next.mcpServers.stitch));
});

test("project disable creates an override entry from scratch", () => {
	const next = JSON.parse(patchMcpServersFile(undefined, "stitch", { enabled: false }, { asOverride: true }));
	assert.deepEqual(next.mcpServers.stitch, { enabled: false });
});

test("keepEnabled preserves an explicit true override", () => {
	const next = JSON.parse(
		patchMcpServersFile(`{"mcpServers": {"stitch": {"url": "https://x", "enabled": false}}}`, "stitch", { enabled: true }, { asOverride: true, keepEnabled: true }),
	);
	assert.equal(next.mcpServers.stitch.enabled, true);
});

test("malformed config parses to empty", () => {
	assert.deepEqual(parseMcpServers("{oops"), {});
	assert.deepEqual(parseMcpServers(undefined), {});
});

test("row normalization strips frames, margins and markers", () => {
	assert.equal(normalizeMcpRow("  │ • stitch — Disabled · 0 tools │  "), "• stitch — Disabled · 0 tools");
	assert.equal(normalizeMcpRow("│ ▸ ← Back │"), "← Back");
	assert.equal(normalizeMcpRow("  ▎ code — x  "), "code — x");
	assert.equal(normalizeMcpRow("plain"), "plain");
});

test("enabled global server offers disable plus project disable when trusted", () => {
	assert.deepEqual(
		buildMcpDetailActions(
			{ name: "stitch", enabled: true, scope: "global", hasOverride: false },
			{ projectTrusted: true },
		).map((action) => action.id),
		["disable", "disable-project"],
	);
});

test("enabled global server offers only disable when untrusted", () => {
	assert.deepEqual(
		buildMcpDetailActions(
			{ name: "stitch", enabled: true, scope: "global", hasOverride: false },
			{ projectTrusted: false },
		).map((action) => action.id),
		["disable"],
	);
});

test("override-disabled server offers enable in project", () => {
	assert.deepEqual(
		buildMcpDetailActions(
			{ name: "stitch", enabled: false, scope: "global", hasOverride: true },
			{ projectTrusted: true },
		).map((action) => action.id),
		["enable-project"],
	);
});

test("extension servers carry no file actions", () => {
	assert.deepEqual(buildExtensionDetailActions(), []);
});
