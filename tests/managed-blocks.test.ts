import assert from "node:assert/strict";
import test from "node:test";
import {
	attachManagedBlocks,
	splitManagedBlocks,
} from "../lib/managed-blocks.ts";

function block(name: string, body: readonly string[]): string {
	return [
		`<!-- gentle-ai:${name} -->`,
		...body,
		`<!-- /gentle-ai:${name} -->`,
		"",
	].join("\n");
}

const BODY = ["# Scoped worker", "", "First paragraph.", "Second paragraph.", ""].join("\n");
const DOCUMENTATION_BLOCK = block("documentation-guidance", [
	"",
	"## Documentation",
	"",
	"Human-authored note that must survive verbatim.",
	"",
]);

test("split removes one appended managed block and keeps every other byte", () => {
	const installed = `${BODY}\n${DOCUMENTATION_BLOCK}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.equal(split.stripped, true);
	assert.equal(split.content, BODY);
	assert.deepEqual(
		split.blocks.map((entry) => entry.name),
		["documentation-guidance"],
	);
	assert.equal(split.blocks[0].text, `\n${DOCUMENTATION_BLOCK}`);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("human text inside a managed block survives verbatim", () => {
	const installed = `${BODY}\n${DOCUMENTATION_BLOCK}`;

	const split = splitManagedBlocks(installed);

	assert.match(split.blocks[0].text, /Human-authored note that must survive verbatim\./);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("two appended managed blocks keep their original order and separation", () => {
	const documentation = block("documentation-guidance", ["", "## Documentation", ""]);
	const browser = block("ego-browser-guidance", ["", "## Browser checks", ""]);
	const installed = `${BODY}\n${documentation}\n${browser}`;

	const split = splitManagedBlocks(installed);

	assert.deepEqual(
		split.blocks.map((entry) => entry.name),
		["documentation-guidance", "ego-browser-guidance"],
	);
	assert.equal(split.content, BODY);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
	assert.match(attachManagedBlocks(split.content, split.blocks).slice(BODY.length), /documentation[\s\S]*Browser checks/);
});

test("a managed block in the middle of the body is recorded at its own seam", () => {
	const routing = block("agent-routing", ["", "## Routing", "", "Delegate on the 4-file rule.", ""]);
	const installed = `# Body\n\nBefore.\n\n${routing}\nAfter.\n`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.equal(split.content, "# Body\n\nBefore.\n\nAfter.\n");
	assert.equal(split.blocks.length, 1);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("other bytes are never collapsed or trimmed", () => {
	const installed = `# Body\n\n\n\nLine with trailing spaces.   \n\n${DOCUMENTATION_BLOCK}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.content, "# Body\n\n\n\nLine with trailing spaces.   \n");
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("nested blocks stay inside their top-level parent and round-trip exactly", () => {
	const routing = block("agent-routing", [
		"",
		"## Routing",
		"",
		block("remote-authorization", ["", "## Remote authorization", ""]),
	]);
	const installed = `${BODY}\n${routing}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.deepEqual(
		split.blocks.map((entry) => entry.name),
		["agent-routing"],
	);
	assert.match(split.blocks[0].text, /<!-- gentle-ai:remote-authorization -->/);
	assert.equal(split.content, BODY);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("an unclosed marker disables stripping for the whole file", () => {
	const installed = `${BODY}\n<!-- gentle-ai:documentation-guidance -->\n\n## Documentation\n`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, "unbalanced-markers");
	assert.equal(split.stripped, false);
	assert.equal(split.content, installed);
	assert.deepEqual(split.blocks, []);
});

test("a closing marker without an opener disables stripping for the whole file", () => {
	const installed = `${BODY}\n<!-- /gentle-ai:documentation-guidance -->\n`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, "stray-closing-marker");
	assert.equal(split.stripped, false);
	assert.equal(split.content, installed);
	assert.deepEqual(split.blocks, []);
});

test("a mismatched closing marker disables stripping for the whole file", () => {
	const installed = `${BODY}\n<!-- gentle-ai:documentation-guidance -->\n\n<!-- /gentle-ai:agent-routing -->\n`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, "mismatched-closing-marker");
	assert.equal(split.content, installed);
	assert.deepEqual(split.blocks, []);
});

test("a block name reopened inside itself disables stripping for the whole file", () => {
	const installed = `${BODY}\n${[
		"<!-- gentle-ai:documentation-guidance -->",
		"",
		"<!-- gentle-ai:documentation-guidance -->",
		"",
		"<!-- /gentle-ai:documentation-guidance -->",
		"",
	].join("\n")}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, "nested-block-name");
	assert.equal(split.stripped, false);
	assert.equal(split.content, installed);
	assert.deepEqual(split.blocks, []);
});

// The existing reader treats markers inside fenced code as plain text, so the
// splitter must never strip them and must never fail the file over them.
test("markers inside a fenced code block are plain text", () => {
	const fenced = [
		"```markdown",
		"<!-- gentle-ai:documentation-guidance -->",
		"example body",
		"<!-- /gentle-ai:documentation-guidance -->",
		"```",
		"",
	].join("\n");
	const installed = `${BODY}\n${fenced}\n${DOCUMENTATION_BLOCK}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.deepEqual(
		split.blocks.map((entry) => entry.name),
		["documentation-guidance"],
	);
	assert.match(split.content, /```markdown\n<!-- gentle-ai:documentation-guidance -->\nexample body/);
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("a marker that is not alone on its line is plain text", () => {
	const installed = `${BODY}\nSee <!-- gentle-ai:documentation-guidance --> inline.\n`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.equal(split.stripped, false);
	assert.equal(split.content, installed);
	assert.deepEqual(split.blocks, []);
});

test("content without managed markers is returned unchanged", () => {
	const split = splitManagedBlocks(BODY);

	assert.equal(split.failSafe, undefined);
	assert.equal(split.stripped, false);
	assert.equal(split.content, BODY);
	assert.deepEqual(split.blocks, []);
});

test("a block at end of file without a trailing newline round-trips byte-for-byte", () => {
	const installed = `${BODY}\n${block("documentation-guidance", ["", "## Documentation"]).trimEnd()}`;

	const split = splitManagedBlocks(installed);

	assert.equal(split.content, BODY);
	assert.equal(split.blocks[0].text, installed.slice(BODY.length));
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("CRLF content round-trips byte-for-byte", () => {
	const installed = "# Body\r\n\r\nLine.\r\n\r\n<!-- gentle-ai:documentation-guidance -->\r\n\r\n## Docs\r\n<!-- /gentle-ai:documentation-guidance -->\r\n";

	const split = splitManagedBlocks(installed);

	assert.equal(split.failSafe, undefined);
	assert.equal(split.content, "# Body\r\n\r\nLine.\r\n");
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("empty content and a block at the very start of the file are handled", () => {
	assert.deepEqual(splitManagedBlocks(""), {
		content: "",
		blocks: [],
		stripped: false,
	});
	const installed = `<!-- gentle-ai:documentation-guidance -->\n\n## Docs\n<!-- /gentle-ai:documentation-guidance -->\n\nAfter.\n`;
	const split = splitManagedBlocks(installed);
	assert.equal(split.content, "\nAfter.\n");
	assert.equal(attachManagedBlocks(split.content, split.blocks), installed);
});

test("attaching no blocks changes nothing, and a block from a longer body appends at the end", () => {
	assert.equal(attachManagedBlocks(BODY, []), BODY);
	const installed = `${BODY}\n${DOCUMENTATION_BLOCK}`;
	const split = splitManagedBlocks(installed);
	const shorter = "# Short body\n";
	assert.equal(
		attachManagedBlocks(shorter, split.blocks),
		`# Short body\n${split.blocks[0].text}`,
	);
});
