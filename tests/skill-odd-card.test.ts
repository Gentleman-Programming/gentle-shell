import assert from "node:assert/strict";
import test from "node:test";
import {
	FILE_CARD_IDENTITY,
	ODD_FILE_CARD,
	SKILL_FILE_CARD,
	fileCardIdentity,
	fileCardLineRange,
	fileCardMarkdownRows,
	fileCardName,
	isMarkdownFile,
	markdownDocumentSource,
} from "../lib/skill-odd-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// A file card is chosen from the path the call names, so every boundary case is
// pinned here: a folder called `skills` or `odd` is a path component, never a
// substring, and a Windows path classifies exactly like a POSIX one.
test("a skill and an ODD artifact are recognized by a whole path component", () => {
	assert.equal(fileCardIdentity("skills/gentle-ai/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("skills/gentle-ai/references/notes.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("packages/gentle/skills/tdd/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	// A document named SKILL.md is a skill wherever it sits: the name is the
	// file's own identity, not its folder's.
	assert.equal(fileCardIdentity("SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("/home/dev/repo/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);

	assert.equal(fileCardIdentity("odd/work/feature/design.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("odd/work")?.identity, FILE_CARD_IDENTITY.ODD, "the folder itself is an ODD path");

	// Windows separators are the same components, not a different path.
	assert.equal(fileCardIdentity("C:\\repo\\skills\\tdd\\SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	assert.equal(fileCardIdentity("C:\\repo\\odd\\work\\design.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("\\\\server\\share\\odd\\work\\design.md")?.identity, FILE_CARD_IDENTITY.ODD);
});

test("a path that merely contains the word is not a skill or an ODD artifact", () => {
	for (const path of [
		"lib/skillset/index.ts",
		"lib/my-skills/notes.md",
		"docs/oddity.md",
		"lib/odd-work/notes.md",
		"odd-work/notes.md",
		"docs/readme.md",
		"lib/x.ts",
		// A file whose own name is `odd` is not inside an ODD folder.
		"docs/odd",
	]) {
		assert.equal(fileCardIdentity(path), undefined, path);
	}
	// Nothing to classify is not an error.
	for (const path of [undefined, null, 42, "", "/", "C:\\"]) {
		assert.equal(fileCardIdentity(path), undefined, String(path));
	}
});

test("the innermost named folder decides which card a nested path wears", () => {
	assert.equal(fileCardIdentity("skills/pack/odd/notes.md")?.identity, FILE_CARD_IDENTITY.ODD);
	assert.equal(fileCardIdentity("odd/work/skills/notes.md")?.identity, FILE_CARD_IDENTITY.SKILL);
	// A SKILL.md keeps its own identity inside an ODD folder.
	assert.equal(fileCardIdentity("odd/work/skills/SKILL.md")?.identity, FILE_CARD_IDENTITY.SKILL);
});

test("a skill keeps the read card's color and an ODD artifact wears the theme's heading role", () => {
	// A skill is the read card's own color, with only its name and mark changed, while an
	// ODD artifact wears the theme's `mdHeading` role, so the theme at hand decides the
	// color and no card carries one of its own.
	assert.deepEqual(SKILL_FILE_CARD, { identity: "skill", title: "skill", glyph: "▤", titleRole: "toolTitle" });
	assert.equal(ODD_FILE_CARD.identity, "odd");
	assert.equal(ODD_FILE_CARD.title, "odd");
	assert.equal(ODD_FILE_CARD.glyph, "📑");
	assert.equal(ODD_FILE_CARD.titleRole, "mdHeading", "the ODD artifact wears the theme's own heading role");
	assert.deepEqual(Object.keys(ODD_FILE_CARD).sort(), ["glyph", "identity", "title", "titleRole"], "the card names roles, never a color of its own");
	// Not a status and not the code palette: the identity can neither read as a failure
	// nor recolor the code drawn beside it.
	assert.doesNotMatch(ODD_FILE_CARD.titleRole, /^syntax/u, "not a code-palette role");
	for (const role of ["warning", "error", "success", "toolTitle"]) assert.notEqual(ODD_FILE_CARD.titleRole, role, role);
	assert.equal(fileCardIdentity("skills/a/SKILL.md")?.title, "skill");
	assert.equal(fileCardIdentity("odd/work/a.md")?.title, "odd");
});

test("every shipped theme defines both roles a file card names, so no card owns a color", async () => {
	// The ODD heading and the Markdown body both name theme roles, so the theme at hand
	// decides what they look like and no card-local hex can disagree with it.
	const { readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");
	for (const name of ["Gentle", "Gentleman-Cute", "Gentleman-Sexy"]) {
		const theme = JSON.parse(await readFile(fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url)), "utf8"));
		const resolve = (role: string) => String(theme.vars?.[theme.colors[role]] ?? theme.colors[role]).toLowerCase();
		for (const role of [ODD_FILE_CARD.titleRole, "mdCode", "mdCodeBlock", "mdListBullet"]) {
			assert.ok(Object.hasOwn(theme.colors, role), `${name} defines ${role}`);
			assert.match(resolve(role), /^#[0-9a-f]{6}$/u, `${name}: ${role} resolves to a color`);
		}
	}
});

test("a collapsed card can name the file itself, on either separator", () => {
	// The last path component and nothing else: a name with spaces stays whole, a
	// trailing separator names no empty file, and a Windows path reads like a POSIX one.
	assert.equal(fileCardName("odd/work/design.md"), "design.md");
	assert.equal(fileCardName("C:\\repo\\odd\\work\\design.md"), "design.md");
	assert.equal(fileCardName("odd/my design doc.md"), "my design doc.md");
	assert.equal(fileCardName("odd/work/"), "work", "a trailing separator names no empty file");
	assert.equal(fileCardName("design.md"), "design.md");
	// Nothing to name is nothing, never an invented file.
	for (const value of ["", "/", undefined, null, 7]) assert.equal(fileCardName(value), "", String(value));
});

test("only a Markdown file is rendered as Markdown", () => {
	for (const path of ["skills/a/SKILL.md", "odd/work/a.md", "odd/work/a.MD", "C:\\repo\\odd\\a.Md"]) {
		assert.equal(isMarkdownFile(path), true, path);
	}
	for (const path of ["skills/a/notes.markdown", "odd/work/a.md.bak", "lib/x.ts", "", undefined, 7]) {
		assert.equal(isMarkdownFile(path), false, String(path));
	}
});

test("a read names the file line range it asked for, and no other tool claims one", () => {
	// The range is the call's own: the lines it asked the read to return.
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 142, limit: 4 }), ":142-145");
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 2, limit: 3 }), ":2-4");
	assert.equal(fileCardLineRange("read", { path: "a.md", limit: 4 }), ":1-4");
	assert.equal(fileCardLineRange("read", { path: "a.md", offset: 5 }), ":5");
	assert.equal(fileCardLineRange("read", { path: "a.md" }), undefined);
	// A malformed range states nothing rather than inventing one.
	assert.equal(fileCardLineRange("read", { offset: "2", limit: 3 }), undefined);
	assert.equal(fileCardLineRange("read", { offset: 2, limit: 0 }), undefined);
	assert.equal(fileCardLineRange("read", { offset: 0, limit: 2 }), undefined);

	// A write and an edit know how many lines they write, never where in the file
	// those lines land. A count must never be drawn as a file line number, so the
	// card names no range at all, and the real range lives in the diff the result carries.
	assert.equal(fileCardLineRange("write", { path: "a.md", content: "one\ntwo\nthree" }), undefined);
	assert.equal(fileCardLineRange("write", { path: "a.md", content: "" }), undefined);
	assert.equal(fileCardLineRange("edit", { path: "a.md", oldText: "a", newText: "one\ntwo" }), undefined);
	assert.equal(fileCardLineRange("edit", { path: "a.md", edits: [{ oldText: "a", newText: "x" }] }), undefined);

	// Every other tool names no range, and neither does a missing argument set.
	assert.equal(fileCardLineRange("grep", { path: "a.md", limit: 2 }), undefined);
	assert.equal(fileCardLineRange("read", undefined), undefined);
});

test("only an expanded, successful read or write of a Markdown file draws a document", () => {
	const markdown = "## Handoff\n\nBody.";
	const draw = (tool: string, args: Record<string, unknown>, result: string, options: { expanded?: boolean; isError?: boolean } = {}) =>
		markdownDocumentSource(tool, args, result, { expanded: true, ...options });
	// A read draws what it returned; a write draws what its call carried, because the
	// result only acknowledges the write.
	assert.equal(draw("read", { path: "docs/a.md" }, markdown), markdown);
	assert.equal(draw("write", { path: "docs/a.md", content: markdown }, "Successfully wrote 20 bytes"), markdown);
	// Collapsed, failed, non-Markdown and every other tool keep their rows.
	assert.equal(draw("read", { path: "docs/a.md" }, markdown, { expanded: false }), undefined);
	assert.equal(draw("read", { path: "docs/a.md" }, markdown, { isError: true }), undefined);
	assert.equal(draw("edit", { path: "docs/a.md", oldText: "a", newText: markdown }, "Applied"), undefined);
	assert.equal(draw("grep", { path: "docs/a.md" }, markdown), undefined);
	assert.equal(draw("read", { path: "docs/a.txt" }, markdown), undefined);
	assert.equal(draw("write", { path: "lib/x.ts", content: markdown }, "Successfully wrote 20 bytes"), undefined);
	// Nothing to draw is not a document: an empty body keeps the result it has.
	assert.equal(draw("read", { path: "docs/a.md" }, ""), undefined);
	assert.equal(draw("read", { path: "docs/a.md" }, "   \n\n"), undefined);
	assert.equal(draw("write", { path: "docs/a.md", content: "" }, "Successfully wrote 0 bytes"), undefined);
	assert.equal(draw("write", { path: "docs/a.md" }, "Successfully wrote 0 bytes"), undefined);
	assert.equal(draw("read", undefined, markdown), undefined);
});

const taggedTheme = {
	fg: (color: string, text: string) => `[${color}]${text}`,
	bold: (text: string) => `<b>${text}</b>`,
};

test("a Markdown document renders through Pi's own Markdown, in the theme's roles", () => {
	const source = "## Handoff\n\nSome **bold** text with `code`.\n";
	const rows = fileCardMarkdownRows(source, taggedTheme, 40);
	const shown = rows.join("\n");
	assert.match(shown, /\[mdHeading\](?:<b>)?Handoff/);
	assert.match(shown, /\[mdCode\]code/);
	assert.equal(shown.includes("## "), false, "the heading renders instead of showing its source");
	assert.equal(shown.includes("**"), false, "inline emphasis renders instead of its source");
});

test("a file is never swallowed: a theme that cannot paint Markdown still shows its rows", () => {
	const unreadable = {
		fg() {
			throw new Error("no roles here");
		},
	};
	const rows = fileCardMarkdownRows("first line\nsecond line", unreadable, 40);
	assert.deepEqual(rows.map((row) => stripAnsi(row).trimEnd()), ["first line", "second line"]);
	// The fallback fits the width it was given, and keeps every row.
	const narrow = fileCardMarkdownRows("first line\nsecond line", unreadable, 6);
	assert.ok(narrow.length >= 2, "every source row reaches the card");
	for (const row of narrow) assert.ok(stripAnsi(row).length <= 6, `"${row}" fits`);
	// An empty document draws nothing at all rather than a blank card row.
	assert.deepEqual(fileCardMarkdownRows("", taggedTheme, 40), []);
	assert.deepEqual(fileCardMarkdownRows("   \n\n", taggedTheme, 40), []);
	assert.deepEqual(fileCardMarkdownRows("first line", taggedTheme, 0), []);
});
