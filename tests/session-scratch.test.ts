import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSessionScratchExtension, SCRATCH_COMMAND_USAGE } from "../extensions/session-scratch.ts";
import * as scratchLib from "../lib/session-scratch.ts";
import { gitArtifactTargets, LEDGER_VERSION, type ScratchLedger } from "../lib/session-scratch.ts";

// Session scratch and artifact ledger (odd/tasks/session-scratch-ledger.md):
// the runtime owns the parent session's TMPDIR and the clones/worktrees it
// creates, records them in a per-session ledger, and removes only what it
// created and recorded. Every fixture lives under one private test root.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> };

interface Fixture { root: string; base: string; configHome: string; cwd: string; work: string }

function fixture(t: TestContext): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-session-scratch-test-")));
	const fx = { root, base: join(root, "tmp"), configHome: join(root, "config"), cwd: join(root, "project"), work: join(root, "work") };
	for (const path of [fx.base, fx.configHome, fx.cwd, fx.work]) mkdirSync(path, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return fx;
}

type ExtensionFactory = typeof createSessionScratchExtension;

interface Options {
	sessionId?: string; child?: boolean; hasUI?: boolean; confirm?: boolean; isProcessAlive?: (pid: number) => boolean; now?: () => number; platform?: NodeJS.Platform; tmp?: string;
	processStartToken?: (pid: number) => string | undefined;
	/** A shared process environment, as a reload re-runs the extension against the same `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The factory of a separately loaded module instance. */
	factory?: ExtensionFactory;
	/** Runs while the confirmation is open, before the user answers. */
	duringConfirm?: () => void;
}

interface BashOptions { isError?: boolean; toolName?: string }

let toolCallCount = 0;

function session(fx: Fixture, options: Options = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const notes: string[] = [];
	const confirms: string[] = [];
	const env: NodeJS.ProcessEnv = options.env ?? { TMPDIR: options.tmp ?? fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome, ...(options.child ? { GENTLE_PI_AGENTS_CHILD: "1" } : {}) };
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: Command) => { commands.set(name, command); },
	} as unknown as ExtensionAPI;
	(options.factory ?? createSessionScratchExtension)({ env, isProcessAlive: options.isProcessAlive, processStartToken: options.processStartToken, now: options.now, platform: options.platform })(pi);
	const ctx = {
		cwd: fx.cwd,
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionId: () => options.sessionId ?? "s-1" },
		ui: {
			notify: (message: string) => { notes.push(message); },
			confirm: async (title: string, message: string) => { confirms.push(`${title}\n${message}`); options.duringConfirm?.(); return options.confirm ?? true; },
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => await handlers.get(name)?.(event, ctx);
	return {
		env, handlers, commands, notes, confirms, ctx,
		start: (reason = "startup") => emit("session_start", { type: "session_start", reason }),
		shutdown: (reason = "quit") => emit("session_shutdown", { type: "session_shutdown", reason }),
		// The call event, then the command's effect on disk, then its result, as Pi runs a tool.
		bash: async (command: string, effect?: () => void, { isError = false, toolName = "bash" }: BashOptions = {}) => {
			const toolCallId = `c${++toolCallCount}`;
			await emit("tool_call", { type: "tool_call", toolName, toolCallId, input: { command } });
			effect?.();
			return await emit("tool_result", { type: "tool_result", toolName, toolCallId, input: { command }, content: [], isError });
		},
		run: async (args: string) => { await commands.get("gentle:scratch")!.handler(args, ctx); return notes.at(-1) ?? ""; },
	};
}

const ledgerFile = (fx: Fixture, sessionId: string) => join(fx.configHome, "scratch", `${sessionId}.json`);
const readLedger = (fx: Fixture, sessionId: string) => JSON.parse(readFileSync(ledgerFile(fx, sessionId), "utf8")) as ScratchLedger;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function origin(fx: Fixture): string {
	const path = join(fx.work, "origin");
	mkdirSync(path);
	git(path, "init", "-q");
	writeFileSync(join(path, "a.txt"), "a\n");
	git(path, "add", "a.txt");
	git(path, "commit", "-q", "-m", "init");
	return path;
}

function writeForeignLedger(fx: Fixture, ledger: Partial<ScratchLedger> & { sessionId: string }): void {
	mkdirSync(join(fx.configHome, "scratch"), { recursive: true });
	const full: ScratchLedger = { version: LEDGER_VERSION, pid: 999_999, processStartedAt: new Date(0).toISOString(), cwd: fx.cwd, tempRoot: fx.base, inherited: { TMPDIR: fx.base }, scratchDir: null, artifacts: [], ...ledger };
	writeFileSync(ledgerFile(fx, ledger.sessionId), JSON.stringify(full));
}

const later = () => Date.now() + 2 * 3_600_000;
// clean keeps the live scratch's entries changed in the last minute (advisories S5).
const minutesLater = () => Date.now() + 2 * 60_000;

// S2

// Pi's /reload re-evaluates every extension module (jiti `moduleCache: false`
// after `clearExtensionCache()`), so the module-level state is new; a fresh
// import with a cache-busting query string is a separate module instance.
const loadInstance = async (tag: string): Promise<ExtensionFactory> =>
	((await import(`../extensions/session-scratch.ts?instance=${tag}-${Date.now()}`)) as { createSessionScratchExtension: ExtensionFactory }).createSessionScratchExtension;

// Native review R3-scratch-socket-path-length: TMPDIR now points at the scratch, and
// Unix socket paths are capped near 104 bytes, so the name must stay short (S9).
const SCRATCH_NAME = /^gp[A-Za-z0-9]{6}$/;

test("S9: the scratch name is gpXXXXXX whatever the session id", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { sessionId: "a".repeat(64) });
	await s.start();
	assert.match(basename(s.env.TMPDIR!), SCRATCH_NAME);
	await s.shutdown();
});

test("S9: TMPDIR keeps the inherited spelling while the ledger records real paths", async (t) => {
	const fx = fixture(t);
	const link = join(fx.root, "tmp-link");
	symlinkSync(fx.base, link, "dir");
	const env: NodeJS.ProcessEnv = { TMPDIR: link, GENTLE_PI_CONFIG_HOME: fx.configHome };
	const first = session(fx, { env, factory: await loadInstance("spelling-a") });
	await first.start();
	const scratch = env.TMPDIR!;
	assert.equal(dirname(scratch), link, "the TMPDIR value joins the inherited value, never a real path");
	const ledger = readLedger(fx, "s-1");
	assert.equal(ledger.scratchDir, join(fx.base, basename(scratch)));
	assert.equal(ledger.tempRoot, fx.base);
	assert.deepEqual(ledger.inherited, { TMPDIR: link });
	writeFileSync(join(scratch, "work.txt"), "x");
	await first.shutdown("reload");
	const second = session(fx, { env, factory: await loadInstance("spelling-b") });
	await second.start("reload");
	assert.equal(env.TMPDIR, scratch, "a reload recovers the scratch under the same spelling");
	assert.deepEqual(readdirSync(fx.base), [basename(scratch)]);
	await second.shutdown("quit");
	assert.deepEqual(readdirSync(fx.base), []);
	assert.equal(env.TMPDIR, link);
});

test("S2: a primary session points TMPDIR at a private session scratch under the inherited one", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { sessionId: "abc/../1" });
	await s.start();
	const scratch = s.env.TMPDIR!;
	assert.equal(dirname(scratch), fx.base);
	assert.match(basename(scratch), SCRATCH_NAME);
	assert.ok(statSync(scratch).isDirectory());
	if (process.platform !== "win32") assert.equal(statSync(scratch).mode & 0o777, 0o700);
	assert.equal(s.env.TMP, undefined, "TMP/TEMP are only set on win32");
});

test("S2: on win32 TMP and TEMP follow the session scratch", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { platform: "win32" });
	await s.start();
	assert.equal(s.env.TMP, s.env.TMPDIR);
	assert.equal(s.env.TEMP, s.env.TMPDIR);
	await s.shutdown();
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(s.env.TMP, undefined);
	assert.equal(s.env.TEMP, undefined);
});

test("S2: a child session creates no scratch, ledger, capture, or command", async (t) => {
	const fx = fixture(t);
	const s = session(fx, { child: true });
	await s.start();
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(s.commands.has("gentle:scratch"), false);
	assert.equal(s.handlers.size, 0);
	assert.deepEqual(readdirSync(fx.base), []);
	assert.equal(existsSync(join(fx.configHome, "scratch")), false);
	// Parent control: the same fixture in a primary session does create one.
	const parent = session(fx);
	await parent.start();
	assert.notEqual(parent.env.TMPDIR, fx.base);
	await parent.shutdown();
});

test("S2: when the scratch cannot be created the session keeps the inherited TMPDIR", async (t) => {
	const fx = fixture(t);
	const missing = join(fx.root, "missing");
	const s = session(fx, { tmp: missing });
	await s.start();
	assert.equal(s.env.TMPDIR, missing);
	assert.equal(existsSync(missing), false);
});

test("S2/S5: reload keeps the same scratch; quit removes it and restores TMPDIR", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	const scratch = s.env.TMPDIR!;
	writeFileSync(join(scratch, "work.txt"), "x");
	await s.shutdown("reload");
	await s.start("reload");
	assert.equal(s.env.TMPDIR, scratch);
	assert.ok(existsSync(join(scratch, "work.txt")));
	await s.shutdown("quit");
	assert.equal(existsSync(scratch), false);
	assert.equal(s.env.TMPDIR, fx.base);
	assert.equal(existsSync(ledgerFile(fx, "s-1")), false, "a ledger without artifacts is deleted");
});

test("S2/S5: a reload into a fresh module instance recovers the live scratch from the ledger and quit removes it once", async (t) => {
	const fx = fixture(t);
	const env: NodeJS.ProcessEnv = { TMPDIR: fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome };
	const first = session(fx, { env, factory: await loadInstance("first") });
	await first.start();
	const scratch = env.TMPDIR!;
	assert.notEqual(scratch, fx.base);
	writeFileSync(join(scratch, "work.txt"), "x");
	await first.shutdown("reload");
	const second = session(fx, { env, factory: await loadInstance("second") });
	assert.notEqual(second.handlers.get("session_start"), first.handlers.get("session_start"), "the second instance is a separate module evaluation");
	await second.start("reload");
	assert.equal(env.TMPDIR, scratch, "TMPDIR is unchanged");
	assert.equal(readFileSync(join(scratch, "work.txt"), "utf8"), "x", "the live scratch survives the reload");
	assert.deepEqual(readdirSync(fx.base), [basename(scratch)], "no second scratch is created");
	assert.equal(readLedger(fx, "s-1").scratchDir, scratch);
	await second.shutdown("quit");
	assert.deepEqual(readdirSync(fx.base), [], "quit removes the one scratch");
	assert.equal(env.TMPDIR, fx.base, "the inherited TMPDIR recorded in the ledger is restored");
	assert.equal(existsSync(ledgerFile(fx, "s-1")), false);
	// The first instance saw only the reload shutdown and removes nothing more.
	await first.shutdown("quit");
	assert.equal(env.TMPDIR, fx.base);
});

test("S5: startup never removes a scratch of this process that TMPDIR no longer points into", async (t) => {
	const fx = fixture(t);
	const env: NodeJS.ProcessEnv = { TMPDIR: fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome };
	const first = session(fx, { env, factory: await loadInstance("keep-a") });
	await first.start();
	const scratch = env.TMPDIR!;
	writeFileSync(join(scratch, "work.txt"), "x");
	env.TMPDIR = fx.base;
	const second = session(fx, { env, factory: await loadInstance("keep-b") });
	await second.start("reload");
	assert.ok(existsSync(join(scratch, "work.txt")), "a scratch owned by this pid is never removed at startup");
	await second.shutdown();
});

test("S5: a session replacement removes the old scratch and the new session gets its own", async (t) => {
	const fx = fixture(t);
	let id = "first";
	const s = session(fx);
	(s.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => id;
	await s.start();
	const first = s.env.TMPDIR!;
	await s.shutdown("new");
	id = "second";
	await s.start("new");
	assert.equal(existsSync(first), false);
	assert.equal(dirname(s.env.TMPDIR!), fx.base, "the new scratch nests under the inherited TMPDIR, not the old scratch");
	assert.match(basename(s.env.TMPDIR!), SCRATCH_NAME);
	await s.shutdown();
});

// S3

test("S3: the ledger records the session, owning process, cwd and scratch, written atomically and privately", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	const ledger = readLedger(fx, "s-1");
	assert.equal(ledger.version, LEDGER_VERSION);
	assert.equal(ledger.sessionId, "s-1");
	assert.equal(ledger.pid, process.pid);
	assert.ok(!Number.isNaN(Date.parse(ledger.processStartedAt)));
	assert.equal(ledger.cwd, fx.cwd);
	assert.equal(ledger.scratchDir, s.env.TMPDIR);
	assert.deepEqual(ledger.artifacts, []);
	assert.deepEqual(readdirSync(join(fx.configHome, "scratch")), ["s-1.json"], "no temp file is left after the rename");
	if (process.platform !== "win32") assert.equal(statSync(ledgerFile(fx, "s-1")).mode & 0o777, 0o600);
	await s.shutdown();
});

// S4

test("S4: clone and worktree destinations resolve against cd segments and git -C", () => {
	const cwd = "/w";
	const paths = (command: string) => gitArtifactTargets(command, cwd).map(({ kind, path }) => `${kind}:${path}`);
	assert.deepEqual(paths("git clone https://example.com/org/repo.git"), ["clone:/w/repo"]);
	assert.deepEqual(paths("git clone --depth 1 -b main git@github.com:org/tool.git dest"), ["clone:/w/dest"]);
	assert.deepEqual(paths("git clone --origin=up ../a/"), ["clone:/w/a"]);
	assert.deepEqual(paths("cd sub && git clone ../origin"), ["clone:/w/sub/origin"]);
	assert.deepEqual(paths("cd sub && git clone ../o here"), ["clone:/w/sub/here"]);
	assert.deepEqual(paths("git -C sub clone ../o d 2>&1 | tail -1"), ["clone:/w/sub/d"]);
	assert.deepEqual(paths("GIT_TERMINAL_PROMPT=0 git clone x/b.bundle"), ["clone:/w/b"]);
	assert.deepEqual(paths("git worktree add -b feat ../wt main"), ["worktree:/wt"]);
	assert.deepEqual(paths("git worktree add --detach wt2 HEAD; git worktree add -B x \"with space\""), ["worktree:/w/wt2", "worktree:/w/with space"]);
	for (const none of ["echo git clone x y", "git worktree list", "git clone", "git log --grep clone", "printf 'git worktree add z'"]) {
		assert.deepEqual(paths(none), [], none);
	}
});

test("S4: a successful foreground bash clone or worktree add is recorded with its command and time", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	const clone = `cd ${fx.work} && git clone -q ${source} copy`;
	await s.bash(clone, () => git(fx.work, "clone", "-q", source, "copy"));
	await s.bash(`git -C ${source} worktree add -q -b feat ../wt`, () => git(source, "worktree", "add", "-q", "-b", "feat", join(fx.work, "wt")));
	const ledger = readLedger(fx, "s-1");
	assert.deepEqual(ledger.artifacts.map(({ kind, path, command }) => ({ kind, path, command })), [
		{ kind: "clone", path: join(fx.work, "copy"), command: clone },
		{ kind: "worktree", path: join(fx.work, "wt"), command: `git -C ${source} worktree add -q -b feat ../wt` },
	]);
	assert.ok(ledger.artifacts.every((artifact) => !Number.isNaN(Date.parse(artifact.recordedAt))));
	// The same path is recorded once.
	await s.bash(clone, () => { rmSync(join(fx.work, "copy"), { recursive: true, force: true }); git(fx.work, "clone", "-q", source, "copy"); });
	assert.equal(readLedger(fx, "s-1").artifacts.length, 2);
	await s.shutdown();
	assert.equal(readLedger(fx, "s-1").scratchDir, null, "the ledger survives shutdown while artifacts remain");
});

test("S4: failed, missing, non-bash, and child results are not recorded", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "copy");
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} failed`, () => git(fx.work, "clone", "-q", source, "failed"), { isError: true });
	await s.bash(`cd ${fx.work} && git clone ${source} never-created`);
	await s.bash(`cd ${fx.work} && git clone ${source} background`, () => git(fx.work, "clone", "-q", source, "background"), { toolName: "bg_start" });
	// A result without its call event has no before-state, so nothing is recorded.
	git(fx.work, "clone", "-q", source, "no-call");
	await s.handlers.get("tool_result")?.({ type: "tool_result", toolName: "bash", toolCallId: "unseen", input: { command: `cd ${fx.work} && git clone ${source} no-call` }, content: [], isError: false }, s.ctx);
	assert.deepEqual(readLedger(fx, "s-1").artifacts, []);
	const child = session(fx, { child: true, sessionId: "child" });
	await child.start();
	await child.bash(`cd ${fx.work} && git clone ${source} child-copy`, () => git(fx.work, "clone", "-q", source, "child-copy"));
	assert.equal(existsSync(ledgerFile(fx, "child")), false);
	await s.shutdown();
});

test("S4: a clone fallback over an existing user clone records nothing and clean keeps it", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	// The user's own clean, fully pushed clone, made before the session.
	git(fx.work, "clone", "-q", source, "dir");
	writeFileSync(join(fx.work, "dir", ".git", "info", "exclude"), "ignored.txt\n");
	writeFileSync(join(fx.work, "dir", "ignored.txt"), "user data");
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} dir || (cd dir && git pull)`, () => git(join(fx.work, "dir"), "pull", "-q"));
	assert.deepEqual(readLedger(fx, "s-1").artifacts, [], "a destination that existed before the command is not the session's");
	await s.run("clean");
	assert.equal(s.confirms.length, 0);
	assert.equal(readFileSync(join(fx.work, "dir", "ignored.txt"), "utf8"), "user data");
	// Control: the same fallback creating the clone is recorded.
	await s.bash(`cd ${fx.work} && git clone ${source} fresh || (cd fresh && git pull)`, () => git(fx.work, "clone", "-q", source, "fresh"));
	assert.deepEqual(readLedger(fx, "s-1").artifacts.map((artifact) => artifact.path), [join(fx.work, "fresh")]);
	await s.shutdown();
});

test("S4: a clone into the session directory or an ancestor of it is never recorded", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	await s.bash(`git clone ${source} .`, () => git(fx.cwd, "clone", "-q", source, "."));
	await s.bash(`git clone ${source} ..`);
	assert.deepEqual(readLedger(fx, "s-1").artifacts, []);
	await s.shutdown();
});

// S5

test("S5: startup sweeps the scratch of dead sessions past the grace period and keeps their artifacts", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const deadA = session(fx, { sessionId: "dead-a" });
	await deadA.start();
	const scratchA = deadA.env.TMPDIR!;
	writeFileSync(join(scratchA, "left.txt"), "x");
	const deadB = session(fx, { sessionId: "dead-b" });
	await deadB.start();
	const scratchB = deadB.env.TMPDIR!;
	await deadB.bash(`cd ${fx.work} && git clone ${source} kept`, () => git(fx.work, "clone", "-q", source, "kept"));
	// Neither session shut down (crash). A later session finds both owners dead.
	const next = session(fx, { sessionId: "next", isProcessAlive: () => false, now: later });
	await next.start();
	assert.equal(existsSync(scratchA), false);
	assert.equal(existsSync(scratchB), false);
	assert.equal(existsSync(ledgerFile(fx, "dead-a")), false);
	const b = readLedger(fx, "dead-b");
	assert.equal(b.scratchDir, null);
	assert.deepEqual(b.artifacts.map((artifact) => artifact.path), [join(fx.work, "kept")]);
	assert.ok(existsSync(join(fx.work, "kept", "a.txt")), "the sweep never removes artifacts");
	assert.ok(existsSync(next.env.TMPDIR!), "the sweep keeps the new session's own scratch");
	await next.shutdown();
});

test("S5: the sweep keeps scratch of live owners and of ledgers younger than the grace period", async (t) => {
	const fx = fixture(t);
	const other = session(fx, { sessionId: "other" });
	await other.start();
	const scratch = other.env.TMPDIR!;
	const live = session(fx, { sessionId: "live-check", isProcessAlive: () => true, now: later });
	await live.start();
	assert.ok(existsSync(scratch), "a live owning process keeps its scratch");
	const young = session(fx, { sessionId: "young-check", isProcessAlive: () => false });
	await young.start();
	assert.ok(existsSync(scratch), "a ledger younger than the grace period keeps its scratch");
	for (const s of [live, young, other]) await s.shutdown();
});

test("S5: the sweep refuses a symlinked scratch, a scratch outside the recorded root, and a directory without the scratch name", async (t) => {
	const fx = fixture(t);
	const victim = join(fx.root, "victim");
	mkdirSync(victim);
	writeFileSync(join(victim, "keep.txt"), "precious");
	const link = join(fx.base, "gpLinkAA");
	symlinkSync(victim, link, "dir");
	writeForeignLedger(fx, { sessionId: "evil-link", scratchDir: link });
	writeForeignLedger(fx, { sessionId: "evil-outside", scratchDir: victim });
	const otherNames = ["gentle-pi-session-evil-prefix-BBBBBB", "gp-1234abcd-BBBBBB", "gpBBBBBBB", "gpBBBBB", "xpBBBBBB"].map((name) => join(fx.base, name));
	for (const [index, dir] of otherNames.entries()) {
		mkdirSync(dir);
		writeFileSync(join(dir, "keep.txt"), "x");
		writeForeignLedger(fx, { sessionId: `evil-prefix-${index}`, scratchDir: dir });
	}
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: () => false, now: later });
	await s.start();
	assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "precious");
	assert.ok(lstatSync(link).isSymbolicLink());
	for (const dir of otherNames) assert.ok(existsSync(join(dir, "keep.txt")), dir);
	for (const id of ["evil-link", "evil-outside", ...otherNames.map((_, index) => `evil-prefix-${index}`)]) assert.ok(existsSync(ledgerFile(fx, id)), `${id} ledger is kept for the command`);
	await s.shutdown();
});

test("S5: a forged ledger naming a session-prefixed directory outside its recorded temp root is refused", async (t) => {
	const fx = fixture(t);
	const forged = join(fx.work, "gpEvilAb");
	mkdirSync(forged);
	writeFileSync(join(forged, "keep.txt"), "precious");
	writeForeignLedger(fx, { sessionId: "evil", tempRoot: fx.base, scratchDir: forged });
	const rootless = join(fx.base, "gpRootAb");
	mkdirSync(rootless);
	writeForeignLedger(fx, { sessionId: "rootless", tempRoot: null, scratchDir: rootless });
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: () => false, now: later });
	await s.start();
	await s.run("clean");
	assert.equal(readFileSync(join(forged, "keep.txt"), "utf8"), "precious");
	assert.ok(existsSync(rootless), "a ledger without a recorded temp root names no removable scratch");
	assert.equal(readLedger(fx, "evil").scratchDir, forged);
	await s.shutdown();
});

// S9: without the session id in the name, a forged ledger could name another
// session's live scratch; the ledger of a live session keeps it.
test("S9: a dead forged ledger never removes the scratch a live session's ledger records, in the sweep or in clean", async (t) => {
	const fx = fixture(t);
	const livePid = 4_444_444;
	const liveScratch = join(fx.base, "gpLiveAb");
	mkdirSync(liveScratch);
	writeFileSync(join(liveScratch, "work.txt"), "live");
	writeForeignLedger(fx, { sessionId: "live", pid: livePid, scratchDir: liveScratch });
	writeForeignLedger(fx, { sessionId: "forged", scratchDir: liveScratch });
	// A forged scratch that holds a live session's scratch is kept too.
	const outer = join(fx.base, "gpOuterA");
	const nested = join(outer, "gpInnerA");
	mkdirSync(nested, { recursive: true });
	writeForeignLedger(fx, { sessionId: "nested-live", pid: livePid, tempRoot: outer, scratchDir: nested });
	writeForeignLedger(fx, { sessionId: "forged-outer", scratchDir: outer });
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: (pid) => pid === livePid, now: later });
	await s.start();
	assert.equal(readFileSync(join(liveScratch, "work.txt"), "utf8"), "live", "the sweep keeps the live scratch");
	assert.ok(existsSync(nested), "the sweep keeps a scratch holding a live one");
	assert.equal(readLedger(fx, "forged").scratchDir, liveScratch);
	await s.run("clean");
	assert.equal(readFileSync(join(liveScratch, "work.txt"), "utf8"), "live", "clean keeps the live scratch");
	assert.ok(existsSync(nested), "clean keeps a scratch holding a live one");
	// This session's own scratch is live whatever the process check says.
	const own = readLedger(fx, "sweeper").scratchDir!;
	writeFileSync(join(own, "mine.txt"), "x");
	writeForeignLedger(fx, { sessionId: "forged-own", scratchDir: own });
	await s.run("clean");
	assert.ok(existsSync(own), "clean keeps this session's scratch named by a forged ledger");
	// Control: a dead ledger's own scratch that no live ledger records is removed.
	const deadScratch = join(fx.base, "gpDeadAb");
	mkdirSync(deadScratch);
	writeForeignLedger(fx, { sessionId: "dead", scratchDir: deadScratch });
	await s.run("clean");
	assert.equal(existsSync(deadScratch), false);
	await s.shutdown();
	assert.equal(existsSync(own), false, "shutdown still removes the session's own scratch");
});

test("S5: a recorded temp root inside the home is accepted only when it is the session's own temp root", async (t) => {
	const fx = fixture(t);
	const home = process.env.HOME;
	process.env.HOME = fx.root;
	t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
	// fx.base and fx.work are now inside the home; fx.base is this session's inherited TMPDIR.
	const foreign = join(fx.work, "gpHomeAb");
	mkdirSync(foreign);
	writeForeignLedger(fx, { sessionId: "home", tempRoot: fx.work, scratchDir: foreign });
	const dead = join(fx.base, "gpDeadAb");
	mkdirSync(dead);
	writeForeignLedger(fx, { sessionId: "dead", tempRoot: fx.base, scratchDir: dead });
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: () => false, now: later });
	await s.start();
	assert.ok(existsSync(foreign), "a forged root inside the home is refused");
	assert.equal(existsSync(dead), false, "an ended session under the same temp root is swept");
	const scratch = s.env.TMPDIR!;
	await s.shutdown();
	assert.equal(existsSync(scratch), false, "the session's own scratch under a home temp root is removed");
});

// Native review R3-untracked-status-guard: `git status --porcelain` honors the user's
// status.showUntrackedFiles, so with "no" a clone holding new work looked clean.
test("S6: clean keeps a clone with untracked work even when status hides untracked files", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} hidden`, () => git(fx.work, "clone", "-q", source, "hidden"));
	git(join(fx.work, "hidden"), "config", "status.showUntrackedFiles", "no");
	writeFileSync(join(fx.work, "hidden", "work.txt"), "new work\n");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0, "nothing is offered for removal");
	assert.equal(readFileSync(join(fx.work, "hidden", "work.txt"), "utf8"), "new work\n");
	assert.match(out, /hidden: uncommitted changes/);
});

test("S5: shutdown keeps a scratch that holds a recorded clone", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	const scratch = s.env.TMPDIR!;
	await s.bash(`cd ${scratch} && git clone ${source} inside`, () => git(scratch, "clone", "-q", source, "inside"));
	await s.shutdown();
	assert.ok(existsSync(join(scratch, "inside", "a.txt")));
	assert.equal(readLedger(fx, "s-1").scratchDir, scratch);
});

// S6

test("S6: list shows the session scratch with its size and the artifacts of this and dead sessions only", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "dead");
	git(fx.work, "clone", "-q", source, "live");
	writeForeignLedger(fx, { sessionId: "dead-1", pid: 1_111_111, artifacts: [{ kind: "clone", path: join(fx.work, "dead"), command: "git clone", recordedAt: new Date().toISOString() }] });
	writeForeignLedger(fx, { sessionId: "live-1", pid: 2_222_222, artifacts: [{ kind: "clone", path: join(fx.work, "live"), command: "git clone", recordedAt: new Date().toISOString() }] });
	const s = session(fx, { isProcessAlive: (pid) => pid === 2_222_222 });
	await s.start();
	writeFileSync(join(s.env.TMPDIR!, "f.bin"), Buffer.alloc(2048));
	await s.bash(`cd ${fx.work} && git clone ${source} mine`, () => git(fx.work, "clone", "-q", source, "mine"));
	const out = await s.run("list");
	assert.match(out, new RegExp(`Session scratch: ${s.env.TMPDIR!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(2\\.0 KiB\\)`));
	assert.match(out, /clone .*\/work\/mine \(this session\)/);
	assert.match(out, /clone .*\/work\/dead \(session dead-1, ended\)/);
	assert.doesNotMatch(out, /work\/live/);
	assert.equal(await s.run(""), out, "no argument lists");
	await s.shutdown();
});

test("S6: clean removes scratch without asking and, after one confirmation, only clean recorded worktrees and pushed clones", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx, { now: minutesLater });
	await s.start();
	const scratch = s.env.TMPDIR!;
	writeFileSync(join(scratch, "junk.txt"), "x");
	mkdirSync(join(scratch, "gaLiveAa"));
	const add = async (args: string[], command: string) => { await s.bash(`cd ${fx.work} && ${command}`, () => git(fx.work, ...args)); };
	await add(["clone", "-q", source, "pushed"], `git clone ${source} pushed`);
	await add(["clone", "-q", source, "unpushed"], `git clone ${source} unpushed`);
	git(join(fx.work, "unpushed"), "commit", "-q", "--allow-empty", "-m", "local");
	await add(["clone", "-q", source, "dirty-clone"], `git clone ${source} dirty-clone`);
	writeFileSync(join(fx.work, "dirty-clone", "new.txt"), "x");
	await s.bash(`cd ${source} && git worktree add -b clean-wt ../wt-clean`, () => git(source, "worktree", "add", "-q", "-b", "clean-wt", join(fx.work, "wt-clean")));
	await s.bash(`cd ${source} && git worktree add -b dirty-wt ../wt-dirty`, () => git(source, "worktree", "add", "-q", "-b", "dirty-wt", join(fx.work, "wt-dirty")));
	writeFileSync(join(fx.work, "wt-dirty", "a.txt"), "changed\n");
	git(fx.work, "clone", "-q", source, "unrecorded");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 1);
	assert.match(s.confirms[0], /pushed/);
	assert.match(s.confirms[0], /wt-clean/);
	assert.match(s.confirms[0], /ignored files inside these paths are deleted too/);
	assert.doesNotMatch(s.confirms[0], /work\/(unpushed|dirty-clone|wt-dirty)/);
	assert.equal(existsSync(join(fx.work, "pushed")), false);
	assert.equal(existsSync(join(fx.work, "wt-clean")), false);
	assert.doesNotMatch(git(source, "worktree", "list"), /wt-clean/, "the worktree is removed and pruned");
	assert.ok(existsSync(join(fx.work, "unpushed", "a.txt")));
	assert.ok(existsSync(join(fx.work, "dirty-clone", "new.txt")));
	assert.equal(readFileSync(join(fx.work, "wt-dirty", "a.txt"), "utf8"), "changed\n");
	assert.ok(existsSync(join(fx.work, "unrecorded", "a.txt")), "paths outside the recorded set are never touched");
	assert.match(out, /unpushed: commits not on any remote/);
	assert.match(out, /dirty-clone: uncommitted changes/);
	assert.match(out, /wt-dirty: uncommitted changes/);
	assert.equal(existsSync(join(scratch, "junk.txt")), false);
	assert.ok(existsSync(join(scratch, "gaLiveAa")), "live subagent scratch is left to the runner");
	assert.ok(existsSync(scratch), "the session keeps its TMPDIR");
	assert.deepEqual(readLedger(fx, "s-1").artifacts.map((artifact) => basename(artifact.path)).sort(), ["dirty-clone", "unpushed", "wt-dirty"]);
	await s.shutdown();
});

test("S6: a declined confirmation keeps every artifact; without UI clean removes scratch only and reports artifacts", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const declined = session(fx, { confirm: false });
	await declined.start();
	await declined.bash(`cd ${fx.work} && git clone ${source} pushed`, () => git(fx.work, "clone", "-q", source, "pushed"));
	await declined.run("clean");
	assert.ok(existsSync(join(fx.work, "pushed", "a.txt")));
	await declined.shutdown();
	const headless = session(fx, { hasUI: false, sessionId: "headless", now: minutesLater });
	await headless.start();
	writeFileSync(join(headless.env.TMPDIR!, "junk.txt"), "x");
	await headless.bash(`cd ${fx.work} && git clone ${source} headless-pushed`, () => git(fx.work, "clone", "-q", source, "headless-pushed"));
	const out = await headless.run("clean");
	assert.equal(headless.confirms.length, 0);
	assert.ok(existsSync(join(fx.work, "headless-pushed", "a.txt")));
	assert.equal(existsSync(join(headless.env.TMPDIR!, "junk.txt")), false);
	assert.match(out, /headless-pushed/);
	await headless.shutdown();
});

test("S6: clean refuses a recorded clone replaced by a symlink and leaves live sessions alone", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	git(fx.work, "clone", "-q", source, "real");
	const s = session(fx, { isProcessAlive: (pid) => pid === 3_333_333 });
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} copy`, () => git(fx.work, "clone", "-q", source, "copy"));
	renameSync(join(fx.work, "copy"), join(fx.work, "moved"));
	symlinkSync(join(fx.work, "real"), join(fx.work, "copy"), "dir");
	git(fx.work, "clone", "-q", source, "theirs");
	const liveScratch = join(fx.base, "gpLiveCC");
	mkdirSync(liveScratch);
	writeForeignLedger(fx, { sessionId: "live-2", pid: 3_333_333, scratchDir: liveScratch, artifacts: [{ kind: "clone", path: join(fx.work, "theirs"), command: "git clone", recordedAt: new Date().toISOString() }] });
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0, "nothing removable, nothing to confirm");
	assert.ok(lstatSync(join(fx.work, "copy")).isSymbolicLink());
	assert.ok(existsSync(join(fx.work, "real", "a.txt")));
	assert.ok(existsSync(join(fx.work, "theirs", "a.txt")));
	assert.ok(existsSync(liveScratch));
	assert.match(out, /copy: not the recorded directory/);
	await s.shutdown();
});

// PR #2300 review: `--all` does not include a detached HEAD, so a commit made only
// there looked pushed and the clone holding its only copy was removable.
test("S6: clean keeps a clone whose detached HEAD has a commit on no remote", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} detached`, () => git(fx.work, "clone", "-q", source, "detached"));
	const clone = join(fx.work, "detached");
	git(clone, "checkout", "-q", "--detach", "HEAD");
	git(clone, "commit", "-q", "--allow-empty", "-m", "only here");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0, "nothing is offered for removal");
	assert.ok(existsSync(join(clone, "a.txt")));
	assert.match(out, /detached: commits not on any remote/);
});

// PR #2300 review: the check ran before the confirmation, so work added while it was
// open was deleted with the clone.
test("S6: clean checks a clone again after the confirmation and keeps it if it changed", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const clone = join(fx.work, "late");
	const s = session(fx, { duringConfirm: () => writeFileSync(join(clone, "late.txt"), "written while asked\n") });
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} late`, () => git(fx.work, "clone", "-q", source, "late"));
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 1, "the clean clone was offered");
	assert.equal(readFileSync(join(clone, "late.txt"), "utf8"), "written while asked\n");
	assert.match(out, /late: uncommitted changes/);
});

// PR #2300 review: a different directory put at the recorded path while the
// confirmation was open is not the one that was checked, so it stays.
test("S6: clean keeps a directory that replaced the checked clone at the same path", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const clone = join(fx.work, "swap");
	const s = session(fx, { duringConfirm: () => {
		renameSync(clone, join(fx.work, "swap-old"));
		git(fx.work, "clone", "-q", source, "swap");
		writeFileSync(join(clone, ".git", "marker"), "replacement\n");
	} });
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} swap`, () => git(fx.work, "clone", "-q", source, "swap"));
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 1, "the checked clone was offered");
	assert.equal(readFileSync(join(clone, ".git", "marker"), "utf8"), "replacement\n", "the replacement stays");
	assert.match(out, /swap: replaced after the check/);
});

// PR #2300 review: a recorded path whose parent became a file (ENOTDIR) is gone, not foreign.
test("S6: a recorded clone whose parent is no longer a directory is reported gone and dropped", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	mkdirSync(join(fx.work, "nest"));
	await s.bash(`cd ${fx.work}/nest && git clone ${source} c`, () => git(join(fx.work, "nest"), "clone", "-q", source, "c"));
	rmSync(join(fx.work, "nest"), { recursive: true, force: true });
	writeFileSync(join(fx.work, "nest"), "now a file\n");
	const first = await s.run("clean");
	assert.match(first, /Already gone: clone .*nest\/c/);
	assert.doesNotMatch(await s.run("list"), /nest\/c/, "the stale entry is dropped");
});

test("S6: clean keeps a detached worktree whose commits are on no branch", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${source} && git worktree add --detach ../detached`, () => git(source, "worktree", "add", "-q", "--detach", join(fx.work, "detached")));
	git(join(fx.work, "detached"), "commit", "-q", "--allow-empty", "-m", "orphan");
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0);
	assert.ok(existsSync(join(fx.work, "detached", "a.txt")));
	assert.match(out, /detached: commits on no branch/);
	await s.shutdown();
});

test("S6/S8: the command help names list and clean", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	assert.match(s.commands.get("gentle:scratch")!.description ?? "", /list\|clean/);
	assert.equal(await s.run("bogus"), SCRATCH_COMMAND_USAGE);
	assert.match(SCRATCH_COMMAND_USAGE, /^Usage: \/gentle:scratch \[list\|clean\]/);
	await s.shutdown();
});

test("S8: the reference documents the scratch dir, ledger, automatic cleanup, sweep rule, and the command help", () => {
	const reference = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	const section = reference.split("### Session scratch and artifact ledger\n")[1]?.split("\n### ")[0] ?? "";
	for (const term of [
		"`gpXXXXXX`", "never its real path", "`TMPDIR`", "`<config home>/scratch/<session id>.json`", "atomically",
		"`version`", "`sessionId`", "`pid`", "`processStartedAt`", "`processStartToken`", "`cwd`", "`tempRoot`", "`inherited`", "`scratchDir`", "`artifacts`", "`git clone ... [<dir>]`", "`git worktree add ... <path>`",
		"did not exist before the command", "recovers the live scratch from the ledger", "never removes a scratch of its own process",
		"At session shutdown", "older than one hour", "never follows symlinks", "directly under the temp root its ledger recorded", "the ledger of a live session",
		"`/gentle:scratch list`", "`/gentle:scratch clean`", "no uncommitted changes and no unpushed commits", "ignored files inside them are deleted too", "`git worktree remove`", "Without a UI",
	]) assert.ok(section.includes(term), `scratch reference missing ${term}`);
	assert.match(reference, /\| `\/gentle:scratch` +\| Lists \(`list`, the default\) or cleans \(`clean`\)/);
	for (const line of SCRATCH_COMMAND_USAGE.split("\n").slice(1)) {
		const [action] = line.trim().split(/\s+/);
		assert.ok(section.includes(`\`/gentle:scratch ${action}\``), `reference missing the ${action} action from the help`);
	}
});

// Native review advisories of gentle-shell#2300 (odd/tasks/scratch-review-advisories.md).

// R3-pid-reuse-liveness: a pid the system reused for another process made an
// ended session look live, so its scratch was never swept. The comparison uses
// the OS's own start token, never the wall clock: a clock step must not make a
// live session look ended (review-e6f96fb8f1a7b6c5 R1-start-time-mismatch).
test("advisories S3: a ledger counts as live only when its pid has the start token the ledger recorded; an unreadable or missing token keeps it", async (t) => {
	const fx = fixture(t);
	const current = new Map([[5_555_550, "linux:900"], [5_555_551, "linux:100"], [5_555_553, "linux:900"]]);
	const cases = [
		{ name: "gpReuseA", token: "linux:100" },
		{ name: "gpMatchA", token: "linux:100", startedAt: "2020-01-01T00:00:00.000Z" },
		{ name: "gpNoTime", token: "linux:100" },
		{ name: "gpOldLed", token: undefined },
	];
	const dirs = cases.map(({ name }) => join(fx.base, name));
	for (const [index, { token, startedAt }] of cases.entries()) {
		mkdirSync(dirs[index]);
		writeForeignLedger(fx, { sessionId: `pid-${index}`, pid: 5_555_550 + index, scratchDir: dirs[index], ...(startedAt ? { processStartedAt: startedAt } : {}), ...(token ? { processStartToken: token } : {}) });
	}
	const s = session(fx, { sessionId: "sweeper", isProcessAlive: () => true, processStartToken: (pid) => current.get(pid), now: later });
	await s.start();
	assert.equal(existsSync(dirs[0]), false, "a reused pid has another start token: the session ended and its scratch is swept");
	assert.ok(existsSync(dirs[1]), "the same start token is the same process, whatever the wall clock says");
	assert.ok(existsSync(dirs[2]), "a start token that cannot be read keeps the ledger live");
	assert.ok(existsSync(dirs[3]), "a ledger without a start token keeps pid liveness");
	const listed = await s.run("list");
	assert.doesNotMatch(listed, /pid-[123]/, "live ledgers are not listed as ended");
	await s.shutdown();
});

test("advisories S3: the process start token is read from the OS, stable for a process, and skipped on Windows", () => {
	const read = (scratchLib as { processStartToken?: (pid: number, platform?: NodeJS.Platform) => string | undefined }).processStartToken;
	assert.equal(typeof read, "function", "lib/session-scratch.ts exports processStartToken");
	assert.equal(read!(process.pid, "win32"), undefined, "Windows checks pid liveness only");
	assert.equal(read!(2 ** 22 + 12_345), undefined, "a pid that does not exist has no start token");
	if (process.platform === "linux" || process.platform === "darwin") {
		const own = read!(process.pid);
		assert.ok(typeof own === "string" && own.length > 0, `own start token ${own}`);
		assert.equal(read!(process.pid), own, "the token of one process never changes");
		assert.notEqual(read!(process.ppid), own, "another process has another token");
	}
});

test("advisories S3: the ledger records the owning process's start token", async (t) => {
	const fx = fixture(t);
	const s = session(fx);
	await s.start();
	const ledger = readLedger(fx, "s-1") as ScratchLedger & { processStartToken?: string };
	const own = (scratchLib as { processStartToken?: (pid: number) => string | undefined }).processStartToken?.(process.pid);
	if (process.platform === "linux") assert.match(own ?? "", /^linux:\d+$/);
	assert.equal(ledger.processStartToken, own);
	await s.shutdown();
});

// R1-clone-removal-orphans-linked-worktrees: removing a clone left the worktrees
// linked to it without a repository.
test("advisories S4: clean keeps a recorded clone with linked worktrees; a prunable one does not count", async (t) => {
	const fx = fixture(t);
	const source = origin(fx);
	const s = session(fx);
	await s.start();
	await s.bash(`cd ${fx.work} && git clone ${source} host`, () => git(fx.work, "clone", "-q", source, "host"));
	const host = join(fx.work, "host");
	git(host, "worktree", "add", "-q", "--detach", join(fx.work, "linked"));
	const out = await s.run("clean");
	assert.equal(s.confirms.length, 0, "nothing is offered for removal");
	assert.ok(existsSync(join(host, "a.txt")));
	assert.ok(existsSync(join(fx.work, "linked", "a.txt")));
	assert.match(out, /host: has linked worktrees/);
	// Control: once the linked worktree's directory is gone it is prunable, and the clone is removable.
	rmSync(join(fx.work, "linked"), { recursive: true, force: true });
	await s.run("clean");
	assert.equal(s.confirms.length, 1);
	assert.equal(existsSync(host), false);
	await s.shutdown();
});

// R3-clean-empties-live-tmpdir: clean emptied the live TMPDIR while a running
// command could still be using what it had just created there.
test("advisories S5: clean keeps the live scratch's entries changed within the minute before it started", async (t) => {
	const fx = fixture(t);
	let offset = 0;
	const s = session(fx, { now: () => Date.now() + offset });
	await s.start();
	const scratch = s.env.TMPDIR!;
	writeFileSync(join(scratch, "fresh.txt"), "x");
	mkdirSync(join(scratch, "tree", "deep"), { recursive: true });
	writeFileSync(join(scratch, "tree", "deep", "f.txt"), "x");
	mkdirSync(join(scratch, "gaChildA"));
	offset = 30_000;
	const out = await s.run("clean");
	assert.ok(existsSync(join(scratch, "fresh.txt")), "an entry changed 30 s before clean stays");
	assert.ok(existsSync(join(scratch, "tree", "deep", "f.txt")));
	assert.match(out, /Emptied scratch .* except .*changed in the last minute/);
	offset = 120_000;
	await s.run("clean");
	assert.deepEqual(readdirSync(scratch), ["gaChildA"], "entries older than a minute go; subagent scratch stays");
	await s.shutdown();
});

// R3-reload-fallback-inherits-scratch: a reload that could not recover the scratch
// recorded the old scratch as the inherited TMPDIR and nested the new one in it.
test("advisories S6: a reload that cannot recover the scratch restores the ledger's inherited TMPDIR", async (t) => {
	const fx = fixture(t);
	const env: NodeJS.ProcessEnv = { TMPDIR: fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome };
	const first = session(fx, { env, factory: await loadInstance("fallback-a") });
	await first.start();
	const old = env.TMPDIR!;
	await first.shutdown("reload");
	rmSync(old, { recursive: true, force: true });
	const second = session(fx, { env, factory: await loadInstance("fallback-b") });
	await second.start("reload");
	assert.equal(dirname(env.TMPDIR!), fx.base, "the new scratch nests under the inherited TMPDIR, not the old scratch");
	assert.match(basename(env.TMPDIR!), SCRATCH_NAME);
	assert.deepEqual(readLedger(fx, "s-1").inherited, { TMPDIR: fx.base });
	await second.shutdown("quit");
	assert.equal(env.TMPDIR, fx.base);
});

test("advisories S6: a reload fallback whose ledger recorded TMPDIR unset creates the new scratch in the system temp dir, not the old scratch", async (t) => {
	if (process.platform === "win32") { t.skip("os.tmpdir() reads TMP/TEMP differently on Windows"); return; }
	const fx = fixture(t);
	// os.tmpdir() falls back to TMP when TMPDIR is unset, which keeps the fixture under its root.
	const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME, GENTLE_PI_AGENTS_CHILD: process.env.GENTLE_PI_AGENTS_CHILD };
	t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	delete process.env.TMPDIR;
	delete process.env.GENTLE_PI_AGENTS_CHILD; // The test runner may itself run inside a subagent.
	process.env.TMP = fx.base;
	process.env.GENTLE_PI_CONFIG_HOME = fx.configHome;
	const first = session(fx, { env: process.env, factory: await loadInstance("unset-a") });
	await first.start();
	const old = process.env.TMPDIR!;
	assert.equal(dirname(old), fx.base);
	assert.deepEqual(readLedger(fx, "s-1").inherited, { TMPDIR: null });
	await first.shutdown("reload");
	rmSync(old, { recursive: true, force: true });
	const second = session(fx, { env: process.env, factory: await loadInstance("unset-b") });
	await second.start("reload");
	assert.equal(dirname(process.env.TMPDIR ?? ""), fx.base, "tmpdir() is asked with the old scratch no longer in TMPDIR");
	assert.deepEqual(readLedger(fx, "s-1").inherited, { TMPDIR: null });
	await second.shutdown("quit");
	assert.equal(process.env.TMPDIR, undefined);
});

test("advisories S6: a reload without a readable ledger never inherits a gpXXXXXX TMPDIR", async (t) => {
	const fx = fixture(t);
	const env: NodeJS.ProcessEnv = { TMPDIR: fx.base, GENTLE_PI_CONFIG_HOME: fx.configHome };
	const first = session(fx, { env, factory: await loadInstance("lost-a") });
	await first.start();
	const old = env.TMPDIR!;
	await first.shutdown("reload");
	writeFileSync(ledgerFile(fx, "s-1"), "{}");
	const second = session(fx, { env, factory: await loadInstance("lost-b") });
	await second.start("reload");
	assert.equal(dirname(env.TMPDIR!), fx.base, "the new scratch is not nested in the old one");
	assert.notEqual(env.TMPDIR, old);
	assert.deepEqual(readLedger(fx, "s-1").inherited, { TMPDIR: fx.base });
	await second.shutdown("quit");
	assert.equal(env.TMPDIR, fx.base);
	// Control: at startup a gpXXXXXX TMPDIR (a Pi started inside another session) is inherited as it is.
	const nested = session(fx, { sessionId: "nested", tmp: old });
	await nested.start();
	assert.equal(dirname(nested.env.TMPDIR!), old);
	await nested.shutdown();
	assert.equal(nested.env.TMPDIR, old);
});

test("advisories S7: the reference documents the advisory rules", () => {
	const reference = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	const section = reference.split("### Session scratch and artifact ledger\n")[1]?.split("\n### ")[0] ?? "";
	for (const term of [
		"live or quarantined subagent", "a later startup sweep", "has a start token other than the one its ledger recorded", "never through the wall clock", "cannot be read", "has linked worktrees",
		"changed in the last minute", "recorded `inherited` values", "not a `gpXXXXXX` directory",
	]) assert.ok(section.includes(term), `scratch reference missing ${term}`);
});
