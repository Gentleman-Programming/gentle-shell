import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..");
const AGENTS_DIR = join(ROOT, "assets", "agents");
const NON_FILESYSTEM_AGENTS = new Set(["sdd-research.md"]);
const DENY_ALL_RULE = '"*": false';

// Vendored contract from pi-subagents v0.35.0, which fixed block-list
// frontmatter parsing in nicobailon/pi-subagents#507. Keep this local so the
// package test detects an incompatible agent declaration without adding a
// runtime dependency on pi-subagents. The second test below exercises the
// real external parser from the pinned devDependency as the drift tripwire.
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
	return rawTools
		.split("\n")
		.flatMap((line) => line.replace(/^-\s+/, "").split(","))
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function agentFileFixture(toolsField: string): string {
	// Mirror the packaged agent frontmatter shape: flat keys, one block/scalar
	// tools field, and a trailing key proving the tools block terminates.
	return `---
name: contract-fixture
description: External parser compatibility fixture.
${toolsField}
model: contract-fixture-model
---
Fixture body.
`;
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

// Load the real external parser from the pinned devDependency. Node refuses
// type stripping inside node_modules, so stage the pinned bytes in a temp ESM
// module first. 0.37.1 is the newest pi-subagents release this repo may
// install under its supply-chain policy (attested publisher, aged release);
// its list-parsing surface is byte-identical to current releases for flat
// keys and block lists, the only shapes packaged declarations use.
async function loadExternalParser(): Promise<{
	pkgVersion: string;
	parseFrontmatter: (content: string) => { frontmatter: Record<string, string>; body: string };
	parseFrontmatterList: (raw: string | undefined) => string[] | undefined;
}> {
	const pkgRoot = join(ROOT, "node_modules", "pi-subagents");
	const pkgVersion = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
	const stage = mkdtempSync(join(tmpdir(), "pisub-frontmatter-"));
	writeFileSync(join(stage, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		join(stage, "frontmatter.ts"),
		readFileSync(join(pkgRoot, "src", "agents", "frontmatter.ts"), "utf8"),
	);
	const external = await import(pathToFileURL(join(stage, "frontmatter.ts")).href);
	assert.equal(typeof external.parseFrontmatter, "function", "pi-subagents must export parseFrontmatter");
	assert.equal(
		typeof external.parseFrontmatterList,
		"function",
		"pi-subagents must export parseFrontmatterList",
	);
	return {
		pkgVersion,
		parseFrontmatter: external.parseFrontmatter,
		parseFrontmatterList: external.parseFrontmatterList,
	};
}

test("external pi-subagents parser partitions both declaration forms identically", async () => {
	const external = await loadExternalParser();
	const agentFiles = readdirSync(AGENTS_DIR)
		.filter((entry) => entry.endsWith(".md"))
		.sort();
	assert.ok(agentFiles.length > 0, "gentle-pi must ship packaged agents");

	for (const fileName of agentFiles) {
		const path = join(AGENTS_DIR, fileName);
		const rawTools = readRawToolsBlock(path);
		const entriesWithMcp = [...expectedBlockEntries(rawTools), "mcp:contract.search"];

		// Exercise the production loading path (pi-subagents agents.ts):
		// parseFrontmatter on the whole file, then parseFrontmatterList on the
		// tools value — never the vendored copies above.
		const blockField = `tools:\n${[...rawTools.split("\n"), "- mcp:contract.search"]
			.map((line) => `  ${line}`)
			.join("\n")}`;
		const blockFile = agentFileFixture(blockField);
		const scalarFile = agentFileFixture(`tools: ${entriesWithMcp.join(", ")}`);
		const blockTokens = external.parseFrontmatterList(
			external.parseFrontmatter(blockFile).frontmatter.tools,
		);
		const scalarTokens = external.parseFrontmatterList(
			external.parseFrontmatter(scalarFile).frontmatter.tools,
		);

		assert.deepEqual(
			blockTokens,
			scalarTokens,
			`${fileName} block and comma forms must produce the same tokens under the external parser`,
		);
		assert.deepEqual(
			splitToolList(blockTokens),
			splitToolList(scalarTokens),
			`${fileName} block and comma forms must produce the same mcp: partition under the external parser`,
		);
		assert.ok(
			(splitToolList(blockTokens).mcpDirectTools ?? []).includes("contract.search"),
			`${fileName} external parser must surface mcp: entries for direct tool partitioning`,
		);
		assert.ok(
			external.parseFrontmatter(blockFile).frontmatter.model === "contract-fixture-model",
			`${fileName} external parser must terminate the tools block at the next key`,
		);

		// Drift tripwire: the vendored contract above must keep matching the
		// pinned external parser, so a silent edit on either side fails here.
		assert.deepEqual(
			parseFrontmatterList(external.parseFrontmatter(blockFile).frontmatter.tools),
			blockTokens,
			`vendored parseFrontmatterList drifted from pi-subagents@${external.pkgVersion}`,
		);
	}
});
