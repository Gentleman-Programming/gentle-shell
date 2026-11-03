import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { boundedGit, createMemberWorktree, GIT_TIMEOUT_MS, reattachMemberWorktree, runGit, type GitExec, type GitResult } from "../lib/fleet-worktree.ts";

const test = nodeTest;
const posixTest = process.platform === "win32" ? nodeTest.skip : nodeTest;

// odd/tasks/fleet-orchestrator.md T4 (L15): a member that works in a git
// repository gets its own worktree and branch; anything else runs in place.
// Real git, always in a scratch repository, never the workspace repository.

// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-worktree-")));
let counter = 0;

const GIT_SAFE = ["-c", "user.name=Fleet Test", "-c", "user.email=fleet@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function git(cwd: string, ...args: string[]): string {
	const result = runGit([...GIT_SAFE, ...args], cwd);
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function scratchRepo(root: string, name = "app"): string {
	const repo = join(root, name);
	mkdirSync(join(repo, "packages", "api"), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "initial");
	return repo;
}

function setup() {
	counter += 1;
	const root = join(scratch, `case-${counter}`);
	const repo = scratchRepo(root);
	const calls: string[][] = [];
	const exec: GitExec = (args, cwd) => {
		calls.push(args);
		return runGit(args, cwd);
	};
	return { root, repo, calls, exec };
}

const branches = (repo: string) => git(repo, "branch", "--format=%(refname:short)").split("\n").sort();
const worktrees = (repo: string) => git(repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));

test("a member in a git repository gets fleet/<slug>/<member> at <repo-parent>/<repo>.fleet/<slug>/<member> from HEAD", () => {
	const { root, repo, exec, calls } = setup();
	const head = git(repo, "rev-parse", "HEAD");
	const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec });
	const path = join(root, "app.fleet", "billing", "api");
	assert.deepEqual(result, { kind: "created", worktree: { repo, path, branch: "fleet/billing/api", cwd: path } });
	assert.deepEqual(branches(repo), ["fleet/billing/api", "main"]);
	assert.deepEqual(worktrees(repo), [repo, path]);
	assert.equal(git(path, "rev-parse", "HEAD"), head);
	assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "fleet/billing/api");
	assert.deepEqual(readdirSync(root).sort(), ["app", "app.fleet"], "nothing else is created");
	assert.ok(calls.every(args => !args.includes("remove") && !args.includes("-D") && !args.includes("--force")), JSON.stringify(calls));
});

test("a member started in a tracked subdirectory runs in the same subdirectory of its worktree, else at its root", () => {
	const { root, repo, exec } = setup();
	writeFileSync(join(repo, "packages", "api", "README.md"), "api\n");
	git(repo, "add", "packages/api/README.md");
	git(repo, "commit", "-q", "-m", "api");
	mkdirSync(join(repo, "untracked"));
	const result = createMemberWorktree({ cwd: join(repo, "packages", "api"), fleetSlug: "billing", member: "api", git: exec });
	assert.equal(result.kind, "created");
	if (result.kind !== "created") return;
	assert.equal(result.worktree.path, join(root, "app.fleet", "billing", "api"));
	assert.equal(result.worktree.cwd, join(root, "app.fleet", "billing", "api", "packages", "api"));
	const untracked = createMemberWorktree({ cwd: join(repo, "untracked"), fleetSlug: "billing", member: "web", git: exec });
	assert.equal(untracked.kind === "created" && untracked.worktree.cwd, join(root, "app.fleet", "billing", "web"), "a directory git does not track is not in the worktree");
});

test("an existing branch refuses the worktree and changes nothing", () => {
	const { root, repo, exec } = setup();
	git(repo, "branch", "fleet/billing/api");
	const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec });
	assert.equal(result.kind, "refused");
	if (result.kind !== "refused") return;
	assert.match(result.message, /branch fleet\/billing\/api already exists/);
	assert.match(result.message, /worktree: false|another member name/);
	assert.deepEqual(branches(repo), ["fleet/billing/api", "main"]);
	assert.deepEqual(worktrees(repo), [repo]);
	assert.equal(existsSync(join(root, "app.fleet")), false);
});

test("an existing worktree path refuses the worktree and creates no branch", () => {
	const { root, repo, exec } = setup();
	const path = join(root, "app.fleet", "billing", "api");
	mkdirSync(path, { recursive: true });
	const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec });
	assert.equal(result.kind, "refused");
	if (result.kind !== "refused") return;
	assert.match(result.message, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} already exists`));
	assert.deepEqual(branches(repo), ["main"]);
	assert.deepEqual(worktrees(repo), [repo]);
	assert.deepEqual(readdirSync(path), [], "the existing directory is left as it was");
});

test("a directory outside any git repository runs in place without touching git state", () => {
	const { root, exec, calls } = setup();
	const plain = join(root, "notes");
	mkdirSync(plain);
	assert.deepEqual(createMemberWorktree({ cwd: plain, fleetSlug: "billing", member: "pub", git: exec }), { kind: "outside-git" });
	assert.deepEqual(calls.map(args => args.slice(0, 2)), [["rev-parse", "--show-toplevel"]]);
	assert.deepEqual(readdirSync(plain), []);
	assert.deepEqual(createMemberWorktree({ cwd: join(root, "missing"), fleetSlug: "billing", member: "pub", git: exec }), { kind: "outside-git" }, "a missing directory is not a repository");
});

test("a git failure while adding the worktree is reported as a refusal", () => {
	const { root, exec } = setup();
	const empty = join(root, "empty");
	mkdirSync(empty);
	git(empty, "init", "-q", "-b", "main");
	const result = createMemberWorktree({ cwd: empty, fleetSlug: "billing", member: "api", git: exec });
	assert.equal(result.kind, "refused", "a repository without commits has no HEAD to branch from");
	if (result.kind !== "refused") return;
	assert.match(result.message, /git worktree add failed/);
});

// T6 (S2): a resumed member reattaches to its own worktree; nothing is created or removed.
test("reattaching a member worktree checks it is still a worktree and changes no git state", () => {
	const { root, repo, exec, calls } = setup();
	const created = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec });
	assert.equal(created.kind, "created");
	if (created.kind !== "created") return;
	const before = [branches(repo), worktrees(repo)];
	calls.length = 0;
	assert.equal(reattachMemberWorktree({ path: created.worktree.path, git: exec }), undefined);
	const plain = join(root, "plain");
	mkdirSync(plain);
	assert.match(reattachMemberWorktree({ path: plain, git: exec }) ?? "", /is no longer a git worktree/);
	assert.match(reattachMemberWorktree({ path: join(root, "app.fleet", "billing", "gone"), git: exec }) ?? "", /worktree .*gone is missing/);
	assert.deepEqual([branches(repo), worktrees(repo)], before);
	assert.ok(calls.every(args => args[0] === "rev-parse"), JSON.stringify(calls));
});

// S10 R6: a fleet git call never blocks the controller without a bound; a
// timeout is a typed refusal that names what git may have left behind.
const TIMED_OUT: GitResult = { status: null, stdout: "", stderr: "git timed out after 60 s", timedOut: true };

test("a git call that outlives its bound returns a timed-out result at the bound", () => {
	const { repo } = setup();
	const started = Date.now();
	const result = boundedGit(300)(["-c", "alias.slow=!sleep 3", "slow"], repo);
	assert.ok(Date.now() - started < 2500, "the call returns at its bound, not when git finishes");
	assert.deepEqual(result, { status: null, stdout: "", stderr: "git timed out after 0.3 s", timedOut: true });
	assert.deepEqual(boundedGit(5000)(["rev-parse", "--is-inside-work-tree"], repo), { status: 0, stdout: "true\n", stderr: "" }, "a call within its bound is unchanged");
	assert.equal(GIT_TIMEOUT_MS, 60_000);
});

posixTest("a worktree add that outlives its bound is a refusal naming the branch and path it may have left", () => {
	const { root, repo } = setup();
	const hooks = join(root, "hooks");
	mkdirSync(hooks);
	writeFileSync(join(hooks, "post-checkout"), "#!/bin/sh\nsleep 3\n");
	chmodSync(join(hooks, "post-checkout"), 0o755);
	const slow = boundedGit(300);
	const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: (args, cwd) => slow(["-c", `core.hooksPath=${hooks}`, ...args], cwd) });
	const path = join(root, "app.fleet", "billing", "api");
	assert.deepEqual(result, { kind: "refused", message: `git worktree add timed out after 0.3 s in ${repo}; it may have left branch fleet/billing/api or ${path}: check them before you retry.` });
});

test("a timed-out git call is a refusal, never outside-git, and stops before anything is created", () => {
	const { root, repo } = setup();
	for (const failAt of [0, 1]) {
		const calls: string[][] = [];
		const exec: GitExec = (args, cwd) => {
			calls.push(args);
			return calls.length - 1 === failAt ? TIMED_OUT : runGit(args, cwd);
		};
		const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec });
		assert.equal(result.kind, "refused", `call ${failAt}`);
		assert.match(result.kind === "refused" ? result.message : "", /^git rev-parse timed out after 60 s in /);
		assert.equal(calls.length, failAt + 1, "no later git call runs");
	}
	assert.deepEqual(branches(repo), ["main"]);
	assert.equal(existsSync(join(root, "app.fleet")), false);
	assert.equal(reattachMemberWorktree({ path: repo, git: () => TIMED_OUT }), `git rev-parse timed out after 60 s in ${repo}`);
});

test("beforeAdd runs after every check, right before the add, and its refusal creates nothing", () => {
	const { root, repo, exec } = setup();
	const order: string[] = [];
	const result = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "api", git: exec, beforeAdd: () => { order.push(`before add, branches ${branches(repo).join(",")}`); return undefined; } });
	assert.equal(result.kind, "created");
	assert.deepEqual(order, ["before add, branches main"]);
	const blocked = createMemberWorktree({ cwd: repo, fleetSlug: "billing", member: "web", git: exec, beforeAdd: () => "could not create the session dir" });
	assert.deepEqual(blocked, { kind: "refused", message: "could not create the session dir" });
	assert.deepEqual(branches(repo), ["fleet/billing/api", "main"], "a refusal before the add creates no branch");
	assert.equal(existsSync(join(root, "app.fleet", "billing", "web")), false);
});
