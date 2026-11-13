import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonFor } from "../lib/codegraph-daemon.ts";
import { lockPathFor, readLeaseVerdict } from "../lib/codegraph-lease.ts";
import {
	indexState,
	maybeRewarm,
	planIndexAction,
	prepareReadiness,
	skipsSession,
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
