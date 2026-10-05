import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";
import { canonicalWriterRoot, normalizeSurfaceEntry, overlappingSurfaces, surfacesOverlap, WriterSurfaceRegistry, writerSurfaceConflictMessage } from "../lib/writer-surfaces.ts";

// gentle-shell#1731 T4 (S2, AC6): concurrent writers are admitted only when
// their `## Allowed edit surfaces` are disjoint. Overlap is conservative: two
// entries overlap when some path could be covered by both, and an entry also
// covers everything under it, so uncertainty always reads as overlap.

test("normalizeSurfaceEntry strips list markers, backticks, ./ and trailing slashes", () => {
	assert.equal(normalizeSurfaceEntry("lib/a.ts"), "lib/a.ts");
	assert.equal(normalizeSurfaceEntry("- `docs/with space.md`"), "docs/with space.md");
	assert.equal(normalizeSurfaceEntry("`./lib//a.ts`"), "lib/a.ts");
	assert.equal(normalizeSurfaceEntry("lib\\nested\\a.ts"), "lib\\nested\\a.ts", "backslashes are kept for the fail-safe check");
	assert.equal(normalizeSurfaceEntry("src/cafe\u0301.ts"), "src/caf\u00e9.ts", "entries compare in NFC");
	assert.equal(normalizeSurfaceEntry("lib/./dir/"), "lib/dir");
	assert.equal(normalizeSurfaceEntry("  1. tests/x.test.ts  "), "tests/x.test.ts");
});

test("normalizeSurfaceEntry refuses entries it cannot scope", () => {
	for (const entry of ["", " ", ".", "./", "/abs/a.ts", "~/a.ts", "C:/a.ts", "lib/../a.ts", "``"]) {
		assert.equal(normalizeSurfaceEntry(entry), undefined, entry);
	}
});

test("disjoint files do not overlap", () => {
	assert.equal(surfacesOverlap("lib/a.ts", "lib/b.ts"), false);
	assert.equal(surfacesOverlap("lib/a.ts", "tests/a.ts"), false);
	assert.equal(surfacesOverlap("lib/a.ts", "lib/a.ts.bak"), false);
	assert.equal(surfacesOverlap("lib/a/b.ts", "lib/b/b.ts"), false);
});

test("the same file overlaps, whatever its spelling", () => {
	assert.equal(surfacesOverlap("lib/a.ts", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("`lib/a.ts`", "./lib/a.ts"), true);
	assert.equal(surfacesOverlap("- lib/a.ts", "lib//a.ts"), true);
	assert.equal(surfacesOverlap("lib/A.ts", "lib/a.ts"), true, "case-insensitive filesystems make these one file");
});

test("a glob covering a file overlaps it", () => {
	assert.equal(surfacesOverlap("lib/*.ts", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("lib/a.ts", "lib/*.ts"), true);
	assert.equal(surfacesOverlap("tests/*.test.ts", "tests/writer-surfaces.test.ts"), true);
	assert.equal(surfacesOverlap("lib/?.ts", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("lib/[ab].ts", "lib/b.ts"), true);
	assert.equal(surfacesOverlap("lib/[!a].ts", "lib/b.ts"), true);
	assert.equal(surfacesOverlap("lib/{a,b}.ts", "lib/b.ts"), true);
	assert.equal(surfacesOverlap("lib/*.ts", "lib/a.md"), false);
	assert.equal(surfacesOverlap("lib/{a,b}.ts", "lib/c.ts"), false);
	assert.equal(surfacesOverlap("lib/*.ts", "tests/a.ts"), false);
});

test("a directory glob or bare directory covers anything under it", () => {
	assert.equal(surfacesOverlap("lib/**", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("lib/**", "lib/deep/nested/a.ts"), true);
	assert.equal(surfacesOverlap("lib/a.ts", "lib/**"), true);
	assert.equal(surfacesOverlap("lib/**/*.ts", "lib/x/y.md"), true, "after ** the rest may sit under the other entry");
	assert.equal(surfacesOverlap("lib", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("lib/", "lib/a.ts"), true);
	assert.equal(surfacesOverlap("**/*.ts", "docs/a.md"), true);
	assert.equal(surfacesOverlap("lib/**", "tests/a.ts"), false);
	assert.equal(surfacesOverlap("lib/**", "libs/a.ts"), false);
});

test("two globs overlap unless their literal affixes prove them disjoint", () => {
	assert.equal(surfacesOverlap("lib/*.ts", "lib/*.md"), false);
	assert.equal(surfacesOverlap("lib/a*.ts", "lib/b*.ts"), false);
	assert.equal(surfacesOverlap("lib/a*", "lib/*b"), true);
	assert.equal(surfacesOverlap("lib/*.ts", "lib/x*"), true);
	assert.equal(surfacesOverlap("lib/**", "lib/*.md"), true);
	assert.equal(surfacesOverlap("lib/*/a.ts", "lib/x/*.ts"), true);
	assert.equal(surfacesOverlap("lib/*/a.ts", "tests/*/a.ts"), false);
});

test("uncertain entries are treated as overlapping", () => {
	assert.equal(surfacesOverlap("lib/../tests/a.ts", "docs/b.md"), true, "unscopable entry");
	assert.equal(surfacesOverlap(".", "docs/b.md"), true, "repository root");
	assert.equal(surfacesOverlap("lib/@(a|b).ts", "lib/c.ts"), true, "extglob syntax is not interpreted");
	assert.equal(surfacesOverlap("lib/x[y", "lib/xzzy"), true, "an unclosed class falls back to affixes");
	assert.equal(surfacesOverlap("lib/{a,{b,c}}.ts", "lib/d.ts"), true, "nested braces are not interpreted");
});

// Verify B1: a brace group spanning `/` must never be split into segments.
test("a brace group spanning a slash overlaps everything", () => {
	assert.equal(surfacesOverlap("lib/{foo.ts,bar/baz.ts}", "lib/bar/baz.ts"), true);
	assert.equal(surfacesOverlap("src/{a,b/c}.ts", "src/b/c.ts"), true);
	assert.equal(surfacesOverlap("src/b/c.ts", "src/{a,b/c}.ts"), true);
	assert.equal(surfacesOverlap("lib/{x,y/z}/w.ts", "docs/a.md"), true, "fail safe even across unrelated roots");
	assert.equal(surfacesOverlap("lib/a}.ts", "lib/b.ts"), true, "an unbalanced brace is not interpreted");
	const registry = new WriterSurfaceRegistry();
	registry.claim("task-a", "/repo", ["lib/{foo.ts,bar/baz.ts}"]);
	assert.deepEqual(registry.conflicts("/repo", ["lib/bar/baz.ts"]).map(conflict => conflict.taskId), ["task-a"]);
});

// Verify M1: lowercasing and class syntax (negation, POSIX classes) are never
// interpreted; any bracket in an entry overlaps everything.
test("any bracket class overlaps everything", () => {
	assert.equal(surfacesOverlap("src/[^a].ts", "src/A.ts"), true);
	assert.equal(surfacesOverlap("src/[!a-z].ts", "src/B.ts"), true);
	assert.equal(surfacesOverlap("src/[[:alpha:]].ts", "src/b.ts"), true);
	assert.equal(surfacesOverlap("lib/[ab].ts", "lib/c.ts"), true);
	assert.equal(surfacesOverlap("lib/[a/b].ts", "docs/x.md"), true);
});

// Second verify (A1 fail-safe additions): a backslash may be an escape or a
// separator, so the entry overlaps everything.
test("any backslash overlaps everything", () => {
	assert.equal(surfacesOverlap("src/foo\\*", "src/foo?"), true);
	assert.equal(surfacesOverlap("lib\\a.ts", "docs/x.md"), true);
	assert.equal(surfacesOverlap("docs/x.md", "lib\\a.ts"), true);
});

test("Unicode spellings compare in NFC and non-ASCII never meets a wildcard regex", () => {
	assert.equal(surfacesOverlap("src/caf\u00e9.ts", "src/cafe\u0301.ts"), true, "NFC vs NFD is one file");
	assert.equal(surfacesOverlap("src/?.ts", "src/\u{1F600}.ts"), true, "an astral character is one path character");
	assert.equal(surfacesOverlap("src/\u{1F600}*.ts", "src/\u{1F600}x.ts"), true);
	assert.equal(surfacesOverlap("src/caf\u00e9.ts", "src/cafe.ts"), false, "distinct literals stay disjoint");
});

// Second verify A1: the registry key is the canonical worktree root, so a
// subdirectory cwd, the root itself and a symlinked spelling share one key.
test("canonicalWriterRoot keys one worktree once and separate worktrees apart", (t) => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "writer-root-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = join(base, "repo");
	mkdirSync(join(repo, "sub"), { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: worktreeGitEnvironment(), stdio: "ignore" });
	git("init", "-q");
	writeFileSync(join(repo, "sub", "a.ts"), "");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
	const feature = join(base, "feature");
	git("worktree", "add", "-q", feature);
	const link = join(base, "link");
	symlinkSync(repo, link);
	assert.equal(canonicalWriterRoot(join(repo, "sub")), repo, "a subdirectory cwd keys to its worktree root");
	assert.equal(canonicalWriterRoot(repo), repo);
	assert.equal(canonicalWriterRoot(join(link, "sub")), repo, "a symlinked spelling keys to the real root");
	assert.equal(canonicalWriterRoot(feature), feature, "a linked worktree keys to itself");
	const registry = new WriterSurfaceRegistry();
	registry.claim("task-a", canonicalWriterRoot(join(repo, "sub")), ["lib/a.ts"]);
	assert.deepEqual(registry.conflicts(canonicalWriterRoot(link), ["lib/a.ts"]).map(conflict => conflict.taskId), ["task-a"]);
	assert.deepEqual(registry.conflicts(canonicalWriterRoot(feature), ["lib/a.ts"]), [], "different worktrees never conflict");
	const plain = join(base, "plain");
	mkdirSync(plain);
	symlinkSync(plain, join(base, "plain-link"));
	assert.equal(canonicalWriterRoot(join(base, "plain-link"), () => undefined), plain, "without Git the key is the realpath");
	assert.equal(canonicalWriterRoot(join(base, "missing"), () => undefined), join(base, "missing"), "an unresolvable path keeps its resolved spelling");
	assert.equal(canonicalWriterRoot("/repo/sub", () => ({ root: "/repo", commonDir: "/repo/.git" })), "/repo", "an injected resolver decides the root");
});

// Like minimatch, `**` is a globstar only as a whole segment; inside a segment
// (`src/**.ts`) it matches within that one segment.
test("`**` inside a segment stays single-segment", () => {
	assert.equal(surfacesOverlap("src/**.ts", "src/a.ts"), true);
	assert.equal(surfacesOverlap("src/**.ts", "src/a/b.ts"), false);
	assert.equal(surfacesOverlap("src/**", "src/a/b.ts"), true);
});

test("overlappingSurfaces lists every overlapping pair; an empty list claims everything", () => {
	assert.deepEqual(overlappingSurfaces(["lib/a.ts", "docs/x.md"], ["lib/**", "tests/a.ts"]), [["lib/a.ts", "lib/**"]]);
	assert.deepEqual(overlappingSurfaces(["lib/a.ts"], ["lib/b.ts", "tests/b.ts"]), []);
	assert.deepEqual(overlappingSurfaces([], ["lib/b.ts"]), [[".", "lib/b.ts"]]);
});

test("the registry reports live overlapping writers in the same root only and releases them", () => {
	const registry = new WriterSurfaceRegistry();
	registry.claim("task-a", "/repo", ["lib/a.ts", "tests/a.test.ts"]);
	registry.claim("task-b", "/repo", ["lib/b.ts"]);
	registry.claim("task-c", "/repo-worktrees/feature", ["lib/a.ts"]);
	assert.deepEqual(registry.conflicts("/repo", ["docs/x.md"]), []);
	assert.deepEqual(registry.conflicts("/repo", ["lib/*.ts"]), [
		{ taskId: "task-a", root: "/repo", pairs: [["lib/*.ts", "lib/a.ts"]] },
		{ taskId: "task-b", root: "/repo", pairs: [["lib/*.ts", "lib/b.ts"]] },
	]);
	assert.deepEqual(registry.conflicts("/elsewhere", ["lib/a.ts"]), [], "different worktree roots never conflict");
	assert.deepEqual(registry.conflicts("/repo/", ["lib/b.ts"]).map(conflict => conflict.taskId), ["task-b"], "roots compare resolved");
	assert.equal(registry.release("task-b"), true);
	assert.equal(registry.release("task-b"), false, "release is idempotent");
	assert.deepEqual(registry.conflicts("/repo", ["lib/b.ts"]), []);
	assert.equal(registry.size, 2);
});

test("the conflict message names the live task, the overlapping entries and the ways forward", () => {
	const message = writerSurfaceConflictMessage([{ taskId: "task-a", root: "/repo", pairs: [["lib/*.ts", "lib/a.ts"]] }]);
	assert.match(message, /task task-a/);
	assert.match(message, /`lib\/\*\.ts` overlaps `lib\/a\.ts`/);
	assert.match(message, /\/repo/);
	assert.match(message, /wait for/i);
	assert.match(message, /narrow `## Allowed edit surfaces`/);
	assert.match(message, /isolated worktree/);
	const many = writerSurfaceConflictMessage([{ taskId: "t", root: "/repo", pairs: Array.from({ length: 8 }, (_, index) => [`a${index}`, `a${index}`] as [string, string]) }]);
	assert.match(many, /and 3 more/, "long overlap lists stay bounded");
});
