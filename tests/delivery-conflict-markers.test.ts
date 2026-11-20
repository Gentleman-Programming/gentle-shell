import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// Markers are assembled at runtime so no line of this file starts with one.
const OPEN = "<".repeat(7), MID = "=".repeat(7), CLOSE = ">".repeat(7);
const CONFLICT = ["base", `${OPEN} ours`, "left", MID, "right", `${CLOSE} theirs`, ""].join("\n");

function fixture(t: { after(fn: () => void): void }) {
	const scratch = mkdtempSync(join(tmpdir(), "conflict-markers-"));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const previousConfig = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
	mkdirSync(process.env.GENTLE_PI_CONFIG_HOME);
	t.after(() => { if (previousConfig === undefined) delete process.env.GENTLE_PI_CONFIG_HOME; else process.env.GENTLE_PI_CONFIG_HOME = previousConfig; });
	const repo = (name: string) => {
		const root = join(scratch, name);
		mkdirSync(root);
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		git("init", "-q", "-b", "main");
		writeFileSync(join(root, "app.txt"), "base\n");
		git("add", "."); git("commit", "-qm", "base");
		return { root, git, write: (path: string, content: string | Buffer) => writeFileSync(join(root, path), content) };
	};
	return { scratch, repo };
}

type Mode = "on" | "off" | "unknown";
function hook(cwd: string, options: { mode?: Mode; child?: boolean } = {}) {
	const handlers = new Map<string, Function>();
	const cli = options.mode === "unknown" ? null : {
		reviewMode: async () => ({ status: { effective: options.mode ?? "off", global: options.mode ?? "off", cloneLocal: "", source: "global" } }),
		assess: async () => { throw new Error("no assessment in this fixture"); },
	};
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit() {} }, registerCommand() {}, registerTool() {} };
	createGentleAiExtension({ nativeReviewCli: cli as never, processEnv: { GENTLE_AI_TELEMETRY: "0", ...(options.child ? { GENTLE_PI_AGENTS_CHILD: "1" } : {}) } })(pi as never);
	const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "markers", getCwd: () => cwd, getBranch: () => [], getEntries: () => [] }, ui: { notify() {}, confirm: async () => true } };
	return async (command: string) => (await handlers.get("tool_call")!({ toolName: "bash", toolCallId: command, input: { command } }, ctx)) as { block?: boolean; reason?: string } | undefined;
}

test("P9: a staged conflict triple denies the commit with path:line, in every RDD mode", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("conflict.txt", CONFLICT); git("add", "conflict.txt");
	for (const mode of ["off", "on", "unknown"] as const) {
		const result = await hook(root, { mode })("git commit -m resolve");
		assert.equal(result?.block, true, mode);
		assert.match(result!.reason!, /^Conflict markers: this commit would add unresolved conflict markers .* at conflict\.txt:2\. This command was not run\. Resolve the markers and stage the result, then retry\. A file that holds markers on purpose is exempted by a `conflict-marker-size` attribute in `\.gitattributes`\.$/, mode);
	}
	const heredoc = await hook(root)("git commit -F - <<'EOF'\nresolve\nEOF");
	assert.equal(heredoc?.block, true, "a heredoc message does not hide the commit");
	assert.equal((await hook(root)("git merge --continue"))?.block, true, "a merge continuation records the index");
});

test("P9: worktree-only markers pass a plain commit and deny commit -a", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("app.txt", CONFLICT);
	const run = hook(root);
	assert.equal(await run("git commit -m nothing-staged"), undefined);
	for (const command of ["git commit -am resolve", "git commit -a -m resolve", "git commit --all -m resolve"]) {
		const result = await run(command);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason!, /app\.txt:2/, command);
	}
	git("add", "app.txt");
	assert.equal((await run("git commit -m staged"))?.block, true);
});

test("P9: a lone ======= underline, a binary file and an incomplete set are not conflicts", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("README.md", `Title\n${MID}\n\nBody\n`);
	write("blob.bin", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${CONFLICT}`)]));
	write("half.txt", `${MID}\n${CLOSE} theirs\n`);
	git("add", ".");
	assert.equal(await hook(root)("git commit -m docs"), undefined);
});

test("P9: only added lines count, and conflict-marker-size is the on-purpose escape", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("fixture.txt", CONFLICT); git("add", "fixture.txt"); git("commit", "-qm", "pre-existing"); // recorded before this commit
	write("fixture.txt", `${CONFLICT}tail\n`); git("add", "fixture.txt");
	assert.equal(await hook(root)("git commit -m 'edit around existing markers'"), undefined, "markers already recorded are not added by this commit");
	write("docs-conflict.md", `# Example\n\n${CONFLICT}`); git("add", ".");
	assert.match((await hook(root)("git commit -m 'document a conflict'"))?.reason ?? "", /docs-conflict\.md:4/, "without the attribute the example is a conflict");
	write(".gitattributes", "docs-conflict.md conflict-marker-size=32\n"); git("add", ".");
	assert.equal(await hook(root)("git commit -m 'document a conflict'"), undefined, "the attribute changes the marker size for that file");
});

test("P9: guard errors fail open and the directory forms check the right repository", async t => {
	const { scratch, repo } = fixture(t);
	const plain = join(scratch, "plain");
	mkdirSync(plain);
	assert.equal(await hook(plain)("git commit -m x"), undefined, "not a repository: the guard says nothing");
	const dirty = repo("dirty"), clean = repo("clean");
	dirty.write("conflict.txt", CONFLICT); dirty.git("add", ".");
	const fromPlain = hook(plain);
	for (const command of [`git -C ${dirty.root} commit -m x`, `cd ${dirty.root} && git commit -m x`, `cd ${dirty.root} && git add . && git commit -m x`]) {
		const result = await fromPlain(command);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason!, /conflict\.txt:2/, command);
	}
	const fromDirty = hook(dirty.root);
	assert.equal(await fromDirty(`git -C ${clean.root} commit -m x`), undefined, "-C selects the clean repository");
	assert.equal(await fromDirty(`cd ${clean.root} && git commit -m x`), undefined, "cd selects the clean repository");
	assert.equal(await hook(dirty.root, { child: true })("git commit -m x"), undefined, "subagent sessions keep today's behavior");
});

// Verifier blocker 1: Git appends a TAB to `+++ b/<path>` when the path has spaces and C-quotes special names.
test("P9: paths with spaces, quotes and non-ASCII are read exactly, so the attribute escape works", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	mkdirSync(join(root, "tests"));
	write("tests/a b.fixture", CONFLICT); git("add", ".");
	const denied = await hook(root)("git commit -m x");
	assert.equal(denied?.block, true);
	assert.match(denied!.reason!, / at tests\/a b\.fixture:2\. /, "a clean path:line");
	write(".gitattributes", "*.fixture conflict-marker-size=32\n"); git("add", ".");
	assert.equal(await hook(root)("git commit -m x"), undefined, "the attribute applies to a path with a space");
	for (const name of ["tests/café.txt", "tests/say \"hi\".txt"]) {
		write(name, CONFLICT); git("add", "--", name);
		const result = await hook(root)("git commit -m x");
		assert.equal(result?.block, true, name);
		assert.ok(result!.reason!.includes(` at ${name}:2. `), result!.reason!);
		git("rm", "-q", "--cached", "--", name);
	}
});

// Verifier blocker 2: staging in the same command runs after the hook, so predict what it would add.
test("P9: git add before git commit in the same command is checked", async t => {
	const { repo } = fixture(t);
	const { root, write } = repo("repo");
	write("app.txt", CONFLICT);
	const run = hook(root);
	for (const command of ["git add app.txt && git commit -m y", "git add -A && git commit -m fix", "git add .; git commit -m y", "git add --all\ngit commit -m y", "git stage app.txt && git commit -m y", `git -C ${root} add -u && git -C ${root} commit -m y`, `cd ${root} && git add app.txt && git commit -m y`]) {
		const result = await run(command);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason!, / at app\.txt:2\. /, command);
	}
	write("clean.txt", "fine\n");
	assert.equal(await run("git add clean.txt && git commit -m y"), undefined, "another unstaged file with markers is not added");
	assert.equal(await run("git add -p && git commit -m y"), undefined, "an interactive add cannot be predicted: fail open");
});

test("P9: git add of an untracked file with markers is denied; add -u ignores untracked files", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("new.txt", CONFLICT);
	const run = hook(root);
	assert.match((await run("git add new.txt && git commit -m y"))?.reason ?? "", / at new\.txt:2\. /);
	assert.match((await run("git add -A && git commit -m y"))?.reason ?? "", / at new\.txt:2\. /);
	assert.equal(await run("git add -u && git commit -m y"), undefined);
	write(".gitignore", "new.txt\n"); git("add", ".gitignore"); git("commit", "-qm", "ignore");
	assert.equal(await run("git add -A && git commit -m y"), undefined, "ignored files are not added");
	// A staged version with markers that the named add replaces with clean content is not counted.
	write("app.txt", CONFLICT); git("add", "app.txt"); write("app.txt", "base\nfixed\n");
	assert.equal(await run("git add app.txt && git commit -m y"), undefined);
});

test("P9: builtin cd and command cd select the directory, never the session cwd", async t => {
	const { scratch, repo } = fixture(t);
	const dirty = repo("dirty"), clean = repo("clean");
	dirty.write("conflict.txt", CONFLICT); dirty.git("add", ".");
	const fromDirty = hook(dirty.root);
	assert.equal(await fromDirty(`builtin cd ${clean.root} && git commit -m x`), undefined);
	assert.equal(await fromDirty(`command cd ${clean.root} && git commit -m x`), undefined);
	assert.equal(await fromDirty(`command -p cd ${clean.root} && git commit -m x`), undefined);
	assert.equal((await hook(scratch)(`builtin cd ${dirty.root} && git commit -m x`))?.block, true);
});

// Verifier advisory: content that came whole from the merged branch is not this commit's addition.
test("P9: concluding a merge counts only markers added against both parents", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	git("switch", "-q", "-c", "other");
	write("example.md", `# Example\n\n${CONFLICT}`); write("app.txt", "theirs\n"); git("add", "."); git("commit", "-qm", "intentional example");
	git("switch", "-q", "main");
	write("app.txt", "ours\n"); git("commit", "-qam", "ours");
	try { git("merge", "-q", "other"); } catch { /* conflict on app.txt */ }
	write("app.txt", "resolved\n"); git("add", "app.txt");
	const run = hook(root);
	assert.equal(await run("git commit -m merge"), undefined, "a clean resolution of a merge that brings an intentional example");
	assert.equal(await run("git merge --continue"), undefined);
	write("app.txt", CONFLICT); git("add", "app.txt");
	const unresolved = await run("git commit -m merge");
	assert.equal(unresolved?.block, true);
	assert.match(unresolved!.reason!, / at app\.txt:2\. /);
	assert.doesNotMatch(unresolved!.reason!, /example\.md/);
	assert.equal((await run("git merge --continue"))?.block, true);
});

// The same both-sides rule with REBASE_HEAD: a picked commit that brings an intentional marker file is not
// this commit's addition; unresolved markers in the stopped file are.
test("P9: continuing a rebase counts only markers added against HEAD and the picked commit", async t => {
	const { repo } = fixture(t);
	const { root, git, write } = repo("repo");
	git("switch", "-q", "-c", "side");
	write("fx.txt", CONFLICT); write("app.txt", "side\n"); git("add", "."); git("commit", "-qm", "side with fixture");
	git("switch", "-q", "main");
	write("app.txt", "main\n"); git("commit", "-qam", "main change");
	git("switch", "-q", "side");
	try { git("rebase", "main"); } catch { /* stops on the app.txt conflict */ }
	git("rev-parse", "-q", "--verify", "REBASE_HEAD");
	const run = hook(root);
	write("app.txt", "resolved\n"); git("add", "app.txt");
	assert.equal(await run("git rebase --continue"), undefined, "case A: the fixture came whole from the picked commit");
	write("app.txt", CONFLICT); git("add", "app.txt");
	const unresolved = await run("git rebase --continue");
	assert.equal(unresolved?.block, true, "case B: unresolved markers are denied");
	assert.match(unresolved!.reason!, / at app\.txt:2\. /);
	assert.doesNotMatch(unresolved!.reason!, /fx\.txt/);
});

test("P9: pushes are not checked", async t => {
	const { scratch, repo } = fixture(t);
	const remote = join(scratch, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", remote]);
	const { root, git, write } = repo("repo");
	git("remote", "add", "origin", remote); git("push", "-q", "-u", "origin", "main");
	write("conflict.txt", CONFLICT); git("add", "."); git("commit", "-qm", "bad resolution");
	for (const command of ["git push", "git push origin main", "git push origin HEAD", "git push -u origin main"]) assert.equal(await hook(root)(command), undefined, command);
});

test("P9 preservation: a clean commit passes and RDD preflight denials keep their text and precedence", async t => {
	const { scratch, repo } = fixture(t);
	const { root, git, write } = repo("repo");
	write("app.txt", "changed\n"); git("add", ".");
	assert.equal(await hook(root)("git commit -m clean"), undefined);
	const remote = join(scratch, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", remote]);
	git("remote", "add", "origin", remote); git("commit", "-qm", "clean"); git("push", "-q", "-u", "origin", "main");
	write("conflict.txt", CONFLICT); git("add", "."); git("commit", "-qm", "markers");
	const result = await hook(root, { mode: "on" })("git push origin HEAD");
	assert.equal(result?.block, true);
	assert.match(result!.reason!, /^RDD pre-delivery: Select the actual committed range/, "the RDD denial runs first and is unchanged");
	assert.equal(await hook(root, { mode: "off" })("git status && echo 'git commit'"), undefined, "non-delivery commands are untouched");
});

// PR #3113 review: a redirection's `&` is not a command separator, so a preceding `cd` keeps its directory.
test("P9: redirections such as 2>&1 keep the cd and -C targets", async t => {
	const { scratch, repo } = fixture(t);
	const plain = join(scratch, "plain");
	mkdirSync(plain);
	const dirty = repo("dirty"), clean = repo("clean");
	dirty.write("conflict.txt", CONFLICT); dirty.git("add", ".");
	const run = hook(plain);
	const forms = (root: string) => [`cd ${root} && git commit -m x 2>&1`, `git -C ${root} commit -am x > /dev/null 2>&1`,
		`cd ${root} && git commit -m x >&2`, `cd ${root} && git commit -m x &>${join(scratch, "out.log")}`, `cd ${root} && git commit -m x 2>/dev/null </dev/null`];
	for (const command of forms(dirty.root)) {
		const result = await run(command);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason!, / at conflict\.txt:2\. /, command);
	}
	for (const command of forms(clean.root)) assert.equal(await run(command), undefined, command);
	assert.equal(await run(`cd ${dirty.root} && git commit -m x &`), undefined, "a trailing background & still ends the cd scope");
});

// PR #3113 review: a backslash-newline continues the command, so flags and paths on the next line belong to it.
test("P9: line continuations keep -a and git add paths with their command", async t => {
	const { repo } = fixture(t);
	const { root, write } = repo("repo");
	write("app.txt", CONFLICT);
	const run = hook(root);
	for (const command of ["git commit \\\n-a -m x", "git commit -m \"fix \\\n\" -a", "git add \\\napp.txt && git commit -m x", "git add app.txt \\\n&& git commit -m x"]) {
		const result = await run(command);
		assert.equal(result?.block, true, JSON.stringify(command));
		assert.match(result!.reason!, / at app\.txt:2\. /, JSON.stringify(command));
	}
	assert.equal(await run("git commit -m 'a \\\n' -m y"), undefined, "inside single quotes the backslash is literal and the commit records only the index");
});

// PR #3113 review (security): no asynchronous work may run between the permission-mode epoch recheck and the
// hook's return; a mode change while the marker check is pending must not yield a stale allow.
test("P9: a permission-mode change while the marker check runs blocks instead of allowing", async t => {
	const { repo, scratch } = fixture(t);
	const { root } = repo("repo");
	const manager = SessionManager.inMemory(root);
	manager.appendCustomEntry("probe-anchor", {});
	const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
	const pi = { on: (name: string, fn: Function) => handlers.set(name, [...handlers.get(name) ?? [], fn]), events: { on() { return () => {}; }, emit() {} },
		registerCommand: (name: string, value: unknown) => commands.set(name, value), registerTool() {}, registerFlag() {}, registerMessageRenderer() {},
		getActiveTools: () => [], appendEntry() {} };
	createGentleAiExtension({ nativeReviewCli: { reviewMode: async () => ({ status: { effective: "off", global: "off", cloneLocal: "", source: "global" } }), assess: async () => { throw new Error("none"); } } as never,
		processEnv: { GENTLE_AI_TELEMETRY: "0", GENTLE_PI_CONFIG_HOME: join(scratch, "config") }, candidateViews: null,
		resolveTelemetryTriggerBinary: () => { throw new Error("disabled"); } } as never)(pi as never);
	const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: manager, signal: new AbortController().signal,
		ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async () => true } };
	const call = async (command: string) => {
		let output: any;
		for (const fn of handlers.get("tool_call") ?? []) { const next = await fn({ toolName: "bash", toolCallId: "probe", input: { command } }, ctx); if (next !== undefined) output = next; }
		return output as { block?: boolean; reason?: string } | undefined;
	};
	await commands.get("gentle:mode").handler("yolo", ctx);
	assert.equal(await call("git commit -m clean"), undefined, "stable mode: a clean commit is allowed");
	// Hold the marker check's first diff (its candidate pathspec is unique to the guard) and change the mode meanwhile.
	const original = childProcess.execFile;
	let held!: () => void, release!: () => void, holding = true;
	const reached = new Promise<void>(resolve => { held = resolve; });
	t.mock.method(childProcess, "execFile", (...args: any[]) => {
		if (holding && Array.isArray(args[1]) && args[1].includes("-G^[<>][<>]")) {
			holding = false; held();
			void new Promise<void>(resolve => { release = resolve; }).then(() => (original as Function)(...args));
			return undefined;
		}
		return (original as Function)(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const pending = call("git commit -m clean");
	await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error("marker check never reached")), 3000))]);
	await commands.get("gentle:mode").handler("normal", ctx);
	release();
	const result = await pending;
	assert.equal(result?.block, true, "a decision made under the earlier mode must not be returned");
	assert.match(result!.reason!, /^Permission mode changed during delivery preflight\. This action was not run; retry under the current mode\.$/);
});

// PR #3113 review: only an UNQUOTED operator is a redirection; a quoted argument that starts with `<` or `>` is a word.
test("P9: quoted words that start with < or > are arguments, not redirections", async t => {
	const { scratch, repo } = fixture(t);
	const { root, write } = repo("repo");
	write("app.txt", CONFLICT);
	const run = hook(root);
	for (const command of [`git commit -m "<type>: msg" -a`, `git commit -a -m ">= 2 fixes"`, `git commit -m 'x > y' -a`, `git commit -m ">" -a`, `git commit -m \\> -a`]) {
		const result = await run(command);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason!, / at app\.txt:2\. /, command);
	}
	const named = repo("named");
	named.write("<name>.txt", CONFLICT);
	const added = await hook(named.root)(`git add "<name>.txt" && git commit -m x`);
	assert.equal(added?.block, true, "a quoted path that starts with < is staged");
	assert.match(added!.reason!, / at <name>\.txt:2\. /);
	const target = join(scratch, "out file.txt");
	const redirected = await run(`git commit -m x > "${target}" -a`);
	assert.equal(redirected?.block, true, "the quoted word is the target of the unquoted operator");
	assert.match(redirected!.reason!, / at app\.txt:2\. /);
	assert.equal(await run(`git commit -m x > "${target}"`), undefined, "an unquoted operator still takes its quoted target");
});
