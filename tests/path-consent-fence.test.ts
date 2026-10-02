import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PathTargetGrants, canonicalizeTarget, evaluatePathFence, resolveOutsidePaths } from "../lib/path-consent-fence.ts";
import { registeredRootsForSession, SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";

// All writes belong to unique fixtures, never the live clone.
function fixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "path-fence-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "repo");
	const sibling = join(dir, "sibling");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(sibling, "nested"), { recursive: true });
	symlinkSync(sibling, join(root, "alias"), "dir");
	return { dir, root, sibling };
}

const grants = () => new PathTargetGrants();

test("canonicalizeTarget resolves relatives, ~, symlinks, and missing tails", (t) => {
	const f = fixture(t);
	assert.equal(canonicalizeTarget("src/file.ts", f.root), join(f.root, "src", "file.ts"));
	assert.equal(canonicalizeTarget("~/x", f.root), join(homedir(), "x"));
	assert.equal(canonicalizeTarget(join(f.root, "alias", "nested", "new.ts"), f.root), join(f.sibling, "nested", "new.ts"));
	assert.equal(canonicalizeTarget(join(f.sibling, "a", "b", "c.txt"), f.root), join(f.sibling, "a", "b", "c.txt"));
});

test("resolveOutsidePaths flags escapes, siblings, ~ and symlinks; keeps inside targets", (t) => {
	const f = fixture(t);
	const roots = [f.root];
	assert.deepEqual(resolveOutsidePaths(["src/file.ts", "readme.md"], f.root, roots), []);
	assert.deepEqual(resolveOutsidePaths(["../sibling/plan.md"], f.root, roots), [join(f.sibling, "plan.md")]);
	assert.deepEqual(resolveOutsidePaths([join(f.sibling, "x")], f.root, roots), [join(f.sibling, "x")]);
	assert.deepEqual(resolveOutsidePaths(["~/notes.txt"], f.root, roots), [join(homedir(), "notes.txt")]);
	assert.deepEqual(resolveOutsidePaths([join(f.root, "alias", "deep", "file")], f.root, roots), [join(f.sibling, "deep", "file")]);
	assert.deepEqual(resolveOutsidePaths(["../sibling/x", join(f.sibling, "x")], f.root, roots), [join(f.sibling, "x")], "dedupes alias and direct forms");
	assert.deepEqual(resolveOutsidePaths([join(f.sibling, "missing", "write.txt")], f.root, roots), [join(f.sibling, "missing", "write.txt")]);
});

test("resolveOutsidePaths accepts registered sibling worktree roots as boundary", (t) => {
	const f = fixture(t);
	assert.deepEqual(resolveOutsidePaths([join(f.sibling, "plan.md")], f.root, [f.root, f.sibling]), []);
});

test("PathTargetGrants are session-bound and fail closed across sessions", () => {
	const g = grants();
	g.grant("session-a", ["/outside/one"]);
	assert.deepEqual(g.pending("session-a", ["/outside/one", "/outside/two"]), ["/outside/two"]);
	g.grant("session-b", ["/outside/three"]);
	assert.deepEqual(g.pending("session-b", ["/outside/one"]), ["/outside/one"], "grants never cross sessions");
	assert.deepEqual(g.pending("session-a", ["/outside/one"]), [], "original session grant survives");
});

test("registeredRootsForSession reads only this session's worktree entries", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fence-entries-")));
	rmSync(dir, { recursive: true, force: true });
	const session = SessionManager.inMemory(join(dir, "repo"));
	session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: session.getSessionId(), root: "/wt/a", evidence: "tool:read" });
	session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: "other", root: "/wt/b", evidence: "tool:read" });
	session.appendCustomEntry("other-type", {});
	assert.deepEqual(registeredRootsForSession(session, session.getSessionId()), ["/wt/a"]);
	// Harness fakes may expose getSessionId without durable entries.
	assert.deepEqual(registeredRootsForSession({ getSessionId: () => "s" } as never, "s"), []);
});

test("evaluatePathFence decides pass, confirm, and headless block", (t) => {
	const f = fixture(t);
	const roots = [f.root];
	const g = grants();
	const pass = evaluatePathFence("read", { path: "src/file.ts" }, f.root, roots, "s1", g, true);
	assert.equal(pass.kind, "pass");
	const confirmDecision = evaluatePathFence("edit", { path: "../sibling/plan.md" }, f.root, roots, "s1", g, true);
	assert.equal(confirmDecision.kind, "confirm");
	assert.deepEqual(confirmDecision.targets, [join(f.sibling, "plan.md")]);
	const headless = evaluatePathFence("write", { path: join(f.sibling, "out.txt") }, f.root, roots, "s1", g, false);
	assert.equal(headless.kind, "headless-block");
	assert.match(headless.reason, /outside the session worktree/);
	assert.ok(headless.reason.includes(join(f.sibling, "out.txt")), "headless reason names the absolute target");
	g.grant("s1", [join(f.sibling, "plan.md")]);
	assert.equal(evaluatePathFence("edit", { path: "../sibling/plan.md" }, f.root, roots, "s1", g, true).kind, "pass");
});

test("evaluatePathFence covers the six path tools and defaults grep/find/ls to cwd", (t) => {
	const f = fixture(t);
	const roots = [f.root];
	const g = grants();
	for (const name of ["read", "write", "edit", "grep", "find", "ls"]) {
		assert.equal(evaluatePathFence(name, { path: "../sibling/x" }, f.root, roots, "s1", g, true).kind, "confirm", name);
	}
	assert.equal(evaluatePathFence("grep", { pattern: "x" }, f.root, roots, "s1", g, true).kind, "pass", "default path . stays inside");
	assert.equal(evaluatePathFence("bash", { command: "ls ../.." }, f.root, roots, "s1", g, true).kind, "pass", "bash is slice 3, never fenced here");
	assert.equal(evaluatePathFence("read", { path: "x" }, f.root, [], "s1", g, true).kind, "pass", "no resolvable boundary: fence stays silent, never false-blocks");
});

test("fence passes inside targets and still asks consent for a sensitive outside path", (t) => {
	const f = fixture(t);
	const g = grants();
	assert.equal(evaluatePathFence("read", { path: join(f.root, "src", "ok.ts") }, f.root, [f.root], "s1", g, true).kind, "pass");
	const sensitive = evaluatePathFence("read", { path: "~/.ssh/config" }, f.root, [f.root], "s1", g, true);
	assert.equal(sensitive.kind, "confirm", "a sensitive path outside the boundary never silently passes");
	if (sensitive.kind === "confirm") {
		assert.deepEqual(sensitive.targets, [canonicalizeTarget("~/.ssh/config", f.root)], "the canonical sensitive target is named for consent");
	}
	// The sensitive-path short-circuit and the no-session guard live in
	// extensions/gentle-ai.ts; tests/gentle-ai.test.ts proves each one keeps
	// this fence from firing at the tool_call hook.
});
