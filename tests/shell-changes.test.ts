import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	CHANGE_STATUS,
	ChangesTracker,
	WorktreeChangesTracker,
	parseWorktrees,
	changesSummary,
	emptyChanges,
	parseNumstat,
	parsePorcelain,
	renderChangesWidget,
	changesModel,
	snapshotChanges,
	type ChangedFile,
} from "../lib/shell-changes.ts";

// The changes view shows the working tree against HEAD, new files included,
// so a resumed session sees the same picture as a fresh one.

const plainTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

const taggedTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
	bold(text: string) {
		return text;
	},
};

function file(path: string, added: number, deleted: number, status: ChangedFile["status"] = CHANGE_STATUS.MODIFIED): ChangedFile {
	return { path, added, deleted, status };
}

test("parseNumstat reads counts, treats binaries as zero, and resolves rename braces", () => {
	const parsed = parseNumstat("12\t3\tlib/a.ts\n-\t-\tassets/logo.png\n0\t0\tsrc/{old => new}/file.ts\n5\t1\told.ts => new.ts\n");
	assert.deepEqual(parsed, [
		{ path: "lib/a.ts", added: 12, deleted: 3 },
		{ path: "assets/logo.png", added: 0, deleted: 0 },
		{ path: "src/new/file.ts", added: 0, deleted: 0 },
		{ path: "new.ts", added: 5, deleted: 1 },
	]);
});

test("parsePorcelain reads NUL-separated status entries including renames and untracked files", () => {
	const raw = [" M lib/a.ts", "A  lib/b.ts", " D lib/c.ts", "?? notes.md", "R  new.ts", "old.ts", "MM lib/d.ts"].join("\0") + "\0";
	const parsed = parsePorcelain(raw);
	assert.deepEqual(
		[...parsed.entries()],
		[
			["lib/a.ts", CHANGE_STATUS.MODIFIED],
			["lib/b.ts", CHANGE_STATUS.ADDED],
			["lib/c.ts", CHANGE_STATUS.DELETED],
			["notes.md", CHANGE_STATUS.UNTRACKED],
			["new.ts", CHANGE_STATUS.RENAMED],
			["lib/d.ts", CHANGE_STATUS.MODIFIED],
		],
	);
});

test("snapshotChanges merges status with counts and keeps untracked files without counts", () => {
	const files = snapshotChanges({
		numstat: "4\t2\tlib/a.ts\n",
		porcelain: " M lib/a.ts\0?? notes.md\0",
	});
	assert.deepEqual(files, [file("lib/a.ts", 4, 2), file("notes.md", 0, 0, CHANGE_STATUS.UNTRACKED)]);
});

test("changesModel sorts files by path and totals the counts", () => {
	const model = changesModel([file("lib/b.ts", 10, 0, CHANGE_STATUS.ADDED), file("lib/a.ts", 4, 2)]);
	assert.deepEqual(model.files, [file("lib/a.ts", 4, 2), file("lib/b.ts", 10, 0, CHANGE_STATUS.ADDED)]);
	assert.equal(model.added, 14);
	assert.equal(model.deleted, 2);
});

test("changesSummary and the widget describe the session at a glance", () => {
	const model = changesModel([file("extensions/gentle-shell.ts", 31, 0, CHANGE_STATUS.ADDED), file("lib/shell-bar.ts", 9, 7), file("tests/x.test.ts", 2, 0)]);
	assert.equal(changesSummary(model), "3 files · +42 −7");
	assert.equal(changesSummary(changesModel([file("a.ts", 1, 0)])), "1 file · +1 −0");

	const [line, ...rest] = renderChangesWidget(model, plainTheme, 120);
	assert.equal(rest.length, 0);
	assert.match(line, /^✎ 3 files · \+42 −7 · extensions\/gentle-shell\.ts · lib\/shell-bar\.ts · tests\/x\.test\.ts {2,}\/gentle:changes$/);
	assert.equal(visibleWidth(line), 120, "the command sits on the right edge");
});

test("changesSummary and the widget surface the capture limit", () => {
	const model = changesModel([file("a.ts", 1, 0)]);
	model.notice = "Session change capture limit reached; additional changes are not displayed.";
	assert.equal(changesSummary(model), "1 file · +1 −0 · capture limit reached");
	assert.match(renderChangesWidget(model, plainTheme, 200)[0], /capture limit reached/);
	assert.doesNotMatch(changesSummary(changesModel([file("a.ts", 1, 0)])), /capture limit reached/);
});

test("renderChangesWidget colors counts by direction and yields nothing when clean", () => {
	const model = changesModel([file("a.ts", 1, 2)]);
	const [line] = renderChangesWidget(model, taggedTheme, 400);
	assert.match(line, /<accent>✎<\/accent>/);
	assert.match(line, /<success>\+1<\/success> <error>−2<\/error>/);
	assert.match(line, /<dim>\/gentle:changes<\/dim>$/);
	assert.deepEqual(renderChangesWidget(emptyChanges(), plainTheme, 120), []);
});

test("renderChangesWidget drops the file list before truncating on narrow terminals", () => {
	const model = changesModel([file("a/very/long/path/one.ts", 1, 0), file("a/very/long/path/two.ts", 1, 0)]);
	const [line] = renderChangesWidget(model, plainTheme, 40);
	assert.equal(visibleWidth(line), 40);
	assert.match(line, /^✎ 2 files · \+2 −0 +\/gentle:changes$/);
	assert.doesNotMatch(line, /one\.ts/);
	const [tiny] = renderChangesWidget(model, plainTheme, 20);
	assert.ok(visibleWidth(tiny) <= 20);
	assert.match(tiny, /^✎ 2 files/);
});

function fakeGit(numstats: string[], porcelains: string[], code = 0) {
	const calls: string[][] = [];
	let round = 0;
	const git = async (args: string[]) => {
		calls.push(args);
		const isNumstat = args[0] === "diff";
		const index = Math.min(isNumstat ? round : round++, numstats.length - 1);
		return { stdout: isNumstat ? numstats[index] : porcelains[index], code };
	};
	return { git, calls };
}

test("ChangesTracker reads the working tree on start and again on refresh", async () => {
	const { git, calls } = fakeGit(
		["4\t2\tlib/a.ts\n", "4\t2\tlib/a.ts\n10\t0\tlib/b.ts\n"],
		[" M lib/a.ts\0", " M lib/a.ts\0A  lib/b.ts\0"],
	);
	const tracker = new ChangesTracker(git);
	await tracker.start();
	assert.deepEqual(tracker.model.files, [file("lib/a.ts", 4, 2)]);
	const model = await tracker.refresh();
	assert.deepEqual(model.files, [file("lib/a.ts", 4, 2), file("lib/b.ts", 10, 0, CHANGE_STATUS.ADDED)]);
	assert.equal(calls.length, 4);
	assert.deepEqual(calls[0], ["diff", "--numstat", "HEAD"]);
	assert.deepEqual(calls[1], ["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
});

test("ChangesTracker stays quiet outside a git repository", async () => {
	const { git, calls } = fakeGit([""], [""], 128);
	const tracker = new ChangesTracker(git);
	await tracker.start();
	assert.deepEqual(await tracker.refresh(), emptyChanges());
	assert.equal(calls.length, 2);
});

test("ChangesTracker coalesces overlapping refreshes into at most one extra round", async () => {
	let resolveGate: (() => void) | undefined;
	let rounds = 0;
	const git = async (args: string[]) => {
		if (args[0] === "diff") {
			rounds += 1;
			if (rounds === 2) await new Promise<void>((resolve) => { resolveGate = resolve; });
		}
		return { stdout: "", code: 0 };
	};
	const tracker = new ChangesTracker(git);
	await tracker.start();
	const first = tracker.refresh();
	const second = tracker.refresh();
	const third = tracker.refresh();
	await new Promise((resolve) => setTimeout(resolve, 0));
	resolveGate?.();
	await Promise.all([first, second, third]);
	assert.equal(rounds, 3);
});

test("registered roots hide clean and missing worktrees while metadata never admits bare or prunable siblings", async () => {
	let roots = "worktree /main\0branch refs/heads/main\0\0worktree /linked space\0detached\0\0worktree /clean\0\0worktree /gone\0\0worktree /pruned\0prunable missing\0\0worktree /bare\0bare\0\0";
	const calls: string[] = [];
	let registered = ["/main", "/linked space", "/clean", "/gone"];
	const tracker = new WorktreeChangesTracker(async () => ({ stdout: roots, code: 0 }), (root) => async (args) => {
		calls.push(root);
		if (root === "/gone") throw new Error("missing directory");
		return { stdout: args[0] === "status" && root !== "/clean" ? "?? same.ts\0" : "", code: 0 };
	}, (root) => async () => root === "/main" ? 2 : 3, () => registered);
	await tracker.start();
	assert.deepEqual(tracker.worktrees.map((tree) => [tree.root, tree.branch, tree.model.added]), [["/main", "main", 2], ["/linked space", undefined, 3]]);
	assert.equal(tracker.model.files.length, 2, "identical filenames in different roots remain distinct");
	assert.equal(new Set(tracker.model.files.map((file) => file.path)).size, 2);
	assert.ok(!calls.includes("/pruned") && !calls.includes("/bare"));
	roots += "worktree /new\0branch refs/heads/new\0\0";
	registered.push("/new");
	await tracker.refresh();
	assert.equal(tracker.worktrees.length, 3);
	roots = "worktree /clean\0\0";
	registered = ["/clean"];
	await tracker.refresh();
	assert.deepEqual(tracker.worktrees, []);
	assert.deepEqual(tracker.model, emptyChanges());
});

test("only registered worktrees are scanned, with whole preexisting and untracked contents", async () => {
	const queried: string[] = [];
	const roots = ["/used"];
	const tracker = new WorktreeChangesTracker(async () => ({ code: 0, stdout: "worktree /used\0\0worktree /hidden\0\0" }), (root) => async (args) => {
		queried.push(root);
		return { code: 0, stdout: args[0] === "status" ? " M old.ts\0?? new.ts\0" : "4\t2\told.ts\n" };
	}, () => async () => 3, () => roots);
	await tracker.start();
	assert.deepEqual(new Set(queried), new Set(["/used"]));
	assert.equal(tracker.model.files.length, 2);
	assert.equal(tracker.model.added, 7);
	roots.push("/hidden");
	await tracker.refresh();
	assert.equal(tracker.model.files.length, 4);
});

test("worktree refresh shares one scan so polling faster than discovery cannot prolong it", async () => {
	let release: (() => void) | undefined;
	let scans = 0;
	const tracker = new WorktreeChangesTracker(async () => {
		scans++;
		if (scans === 2) await new Promise<void>((resolve) => { release = resolve; });
		return { stdout: "", code: 0 };
	}, () => async () => ({ stdout: "", code: 0 }));
	await tracker.start();
	const first = tracker.refresh();
	const overlapping = tracker.refresh();
	release!();
	await Promise.all([first, overlapping]);
	assert.equal(scans, 2, "overlapping poll must not extend an already slow scan");
	await tracker.refresh();
	assert.equal(scans, 3, "next refresh still rediscovers roots");
});

test("registration during an in-flight status scan is included before refresh resolves", async () => {
	const roots = ["/used"];
	let release: () => void;
	let entered: () => void;
	const scanning = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let paused = false;
	const tracker = new WorktreeChangesTracker(async () => ({ code: 0, stdout: "" }), (root) => async (args) => {
		if (root === "/used" && args[0] === "status" && !paused) { paused = true; entered(); await gate; }
		return { code: 0, stdout: args[0] === "status" ? " M file.ts\0" : "1\t0\tfile.ts\n" };
	}, undefined, () => roots);
	const scan = tracker.refresh();
	await scanning;
	roots.push("/newly-used");
	const concurrent = tracker.refresh();
	release();
	await Promise.all([scan, concurrent]);
	assert.equal(tracker.model.files.length, 2);
});

test("worktree porcelain preserves unusual directory names and detached fallback", () => {
	assert.deepEqual(parseWorktrees("worktree /a\nbranch strange\0HEAD abc\0detached\0\0"), [{ root: "/a\nbranch strange" }]);
});

test("registered roots remain scannable during metadata discovery failure", async () => {
	let code = 128;
	const tracker = new WorktreeChangesTracker(async () => ({ stdout: "worktree /repo\0\0", code }), () => async (args) => ({ stdout: args[0] === "status" ? "?? new.ts\0" : "", code: 0 }), undefined, () => ["/repo"]);
	await tracker.start();
	assert.equal(tracker.worktrees.length, 1);
	code = 0;
	await tracker.refresh();
	assert.equal(tracker.worktrees.length, 1);
});

test("isolated Git worktrees include preexisting dirty files only after root registration", async (t) => {
	const temporary = await mkdtemp(join(tmpdir(), "gentle-shell-worktrees-"));
	// Every repository, linked root and Git configuration belongs to this fixture.
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const fixture = await realpath(temporary);
	const main = join(fixture, "main");
	const linked = join(fixture, "linked space");
	const clean = join(fixture, "clean");
	const untracked = join(fixture, "untracked");
	const empty = join(fixture, "empty");
	const config = join(fixture, "gitconfig");
	await mkdir(empty);
	await writeFile(config, "");
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	env.GIT_CONFIG_GLOBAL = config;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_ATTR_NOSYSTEM = "1";
	const exec = promisify(execFile);
	const gitAt = (root: string) => async (args: string[]) => {
		const { stdout } = await exec("git", [
			"--no-optional-locks", "-C", root,
			"-c", `core.hooksPath=${empty}`,
			"-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
			...args,
		], { env });
		return { stdout, code: 0 };
	};
	await gitAt(fixture)(["init", "--initial-branch=main", `--template=${empty}`, main]);
	await gitAt(main)(["config", "user.name", "Shell Test"]);
	await gitAt(main)(["config", "user.email", "shell-test@example.invalid"]);
	await writeFile(join(main, "same.ts"), "export const value = 1;\n");
	await gitAt(main)(["add", "same.ts"]);
	await gitAt(main)(["commit", "-m", "Initial fixture"]);
	await gitAt(main)(["worktree", "add", "-b", "linked", linked]);
	await gitAt(main)(["worktree", "add", "-b", "clean", clean]);

	// Discovery starts from a linked root, not the clone's primary worktree.
	const registered = [main, linked, clean];
	const tracker = new WorktreeChangesTracker(gitAt(linked), gitAt, undefined, () => registered);
	await tracker.start();
	assert.deepEqual(tracker.worktrees, [], "all clean roots are hidden");
	await writeFile(join(main, "same.ts"), "export const value = 2;\n");
	await writeFile(join(linked, "same.ts"), "export const value = 3;\n");
	await tracker.refresh();
	assert.deepEqual(new Set(tracker.worktrees.map((tree) => tree.root)), new Set([main, linked]));
	assert.deepEqual(tracker.worktrees.map((tree) => tree.model.files[0].path), ["same.ts", "same.ts"]);
	assert.equal(new Set(tracker.model.files.map((file) => file.path)).size, 2, "aggregate paths distinguish the two roots");

	await gitAt(main)(["worktree", "add", "-b", "untracked", untracked]);
	await writeFile(join(untracked, "notes.md"), "New worktree content\n");
	await tracker.refresh();
	assert.equal(tracker.worktrees.length, 2, "a new dirty sibling stays hidden until registered");
	registered.push(untracked);
	await tracker.refresh();
	assert.deepEqual(new Set(tracker.worktrees.map((tree) => tree.root)), new Set([main, linked, untracked]));
	assert.deepEqual(tracker.worktrees.find((tree) => tree.root === untracked)?.model.files, [file("notes.md", 0, 0, CHANGE_STATUS.UNTRACKED)]);
	assert.ok(!tracker.worktrees.some((tree) => tree.root === clean), "unchanged linked root remains hidden");
});

test("untracked-only unborn roots remain visible without a HEAD diff", async () => {
	const tracker = new ChangesTracker(async (args) => ({ stdout: args[0] === "status" ? "?? first.ts\0" : "", code: args[0] === "status" ? 0 : 128 }), async () => 2);
	await tracker.start();
	assert.deepEqual(tracker.model.files, [file("first.ts", 2, 0, CHANGE_STATUS.UNTRACKED)]);
});

test("ChangesTracker counts the lines of untracked files, which git numstat leaves out", async () => {
	const { git } = fakeGit(["", ""], ["", "?? notes.md\0?? empty.md\0"]);
	const counted: string[] = [];
	const tracker = new ChangesTracker(git, async (path) => {
		counted.push(path);
		return path === "notes.md" ? 3 : 0;
	});
	await tracker.start();
	const model = await tracker.refresh();
	assert.deepEqual(model.files, [file("empty.md", 0, 0, CHANGE_STATUS.UNTRACKED), file("notes.md", 3, 0, CHANGE_STATUS.UNTRACKED)]);
	assert.equal(model.added, 3);
	assert.deepEqual(counted, ["notes.md", "empty.md"]);
});
