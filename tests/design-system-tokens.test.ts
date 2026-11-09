import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_SYSTEM_TOKENS, MAX_SYSTEM_MD_BYTES, parseSystemTokens, readSystemTokens } from "../lib/design-system-tokens.ts";

// The canvas inspector compares what an artboard renders with design/system.md. The server reads that
// file read-only and gives the page its tokens: table rows with a backticked `--name` and value.

const REAL = readFileSync(fileURLToPath(new URL("../design/system.md", import.meta.url)), "utf8");

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-tokens-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const byName = (text: string) => new Map(parseSystemTokens(text).map((token) => [token.name, token]));

test("S1: the real design/system.md yields its colors, fonts, radius, shadows and layout tokens, grouped by section", () => {
	const tokens = byName(REAL);
	assert.deepEqual(tokens.get("--bg"), { name: "--bg", value: "#1a1218", section: "Colors — brand set", group: "color" });
	assert.equal(tokens.get("--accent")?.value, "#f095c8");
	assert.equal(tokens.get("--text-muted")?.group, "color");
	assert.equal(tokens.get("--accent-line")?.section, "Colors — canvas derived tokens");
	assert.equal(tokens.get("--rail-width")?.value, "60px");
	assert.equal(tokens.get("--rail-width")?.group, "layout");
	assert.equal(tokens.get("--side-width")?.value, "360px");
	// Rows that list several tokens in a cell.
	assert.equal(tokens.get("--success-halo")?.value, "#b4e7c726");
	assert.equal(tokens.get("--success-line")?.value, "#b4e7c766");
	assert.equal(tokens.get("--error-wash")?.value, "#ff718f1a");
	assert.equal(tokens.get("--scrim")?.value, "#000000b3");
	// Tokens written inline in the first cell.
	assert.match(tokens.get("--font-sans")!.value, /^Inter, "SF Pro Text"/);
	assert.equal(tokens.get("--font-sans")?.group, "font");
	assert.match(tokens.get("--font-mono")!.value, /^"IosevkaTerm NF"/);
	assert.equal(tokens.get("--radius-sm")?.value, "8px");
	assert.equal(tokens.get("--radius-pill")?.value, "999px");
	assert.equal(tokens.get("--radius-sm")?.group, "radius");
	assert.equal(tokens.get("--glow")?.value, "0 10px 30px #f095c84d");
	assert.equal(tokens.get("--glow-hover")?.value, "0 14px 36px #f095c86b");
	assert.equal(tokens.get("--shadow-frame")?.group, "shadow");
	assert.equal(tokens.get("--ease")?.value, "cubic-bezier(.4, 0, .2, 1)");
	// Prose and non-token rows are not tokens.
	for (const name of tokens.keys()) assert.match(name, /^--[A-Za-z0-9_-]+$/);
	assert.equal([...tokens.keys()].some((name) => name.includes(" ")), false);
	assert.ok(tokens.size >= 46, `${tokens.size} tokens`);
});

test("S1: the colors of the real file are the ones canvas.css declares in :root", () => {
	const css = readFileSync(fileURLToPath(new URL("../assets/design-canvas/canvas.css", import.meta.url)), "utf8");
	const root = css.match(/:root\s*{[^}]*}/)![0];
	const tokens = byName(REAL);
	for (const [name, value] of root.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{3,8});/g).map((match) => [match[1], match[2]] as const)) {
		if (tokens.has(name)) assert.equal(tokens.get(name)!.value, value, name);
	}
});

test("S1: only table rows whose cells carry backticked names are tokens; headers, separators and prose are skipped", () => {
	const text = [
		"## Colors",
		"",
		"| Token | Value | Usage |",
		"| --- | --- | --- |",
		"| `--bg` | `#1a1218` | Page |",
		"| --plain | `#fff` | no backticks on the name |",
		"| `--novalue` | #fff | no backticks on the value |",
		"| `not-a-property` | `#000` | not a custom property |",
		"| `--ok-2_x` | `#abc` | |",
		"A line outside a table with `--x` `#123`.",
		"| |",
		"|`--tight`|`#010101`|",
	].join("\n");
	assert.deepEqual([...byName(text).keys()], ["--bg", "--ok-2_x", "--tight"]);
});

test("S1: a name listed in two cells is paired with its value; unequal lists are skipped", () => {
	const text = "## Colors\n| `--a` / `--b` | `#111111` / `#222222` | x |\n| `--c` / `--d` | `#333333` | x |\n";
	const tokens = byName(text);
	assert.equal(tokens.get("--a")?.value, "#111111");
	assert.equal(tokens.get("--b")?.value, "#222222");
	assert.equal(tokens.has("--c"), false);
	assert.equal(tokens.has("--d"), false);
});

test("S1: a duplicate name keeps its first definition, CRLF files and escaped pipes parse, and groups follow the section heading", () => {
	const text = ["## Colors", "| `--a` | `#111111` |", "| `--a` | `#999999` |", "## Spacing", "| `--space-1` | `4px` |", "## Radius", "| `--r` | `a \\| b` |", "## Misc", "| `--m` | `1` |", ""].join("\r\n");
	const tokens = parseSystemTokens(text);
	assert.deepEqual(tokens.map((token) => [token.name, token.value, token.group]), [["--a", "#111111", "color"], ["--space-1", "4px", "spacing"], ["--r", "a | b", "radius"], ["--m", "1", "other"]]);
	assert.equal(tokens[0].section, "Colors");
});

test("S1: rows before any heading have an empty section, and prose or an empty file has no tokens", () => {
	assert.deepEqual(parseSystemTokens("| `--a` | `#111111` |").map((token) => [token.name, token.section]), [["--a", ""]]);
	assert.deepEqual(parseSystemTokens(""), []);
	assert.deepEqual(parseSystemTokens("# Title\n\nJust prose.\n"), []);
});

test("S1: tokens, names, values and sections are bounded", () => {
	const rows = Array.from({ length: MAX_SYSTEM_TOKENS + 50 }, (_, index) => `| \`--t${index}\` | \`#000000\` |`).join("\n");
	assert.equal(parseSystemTokens(`## Many\n${rows}`).length, MAX_SYSTEM_TOKENS);
	assert.deepEqual(parseSystemTokens(`| \`--${"n".repeat(80)}\` | \`#000\` |`), [], "a name over 64 characters");
	assert.deepEqual(parseSystemTokens(`| \`--v\` | \`${"x".repeat(401)}\` |`), [], "a value over 400 characters");
	assert.equal(parseSystemTokens(`## ${"h".repeat(200)}\n| \`--a\` | \`#000\` |`)[0].section.length, 80);
});

test("S1: readSystemTokens reads design/system.md read-only and never throws", async (t) => {
	const root = scratch(t);
	assert.deepEqual(await readSystemTokens(root), { exists: false, tokens: [] }, "missing file");
	assert.deepEqual(await readSystemTokens(join(root, "no-such-design-root")), { exists: false, tokens: [] }, "missing design root");
	writeFileSync(join(root, "system.md"), "");
	assert.deepEqual(await readSystemTokens(root), { exists: true, tokens: [] }, "empty file");
	writeFileSync(join(root, "system.md"), "garbage \u0000 \ud800 | | |\n| `--a` | `#112233` |\n");
	assert.deepEqual((await readSystemTokens(root)).tokens.map((token) => token.name), ["--a"], "malformed content");
	writeFileSync(join(root, "system.md"), REAL);
	const real = await readSystemTokens(root);
	assert.equal(real.exists, true);
	assert.deepEqual(real.tokens, parseSystemTokens(REAL));
});

test("S1: a file past the size limit gives no tokens and says why, without reading it", async (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "system.md"), `## Colors\n| \`--a\` | \`#000\` |\n${"x".repeat(MAX_SYSTEM_MD_BYTES)}`);
	assert.deepEqual(await readSystemTokens(root), { exists: true, tokens: [], problem: "too-large" });
});

test("S1: a symlink out of the design root, a directory, or a broken link is not read", async (t) => {
	const root = scratch(t);
	const outside = scratch(t);
	writeFileSync(join(outside, "system.md"), "| `--a` | `#112233` |");
	symlinkSync(join(outside, "system.md"), join(root, "system.md"));
	assert.deepEqual(await readSystemTokens(root), { exists: false, tokens: [] });
	const dir = scratch(t);
	mkdirSync(join(dir, "system.md"));
	assert.deepEqual(await readSystemTokens(dir), { exists: false, tokens: [] });
	const broken = scratch(t);
	symlinkSync(join(broken, "gone.md"), join(broken, "system.md"));
	assert.deepEqual(await readSystemTokens(broken), { exists: false, tokens: [] });
});
