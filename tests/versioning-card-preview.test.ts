import assert from "node:assert/strict";
import test from "node:test";
import { versioningCardPreview, versioningCommandFamily } from "../lib/versioning-card-preview.ts";

// Synthetic fixtures only. Every shape below is written here rather than captured
// from a repository, a terminal or a live git invocation, so this suite reads no
// private data, no working tree and no git state: the preview is a pure function
// of the command and the output the host already retained.

/** A commit's own success output: the summary, the diffstat, then one row per created file. */
const COMMIT_OUTPUT = [
	"[main 1a2b3c4] feat: add the thing",
	" 2 files changed, 5 insertions(+), 1 deletion(-)",
	" create mode 100644 src/a.ts",
	" create mode 100644 src/b.ts",
].join("\n");

test("a separator quoted inside a commit message separates nothing", () => {
	// A commit message is one argument, so a `;` or `&&` it quotes splits no segment:
	// the commit is still the step that reported, and its output keeps the commit
	// shape rather than the shape of a command the message merely mentions.
	const command = 'git commit -m "docs: clarify; git add -A stages everything"';
	assert.equal(versioningCommandFamily(command), "commit");
	assert.deepEqual(versioningCardPreview({ command, output: COMMIT_OUTPUT, failed: false }), {
		text: "[main 1a2b3c4] feat: add the thing\n 2 files changed, 5 insertions(+), 1 deletion(-)",
		tail: false,
		reveals: true,
	});
	// The same holds for `&&`, and for a real separator beside the quoted one.
	assert.equal(versioningCommandFamily('git commit -m "fix: a && git cherry-pick 1a2b3c4"'), "commit");
	assert.equal(versioningCommandFamily(`git add -A && git commit -m "fix: a && b"`), "commit");
});

test("the family follows the last local-history segment of the command", () => {
	assert.equal(versioningCommandFamily("git add -A"), "add");
	assert.equal(versioningCommandFamily("git commit --amend --no-edit"), "commit");
	assert.equal(versioningCommandFamily("git -C repo rebase main"), "rebase");
	assert.equal(versioningCommandFamily("git --no-pager cherry-pick 1a2b3c4"), "cherry-pick");
	assert.equal(versioningCommandFamily("gh stack init"), "stack");
	assert.equal(versioningCommandFamily("gh stack add feat/two"), "stack");
	// The output of a composition belongs to its last local-history step: the
	// commit is what reports, so the commit shape is the one to preview.
	assert.equal(versioningCommandFamily("git add -A && git commit -m 'feat: x'"), "commit");
	// Publishing is not versioning: a push, a pull request and an issue keep their
	// own cards, and a read is not local history at all.
	assert.equal(versioningCommandFamily("git push origin main"), undefined);
	assert.equal(versioningCommandFamily("gh pr create --title x"), undefined);
	assert.equal(versioningCommandFamily("gh issue edit 7 --add-label bug"), undefined);
	assert.equal(versioningCommandFamily("git status"), undefined);
	// A commit message that merely mentions a command stays one segment, so the
	// commit's own shape is still the one read.
	assert.equal(versioningCommandFamily('git commit -m "then git add -A"'), "commit");
});

test("a silent add draws no rows and offers nothing to expand", () => {
	// `git add` prints nothing when it succeeds. Nothing here may turn that silence
	// into a claim about what it staged, so the card draws no rows at all.
	for (const output of ["", "\n", "  \n\n"]) {
		assert.deepEqual(
			versioningCardPreview({ command: "git add -A", output, failed: false }),
			{ text: "", tail: false, reveals: false },
			JSON.stringify(output),
		);
	}
});

test("a commit previews its summary and diffstat instead of its file list", () => {
	const preview = versioningCardPreview({ command: "git commit -m 'feat: add the thing'", output: COMMIT_OUTPUT, failed: false });
	assert.deepEqual(preview, {
		text: "[main 1a2b3c4] feat: add the thing\n 2 files changed, 5 insertions(+), 1 deletion(-)",
		tail: false,
		reveals: true,
	});
	// Nothing is rewritten: every preview row is one the call itself printed.
	for (const row of preview!.text.split("\n")) assert.ok(COMMIT_OUTPUT.split("\n").includes(row), row);
});

test("a commit on a detached head and a cherry-pick keep their own summary row", () => {
	const detached = ["[detached HEAD 5e6f7a8] fix: replay me", " 1 file changed, 2 insertions(+)"].join("\n");
	assert.equal(
		versioningCardPreview({ command: "git commit -m 'fix: replay me'", output: detached, failed: false })?.text,
		detached,
	);
	// A cherry-pick prints the commit it replayed, its author and date, then the
	// diffstat: the card keeps the two rows that name the result.
	const picked = [
		"[main 5e6f7a8] fix: replay me",
		" Author: Ada Lovelace <ada@example.com>",
		" Date: Mon Jan 1 00:00:00 2024 +0000",
		" 1 file changed, 2 insertions(+)",
	].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git cherry-pick 5e6f7a8", output: picked, failed: false }), {
		text: "[main 5e6f7a8] fix: replay me\n 1 file changed, 2 insertions(+)",
		tail: false,
		reveals: true,
	});
});

test("a localized commit keeps its own words and still previews the same two rows", () => {
	const output = [
		"[main 1a2b3c4] feat: hinzufügen",
		" 2 Dateien geändert, 5 Einfügungen(+), 1 Löschung(-)",
		" create mode 100644 src/a.ts",
	].join("\n");
	// The words are the call's own: the preview reads git's untranslated structure
	// (the summary line and the `(+)`/`(-)` markers) and never rewrites a sentence.
	assert.equal(
		versioningCardPreview({ command: "git commit -m x", output, failed: false })?.text,
		"[main 1a2b3c4] feat: hinzufügen\n 2 Dateien geändert, 5 Einfügungen(+), 1 Löschung(-)",
	);
	// A translated sentence the preview cannot read keeps the raw rows instead of
	// inventing a summary out of it.
	const nothing = "Auf Branch main\nnichts zu committen, Arbeitsverzeichnis unverändert";
	assert.deepEqual(versioningCardPreview({ command: "git commit -m x", output: nothing, failed: false }), {
		text: nothing,
		tail: true,
		reveals: false,
	});
});

test("a rebase sentence and a stack's own output are shown raw rather than read", () => {
	// git translates its rebase sentence, and the stack extension was absent from
	// the verifier: neither shape is one this preview may parse, so both keep the
	// rows the command printed.
	const rebased = "Successfully rebased and updated refs/heads/main.\n";
	assert.deepEqual(versioningCardPreview({ command: "git rebase main", output: rebased, failed: false }), {
		text: "Successfully rebased and updated refs/heads/main.",
		tail: true,
		reveals: false,
	});
	const stacked = ["Added feat/two to the stack.", "Created branch feat/two from main."].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "gh stack add feat/two", output: stacked, failed: false }), {
		text: stacked,
		tail: true,
		reveals: false,
	});
});

test("a failed call previews its own cause and never a success summary", () => {
	const output = [
		"[main 1a2b3c4] feat: add the thing",
		" create mode 100644 src/a.ts",
		"",
		"error: pre-commit hook exited with code 1",
		"hint: fix the failing check and run the commit again",
	].join("\n");
	const preview = versioningCardPreview({ command: "git commit -m x", output, failed: true });
	// An anchored cause is drawn from the head of its rows: that is what keeps it
	// visible once a narrow card wraps them.
	assert.equal(preview?.tail, false, "a readable cause leads its own rows");
	assert.equal(preview?.text.endsWith("error: pre-commit hook exited with code 1\nhint: fix the failing check and run the commit again"), true, preview?.text);
	assert.equal(preview?.text.includes("[main 1a2b3c4]"), false, "a failed commit never shows its summary");
	assert.equal(preview?.reveals, true);
	// A rebase that stopped on a conflict keeps the cause it printed; the rows before
	// it are context an expansion restores.
	const conflict = ["CONFLICT (content): Merge conflict in src/a.ts", "error: could not apply 1a2b3c4... feat: x"].join("\n");
	assert.equal(versioningCardPreview({ command: "git rebase main", output: conflict, failed: true })?.text, "error: could not apply 1a2b3c4... feat: x");
	// A failure that printed nothing claims nothing.
	assert.deepEqual(versioningCardPreview({ command: "git add missing-path", output: "", failed: true }), {
		text: "",
		tail: true,
		reveals: false,
	});
});

test("a bracketed line that is not a commit summary is never read as one", () => {
	// A hook or a tool in the output can print a bracketed line; only git's own
	// `[<ref> <abbreviated sha>] <subject>` shape is a commit summary.
	const hookOutput = ["[eslint] 2 problems", " 1 file changed, 1 insertion(+)"].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git commit -m x", output: hookOutput, failed: false }), {
		text: hookOutput,
		tail: true,
		reveals: false,
	});
	// The real summary further down is still found, and the hook row stays behind
	// the key with the rest of the output.
	const mixed = ["[eslint] 2 problems", "[main 1a2b3c4] feat: x", " 1 file changed, 1 insertion(+)"].join("\n");
	assert.equal(versioningCardPreview({ command: "git commit -m x", output: mixed, failed: false })?.text, "[main 1a2b3c4] feat: x\n 1 file changed, 1 insertion(+)");
});

test("a long output keeps its last rows and says that expanding reveals more", () => {
	const output = ["[main 1a2b3c4] feat: x", ...Array.from({ length: 20 }, (_, index) => ` create mode 100644 src/file-${index}.ts`)].join("\n");
	const preview = versioningCardPreview({ command: "git commit -m x", output, failed: false });
	assert.equal(preview?.reveals, true, "the file list stays behind the key");
	assert.equal(preview?.text, "[main 1a2b3c4] feat: x", "a summary spends only the rows it has");
	// The raw fallback spends the budget it was given, from the end of the output.
	const verbose = Array.from({ length: 20 }, (_, index) => `add 'src/file-${index}.ts'`).join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git add -v src", output: verbose, failed: false }), {
		text: ["add 'src/file-17.ts'", "add 'src/file-18.ts'", "add 'src/file-19.ts'"].join("\n"),
		tail: true,
		reveals: true,
	});
	assert.equal(
		versioningCardPreview({ command: "git add -v src", output: verbose, failed: false, limit: 1 })?.text,
		"add 'src/file-19.ts'",
	);
});

test("a diffstat is read only after the recognized summary, and only in git's own shape", () => {
	// A hook or a tool in the output can print a row that carries the markers
	// (`check (+)`, `lint (+2)`). Only a row that follows the recognized summary and
	// opens with a count is git's diffstat, so noise before the summary is never read
	// as the stat the commit printed after it.
	const noisy = ["check (+)", "[main 1a2b3c4] feat: x", " 2 files changed, 5 insertions(+), 1 deletion(-)", " create mode 100644 src/a.ts"].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git commit -m x", output: noisy, failed: false }), {
		text: "[main 1a2b3c4] feat: x\n 2 files changed, 5 insertions(+), 1 deletion(-)",
		tail: false,
		reveals: true,
	});
	// A marker row after the summary that is not a diffstat (no count) is not the
	// stat either: the summary is the only row the commit stated.
	const marker = ["[main 1a2b3c4] feat: x", "lint (+2)", " create mode 100644 src/a.ts"].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git commit -m x", output: marker, failed: false }), {
		text: "[main 1a2b3c4] feat: x",
		tail: false,
		reveals: true,
	});
	// A deletion-only diffstat carries `(-)` rather than `(+)` and is still read.
	const deletions = ["[main 1a2b3c4] fix: drop it", " 1 file changed, 3 deletions(-)"].join("\n");
	assert.equal(versioningCardPreview({ command: "git commit -m x", output: deletions, failed: false })?.text, deletions);
});

test("a failed cherry-pick states its cause and the host's exit status ahead of the advice", () => {
	// git prints the cause, then a block of translated advice, and pi appends the
	// exit status it observed. A bounded preview must not spend all three rows on
	// advice: the cause and the status come first, the advice follows.
	const output = [
		"Auto-merging src/a.ts",
		"CONFLICT (content): Merge conflict in src/a.ts",
		"error: could not apply 1a2b3c4... feat: x",
		"hint: After resolving the conflicts, mark them with",
		'hint: "git add/rm <pathspec>", then run',
		'hint: "git cherry-pick --continue".',
		'hint: You can instead skip this commit with "git cherry-pick --skip".',
		'hint: To abort and get back to the state before "git cherry-pick",',
		'hint: run "git cherry-pick --abort".',
		"",
		"Command exited with code 1",
	].join("\n");
	const preview = versioningCardPreview({ command: "git cherry-pick 1a2b3c4", output, failed: true });
	assert.match(preview!.text, /could not apply 1a2b3c4/, "the cause survives the advice block");
	assert.match(preview!.text, /Command exited with code 1/, "and the exit status the host appended is named");
	assert.equal(preview!.text.split("\n")[0]?.startsWith("error: could not apply 1a2b3c4"), true, "with the cause ahead of any advice");
	assert.equal(preview!.tail, false, "the head is kept, so wrapping cannot hide it");
	assert.equal(preview!.reveals, true);
	// A rebase that stopped on the same kind of conflict reads the same way.
	const rebase = versioningCardPreview({ command: "git rebase main", output, failed: true });
	assert.match(rebase!.text, /could not apply 1a2b3c4/);
	assert.match(rebase!.text, /Command exited with code 1/);
	// The exit status alone still names the outcome when nothing else readable did.
	assert.deepEqual(versioningCardPreview({ command: "git add -A", output: "Command exited with code 1", failed: true }), {
		text: "Command exited with code 1",
		tail: true,
		reveals: false,
	});
});

test("a failed preview leads with its cause and never exceeds its row budget", () => {
	// The cause leads, so a card that draws only the head of its rows still shows it.
	const output = [
		"Auto-merging src/a.ts",
		"CONFLICT (content): Merge conflict in src/a.ts",
		"error: could not apply 1a2b3c4... feat: x",
		"hint: After resolving the conflicts, mark them with",
		'hint: "git add/rm <pathspec>", then run',
		'hint: run "git cherry-pick --abort".',
		"",
		"Command exited with code 1",
	].join("\n");
	const preview = versioningCardPreview({ command: "git cherry-pick 1a2b3c4", output, failed: true });
	assert.equal(preview?.text.split("\n")[0], "error: could not apply 1a2b3c4... feat: x", "the cause is the first row drawn");
	assert.equal(preview?.tail, false, "the head is kept, so wrapping cannot hide the cause");
	assert.match(preview!.text, /Command exited with code 1/, "the exit status fits beside it");
	assert.equal(preview?.reveals, true);
	// A preview narrower than its facts draws the cause and nothing more, never more
	// rows than it was given: the status row is what the budget costs first.
	assert.deepEqual(versioningCardPreview({ command: "git cherry-pick 1a2b3c4", output, failed: true, limit: 1 }), {
		text: "error: could not apply 1a2b3c4... feat: x",
		tail: false,
		reveals: true,
	});
	// A budget of two keeps the cause and the status, and the advice still waits.
	assert.equal(
		versioningCardPreview({ command: "git cherry-pick 1a2b3c4", output, failed: true, limit: 2 })?.text,
		"error: could not apply 1a2b3c4... feat: x\nCommand exited with code 1",
	);
});

test("a failure the card cannot read keeps the raw rows it printed", () => {
	// A localized failure states no untranslated `error:`/`fatal:` cause, so the card
	// reads nothing into it: the rows stay as the call printed them, advice included.
	const localized = [
		"Konflikt (Inhalt): Merge-Konflikt in src/a.ts",
		"Hinweis: Setze die Konflikte fort",
		'Hinweis: mit "git cherry-pick --continue"',
		"",
		"Command exited with code 1",
	].join("\n");
	assert.deepEqual(versioningCardPreview({ command: "git cherry-pick 1a2b3c4", output: localized, failed: true }), {
		text: ["Hinweis: Setze die Konflikte fort", 'Hinweis: mit "git cherry-pick --continue"', "Command exited with code 1"].join("\n"),
		tail: true,
		reveals: true,
	});
	// A failure never previews the success rows: the summary and the diffstat stay out
	// even when the call printed them before failing.
	const withSuccess = ["[main 1a2b3c4] feat: x", " 1 file changed, 1 insertion(+)", "error: pre-commit hook exited with code 1", "Command exited with code 1"].join("\n");
	const preview = versioningCardPreview({ command: "git commit -m x", output: withSuccess, failed: true });
	assert.doesNotMatch(preview!.text, /\[main 1a2b3c4\]|insertions?\(\+\)/);
	assert.match(preview!.text, /pre-commit hook exited with code 1/);
});

test("a card that is not versioning has no preview at all", () => {
	// Publishing, exploration and checking keep the previews they already had; the
	// helper answers nothing for them rather than styling another activity's card.
	const output = COMMIT_OUTPUT;
	for (const command of ["git push origin main", "git status", "git diff --stat", "pnpm test", "gh pr create --title x", "gh issue comment 7 --body x", "gh stack submit"]) {
		assert.equal(versioningCardPreview({ command, output, failed: false }), undefined, command);
	}
	// A commit beside a push is a publishing card, so the commit shape stays out of it.
	assert.equal(versioningCardPreview({ command: "git commit -m x && git push", output, failed: false }), undefined);
	assert.equal(versioningCardPreview({ command: "", output, failed: false }), undefined);
});
