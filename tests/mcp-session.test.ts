import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpSession } from "../lib/mcp-session.ts";

const GLOBAL = "/home/marcos/.pi/mcp.json";
const PROJECT = "/work/.pi/mcp.json";

test("joins configured servers with tool counts", () => {
	const entries = buildMcpSession({
		globalPath: GLOBAL,
		projectPath: PROJECT,
		globalRaw: `{"mcpServers": {"codegraph": {"command": "x"}, "stitch": {"url": "https://x", "enabled": false}}}`,
		projectRaw: undefined,
		tools: [{ name: "mcp__codegraph__search", description: "Search code" }],
		registered: [],
	});
	assert.deepEqual(entries, [
		{
			name: "codegraph",
			enabled: true,
			scope: "global",
			hasOverride: false,
			source: GLOBAL,
			toolCount: 1,
			status: "connected",
			tools: [{ name: "search", description: "Search code" }],
		},
		{
			name: "stitch",
			enabled: false,
			scope: "global",
			hasOverride: false,
			source: GLOBAL,
			toolCount: 0,
			status: "disabled",
			tools: [],
		},
	]);
});

test("project overrides flip enabled and tools use short names", () => {
	const entries = buildMcpSession({
		globalPath: GLOBAL,
		projectPath: PROJECT,
		globalRaw: `{"mcpServers": {"stitch": {"url": "https://x"}}}`,
		projectRaw: `{"mcpServers": {"stitch": {"enabled": false}}}`,
		tools: [{ name: "mcp__stitch__generate", description: "Generate UI" }],
		registered: [],
	});
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.enabled, false);
	assert.equal(entries[0]?.hasOverride, true);
	assert.equal(entries[0]?.status, "disabled");
	assert.deepEqual(entries[0]?.tools, [{ name: "generate", description: "Generate UI" }]);
});

test("extension servers without config join as extension scope", () => {
	const entries = buildMcpSession({
		globalPath: GLOBAL,
		projectPath: PROJECT,
		globalRaw: undefined,
		projectRaw: undefined,
		tools: [{ name: "mcp__jira__list", description: "List issues" }],
		registered: ["jira"],
	});
	assert.deepEqual(entries, [
		{
			name: "jira",
			enabled: true,
			scope: "extension",
			hasOverride: false,
			source: "extension",
			toolCount: 1,
			status: "connected",
			tools: [{ name: "list", description: "List issues" }],
		},
	]);
});

test("malformed files degrade to empty instead of throwing", () => {
	const entries = buildMcpSession({
		globalPath: GLOBAL,
		projectPath: PROJECT,
		globalRaw: "{oops",
		projectRaw: undefined,
		tools: [],
		registered: [],
	});
	assert.deepEqual(entries, []);
});
