import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	SessionManager,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PATH_FENCE_TOOL_NAMES, PathTargetGrants, canonicalizeTarget, evaluatePathFence, resolveOutsidePaths, unclassifiedFenceInputKeys } from "../lib/path-consent-fence.ts";
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

function fileLink(t: test.TestContext, target: string, link: string): boolean {
	try {
		symlinkSync(target, link, "file");
		return true;
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			t.skip("Platform cannot create file symlinks without additional privileges");
			return false;
		}
		throw error;
	}
}

test("dangling outside file alias requires consent before an actual OS write", (t) => {
	const f = fixture(t);
	const destination = join(f.sibling, "new.txt");
	const alias = join(f.root, "dangling");
	if (!fileLink(t, destination, alias)) return;
	assert.equal(evaluatePathFence("write", { path: alias }, f.root, [f.root], "s", grants(), true).kind, "confirm");
	assert.equal(canonicalizeTarget(alias, f.root), destination);
	assert.equal(evaluatePathFence("write", { path: alias }, f.root, [f.root], "s", grants(), false).kind, "headless-block");
	const g = grants();
	g.grant("s", [destination]);
	assert.equal(evaluatePathFence("write", { path: alias }, f.root, [f.root], "s", g, true).kind, "pass");
	writeFileSync(alias, "fixture witness");
	assert.equal(readFileSync(destination, "utf8"), "fixture witness");
});

test("link traversal preserves filesystem parents rather than lexical parents", async (t) => {
	for (const shape of ["existing", "ambiguous", "relative-parent"]) {
		await t.test(shape, (t) => {
			const f = fixture(t);
			const destination = join(f.sibling, "victim.txt");
			const link = shape === "relative-parent" ? join(f.sibling, "nested", "link") : join(f.root, "parent-link");
			if (shape === "existing") writeFileSync(destination, "before");
			const target = shape === "relative-parent" ? "../victim.txt" : "alias/nested/../victim.txt";
			if (!fileLink(t, target, link)) return;
			const path = shape === "relative-parent" ? join(f.root, "alias", "nested", "link") : link;
			const g = grants();
			g.grant("s", [join(f.root, "victim.txt")]);
			if (shape === "ambiguous") {
				assert.throws(() => canonicalizeTarget(path, f.root));
				for (const hasUI of [true, false]) {
					assert.equal(evaluatePathFence("write", { path }, f.root, [f.root], "s", g, hasUI).kind, "headless-block");
				}
				return;
			}
			assert.equal(canonicalizeTarget(path, f.root), destination);
			assert.equal(evaluatePathFence("write", { path }, f.root, [f.root], "s", g, true).kind, "confirm");
			g.grant("s", [destination]);
			assert.equal(evaluatePathFence("write", { path }, f.root, [f.root], "s", g, true).kind, "pass");
			writeFileSync(path, "outside witness");
			assert.equal(readFileSync(destination, "utf8"), "outside witness");
		});
	}
});

test("relative and chained dangling links preserve actual destination authority", (t) => {
	const f = fixture(t);
	if (!fileLink(t, "../sibling/missing.txt", join(f.root, "first"))) return;
	if (!fileLink(t, "first", join(f.root, "second"))) return;
	assert.equal(canonicalizeTarget("second", f.root), join(f.sibling, "missing.txt"));
	assert.deepEqual(resolveOutsidePaths(["second"], f.root, [f.root]), [join(f.sibling, "missing.txt")]);
	assert.deepEqual(resolveOutsidePaths(["second"], f.root, [f.root, f.sibling]), []);
	if (!fileLink(t, "src/missing.txt", join(f.root, "inside"))) return;
	assert.deepEqual(resolveOutsidePaths(["inside"], f.root, [f.root]), []);
});

test("symlink cycles fail closed even with lexical grants", (t) => {
	const f = fixture(t);
	if (!fileLink(t, "loop-b", join(f.root, "loop-a"))) return;
	if (!fileLink(t, "loop-a", join(f.root, "loop-b"))) return;
	assert.throws(() => canonicalizeTarget("loop-a", f.root));
	const g = grants();
	g.grant("s", [join(f.root, "loop-a")]);
	for (const hasUI of [true, false]) {
		assert.equal(evaluatePathFence("write", { path: "loop-a" }, f.root, [f.root], "s", g, hasUI).kind, "headless-block");
	}
});

test("dangling directory junction tails resolve outside and non-directory tails block", (t) => {
	const f = fixture(t);
	const destination = join(f.sibling, "missing-directory");
	symlinkSync(destination, join(f.root, "dangling-directory"), process.platform === "win32" ? "junction" : "dir");
	assert.equal(canonicalizeTarget("dangling-directory/deep/new.txt", f.root), join(destination, "deep", "new.txt"));
	assert.equal(evaluatePathFence("write", { path: "dangling-directory/deep/new.txt" }, f.root, [f.root], "s", grants(), true).kind, "confirm");
	writeFileSync(join(f.root, "plain-file"), "fixture");
	assert.equal(evaluatePathFence("write", { path: "plain-file/child" }, f.root, [f.root], "s", grants(), true).kind, "headless-block");
});

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

test("registeredRootsForSession reads only this session's worktree entries", (t) => {
	const f = fixture(t);
	const session = SessionManager.inMemory(f.root);
	session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: session.getSessionId(), root: f.root, evidence: "tool:read" });
	session.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: "other", root: f.sibling, evidence: "tool:read" });
	session.appendCustomEntry("other-type", {});
	assert.deepEqual(registeredRootsForSession(session, session.getSessionId()), [f.root]);
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

// #1660 secondary: a fenced tool that gains a path-bearing input key must not
// be silently unfenced. Every key of the real Pi schemas is classified.
test("every input key of the fenced tools' real schemas is classified", () => {
	const definitions = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]
		.map((create) => create(process.cwd()));
	assert.deepEqual(definitions.map((definition) => definition.name).sort(), [...PATH_FENCE_TOOL_NAMES].sort(), "every fenced tool has a schema under test");
	for (const definition of definitions) {
		assert.deepEqual(unclassifiedFenceInputKeys(definition.parameters), [], `${definition.name} has no unclassified input key`);
	}
});

test("unclassifiedFenceInputKeys flags new top-level and nested keys", () => {
	const edit = createEditToolDefinition(process.cwd()).parameters as { properties: Record<string, unknown> };
	assert.deepEqual(unclassifiedFenceInputKeys({ ...edit, properties: { ...edit.properties, backupPath: { type: "string" } } }), ["backupPath"]);
	assert.deepEqual(unclassifiedFenceInputKeys({
		type: "object",
		properties: { edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, target: { type: "string" } } } } },
	}), ["target"], "array item properties are walked like collectStringPaths walks input");
	assert.deepEqual(unclassifiedFenceInputKeys({ type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } }), []);
});

test("read-only roots exempt read tools only, never an ancestor, and honor leaf filters", (t) => {
	const f = fixture(t);
	const home = join(f.dir, "home");
	for (const dir of [join(home, "skills", "demo"), join(home, "npm", "node_modules", "pkg"), join(home, "sessions"), join(f.dir, "shared", "deep")]) mkdirSync(dir, { recursive: true });
	const roots = [{ dir: join(home, "skills") }, { dir: join(home, "npm", "node_modules") }, { dir: join(f.dir, "shared"), leaf: /^out-[0-9a-f]+\.log$/ }];
	const decide = (toolName: string, path: string, hasUI = false) => evaluatePathFence(toolName, { path }, f.root, [f.root], "s", grants(), hasUI, roots).kind;
	for (const toolName of ["read", "grep", "find", "ls"]) {
		assert.equal(decide(toolName, join(home, "skills", "demo")), "pass", `${toolName} passes inside a read-only root`);
		assert.equal(decide(toolName, join(home, "skills")), "pass", `${toolName} passes on the root directory itself`);
		assert.equal(decide(toolName, join(home, "npm", "node_modules", "pkg", "a.md")), "pass");
		assert.equal(decide(toolName, home), "headless-block", `${toolName} on the parent of a root stays fenced`);
		assert.equal(decide(toolName, join(home, "npm")), "headless-block", `${toolName} on an ancestor of a root stays fenced`);
	}
	for (const name of ["auth.json", "settings.json", "models.json", "mcp.json", join("sessions", "x")]) assert.equal(decide("read", join(home, name)), "headless-block", `${name} beside the roots stays fenced`);
	for (const toolName of ["write", "edit"]) assert.equal(decide(toolName, join(home, "skills", "demo", "a.txt")), "headless-block", `${toolName} stays fenced inside a read-only root`);
	assert.equal(decide("write", join(home, "skills", "demo", "a.txt"), true), "confirm");
	assert.equal(decide("read", join(f.dir, "shared", "out-ab12.log")), "pass", "a matching direct child passes");
	assert.equal(decide("read", join(f.dir, "shared", "other.log")), "headless-block", "a non-matching child stays fenced");
	assert.equal(decide("read", join(f.dir, "shared", "deep", "out-ab12.log")), "headless-block", "a leaf root never reaches nested directories");
	assert.equal(decide("read", join(home, "skills", "..", "auth.json")), "headless-block", "dot-dot out of a root is judged by its destination");
	assert.equal(evaluatePathFence("read", { path: join(home, "skills", "x") }, f.root, [f.root], "s", grants(), false).kind, "headless-block", "without read-only roots the previous behavior holds");
});
