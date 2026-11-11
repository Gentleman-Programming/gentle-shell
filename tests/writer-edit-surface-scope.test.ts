import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// Bounded writer edit-surface scope guard (issue #484).
//
// The guard reads the `## Allowed edit surfaces` section out of the delegated
// `subagent_run` prompt. A delegated task is a full prompt: the surfaces list
// is followed by deeper headings (`### Validation`, `#### Return`) and by
// ordinary prose. The section remains fail-closed through ordinary prose until
// the next canonical Markdown heading, so following content is always parsed as
// a surface entry rather than silently discarded. A `context` value carrying
// only the heading and its lines had nothing following it, which is why the same
// surfaces were accepted there and rejected in `task`.
//
// Every case below runs through the real `tool_call` hook with the exact
// `subagent_run` input shape, because that is the boundary that rejected.
// ---------------------------------------------------------------------------

// cost-speed P9b: the rule sentence follows the specific problem, once.
const REJECTION =
	"Fix only that section, then relaunch with the rest of the task unchanged, never shortened or re-summarized; derive the surfaces from the task (narrow repository-relative paths or globs, one per line, until the next Markdown heading) and do not ask the human to author paths or globs.";

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

const scratchRoots: string[] = [];

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function dispatchWriter(input: Record<string, unknown>) {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-writer-surfaces-"));
	scratchRoots.push(cwd);
	// S16: these tests cover the surface rule; a measured context at the backstop admits the launch so the
	// feature-document admission (tests/writer-feature-document-admission.test.ts) does not decide here.
	return toolCall!({ toolName: "subagent_run", input }, {
		cwd,
		hasUI: false,
		ui: { confirm: async () => true },
		getContextUsage: () => ({ tokens: 150_000, contextWindow: 272_000, percent: 55 }),
	} as unknown as ExtensionContext);
}

async function assertAccepted(input: Record<string, unknown>, message: string) {
	assert.equal(await dispatchWriter(input), undefined, message);
}

// Each entry problem: why it is invalid, then its fix.
const ENTRY_REASONS = [
	"is a list marker with no path; put the path after it or delete the line",
	"contains a control or line-separator character; retype it without that character",
	"has stray backticks; remove them",
	"has text outside its backticked path; move that text below another Markdown heading",
	"lists several paths; put one path per line",
	"has a label before the path; keep only the path",
	"is a heading indented 4+ spaces, so it does not end the section; start it at the line start",
	"is text under a list marker, not a path; move it below another Markdown heading, as a line of its own outside the list",
	"is not a path; move it below another Markdown heading",
	"has text after the path; move that text below another Markdown heading",
	"looks like prose; move it below another Markdown heading",
	"has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading",
	"is absolute or home-relative; use a repository-relative path",
	"names the whole repository; list only the paths or narrow globs the task edits",
	"has a `..` segment; use a path inside the repository",
	"starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`",
	"is not a narrow repository-relative path or glob; use one",
];
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PROBLEM = new RegExp(`^(?:${[
	"No `## Allowed edit surfaces` heading was found; (?:add it with one path per line|\".+\" is close: rename it to exactly `## Allowed edit surfaces`)\\.",
	escapeRegExp("The `## Allowed edit surfaces` section has no entries; add one path per line before the next heading."),
	"Repeated `## Allowed edit surfaces` sections disagree on \".+\"; keep one section or list the same entries in each\\.",
	`Allowed edit surfaces entry ".+" \\(non-empty line \\d+(?: of section \\d+)?\\) (?:${ENTRY_REASONS.map(escapeRegExp).join("|")})\\.(?: \\d+ more invalid lines? follows?\\.)?`,
].join("|")})$`);

// Every rejection is exactly one concrete problem (entry quoted, position, reason, fix)
// followed once by the rule sentence; nothing else (review R3-005, cost-speed P9b).
function rejectionProblem(reason: string): string {
	assert.ok(reason.endsWith(` ${REJECTION}`), "rule sentence suffix");
	const problem = reason.slice(0, reason.length - REJECTION.length - 1);
	assert.match(problem, PROBLEM);
	return problem;
}

async function assertRejected(input: Record<string, unknown>, message: string) {
	const result = await dispatchWriter(input);
	assert.equal(result?.block, true, message);
	rejectionProblem(result.reason);
}

// gentle-shell#1713: an unexplained rejection made the orchestrator resend
// shorter, re-summarized tasks (1786 -> 1542 chars) and lose requirements.
test("rejection names the offending line and asks for the same task unchanged", async () => {
	const result = await dispatchWriter({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [
			"Implement split transactions.",
			"",
			"## Allowed edit surfaces",
			"- src/model.ts",
			"- test/**/*.test.ts",
			"",
			"Requirements: one parent transaction with ordered allocations.",
		].join("\n"),
	});
	assert.equal(result?.block, true);
	assert.equal(rejectionProblem(result.reason), `Allowed edit surfaces entry "Requirements: one parent transaction with ordered allocations." (non-empty line 3) looks like prose; move it below another Markdown heading.`);
	assert.match(result.reason, /then relaunch with the rest of the task unchanged, never shortened or re-summarized/);
	const missing = await dispatchWriter({ agent: "gentle-ai-worker", mode: "task", task: "Implement it." });
	assert.equal(rejectionProblem(missing?.reason ?? ""), "No `## Allowed edit surfaces` heading was found; add it with one path per line.");
});

test("each rejection names its concrete problem, and invalid paths are not called prose", async () => {
	const problem = async (input: Record<string, unknown>) => rejectionProblem((await dispatchWriter({ agent: "gentle-ai-worker", mode: "task", ...input }))!.reason);
	assert.equal(await problem({ task: "## Allowed edit surfaces\n\n## Return\nReport" }), "The `## Allowed edit surfaces` section has no entries; add one path per line before the next heading.");
	assert.equal(await problem({ task: "## Allowed edit surfaces\nsrc/a.ts", context: "## Allowed edit surfaces\nsrc/b.ts" }), "Repeated `## Allowed edit surfaces` sections disagree on \"src/a.ts\"; keep one section or list the same entries in each.");
	const entry = (shown: string, why: string) => `Allowed edit surfaces entry "${shown}" (non-empty line 1) ${why}.`;
	for (const [path, why] of [
		["/etc/passwd", "is absolute or home-relative; use a repository-relative path"],
		["../outside.ts", "has a `..` segment; use a path inside the repository"],
		["src/../../x.ts", "has a `..` segment; use a path inside the repository"],
		["**/*.ts", "starts with a glob, so it spans the whole repository; start with a directory, for example `src/**/*.ts`"],
		["src/`odd.ts", "has stray backticks; remove them"],
	]) {
		assert.equal(await problem({ task: `## Allowed edit surfaces\n- ${path}` }), entry(`- ${path}`, why), path);
	}
	const long = `Then ${"verify every requirement ".repeat(8)}carefully.`;
	const prose = "looks like prose; move it below another Markdown heading";
	assert.equal(await problem({ task: `## Allowed edit surfaces\nsrc/a.ts\n${long}` }), `Allowed edit surfaces entry "${long.slice(0, 77)}…" (non-empty line 2) ${prose}.`);
	// A real path with a space must not be steered out of the section.
	assert.equal(await problem({ task: "## Allowed edit surfaces\n- docs/with space.md" }), entry("- docs/with space.md", "has spaces outside backticks; if it is one path, wrap the whole entry in backticks, otherwise move it below another Markdown heading"));
	// Whitespace that stays invalid even when quoted is plain prose.
	assert.equal(await problem({ task: "## Allowed edit surfaces\n- ~ notes for later" }), entry("- ~ notes for later", "is not a path; move it below another Markdown heading"));
	const control = await problem({ task: "## Allowed edit surfaces\nsrc/a\u0007.ts" });
	assert.doesNotMatch(control, /\u0007/);
	assert.equal(control, entry("src/a\\u0007.ts", "contains a control or line-separator character; retype it without that character"));
});

test("task-scoped surfaces are accepted ahead of a deeper heading", async () => {
	await assertAccepted({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [
			"Fix the decoder.",
			"",
			"## Allowed edit surfaces",
			"- `lib/sdd-status.ts`",
			"- `tests/sdd-status.test.ts`",
			"",
			"### Validation commands",
			"- pnpm test",
			"",
			"#### Return",
			"- one structured envelope",
		].join("\n"),
	}, "a delegated task ends its surfaces list at the next heading of any level");
});

test("task-scoped surfaces reject trailing prose before the next heading", async () => {
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [
			"## Allowed edit surfaces",
			"- `lib/sdd-status.ts`",
			"",
			"Then run the focused test file and report the outcome.",
		].join("\n"),
	}, "trailing prose must begin under a following Markdown heading");
});

test("canonical headings close the surface section with up to three ASCII spaces", async () => {
	for (const indentation of ["", " ", "  ", "   "]) {
		await assertAccepted({
			agent: "gentle-ai-worker",
			mode: "task",
			task: [
				"## Allowed edit surfaces",
				"- `lib/sdd-status.ts`",
				`${indentation}### Validation`,
				"node --test",
			].join("\n"),
		}, `${JSON.stringify(indentation)} indentation closes the section`);
	}
});

test("canonical empty headings with trailing spaces close the surface section", async () => {
	for (const indentation of ["", "   "]) {
		await assertAccepted({
			agent: "gentle-ai-worker",
			mode: "task",
			task: [
				"## Allowed edit surfaces",
				"- `lib/sdd-status.ts`",
				`${indentation}### `,
				"Ordinary prose after an empty heading is not a surface entry.",
			].join("\n"),
		}, `${JSON.stringify(indentation)} indentation closes at an empty heading`);
	}
});

test("pseudo-headings remain inside the surface section and reject dangerous paths", async () => {
	for (const [label, heading] of [
		["four-space indentation", "    ### Validation"],
		["seven hashes", "####### Validation"],
		["bare marker", "###"],
		["missing heading separator", "###Validation"],
		["tab", "###\tValidation"],
		["vertical tab", "###\vValidation"],
		["form feed", "###\fValidation"],
		["bare carriage return", "###\rValidation"],
		["NBSP", "###\u00a0Validation"],
		["em space", "###\u2003Validation"],
		["Ogham space", "###\u1680Validation"],
		["line separator", "###\u2028Validation"],
		["paragraph separator", "###\u2029Validation"],
	] as const) {
		await assertRejected({
			agent: "gentle-ai-worker",
			mode: "task",
			task: [
				"## Allowed edit surfaces",
				"- `lib/sdd-status.ts`",
				heading,
				"/etc/passwd",
			].join("\n"),
		}, `${label} pseudo-heading cannot close the surface section`);
	}
});

test("only ASCII spaces may separate Markdown list markers from entries", async () => {
	for (const [label, separator] of [
		["NBSP", "\u00a0"],
		["em space", "\u2003"],
		["Ogham space", "\u1680"],
		["tab", "\t"],
	] as const) {
		await assertRejected({
			agent: "gentle-ai-worker",
			mode: "task",
			task: ["## Allowed edit surfaces", `-${separator}\`lib/sdd-status.ts\``].join("\n"),
		}, `${label} cannot separate a list marker and entry`);
	}
	await assertAccepted({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `lib/sdd-status.ts`", "1. tests/sdd-status.test.ts"].join("\n"),
	}, "ASCII-space bullets and numbered entries remain accepted");
});

test("the documented task shape from issue #484 is accepted", async () => {
	await assertAccepted({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [
			"## Allowed edit surfaces",
			"- `lib/sdd-status.ts`",
			"- `tests/sdd-status.test.ts`",
			"",
			"## Skills to load before work",
			"- `skills/typescript/SKILL.md`",
		].join("\n"),
	}, "the reported repro shape stays accepted");
});

test("bullet, backtick and plain-line surfaces reach the same decision", async () => {
	const bulleted = ["## Allowed edit surfaces", "- `lib/sdd-status.ts`", "- `tests/sdd-status.test.ts`"].join("\n");
	const plain = ["## Allowed edit surfaces", "lib/sdd-status.ts", "tests/sdd-status.test.ts"].join("\n");
	await assertAccepted({ agent: "gentle-ai-worker", mode: "task", task: bulleted }, "bullets in task are accepted");
	await assertAccepted({ agent: "gentle-ai-worker", mode: "task", task: plain }, "plain lines in task are accepted");
	await assertAccepted(
		{ agent: "gentle-ai-worker", mode: "task", task: "Fix the decoder.", context: bulleted },
		"bullets in context are accepted",
	);
	await assertAccepted(
		{ agent: "gentle-ai-worker", mode: "task", task: "Fix the decoder.", context: plain },
		"plain lines in context are accepted",
	);
	await assertAccepted(
		{ agent: "gentle-ai-worker", mode: "task", task: bulleted, context: plain },
		"the same surfaces in both fields are accepted",
	);
	await assertAccepted(
		{
			agent: "gentle-ai-worker",
			mode: "task",
			task: ["## Allowed edit surfaces", "extensions/**/*.ts", "tests/*.test.ts"].join("\n"),
		},
		"narrow no-space globs remain accepted",
	);
});

test("a list broken by a blank line still validates every entry", async () => {
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `lib/sdd-status.ts`", "", "- `/etc/passwd`"].join("\n"),
	}, "a loose bulleted list cannot smuggle an absolute path past the guard");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		context: ["## Allowed edit surfaces", "lib/sdd-status.ts", "", "/etc/passwd"].join("\n"),
	}, "a loose plain-line list cannot smuggle an absolute path past the guard");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "lib/sdd-status.ts", "", "../other-repo/lib/a.ts"].join("\n"),
	}, "a loose plain-line list cannot smuggle parent traversal past the guard");
});

test("an entry hidden below a paragraph is validated, not discarded", async () => {
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [
			"## Allowed edit surfaces",
			"- `lib/sdd-status.ts`",
			"",
			"Also authorize the following path.",
			"- `/etc/passwd`",
		].join("\n"),
	}, "prose cannot close the section while a path still follows it");
});

test("whitespace-bearing surfaces require whole-entry backticks", async () => {
	const backtickedSpaced = [
		"## Allowed edit surfaces",
		"- `Directory With Spaces/note.md`",
		"`Directory\u00a0With\u2003Spaces/unicode.md`",
	];
	const equivalentBacktickedSpaced = [
		"## Allowed edit surfaces",
		"`Directory With Spaces/note.md`",
		"- `Directory\u00a0With\u2003Spaces/unicode.md`",
	];

	await assertAccepted(
		{ agent: "gentle-ai-worker", mode: "task", task: backtickedSpaced.join("\n") },
		"whole-entry backticked ASCII and Unicode space-separator paths are accepted",
	);
	await assertAccepted(
		{ agent: "gentle-ai-worker", mode: "task", task: backtickedSpaced.join("\n"), context: equivalentBacktickedSpaced.join("\n") },
		"task and context compare equivalent backticked whitespace-bearing paths by value",
	);
	await assertAccepted({
		agent: "gentle-ai-worker",
		mode: "task",
		task: [...backtickedSpaced, "### Validation", "node --test"].join("\n"),
	}, "the next Markdown heading closes a backticked whitespace-bearing surface section");

	for (const [label, entry] of [
		["bare spaced path", "Directory With Spaces/note.md"],
		["bare bulleted spaced path", "- Directory With Spaces/note.md"],
		["bare NBSP path", "Directory\u00a0With Spaces/note.md"],
		["bare em-space path", "Directory\u2003With Spaces/note.md"],
		["U+0085 control path", "`Directory\u0085With Spaces/note.md`"],
		["U+0085 list separator", "-\u0085`lib/sdd-status.ts`"],
		["U+2028 line-separator path", "`Directory\u2028With Spaces/note.md`"],
		["U+2029 paragraph-separator path", "`Directory\u2029With Spaces/note.md`"],
		["list-marked prose", "- Then run the focused test file."],
		["marker-only hyphen", "-"],
		["empty backticks", "``"],
		["unclosed backticks", "`lib/sdd-status.ts"],
		["partially backticked path", "`lib/sdd-status.ts` trailing"],
		["absolute spaced path", "/tmp/Outside Directory/file.md"],
		["parent spaced path", "../Other Directory/file.md"],
		["home spaced path", "~/Private Directory/file.md"],
		["Windows spaced path", "C:\\Outside Directory\\file.md"],
		["dangerous backticked bullet", "- `/tmp/Outside Directory/file.md`"],
	] as const) {
		await assertRejected({
			agent: "gentle-ai-worker",
			mode: "task",
			task: ["## Allowed edit surfaces", "lib/sdd-status.ts", entry].join("\n"),
		}, `${label} after a valid entry is rejected`);
		await assertRejected({
			agent: "gentle-ai-worker",
			mode: "task",
			task: ["## Allowed edit surfaces", entry, "lib/sdd-status.ts"].join("\n"),
		}, `${label} before a valid entry is rejected`);
	}
});

test("out-of-scope and empty surfaces stay rejected", async () => {
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: "Fix the decoder.",
	}, "a task with no section is rejected");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Edit ranges", "- `lib/sdd-status.ts`"].join("\n"),
	}, "a semantically equivalent heading is rejected with the actionable canonical-heading reason");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "", "## Skills to load before work", "- `skills/typescript/SKILL.md`"].join("\n"),
	}, "an empty section is rejected");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `/home/user/repo/lib/sdd-status.ts`"].join("\n"),
	}, "an absolute path is rejected");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `../other-repo/lib/sdd-status.ts`"].join("\n"),
	}, "parent traversal is rejected");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `.`"].join("\n"),
	}, "the repository root is rejected");
	await assertRejected({
		agent: "gentle-ai-worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `*`"].join("\n"),
	}, "a repository-wide glob is rejected");
	await assertRejected({
		agent: "worker",
		mode: "task",
		task: ["## Allowed edit surfaces", "- `~/lib/sdd-status.ts`"].join("\n"),
	}, "a home-relative path is rejected for the configured worker too");
});

test("agents outside the bounded writer set are not scope-guarded", async () => {
	await assertAccepted({
		agent: "gentle-ai-explore",
		mode: "task",
		task: "Map the decoder call sites.",
	}, "a read-only explorer needs no edit surfaces");
});
