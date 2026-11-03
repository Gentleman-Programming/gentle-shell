import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemberWorktree, runGit, type GitExec } from "../lib/fleet-worktree.ts";

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
