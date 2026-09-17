import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const AGENTS_DIR = join(ROOT, "assets", "agents");
const NON_FILESYSTEM_AGENTS = new Set(["sdd-research.md"]);
const DENY_ALL_RULE = '"*": false';

// Vendored contract from pi-subagents v0.35.0, which fixed block-list
// frontmatter parsing in nicobailon/pi-subagents#507. Keep this local so the
// package test detects an incompatible agent declaration without adding a
// runtime dependency on pi-subagents.
function parseFrontmatterList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
}

// Vendored from the same pi-subagents release. Direct MCP declarations are
// partitioned after list parsing instead of remaining in the ordinary tool
// allowlist.
function splitToolList(rawTools: string[] | undefined): {
	tools?: string[];
	mcpDirectTools?: string[];
} {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

function readRawToolsBlock(path: string): string {
	const source = readFileSync(path, "utf8");
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(frontmatter, `${path} must have YAML frontmatter`);

	const lines = frontmatter[1].split("\n");
	const toolsIndex = lines.findIndex((line) => line === "tools:");
	assert.notEqual(toolsIndex, -1, `${path} must declare a tools block`);

	const blockLines: string[] = [];
	for (const line of lines.slice(toolsIndex + 1)) {
		if (!line.startsWith("  - ")) break;
		blockLines.push(line.slice(2));
	}
	assert.ok(blockLines.length > 0, `${path} must declare at least one tool`);
	return blockLines.join("\n");
}

function expectedBlockEntries(rawTools: string): string[] {
	return rawTools.split("\n").map((line) => line.replace(/^-\s+/, "").trim());
}

test("packaged agent tool blocks match the pi-subagents parsing contract", () => {
	const agentFiles = readdirSync(AGENTS_DIR)
		.filter((entry) => entry.endsWith(".md"))
		.sort();
	assert.ok(agentFiles.length > 0, "gentle-pi must ship packaged agents");

	let denyAllAgents = 0;
	for (const fileName of agentFiles) {
		const path = join(AGENTS_DIR, fileName);
		const rawTools = readRawToolsBlock(path);
		const expectedEntries = expectedBlockEntries(rawTools);
		const parsedEntries = parseFrontmatterList(rawTools);

		assert.deepEqual(
			parsedEntries,
			expectedEntries,
			`${fileName} tools must not collapse into newline-containing tokens`,
		);
		for (const entry of parsedEntries ?? []) {
			assert.doesNotMatch(entry, /\n/, `${fileName} tool ${JSON.stringify(entry)} must be one clean token`);
		}

		const parsedTools = splitToolList(parsedEntries).tools ?? [];
		if (NON_FILESYSTEM_AGENTS.has(fileName)) {
			assert.ok(!parsedTools.includes("read"), `${fileName} must remain explicitly web-only`);
		} else {
			assert.ok(parsedTools.includes("read"), `${fileName} must retain its filesystem read tool`);
		}

		if (expectedEntries[0] === DENY_ALL_RULE) {
			denyAllAgents += 1;
			assert.ok(
				parsedTools.slice(1).includes("read"),
				`${fileName} deny-all marker must not swallow the following tool allowlist`,
			);
		}

		const blockWithMcp = `${rawTools}\n- mcp:contract.search`;
		const scalarWithMcp = [...expectedEntries, "mcp:contract.search"].join(", ");
		assert.deepEqual(
			splitToolList(parseFrontmatterList(blockWithMcp)),
			splitToolList(parseFrontmatterList(scalarWithMcp)),
			`${fileName} block and comma forms must produce the same tool partition`,
		);
	}

	assert.ok(denyAllAgents > 0, "the contract must exercise packaged deny-all tool maps");
});
