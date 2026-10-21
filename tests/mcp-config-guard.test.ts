import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectMcpConfigStatus, removeBuiltinMcpExclusion } from "../lib/mcp-config-guard.ts";

test("inspectMcpConfigStatus detects when builtin:mcp is excluded in settings.json", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		const mcpPath = join(tempDir, "mcp.json");

		writeFileSync(settingsPath, JSON.stringify({ extensions: ["-builtin:mcp", "npm:some-pkg"] }, null, 2));
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { server1: { command: "test" } } }, null, 2));

		const status = inspectMcpConfigStatus(tempDir);
		assert.equal(status.isBuiltinMcpExcluded, true);
		assert.equal(status.hasConfiguredServers, true);
		assert.equal(status.serverCount, 1);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("inspectMcpConfigStatus returns false when builtin:mcp is not excluded", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		const mcpPath = join(tempDir, "mcp.json");

		writeFileSync(settingsPath, JSON.stringify({ extensions: ["-builtin:codemode", "npm:some-pkg"] }, null, 2));
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s1: {}, s2: {} } }, null, 2));

		const status = inspectMcpConfigStatus(tempDir);
		assert.equal(status.isBuiltinMcpExcluded, false);
		assert.equal(status.hasConfiguredServers, true);
		assert.equal(status.serverCount, 2);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("removeBuiltinMcpExclusion removes -builtin:mcp from settings.json", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ extensions: ["-builtin:codemode", "-builtin:mcp", "npm:pkg"] }, null, 2) + "\n",
		);

		const modified = removeBuiltinMcpExclusion(tempDir);
		assert.equal(modified, true);

		const updated = inspectMcpConfigStatus(tempDir);
		assert.equal(updated.isBuiltinMcpExcluded, false);

		// Second run is a no-op
		const modifiedAgain = removeBuiltinMcpExclusion(tempDir);
		assert.equal(modifiedAgain, false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
