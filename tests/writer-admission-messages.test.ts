import assert from "node:assert/strict";
import test from "node:test";
import { allowedEditSurfaces, rejectUnscopedBoundedWriterDispatch, WRITER_EDIT_SURFACE_REJECTION } from "../lib/bounded-writer-admission.ts";

// cost-speed P9b: a rejected `## Allowed edit surfaces` section names the invalid entry (quoted, bounded,
// control characters escaped), its position, why it is invalid and the fix, then one short rule sentence.
// The tool hook (extensions/gentle-ai.ts) and the executor (extensions/gentle-agents.ts) both call this function.

const H = "## Allowed edit surfaces\n";
const RULE = "Fix only that section, then relaunch with the rest of the task unchanged, never shortened or re-summarized; derive the surfaces from the task (narrow repository-relative paths or globs, one per line, until the next Markdown heading) and do not ask the human to author paths or globs.";

function reason(task: string, context?: string): string {
	const result = rejectUnscopedBoundedWriterDispatch({ agent: "gentle-ai-worker", mode: "task", task, context });
	assert.equal(result?.block, true, `rejected: ${JSON.stringify(task)}`);
	return result!.reason;
}

const LIST_TEXT = "is text under a list marker, not a path; move it below another Markdown heading, as a line of its own outside the list";
const CONTROL = "contains a control or line-separator character; retype it without that character";
// The quote keeps every character but ASCII spaces at the ends, with invisible characters escaped.
const quote = (line: string) => line.replace(/^ +| +$/g, "").replace(/\p{Cc}|\p{Zl}|\p{Zp}/gu, char => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);
const entry = (shown: string, position: string, why: string) => `Allowed edit surfaces entry "${shown}" (${position}) ${why}. ${RULE}`;

test("the rule sentence is the exported constant, sent once, after the specific part", () => {
	assert.equal(WRITER_EDIT_SURFACE_REJECTION, RULE);
	const text = reason(`${H}/etc/passwd`);
	assert.ok(text.endsWith(` ${RULE}`));
	assert.equal(text.split(RULE).length, 2, "rule appears exactly once");
});

for (const [label, section, expected] of [
	["prose after a blank line", "src/a.ts\n\nRequirements: one parent transaction.", entry("Requirements: one parent transaction.", "non-empty line 2", "looks like prose; move it below another Markdown heading")],
	["list-marked prose", "- src/a.ts\n- Then run the focused test file.", entry("- Then run the focused test file.", "non-empty line 2", "looks like prose; move it below another Markdown heading")],
	["trailing comment after a path", "src/a.ts  # the model", entry("src/a.ts  # the model", "non-empty line 1", "has text after the path; move that text below another Markdown heading")],
	["path with spaces, no backticks", "- docs/with space.md", entry("- docs/with space.md", "non-empty line 1", "has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading")],
	["prose that is never a path", "- ~ notes for later", entry("- ~ notes for later", "non-empty line 1", "is not a path; move it below another Markdown heading")],
	["absolute path", "- /etc/passwd", entry("- /etc/passwd", "non-empty line 1", "is absolute or home-relative; use a repository-relative path")],
	["home path", "~/x.ts", entry("~/x.ts", "non-empty line 1", "is absolute or home-relative; use a repository-relative path")],
	["drive path", "C:\\x.ts", entry("C:\\x.ts", "non-empty line 1", "is absolute or home-relative; use a repository-relative path")],
	["repository root", "src/a.ts\n.", entry(".", "non-empty line 2", "names the whole repository; list only the paths or narrow globs the task edits")],
	["dot-slash root", "./", entry("./", "non-empty line 1", "names the whole repository; list only the paths or narrow globs the task edits")],
	["parent segment", "src/../../x.ts", entry("src/../../x.ts", "non-empty line 1", "has a `..` segment; use a path inside the repository")],
	["root glob", "**/*.ts", entry("**/*.ts", "non-empty line 1", "starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`")],
	["stray backtick", "src/`odd.ts", entry("src/`odd.ts", "non-empty line 1", "has stray backticks; remove them")],
	["partial backticks", "`lib/a.ts` trailing", entry("`lib/a.ts` trailing", "non-empty line 1", "has text outside its backticked path; move that text below another Markdown heading")],
	["control character", "src/a\u0007.ts", entry("src/a\\u0007.ts", "non-empty line 1", "contains a control or line-separator character; retype it without that character")],
	["line separator", "`Dir\u2028x/a.md`", entry("`Dir\\u2028x/a.md`", "non-empty line 1", "contains a control or line-separator character; retype it without that character")],
	["marker only", "src/a.ts\n-", entry("-", "non-empty line 2", "is a list marker with no path; put the path after it or delete the line")],
	["numbered marker only", "1.", entry("1.", "non-empty line 1", "is a list marker with no path; put the path after it or delete the line")],
	["heading indented four spaces", "src/a.ts\n    ## Return", entry("## Return", "non-empty line 2", "is a heading indented 4+ spaces, so it does not end the section; start it at the line start")],
	["heading-like text under a dash marker", "src/a.ts\n- # foo", entry("- # foo", "non-empty line 2", LIST_TEXT)],
	["heading-like text under a star marker", "* ## notes", entry("* ## notes", "non-empty line 1", LIST_TEXT)],
	["leading tab", "\tsrc/a.ts", entry("\\u0009src/a.ts", "non-empty line 1", CONTROL)],
	["trailing tab", "src/a.ts\t", entry("src/a.ts\\u0009", "non-empty line 1", CONTROL)],
	["tab-indented list entry", "src/b.ts\n\t- src/a.ts", entry("\\u0009- src/a.ts", "non-empty line 2", CONTROL)],
] as const) {
	test(`invalid entry names line, position, reason and fix: ${label}`, () => {
		assert.equal(reason(`Task.\n\n${H}${section}\n\n## Return\nReport`), expected);
	});
}

test("several invalid entries: the first is named and the rest are counted", () => {
	assert.equal(reason(`${H}src/a.ts\n/abs\nnote one\n..`), entry("/abs", "non-empty line 2", "is absolute or home-relative; use a repository-relative path").replace(`. ${RULE}`, `. 2 more invalid lines follow. ${RULE}`));
	assert.equal(reason(`${H}/abs\n..`), entry("/abs", "non-empty line 1", "is absolute or home-relative; use a repository-relative path").replace(`. ${RULE}`, `. 1 more invalid line follows. ${RULE}`));
});

test("an invalid entry in a later section names that section", () => {
	assert.equal(reason(`${H}src/a.ts`, `${H}src/a.ts\n/abs`), entry("/abs", "non-empty line 2 of section 2", "is absolute or home-relative; use a repository-relative path"));
});

test("section-level problems name what to change", () => {
	assert.equal(reason("Implement it."), `No \`## Allowed edit surfaces\` heading was found; add it with one path per line. ${RULE}`);
	assert.equal(reason("Implement it.\n\n## Allowed edit surfaces:\nsrc/a.ts"), `No \`## Allowed edit surfaces\` heading was found; "## Allowed edit surfaces:" is close: rename it to exactly \`## Allowed edit surfaces\`. ${RULE}`);
	assert.equal(reason("### Edit surfaces\nsrc/a.ts"), `No \`## Allowed edit surfaces\` heading was found; "### Edit surfaces" is close: rename it to exactly \`## Allowed edit surfaces\`. ${RULE}`);
	assert.equal(reason(`${H}\n## Return\nReport`), `The \`## Allowed edit surfaces\` section has no entries; add one path per line before the next heading. ${RULE}`);
	assert.equal(reason(`${H}src/a.ts`, `${H}src/b.ts`), `Repeated \`## Allowed edit surfaces\` sections disagree on "src/a.ts"; keep one section or list the same entries in each. ${RULE}`);
});

test("echo is bounded to 80 UTF-8 bytes and secret-looking values are masked", () => {
	const long = `Then ${"verify every requirement ".repeat(8)}carefully.`;
	const text = reason(`${H}${long}`);
	const shown = text.match(/^Allowed edit surfaces entry "(.*)" \(non-empty line 1\)/)![1];
	assert.ok(shown.endsWith("…"));
	assert.ok(Buffer.byteLength(shown) <= 80, shown);
	assert.equal(shown, `${long.slice(0, 77)}…`);
	const wide = reason(`${H}${"é".repeat(30)} notes here`).match(/"(.*)"/)![1];
	assert.ok(Buffer.byteLength(wide) <= 80 && !wide.includes("\ufffd"), wide);
	const secret = reason(`${H}API_KEY = sk-live-abcdefghijklmnopqrstuvwxyz0123456789`);
	assert.doesNotMatch(secret, /sk-live|abcdefghij/);
	assert.match(secret, /^Allowed edit surfaces entry "API_KEY = \*\*\*" \(non-empty line 1\)/);
	const token = reason(`${H}- use ghp_0123456789abcdefghijABCDEFGHIJklmnop here`);
	assert.doesNotMatch(token, /ghp_0123/);
	assert.match(token, /"- use \*\*\* here"/);
});

// Messages only: the accept/reject decision is the one the existing pins hold.
test("accepted inputs stay accepted", () => {
	for (const [section, paths] of [
		["src/a.ts", ["src/a.ts"]],
		["src/**/*.test.ts", ["src/**/*.test.ts"]],
		["`docs/with space.md`", ["docs/with space.md"]],
		["- src/a.ts\n* src/b.ts\n+ src/c.ts\n1. src/d.ts\n2) src/e.ts", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]],
		["src/a.ts\n\n\nsrc/b.ts", ["src/a.ts", "src/b.ts"]],
		["- `-`", ["-"]],
		["./src/a.ts", ["./src/a.ts"]],
		["#Return", ["#Return"]],
		["   src/a.ts   ", ["src/a.ts"]],
	] as const) {
		const task = `Task.\n${H}${section}\n## Return\nReport`;
		assert.deepEqual(allowedEditSurfaces(task), [...paths], section);
		assert.equal(rejectUnscopedBoundedWriterDispatch({ agent: "worker", task }), undefined, section);
	}
});

test("rejected inputs stay rejected", () => {
	for (const section of ["", "Requirements: x.", "src/a.ts  # c", "/abs", ".", "..", "**/*.ts", "a b/c.md", "src/a\u0007.ts", "-", "`x", "    ## Return", "``"]) {
		const task = `${H}${section}`;
		assert.equal(allowedEditSurfaces(task), undefined, JSON.stringify(section));
		assert.equal(rejectUnscopedBoundedWriterDispatch({ agent: "gentle-ai-worker", task })?.block, true, JSON.stringify(section));
	}
	assert.equal(rejectUnscopedBoundedWriterDispatch({ agent: "gentle-ai-explore", task: "no heading" }), undefined, "non-writers are untouched");
});

// Verifier blocker 3: the fix a message suggests, applied literally to the offending entry, yields the path the
// author meant or an input that is still rejected; never a different accepted surface.
function applyFix(entry: string, message: string, intent: "path" | "prose"): string | undefined {
	const marker = /^(?:[-*+]|\d+[.)]) +/.exec(entry)?.[0] ?? "";
	const body = entry.slice(marker.length);
	if (message.includes("if it is one path, wrap")) return intent === "path" ? `${marker}\`${body}\`` : undefined;
	if (message.includes("move that text below")) return `${marker}${/`[^`]+`/.exec(body)?.[0] ?? body.split(/\s+/)[0].replace(/:$/, "")}`;
	if (message.includes("keep only the path")) return `${marker}${body.split(/\s+/).at(-1)}`;
	if (message.includes("put one path per line")) return body.split(/\s*,\s*/).map(path => `${marker}${path}`).join("\n");
	if (message.includes("remove them")) return entry.replace(/`/g, "");
	if (message.includes("retype it without that character")) return entry.replace(/\p{Cc}|\p{Zl}|\p{Zp}/gu, "");
	if (/move it below another Markdown heading|delete the line/.test(message)) return undefined;
	if (message.includes("start it at the line start")) return entry.trimStart();
	return "not mechanical";
}

for (const [entry, why, intent, expected] of [
	["- `src/a.ts` \u2014 new file", "has text outside its backticked path; move that text below another Markdown heading", "path", ["src/a.ts"]],
	["`src/a.ts` (new)", "has text outside its backticked path; move that text below another Markdown heading", "path", ["src/a.ts"]],
	["src/a.ts (new file)", "has text after the path; move that text below another Markdown heading", "path", ["src/a.ts"]],
	["src/a.ts  # the model", "has text after the path; move that text below another Markdown heading", "path", ["src/a.ts"]],
	["src/a.ts: the parser", "has text after the path; move that text below another Markdown heading", "path", ["src/a.ts"]],
	["src/a.ts, src/b.ts", "lists several paths; put one path per line", "path", ["src/a.ts", "src/b.ts"]],
	["Files: src/a.ts", "has a label before the path; keep only the path", "path", ["src/a.ts"]],
	["docs/my file.md", "has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading", "path", ["docs/my file.md"]],
	["Then run tests/a.test.ts", "has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading", "prose", []],
	["edit the parser module", "looks like prose; move it below another Markdown heading", "prose", []],
	["Requirements: one parent transaction.", "looks like prose; move it below another Markdown heading", "prose", []],
	["- ~ notes for later", "is not a path; move it below another Markdown heading", "prose", []],
	["`src/a.ts", "has stray backticks; remove them", "path", ["src/a.ts"]],
	["``", "has stray backticks; remove them", "path", []],
	["src/a\u0007.ts", "contains a control or line-separator character; retype it without that character", "path", ["src/a.ts"]],
	["-", "is a list marker with no path; put the path after it or delete the line", "prose", []],
	["    ## Notes", "is a heading indented 4+ spaces, so it does not end the section; start it at the line start", "prose", []],
	["- # foo", LIST_TEXT, "prose", []],
	["* ## notes", LIST_TEXT, "prose", []],
	["\tsrc/a.ts", CONTROL, "path", ["src/a.ts"]],
	["src/a.ts\t", CONTROL, "path", ["src/a.ts"]],
	["\t- src/a.ts", CONTROL, "path", ["src/a.ts"]],
	["~/my repo/a.ts", "is absolute or home-relative; use a repository-relative path", "path", null],
	["C:\\Users\\me\\my repo\\a.ts", "is absolute or home-relative; use a repository-relative path", "path", null],
	["/Users/x/repo/src/a.ts", "is absolute or home-relative; use a repository-relative path", "path", null],
	["**/my file.ts", "starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`", "path", null],
	["**/*.ts", "starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`", "path", null],
	["../my file.ts", "has a `..` segment; use a path inside the repository", "path", null],
	["src/../x", "has a `..` segment; use a path inside the repository", "path", null],
	["./", "names the whole repository; list only the paths or narrow globs the task edits", "path", null],
] as const) {
	test(`the suggested fix never admits a different surface: ${JSON.stringify(entry)}`, () => {
		const message = reason(`${H}src/keep.ts\n${entry}`);
		assert.equal(message, `Allowed edit surfaces entry "${quote(entry)}" (non-empty line 2) ${why}. ${RULE}`);
		const fixed = applyFix(entry, message, intent);
		if (expected === null) {
			// Not mechanical: the author supplies a new value. Wrapping it instead never admits it.
			assert.equal(fixed, "not mechanical");
			assert.doesNotMatch(message, /wrap/);
			assert.equal(allowedEditSurfaces(`${H}src/keep.ts\n\`${entry}\``), undefined);
			return;
		}
		const section = `${H}src/keep.ts${fixed === undefined ? "" : `\n${fixed}`}\n## Return`;
		assert.deepEqual(allowedEditSurfaces(section), ["src/keep.ts", ...expected].sort(), String(fixed));
	});
}

test("the quoted entry, ellipsis included, is at most 80 UTF-8 bytes", () => {
	for (const line of [`Then ${"verify every requirement ".repeat(8)}carefully.`, `${"é".repeat(60)} notes here`, `${"😀".repeat(40)} x`]) {
		const shown = reason(`${H}${line}`).match(/^Allowed edit surfaces entry "(.*)" \(non-empty line 1\)/)![1];
		assert.ok(shown.endsWith("…"), shown);
		assert.ok(Buffer.byteLength(shown) <= 80, `${Buffer.byteLength(shown)} ${shown}`);
		assert.ok(!shown.includes("\ufffd"));
	}
});

test("a tab at either end of an entry stays in the quote, escaped, within the 80-byte bound", () => {
	const shown = (line: string) => reason(`${H}${line}`).match(/^Allowed edit surfaces entry "(.*)" \(non-empty line 1\)/)![1];
	assert.equal(shown("\tsrc/a.ts"), "\\u0009src/a.ts");
	assert.equal(shown("src/a.ts\t"), "src/a.ts\\u0009");
	assert.equal(shown("  \t- src/a.ts  "), "\\u0009- src/a.ts");
	const long = shown(`\t${"x".repeat(200)}\t`);
	assert.ok(long.startsWith("\\u0009x") && long.endsWith("…") && Buffer.byteLength(long) <= 80, long);
});

// Review of PR #3114: the quote is produced in time linear in the entry length, and a masked token never leaks a prefix.
// 64 KiB runs first: a superlinear regression fails that size's time assertion in seconds instead of hanging
// the job on the 1 MiB input.
test("a 64 KiB and a 1 MiB invalid entry are quoted quickly and masked tokens never leak", () => {
	for (const size of [64 << 10, 1 << 20]) quotesQuickly(size);
});

function quotesQuickly(MiB: number) {
	const token = (n: number) => "Ab3".repeat(Math.ceil(n / 3)).slice(0, n);
	for (const [label, line, expected] of [
		["prose", `${"lorem ipsum dolor ".repeat(MiB / 18)}end.`, `${"lorem ipsum dolor ".repeat(5).slice(0, 77)}…`],
		["one word with no secret label", `see ${"a".repeat(MiB)} later`, `see ${"a".repeat(73)}…`],
		["a single token-like run", `/${token(MiB)}`, "/***"],
		["a token-like run after prose", `then use ${token(MiB)} here`, "then use *** here"],
		["a secret label before a long value", `api_token = ${token(MiB)}`, "api_token = ***"],
		["a long non-breaking space run with no comma", `a b${"\u00a0".repeat(MiB)}c`, `a b${"\u00a0".repeat(37)}…`],
		["short words then a long token", `${"word ".repeat(10)}${token(MiB)} end`, `${"word ".repeat(10)}*** end`],
	] as const) {
		const started = performance.now();
		const text = reason(`${H}src/keep.ts\n${line}`);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 500, `${label} at ${MiB} bytes: ${Math.round(elapsed)} ms`);
		const shown = text.match(/^Allowed edit surfaces entry "(.*)" \(non-empty line 2\)/)![1];
		assert.equal(shown, expected, label);
		assert.ok(Buffer.byteLength(shown) <= 80, label);
	}
}
