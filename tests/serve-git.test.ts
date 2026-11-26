import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServeAuth } from "../lib/serve-auth.ts";
import { classifyGitArgs } from "../lib/serve-git.ts";
import { startServeServer, type ServeServer } from "../lib/serve-server.ts";
import { after, before, call, pairDevice, test } from "./serve-test-client.ts";

const ADMIN = "gsa_test-admin-token";
const IDENTITY = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
let root: string;
let repo: string;
let server: ServeServer;
let reader: { id: string; token: string };
let operator: { id: string; token: string };
let silent: Server;

before(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-serve-git-")));
	repo = join(root, "repo");
	mkdirSync(repo);
	const auth = new ServeAuth({ devicesFile: join(root, "serve", "devices.json"), adminToken: ADMIN });
	// No user or system git configuration: the fixture's own only.
	const emptyConfig = join(root, "empty.gitconfig");
	writeFileSync(emptyConfig, "");
	server = await startServeServer({
		host: "127.0.0.1",
		port: 0,
		auth,
		version: "test",
		launchSession: () => { throw new Error("no sessions here"); },
		env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_DIR: "/somewhere/else" },
		gitLimits: { stdoutBytes: 100 },
	});
	reader = await pairDevice(server.url, ADMIN, ["sessions:read"], "reader");
	operator = await pairDevice(server.url, ADMIN, ["sessions:read", "sessions:operate"], "operator");
	// A remote that accepts and never answers, for the timeout.
	silent = createServer(() => { /* hold the connection */ });
	const listening = Promise.withResolvers<void>();
	silent.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
});
after(async () => {
	await server?.close();
	silent?.close();
	rmSync(root, { recursive: true, force: true });
});

const git = (token: string, args: string[], extra: Record<string, unknown> = {}) => call(server.url, "POST", "/api/git", { token, body: { cwd: repo, args, ...extra } });
const text = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

test("classifyGitArgs: reads, operations, network commands and refused options", () => {
	assert.deepEqual(classifyGitArgs(["status", "--porcelain=v2"]), { subcommand: "status", scope: "sessions:read", network: false });
	assert.deepEqual(classifyGitArgs(["-C", "sub", "--no-pager", "log", "-n", "5"]), { subcommand: "log", scope: "sessions:read", network: false });
	assert.deepEqual(classifyGitArgs(["--version"]), { scope: "sessions:read", network: false });
	assert.equal(classifyGitArgs(["commit", "-m", "x"]).scope, "sessions:operate");
	assert.deepEqual(classifyGitArgs(["fetch", "origin"]), { subcommand: "fetch", scope: "sessions:operate", network: true });
	assert.equal(classifyGitArgs(["ls-remote", "origin"]).scope, "sessions:read");
	assert.equal(classifyGitArgs(["log", "--output=/tmp/x"]).scope, "sessions:operate", "--output writes a file");
	assert.equal(classifyGitArgs(["diff", "--numstat", "--output-indicator-new=+"]).scope, "sessions:read");
	assert.equal(classifyGitArgs(["grep", "-O", "x"]).scope, "sessions:operate");
	assert.equal(classifyGitArgs(["-c", "color.ui=false", "status"]).scope, "sessions:operate", "any -c operates");
	assert.equal(classifyGitArgs(["status", "--", "-c"]).scope, "sessions:read");

	for (const args of [["branch"], ["branch", "--list", "feat/*"], ["branch", "-a", "--contains", "HEAD"], ["branch", "--show-current"], ["tag"], ["tag", "-l", "v*"],
		["config", "--get", "user.name"], ["config", "get", "user.name"], ["config", "--list"], ["remote", "-v"], ["remote", "get-url", "origin"],
		["stash", "list"], ["worktree", "list"], ["symbolic-ref", "HEAD"], ["rev-parse", "--show-toplevel"], ["for-each-ref", "refs/heads"]]) {
		assert.equal(classifyGitArgs(args).scope, "sessions:read", args.join(" "));
	}
	for (const args of [["branch", "new"], ["branch", "-D", "old"], ["tag", "v1"], ["tag", "-a", "v1", "-m", "x"], ["config", "user.name", "x"],
		["config", "--unset", "user.name"], ["remote", "add", "o", "u"], ["stash"], ["stash", "pop"], ["worktree", "add", "x"], ["symbolic-ref", "HEAD", "refs/heads/x"],
		["checkout", "main"], ["add", "."]]) {
		assert.equal(classifyGitArgs(args).scope, "sessions:operate", args.join(" "));
	}

	const refused = [["-c", "core.sshCommand=evil", "fetch"], ["-c", "Core.FSMonitor=evil", "status"], ["-c", "core.hooksPath=/x", "commit"],
		["-c", "alias.x=!evil", "x"], ["-c", "uploadpack.packObjectsHook=evil", "fetch"], ["-c", "remote.origin.uploadpack=evil", "fetch"],
		["--config-env=core.sshCommand=VAR", "fetch"], ["--config-env", "core.fsmonitor=VAR", "status"], ["--exec-path=/tmp", "status"],
		["fetch", "--upload-pack=evil", "origin"], ["push", "--receive-pack", "evil"], ["push", "--exec=evil"], ["clone", "-u", "evil", "url"],
		["clone", "--config", "core.fsmonitor=evil", "url"], ["clone", "-c", "core.sshCommand=evil", "url"], ["ls-remote", "-uevil", "url"]];
	for (const args of refused) assert.throws(() => classifyGitArgs(args), (error: { code?: string }) => error.code === "git_refused", args.join(" "));
	// After `--` they are paths, not options.
	assert.equal(classifyGitArgs(["log", "--", "--upload-pack=x"]).scope, "sessions:read");
});

test("classifyGitArgs: file contents (patches, blobs, blame, grep) need sessions:operate; paths and counts do not", () => {
	for (const args of [["log", "--format=%H%x00%s", "-n", "20"], ["log", "--all", "--no-merges", "--format=%at"], ["log", "--stat"], ["log", "-1", "--format=%B"],
		["diff", "--numstat", "-z"], ["diff", "--numstat", "-z", "HEAD"], ["diff", "--name-status"], ["diff", "--stat", "main"], ["diff", "--quiet"],
		["diff-tree", "-r", "-M", "-z", "--no-commit-id", "--name-status", "HEAD"], ["diff-index", "--cached", "HEAD"], ["diff-files"],
		["stash", "list", "--format=%gd%x00%gs"], ["stash", "show", "stash@{0}"], ["cat-file", "-t", "HEAD"], ["cat-file", "-s", "HEAD:a.txt"],
		["cat-file", "--batch-check"], ["ls-files", "-z"], ["ls-tree", "-r", "HEAD"], ["rev-parse", "HEAD:a.txt"]]) {
		assert.equal(classifyGitArgs(args).scope, "sessions:read", args.join(" "));
	}
	for (const args of [["show", "HEAD"], ["show", "HEAD:a.txt"], ["show", "-s", "--format=%H"], ["diff"], ["diff", "HEAD"], ["diff", "--no-color", "--no-ext-diff", "a", "b"],
		["diff", "--numstat", "-p"], ["diff", "--stat", "--patch"], ["diff", "--check"], ["diff", "--name-only", "-U3"], ["diff-tree", "-p", "HEAD"], ["diff-tree", "--cc", "HEAD"],
		["diff-index", "-p", "HEAD"], ["diff-files", "--patch"], ["log", "-p"], ["log", "-pM"], ["log", "--patch"], ["log", "-L1,2:a.txt"], ["log", "-Ssecret"],
		["log", "-G", "secret"], ["log", "--word-diff"], ["log", "-c"], ["log", "--diff-merges=on"], ["stash", "show", "-p"], ["stash", "list", "-p"],
		["cat-file", "-p", "HEAD:a.txt"], ["cat-file", "blob", "HEAD:a.txt"], ["cat-file", "--batch"], ["blame", "a.txt"], ["grep", "secret"]]) {
		assert.equal(classifyGitArgs(args).scope, "sessions:operate", args.join(" "));
	}
});

test("POST /api/git runs git without a shell: exit code, base64 output, stdin and allowed env", async () => {
	const init = await git(operator.token, ["init", "-q", "-b", "main"]);
	assert.equal(init.status, 200, JSON.stringify(init.body));
	assert.equal(init.body.code, 0, text(init.body.stderr));
	writeFileSync(join(repo, "a.txt"), "hello\n");
	assert.equal((await git(operator.token, ["add", "a.txt"])).body.code, 0);
	const commit = await git(operator.token, ["commit", "-q", "-m", "first"], { env: IDENTITY });
	assert.equal(commit.body.code, 0, text(commit.body.stderr));

	const status = await git(reader.token, ["status", "--porcelain"]);
	assert.equal(status.body.code, 0);
	assert.equal(text(status.body.stdout), "", "the inherited GIT_DIR does not leak into the request");
	assert.equal(status.body.truncated, false);
	assert.equal(status.body.timedOut, false);

	const hashed = await git(operator.token, ["hash-object", "--stdin"], { stdin: Buffer.from("hello\n").toString("base64") });
	assert.equal(text(hashed.body.stdout).trim(), "ce013625030ba8dba906f756967f9e9ca394464a");

	const failing = await git(reader.token, ["rev-parse", "--verify", "nope"]);
	assert.equal(failing.status, 200);
	assert.notEqual(failing.body.code, 0);
	assert.match(text(failing.body.stderr), /fatal|Needed a single revision/);

	const big = await git(operator.token, ["log", "-p"]);
	assert.equal(big.body.truncated, true);
	assert.equal(Buffer.from(big.body.stdout, "base64").length, 100);

	// No editor can answer: a commit without a message gives up at once.
	writeFileSync(join(repo, "b.txt"), "b\n");
	await git(operator.token, ["add", "b.txt"]);
	const noMessage = await git(operator.token, ["commit"], { env: IDENTITY });
	assert.notEqual(noMessage.body.code, 0);
});

test("scopes, refusals and validation", async () => {
	assert.equal((await git(reader.token, ["commit", "-m", "x"])).status, 403);
	assert.equal((await git(reader.token, ["-c", "color.ui=false", "status"])).status, 403);
	// Contents need operate; status, branches, the log and changed paths stay readable.
	for (const args of [["show", "HEAD:a.txt"], ["diff", "HEAD"], ["cat-file", "-p", "HEAD:a.txt"], ["blame", "a.txt"], ["grep", "hello"], ["log", "-p"]]) {
		const denied = await git(reader.token, args);
		assert.equal(denied.status, 403, args.join(" "));
		assert.equal(denied.body.error.code, "forbidden");
	}
	assert.equal(text((await git(operator.token, ["show", "HEAD:a.txt"])).body.stdout), "hello\n");
	for (const args of [["status", "--porcelain"], ["branch", "--show-current"], ["log", "--format=%s"], ["diff", "--numstat", "HEAD"], ["diff-tree", "-r", "--name-status", "HEAD"]]) {
		const allowed = await git(reader.token, args);
		assert.equal(allowed.status, 200, args.join(" "));
		assert.equal(allowed.body.code, 0, `${args.join(" ")}: ${text(allowed.body.stderr)}`);
	}
	const refused = await git(operator.token, ["-c", "core.fsmonitor=touch /tmp/pwned", "status"]);
	assert.equal(refused.status, 400);
	assert.equal(refused.body.error.code, "git_refused");
	assert.equal((await git(operator.token, ["status"], { env: { GIT_SSH_COMMAND: "evil" } })).body.error.code, "env_not_allowed");
	assert.equal((await git(operator.token, ["status"], { env: { GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'" } })).body.error.code, "env_not_allowed");
	assert.equal((await git(operator.token, [])).body.error.code, "invalid_args");
	assert.equal((await git(operator.token, ["status", "a\0b"])).body.error.code, "invalid_args");
	assert.equal((await git(operator.token, ["status"], { stdin: "not base64!" })).body.error.code, "invalid_stdin");
	assert.equal((await git(operator.token, ["status"], { timeoutMs: 300_000 })).body.error.code, "invalid_timeout", "only network commands may wait that long");
	assert.equal((await call(server.url, "POST", "/api/git", { token: operator.token, body: { cwd: "relative", args: ["status"] } })).body.error.code, "invalid_cwd");
	assert.equal((await call(server.url, "POST", "/api/git", { body: { cwd: repo, args: ["status"] } })).status, 401);
	assert.equal((await call(server.url, "GET", "/api/git", { token: operator.token })).status, 405);
});

test("a network command that hangs is ended at its timeout", async () => {
	const port = (silent.address() as { port: number }).port;
	const started = Date.now();
	const hung = await git(reader.token, ["ls-remote", `http://127.0.0.1:${port}/repo.git`], { timeoutMs: 1000 });
	assert.equal(hung.status, 200);
	assert.equal(hung.body.timedOut, true);
	assert.ok(Date.now() - started < 5000);
});

test("git missing on the server answers 501 git_missing", async () => {
	const auth = new ServeAuth({ devicesFile: join(root, "serve2", "devices.json"), adminToken: ADMIN });
	const bare = await startServeServer({ host: "127.0.0.1", port: 0, auth, version: "test", launchSession: () => { throw new Error("none"); }, env: { PATH: join(root, "no-bin") } });
	try {
		const missing = await call(bare.url, "POST", "/api/git", { token: ADMIN, body: { cwd: repo, args: ["status"] } });
		assert.equal(missing.status, 501);
		assert.equal(missing.body.error.code, "git_missing");
	} finally {
		await bare.close();
	}
});
