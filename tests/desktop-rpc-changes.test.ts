import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import shell, { shellGitRunner, shellUntrackedLines, type ShellDeps } from "../extensions/gentle-shell.ts";
import { loadFileDiff } from "../lib/change-diff.ts";
import {
	CHANGE_NOT_FOUND,
	CHANGES_UNAVAILABLE,
	capDesktopDiff,
	DESKTOP_CHANGE_DIFF_MAX_BYTES,
	DESKTOP_CHANGE_ROOT_FALLBACK_LABEL,
	DESKTOP_CHANGES_FILE_LIMIT,
	DESKTOP_CHANGES_METHODS,
	DESKTOP_CHANGES_SERVICE_CHANNEL,
	DESKTOP_CHANGES_SERVICE_SCHEMA,
	desktopChangeRootLabel,
	INVALID_CHANGES_PARAMS,
	isDesktopChangesServiceShape,
	isPlausibleChangePath,
	parseDesktopChangesRead,
	parseGetChangeDiffParams,
	parseGetChangesParams,
	projectDesktopChanges,
	projectDesktopDiff,
} from "../lib/desktop-rpc-changes.ts";
import { DesktopChangesBridge } from "../lib/desktop-changes-service.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { CHANGE_STATUS, changesModel, DIFF_MAX_BYTES, DIFF_TOO_LARGE, type GitRunner } from "../lib/shell-changes.ts";

// #3322: `get_changes` and `get_change_diff` read the `/gentle:changes`
// owner (the shell's WorktreeChangesTracker and the shared loadFileDiff
// arguments). A diff is served only for a file in the owner's current change
// set for that root; everything else is `not_found`.

// ---- Pure contract ----

test("root labels are the directory name, never an absolute path", () => {
	assert.equal(desktopChangeRootLabel("/home/me/work/project"), "project");
	assert.equal(desktopChangeRootLabel("C:\\Users\\me\\project\\"), "project");
	assert.equal(desktopChangeRootLabel("C:/Users/me/wt-1"), "wt-1");
	assert.equal(desktopChangeRootLabel("/"), DESKTOP_CHANGE_ROOT_FALLBACK_LABEL);
	assert.equal(desktopChangeRootLabel("C:\\"), DESKTOP_CHANGE_ROOT_FALLBACK_LABEL);
});

test("implausible request paths are refused before the owner is asked", () => {
	for (const path of ["file.ts", "lib/a b.ts", "dir/.hidden", "..foo", "a..b/c"]) assert.equal(isPlausibleChangePath(path), true, path);
	for (const path of ["", "../outside", "lib/../../x", "lib\\..\\x", "/etc/passwd", "\\\\server\\share", "C:\\Windows\\win.ini", "c:/x", "a\0b", "a\nb", "x".repeat(4097)]) {
		assert.equal(isPlausibleChangePath(path), false, JSON.stringify(path.slice(0, 40)));
	}
});

test("params parsers accept only the documented shapes", () => {
	assert.deepEqual(parseGetChangesParams({}), { ok: true });
	assert.deepEqual(parseGetChangesParams({ root: "r" }), { error: INVALID_CHANGES_PARAMS });
	assert.deepEqual(parseGetChangeDiffParams({ root: "root-1", path: "a.ts" }), { root: "root-1", path: "a.ts" });
	for (const params of [{}, { root: "r" }, { path: "a" }, { root: 1, path: "a" }, { root: "r", path: ["a"] }, { root: "r", path: "a", extra: true }]) {
		assert.deepEqual(parseGetChangeDiffParams(params as Record<string, unknown>), { error: INVALID_CHANGES_PARAMS }, JSON.stringify(params));
	}
});

test("projectDesktopChanges uses opaque ids, keeps root-relative paths, and caps files at the feed limit", () => {
	const files = Array.from({ length: DESKTOP_CHANGES_FILE_LIMIT + 5 }, (_, index) => ({ path: `f${String(index).padStart(4, "0")}.ts`, added: 1, deleted: 0, status: CHANGE_STATUS.MODIFIED }));
	const read = projectDesktopChanges([
		{ root: "/abs/one", branch: "main", model: changesModel(files.slice(0, 3)) },
		{ root: "/abs/two", model: changesModel(files.slice(3)) },
	], (root) => (root === "/abs/one" ? "root-1" : "root-2"));
	assert.deepEqual(read.roots, [{ id: "root-1", label: "one" }, { id: "root-2", label: "two" }]);
	assert.equal(read.files.length, DESKTOP_CHANGES_FILE_LIMIT);
	assert.equal(read.truncated, true);
	assert.deepEqual(read.files[0], { root: "root-1", path: "f0000.ts", status: "modified", added: 1, deleted: 0 });
	assert.equal(read.files[3]!.root, "root-2");
	assert.doesNotMatch(JSON.stringify(read), /\/abs\//);
	assert.equal(projectDesktopChanges([], () => "x").truncated, false);
});

test("capDesktopDiff bounds UTF-8 bytes on a line or character boundary", () => {
	assert.deepEqual(capDesktopDiff("small\n"), { diff: "small\n", truncated: false });
	const lines = "+line\n".repeat(DESKTOP_CHANGE_DIFF_MAX_BYTES);
	const capped = capDesktopDiff(lines);
	assert.equal(capped.truncated, true);
	assert.ok(Buffer.byteLength(capped.diff) <= DESKTOP_CHANGE_DIFF_MAX_BYTES);
	assert.ok(capped.diff.endsWith("\n") && lines.startsWith(capped.diff));
	// One long line of multi-byte characters is cut between characters.
	const wide = capDesktopDiff("é".repeat(10), 5);
	assert.deepEqual(wide, { diff: "éé", truncated: true });
	const exact = "a".repeat(DESKTOP_CHANGE_DIFF_MAX_BYTES);
	assert.deepEqual(capDesktopDiff(exact), { diff: exact, truncated: false });
});

test("projectDesktopDiff answers only for a Git diff that completed or hit its bound", () => {
	assert.deepEqual(projectDesktopDiff({ stdout: "d", code: 0 }), { diff: "d", truncated: false });
	assert.deepEqual(projectDesktopDiff({ stdout: "d", code: 1 }), { diff: "d", truncated: false });
	assert.deepEqual(projectDesktopDiff({ stdout: "partial", code: 1, truncated: true }), { diff: "partial", truncated: true });
	assert.equal(projectDesktopDiff({ stdout: "fatal: bad", code: 128 }), undefined);
	assert.equal(projectDesktopDiff({ stdout: "d", code: 1, timedOut: true }), undefined);
});

test("parseDesktopChangesRead rebuilds the owner answer and refuses leaky shapes", () => {
	const good = { roots: [{ id: "root-1", label: "repo", extra: "/abs" }], files: [{ root: "root-1", path: "a.ts", status: "untracked", added: 2, deleted: 0, cwd: "/abs" }], truncated: false };
	assert.deepEqual(parseDesktopChangesRead(good), { roots: [{ id: "root-1", label: "repo" }], files: [{ root: "root-1", path: "a.ts", status: "untracked", added: 2, deleted: 0 }], truncated: false });
	assert.equal(parseDesktopChangesRead({ ...good, roots: [{ id: "root-1", label: "/home/me/repo" }] }), undefined, "an absolute label never crosses");
	assert.equal(parseDesktopChangesRead({ ...good, files: [{ ...good.files[0], root: "root-9" }] }), undefined);
	assert.equal(parseDesktopChangesRead({ ...good, files: [{ ...good.files[0], path: "/abs/a.ts" }] }), undefined);
	assert.equal(parseDesktopChangesRead({ ...good, files: [{ ...good.files[0], status: "weird" }] }), undefined);
	assert.equal(parseDesktopChangesRead({ ...good, files: [{ ...good.files[0], added: -1 }] }), undefined);
	assert.equal(parseDesktopChangesRead({ ...good, truncated: "no" }), undefined);
	assert.equal(parseDesktopChangesRead(undefined), undefined);
});

test("isDesktopChangesServiceShape accepts only the versioned adapter", () => {
	const ok = { schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: async () => undefined, diff: async () => ({ kind: "not_found" }), dispose() {} };
	assert.equal(isDesktopChangesServiceShape(ok), true);
	assert.equal(isDesktopChangesServiceShape({ ...ok, schema: "other/v1" }), false);
	assert.equal(isDesktopChangesServiceShape({ ...ok, diff: undefined }), false);
	assert.equal(isDesktopChangesServiceShape(null), false);
});

// ---- Bridge: parse before owner work, typed errors, no raw leaks ----

function bridgeWith(service: Record<string, unknown> | undefined) {
	let discoveries = 0;
	const bridge = new DesktopChangesBridge({} as ExtensionAPI, { discover: async () => { discoveries += 1; return service as never; } });
	bridge.attach({} as never);
	return { bridge, discoveries: () => discoveries };
}

test("malformed params and implausible paths never reach the owner", async () => {
	const { bridge, discoveries } = bridgeWith({ schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: async () => { throw new Error("must not read"); }, diff: async () => { throw new Error("must not diff"); }, dispose() {} });
	assert.deepEqual(await bridge.handle("get_changes", { x: 1 }), { ok: false, error: INVALID_CHANGES_PARAMS });
	assert.deepEqual(await bridge.handle("get_change_diff", { root: "root-1" }), { ok: false, error: INVALID_CHANGES_PARAMS });
	for (const path of ["../secret", "/etc/passwd", "C:\\Windows\\win.ini", "a/../../b"]) {
		assert.deepEqual(await bridge.handle("get_change_diff", { root: "root-1", path }), { ok: false, error: CHANGE_NOT_FOUND }, path);
	}
	assert.deepEqual(await bridge.handle("get_change_diff", { root: "", path: "a.ts" }), { ok: false, error: CHANGE_NOT_FOUND });
	assert.equal(discoveries(), 0, "no owner discovery for a request that can never be served");
	assert.equal(await bridge.handle("list_jobs", {}), undefined, "other methods fall through");
});

test("a missing, throwing, or malformed owner answers changes_unavailable without raw detail", async () => {
	assert.deepEqual(await bridgeWith(undefined).bridge.handle("get_changes", {}), { ok: false, error: CHANGES_UNAVAILABLE });
	const throwing = bridgeWith({ schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: async () => { throw new Error("git failed in /home/me/secret"); }, diff: async () => { throw new Error("/home/me/secret"); }, dispose() {} }).bridge;
	assert.deepEqual(await throwing.handle("get_changes", {}), { ok: false, error: CHANGES_UNAVAILABLE });
	assert.deepEqual(await throwing.handle("get_change_diff", { root: "root-1", path: "a.ts" }), { ok: false, error: CHANGES_UNAVAILABLE });
	const malformed = bridgeWith({ schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: async () => ({ roots: [{ id: "r", label: "/home/me/repo" }], files: [], truncated: false }), diff: async () => ({ kind: "ok", diff: 5 }), dispose() {} }).bridge;
	assert.deepEqual(await malformed.handle("get_changes", {}), { ok: false, error: CHANGES_UNAVAILABLE });
	assert.deepEqual(await malformed.handle("get_change_diff", { root: "r", path: "a.ts" }), { ok: false, error: CHANGES_UNAVAILABLE });
	const detached = new DesktopChangesBridge({} as ExtensionAPI, { discover: async () => { throw new Error("unreachable"); } });
	assert.deepEqual(await detached.handle("get_changes", {}), { ok: false, error: CHANGES_UNAVAILABLE }, "no attached session");
});

test("the bridge re-applies the diff bound to an owner answer", async () => {
	const big = "+x\n".repeat(DESKTOP_CHANGE_DIFF_MAX_BYTES);
	const { bridge } = bridgeWith({ schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: async () => undefined, diff: async () => ({ kind: "ok", diff: big, truncated: false }), dispose() {} });
	const outcome = await bridge.handle("get_change_diff", { root: "root-1", path: "a.ts" }) as { ok: true; data: { diff: string; truncated: boolean } };
	assert.equal(outcome.data.truncated, true);
	assert.ok(Buffer.byteLength(outcome.data.diff) <= DESKTOP_CHANGE_DIFF_MAX_BYTES);
});

test("a reset while the owner works drops the stale answer and disposes the adapter", async () => {
	let release!: () => void;
	let disposed = 0;
	const service = { schema: DESKTOP_CHANGES_SERVICE_SCHEMA, read: () => new Promise((resolve) => { release = () => resolve({ roots: [], files: [], truncated: false }); }), diff: async () => ({ kind: "not_found" }), dispose() { disposed += 1; } };
	const { bridge } = bridgeWith(service);
	const pending = bridge.handle("get_changes", {});
	await new Promise((resolve) => setTimeout(resolve, 5));
	bridge.reset();
	release();
	assert.deepEqual(await pending, { ok: false, error: CHANGES_UNAVAILABLE });
	assert.equal(disposed, 1);
});

// ---- Transport with the real owner: gentle-shell + gentle-desktop-rpc ----

function tempRepo(t: test.TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rpc-changes-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
	git("init", "-q", "--initial-branch=main");
	writeFileSync(join(root, "file.ts"), "base\n");
	writeFileSync(join(root, "clean.ts"), "committed and unchanged\n");
	git("add", "file.ts", "clean.ts");
	git("commit", "-q", "-m", "base");
	return { root, git };
}

type RunnerFor = (cwd: string, maxBuffer?: number) => GitRunner;
const realGit: RunnerFor = (cwd, maxBuffer) => shellGitRunner(cwd, process.env, undefined, maxBuffer);

function app(t: test.TestContext, root: string, options: Pick<Partial<ShellDeps>, "changesLineCache" | "changesCacheDirectory"> & { gitRunner?: RunnerFor; withOwner?: boolean } = {}) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const entries: unknown[] = [];
	const handlers = new Map<string, Function[]>();
	const listeners = new Map<string, Function[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi: any = {
		on: (key: string, fn: Function) => handlers.set(key, [...(handlers.get(key) ?? []), fn]),
		events: {
			on: (key: string, fn: Function) => { listeners.set(key, [...(listeners.get(key) ?? []), fn]); return () => {}; },
			emit: (key: string, data: unknown) => listeners.get(key)?.forEach((fn) => fn(data)),
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerCommand: (key: string, registration: any) => commands.set(key, registration),
	};
	let gitCalls = 0;
	if (options.withOwner !== false) {
		const runner = options.gitRunner ?? realGit;
		shell(pi, { GENTLE_PI_SHELL_CHANGES_POLL_MS: "60000", GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off" }, {
			resolveWorktree: () => ({ root, commonDir: join(root, ".git") }),
			devBinary: () => undefined,
			...(options.changesLineCache ? { changesLineCache: options.changesLineCache } : {}),
			changesCacheDirectory: options.changesCacheDirectory,
			gitRunner: (cwd, maxBuffer) => { const run = runner(cwd, maxBuffer); return (args) => { gitCalls += 1; return run(args); }; },
		});
	}
	desktopRpc(pi as ExtensionAPI);
	const lines: string[] = [];
	const ctx: any = {
		mode: "rpc", hasUI: true, cwd: root,
		sessionManager: { getSessionId: () => "session", getEntries: () => entries },
		ui: {
			setFooter() {}, getEditorComponent: () => ({}), setWorkingVisible() {}, notify() {},
			setWidget: (key: string, value: string[] | undefined) => { if (key === DESKTOP_RPC_WIDGET && value) lines.push(...value); },
		},
	};
	const fire = async (key: string) => { for (const fn of handlers.get(key) ?? []) await fn({}, ctx); };
	let sequence = 0;
	return {
		root, ctx, lines, fire, listeners, gitCalls: () => gitCalls,
		async call(method: string, params: Record<string, unknown> = {}) {
			const before = lines.length;
			await commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: `req-${++sequence}`, method, params }), ctx);
			const published = lines.slice(before).map((line) => JSON.parse(line));
			assert.equal(published.length, 1, `${method} publishes exactly one line: its response, never an event`);
			assert.equal(published[0].kind, "response");
			return published[0] as { ok: boolean; data?: any; error?: { code: string; message: string } };
		},
	};
}

const pathVariants = (root: string) => [root, root.replace(/\\/g, "/"), root.replace(/\\/g, "\\\\")];

test("capabilities advertise get_changes and get_change_diff and no changes event", async (t) => {
	const repo = tempRepo(t);
	const a = app(t, repo.root);
	await a.fire("session_start");
	const response = await a.call("capabilities");
	for (const method of DESKTOP_CHANGES_METHODS) assert.ok(response.data.methods.includes(method), method);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"], "reads advertise no event");
	await a.fire("session_shutdown");
});

test("get_changes lists the owner's change set with opaque roots and root-relative paths", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	mkdirSync(join(repo.root, "lib"));
	writeFileSync(join(repo.root, "lib", "new.ts"), "one\ntwo\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const response = await a.call("get_changes");
	assert.equal(response.ok, true);
	assert.equal(response.data.roots.length, 1);
	const [root] = response.data.roots;
	assert.equal(root.label, repo.root.split(/[\\/]/).pop());
	assert.deepEqual(response.data, {
		roots: [{ id: root.id, label: root.label }],
		files: [
			{ root: root.id, path: "file.ts", status: "modified", added: 1, deleted: 1 },
			{ root: root.id, path: "lib/new.ts", status: "untracked", added: 2, deleted: 0 },
		],
		truncated: false,
	});
	const wire = JSON.stringify(response);
	for (const variant of pathVariants(repo.root)) assert.ok(!wire.includes(variant), "no absolute root on the wire");
	assert.ok(!wire.includes(tmpdir().replace(/\\/g, "\\\\")) && !wire.includes(tmpdir().replace(/\\/g, "/")), "no temp directory on the wire");
	await a.fire("session_shutdown");
});

test("session shutdown flushes injected Changes counts for the next Desktop session", async (t) => {
	const repo = tempRepo(t);
	const cache = mkdtempSync(join(tmpdir(), "gentle-desktop-counts-"));
	t.after(() => rmSync(cache, { recursive: true, force: true }));
	const changesCacheDirectory = join(cache, "untracked");
	writeFileSync(join(repo.root, "new.txt"), "a\nb\n");
	const cold = app(t, repo.root, { changesCacheDirectory });
	await cold.fire("session_start");
	const first = await cold.call("get_changes");
	assert.equal(first.ok, true);
	assert.equal(first.data.files[0].added, 2);
	await cold.fire("session_shutdown");
	assert.equal(existsSync(changesCacheDirectory), true);

	let readCalls = 0;
	const warm = app(t, repo.root, { changesCacheDirectory, changesLineCache: (directory) => shellUntrackedLines({
		lstat: async (path) => (await import("node:fs/promises")).lstat(path),
		read: async () => { readCalls++; throw Error("unchanged file should not be read"); },
	}, undefined, directory) });
	await warm.fire("session_start");
	const second = await warm.call("get_changes");
	assert.equal(second.ok, true);
	assert.deepEqual(second.data.files.map(({ root: _root, ...file }: { root: string }) => file), [
		{ path: "new.txt", status: "untracked", added: 2, deleted: 0 },
	]);
	assert.equal(readCalls, 0);
	await warm.fire("session_shutdown");
});

test("get_changes completes one more scan when files exceed a single budget", async (t) => {
	const repo = tempRepo(t);
	const a = app(t, repo.root);
	const paths = Array.from({ length: 65 }, (_, i) => `n${String(i).padStart(2, "0")}.txt`);
	const first = join(repo.root, paths[0]);
	writeFileSync(first, Buffer.alloc(DIFF_MAX_BYTES, 10));
	for (const path of paths.slice(1)) linkSync(first, join(repo.root, path));
	await a.fire("session_start");
	t.after(() => a.fire("session_shutdown"));
	const response = await a.call("get_changes");
	assert.equal(response.ok, true);
	assert.equal(response.data.files.length, paths.length);
	assert.equal(response.data.files.filter((file: { added: number }) => file.added === DIFF_MAX_BYTES).length, paths.length);
	const [root] = response.data.roots;
	assert.deepEqual(response.data, {
		roots: [root],
		files: paths.map((path) => ({ root: root.id, path, status: "untracked", added: DIFF_MAX_BYTES, deleted: 0 })),
		truncated: false,
	});
});

test("get_changes marks counts still pending at its bound and clears the markers on a later read", async (t) => {
	const repo = tempRepo(t);
	const paths = ["a.txt", "b.txt", "c.txt", "d.txt"];
	for (const path of paths) writeFileSync(join(repo.root, path), "x\n");
	const a = app(t, repo.root, { changesLineCache: () => shellUntrackedLines(undefined, 2) });
	await a.fire("session_start");
	t.after(() => a.fire("session_shutdown"));
	const first = await a.call("get_changes");
	assert.equal(first.ok, true);
	assert.equal(first.data.countsPending, true);
	const [root] = first.data.roots;
	const file = (path: string, added: number) => ({ root: root.id, path, status: "untracked", added, deleted: 0 });
	const pending = first.data.files.filter((entry: { countsPending?: true }) => entry.countsPending).map((entry: { path: string }) => entry.path);
	assert.equal(pending.length, 2);
	assert.deepEqual(first.data, {
		roots: [root],
		files: paths.map((path) => pending.includes(path) ? { ...file(path, 0), countsPending: true } : file(path, 1)),
		truncated: false,
		countsPending: true,
	});
	const later = await a.call("get_changes");
	assert.equal(later.ok, true);
	assert.deepEqual(later.data, { roots: [root], files: paths.map((path) => file(path, 1)), truncated: false });
});

test("get_change_diff serves exactly the panel's diff for tracked and untracked files", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	writeFileSync(join(repo.root, "new.ts"), "hello\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const listed = await a.call("get_changes");
	const root = listed.data.roots[0].id as string;
	const panelRun = realGit(repo.root, DIFF_MAX_BYTES);

	const tracked = await a.call("get_change_diff", { root, path: "file.ts" });
	assert.deepEqual(tracked, { schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId: "req-2", ok: true, data: { root, path: "file.ts", diff: await loadFileDiff(panelRun, { path: "file.ts", added: 1, deleted: 1, status: CHANGE_STATUS.MODIFIED }), truncated: false } });
	assert.match(tracked.data.diff, /-base\n\+changed\n/);

	const untracked = await a.call("get_change_diff", { root, path: "new.ts" });
	assert.equal(untracked.ok, true);
	assert.equal(untracked.data.diff, await loadFileDiff(panelRun, { path: "new.ts", added: 1, deleted: 0, status: CHANGE_STATUS.UNTRACKED }));
	assert.match(untracked.data.diff, /\+hello\n/);
	assert.equal(untracked.data.truncated, false);
	for (const variant of pathVariants(repo.root)) assert.ok(!JSON.stringify(untracked).includes(variant), "nothing beyond the diff text: no absolute path");
	assert.doesNotMatch(JSON.stringify(untracked.data), /git (diff|-C)/, "no Git command on the wire");
	await a.fire("session_shutdown");
});

test("get_change_diff answers not_found for anything outside the owner's change set", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rpc-outside-")));
	t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
	const outside = join(outsideDir, "secret.txt");
	writeFileSync(outside, "TOP-SECRET-OUTSIDE\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const listed = await a.call("get_changes");
	const root = listed.data.roots[0].id as string;
	const cases: Array<[string, Record<string, unknown>]> = [
		["unknown root", { root: "root-99", path: "file.ts" }],
		["absolute root instead of the id", { root: repo.root, path: "file.ts" }],
		["label instead of the id", { root: listed.data.roots[0].label, path: "file.ts" }],
		["exists on disk but is not in the change set", { root, path: "clean.ts" }],
		["Git metadata", { root, path: ".git/config" }],
		["does not exist", { root, path: "missing.ts" }],
		["traversal out of the root", { root, path: `../${outsideDir.split(/[\\/]/).pop()}/secret.txt` }],
		["traversal back into the set", { root, path: "lib/../file.ts" }],
		["absolute path outside", { root, path: outside }],
		["absolute path of a listed file", { root, path: join(repo.root, "file.ts") }],
		["forward-slash absolute path of a listed file", { root, path: join(repo.root, "file.ts").replace(/\\/g, "/") }],
		["dot-prefixed alias", { root, path: "./file.ts" }],
		["backslash alias", { root, path: ".\\file.ts" }],
		["case variant", { root, path: "FILE.ts" }],
		["trailing space", { root, path: "file.ts " }],
	];
	for (const [name, params] of cases) {
		const response = await a.call("get_change_diff", params);
		assert.equal(response.ok, false, name);
		assert.deepEqual(response.error, CHANGE_NOT_FOUND, name);
		assert.ok(!JSON.stringify(response).includes("TOP-SECRET"), name);
	}
	await a.fire("session_shutdown");
});

test("a link in the worktree never serves the content outside the root it points at", async (t) => {
	const repo = tempRepo(t);
	const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rpc-link-")));
	t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
	writeFileSync(join(outsideDir, "secret.txt"), "TOP-SECRET-LINKED\n");
	// A directory link is a junction on Windows (no privilege needed); a file
	// symlink may be refused there without Developer Mode.
	try {
		symlinkSync(outsideDir, join(repo.root, "linkdir"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		t.skip(`directory links unavailable here: ${(error as NodeJS.ErrnoException).code}`);
		return;
	}
	try { symlinkSync(join(outsideDir, "secret.txt"), join(repo.root, "link.txt"), "file"); } catch { /* file symlinks need privilege on Windows */ }
	const a = app(t, repo.root);
	await a.fire("session_start");
	const listed = await a.call("get_changes");
	const root = listed.data.roots[0].id as string;
	const paths = listed.data.files.map((file: { path: string }) => file.path);
	// Git for Windows lists files behind a junction as untracked files of the
	// tree, so the change set itself can name them; the diff must still refuse.
	if (process.platform === "win32") assert.ok(paths.includes("linkdir/secret.txt"), "the junction case is exercised here");
	for (const path of ["linkdir/secret.txt", "link.txt/../linkdir/secret.txt", "linkdir/../file.ts"]) {
		const response = await a.call("get_change_diff", { root, path });
		assert.deepEqual(response.error, CHANGE_NOT_FOUND, path);
	}
	if (paths.includes("link.txt")) {
		const response = await a.call("get_change_diff", { root, path: "link.txt" });
		assert.ok(!JSON.stringify(response).includes("TOP-SECRET"), "a symlink diff is the link, never its target's content");
	}
	await a.fire("session_shutdown");
});

test("a diff past 256 KiB is cut with truncated, and one past the panel bound still answers its head", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "medium.txt"), "+medium line of text\n".repeat(16_000));
	writeFileSync(join(repo.root, "huge.txt"), "huge line of text that repeats\n".repeat(40_000));
	const a = app(t, repo.root);
	await a.fire("session_start");
	const root = (await a.call("get_changes")).data.roots[0].id as string;
	const panelRun = realGit(repo.root, DIFF_MAX_BYTES);

	const medium = await a.call("get_change_diff", { root, path: "medium.txt" });
	const panelMedium = await loadFileDiff(panelRun, { path: "medium.txt", added: 16_000, deleted: 0, status: CHANGE_STATUS.UNTRACKED });
	assert.ok(Buffer.byteLength(panelMedium) > DESKTOP_CHANGE_DIFF_MAX_BYTES, "fixture is past the Desktop bound but within the panel's");
	assert.equal(medium.data.truncated, true);
	assert.ok(Buffer.byteLength(medium.data.diff) <= DESKTOP_CHANGE_DIFF_MAX_BYTES);
	assert.ok(panelMedium.startsWith(medium.data.diff), "the cut diff is the head of the panel's diff");

	const huge = await a.call("get_change_diff", { root, path: "huge.txt" });
	assert.equal(await loadFileDiff(panelRun, { path: "huge.txt", added: 40_000, deleted: 0, status: CHANGE_STATUS.UNTRACKED }), DIFF_TOO_LARGE, "the panel shows its notice");
	assert.equal(huge.data.truncated, true);
	assert.ok(Buffer.byteLength(huge.data.diff) <= DESKTOP_CHANGE_DIFF_MAX_BYTES);
	assert.match(huge.data.diff, /^diff --git/);
	await a.fire("session_shutdown");
});

test("a clean repository is an empty success, not changes_unavailable", async (t) => {
	const repo = tempRepo(t);
	const a = app(t, repo.root);
	await a.fire("session_start");
	const response = await a.call("get_changes");
	assert.equal(response.ok, true);
	assert.deepEqual(response.data, { roots: [], files: [], truncated: false });
	assert.deepEqual((await a.call("get_change_diff", { root: "root-1", path: "file.ts" })).error, CHANGE_NOT_FOUND);
	await a.fire("session_shutdown");
});

test("get_changes caps files at the feed limit with truncated", async (t) => {
	const repo = tempRepo(t);
	for (let index = 0; index < DESKTOP_CHANGES_FILE_LIMIT + 3; index += 1) writeFileSync(join(repo.root, `n${String(index).padStart(3, "0")}.txt`), "x\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const response = await a.call("get_changes");
	assert.equal(response.data.files.length, DESKTOP_CHANGES_FILE_LIMIT);
	assert.equal(response.data.truncated, true);
	await a.fire("session_shutdown");
});

test("changes_unavailable when there is no owner, no worktree, or Git fails", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");

	const ownerless = app(t, repo.root, { withOwner: false });
	await ownerless.fire("session_start");
	assert.deepEqual((await ownerless.call("get_changes")).error, CHANGES_UNAVAILABLE);
	assert.deepEqual((await ownerless.call("get_change_diff", { root: "root-1", path: "file.ts" })).error, CHANGES_UNAVAILABLE);

	const statusFails = app(t, repo.root, { gitRunner: (cwd, max) => { const run = realGit(cwd, max); return async (args) => args[0] === "status" ? { stdout: "fatal: /secret/path", code: 128 } : run(args); } });
	await statusFails.fire("session_start");
	const failed = await statusFails.call("get_changes");
	assert.deepEqual(failed.error, CHANGES_UNAVAILABLE);
	assert.ok(!JSON.stringify(failed).includes("/secret/path"));
	await statusFails.fire("session_shutdown");

	const diffFails = app(t, repo.root, { gitRunner: (cwd, max) => { const run = realGit(cwd, max); return async (args) => args.includes("diff") && !args.includes("--numstat") ? { stdout: "fatal: /secret/path", code: 128 } : run(args); } });
	await diffFails.fire("session_start");
	const root = (await diffFails.call("get_changes")).data.roots[0].id as string;
	const diffFailed = await diffFails.call("get_change_diff", { root, path: "file.ts" });
	assert.deepEqual(diffFailed.error, CHANGES_UNAVAILABLE);
	assert.ok(!JSON.stringify(diffFailed).includes("/secret/path"));
	await diffFails.fire("session_shutdown");

	const nonRepo = realpathSync(mkdtempSync(join(tmpdir(), "gentle-rpc-norepo-")));
	t.after(() => rmSync(nonRepo, { recursive: true, force: true }));
	const noWorktree = app(t, nonRepo, { gitRunner: () => async () => ({ stdout: "", code: 128 }) });
	await noWorktree.fire("session_start");
	assert.deepEqual((await noWorktree.call("get_changes")).error, CHANGES_UNAVAILABLE);
	await noWorktree.fire("session_shutdown");
});

test("invalid params are typed invalid_request through the transport, before any Git work", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const before = a.gitCalls();
	assert.deepEqual((await a.call("get_changes", { all: true })).error, INVALID_CHANGES_PARAMS);
	assert.deepEqual((await a.call("get_change_diff", { root: "root-1" })).error, INVALID_CHANGES_PARAMS);
	assert.deepEqual((await a.call("get_change_diff", { root: "root-1", path: 7 })).error, INVALID_CHANGES_PARAMS);
	assert.deepEqual((await a.call("get_change_diff", { root: "root-1", path: "../x" })).error, CHANGE_NOT_FOUND);
	assert.equal(a.gitCalls(), before, "a refused request runs no Git");
	await a.fire("session_shutdown");
});

test("the owner answers discovery only for its own live session", async (t) => {
	const repo = tempRepo(t);
	const a = app(t, repo.root);
	await a.fire("session_start");
	assert.equal(a.listeners.get(DESKTOP_CHANGES_SERVICE_CHANNEL)?.length, 1, "one owner listens");
	const answers: unknown[] = [];
	const foreign = { ...a.ctx, sessionManager: { getSessionId: () => "other-session", getEntries: () => [] } };
	a.listeners.get(DESKTOP_CHANGES_SERVICE_CHANNEL)![0]!({ context: foreign, respond: (service: unknown) => answers.push(service) });
	assert.equal(answers.length, 0, "a different session is never answered");
	await a.fire("session_shutdown");
	a.listeners.get(DESKTOP_CHANGES_SERVICE_CHANNEL)![0]!({ context: a.ctx, respond: (service: unknown) => answers.push(service) });
	assert.equal(answers.length, 0, "a shut-down session is never answered");
});

// ---- Hardening: repository-configured drivers, the git dir, and verifier probes ----

const linkDir = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
const unlinkDirs = (paths: string[]) => { for (const path of paths) { try { rmdirSync(path); } catch { /* already gone */ } } };

function scratchDir(t: test.TestContext, prefix: string) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("get_change_diff never runs a repository textconv driver; the panel path is unchanged", async (t) => {
	const repo = tempRepo(t);
	const scratch = scratchDir(t, "gentle-rpc-driver-");
	const marker = join(scratch, "marker.txt");
	const script = join(scratch, "driver.sh");
	const posix = (path: string) => path.split("\\").join("/");
	writeFileSync(script, `#!/bin/sh\necho ran >> '${posix(marker)}'\ncat "$1"\n`);
	writeFileSync(join(repo.root, ".gitattributes"), "*.txt diff=evil\n");
	writeFileSync(join(repo.root, "a.txt"), "one\n");
	repo.git("add", ".gitattributes", "a.txt");
	repo.git("commit", "-q", "-m", "attr");
	repo.git("config", "diff.evil.textconv", `sh '${posix(script)}'`);
	writeFileSync(join(repo.root, "a.txt"), "two\n");
	const runs = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
	const a = app(t, repo.root);
	await a.fire("session_start");
	const root = (await a.call("get_changes")).data.roots[0].id as string;
	const diff = await a.call("get_change_diff", { root, path: "a.txt" });
	assert.equal(diff.ok, true);
	assert.match(diff.data.diff, /-one\n\+two\n/);
	assert.equal(runs(), 0, "the RPC diff never executes the repository's textconv command");
	await a.fire("session_shutdown");
	await loadFileDiff(realGit(repo.root, DIFF_MAX_BYTES), { path: "a.txt", added: 1, deleted: 1, status: CHANGE_STATUS.MODIFIED });
	assert.ok(runs() > 0, "the panel's default call is exactly as before (it still honors the driver)");
});

test("a junction to the git dir inside the root is never served", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	try {
		linkDir(join(repo.root, ".git"), join(repo.root, "g"));
	} catch (error) {
		t.skip(`directory links unavailable here: ${(error as NodeJS.ErrnoException).code}`);
		return;
	}
	t.after(() => unlinkDirs([join(repo.root, "g")]));
	const a = app(t, repo.root);
	await a.fire("session_start");
	const listed = await a.call("get_changes");
	const root = listed.data.roots[0].id as string;
	const paths = listed.data.files.map((file: { path: string }) => file.path);
	if (process.platform === "win32") assert.ok(paths.includes("g/config"), "Git lists the aliased git dir: the case is exercised");
	for (const path of ["g/config", "g/HEAD", "g/refs/heads/main"]) {
		const response = await a.call("get_change_diff", { root, path });
		assert.deepEqual(response.error, CHANGE_NOT_FOUND, path);
	}
	assert.equal((await a.call("get_change_diff", { root, path: "file.ts" })).ok, true, "ordinary files still answer");
	await a.fire("session_shutdown");
});

test("P1: odd Windows and URL path forms are not_found and leak nothing", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const root = (await a.call("get_changes")).data.roots[0].id as string;
	for (const path of ["file.ts.", "file.ts::$DATA", "file.ts:x", "FILE~1.TS", "file%2Ets", "file.ts\0", "\\\\?\\" + join(repo.root, "file.ts"), "//?/C:/x", "\\\\localhost\\c$\\x", "x/".repeat(3000) + "file.ts", "file.ts/", "File.ts", "./file.ts"]) {
		const response = await a.call("get_change_diff", { root, path });
		assert.deepEqual(response.error, CHANGE_NOT_FOUND, JSON.stringify(path.slice(0, 30)));
		for (const variant of pathVariants(repo.root)) assert.ok(!JSON.stringify(response).includes(variant));
	}
	await a.fire("session_shutdown");
});

test("P2: a root id from a previous session is not_found", async (t) => {
	const repo = tempRepo(t);
	writeFileSync(join(repo.root, "file.ts"), "changed\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const root = (await a.call("get_changes")).data.roots[0].id as string;
	await a.fire("session_shutdown");
	await a.fire("session_start");
	assert.deepEqual((await a.call("get_change_diff", { root, path: "file.ts" })).error, CHANGE_NOT_FOUND);
	await a.fire("session_shutdown");
});

test("P3: a directory swapped to a junction after listing is refused, nested links too", async (t) => {
	const repo = tempRepo(t);
	const outside = scratchDir(t, "gentle-rpc-swap-");
	writeFileSync(join(outside, "secret.txt"), "TOP-SECRET-SWAP\n");
	const moved = scratchDir(t, "gentle-rpc-moved-");
	mkdirSync(join(repo.root, "sub"));
	writeFileSync(join(repo.root, "sub", "secret.txt"), "inside\n");
	mkdirSync(join(repo.root, "u"));
	writeFileSync(join(repo.root, "u", "secret.txt"), "inside-untracked\n");
	repo.git("add", "sub");
	repo.git("commit", "-q", "-m", "sub");
	writeFileSync(join(repo.root, "sub", "secret.txt"), "inside changed\n");
	const a = app(t, repo.root);
	await a.fire("session_start");
	const root = (await a.call("get_changes")).data.roots[0].id as string;
	renameSync(join(repo.root, "sub"), join(moved, "sub"));
	renameSync(join(repo.root, "u"), join(moved, "u"));
	try {
		linkDir(outside, join(repo.root, "sub"));
		linkDir(outside, join(repo.root, "u"));
	} catch (error) {
		t.skip(`directory links unavailable here: ${(error as NodeJS.ErrnoException).code}`);
		return;
	}
	mkdirSync(join(repo.root, "a", "b"), { recursive: true });
	linkDir(outside, join(repo.root, "a", "b", "j"));
	t.after(() => unlinkDirs([join(repo.root, "sub"), join(repo.root, "u"), join(repo.root, "a", "b", "j")]));
	for (const path of ["sub/secret.txt", "u/secret.txt", "a/b/j/secret.txt"]) {
		const response = await a.call("get_change_diff", { root, path });
		assert.ok(!JSON.stringify(response).includes("TOP-SECRET"), path);
		assert.equal(response.ok, false, path);
	}
	await a.fire("session_shutdown");
});
