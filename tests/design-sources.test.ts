import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { DESIGN_SOURCE_LIMITS, detectDesignSources, staleDesignSources } from "../lib/design-sources.ts";

// S13: the design sources a project has, found by a bounded deterministic
// walk, and the ones changed after design/system.md was written.

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-design-sources-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function write(root: string, path: string, content = ""): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

test("each design source kind is detected, sorted, and plain files are not", (t) => {
	const cwd = scratch(t);
	write(cwd, "tailwind.config.ts", "export default {}");
	write(cwd, "web/tailwind.config.cjs", "module.exports = {}");
	write(cwd, "src/styles/globals.css", ":root {\n  --brand: #0a84ff;\n}\n");
	write(cwd, "src/styles/dark.scss", "[data-theme='dark'] { --surface: #111; }");
	write(cwd, "src/app.pcss", "@import 'tailwindcss';\n@theme {\n  --color-ink: oklch(20% 0 0);\n}\n");
	write(cwd, "src/theme-entry.css", "@theme inline;");
	write(cwd, "src/design-tokens.json", "{}");
	write(cwd, "src/tokens/Tokens.ts", "export const x = 1;");
	write(cwd, "src/theme.ts", "export const theme = { colors: { primary: '#000' } };");
	write(cwd, "src/plain.css", ".btn { color: red; background: var(--brand); }");
	write(cwd, "src/commented.css", "/* :root { --x: 1px; } */\n.a { margin: 0; }");
	write(cwd, "src/nested.css", ".card { --pad: 4px; }");
	write(cwd, "src/theme.js", "export const spacing = { sm: 4 };");
	write(cwd, "src/tokens.md", "# tokens");
	write(cwd, "tailwind.config.json", "{}");
	assert.deepEqual(detectDesignSources(cwd), [
		"src/app.pcss",
		"src/design-tokens.json",
		"src/styles/dark.scss",
		"src/styles/globals.css",
		"src/theme-entry.css",
		"src/theme.ts",
		"src/tokens/Tokens.ts",
		"tailwind.config.ts",
		"web/tailwind.config.cjs",
	]);
});

test("token files count only when named as design tokens, never auth or tokenizer files", (t) => {
	const cwd = scratch(t);
	write(cwd, "src/theme.tokens.css", ".a { margin: 0; }");
	write(cwd, "src/tokens_v2.js", "export {};");
	for (const path of ["src/auth/token.ts", "src/auth/refreshToken.ts", "src/csrf-token.js", "src/tokenizer.ts", "src/jwt-token.test.ts", "src/tokens.test.ts", "src/design-tokens.spec.js"]) write(cwd, path, "export {};");
	assert.deepEqual(detectDesignSources(cwd), ["src/theme.tokens.css", "src/tokens_v2.js"]);
});

test("a project without design sources, or a missing cwd, has none", (t) => {
	const cwd = scratch(t);
	write(cwd, "src/index.ts", "export {};");
	write(cwd, "src/plain.css", "body { margin: 0; }");
	assert.deepEqual(detectDesignSources(cwd), []);
	assert.deepEqual(detectDesignSources(join(cwd, "missing")), []);
});

test("the walk skips dependency, build, VCS, design and dot directories", (t) => {
	const cwd = scratch(t);
	const css = ":root { --x: 1px; }";
	for (const dir of ["node_modules/pkg", ".git", "dist", "build", "out", "coverage", ".next", ".worktrees/other", "design", ".cache", "src/.hidden"]) {
		write(cwd, `${dir}/tokens.json`, "{}");
		write(cwd, `${dir}/vars.css`, css);
	}
	write(cwd, "packages/ui/design/tokens.json", "{}");
	assert.deepEqual(detectDesignSources(cwd), ["packages/ui/design/tokens.json"], "only the root design/ is the design output");
});

test("symlinks are not followed, to files or directories", (t) => {
	const cwd = scratch(t);
	const outside = scratch(t);
	write(outside, "shared/tokens.json", "{}");
	write(outside, "vars.css", ":root { --x: 1px; }");
	write(cwd, "src/index.ts", "");
	symlinkSync(join(outside, "shared"), join(cwd, "src", "shared"));
	symlinkSync(join(outside, "vars.css"), join(cwd, "src", "vars.css"));
	symlinkSync(join(outside, "shared", "tokens.json"), join(cwd, "tokens.json"));
	assert.deepEqual(detectDesignSources(cwd), []);
});

test("the depth cap holds: six directory levels are walked, the seventh is not", (t) => {
	const cwd = scratch(t);
	assert.equal(DESIGN_SOURCE_LIMITS.maxDepth, 6);
	write(cwd, "a/b/c/d/e/f/tokens.json", "{}");
	write(cwd, "a/b/c/d/e/f/g/tokens.json", "{}");
	assert.deepEqual(detectDesignSources(cwd), ["a/b/c/d/e/f/tokens.json"]);
});

test("the file cap holds: the walk stops after 5000 files in name order", (t) => {
	const cwd = scratch(t);
	assert.equal(DESIGN_SOURCE_LIMITS.maxFiles, 5000);
	for (let index = 0; index < 4999; index++) write(cwd, `a${String(index).padStart(4, "0")}.txt`);
	write(cwd, "z-tokens.json", "{}");
	assert.deepEqual(detectDesignSources(cwd), ["z-tokens.json"], "the 5000th file is still read");
	write(cwd, "a4999.txt");
	assert.deepEqual(detectDesignSources(cwd), [], "the 5001st file is not");
});

test("only the first 256 KiB of a stylesheet is read", (t) => {
	const cwd = scratch(t);
	assert.equal(DESIGN_SOURCE_LIMITS.maxBytes, 256 * 1024);
	const filler = `/*${"x".repeat(256 * 1024)}*/\n`;
	write(cwd, "late.css", `.a{}\n${filler}:root { --x: 1px; }`);
	write(cwd, "early.css", `:root { --x: 1px; }\n${filler}`);
	assert.deepEqual(detectDesignSources(cwd), ["early.css"]);
});

test("stale sources are the ones modified after design/system.md", (t) => {
	const cwd = scratch(t);
	write(cwd, "tailwind.config.js", "module.exports = {}");
	write(cwd, "src/tokens.json", "{}");
	const sources = detectDesignSources(cwd);
	assert.deepEqual(staleDesignSources(cwd, sources), [], "no design/system.md, nothing is stale");
	write(cwd, "design/system.md", "# Tokens");
	utimesSync(join(cwd, "design", "system.md"), 2000, 2000);
	utimesSync(join(cwd, "tailwind.config.js"), 1000, 1000);
	utimesSync(join(cwd, "src", "tokens.json"), 3000, 3000);
	assert.deepEqual(staleDesignSources(cwd, sources), ["src/tokens.json"]);
	utimesSync(join(cwd, "src", "tokens.json"), 2000, 2000);
	assert.deepEqual(staleDesignSources(cwd, sources), [], "an equal mtime is not newer");
	assert.deepEqual(staleDesignSources(cwd, [...sources, "gone.css"]), [], "a source that vanished is skipped");
});
