import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEGRAPH_MARK,
	codeGraphCollapsedRows,
	codeGraphInitOutcome,
	codeGraphResultSummary,
	codegraphCallDetail,
	codegraphCallFromCommand,
} from "../lib/codegraph-card-preview.ts";

// Fixtures are rows the real binary printed in fresh temporary Git repositories
// (codegraph 1.6.0). This suite reads no repository, index or terminal: the preview
// is a pure function of the operation, the command and the output already retained.

/** A fresh init: its progress box and the sentence it ends with. */
const INIT = ["┌  Initializing CodeGraph", "│", "◆  Initialized in /tmp/ws", "│", "└  Done", ""].join("\n");
/** `codegraph init` on a workspace that already has an index. */
const INIT_ALREADY = ["┌  Initializing CodeGraph", "▲  Already initialized in /tmp/ws", '●  Use "codegraph index" to re-index or "codegraph sync" to update'].join("\n");
/** An init log with facts but no concluding sentence. */
const INIT_FACTS = ["┌  Initializing CodeGraph", "Scanning files...", "◆  Indexed 2 files", "●  5 nodes, 7 edges in 239ms", "└  Done"].join("\n");
/** A successful `codegraph query`: two entries. */
const QUERY = ['Search Results for "alpha":', "", "function    alpha", "  src/a.ts:1", "", "import      ./a.ts", "  src/b.ts:1"].join("\n");

test("an init card collapses to the one sentence the tool printed", () => {
	assert.equal(codeGraphInitOutcome(INIT), "initialized");
	assert.equal(codeGraphInitOutcome(INIT_ALREADY), "already initialized");
	// No concluding sentence is no outcome: the card keeps the rows it has.
	assert.equal(codeGraphInitOutcome(INIT_FACTS), undefined);
	assert.equal(codeGraphInitOutcome("▲  Failed: EACCES: permission denied"), undefined);
	assert.deepEqual(codeGraphCollapsedRows("init", INIT, false, false), { text: "→ initialized", rows: 1, tail: false });
	assert.deepEqual(codeGraphCollapsedRows("init", INIT_ALREADY, false, false), { text: "→ already initialized", rows: 1, tail: false });
});

test("an init without a concluding sentence previews the facts it reported", () => {
	assert.deepEqual(codeGraphCollapsedRows("init", INIT_FACTS, false, false), {
		text: "◆  Indexed 2 files\n●  5 nodes, 7 edges in 239ms",
		rows: 3,
		tail: true,
	});
});

test("a query and an explore summarize the count their own output stated", () => {
	assert.equal(codeGraphResultSummary("query", QUERY), "2 results");
	assert.equal(codeGraphResultSummary("query", 'ℹ No results found for "zzz"'), "0 results");
	assert.equal(codeGraphResultSummary("explore", "**Exploration: alpha**\n\nFound 2 symbols across 1 file."), "2 symbols in 1 file");
	assert.equal(codeGraphResultSummary("explore", "**Exploration: alpha**\n\nFound 1 symbol across 1 file."), "1 symbol in 1 file");
	// A shape the module cannot read yields no count at all.
	assert.equal(codeGraphResultSummary("query", "some unexpected banner"), undefined);
	assert.equal(codeGraphResultSummary("explore", "**Exploration: alpha**"), undefined);
	assert.equal(codeGraphResultSummary("init", QUERY), undefined);
	assert.deepEqual(codeGraphCollapsedRows("query", QUERY, false, false), { text: "→ 2 results", rows: 1, tail: false });
});

test("an unreadable shape keeps the rows it printed, and a failure its reason", () => {
	const unknown = ["first printed row", "second printed row"].join("\n");
	assert.deepEqual(codeGraphCollapsedRows("query", unknown, false, false), { text: unknown, rows: 3, tail: true });
	assert.match(codeGraphCollapsedRows("init", "▲  Failed: EACCES: permission denied", true, false)?.text ?? "", /Failed: EACCES/);
	// A withheld card draws no rows, but a failure always says why.
	assert.equal(codeGraphCollapsedRows("query", QUERY, false, true), undefined);
	assert.match(codeGraphCollapsedRows("init", "▲  Failed: EACCES", true, true)?.text ?? "", /Failed:/);
});

test("the identity reads the operation and query from the bash command", () => {
	assert.deepEqual(codegraphCallFromCommand("codegraph init /tmp/ws"), { operation: "init" });
	assert.deepEqual(codegraphCallFromCommand("codegraph query --path /tmp/ws --limit 5 -- alpha"), { operation: "query", query: "alpha" });
	assert.deepEqual(codegraphCallFromCommand('codegraph explore --path /tmp/ws --max-files 5 -- "a b"'), { operation: "explore", query: "a b" });
	// Without a `--` separator only a lone payload is readable; flags are never guessed into the query.
	assert.deepEqual(codegraphCallFromCommand("codegraph query alpha"), { operation: "query", query: "alpha" });
	assert.deepEqual(codegraphCallFromCommand("codegraph query --path /tmp/ws alpha"), { operation: "query" });
	// A composition belongs to its last CodeGraph step, through the classifier's own splitter.
	assert.deepEqual(codegraphCallFromCommand("cd /tmp/ws && codegraph init"), { operation: "init" });
	assert.deepEqual(codegraphCallFromCommand("CI=1 codegraph init"), { operation: "init" });
	assert.deepEqual(codegraphCallFromCommand("/usr/local/bin/codegraph init"), { operation: "init" });
	assert.equal(codegraphCallDetail({ operation: "init" }), "init");
	assert.equal(codegraphCallDetail({ operation: "query", query: "alpha" }), "query alpha");
	// The mark is the tool's own icon.
	assert.equal(CODEGRAPH_MARK, "\u{F01BC}");
});

test("a command that merely mentions codegraph is not a CodeGraph call", () => {
	for (const command of ["echo codegraph init", "git log --grep codegraph", "mytool codegraph init", "codegraph", "codegraph --version", "codegraph --help", "codegraph init && ./script"]) {
		assert.equal(codegraphCallFromCommand(command), undefined, command);
	}
});
