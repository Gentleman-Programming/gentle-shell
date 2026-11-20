import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_SYSTEM_LINE, MAX_SYSTEM_TOKENS, MAX_SYSTEM_MD_BYTES, parseSystemTokens, readSystemTokens } from "../lib/design-system-tokens.ts";

// The canvas inspector compares what an artboard renders with design/system.md. The server reads that
// file read-only and gives the page its tokens: table rows with a backticked `--name` and value.

const REAL = readFileSync(fileURLToPath(new URL("../design/system.md", import.meta.url)), "utf8");

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-tokens-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const byName = (text: string) => new Map(parseSystemTokens(text).map((token) => [token.name, token]));

test("S1: the real design/system.md yields the wizard's colors, fonts, radius, shadows and motion tokens, grouped by section", () => {
	const tokens = byName(REAL);
	assert.deepEqual(tokens.get("--bg"), { name: "--bg", value: "#1a1218", section: "Colors", group: "color" });
	assert.equal(tokens.get("--accent")?.value, "#f095c8");
	assert.equal(tokens.get("--text-muted")?.group, "color");
	assert.equal(tokens.get("--border-soft")?.value, "#ffffff17");
	assert.equal(tokens.get("--info")?.value, "#a9c7ee");
	assert.match(tokens.get("--font-sans")!.value, /^Inter, "SF Pro Text"/);
	assert.equal(tokens.get("--font-sans")?.group, "font");
	assert.match(tokens.get("--font-mono")!.value, /^"IosevkaTerm NF"/);
	assert.equal(tokens.get("--radius-sm")?.value, "8px");
	assert.equal(tokens.get("--radius-pill")?.value, "999px");
	assert.equal(tokens.get("--radius-sm")?.group, "radius");
	assert.equal(tokens.get("--glow")?.value, "0 10px 30px #f095c84d");
	assert.equal(tokens.get("--glow-hover")?.value, "0 14px 36px #f095c86b");
	assert.equal(tokens.get("--shadow-panel")?.group, "shadow");
	assert.equal(tokens.get("--ease")?.value, "cubic-bezier(.4, 0, .2, 1)");
	// Prose and non-token rows are not tokens.
	for (const name of tokens.keys()) assert.match(name, /^--[A-Za-z0-9_-]+$/);
	assert.equal(tokens.size, 27, [...tokens.keys()].join(" "));
});

// Every documented token row names the file it comes from in its Source cell, and that file must
// declare the token with the same value. Returns one line per problem; empty when the file is sound.
const REPO = fileURLToPath(new URL("..", import.meta.url));
const rowCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
const declared = (css: string) => {
	const found = new Map<string, string[]>();
	for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g)) {
		found.set(match[1], [...(found.get(match[1]) ?? []), match[2].replace(/\s+/g, " ").trim()]);
	}
	return found;
};

function sourceProblems(text: string, root: string): string[] {
	const problems: string[] = [];
	let header: string[] | undefined;
	let checked = 0;
	for (const line of text.split(/\r\n?|\n/)) {
		if (!line.trim().startsWith("|")) {
			header = undefined;
			continue;
		}
		const cells = rowCells(line);
		if (!header) {
			header = cells.map((cell) => cell.toLowerCase());
			continue;
		}
		const tokens = parseSystemTokens(line);
		if (tokens.length === 0) continue;
		checked += tokens.length;
		const names = tokens.map((token) => token.name).join(", ");
		const column = header.indexOf("source");
		const paths = column < 0 ? [] : [...(cells[column] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
		if (paths.length !== 1) {
			problems.push(`${names}: the row names no single source file`);
			continue;
		}
		const path = join(root, paths[0]);
		if (paths[0].split(/[\\/]/).includes("..") || !existsSync(path) || !statSync(path).isFile()) {
			problems.push(`${names}: source ${paths[0]} does not exist`);
			continue;
		}
		const css = declared(readFileSync(path, "utf8"));
		for (const token of tokens) {
			const values = css.get(token.name);
			if (!values) problems.push(`${token.name}: not declared in ${paths[0]}`);
			else if (!values.includes(token.value.replace(/\s+/g, " ").trim())) problems.push(`${token.name}: ${token.value} in system.md, ${values.join(" | ")} in ${paths[0]}`);
		}
	}
	const total = parseSystemTokens(text).length;
	if (checked !== total) problems.push(`${total - checked} documented tokens sit outside a table with a Source column`);
	return problems;
}

test("S8: every token of the real design/system.md is declared, with the same value, in the source file its row names", () => {
	assert.ok(parseSystemTokens(REAL).length > 0, "the real file documents tokens");
	assert.deepEqual(sourceProblems(REAL, REPO), []);
});

test("S7: the real design/system.md describes the project only, never the canvas UI style", () => {
	for (const canvas of ["design-canvas", "canvas.css", "--gd-", "Same brand set", "| both |"]) assert.ok(!REAL.includes(canvas), `system.md mentions ${canvas}`);
});

test("S8: the source check fails on a missing token, a different value, a row without a source and a source that does not exist", (t) => {
	const root = scratch(t);
	writeFileSync(join(root, "theme.css"), ":root {\n\t--a: #111111;\n\t--b: 0 1px  2px #000;\n}\n/* --c: #333333; */\n");
	const table = (rows: string[]) => ["## Colors", "", "| Token | Value | Source |", "| --- | --- | --- |", ...rows].join("\n");
	assert.deepEqual(sourceProblems(table(["| `--a` | `#111111` | `theme.css` |", "| `--b` | `0 1px 2px #000` | `theme.css` |"]), root), []);
	assert.deepEqual(sourceProblems(table(["| `--c` | `#333333` | `theme.css` |"]), root), ["--c: not declared in theme.css"]);
	assert.deepEqual(sourceProblems(table(["| `--a` | `#222222` | `theme.css` |"]), root), ["--a: #222222 in system.md, #111111 in theme.css"]);
	assert.deepEqual(sourceProblems(table(["| `--a` | `#111111` | both |"]), root), ["--a: the row names no single source file"]);
	assert.deepEqual(sourceProblems(table(["| `--a` | `#111111` | `gone.css` |"]), root), ["--a: source gone.css does not exist"]);
	assert.deepEqual(sourceProblems(table(["| `--a` | `#111111` | `../theme.css` |"]), root), ["--a: source ../theme.css does not exist"]);
	assert.deepEqual(sourceProblems("## Colors\n\n| Token | Value |\n| --- | --- |\n| `--a` | `#111111` |\n", root), ["--a: the row names no single source file"]);
	assert.deepEqual(sourceProblems("## Colors\n\n| `--a` | `#111111` | `theme.css` |\n", root), ["1 documented tokens sit outside a table with a Source column"]);
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

test("a pathological first cell parses in linear time, and lines past the length cap are skipped", () => {
	for (const filler of [" ", "1", " :", ".5"]) {
		const line = `| \`--a\` ${filler.repeat(60_000)}x | y |`;
		const started = performance.now();
		assert.deepEqual(parseSystemTokens(`## Colors\n${line}\n`), [], JSON.stringify(filler));
		assert.ok(performance.now() - started < 200, `${JSON.stringify(filler)} took ${Math.round(performance.now() - started)} ms`);
	}
	// Inline tokens still parse.
	assert.deepEqual(parseSystemTokens("## Radius\n| `--radius-sm` 8px, `--radius-md`: `12px` | x |\n").map((token) => [token.name, token.value]), [["--radius-sm", "8px"], ["--radius-md", "12px"]]);
	const long = `| \`--long\` | \`#000\` | ${"note ".repeat(MAX_SYSTEM_LINE / 5)} |`;
	assert.ok(long.length > MAX_SYSTEM_LINE);
	assert.deepEqual(parseSystemTokens(`## Colors\n${long}\n| \`--short\` | \`#fff\` |\n`).map((token) => token.name), ["--short"], "an over-long line is skipped, the next one still parses");
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
