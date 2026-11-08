import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPostMergeCloseExtension } from "../extensions/post-merge-close.ts";
import {
	CLOSE_CHANGE_USAGE, POST_MERGE_CLOSE_ENTRY, PULL_REQUEST_FIELDS,
	type RemoteBranchInput, type RemoteBranchOps, type RemoteBranchState,
} from "../lib/post-merge-close.ts";
import { SESSION_WORKTREE_ENTRY } from "../lib/session-worktree-registry.ts";

// Safe post-merge change closure (odd/tasks/post-merge-close.md T1): the
// command only associates a merged same-repository pull request with the
// session's own worktrees and previews a future cleanup. Everything here runs
// against private fixtures under the system temp directory, with a fake `gh`
// executable so the public command behavior is pinned without any network.

type Command = { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type Entry = { type: string; customType?: string; data: unknown };

const PATH_FALLBACK = "/usr/local/bin:/usr/bin:/bin";

function fixture(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-close-change-")));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const origin = join(root, "origin");
	const main = join(root, "main");
	for (const path of [home, bin, origin]) mkdirSync(path, { recursive: true });
	writeFileSync(join(home, ".gitconfig"), "[init]\n\tdefaultBranch = main\n");
	const gitEnv = { PATH: PATH_FALLBACK, HOME: home };
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv } as const).trim();

	git(origin, "init", "-q");
	writeFileSync(join(origin, "a.txt"), "a\n");
	git(origin, "add", "a.txt");
	git(origin, "commit", "-q", "-m", "base");
	git(origin, "clone", "-q", origin, main);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// The feature branch holds the pull request head commit H.
	git(main, "switch", "-q", "-c", "feature");
	writeFileSync(join(main, "b.txt"), "feature\n");
	git(main, "add", "b.txt");
	git(main, "commit", "-q", "-m", "feature");
	const headSha = git(main, "rev-parse", "HEAD");
	// A real merge commit M over the base, for the destination fast-forward check.
	git(main, "switch", "-q", "main");
	git(main, "checkout", "-q", "-b", "merge-line", "main");
	writeFileSync(join(main, "m.txt"), "m\n");
	git(main, "add", "m.txt");
	git(main, "commit", "-q", "-m", "merge line");
	const mergeSha = git(main, "rev-parse", "HEAD");
	// The clone root returns to the base branch; worktrees hold the rest.
	git(main, "switch", "-q", "main");
	const clean = join(root, "wt-clean");
	git(main, "worktree", "add", "-q", clean, "feature");
	// Publish the feature branch so the local clone carries its tracking ref
	// without any network; only afterwards does the remote carry the real
	// GitHub URL that the command's remote resolution must match.
	git(main, "push", "-q", "origin", "feature");
	git(main, "fetch", "-q", "origin");
	git(main, "remote", "set-url", "origin", "https://github.com/octocat/widget.git");
	// A second, independent clone of the same repository, for binding checks.
	const clone2 = join(root, "clone2");
	git(origin, "clone", "-q", main, clone2);
	git(clone2, "remote", "set-url", "origin", "https://github.com/octocat/widget.git");

	const ghLog = join(root, "gh-calls.log");
	const ghResponse = join(root, "gh-response.json");
	const setResponse = (view: Record<string, unknown>) => writeFileSync(ghResponse, JSON.stringify(view));
	setResponse(mergedView(headSha, mergeSha));
	// A fake gh that records its arguments and working directory, then answers
	// with the canned response. It is found through the PATH of the environment
	// handed to the extension, exactly as the real command would be.
	writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf 'args: %s\\n' "$*" >> "$GH_CALL_LOG"\nprintf 'cwd: %s\\n' "$(pwd)" >> "$GH_CALL_LOG"\n[ -n "$GH_DELAY" ] && sleep "$GH_DELAY"\ncat "$GH_RESPONSE"\n`);
	chmodSync(join(bin, "gh"), 0o755);
	return {
		root, home, bin, origin, main, clone2, url: "https://github.com/octocat/widget/pull/7", owner: "octocat", repo: "widget",
		number: 7, headBranch: "feature", baseBranch: "main", headSha, mergeSha, clean, ghLog, ghResponse, git, setResponse,
	};
}

function mergedView(headSha: string, mergeSha: string): Record<string, unknown> {
	return {
		state: "MERGED", number: 7, url: "https://github.com/octocat/widget/pull/7",
		headRefName: "feature", headRefOid: headSha, baseRefName: "main",
		mergedAt: "2024-05-01T10:00:00Z", mergeCommit: { oid: mergeSha }, isCrossRepository: false,
	};
}

interface HarnessOptions {
	sessionId?: string; hasUI?: boolean; child?: boolean; confirm?: boolean; cwd?: string;
	registeredWorktrees?: readonly string[];
	/** Injectable fake remote branch operations, so tests never touch a network. */
	remoteBranchOps?: RemoteBranchOps;
}

function harness(t: TestContext, fx: ReturnType<typeof fixture>, options: HarnessOptions = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-close-change-run-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const entries: Entry[] = [];
	const commands = new Map<string, Command>();
	const notes: Array<{ message: string; style?: string }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const sessionId = { id: options.sessionId ?? "session-1" };
	const state = { confirm: options.confirm ?? true, duringConfirm: undefined as undefined | (() => void), confirmQueue: undefined as boolean[] | undefined };
	const env: NodeJS.ProcessEnv = { PATH: `${fx.bin}:${PATH_FALLBACK}`, HOME: fx.home, GH_CALL_LOG: fx.ghLog, GH_RESPONSE: fx.ghResponse, ...(options.child ? { GENTLE_PI_AGENTS_CHILD: "1" } : {}) };
	const sessionManager = {
		getSessionId: () => sessionId.id,
		getEntries: () => entries,
	};
	const pi = {
		on: () => undefined,
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
		appendEntry: (type: string, data: unknown) => { entries.push({ type: "custom", customType: type, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: options.cwd ?? fx.main,
		hasUI: options.hasUI ?? true,
		sessionManager,
		ui: {
			notify: (message: string, style?: string) => { notes.push({ message, style }); },
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				const queued = state.confirmQueue;
				const answer = queued !== undefined && queued.length > 0 ? queued.shift()! : state.confirm;
				state.duringConfirm?.();
				return answer;
			},
		},
	} as unknown as ExtensionContext;
	for (const path of options.registeredWorktrees ?? []) {
		entries.push({ type: "custom", customType: SESSION_WORKTREE_ENTRY, data: { sessionId: sessionId.id, root: path, evidence: "explicit" } });
	}
	createPostMergeCloseExtension({ env, remoteBranchOps: options.remoteBranchOps })(pi);
	const run = async (args: string) => {
		await commands.get("gentle:close-change")!.handler(args, ctx);
		return notes.at(-1)?.message ?? "";
	};
	return { entries, commands, notes, confirms, state, sessionId, env, ctx, sessionManager, run };
}

const ghCalls = (fx: ReturnType<typeof fixture>): string[] => existsSync(fx.ghLog)
	? readFileSync(fx.ghLog, "utf8").split("\n").filter((line) => line.startsWith("args: "))
	: [];
const ghWorktrees = (fx: ReturnType<typeof fixture>): string[] => existsSync(fx.ghLog)
	? readFileSync(fx.ghLog, "utf8").split("\n").filter((line) => line.startsWith("cwd: ")).map((line) => line.slice("cwd: ".length))
	: [];

const closeEntries = (s: { entries: Array<Entry> }): unknown[] => s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).map((entry) => entry.data);
const references = (fx: ReturnType<typeof fixture>): string =>
	`${fx.git(fx.main, "for-each-ref", "--format=%(refname)")}\n${fx.git(fx.main, "worktree", "list", "--porcelain")}\n${fx.git(fx.clean, "status", "--porcelain")}`;
const refState = (fx: ReturnType<typeof fixture>, kind: "heads" | "remotes", name: string): string =>
	fx.git(fx.main, "for-each-ref", `refs/${kind}/${name}`, "--format=%(refname)").trim();
const refsSnapshot = (fx: ReturnType<typeof fixture>): string =>
	`${fx.git(fx.main, "for-each-ref", "--format=%(refname)")}\n${fx.git(fx.main, "worktree", "list", "--porcelain")}`;
const worktreePattern = (fx: ReturnType<typeof fixture>): string => fx.clean.replace(/[\\/.]/g, "\\$&");

/** Fake remote ops that answer from a fixed queue and record every call. */
function fakeRemoteOps(states: readonly RemoteBranchState[]) {
	const reads: RemoteBranchInput[] = [];
	const deletions: RemoteBranchInput[] = [];
	let read = 0, removed = 0;
	const ops: RemoteBranchOps = {
		async readHead(input) {
			reads.push(input);
			const state = states[Math.min(read, states.length - 1)];
			read += 1;
			return state;
		},
		async deleteBranch(input) {
			deletions.push(input);
			removed += 1;
			return { ok: true };
		},
	};
	return { ops, reads, deletions, count: () => ({ read, removed }) };
}

test("help, an empty command and unknown input only print the usage and never read anything", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx);
	for (const args of ["", "help", "wat"]) assert.equal(await s.run(args), CLOSE_CHANGE_USAGE);
	assert.equal(ghCalls(fx).length, 0);
	assert.equal(s.confirms.length, 0);
	assert.equal(s.entries.length, 0);
});

test("untrusted origins fail closed before any read and leave Git untouched", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	const before = references(fx);
	for (const bad of [
		"https://github.com/octocat/widget/pull/7?x=1", "https://github.com/octocat/widget/pull/7#r1",
		"https://user:pass@github.com/octocat/widget/pull/7",
		"https://evil.com/octocat/widget/pull/7", "http://github.com/octocat/widget/pull/7",
		"https://github.com/octocat/widget/pull/abc", "https://github.com/octocat/widget/issues/7",
		"https://github.com/octocat/widget/pull/7/commits", "https://github.com/octocat/../widget/pull/7",
		"https://github.com/octocat/widget/pull/7/", "https://github.com/%2e%2e/widget/pull/7",
		"git@github.com:octocat/widget.git", "github.com/octocat/widget/pull/7",
	]) {
		const message = await s.run(`register ${bad}`);
		assert.match(message, /Not a GitHub pull request URL/, bad);
	}
	assert.equal(ghCalls(fx).length, 0);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 0);
	assert.equal(references(fx), before);
});

test("a declined read permission runs no gh child and confirms exactly once", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], confirm: false });
	const message = await s.run(`register ${fx.url}`);
	assert.match(message, /Read permission declined; nothing was read from GitHub and nothing changed/);
	assert.equal(s.confirms.length, 1);
	assert.match(s.confirms[0].title, /Read GitHub pull request data\?/);
	assert.match(s.confirms[0].message, /octocat\/widget#7/);
	assert.match(s.confirms[0].message, /grants nothing else/);
	assert.equal(ghCalls(fx).length, 0);
	assert.equal(closeEntries(s).length, 0);
});

test("headless sessions fail closed and child sessions get no command", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], hasUI: false });
	assert.match(await s.run(`register ${fx.url}`), /needs an interactive session UI/);
	assert.match(await s.run(`preview ${fx.url}`), /needs an interactive session UI/);
	assert.equal(ghCalls(fx).length, 0);
	const child = harness(t, fx, { child: true });
	assert.equal(child.commands.has("gentle:close-change"), false);
});

test("register pins the pull request and only the session-registered matching worktrees", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	const message = await s.run(`register ${fx.url}`);
	assert.match(message, new RegExp(`Registered octocat/widget#7 for this session \\(head feature at ${fx.headSha}\\)`));
	assert.match(message, new RegExp(`worktree ${fx.clean.replace(/[\\/.]/g, "\\$&")} — local branch feature at ${fx.headSha}`));
	assert.equal(ghCalls(fx).length, 1);
	assert.equal(ghCalls(fx)[0], `args: pr view 7 --repo octocat/widget --json ${PULL_REQUEST_FIELDS}`);
	assert.deepEqual(ghWorktrees(fx), [fx.main]);
	assert.equal(s.confirms.length, 1);
	const record = s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).map((entry) => entry.data)[0] as Record<string, unknown>;
	assert.equal(record.version, 1);
	assert.equal(record.sessionId, "session-1");
	assert.equal(record.commonDir, `${fx.main}/.git`);
	assert.deepEqual(record.pr, { owner: "octocat", repo: "widget", number: 7, url: fx.url });
	assert.equal(record.baseBranch, "main");
	assert.equal(record.headBranch, "feature");
	assert.equal(record.headSha, fx.headSha);
	assert.deepEqual(record.worktrees, [{ path: fx.clean, fingerprint: (record.worktrees as Array<{ fingerprint: string }>)[0].fingerprint }]);
	assert.ok((record.worktrees as Array<{ fingerprint: string }>)[0].fingerprint.length > 0);
});

test("registration is immutable: mismatched re-registrations are refused and exact ones are idempotent", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 1);
	fx.setResponse(mergedView("1".repeat(40), fx.mergeSha));
	assert.match(await s.run(`register ${fx.url}`), /already registered.*different pinned data.*registration never replaces a record/s);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 1);
	fx.setResponse(mergedView(fx.headSha, fx.mergeSha));
	assert.match(await s.run(`register ${fx.url}`), /already registered for this session with the same pinned data/);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 1);
	// A URL with no registration in this session is refused before any read.
	assert.match(await s.run("preview https://github.com/octocat/widget/pull/9"), /No registration for octocat\/widget#9 in this session and clone/);
	assert.equal(ghCalls(fx).length, 3, "two registration attempts re-read the pull request; the unmatched preview never did");
});

test("fork and unverifiable pull requests are rejected explicitly", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	fx.setResponse({ ...mergedView(fx.headSha, fx.mergeSha), isCrossRepository: true });
	assert.match(await s.run(`register ${fx.url}`), /fork/);
	assert.equal(closeEntries(s).length, 0);
	fx.setResponse({ ...mergedView(fx.headSha, fx.mergeSha), isCrossRepository: undefined });
	delete (JSON.parse(readFileSync(fx.ghResponse, "utf8")) as Record<string, unknown>).isCrossRepository;
	assert.match(await s.run(`register ${fx.url}`), /cannot be proven to belong to the target repository/);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 0);
	assert.equal(ghCalls(fx).length, 2, "the authorized reads happened, but nothing was stored");
});

test("worktrees outside the session's registered set are never claimed", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx);
	const before = references(fx);
	assert.match(await s.run(`register ${fx.url}`), /No worktree of this session.*checked out at.*nothing was registered/s);
	assert.equal(s.entries.length, 0);
	assert.equal(references(fx), before);
});

test("restored records are schema-validated and bound to this session and clone", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	assert.equal(ghCalls(fx).length, 1);
	// A different session sees nothing, and foreign entries are ignored.
	s.sessionId.id = "session-2";
	s.entries.push({ type: "custom", customType: POST_MERGE_CLOSE_ENTRY, data: { version: 1, sessionId: "session-2", commonDir: "/elsewhere/.git", pr: { owner: "octocat", repo: "widget", number: 7, url: fx.url }, baseBranch: "main", headBranch: "feature", headSha: fx.headSha, registeredAt: "2024-05-01T10:00:00Z", worktrees: [{ path: fx.clean, fingerprint: "x" }] } });
	assert.match(await s.run("preview"), /No \/gentle:close-change registration for this session and clone yet/);
	assert.equal(ghCalls(fx).length, 1);
	// Back in the owning session, malformed and foreign entries are skipped.
	s.sessionId.id = "session-1";
	s.entries.push({ type: "custom", customType: POST_MERGE_CLOSE_ENTRY, data: { nonsense: true } });
	s.entries.push({ type: "custom", customType: POST_MERGE_CLOSE_ENTRY, data: null });
	assert.match(await s.run(`preview ${fx.url}`), /Post-merge preview for octocat\/widget#7/);
	assert.equal(ghCalls(fx).length, 2);
	// A different clone of the same repository is not this registration's clone.
	const other = harness(t, fx, { cwd: fx.clone2 });
	assert.match(await other.run(`preview ${fx.url}`), /No registration for octocat\/widget#7 in this session and clone/);
	assert.equal(ghCalls(fx).length, 2);
});

test("preview demands a fresh grant and cancels when the session drifts during the prompt", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	assert.equal(ghCalls(fx).length, 1);
	s.state.confirm = false;
	assert.match(await s.run(`preview ${fx.url}`), /Read permission declined/);
	assert.equal(ghCalls(fx).length, 1);
	s.state.confirm = true;
	s.state.duringConfirm = () => { s.sessionId.id = "session-2"; };
	assert.match(await s.run(`preview ${fx.url}`), /changed while the permission prompt was open/);
	assert.equal(ghCalls(fx).length, 1);
	s.sessionId.id = "session-1";
	s.state.duringConfirm = () => { (s.ctx.sessionManager as unknown) = { getSessionId: () => "session-1", getEntries: () => s.entries }; };
	assert.match(await s.run(`preview ${fx.url}`), /changed while the permission prompt was open/);
	assert.equal(ghCalls(fx).length, 1);
	assert.equal(s.confirms.length, 4);
});

test("an unmerged pull request is never registered or previewed, even when approved", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	fx.setResponse({ ...mergedView(fx.headSha, fx.mergeSha), state: "OPEN", mergedAt: null, mergeCommit: null, reviewDecision: "APPROVED" });
	assert.match(await s.run(`register ${fx.url}`), /is OPEN, not merged/);
	assert.match(await s.run(`register ${fx.url}`), /Approvals, checks and comments are not merge evidence/);
	assert.equal(s.entries.filter((entry) => entry.customType === POST_MERGE_CLOSE_ENTRY).length, 0);
});

test("a merged squash pull request previews exact states and pins the registered head commit", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	const message = await s.run(`preview ${fx.url}`);
	assert.match(message, /Post-merge preview for octocat\/widget#7/);
	assert.match(message, /merged at 2024-05-01T10:00:00Z/);
	assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: removable — clean git worktree`));
	assert.match(message, /local branch feature: kept — nothing proves its commit exists anywhere else yet; a cleanup that reads the remote branch may prove it/);
	assert.match(message, /remote branch origin\/feature: unknown — the local tracking ref caches [0-9a-f]{40}, which is stale evidence only/);
	assert.match(message, /destination branch main: kept — a later cleanup may fast-forward it to the merge commit/);
	assert.match(message, /No deletion or update has run/);
	assert.ok(message.includes(fx.headSha) && !message.includes(fx.mergeSha), "the head commit is pinned; the merge commit is only described");
	assert.equal(ghCalls(fx).length, 2);
});

test("a dirty registered worktree is kept, not removable", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	writeFileSync(join(fx.clean, "draft.txt"), "uncommitted\n");
	const message = await s.run(`preview ${fx.url}`);
	assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: kept — has uncommitted changes`));
	assert.match(message, /local branch feature: kept — nothing proves its commit exists anywhere else yet; a cleanup that reads the remote branch may prove it/);
	assert.equal(ghCalls(fx).length, 2);
});

test("a session directory changed during the prompt cancels the read and stores nothing", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	s.state.duringConfirm = () => { s.ctx.cwd = fx.clone2; };
	assert.match(await s.run(`register ${fx.url}`), /changed while the permission prompt was open/);
	assert.equal(ghCalls(fx).length, 0);
	assert.equal(closeEntries(s).length, 0);
});

test("a session directory changed while the pull request is being read discards the answer", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	s.state.duringConfirm = () => {
		s.env.GH_DELAY = "1";
		setTimeout(() => { s.ctx.cwd = fx.clone2; }, 300);
	};
	assert.match(await s.run(`register ${fx.url}`), /changed while the pull request was being read/);
	assert.equal(ghCalls(fx).length, 1, "the read was authorized and ran, but its answer is discarded");
	assert.equal(closeEntries(s).length, 0);
});

test("a preview refuses when the registered worktree is no longer registered to the session", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	const at = s.entries.findIndex((entry) => entry.customType === SESSION_WORKTREE_ENTRY);
	assert.ok(at >= 0);
	s.entries.splice(at, 1);
	const message = await s.run(`preview ${fx.url}`);
	assert.match(message, /whose provenance this session can no longer establish/);
	assert.doesNotMatch(message, /removable/);
	assert.equal(ghCalls(fx).length, 1, "the provenance refusal precedes the remote read");
});

test("a preview refuses when the pull request now names different branches than the registration", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	fx.setResponse({ ...mergedView(fx.headSha, fx.mergeSha), headRefName: "other", baseRefName: "otherbase" });
	const message = await s.run(`preview ${fx.url}`);
	assert.match(message, /head\/base branch names changed since registration/);
	assert.doesNotMatch(message, /removable/);
	assert.equal(ghCalls(fx).length, 2);
});

test("a clean worktree stays kept unless its checked-out branch still sits at the registered head", async (t) => {
	for (const scenario of ["extra commit", "switched branch"] as const) {
		const fx = fixture(t);
		const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
		await s.run(`register ${fx.url}`);
		if (scenario === "extra commit") {
			writeFileSync(join(fx.clean, "later.txt"), "later\n");
			fx.git(fx.clean, "add", "later.txt");
			fx.git(fx.clean, "commit", "-q", "-m", "later work");
		} else {
			fx.git(fx.clean, "switch", "-q", "merge-line");
		}
		const head = fx.git(fx.clean, "rev-parse", "HEAD");
		const status = fx.git(fx.clean, "status", "--porcelain");
		const message = await s.run(`preview ${fx.url}`);
		assert.match(message, new RegExp(`worktree ${fx.clean.replace(/[\\/.]/g, "\\$&")}: kept — its checked-out branch no longer sits at the registered head commit`), scenario);
		assert.doesNotMatch(message, /worktree .*: removable/, scenario);
		assert.equal(fx.git(fx.clean, "rev-parse", "HEAD"), head, "HEAD kept");
		assert.equal(fx.git(fx.clean, "status", "--porcelain"), status, "files kept");
		assert.equal(closeEntries(s).length, 1, "entries kept");
	}
});

test("a locally cached tracking ref never proves the remote branch removable", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	const movedTip = fx.git(fx.main, "rev-parse", "refs/heads/main");
	for (const cached of [fx.headSha, movedTip]) {
		fx.git(fx.main, "update-ref", "refs/remotes/origin/feature", cached);
		const message = await s.run(`preview ${fx.url}`);
		assert.match(message, new RegExp(`remote branch origin/feature: unknown — the local tracking ref caches ${cached}, which is stale evidence only; the remote branch is not provable until a future cleanup performs a fresh authorized read`));
		assert.doesNotMatch(message, /remote branch .*: removable/);
	}
});

test("moved, gone and unprovable resources are reported precisely", async (t) => {
	const fx = fixture(t);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean] });
	await s.run(`register ${fx.url}`);
	// The feature branch gains a commit beyond the registered head.
	writeFileSync(join(fx.clean, "later.txt"), "later\n");
	fx.git(fx.clean, "add", "later.txt");
	fx.git(fx.clean, "commit", "-q", "-m", "later work");
	// The worktree is deleted, the tracking ref disappears, and main moves on.
	rmSync(fx.clean, { recursive: true, force: true });
	fx.git(fx.main, "update-ref", "-d", "refs/remotes/origin/feature");
	fx.git(fx.main, "switch", "-q", "main");
	writeFileSync(join(fx.main, "after.txt"), "after\n");
	fx.git(fx.main, "add", "after.txt");
	fx.git(fx.main, "commit", "-q", "-m", "after");
	const message = await s.run(`preview ${fx.url}`);
	assert.match(message, new RegExp(`worktree ${fx.clean.replace(/[\\/.]/g, "\\$&")}: already gone`));
	assert.match(message, /local branch feature: kept — has commits beyond the registered head commit/);
	assert.match(message, /remote branch origin\/feature: unknown — no local tracking ref is cached; the remote branch is not provable until a future cleanup performs a fresh authorized read/);
	assert.match(message, /destination branch main: kept — has commits the merge commit does not include, so a later cleanup would refuse to update it/);
});

// The confirmed cleanup (T2). Every deletion below runs against the injected
// fake remote ops (never a network) and real disposable Git fixtures, and
// every refusal is checked to leave every ref, worktree and entry as it was.

test("clean removes exactly the proven plan and reports one line per action", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	const registration = closeEntries(s).map((entry) => structuredClone(entry));
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	// One line per planned action, nothing else touched.
	assert.match(message, /Post-merge cleanup for octocat\/widget#7/);
	assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
	assert.match(message, /local branch feature: deleted/);
	assert.match(message, /remote branch origin\/feature: deleted/);
	assert.match(message, new RegExp(`destination branch main: fast-forwarded to ${fx.mergeSha}`));
	assert.match(message, /The registration and the pull request are unchanged\./);
	// One confirmation listed the exact actions before any of them ran.
	assert.equal(s.confirms.length, 4, "register grant, pull request read, remote read, one cleanup confirmation");
	assert.match(s.confirms[3].title, /Run this cleanup\?/);
	assert.match(s.confirms[3].message, /Exactly these actions will run/);
	assert.match(s.confirms[3].message, new RegExp(`remove worktree ${worktreePattern(fx)}`));
	assert.match(s.confirms[3].message, /delete local branch feature/);
	assert.match(s.confirms[3].message, /delete remote branch origin\/feature/);
	assert.match(s.confirms[3].message, new RegExp(`fast-forward main to ${fx.mergeSha}`));
	// Observable effects: worktree directory gone, local branch gone, one remote deletion.
	assert.equal(existsSync(fx.clean), false, "the worktree directory is gone");
	assert.equal(refState(fx, "heads", "feature"), "", "refs/heads/feature is gone");
	assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), fx.mergeSha, "main fast-forwarded to the merge commit");
	assert.equal(ops.deletions.length, 1, "exactly one remote deletion");
	assert.deepEqual({ remote: ops.deletions[0]?.remote, branch: ops.deletions[0]?.branch }, { remote: "origin", branch: "feature" });
	assert.equal(ops.reads.length, 2, "one read for the plan and one recheck immediately before the deletion");
	assert.deepEqual(closeEntries(s), registration, "the registration entry is unchanged");
});

test("a declined cleanup confirmation removes nothing", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	const registration = closeEntries(s).map((entry) => structuredClone(entry));
	const refsBefore = refsSnapshot(fx);
	s.state.confirmQueue = [true, true, false];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /Cleanup declined; nothing was removed and nothing changed\./);
	assert.equal(existsSync(fx.clean), true, "the worktree was not removed");
	assert.equal(refsSnapshot(fx), refsBefore, "every ref and worktree is unchanged");
	assert.equal(ops.deletions.length, 0, "no remote deletion happened");
	assert.equal(ops.reads.length, 1, "only the single granted remote read happened");
	assert.deepEqual(closeEntries(s), registration, "the registration entry is unchanged");
});

test("a moved or reused remote ref keeps the remote and local branches while the clean worktree is still removed", async (t) => {
	for (const answer of [{ state: "moved", sha: "e".repeat(40) }, { state: "at", sha: "d".repeat(40) }] as const) {
		const fx = fixture(t);
		const ops = fakeRemoteOps([answer]);
		const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
		await s.run(`register ${fx.url}`);
		const localBranchBefore = refState(fx, "heads", "feature");
		s.state.confirmQueue = [true, true, true];
		const message = await s.run(`clean ${fx.url}`);
		// The kept states are listed in the confirmation; the removal report stays accurate.
		assert.match(s.confirms[3].message, new RegExp(`remote branch origin\\/feature: kept — the remote branch now points at ${answer.sha}, not the registered head commit`));
		assert.match(s.confirms[3].message, /local branch feature: kept — nothing proves its commit exists anywhere else yet; a cleanup that reads the remote branch may prove it/);
		assert.doesNotMatch(message, /remote branch .*: deleted/);
		assert.doesNotMatch(message, /local branch .*: deleted/);
		assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
		assert.equal(existsSync(fx.clean), false, "the clean worktree is still removed");
		assert.equal(refState(fx, "heads", "feature"), localBranchBefore, "the local branch is kept");
		assert.equal(ops.deletions.length, 0, "the remote branch was never deleted");
		assert.equal(ops.reads.length, 1);
		assert.equal(s.confirms.length, 4);
	}
});

test("an absent remote branch is idempotent: already gone, proven local cleanup still runs, no deletion", async (t) => {
	const fx = fixture(t);
	// The pull request was squash-merged, but the destination already contains
	// the head commit because main was fast-forwarded to it: that alone proves
	// the local branch's commit lives elsewhere.
	fx.git(fx.main, "merge", "--ff-only", "feature");
	const ops = fakeRemoteOps([{ state: "absent" }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(s.confirms[3].message, /remote branch origin\/feature: already gone/);
	assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
	assert.match(message, /local branch feature: deleted/);
	assert.doesNotMatch(message, /remote branch .*: deleted/);
	assert.equal(existsSync(fx.clean), false, "the worktree was removed");
	assert.equal(refState(fx, "heads", "feature"), "", "the local branch, proven by its ancestor destination, is gone");
	assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), fx.headSha, "the destination tip is unchanged");
	assert.equal(ops.deletions.length, 0, "an absent remote branch is never deleted");
	assert.equal(ops.reads.length, 1);
});

test("a dirty worktree is kept with the reason and never removed while the other planned actions still run", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	writeFileSync(join(fx.clean, "draft.txt"), "uncommitted\n");
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(s.confirms[3].message, new RegExp(`worktree ${worktreePattern(fx)}: kept — has uncommitted changes`));
	assert.doesNotMatch(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
	// The branch stays checked out in the retained dirty worktree, so git refuses
	// the planned local deletion and the report says so instead of forcing it.
	assert.match(message, /local branch feature: kept — git refused to delete it/);
	assert.match(message, /remote branch origin\/feature: deleted/);
	assert.match(message, new RegExp(`destination branch main: fast-forwarded to ${fx.mergeSha}`));
	assert.equal(existsSync(fx.clean), true, "the dirty worktree was never removed");
	assert.equal(readFileSync(join(fx.clean, "draft.txt"), "utf8"), "uncommitted\n", "its files are untouched");
	assert.match(refState(fx, "heads", "feature"), /refs\/heads\/feature/, "the local branch that git refused to delete still exists");
	assert.equal(ops.deletions.length, 1);
});

test("the destination is only ever updated by fast-forward, never by a merge, reset or deletion", async (t) => {
	// Fast-forwardable: main holds an ancestor of the merge commit in a clean worktree.
	{
		const fx = fixture(t);
		const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
		const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
		await s.run(`register ${fx.url}`);
		s.state.confirmQueue = [true, true, true];
		const message = await s.run(`clean ${fx.url}`);
		assert.match(message, new RegExp(`destination branch main: fast-forwarded to ${fx.mergeSha}`));
		assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), fx.mergeSha, "main advanced exactly to the merge commit");
	}
	// Not fast-forwardable: main holds commits the merge commit does not include.
	{
		const fx = fixture(t);
		writeFileSync(join(fx.main, "other.txt"), "other\n");
		fx.git(fx.main, "add", "other.txt");
		fx.git(fx.main, "commit", "-q", "-m", "other");
		const mainTip = fx.git(fx.main, "rev-parse", "refs/heads/main");
		const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
		const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
		await s.run(`register ${fx.url}`);
		s.state.confirmQueue = [true, true, true];
		const message = await s.run(`clean ${fx.url}`);
		assert.match(s.confirms[3].message, /destination branch main: kept — has commits the merge commit does not include, so a later cleanup would refuse to update it/);
		assert.doesNotMatch(message, /destination branch .*: fast-forwarded/);
		assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), mainTip, "the destination tip is unchanged");
		assert.match(refState(fx, "heads", "main"), /refs\/heads\/main/, "the destination branch still exists");
	}
});

test("session or repository drift during the cleanup confirmation removes nothing", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	const refsBefore = refsSnapshot(fx);
	let confirmed = 0;
	s.state.duringConfirm = () => { confirmed += 1; if (confirmed === 3) s.ctx.cwd = fx.clone2; };
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /changed while the confirmation was open; nothing was removed\./);
	assert.equal(existsSync(fx.clean), true, "the worktree was not removed");
	assert.equal(refsSnapshot(fx), refsBefore, "every ref and worktree is unchanged");
	assert.equal(ops.deletions.length, 0, "no remote deletion happened");
	assert.equal(ops.reads.length, 1, "only the single granted read ran, before the drift");
});

test("a declined remote-branch read runs no read and performs no deletion", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	const refsBefore = refsSnapshot(fx);
	s.state.confirmQueue = [true, false];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /Remote branch read declined; nothing was read from the remote and nothing changed\./);
	assert.equal(ops.reads.length, 0, "no remote read ran at all");
	assert.equal(ops.deletions.length, 0, "no remote deletion happened");
	assert.equal(refsSnapshot(fx), refsBefore, "every ref and worktree is unchanged");
	assert.equal(existsSync(fx.clean), true, "the worktree was not removed");
});

test("clean in a headless session fails closed without reads or changes", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], hasUI: false, remoteBranchOps: ops.ops });
	const refsBefore = refsSnapshot(fx);
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /needs an interactive session UI/);
	assert.equal(ops.reads.length, 0, "no remote read ran");
	assert.equal(ops.deletions.length, 0, "no remote deletion happened");
	assert.equal(s.confirms.length, 0, "nothing was ever asked");
	assert.equal(existsSync(fx.clean), true, "the worktree was not removed");
	assert.equal(refsSnapshot(fx), refsBefore, "every ref and worktree is unchanged");
});

// Bounded correction batch (S2): ignored content counts as work, the cleanup
// re-proves the branch commit at action time, and nothing is ever pruned.

test("ignored files count as work: a worktree holding only ignored files is kept and they survive", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	// A real ignore mechanism: the clone's common info/exclude governs every
	// worktree, so .env in the worktree is ignored, never untracked.
	writeFileSync(join(fx.main, ".git", "info", "exclude"), ".env\n");
	writeFileSync(join(fx.clean, ".env"), "secret\n");
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(s.confirms[3].message, new RegExp(`worktree ${worktreePattern(fx)}: kept — has ignored files that its removal would delete \\(1 ignored file\\)`));
	assert.doesNotMatch(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
	assert.doesNotMatch(message, new RegExp(`worktree ${worktreePattern(fx)}: `), "no worktree action ran at all");
	assert.equal(existsSync(fx.clean), true, "the worktree was not removed");
	assert.equal(readFileSync(join(fx.clean, ".env"), "utf8"), "secret\n", "the ignored file survives");
});

test("the destination worktree's ignored files block the fast-forward and keep their content", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	writeFileSync(join(fx.main, ".git", "info", "exclude"), ".env\n");
	writeFileSync(join(fx.main, ".env"), "secret\n");
	const mainTip = fx.git(fx.main, "rev-parse", "refs/heads/main");
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /destination branch main: kept — the worktree holding it has ignored files/);
	assert.doesNotMatch(message, /destination branch .*: fast-forwarded/);
	assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), mainTip, "the destination tip is unchanged");
	assert.equal(readFileSync(join(fx.main, ".env"), "utf8"), "secret\n", "the ignored file keeps its content");
});

test("drift inside the action-time remote read deletes nothing and changes no ref", async (t) => {
	const fx = fixture(t);
	const reads: RemoteBranchInput[] = [];
	const deletions: RemoteBranchInput[] = [];
	const box: { drift?: () => void } = {};
	const ops: RemoteBranchOps = {
		async readHead(input) {
			reads.push(input);
			if (reads.length === 2) box.drift?.();
			return { state: "at", sha: fx.headSha };
		},
		async deleteBranch(input) { deletions.push(input); return { ok: true }; },
	};
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops });
	box.drift = () => { s.ctx.cwd = fx.clone2; };
	await s.run(`register ${fx.url}`);
	const refsBefore = fx.git(fx.main, "for-each-ref", "--format=%(refname)");
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /local branch feature: kept — the session or repository changed during the recheck/);
	assert.match(message, /remote branch origin\/feature: kept — the session or repository changed during the recheck/);
	assert.equal(deletions.length, 0, "no remote deletion happened");
	assert.equal(fx.git(fx.main, "for-each-ref", "--format=%(refname)"), refsBefore, "no ref changed");
});

// A deletion that already happened must never be reported as kept: the report
// is the only record the operator has of a completed remote change.
test("a completed remote deletion is reported as deleted even when drift follows it", async (t) => {
	const fx = fixture(t);
	const deletions: RemoteBranchInput[] = [];
	const box: { drift?: () => void } = {};
	const ops: RemoteBranchOps = {
		async readHead() { return { state: "at", sha: fx.headSha }; },
		async deleteBranch(input) { deletions.push(input); box.drift?.(); return { ok: true }; },
	};
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops });
	box.drift = () => { s.ctx.cwd = fx.clone2; };
	await s.run(`register ${fx.url}`);
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.equal(deletions.length, 1, "the authorized deletion ran exactly once");
	assert.match(message, /remote branch origin\/feature: deleted, but the session or repository changed during the recheck/);
	assert.doesNotMatch(message, /remote branch origin\/feature: kept/);
});

test("the local branch is deleted only on action-time proof: a remote branch present in the plan but absent at action time keeps refs/heads/feature", async (t) => {
	const fx = fixture(t);
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }, { state: "absent" }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, /local branch feature: kept — nothing proves its commit exists elsewhere any more/);
	assert.match(message, /remote branch origin\/feature: already gone/);
	assert.equal(refState(fx, "heads", "feature"), "refs/heads/feature", "the local branch is kept");
	assert.equal(ops.deletions.length, 0, "no remote deletion happened");
	assert.equal(ops.reads.length, 2, "one read for the plan and one fresh read taken at action time");
});

test("a clean never prunes: an unrelated removed worktree keeps its admin entry", async (t) => {
	const fx = fixture(t);
	const unrelated = join(fx.root, "wt-unrelated");
	fx.git(fx.main, "worktree", "add", "-q", unrelated, "merge-line");
	rmSync(unrelated, { recursive: true, force: true });
	const ops = fakeRemoteOps([{ state: "at", sha: fx.headSha }]);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	s.state.confirmQueue = [true, true, true];
	const message = await s.run(`clean ${fx.url}`);
	assert.match(message, new RegExp(`worktree ${worktreePattern(fx)}: removed`));
	const listing = fx.git(fx.main, "worktree", "list", "--porcelain");
	assert.match(listing, new RegExp(unrelated.replace(/[\\/.]/g, "\\$&")), "the unrelated worktree's admin entry survives");
});

test("a second clean of an already clean tree reports no fast-forward", async (t) => {
	const fx = fixture(t);
	const states: RemoteBranchState[] = [{ state: "at", sha: fx.headSha }];
	const ops = fakeRemoteOps(states);
	const s = harness(t, fx, { registeredWorktrees: [fx.clean], remoteBranchOps: ops.ops });
	await s.run(`register ${fx.url}`);
	s.state.confirmQueue = [true, true, true];
	const first = await s.run(`clean ${fx.url}`);
	assert.match(first, new RegExp(`destination branch main: fast-forwarded to ${fx.mergeSha}`));
	states[0] = { state: "absent" };
	const second = await s.run(`clean ${fx.url}`);
	assert.doesNotMatch(second, /fast-forwarded/);
	assert.match(second, /Nothing is provable as removable right now, so nothing was removed and nothing changed\./);
	assert.equal(fx.git(fx.main, "rev-parse", "refs/heads/main"), fx.mergeSha, "the destination tip did not move");
});
