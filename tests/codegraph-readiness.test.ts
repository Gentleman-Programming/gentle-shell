import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonFor } from "../lib/codegraph-daemon.ts";
import { lockPathFor, readLeaseVerdict } from "../lib/codegraph-lease.ts";
import {
	childWorktreeNeedsIndex,
	indexState,
	maybeRewarm,
	planIndexAction,
	prepareReadiness,
	runCodegraph,
	sessionSkipsReadiness,
	skipsSession,
	SYNC_RETRY_DELAY_MS,
	syncBeforeSearch,
	warmUpDaemon,
	type ReadinessInput,
	type SearchSyncInput,
	type SessionStartReason,
} from "../lib/codegraph-readiness.ts";

function dir(t: test.TestContext, name: string): string {
	const cwd = mkdtempSync(join(tmpdir(), `gentle-codegraph-readiness-${name}-`));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

function writeDb(cwd: string): void {
	mkdirSync(join(cwd, ".codegraph"));
	writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
}

/** git that fails the test WITH stderr instead of swallowing it. */
function git(args: readonly string[], cwd: string): void {
	const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} in ${cwd} failed (${result.status}): ${result.stderr ?? result.error ?? "no stderr"}`);
	}
}

/** A main checkout with a tracked marker file and an index, plus a linked worktree of it. */
function worktreePair(t: test.TestContext): { main: string; worktree: string } {
	const main = mkdtempSync(join(tmpdir(), "gentle-codegraph-readiness-worktree-"));
	git(["init", "-b", "main"], main);
	// The marker is committed in main so `git worktree add` copies it: planIndexAction needs it for init.
	writeFileSync(join(main, "package.json"), "{}\n");
	const fixtureGit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
	git([...fixtureGit, "add", "package.json"], main);
	git([...fixtureGit, "commit", "-m", "fixture"], main);
	// A unique name per test: a leftover worktree from a crashed run must never
	// collide with the next one (git worktree add refuses an existing path).
	const worktree = join(dirname(main), `readiness-worktree-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	git(["worktree", "add", "-b", "feature", worktree], main);
	// Direct removal, not `git worktree remove`: after-hooks may run after the
	// main repo is already gone, and the repo's own cleanup drops the registration.
	t.after(() => {
		rmSync(worktree, { recursive: true, force: true });
		rmSync(main, { recursive: true, force: true });
	});
	writeDb(main);
	return { main, worktree };
}

/** Writes one daemon-registry record for a project into `registry`. */
function fakeRegistryRecord(registry: string, root: string, socketPath: string, pid: number, startedAt = 1): void {
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root, socketPath, startedAt, pid }));
}

/** A ReadinessInput whose run and warm are counters; nothing real is spawned. */
function fakeInput(cwd: string, overrides: Partial<ReadinessInput> = {}): ReadinessInput {
	return {
		cwd,
		env: {},
		reason: "startup" as SessionStartReason,
		isProjectRoot: () => true,
		run: async () => true,
		warm: async () => true,
		...overrides,
	};
}

/** Lets a detached background job settle before its effects are asserted. */
function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

test("indexState: the database file is the index, not the directory", (t) => {
	const present = dir(t, "present");
	writeDb(present);
	assert.equal(indexState(present), "present");

	const bare = dir(t, "bare");
	mkdirSync(join(bare, ".codegraph"));
	assert.equal(indexState(bare), "absent", "a directory without the database file is not an index");

	assert.equal(indexState(dir(t, "none")), "absent");
});

test("indexState: an access error is unknown, not absent", (t) => {
	// Windows ACLs do not map a chmod 000 to a statSync denial (the same guard the
	// lease suite's unreadable-token test uses), so the access-error path cannot be
	// exercised there: the test is POSIX-only.
	if (process.platform === "win32") return;
	const cwd = mkdtempSync(join(tmpdir(), "gentle-codegraph-readiness-denied-"));
	mkdirSync(join(cwd, ".codegraph"));
	writeFileSync(join(cwd, ".codegraph", "codegraph.db"), "index");
	chmodSync(join(cwd, ".codegraph"), 0o000);
	t.after(() => {
		chmodSync(join(cwd, ".codegraph"), 0o755);
		rmSync(cwd, { recursive: true, force: true });
	});
	assert.equal(indexState(cwd), "unknown");
});

test("planIndexAction: present syncs, unknown does nothing, markers decide init", (t) => {
	const present = dir(t, "plan-present");
	writeDb(present);
	assert.equal(planIndexAction(present, "present", () => false), "sync");
	assert.equal(planIndexAction(present, "unknown", () => true), "none");

	const fresh = dir(t, "plan-fresh");
	assert.equal(planIndexAction(fresh, "absent", () => false), "none", "not a project root");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	assert.equal(planIndexAction(fresh, "absent", () => true), "init");
	assert.equal(planIndexAction(dir(t, "plan-bare"), "absent", () => true), "none", "no marker file");
});

test("skipsSession: a child or a reload never starts index work", () => {
	assert.equal(skipsSession({ GENTLE_PI_AGENTS_CHILD: "1" }, "startup"), true);
	assert.equal(skipsSession({}, "reload"), true);
	assert.equal(skipsSession({}, "startup"), false);
});

test("prepareReadiness: an existing index is synced and then warmed", async (t) => {
	const cwd = dir(t, "sync-ok");
	writeDb(cwd);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["run:unlock", "run:sync -q", "warm"], "a sync is always preceded by an unlock");
});

test("prepareReadiness: a live daemon syncs without unlocking; a dead one keeps unlock-then-sync", async (t) => {
	const cwd = dir(t, "sync-live-daemon");
	writeDb(cwd);
	const registry = dir(t, "sync-live-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		registryDir: registry,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["run:sync -q", "warm"], "a live daemon holds the writer lock: only the sync runs");

	const deadCwd = dir(t, "sync-dead-daemon");
	writeDb(deadCwd);
	const deadCalls: string[] = [];
	await prepareReadiness(fakeInput(deadCwd, {
		registryDir: dir(t, "sync-dead-registry"),
		run: async (args) => {
			deadCalls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(deadCalls, ["run:unlock", "run:sync -q"], "no live daemon: the stale-lock clear still precedes the sync");
});

test("prepareReadiness: a failed unlock prevents the sync, a failed sync still warms", async (t) => {
	const locked = dir(t, "unlock-fail");
	writeDb(locked);
	const calls: string[] = [];
	const unlocked = await prepareReadiness(fakeInput(locked, {
		run: async () => {
			calls.push("run");
			return false;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(unlocked, { action: "sync", ok: false, warm: "ok" }, "the index still exists, so it is warmed");
	assert.deepEqual(calls, ["run", "warm"], "the unlock failed, so the sync never ran");

	const synced = dir(t, "sync-fail");
	writeDb(synced);
	const syncCalls: string[] = [];
	const failedSync = await prepareReadiness(fakeInput(synced, {
		run: async (args) => {
			syncCalls.push(`run:${args[0]}`);
			return args[0] === "unlock";
		},
		warm: async () => true,
	}));
	assert.deepEqual(failedSync, { action: "sync", ok: false, warm: "ok" }, "a failed sync leaves an index to warm");
	assert.deepEqual(syncCalls, ["run:unlock", "run:sync"], "the unlock succeeded, so the sync ran and failed");

	const fresh = dir(t, "init-fail");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const warmCalls: string[] = [];
	const failedInit = await prepareReadiness(fakeInput(fresh, {
		run: async () => false,
		warm: async () => {
			warmCalls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(failedInit, { action: "init", ok: false, warm: "skipped" }, "a failed init leaves nothing worth warming");
	assert.deepEqual(warmCalls, []);
});

test("prepareReadiness: an init that succeeds warms; a child or reload does nothing", async (t) => {
	const fresh = dir(t, "init-ok");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(fresh, {
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["run:init -y", "warm"]);

	const childCalls: string[] = [];
	const child = await prepareReadiness(fakeInput(fresh, {
		env: { GENTLE_PI_AGENTS_CHILD: "1" },
		run: async (args) => {
			childCalls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(child, { action: "none", ok: true, warm: "skipped" });
	assert.deepEqual(childCalls, []);
});

test("prepareReadiness: an unknown index state or a non-project runs nothing", async (t) => {
	const unknown = dir(t, "unknown");
	const unknownResult = await prepareReadiness(fakeInput(unknown, { isProjectRoot: () => false }));
	assert.deepEqual(unknownResult, { action: "none", ok: true, warm: "skipped" });

	const notRoot = dir(t, "not-root");
	writeFileSync(join(notRoot, "package.json"), "{}\n");
	const notRootResult = await prepareReadiness(fakeInput(notRoot, { isProjectRoot: () => false }));
	assert.deepEqual(notRootResult, { action: "none", ok: true, warm: "skipped" });
});

test("prepareReadiness: concurrent runs for one project are deduped in-process", async (t) => {
	const cwd = dir(t, "dedupe");
	writeDb(cwd);
	let runs = 0;
	const input: ReadinessInput = fakeInput(cwd, {
		run: async (args) => {
			if (args[0] === "sync") runs += 1;
			await new Promise((resolve) => setTimeout(resolve, 20));
			return true;
		},
		warm: async () => true,
	});
	const [first, second] = await Promise.all([prepareReadiness(input), prepareReadiness(input)]);
	assert.equal(runs, 1, "one sync serves both callers");
	assert.deepEqual(first, second);
});

test("daemonFor: newest live daemon wins and its registered spelling is returned", (t) => {
	const cwd = dir(t, "daemon");
	const registry = dir(t, "registry");
	const alias = join(registry, "alias");
	symlinkSync(cwd, alias);
	const liveSocket = join(registry, "live.sock");
	writeFileSync(liveSocket, "");
	writeFileSync(join(registry, "one.json"), JSON.stringify({ root: alias, socketPath: liveSocket, startedAt: 2, pid: process.pid }));
	writeFileSync(join(registry, "two.json"), JSON.stringify({ root: cwd, socketPath: join(registry, "missing.sock"), startedAt: 1, pid: process.pid }));

	const daemon = daemonFor(cwd, registry);
	assert.equal(daemon.alive, true);
	assert.equal(daemon.root, alias, "the registered spelling keeps the warm-up on the existing daemon");

	const dead = daemonFor(cwd, join(registry, "empty"));
	assert.deepEqual(dead, { alive: false, root: undefined });
});

test("daemonFor: a dead pid is not alive, but its record still names the spelling", (t) => {
	const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	assert.ok(typeof exited.pid === "number" && exited.pid > 0);
	const cwd = dir(t, "daemon-dead");
	const registry = dir(t, "registry-dead");
	const socket = join(registry, "stale.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, exited.pid);

	const daemon = daemonFor(cwd, registry);
	assert.equal(daemon.alive, false);
	assert.equal(daemon.root, cwd, "a stale record still carries the spelling for the next warm-up");
});

test("maybeRewarm: warms in the background only when the daemon is not alive", async (t) => {
	const cwd = dir(t, "rewarm");
	const registry = dir(t, "rewarm-registry");
	const warmed: string[] = [];
	const warm = async (project: string) => {
		warmed.push(project);
		return true;
	};

	maybeRewarm(cwd, warm, registry);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(warmed, [cwd], "no daemon registered: one background warm for the cwd spelling");

	const liveSocket = join(registry, "live.sock");
	writeFileSync(liveSocket, "");
	fakeRegistryRecord(registry, cwd, liveSocket, process.pid);
	warmed.length = 0;
	maybeRewarm(cwd, warm, registry);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(warmed, [], "a live daemon needs no re-warm");
});

test("warmUpDaemon: a live daemon resolves true without spawning; a dead record still spawns", async (t) => {
	// Any spawn would fail: PATH holds nothing but an empty directory, so a true result can only
	// come from the liveness gate, and a spawn-path result is a fast false.
	const emptyBin = dir(t, "warm-empty-bin");
	const previousPath = process.env.PATH;
	process.env.PATH = emptyBin;
	t.after(() => {
		process.env.PATH = previousPath;
	});

	const cwd = dir(t, "warm-live");
	const registry = dir(t, "warm-live-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const startedAt = Date.now();
	const warmed = await warmUpDaemon(cwd, false, 5_000, registry);
	assert.equal(warmed, true, "a live daemon is already warm: no spawn, no handshake");
	assert.ok(Date.now() - startedAt < 5_000, "the resolution is immediate");

	const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	assert.ok(typeof exited.pid === "number" && exited.pid > 0);
	const deadCwd = dir(t, "warm-dead");
	const deadRegistry = dir(t, "warm-dead-registry");
	const staleSocket = join(deadRegistry, "stale.sock");
	writeFileSync(staleSocket, "");
	fakeRegistryRecord(deadRegistry, deadCwd, staleSocket, exited.pid);
	const dead = await warmUpDaemon(deadCwd, false, 5_000, deadRegistry);
	assert.equal(dead, false, "a dead record does not short-circuit: the spawn path ran and failed without codegraph on PATH");
});

test("warmUpDaemon: a timed-out warm-up kills its spawned child instead of leaking it", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "warm-timeout-bin");
	const pidFile = join(bin, "child.pid");
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nsleep 30\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
	});
	const warmed = await warmUpDaemon(dir(t, "warm-timeout"), false, 500);
	assert.equal(warmed, false, "the fake daemon never handshakes: the warm-up times out");
	const fileDeadline = Date.now() + 3_000;
	while (!existsSync(pidFile) && Date.now() < fileDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(existsSync(pidFile), "the fake daemon spawned");
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const deadline = Date.now() + 3_000;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(), false, "the timed-out warm-up child is killed, not leaked to hold the daemon lock");
});

test("runCodegraph: a timeout kills the command's whole process group, grandchildren included", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "tree-kill-bin");
	const pidFile = join(bin, "child.pid");
	const grandFile = join(bin, "grandchild.pid");
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nsleep 60 &\nprintf '%s\\n' \"$!\" > \"$FAKE_GRANDCHILD\"\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nwait\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	process.env.FAKE_GRANDCHILD = grandFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		delete process.env.FAKE_GRANDCHILD;
		for (const file of [pidFile, grandFile]) {
			if (!existsSync(file)) continue;
			try {
				process.kill(Number(readFileSync(file, "utf8").trim()), "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
	const ok = await runCodegraph(["sync", "-q"], dir(t, "tree-kill-cwd"), 500);
	assert.equal(ok, false, "the fake command never exits: the run times out");
	const fileDeadline = Date.now() + 3_000;
	while ((!existsSync(pidFile) || !existsSync(grandFile)) && Date.now() < fileDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(existsSync(pidFile) && existsSync(grandFile), "the fake command and its grandchild started");
	const pids = [Number(readFileSync(pidFile, "utf8").trim()), Number(readFileSync(grandFile, "utf8").trim())];
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const deadline = Date.now() + 3_000;
	while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(pids.map(alive), [false, false], "the direct child AND its grandchild die with the group kill");
});

test("syncBeforeSearch: unlock first, then sync -q; a failed sync reports only sync", async (t) => {
	const cwd = dir(t, "search-order");
	const calls: string[] = [];
	const failures: string[] = [];
	syncBeforeSearch({
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return args[0] === "unlock";
		},
		onFailed: (stage) => failures.push(stage),
	});
	await settled();
	assert.deepEqual(calls, ["unlock", "sync -q"]);
	assert.deepEqual(failures, ["sync"]);
});

test("syncBeforeSearch: a live daemon syncs only, never unlocked; no daemon keeps unlock+sync", async (t) => {
	const cwd = dir(t, "search-live-daemon");
	const registry = dir(t, "search-live-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	syncBeforeSearch({
		cwd,
		registryDir: registry,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	});
	await settled();
	assert.deepEqual(calls, ["sync -q"], "a live daemon holds the writer lock and is not stale: only the sync runs");

	const deadCwd = dir(t, "search-dead-daemon");
	const deadCalls: string[] = [];
	syncBeforeSearch({
		cwd: deadCwd,
		registryDir: dir(t, "search-dead-registry"),
		run: async (args) => {
			deadCalls.push(args.join(" "));
			return true;
		},
	});
	await settled();
	assert.deepEqual(deadCalls, ["unlock", "sync -q"], "no live daemon: the stale lock is still cleared first");
});

test("syncBeforeSearch: a failed unlock never runs the sync and reports only unlock", async (t) => {
	const cwd = dir(t, "search-unlock-fail");
	const calls: string[] = [];
	const failures: string[] = [];
	syncBeforeSearch({
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return false;
		},
		onFailed: (stage) => failures.push(stage),
	});
	await settled();
	assert.deepEqual(calls, ["unlock"], "the unlock failed, so the sync never ran");
	assert.deepEqual(failures, ["unlock"]);
});

test("syncBeforeSearch: concurrent calls for one cwd coalesce into a single unlock+sync", async (t) => {
	const cwd = dir(t, "search-coalesce");
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const run: SearchSyncInput["run"] = async (args) => {
		calls.push(args.join(" "));
		if (args[0] === "unlock") await gate;
		return true;
	};

	syncBeforeSearch({ cwd, run });
	syncBeforeSearch({ cwd, run });
	assert.deepEqual(calls, ["unlock"], "the second call starts no second job while one is in flight");

	release?.();
	await settled();
	assert.deepEqual(calls, ["unlock", "sync -q"], "exactly one unlock+sync sequence serves both callers");

	syncBeforeSearch({ cwd, run });
	await settled();
	assert.deepEqual(calls, ["unlock", "sync -q", "unlock", "sync -q"], "a settled job frees the cwd for the next turn");
});

test("syncBeforeSearch: a rejecting run never surfaces an unhandled rejection", async (t) => {
	const cwd = dir(t, "search-reject");
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));

	syncBeforeSearch({
		cwd,
		run: async () => {
			throw new Error("unlock exploded");
		},
	});
	await settled();

	assert.deepEqual(rejections, []);
});

test("prepareReadiness: a live sync lease in another session skips the sync but still warms", async (t) => {
	const cwd = dir(t, "sync-lease-live");
	writeDb(cwd);
	const locks = dir(t, "sync-lease-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), `${JSON.stringify({ kind: "sync", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })}\n`);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" }, "another session is refreshing: not a failure");
	assert.deepEqual(calls, ["warm"], "no unlock, no sync — the lease holder owns the refresh");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", locks)), "held-live", "the foreign lease is never stolen");
});

test("prepareReadiness: a damaged sync lease is a loud failure, not another session's refresh", async (t) => {
	const cwd = dir(t, "sync-lease-damaged");
	writeDb(cwd);
	const locks = dir(t, "sync-lease-damaged-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), "{not-json\n");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.equal(result.ok, false, "an unowned damaged token must not report the refresh as handled");
	assert.deepEqual(calls, [], "no unlock, no sync: nobody owns this refresh, and the failure says so");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", locks)), "unknown", "the damaged token stays untouched");
});

test("prepareReadiness: a mid-run exception surfaces as an error, not a silent skip", async (t) => {
	const cwd = dir(t, "sync-throws");
	writeDb(cwd);
	const locks = dir(t, "sync-throws-locks");
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async () => {
			throw new Error("boom: mid-run explosion");
		},
	}));
	assert.equal(result.ok, false);
	assert.equal(result.action, "none");
	assert.match(result.error ?? "", /boom: mid-run explosion/, "the collapsed exception carries its reason");
});

test("prepareReadiness: the daemon-less sync takes and releases the lease when it is free", async (t) => {
	const cwd = dir(t, "sync-lease-free");
	writeDb(cwd);
	const locks = dir(t, "sync-lease-free-locks");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["run:unlock", "run:sync -q"]);
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", locks)), "free", "the lease is released after the sync");
});

test("prepareReadiness: an init under another session's lock reports present once the database appears", async (t) => {
	const cwd = dir(t, "init-join");
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const locks = dir(t, "init-join-locks");
	writeFileSync(lockPathFor(cwd, "init", locks), `${JSON.stringify({ kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 600_000 })}\n`);
	const timer = setTimeout(() => writeDb(cwd), 30);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => true,
	}));
	clearTimeout(timer);
	assert.deepEqual(result, { action: "init", ok: true, warm: "ok" }, "the other session's init finished: joined, not failed");
	assert.deepEqual(calls, [], "this session never runs init");
});

test("prepareReadiness: a foreign init still running past the wait budget fails closed", async (t) => {
	const cwd = dir(t, "init-skip");
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const locks = dir(t, "init-skip-locks");
	writeFileSync(lockPathFor(cwd, "init", locks), `${JSON.stringify({ kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 600_000 })}\n`);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		initLockWaitMs: 10,
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(result, { action: "init", ok: false, warm: "skipped" }, "fail-closed: no second concurrent init");
	assert.deepEqual(calls, []);
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "init", locks)), "held-live", "skipped never steals");
});

test("syncBeforeSearch: a live sync lease in another session means zero CLI calls", async (t) => {
	const cwd = dir(t, "search-lease-live");
	const locks = dir(t, "search-lease-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), `${JSON.stringify({ kind: "sync", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })}\n`);
	const calls: string[] = [];
	const failures: string[] = [];
	syncBeforeSearch({
		cwd,
		locksDir: locks,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		onFailed: (stage) => failures.push(stage),
	});
	await settled();
	assert.deepEqual(calls, [], "no unlock, no sync: the live lease holder owns this refresh");
	assert.deepEqual(failures, []);
});

test("prepareReadiness: a linked worktree is seeded instead of initialized", async (t) => {
	const fresh = dir(t, "seed-ok");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(fresh, {
		seed: async () => ({ outcome: "seeded" }),
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["warm"], "no init ran: the seed produced the index");
});

test("prepareReadiness: seed outcomes target-exists, deferred, and the fall-backs", async (t) => {
	const exists = dir(t, "seed-exists");
	writeFileSync(join(exists, "package.json"), "{}\n");
	const existsCalls: string[] = [];
	const existsResult = await prepareReadiness(fakeInput(exists, {
		seed: async () => ({ outcome: "target-exists" }),
		run: async () => {
			existsCalls.push("run");
			return true;
		},
	}));
	assert.deepEqual(existsResult, { action: "init", ok: true, warm: "ok" });
	assert.deepEqual(existsCalls, [], "an existing index needs no init");

	const deferred = dir(t, "seed-deferred");
	writeFileSync(join(deferred, "package.json"), "{}\n");
	const deferredCalls: string[] = [];
	const deferredResult = await prepareReadiness(fakeInput(deferred, {
		seed: async () => ({ outcome: "deferred" }),
		run: async () => {
			deferredCalls.push("run");
			return true;
		},
		warm: async () => {
			deferredCalls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(deferredResult, { action: "init", ok: false, warm: "skipped" }, "another session owns creation: fail closed");
	assert.deepEqual(deferredCalls, [], "deferred runs neither init nor warm");

	for (const outcome of ["seed-failed", "not-seedable"] as const) {
		const fresh = dir(t, `seed-${outcome}`);
		writeFileSync(join(fresh, "package.json"), "{}\n");
		const calls: string[] = []
		const result = await prepareReadiness(fakeInput(fresh, {
			seed: async () => ({ outcome }),
			run: async (args) => {
				calls.push(`run:${args.join(" ")}`);
				return true;
			},
		}));
		assert.deepEqual(result, { action: "init", ok: true, warm: "ok" }, `${outcome} falls back to init`);
		assert.deepEqual(calls, ["run:init -y"], `${outcome} runs the ordinary init`);
	}
});

test("two real sessions racing one fresh project run exactly one init", async (t) => {
	const cwd = dir(t, "init-race");
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const locks = dir(t, "init-race-locks");
	const sandbox = dir(t, "init-race-child");
	const log = join(sandbox, "init.log");
	const script = join(sandbox, "child.mjs");
	writeFileSync(script, [
		'import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";',
		"const [libHref, project, locksDir, logPath] = process.argv.slice(2);",
		"const { prepareReadiness } = await import(libHref);",
		"await prepareReadiness({",
		"  cwd: project,",
		"  locksDir,",
		'  env: {}, reason: "startup",',
		"  isProjectRoot: () => true,",
		"  run: async (args) => {",
		'    if (args[0] === "init") {',
		"      appendFileSync(logPath, `init ${process.pid}\\n`);",
		"      await new Promise((resolve) => setTimeout(resolve, 200));",
		"      mkdirSync(`${project}/.codegraph`, { recursive: true });",
		'      writeFileSync(`${project}/.codegraph/codegraph.db`, "index");',
		"      return true;",
		"    }",
		"    return true;",
		"  },",
		"  warm: async () => true,",
		"});",
	].join("\n") + "\n");
	const libHref = new URL("../lib/codegraph-readiness.ts", import.meta.url).href;
	const closed = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve) => {
		child.on("close", (code: number | null) => resolve(code ?? -1));
	});
	const children = [spawn(process.execPath, [script, libHref, cwd, locks, log], { stdio: "ignore" }), spawn(process.execPath, [script, libHref, cwd, locks, log], { stdio: "ignore" })];
	const codes = await Promise.all(children.map(closed));
	assert.deepEqual(codes, [0, 0], "both sessions finish their readiness normally");
	const lines = readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 1, `exactly one init ran, got: ${lines.join(" | ")}`);
	assert.equal(indexState(cwd), "present", "the racing init produced the shared database");
});

test("prepareReadiness: a live CodeGraph writer lock means no unlock, no sync, and ok", async (t) => {
	const cwd = dir(t, "sync-writer-busy");
	writeDb(cwd);
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["warm"], "a live writer is never unlocked under");
});

test("syncBeforeSearch: a live CodeGraph writer lock means zero CLI calls", async (t) => {
	const cwd = dir(t, "search-writer-busy");
	writeDb(cwd);
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	const calls: string[] = [];
	syncBeforeSearch({
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	});
	await settled();
	assert.deepEqual(calls, [], "the live writer owns the refresh");
});

test("prepareReadiness: the init run receives the lock's adopt hook", async (t) => {
	const fresh = dir(t, "init-adopt");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const seen: Array<{ pid: number; proxy: boolean }> = [];
	const result = await prepareReadiness(fakeInput(fresh, {
		run: async (args, _cwd, _timeout, onSpawn) => {
			if (args[0] === "init") {
				assert.equal(typeof onSpawn, "function", "the init run can report its spawn");
				onSpawn?.(4242, false);
			}
			return true;
		},
		warm: async () => true,
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "ok" });
	assert.equal(seen.length, 0);
});

test("prepareReadiness: a main-busy seed stands down benignly with nothing to warm", async (t) => {
	const fresh = dir(t, "seed-main-busy");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(fresh, {
		seed: async () => ({ outcome: "main-busy" }),
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "skipped" }, "the busy main is not this session's failure");
	assert.deepEqual(calls, [], "no init, no warm: the main checkout owns the moment");
});

test("prepareReadiness: a failed sync beside a live daemon is retried once after a backoff", async (t) => {
	const cwd = dir(t, "sync-live-retry");
	writeDb(cwd);
	const registry = dir(t, "sync-live-retry-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	const sleeps: number[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		registryDir: registry,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return calls.filter((call) => call === "run:sync -q").length > 1;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(calls, ["run:sync -q", "run:sync -q"], "the failed first sync beside a live daemon is retried once");
	assert.deepEqual(sleeps, [SYNC_RETRY_DELAY_MS], "the retry waits exactly one backoff");
});

test("prepareReadiness: a sync failing twice beside a live daemon reports daemonAlive and the command info", async (t) => {
	const cwd = dir(t, "sync-live-fail");
	writeDb(cwd);
	const registry = dir(t, "sync-live-fail-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	const events: unknown[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		registryDir: registry,
		sleep: async () => {},
		run: async (args, _cwd, _timeoutMs, _onSpawn, onInfo) => {
			calls.push(`run:${args.join(" ")}`);
			if (args[0] === "sync") onInfo?.({ ok: false, exitCode: 1, stderrTail: "database is locked" });
			return false;
		},
		onIndexed: (indexed) => {
			events.push({ ...indexed });
		},
	}));
	assert.equal(result.ok, false);
	assert.equal(result.warm, "ok", "a failed sync still leaves an index to warm");
	assert.deepEqual(calls, ["run:sync -q", "run:sync -q"], "two sync attempts, then the failure is reported");
	assert.deepEqual(events, [{ action: "sync", ok: false, daemonAlive: true, exitCode: 1, stderrTail: "database is locked" }]);
});

test("prepareReadiness: without a live daemon unlock+sync stays single-shot and reports daemonAlive false", async (t) => {
	const cwd = dir(t, "sync-dead-single");
	writeDb(cwd);
	const calls: string[] = [];
	const sleeps: number[] = [];
	const events: unknown[] = [];
	await prepareReadiness(fakeInput(cwd, {
		registryDir: dir(t, "sync-dead-single-registry"),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return args[0] === "unlock";
		},
		onIndexed: (indexed) => {
			events.push({ ...indexed });
		},
	}));
	assert.deepEqual(calls, ["run:unlock", "run:sync -q"], "the daemon-less path is unchanged: unlock once, sync once");
	assert.deepEqual(sleeps, [], "the backoff belongs to the live-daemon branch only");
	assert.deepEqual(events, [{ action: "sync", ok: false, daemonAlive: false }]);
});

test("syncBeforeSearch: beside a live daemon a failed sync retries once; daemon-less failures carry daemonAlive false", async (t) => {
	const cwd = dir(t, "search-live-retry");
	const registry = dir(t, "search-live-retry-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	const sleeps: number[] = [];
	const failures: Array<{ stage: string; info: Record<string, unknown> }> = [];
	syncBeforeSearch({
		cwd,
		registryDir: registry,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		run: async (args, _cwd, _timeoutMs, _onSpawn, onInfo) => {
			calls.push(args.join(" "));
			if (args[0] === "sync") onInfo?.({ ok: false, exitCode: 2, stderrTail: "wedged" });
			return args[0] !== "sync" || calls.filter((call) => call === "sync -q").length > 1;
		},
		onFailed: (stage, info) => {
			failures.push({ stage, info: { ...info } });
		},
	});
	await settled();
	assert.deepEqual(calls, ["sync -q", "sync -q"], "the first failing sync is retried once beside a live daemon");
	assert.deepEqual(sleeps, [SYNC_RETRY_DELAY_MS]);
	assert.deepEqual(failures, [], "a successful retry reports nothing");

	const deadCwd = dir(t, "search-dead-detail");
	const deadFailures: Array<{ stage: string; info: Record<string, unknown> }> = [];
	syncBeforeSearch({
		cwd: deadCwd,
		registryDir: dir(t, "search-dead-detail-registry"),
		run: async (args) => args[0] === "unlock",
		onFailed: (stage, info) => {
			deadFailures.push({ stage, info: { ...info } });
		},
	});
	await settled();
	assert.deepEqual(deadFailures, [{ stage: "sync", info: { daemonAlive: false } }], "daemon-less failures report daemonAlive false");
});

test("childWorktreeNeedsIndex: only a child in its own unindexed linked worktree needs an index", (t) => {
	const plain = dir(t, "child-plain");
	writeFileSync(join(plain, "package.json"), "{}\n");
	assert.equal(childWorktreeNeedsIndex({}, plain), false, "not a child");
	assert.equal(childWorktreeNeedsIndex({ GENTLE_PI_AGENTS_CHILD: "1" }, plain), false, "a child in a plain directory shares its parent's project");

	const { worktree } = worktreePair(t);
	writeDb(worktree);
	assert.equal(childWorktreeNeedsIndex({ GENTLE_PI_AGENTS_CHILD: "1" }, worktree), false, "the worktree already carries its own index");
});

test("sessionSkipsReadiness: a child in its own unindexed linked worktree is the only un-skipped child", (t) => {
	const { main, worktree } = worktreePair(t);
	const child = { GENTLE_PI_AGENTS_CHILD: "1" };
	assert.equal(sessionSkipsReadiness(child, "startup", worktree), false, "that worktree's index is nobody else's job");
	assert.equal(sessionSkipsReadiness(child, "reload", worktree), true, "reload dominates: /reload is not a new session");
	assert.equal(sessionSkipsReadiness({}, "startup", main), false, "an ordinary session is never skipped");
	assert.equal(sessionSkipsReadiness({ GENTLE_PI_AGENTS_CHILD: "0" }, "startup", worktree), false, "only \"1\" is a child: an ordinary session in a worktree still runs readiness");
	writeDb(worktree);
	assert.equal(sessionSkipsReadiness(child, "startup", worktree), true, "once the index exists the child skips again");
});

test("prepareReadiness: a child in its own unindexed linked worktree seeds and never warms", async (t) => {
	const { worktree } = worktreePair(t);
	const calls: string[] = [];
	const seeded: string[] = [];
	const events: string[] = [];
	const result = await prepareReadiness(fakeInput(worktree, {
		env: { GENTLE_PI_AGENTS_CHILD: "1" },
		seed: async (workspace) => {
			seeded.push(workspace);
			return { outcome: "seeded" };
		},
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
		onIndexed: (indexed) => {
			events.push(indexed.action);
		},
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "skipped" }, "a child seeds or initialises only; it never warms a daemon");
	assert.deepEqual(seeded, [worktree], "the un-skipped child seeds its own worktree");
	assert.deepEqual(calls, [], "no init and no warm ran");
	assert.deepEqual(events, ["init"], "onIndexed still reports the finished index");
});

test("prepareReadiness: a child reload or an indexed worktree still skips entirely", async (t) => {
	const { worktree } = worktreePair(t);
	const calls: string[] = [];
	const reload = await prepareReadiness(fakeInput(worktree, {
		env: { GENTLE_PI_AGENTS_CHILD: "1" },
		reason: "reload",
		seed: async () => {
			calls.push("seed");
			return { outcome: "seeded" };
		},
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(reload, { action: "none", ok: true, warm: "skipped" }, "reload dominates the child exception");
	assert.deepEqual(calls, []);

	writeDb(worktree);
	const indexedCalls: string[] = [];
	const indexed = await prepareReadiness(fakeInput(worktree, {
		env: { GENTLE_PI_AGENTS_CHILD: "1" },
		seed: async () => {
			indexedCalls.push("seed");
			return { outcome: "seeded" };
		},
		run: async (args) => {
			indexedCalls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(indexed, { action: "none", ok: true, warm: "skipped" }, "once the index exists the child skips entirely again");
	assert.deepEqual(indexedCalls, [], "no seed, no sync: the child skips");
});
