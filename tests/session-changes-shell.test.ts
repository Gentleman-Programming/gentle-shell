import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shell, { shellGitRunner } from "../extensions/gentle-shell.ts";
import { SESSION_CHANGE_ENTRY } from "../lib/session-changes.ts";
import { SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";

// /gentle:changes shows the current Git state (working tree vs HEAD, untracked
// included) of the session's repository and of every worktree its subagents
// used. Captured write/edit evidence only names roots; Git names the files.

type Runner = (root: string) => (args: string[]) => Promise<{ stdout: string; code: number }>;
function fixture(entries: any[] = [], options: { root?: string; sessionId?: string; gitRunner?: Runner; pollMs?: number } = {}) {
	const handlers = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
	const commands = new Map<string, any>(), widgets = new Map<string, any>();
	let gitCalls = 0;
	const pi: any = { on: (key, fn) => handlers.set(key, [...(handlers.get(key) ?? []), fn]),
		events: { on: (key, fn) => { listeners.set(key,[...(listeners.get(key) ?? []), fn]); return () => {}; }, emit: (key,data) => listeners.get(key)?.forEach(fn=>fn(data)) },
		appendEntry: (customType,data) => entries.push({type:"custom",customType,data}), registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerCommand: (key, registration) => commands.set(key,registration) };
	const notices: string[] = [], levels: string[] = [];
	const root = options.root ?? "/repo";
	const sessionId = options.sessionId ?? "session";
	const overlay: { view?: any; close?: () => void } = {};
	const ctx: any = { hasUI:true, cwd:root, sessionManager:{getSessionId:()=>sessionId,getEntries:()=>entries},
		ui: { setFooter() {}, getEditorComponent:()=>({}), setWorkingVisible() {}, setWidget:(key,value)=>value===undefined?widgets.delete(key):widgets.set(key,value), notify:(text,level)=>{ notices.push(text); levels.push(level); },
			custom:(factory:any)=>new Promise(resolve=>{ overlay.close=()=>resolve(null); overlay.view=factory({terminal:{rows:40,columns:200},requestRender(){}},{fg:(_c:string,t:string)=>t,bold:(t:string)=>t},{},resolve); }) } };
	shell(pi,{GENTLE_PI_SHELL_CHANGES_POLL_MS:String(options.pollMs ?? 60_000)}, {resolveWorktree:()=>({root,commonDir:root+"/.git"}),devBinary:()=>undefined,
		gitRunner:(cwd)=>async(args)=>{gitCalls++; return options.gitRunner ? options.gitRunner(cwd)(args) : await new Promise<any>(()=>{});} });
	const fire=async(key,event={})=>{for(const fn of handlers.get(key)??[]) await fn(event,ctx);};
	// Opens the panel and closes it again: its groups (root, branch, files)
	// and the rendered group rows.
	const panel=async()=>{
		overlay.view=undefined;
		const opened=commands.get("gentle:changes").handler("",ctx);
		for(let i=0;i<200&&!overlay.view;i++){ if(await Promise.race([opened.then(()=>true),new Promise(r=>setTimeout(()=>r(false),5))])) break; }
		if(!overlay.view) return undefined;
		const text=overlay.view.render(200).join("\n");
		const trees=(overlay.view.children[0].trees as any[]).map(tree=>({root:tree.root as string,branch:tree.branch as string|undefined,files:tree.model.files.map((file:any)=>file.path) as string[],added:tree.model.added as number,deleted:tree.model.deleted as number}));
		overlay.close!(); await opened;
		return {text,trees,files:trees.flatMap(tree=>tree.files)};
	};
	return {pi,ctx,entries,notices,levels,commands,widgets,fire,panel,overlay,gitCalls:()=>gitCalls};
}

function tempRepo(t: { after(fn: () => void): void }, name = "gentle-changes-") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, "file.ts"), "base\n");
	git("add", "file.ts"); git("commit", "-q", "-m", "base");
	return { root, git };
}
const sessionRoot = (root: string, evidence = "session:cwd", sessionId = "session") => ({ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId, root, evidence } });
const captured = (root: string, id: string, path = "file.ts", sessionId = "session") => ({ type: "custom", customType: SESSION_CHANGE_ENTRY,
	data: { sessionId, evidence: { id, root, path, before: { kind: "text", text: "base\n" }, after: { kind: "text", text: "agent\n" } } } });
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
const real: Runner = (cwd) => shellGitRunner(cwd);

test("Gentle Shell startup never waits for a repository scan", async () => {
	const f = fixture([sessionRoot("/repo"), captured("/repo", "a")]);
	await Promise.race([f.fire("session_start"), new Promise((_, reject) => setTimeout(() => reject(new Error("startup blocked by Git inventory")), 100))]);
	assert.equal(f.gitCalls(), 0, "session_start never runs Git");
	assert.equal(f.widgets.has("gentle-shell-changes"), false, "the list fills only after a turn end or panel open");
	await f.fire("session_shutdown");
});

test("the orchestrator repository's dirty file is listed, and leaves once committed", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "human or agent, Git decides\n");
	writeFileSync(join(repo.root, "new.ts"), "one\ntwo\n");
	const f = fixture([], { root: repo.root, gitRunner: real });
	await f.fire("session_start");
	assert.equal(f.gitCalls(), 0);
	await f.fire("agent_end"); await settle();
	assert.equal(f.widgets.has("gentle-shell-changes"), true, "uncaptured working-tree changes are listed");
	const panel = await f.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.files, tree.added, tree.deleted]), [[repo.root, ["file.ts", "new.ts"], 3, 1]], "untracked files count their lines");
	repo.git("add", "-A"); repo.git("commit", "-q", "-m", "work");
	await f.fire("agent_end"); await settle();
	assert.equal(f.widgets.has("gentle-shell-changes"), false, "committed work leaves the widget and the counter");
	assert.equal(await f.panel(), undefined);
	assert.match(f.notices.join("\n"), /No uncommitted changes/);
	await f.fire("session_shutdown");
});

test("a subagent worktree is its own group and disappears once the worktree is removed", async (t) => {
	const repo = tempRepo(t);
	const linked = join(realpathSync(mkdtempSync(join(tmpdir(), "gentle-changes-wt-"))), "linked");
	t.after(() => rmSync(join(linked, ".."), { recursive: true, force: true }));
	repo.git("worktree", "add", "-q", "-b", "agent-branch", linked);
	writeFileSync(join(repo.root, "file.ts"), "orchestrator\n");
	writeFileSync(join(linked, "worker.ts"), "worker\n");
	const f = fixture([sessionRoot(repo.root), sessionRoot(linked, "subagent:spawn")], { root: repo.root, gitRunner: real });
	await f.fire("session_start");
	const panel = await f.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.branch, tree.files]).sort(), [[linked, "agent-branch", ["worker.ts"]], [repo.root, "main", ["file.ts"]]].sort(), "one group per root, each with its own branch");
	assert.match(panel!.text, /agent-branch · linked/);
	repo.git("worktree", "remove", "--force", linked);
	await f.fire("agent_end"); await settle();
	const after = await f.panel();
	assert.deepEqual(after!.trees.map(tree => tree.root), [repo.root], "a removed worktree leaves without error");
	assert.doesNotMatch(f.notices.join("\n"), /Git status failed|Could not read/, "a removed worktree is not a failed scan");
	await f.fire("session_shutdown");
});

test("captured evidence only names a subagent's independent repository; Git names its files", async (t) => {
	const repo = tempRepo(t);
	const foreign = tempRepo(t, "gentle-changes-foreign-");
	writeFileSync(join(foreign.root, "real.ts"), "dirty\n");
	// The captured path is clean in Git, so it is not listed.
	const f = fixture([sessionRoot(repo.root), captured(foreign.root, "child:1", "file.ts")], { root: repo.root, gitRunner: real });
	await f.fire("session_start");
	const panel = await f.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.files]), [[foreign.root, ["real.ts"]]]);
	await f.fire("session_shutdown");
});

test("reload and new sessions read the same state from Git, without stale entries", async (t) => {
	const repo = tempRepo(t);
	const linked = join(realpathSync(mkdtempSync(join(tmpdir(), "gentle-changes-wt-"))), "linked");
	t.after(() => rmSync(join(linked, ".."), { recursive: true, force: true }));
	repo.git("worktree", "add", "-q", linked);
	writeFileSync(join(repo.root, "file.ts"), "agent\n");
	writeFileSync(join(linked, "file.ts"), "worker\n");
	const entries = [sessionRoot(repo.root), sessionRoot(linked, "subagent:spawn"), captured(repo.root, "a"), captured(repo.root, "b", "gone.ts")];
	repo.git("commit", "-q", "-am", "orchestrator work");
	const reloaded = fixture(entries, { root: repo.root, gitRunner: real });
	await reloaded.fire("session_start");
	assert.equal(reloaded.gitCalls(), 0);
	const panel = await reloaded.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.files]), [[linked, ["file.ts"]]], "committed and captured-only files are not listed after reload");
	await reloaded.fire("session_shutdown");
	const next = fixture([...entries], { root: repo.root, sessionId: "new-session", gitRunner: real });
	await next.fire("session_start");
	assert.equal(await next.panel(), undefined, "another session's worktrees are not inherited");
	assert.match(next.notices.join("\n"), /No uncommitted changes/);
	await next.fire("session_shutdown");
});

test("a failing Git root is omitted while the other roots stay listed", async (t) => {
	const repo = tempRepo(t);
	const broken = tempRepo(t, "gentle-changes-broken-");
	writeFileSync(join(repo.root, "file.ts"), "agent\n");
	writeFileSync(join(broken.root, "file.ts"), "agent\n");
	const failing: Runner = (cwd) => cwd === broken.root ? async () => { throw new Error("git timed out"); } : shellGitRunner(cwd);
	const f = fixture([sessionRoot(repo.root), sessionRoot(broken.root, "explicit")], { root: repo.root, gitRunner: failing });
	await f.fire("session_start");
	await f.fire("agent_end"); await settle();
	const panel = await f.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.files]), [[repo.root, ["file.ts"]]]);
	assert.match(f.notices.join("\n"), /Git status failed for 1 root\b/, "the panel reports the failed root");
	await f.fire("session_shutdown");
});

// A root whose `git status` exits nonzero is a failed scan, never a clean
// root: when it is the only root the panel must not claim a clean tree.
const statusFailsAt = (broken: string): Runner => (cwd) => cwd === broken ? async (args) => args[0] === "status" ? { stdout: "", code: 128 } : shellGitRunner(cwd)(args) : shellGitRunner(cwd);

test("when every scanned root fails, Changes reports an error instead of a clean tree", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "agent\n");
	const f = fixture([sessionRoot(repo.root)], { root: repo.root, gitRunner: statusFailsAt(repo.root) });
	await f.fire("session_start");
	assert.equal(await f.panel(), undefined);
	assert.doesNotMatch(f.notices.join("\n"), /No uncommitted changes/);
	assert.match(f.notices.join("\n"), /Could not read Git status for 1 root\b/);
	assert.equal(f.levels.at(-1), "error");
	await f.fire("session_shutdown");
});

test("a clean root next to a failed one reports the failure count, not a plain clean tree", async (t) => {
	const repo = tempRepo(t);
	const broken = tempRepo(t, "gentle-changes-broken-");
	const f = fixture([sessionRoot(repo.root), sessionRoot(broken.root, "explicit")], { root: repo.root, gitRunner: statusFailsAt(broken.root) });
	await f.fire("session_start");
	assert.equal(await f.panel(), undefined);
	assert.match(f.notices.join("\n"), /Git status failed for 1 of 2 roots/);
	assert.equal(f.levels.at(-1), "warning");
	await f.fire("session_shutdown");
});

test("a dirty root next to a failed one opens the panel and reports the failure count", async (t) => {
	const repo = tempRepo(t);
	const broken = tempRepo(t, "gentle-changes-broken-");
	writeFileSync(join(repo.root, "file.ts"), "agent\n");
	writeFileSync(join(broken.root, "file.ts"), "agent\n");
	const f = fixture([sessionRoot(repo.root), sessionRoot(broken.root, "explicit")], { root: repo.root, gitRunner: statusFailsAt(broken.root) });
	await f.fire("session_start");
	const panel = await f.panel();
	assert.deepEqual(panel!.trees.map(tree => [tree.root, tree.files]), [[repo.root, ["file.ts"]]]);
	assert.match(f.notices.join("\n"), /Git status failed for 1 root\b/);
	await f.fire("session_shutdown");
});

test("every changed file is listed without a capture limit", async (t) => {
	const repo = tempRepo(t);
	mkdirSync(join(repo.root, "many"));
	for (let i = 0; i < 300; i++) writeFileSync(join(repo.root, "many", `${i}.ts`), "x\n");
	const f = fixture([], { root: repo.root, gitRunner: real });
	await f.fire("session_start");
	const panel = await f.panel();
	assert.equal(panel!.files.length, 300);
	assert.equal(panel!.trees[0].added, 300);
	assert.equal(f.widgets.has("gentle-shell-changes"), true);
	assert.doesNotMatch(panel!.text, /limit/);
	assert.doesNotMatch(f.notices.join("\n"), /limit/);
	await f.fire("session_shutdown");
});

test("the open panel diffs the selected file against HEAD and reloads a same-count edit", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "first\n");
	writeFileSync(join(repo.root, "new.ts"), "hello\n");
	const f = fixture([], { root: repo.root, gitRunner: real, pollMs: 20 });
	await f.fire("session_start");
	const opened = f.commands.get("gentle:changes").handler("", f.ctx);
	for (let i = 0; i < 200 && !f.overlay.view; i++) await new Promise(resolve => setTimeout(resolve, 5));
	const view = f.overlay.view;
	const shows = async (pattern: RegExp) => {
		for (let i = 0; i < 100 && !pattern.test(view.render(200).join("\n")); i++) await new Promise(resolve => setTimeout(resolve, 10));
		return view.render(200).join("\n");
	};
	try {
		view.handleInput("\r");
		view.handleInput("j");
		assert.match(await shows(/\+first/), /-base/, "tracked files diff against HEAD");
		view.handleInput("j");
		assert.match(await shows(/\+hello/), /\+hello/, "untracked files show their full content");
		view.handleInput("k");
		await new Promise(resolve => setTimeout(resolve, 20));
		writeFileSync(join(repo.root, "file.ts"), "secnd\n");
		assert.match(await shows(/\+secnd/), /\+secnd/, "the poll reloads a same-count edit");
	} finally { f.overlay.close!(); await opened; await f.fire("session_shutdown"); }
});

// A repository rooted at HOME (or a broad user folder) makes `git status` scan
// the user's whole tree: Changes never scans such a root, at turn end or in
// the panel, matching the startup warning that tells the user to move.
test("a repository rooted at HOME is never scanned by Changes", async (t) => {
	const repo = tempRepo(t, "gentle-changes-home-");
	writeFileSync(join(repo.root, "file.ts"), "dirty at home\n");
	const previousHome = process.env.HOME;
	process.env.HOME = repo.root;
	t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
	const f = fixture([sessionRoot(repo.root)], { root: repo.root, gitRunner: real });
	await f.fire("session_start");
	await f.fire("agent_end"); await settle();
	assert.equal(f.gitCalls(), 0, "no Git runs against a home-rooted repository");
	assert.equal(f.widgets.has("gentle-shell-changes"), false);
	assert.equal(await f.panel(), undefined);
	assert.equal(f.gitCalls(), 0);
	assert.doesNotMatch(f.notices.join("\n"), /Git status failed|Could not read/, "a filtered home root is not a failed scan");
	await f.fire("session_shutdown");
});
