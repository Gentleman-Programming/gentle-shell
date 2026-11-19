import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { daemonFor } from "../lib/codegraph-daemon.ts";
import { clearCodegraphResolveCache } from "../lib/codegraph-cli-resolve.ts";
import { lockPathFor, readLeaseVerdict } from "../lib/codegraph-lease.ts";
import {
	buildWindowsCommand,
	childWorktreeNeedsIndex,
	indexState,
	killWindowsTree,
	maybeRewarm,
	planIndexAction,
	prepareReadiness,
	runCodegraph,
	runCodegraphSeedSync,
	sessionSkipsReadiness,
	setTreeKillSeamForTests,
	skipsSession,
	spawnCodegraph,
	SYNC_RETRY_DELAY_MS,
	SYNC_TIMEOUT_MS,
	syncBeforeSearch,
	warmUpDaemon,
	type ReadinessInput,
	type SearchSyncInput,
	type SessionStartReason,
	type SpawnCodegraphSeam,
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

/** Whether this process really cannot traverse a chmod-000 directory: root on Linux (and any
 * other DAC-bypass context) still can, so the permission-denial fixtures would exercise the
 * wrong branch there. Probes with the same statSync indexState uses and reports whether
 * traversal is denied, so the callers can skip with a clear reason when it is not. */
function directoryTraversalDenied(): boolean {
	const probe = mkdtempSync(join(tmpdir(), "gentle-codegraph-readiness-deny-probe-"));
	const denied = join(probe, "denied");
	mkdirSync(denied);
	writeFileSync(join(denied, "codegraph.db"), "index");
	chmodSync(denied, 0o000);
	let traversalDenied: boolean;
	try {
		traversalDenied = !statSync(join(denied, "codegraph.db")).isFile();
	} catch {
		traversalDenied = true;
	}
	try {
		chmodSync(denied, 0o755);
	} catch {
		/* root traversal still allows the restore */
	}
	rmSync(probe, { recursive: true, force: true });
	return traversalDenied;
}

/** Whether a killed pid is really gone: a container whose PID 1 never reaps orphans leaves a
 * terminated child a zombie — kill(pid, 0) still succeeds there, but a zombie can neither run
 * nor write. /proc's state field recognizes it as terminated on Linux; elsewhere kill(pid, 0)
 * is the whole answer, and a pid still capable of running keeps failing the test. */
function processRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	if (process.platform !== "linux") return true;
	try {
		const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
	} catch {
		return true;
	}
}

/** How many times the non-Linux settlement probe re-asks `ps` for the pid's state: a probe
 * spawned on a loaded host can itself fail, which says nothing about the pid, and a process
 * already answered by the kernel's kill probe must not be reported as a survivor because one
 * `ps` call did not run. A pid that can still run answers every probe with a live state, so
 * the retries cost it nothing but a few milliseconds. */
const SETTLEMENT_STATE_PROBES = 5;

/** Whether a ps state sample reports a terminated process. The rule is the leading Z: macOS
 * appends the flag letters the entry carries (ZN, Z+), so an exact Z comparison rejects a real
 * zombie, and an empty sample is no sample at all. */
function psStateSaysGone(state: string): boolean {
	return state.startsWith("Z");
}

/** The errno of a signal-0 probe on pid, or undefined while the probe still answers. Only
 * ESRCH is proof the pid is gone: any other failure says nothing about the pid. */
function signalZeroErrno(pid: number): string | undefined {
	try {
		process.kill(pid, 0);
		return undefined;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code;
	}
}

/** Whether a descendant is already dead at the moment the run's result settles — the strict
 * oracle the settlement assertions need, unlike the polled processRunning. A reparented
 * orphan the group SIGKILL killed stays enumerable as a zombie until init reaps it, and a
 * zombie can neither run nor write: gone means ESRCH, or terminated-but-unreaped (state Z
 * from /proc on Linux, from ps elsewhere). A pid that is still executing fails this check. */
async function goneAtSettlement(pid: number): Promise<boolean> {
	if (!processRunning(pid)) return true;
	if (process.platform === "linux") return false;
	for (let probe = 0; probe < SETTLEMENT_STATE_PROBES; probe += 1) {
		const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { timeout: 2_000 });
		const text = (state.stdout ?? "").toString().trim();
		if (state.status === 0 && text !== "") return psStateSaysGone(text);
		// An unusable sample says nothing about the pid, but one macOS reaped between the kill probe
		// and this ps answers ESRCH: the only answer that is proof of death, not noise.
		if (signalZeroErrno(pid) === "ESRCH") return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return false;
}

/** Collects the pids a fake command publishes about itself, and samples each one's liveness
 * the moment the run settles — through a reaction registered before the polling starts. A
 * liveness sample taken after the settlement would grant a killed descendant a grace window
 * the settlement assertions are meant to forbid, and a collector that wakes late can equally
 * miss a survivor that exits a beat after the result. A run that settles before its pid files
 * are observable fails the startup premise instead of lending the assertions a post-settlement
 * wait. */
async function descendantPids(run: Promise<boolean>, files: readonly string[]): Promise<{ pids: number[]; gone: boolean[] }> {
	const published = (file: string): number | undefined => {
		if (!existsSync(file)) return undefined;
		const pid = Number(readFileSync(file, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	};
	let settled = false;
	const captured = new Map<string, boolean>();
	const settleSample = async () => {
		settled = true;
		for (const file of files) {
			const pid = published(file);
			if (pid !== undefined && !captured.has(file)) captured.set(file, await goneAtSettlement(pid));
		}
	};
	const settledRun = run.then(settleSample);
	const deadline = Date.now() + 3_000;
	while (!settled && files.some((file) => published(file) === undefined) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	await settledRun;
	assert.ok(files.every((file) => published(file) !== undefined), "the fake command and its descendants published their pids before the run settled");
	assert.ok(files.every((file) => captured.has(file)), "the settlement reaction observed every required pid: a run that settles before its pid files are observable fails the startup premise");
	return {
		pids: files.map((file) => published(file)!),
		gone: files.map((file) => captured.get(file)!),
	};
}

/** Kills a fake tree whose real kill a seam diverted away: the spawned command leads its own
 * process group (detached), so the negative pid reaches the loop's \`sleep\` children as well —
 * a survivor holding the inherited stdio would keep the runner's process alive after the test
 * ends, and the settlement assertions deliberately leave the tree running. */
function killFakeTreePid(pid: number): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* no such group: the leader already went */
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* already gone */
	}
}

/** Teardown backstop: reads the published pid when the file still exists and delegates. The
 * body kills the tree itself while the file is provably present — a registered directory
 * cleanup may already have removed it by hook time. */
function killFakeTree(pidFile: string): void {
	if (!existsSync(pidFile)) return;
	killFakeTreePid(Number(readFileSync(pidFile, "utf8").trim()));
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
	if (!directoryTraversalDenied()) return t.skip("this process traverses chmod-000 directories (root or another DAC-bypass context): the access-error path cannot be exercised");
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

test("planIndexAction: a symlinked .codegraph directory is never synced automatically", (t) => {
	const real = dir(t, "plan-symlink-real");
	writeDb(real);
	const linked = dir(t, "plan-symlink-linked");
	symlinkSync(join(real, ".codegraph"), join(linked, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
	// indexState follows the link to "present"; the plan must not turn that into a sync: CodeGraph
	// would follow the link too and write this workspace's files into the linked checkout's index.
	assert.equal(planIndexAction(linked, "present", () => true), "none", "the same unsafe directory the explicit tool refuses is never auto-synced");
	assert.equal(planIndexAction(real, "present", () => false), "sync", "a regular .codegraph directory keeps its sync");
});

test("planIndexAction: a linked .codegraph without a database is never initialized either", (t) => {
	const real = dir(t, "plan-link-empty-real");
	mkdirSync(join(real, ".codegraph"));
	writeFileSync(join(real, "package.json"), "{}\n");
	const linked = dir(t, "plan-link-empty-linked");
	writeFileSync(join(linked, "package.json"), "{}\n");
	symlinkSync(join(real, ".codegraph"), join(linked, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
	// indexState follows the link: a target without a database reports "absent", and init -y
	// would create the other checkout's database through that link — the plan must refuse it.
	assert.equal(indexState(linked), "absent");
	assert.equal(planIndexAction(linked, "absent", () => true), "none", "an empty linked index directory is not this workspace's to initialize");
	assert.equal(planIndexAction(real, "absent", () => true), "init", "a genuinely absent index in a regular directory still allows init");
});

test("skipsSession: a child or a reload never starts index work", () => {
	assert.equal(skipsSession({ GENTLE_PI_AGENTS_CHILD: "1" }, "startup"), true);
	assert.equal(skipsSession({}, "reload"), true);
	assert.equal(skipsSession({}, "startup"), false);
});

test("prepareReadiness: seed failure exposes its diagnostic without initializing", async (t) => {
	const cwd = dir(t, "seed-diagnostic");
	writeFileSync(join(cwd, "package.json"), "{}");
	const error = "CodeGraph seed publication requires hard links; use a worktree filesystem that supports hard links.";
	let runs = 0;
	let warms = 0;
	const result = await prepareReadiness(fakeInput(cwd, {
		seed: async () => ({ outcome: "seed-failed", error }),
		run: async () => { runs += 1; return true; },
		warm: async () => { warms += 1; return true; },
	}));
	assert.deepEqual(result, { action: "init", ok: false, warm: "skipped", error });
	assert.equal(runs, 0);
	assert.equal(warms, 0);
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
	assert.deepEqual(calls, ["run:sync -q", "warm"], "the daemon-less refresh runs the sync alone: no unlock ever removes a live owner's lock");
});

test("prepareReadiness: a live daemon syncs without unlocking; a dead one runs the same plain sync", async (t) => {
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
	assert.deepEqual(deadCalls, ["run:sync -q"], "no live daemon: the lease holder refreshes with the sync alone");
});

test("prepareReadiness: a failed daemon-less sync still warms; a failed init does not", async (t) => {
	const synced = dir(t, "sync-fail");
	writeDb(synced);
	const syncCalls: string[] = [];
	const failedSync = await prepareReadiness(fakeInput(synced, {
		run: async (args) => {
			syncCalls.push(`run:${args[0]}`);
			return false;
		},
		warm: async () => true,
	}));
	assert.deepEqual(failedSync, { action: "sync", ok: false, warm: "ok" }, "a failed sync leaves an index to warm");
	assert.deepEqual(syncCalls, ["run:sync"], "only the sync ran: no unlock precedes it any more");

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
	writeFileSync(join(unknown, "package.json"), "{}\n");
	// A real non-ENOENT stat error for the database: only that makes indexState say "unknown",
	// where an empty directory would just read "absent" and exercise the non-project branch.
	const runs: string[] = [];
	const dbPath = join(unknown, ".codegraph", "codegraph.db");
	const realStatSync = fsSync.statSync;
	t.mock.method(fsSync, "statSync", ((...args: Parameters<typeof fsSync.statSync>) => {
		if (String(args[0]) === dbPath) {
			const denied = new Error("simulated unreadable index") as NodeJS.ErrnoException;
			denied.code = "EACCES";
			throw denied;
		}
		return realStatSync(...args);
	}) as typeof fsSync.statSync);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const unknownResult = await prepareReadiness(fakeInput(unknown, {
		isProjectRoot: () => true,
		run: async (args) => {
			runs.push(args.join(" "));
			return true;
		},
	}));
	assert.deepEqual(unknownResult, { action: "none", ok: true, warm: "skipped" });
	assert.deepEqual(runs, [], "an index state that cannot be confirmed runs neither sync nor init");

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

test("prepareReadiness: a reload followed by a startup for the same cwd still runs its sync", async (t) => {
	const cwd = dir(t, "reload-then-startup");
	writeDb(cwd);
	const reload = await prepareReadiness(fakeInput(cwd, { reason: "reload" }));
	assert.deepEqual(reload, { action: "none", ok: true, warm: "skipped" });
	const calls: string[] = [];
	const startup = await prepareReadiness(fakeInput(cwd, {
		locksDir: dir(t, "reload-then-startup-locks"),
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	}));
	assert.deepEqual(startup, { action: "sync", ok: true, warm: "ok" }, "the startup is never served the reload's cached skip");
	assert.deepEqual(calls, ["sync -q"], "the startup runs its own refresh");
});

test("daemonFor: newest live daemon wins and its registered spelling is returned", (t) => {
	const cwd = dir(t, "daemon");
	const registry = dir(t, "registry");
	const alias = join(registry, "alias");
	symlinkSync(cwd, alias, "junction");
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

test("warmUpDaemon: a vanished cwd resolves false instead of rejecting", async (t) => {
	// No registry records and an empty PATH: projectSpelling falls through to realpathSync on a
	// path that does not exist, so the never-rejects contract is the only thing under test.
	const emptyBin = dir(t, "warm-vanished-bin");
	const previousPath = process.env.PATH;
	process.env.PATH = emptyBin;
	t.after(() => {
		process.env.PATH = previousPath;
	});
	const registry = dir(t, "warm-vanished-registry");
	const cwd = join(dir(t, "warm-vanished-parent"), "gone");
	const warmed = await warmUpDaemon(cwd, false, 5_000, registry);
	assert.equal(warmed, false, "an unresolvable cwd resolves false: nothing to warm, and the promise never rejects");
});

test("warmUpDaemon: a timed-out warm-up kills its spawned child instead of leaking it", { timeout: 10_000 }, async (t) => {
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
	const warmed = warmUpDaemon(dir(t, "warm-timeout"), false, 500);
	const fileDeadline = Date.now() + 3_000;
	while (!existsSync(pidFile) && Date.now() < fileDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(existsSync(pidFile), "the fake daemon spawned");
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	assert.equal(await warmed, false, "the fake daemon never handshakes: the warm-up times out");
	// The termination evidence belongs at settlement: the child must already be gone when the
	// result is delivered, not merely die soon after a result that resolved on the kill signal.
	assert.equal(processRunning(pid), false, "the timed-out warm-up child is killed before the result, not leaked to hold the daemon lock");
});

test("warmUpDaemon: a timed-out warm-up whose child ignores SIGTERM is SIGKILLed", { timeout: 10_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "warm-term-ignore-bin");
	const pidFile = join(bin, "child.pid");
	// trap '' TERM: the shell and the sleep it runs inherit an ignored SIGTERM, so only a bounded
	// SIGKILL escalation can end this warm-up child before it keeps holding the daemon lock.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\ntrap '' TERM\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nsleep 30\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		if (!existsSync(pidFile)) return;
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
		} catch {
			/* already gone */
		}
	});
	const warmed = await warmUpDaemon(dir(t, "warm-term-ignore"), false, 500);
	assert.equal(warmed, false, "the ignoring warm-up child still reports the failed warm-up");
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
	assert.equal(alive(), false, "a SIGTERM-ignoring warm-up child is SIGKILLed before its result, never left alive holding the daemon lock");
});

test("warmUpDaemon: a valid call reply after the deadline keeps the warm-up failed", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "warm-late-reply-bin");
	const pidFile = join(bin, "child.pid");
	const initializeReply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
	const lateCallReply = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ text: "late" }] } });
	// Handshake at once, then the child catches the timeout's group SIGTERM (the observed event
	// that proves the deadline fired) and holds. Only after the test answers with the GO file —
	// strictly after the deadline — does it deliver the valid call reply, then keep running
	// until the SIGKILL escalation ends it: a delay-based script could never prove the ordering.
	const sawTermFile = join(bin, "saw-term");
	const goFile = join(bin, "go");
	const repliedFile = join(bin, "replied");
	const script = [
		"#!/bin/sh",
		"printf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"",
		"printf '%s\\n' '" + initializeReply + "'",
		"trap 'printf term > \"$FAKE_SAW_TERM\"' TERM",
		"while [ ! -f \"$FAKE_SAW_TERM\" ]; do sleep 0.02; done",
		"while [ ! -f \"$FAKE_GO\" ]; do sleep 0.02; done",
		"printf '%s\\n' '" + lateCallReply + "'",
		"printf replied > \"$FAKE_REPLIED\"",
		"while :; do sleep 0.2; done",
		"",
	].join("\n");
	writeFileSync(join(bin, "codegraph"), script);
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	process.env.FAKE_SAW_TERM = sawTermFile;
	process.env.FAKE_GO = goFile;
	process.env.FAKE_REPLIED = repliedFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		delete process.env.FAKE_SAW_TERM;
		delete process.env.FAKE_GO;
		delete process.env.FAKE_REPLIED;
		if (!existsSync(pidFile)) return;
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
		} catch {
			/* already gone */
		}
	});
	const warmed = warmUpDaemon(dir(t, "warm-late-reply"), false, 500);
	const termDeadline = Date.now() + 3_000;
	while (!existsSync(sawTermFile) && Date.now() < termDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(existsSync(sawTermFile), "the observed event: the deadline fired and the child caught its group SIGTERM");
	writeFileSync(goFile, "");
	assert.equal(await warmed, false, "a call reply that lands after the deadline does not report a successful warm-up");
	const repliedDeadline = Date.now() + 3_000;
	while (!existsSync(repliedFile) && Date.now() < repliedDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(existsSync(repliedFile), true, "the late reply really was delivered after the deadline");
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
	const deadline = Date.now() + 5_000;
	while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(alive(), false, "the late reply settles the result, and the SIGKILL escalation still ends the child");
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
	const run = runCodegraph(["sync", "-q"], dir(t, "tree-kill-cwd"), 500);
	const { gone } = await descendantPids(run, [pidFile, grandFile]);
	const ok = await run;
	assert.equal(ok, false, "the fake command never exits: the run times out");
	assert.deepEqual(gone, [true, true], "the direct child AND its grandchild are already dead when the result settles: the group kill completed before the settlement, and no polling window can absorb a survivor");
});

test("runCodegraph: a timed-out group member that outlives the SIGTERM leader is killed before the result", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "close-kill-bin");
	const pidFile = join(bin, "child.pid");
	const memberFile = join(bin, "member.pid");
	// The leader obeys SIGTERM (exec sleep 30) and holds the pipes; the member ignores SIGTERM
	// and holds no stdio, so the leader's close fires while the member still runs — the result
	// must not resolve before that member is gone.
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		"( trap '' TERM; while :; do sleep 0.2; done ) >/dev/null 2>&1 &",
		"printf '%s\\n' \"$!\" > \"$FAKE_MEMBER\"",
		"printf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"",
		"exec sleep 30",
		"",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	process.env.FAKE_MEMBER = memberFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		delete process.env.FAKE_MEMBER;
		for (const file of [pidFile, memberFile]) {
			if (!existsSync(file)) continue;
			try {
				process.kill(Number(readFileSync(file, "utf8").trim()), "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
	const ok = await runCodegraph(["sync", "-q"], dir(t, "close-kill-cwd"), 300);
	assert.equal(ok, false, "the ignoring member still reports the timeout");
	const fileDeadline = Date.now() + 3_000;
	while ((!existsSync(pidFile) || !existsSync(memberFile)) && Date.now() < fileDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(existsSync(pidFile) && existsSync(memberFile), "the fake command and its group member started");
	const pids = [Number(readFileSync(pidFile, "utf8").trim()), Number(readFileSync(memberFile, "utf8").trim())];
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
		} catch {
			return false;
		}
		// A container whose PID 1 never reaps orphans leaves the killed member a zombie: kill
		// still succeeds, but a zombie can neither run nor write. /proc's state field recognizes
		// it as terminated on Linux; a member still capable of running keeps failing the test.
		if (process.platform !== "linux") return true;
		try {
			const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
		} catch {
			return true;
		}
	};
	const deadline = Date.now() + 3_000;
	while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(pids.map(alive), [false, false], "a group member holding no stdio cannot outlive the reported result");
});

test("buildWindowsCommand: a UNC project path keeps its backslashes and cmd metacharacters stay inert", () => {
	const unc = "\\\\server\\share\\proj";
	assert.equal(
		buildWindowsCommand(["sync", "-q", unc]),
		"codegraph \"sync\" \"-q\" \"\\\\server\\share\\proj\"",
		"the UNC path reaches codegraph.cmd with its backslashes exactly as written",
	);
	assert.equal(
		buildWindowsCommand(["sync", "C:\\proj & echo no"]),
		"codegraph \"sync\" \"C:\\proj & echo no\"",
		"spaces and cmd metacharacters stay inside the double quotes",
	);
});

test("buildWindowsCommand: a literal percent in an argument is rejected, not cmd-expanded", () => {
	// With USERNAME=alice, cmd.exe expands %USERNAME% even inside double quotes and offers no
	// command-line escape for a literal percent, so no faithful transport exists through
	// shell:true and the npm .cmd shim: the builder rejects such an argument instead of letting
	// the command target a different project than the lease protects.
	assert.throws(() => buildWindowsCommand(["sync", "-q", "C:\\repos\\%USERNAME%"]), /C:\\repos\\%USERNAME%/);
	assert.equal(
		buildWindowsCommand(["sync", "-q", "C:\\repos\\plain"]),
		"codegraph \"sync\" \"-q\" \"C:\\repos\\plain\"",
		"percent-free arguments keep their exact cmd.exe transport",
	);
});

test("runCodegraph: a percent-carrying project path is rejected before any spawn on Windows", async (t) => {
	if (process.platform !== "win32") return t.skip("the cmd.exe percent expansion only exists on win32");
	// A runner whose codegraph.cmd resolves would take the direct argument vector — the percent
	// rides it literally, and the rejecting builder never runs. An empty PATH forces the
	// unresolved shim, isolating the cmd.exe fallback's percent rejection; the resolved-vector
	// transport has its own seam test above.
	const emptyBin = dir(t, "pct-empty-bin");
	const previousPath = process.env.PATH;
	process.env.PATH = emptyBin;
	clearCodegraphResolveCache();
	t.after(() => {
		process.env.PATH = previousPath;
		clearCodegraphResolveCache();
	});
	const project = join(tmpdir(), `gentle-codegraph-readiness-pct-${process.pid}-%USERNAME%`);
	mkdirSync(project, { recursive: true });
	t.after(() => rmSync(project, { recursive: true, force: true }));
	const reasons: string[] = [];
	const ok = await runCodegraph(["sync", "-q"], project, 1_000, undefined, (info) => {
		reasons.push(info.stderrTail ?? "");
	});
	assert.equal(ok, false, "the percent path is rejected: no command runs for the wrong project");
	assert.match(reasons[0] ?? "", /percent/, "the rejection says why no command ran");
});

test("runCodegraph: a SIGTERM-ignoring command is SIGKILLed before the timeout result", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "sigkill-bin");
	const pidFile = join(bin, "child.pid");
	const grandFile = join(bin, "grandchild.pid");
	// trap '' TERM: the shell and the sleep it backgrounds inherit an ignored SIGTERM, so only
	// the grace-window SIGKILL escalation can end this tree.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\ntrap '' TERM\nsleep 60 &\nprintf '%s\\n' \"$!\" > \"$FAKE_GRANDCHILD\"\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nwait\n");
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
	const run = runCodegraph(["sync", "-q"], dir(t, "sigkill-cwd"), 300);
	const { gone } = await descendantPids(run, [pidFile, grandFile]);
	const ok = await run;
	assert.equal(ok, false, "the ignoring command still reports the timeout");
	assert.deepEqual(gone, [true, true], "the SIGTERM-ignoring tree is already dead when the result settles: the SIGKILL completed before the result was delivered");
});

test("runCodegraph: a command that exits zero after handling the timeout's SIGTERM is still failed", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "term-exit-zero-bin");
	const pidFile = join(bin, "child.pid");
	// The trap answers SIGTERM with a clean exit 0 well inside the SIGKILL grace window, so the
	// close callback sees code 0 — the deadline still expired, and the run must stay failed.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\ntrap 'exit 0' TERM\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nwhile :; do sleep 0.05; done\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		if (!existsSync(pidFile)) return;
		try {
			process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
		} catch {
			/* already gone */
		}
	});
	const events: Array<{ ok: boolean; exitCode?: number | null }> = [];
	const ok = await runCodegraph(["sync", "-q"], dir(t, "term-exit-zero-cwd"), 300, undefined, (info) => {
		events.push({ ok: info.ok, exitCode: info.exitCode });
	});
	assert.equal(ok, false, "the deadline expired: the run reports the timeout, not the later exit code");
	assert.deepEqual(events, [{ ok: false, exitCode: 0 }], "the command exited zero after SIGTERM and the result still records the timeout failure");
});

test("runCodegraph: a throwing onInfo sink never swallows the command result", { timeout: 5_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "sink-throw-bin");
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	t.after(() => {
		process.env.PATH = previousPath;
	});
	let sinkCalls = 0;
	const ok = await runCodegraph(["sync", "-q"], dir(t, "sink-throw-cwd"), 5_000, undefined, () => {
		sinkCalls += 1;
		throw new Error("diagnostic sink exploded");
	});
	assert.equal(sinkCalls, 1, "the diagnostic sink ran");
	assert.equal(ok, true, "the command's actual outcome resolves even when its diagnostic callback throws");
});

/** The seed's mid-flight staging shape — `<worktree>/.codegraph/seed-xxxx/.codegraph/codegraph.db`
 * with real sources in the worktree — plus a fake codegraph CLI on PATH: `files` prints the
 * paths file's tracked-file listing (the shape a real `codegraph files --format flat -j
 * <project>` reports), and the per-test `syncScript` fakes the sync at the runCodegraph/exec
 * boundary, so the REAL runner (link materialization + probes + sync) is what the test
 * exercises. */
function seedSyncHarness(t: test.TestContext, name: string, syncScript: string): { staging: string; seen: () => string } {
	const bin = dir(t, `${name}-bin`);
	const pathsFile = join(bin, "paths.json");
	const seenFile = join(bin, "seen.log");
	writeFileSync(pathsFile, '[{"path":"src/a.ts","language":"typescript","nodeCount":1},{"path":"src/b.ts","language":"typescript","nodeCount":1},{"path":"src/c.ts","language":"typescript","nodeCount":1}]\n');
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'case "$1" in',
		'  files) cat "$FAKE_PATHS" 2>/dev/null || printf "[]" ;;',
		`  sync) ${syncScript} ;;`,
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PATHS = pathsFile;
	process.env.FAKE_SEEN = seenFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PATHS;
		delete process.env.FAKE_SEEN;
	});
	const worktree = dir(t, `${name}-wt`);
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	const staging = join(worktree, ".codegraph", "seed-ab12cd");
	mkdirSync(join(staging, ".codegraph"), { recursive: true });
	writeFileSync(join(staging, ".codegraph", "codegraph.db"), "index-bytes");
	return {
		staging,
		seen: () => {
			try {
				return readFileSync(seenFile, "utf8");
			} catch {
				return "";
			}
		},
	};
}

test("runCodegraphSeedSync: an exit-0 staging sync that drops tracked entries reports removedEntries", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	// The fake sync empties the tracked-file listing exactly like a real sources-less sync does
	// (probed: a 3-file index synced in an empty project exits 0 with 0 files) — while checking
	// that the staging project really sees the worktree's sources through the runner's links.
	const { staging, seen } = seedSyncHarness(t, "seed-drop", 'printf \'[]\\n\' > "$FAKE_PATHS"; [ -f "$3/src/a.ts" ] && printf seen >> "$FAKE_SEEN"');
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: true }, "an exit-0 sync that emptied the staged index is a failed validation, never a publishable one");
	assert.equal(seen(), "seen", "the validating sync ran with the worktree's real sources visible in the staging project");
});

test("runCodegraphSeedSync: a clean staging sync against the worktree's real sources reports no removal", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const { staging, seen } = seedSyncHarness(t, "seed-keep", '[ -f "$3/src/a.ts" ] && printf seen >> "$FAKE_SEEN"');
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: false }, "a sync that preserved every tracked entry validates the copy");
	assert.equal(seen(), "seen", "the validating sync ran with the worktree's real sources visible in the staging project");
});

test("runCodegraphSeedSync: a sync that swaps one entry for another still reports removedEntries", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	// The staged index starts with {a,b,c}; the fake sync replaces c with d. The net count stays
	// 3, but a tracked entry was dropped: identities decide, never the net file count.
	const { staging } = seedSyncHarness(t, "seed-swap", 'printf \'%s\\n\' \'[{"path":"src/a.ts","language":"typescript","nodeCount":1},{"path":"src/b.ts","language":"typescript","nodeCount":1},{"path":"src/d.ts","language":"typescript","nodeCount":1}]\' > "$FAKE_PATHS"');
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: true }, "a same-count swap still dropped a tracked entry: the SeedSyncReport must say so");
});

test("runCodegraphSeedSync: a multibyte tracked path split across stdout chunks survives the identity comparison", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	// The before-listing splits é (UTF-8 C3 A9) between two stdout writes with a pause between
	// them, so the runner's capture sees two Buffer chunks; the after-listing prints the same
	// bytes whole. A per-chunk decode corrupts the before-listing into caf\uFFFD and the identity
	// comparison reports a removal for a file that is still tracked. The stderr capture gets the
	// same split treatment, and its decoded tail must come back intact too.
	const bin = dir(t, "seed-split-bin");
	const listing = `${JSON.stringify([{ path: "src/café.ts", language: "typescript", nodeCount: 1 }])}\n`;
	// é is the two UTF-8 bytes C3 A9: the boundary between them is the split point (a per-chunk
	// decode turns each side into a replacement character).
	const eAccent = Buffer.from("é", "utf8");
	const bytes = Buffer.from(listing, "utf8");
	const splitAt = bytes.indexOf(eAccent) + 1; // between é's two UTF-8 bytes
	writeFileSync(join(bin, "paths-head"), bytes.subarray(0, splitAt));
	writeFileSync(join(bin, "paths-tail"), bytes.subarray(splitAt));
	const pathsFile = join(bin, "paths.json");
	writeFileSync(pathsFile, bytes);
	const errBytes = Buffer.from("stderr: src/café.ts\n", "utf8");
	const errSplitAt = errBytes.indexOf(eAccent) + 1;
	writeFileSync(join(bin, "err-head"), errBytes.subarray(0, errSplitAt));
	writeFileSync(join(bin, "err-tail"), errBytes.subarray(errSplitAt));
	const splitDone = join(bin, "split-done");
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'case "$1" in',
		"  files)",
		'    if [ -f "$FAKE_SPLIT_DONE" ]; then',
		'      cat "$FAKE_PATHS"',
		"    else",
		'      cat "$FAKE_HEAD"',
		'      cat "$FAKE_ERR_HEAD" >&2',
		"      sleep 0.2",
		'      cat "$FAKE_TAIL"',
		'      cat "$FAKE_ERR_TAIL" >&2',
		'      touch "$FAKE_SPLIT_DONE"',
		"    fi",
		"    ;;",
		"  sync) : ;;",
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PATHS = pathsFile;
	process.env.FAKE_HEAD = join(bin, "paths-head");
	process.env.FAKE_TAIL = join(bin, "paths-tail");
	process.env.FAKE_ERR_HEAD = join(bin, "err-head");
	process.env.FAKE_ERR_TAIL = join(bin, "err-tail");
	process.env.FAKE_SPLIT_DONE = splitDone;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PATHS;
		delete process.env.FAKE_HEAD;
		delete process.env.FAKE_TAIL;
		delete process.env.FAKE_ERR_HEAD;
		delete process.env.FAKE_ERR_TAIL;
		delete process.env.FAKE_SPLIT_DONE;
	});
	const worktree = dir(t, "seed-split-wt");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	const staging = join(worktree, ".codegraph", "seed-ab12cd");
	mkdirSync(join(staging, ".codegraph"), { recursive: true });
	writeFileSync(join(staging, ".codegraph", "codegraph.db"), "index-bytes");
	const stderrTails: string[] = [];
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000, undefined, (info) => {
		if (info.stderrTail !== undefined) stderrTails.push(info.stderrTail);
	});
	assert.deepEqual(report, { ok: true, removedEntries: false }, "the multibyte path split across chunks is the same tracked identity before and after the sync");
	assert.ok(stderrTails.some((tail) => tail.includes("stderr: src/café.ts")), "the stderr tail decodes its split multibyte bytes intact");
	assert.equal(existsSync(splitDone), true, "the split before-listing ran exactly once");
});

test("runCodegraphSeedSync: a staging copy whose tracked files cannot be listed fails closed", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "seed-torn-bin");
	const seenFile = join(bin, "seen.log");
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'case "$1" in',
		'  files) printf "not-a-json-listing\\n" ;;',
		'  sync) printf seen >> "$FAKE_SEEN" ;;',
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_SEEN = seenFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_SEEN;
	});
	const worktree = dir(t, "seed-torn-wt");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	const staging = join(worktree, ".codegraph", "seed-ab12cd");
	mkdirSync(join(staging, ".codegraph"), { recursive: true });
	writeFileSync(join(staging, ".codegraph", "codegraph.db"), "torn-copy");
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: false, removedEntries: false }, "an unreadable entry count is an unprovable validation: fail closed, never publish");
	assert.equal(existsSync(seenFile), false, "the sync itself never runs when the copy cannot be counted");
});

test("runCodegraphSeedSync: an informational empty-index listing is an empty path set, not a failure", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "seed-empty-bin");
	const seenFile = join(bin, "seen.log");
	const listedFile = join(bin, "listed");
	// The real CLI prints this exact informational sentence (exit 0, stdout) when `files` finds
	// no indexed files instead of `[]` — the documented-by-source empty result. The
	// before-listing sees it; the validating sync and the after-listing still run.
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'case "$1" in',
		"  files)",
		'    if [ ! -f "$FAKE_LISTED" ]; then',
		"      printf '%s\\n' 'ℹ No files indexed. Run \"codegraph index\" first.'",
		'      touch "$FAKE_LISTED"',
		"    else",
		"      printf '[]\\n'",
		"    fi",
		"    ;;",
		'  sync) printf seen >> "$FAKE_SEEN" ;;',
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_SEEN = seenFile;
	process.env.FAKE_LISTED = listedFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_SEEN;
		delete process.env.FAKE_LISTED;
	});
	const worktree = dir(t, "seed-empty-wt");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	const staging = join(worktree, ".codegraph", "seed-ab12cd");
	mkdirSync(join(staging, ".codegraph"), { recursive: true });
	writeFileSync(join(staging, ".codegraph", "codegraph.db"), "empty-parent-copy");
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: false }, "a confirmed-empty staged index validates: the sync may still add the worktree's files");
	assert.equal(existsSync(seenFile), true, "the validating sync ran after the informational empty listing");
});

test("runCodegraphSeedSync: an empty-index notice with extra output is unprovable, never empty", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "seed-notice-extra-bin");
	const seenFile = join(bin, "seen.log");
	// The informational line followed by a torn JSON fragment: only the complete line is the
	// documented empty case — extra output must not pass as a confirmed-empty index.
	writeFileSync(join(bin, "codegraph"), [
		"#!/bin/sh",
		'case "$1" in',
		"  files)",
		"    echo 'ℹ No files indexed. Run \"codegraph index\" first.'",
		"    echo [{path:torn",
		"    ;;",
		'  sync) printf seen >> "$FAKE_SEEN" ;;',
		"esac",
		"exit 0",
	].join("\n"));
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_SEEN = seenFile;
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_SEEN;
	});
	const worktree = dir(t, "seed-notice-extra-wt");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	const staging = join(worktree, ".codegraph", "seed-ab12cd");
	mkdirSync(join(staging, ".codegraph"), { recursive: true });
	writeFileSync(join(staging, ".codegraph", "codegraph.db"), "notice-extra");
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: false, removedEntries: false }, "the notice beside extra output is not a confirmed-empty index: fail closed");
	assert.equal(existsSync(seenFile), false, "the validating sync never runs on an unprovable listing");
});

test("runCodegraphSeedSync: a source directory whose link cannot be created is copied instead", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const { staging, seen } = seedSyncHarness(t, "seed-copy-fallback", '[ -f "$3/src/a.ts" ] && printf seen >> "$FAKE_SEEN"');
	// A Windows share takes no junction to a remote directory; a pre-existing staging entry
	// forces the same link failure here, so the fallback must materialize the sources as a copy.
	mkdirSync(join(staging, "src"));
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: false }, "a copied source tree still validates the staged index");
	assert.equal(seen(), "seen", "the validating sync saw the worktree's sources through the copy");
	assert.equal(lstatSync(join(staging, "src")).isSymbolicLink(), false, "the un-linkable source became a real directory in the staging project");
	assert.equal(readFileSync(join(staging, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the copy carries the worktree's file contents");
});

test("runCodegraphSeedSync: the share copy fallback leaves the event loop and skips dependency trees", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const { staging, seen } = seedSyncHarness(t, "seed-copy-bounded", '[ -f "$3/src/a.ts" ] && printf seen >> "$FAKE_SEEN"');
	const worktree = dirname(dirname(staging));
	mkdirSync(join(worktree, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
	// Pre-existing staging entries force the same link failure a Windows share causes for every
	// top-level entry, so both trees take the copy fallback.
	mkdirSync(join(staging, "src"));
	mkdirSync(join(staging, "node_modules"));
	const inFlight = runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.equal(existsSync(join(staging, "src", "a.ts")), false, "a blocking copy would have finished inside the call itself: the copy runs off the event loop");
	const report = await inFlight;
	assert.deepEqual(report, { ok: true, removedEntries: false }, "the bounded copy still validates the staged index");
	assert.equal(seen(), "seen", "the validating sync saw the worktree's sources through the copy");
	assert.equal(readFileSync(join(staging, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the worktree's own files are still copied");
	assert.deepEqual(readdirSync(join(staging, "node_modules")), [], "a dependency tree the scanner ignores is never staged, even on the share fallback");
});

test("runCodegraphSeedSync: a regular file the share cannot hard-link is copied, not fatal", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const { staging, seen } = seedSyncHarness(t, "seed-file-fallback", '[ -f "$3/src/a.ts" ] && printf seen >> "$FAKE_SEEN"');
	const worktree = dirname(dirname(staging));
	writeFileSync(join(worktree, "README.md"), "# sources\n");
	writeFileSync(join(worktree, "package.json"), "{\n  \"name\": \"staged-sources\"\n}\n");
	// A pre-existing staging entry makes the hard link fail (EEXIST stands in for a share that
	// refuses CreateHardLink): the file must copy instead of aborting the whole validation.
	writeFileSync(join(staging, "package.json"), "stale staging bytes\n");
	const report = await runCodegraphSeedSync(["sync", "-q"], staging, 10_000);
	assert.deepEqual(report, { ok: true, removedEntries: false }, "a share without hard links still stages the worktree's regular files");
	assert.equal(seen(), "seen");
	assert.equal(readFileSync(join(staging, "package.json"), "utf8"), "{\n  \"name\": \"staged-sources\"\n}\n", "the un-linkable file was copied, so validation and publication can proceed");
	assert.equal(lstatSync(join(staging, "README.md")).nlink, 2, "where hard links work the staging keeps using them");
});

test("runCodegraphSeedSync: an ordinary sync outside a seed staging project keeps the boolean report", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness");
	const bin = dir(t, "seed-plain-bin");
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	t.after(() => {
		process.env.PATH = previousPath;
	});
	const report = await runCodegraphSeedSync(["sync", "-q"], dir(t, "seed-plain"), 10_000);
	assert.equal(report, true, "a non-staging call delegates to the plain runCodegraph contract");
});

test("syncBeforeSearch: the daemon-less refresh runs only sync -q; a failure reports only sync", async (t) => {
	const cwd = dir(t, "search-order");
	const calls: string[] = [];
	const failures: string[] = [];
	await syncBeforeSearch({
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return false;
		},
		onFailed: (stage) => failures.push(stage),
	});
	assert.deepEqual(calls, ["sync -q"], "no unlock ever precedes the daemon-less sync");
	assert.deepEqual(failures, ["sync"]);
});

test("syncBeforeSearch: a live daemon syncs only; no daemon runs the same single sync", async (t) => {
	const cwd = dir(t, "search-live-daemon");
	const registry = dir(t, "search-live-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: string[] = [];
	await syncBeforeSearch({
		cwd,
		registryDir: registry,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	});
	assert.deepEqual(calls, ["sync -q"], "a live daemon holds the writer lock and is not stale: only the sync runs");

	const deadCwd = dir(t, "search-dead-daemon");
	const deadCalls: string[] = [];
	await syncBeforeSearch({
		cwd: deadCwd,
		registryDir: dir(t, "search-dead-registry"),
		run: async (args) => {
			deadCalls.push(args.join(" "));
			return true;
		},
	});
	assert.deepEqual(deadCalls, ["sync -q"], "no live daemon: the lease holder refreshes with the sync alone");
});

test("syncBeforeSearch: a damaged sync lease reports a blocked refresh and never syncs past it", async (t) => {
	const cwd = dir(t, "search-lease-damaged");
	const locks = dir(t, "search-lease-damaged-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), "{not-json\n");
	const calls: string[] = [];
	const failures: string[] = [];
	await syncBeforeSearch({
		cwd,
		locksDir: locks,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		onFailed: (stage) => failures.push(stage),
	});
	assert.deepEqual(calls, [], "no unlock, no sync: nobody owns this refresh");
	assert.deepEqual(failures, ["lease"], "the blocked lease is the reported stage");
});

test("syncBeforeSearch: concurrent calls for one cwd coalesce into a single sync", async (t) => {
	const cwd = dir(t, "search-coalesce");
	const calls: string[] = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const run: SearchSyncInput["run"] = async (args) => {
		calls.push(args.join(" "));
		if (args[0] === "sync") await gate;
		return true;
	};

	const first = syncBeforeSearch({ cwd, run });
	const second = syncBeforeSearch({ cwd, run });
	assert.deepEqual(calls, ["sync -q"], "the second call starts no second job while one is in flight");

	release?.();
	await Promise.all([first, second]);
	assert.deepEqual(calls, ["sync -q"], "exactly one sync serves both awaiting callers");

	await syncBeforeSearch({ cwd, run });
	assert.deepEqual(calls, ["sync -q", "sync -q"], "a settled job frees the cwd for the next search");
});

test("syncBeforeSearch: a rejecting run never surfaces an unhandled rejection", async (t) => {
	const cwd = dir(t, "search-reject");
	const rejections: unknown[] = [];
	const onUnhandled = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));

	await syncBeforeSearch({
		cwd,
		run: async () => {
			throw new Error("refresh exploded");
		},
	});
	// One explicit event-loop checkpoint after job settlement: an unhandled rejection would
	// surface to the observer here, never before the await returned.
	await settled();

	assert.deepEqual(rejections, []);
});

test("prepareReadiness: a live sync lease in another session skips the sync and stands the warm-up down", async (t) => {
	const cwd = dir(t, "sync-lease-live");
	writeDb(cwd);
	const locks = dir(t, "sync-lease-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), `${JSON.stringify({ kind: "sync", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })}\n`);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async () => {
			calls.push("run");
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "skipped" }, "another session is refreshing: not a failure, and its sync may still be running");
	assert.deepEqual(calls, [], "no sync, no warm: the holder owns the refresh and no daemon starts under it");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", locks)), "held-live", "the foreign lease is never stolen");
});

test("prepareReadiness: the daemon-less sync child is adopted onto the sync lease", async (t) => {
	const cwd = dir(t, "sync-adopt");
	writeDb(cwd);
	const locks = dir(t, "sync-adopt-locks");
	const seen: Array<{ args: string; mine: boolean; writerPid?: number }> = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		run: async (args, _cwd, _timeoutMs, onSpawn) => {
			assert.equal(typeof onSpawn, "function", "the " + args[0] + " child can report its spawn to the lease");
			onSpawn?.(4242, false);
			const token = JSON.parse(readFileSync(lockPathFor(cwd, "sync", locks), "utf8")) as { pid: number; writerPid?: number };
			seen.push({ args: args.join(" "), mine: token.pid === process.pid, writerPid: token.writerPid });
			return true;
		},
	}));
	assert.deepEqual(result, { action: "sync", ok: true, warm: "ok" });
	assert.deepEqual(seen, [
		{ args: "sync -q", mine: true, writerPid: 4242 },
	], "the sync child lands on the sync lease token while it is held");
	assert.equal(readLeaseVerdict(lockPathFor(cwd, "sync", locks)), "free", "the lease is released after the refresh");
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
	assert.deepEqual(calls, [], "no sync: nobody owns this refresh, and the failure says so");
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
	assert.deepEqual(calls, ["run:sync -q"]);
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

test("prepareReadiness: an index that turns unknown under the init lock fails closed without initializing", async (t) => {
	// The chmod 000 access-error probe is POSIX-only (Windows ACLs do not map it to a statSync
	// denial), so the tri-state recheck's fail-closed branch runs on POSIX only.
	if (process.platform === "win32") return;
	if (!directoryTraversalDenied()) return t.skip("this process traverses chmod-000 directories (root or another DAC-bypass context): the access-error path cannot be exercised");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-codegraph-readiness-init-unknown-"));
	t.after(() => {
		try {
			chmodSync(join(cwd, ".codegraph"), 0o755);
		} catch {
			/* never created, or already restored */
		}
		rmSync(cwd, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const locks = dir(t, "init-unknown-locks");
	// A foreign live init lock makes acquireInitLock poll, which opens the window between the
	// plan (absent) and the post-lock recheck in which the index turns unreadable.
	writeFileSync(lockPathFor(cwd, "init", locks), `${JSON.stringify({ kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 600_000 })}\n`);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		onStart: () => {
			setTimeout(() => {
				// The other session finished AND the index became unreadable at once: the recheck
				// must see "unknown", never a green light to initialize.
				rmSync(lockPathFor(cwd, "init", locks), { force: true });
				mkdirSync(join(cwd, ".codegraph"));
				chmodSync(join(cwd, ".codegraph"), 0o000);
			}, 100);
		},
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		warm: async () => true,
	}));
	assert.deepEqual(result, { action: "init", ok: false, warm: "skipped" }, "an unconfirmable index is a fail-closed report");
	assert.deepEqual(calls, [], "unknown never initializes");
});

test("prepareReadiness: a .codegraph that becomes a link while waiting for the init lock fails closed", async (t) => {
	const foreign = dir(t, "init-link-swap-foreign");
	mkdirSync(join(foreign, ".codegraph"));
	const cwd = dir(t, "init-link-swap");
	// A regular, database-less .codegraph reads "absent" and safe, so the plan selects init.
	mkdirSync(join(cwd, ".codegraph"));
	writeFileSync(join(cwd, "package.json"), "{}\n");
	const locks = dir(t, "init-link-swap-locks");
	writeFileSync(lockPathFor(cwd, "init", locks), `${JSON.stringify({ kind: "init", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 600_000 })}\n`);
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(cwd, {
		locksDir: locks,
		onStart: () => {
			setTimeout(() => {
				// The other session finished, and the directory it left became another checkout's
				// link before this session acquired the lock: the recheck must refuse to init.
				rmSync(lockPathFor(cwd, "init", locks), { force: true });
				rmSync(join(cwd, ".codegraph"), { recursive: true });
				symlinkSync(join(foreign, ".codegraph"), join(cwd, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
			}, 100);
		},
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		warm: async () => true,
	}));
	assert.deepEqual(result, { action: "init", ok: false, warm: "skipped" }, "a directory that turned into a link under the lock is never initialized through");
	assert.deepEqual(calls, [], "no init spawn is handed the linked directory");
});

test("syncBeforeSearch: a live sync lease in another session means zero CLI calls", async (t) => {
	const cwd = dir(t, "search-lease-live");
	const locks = dir(t, "search-lease-locks");
	writeFileSync(lockPathFor(cwd, "sync", locks), `${JSON.stringify({ kind: "sync", pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })}\n`);
	const calls: string[] = [];
	const failures: string[] = [];
	await syncBeforeSearch({
		cwd,
		locksDir: locks,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
		onFailed: (stage) => failures.push(stage),
	});
	assert.deepEqual(calls, [], "no sync: the live lease holder owns this refresh");
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

test("prepareReadiness: seed outcomes target-exists, deferred, seed-failed, and not-seedable", async (t) => {
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

	const failed = dir(t, "seed-seed-failed");
	writeFileSync(join(failed, "package.json"), "{}\n");
	const failedCalls: string[] = [];
	const failedResult = await prepareReadiness(fakeInput(failed, {
		seed: async () => ({ outcome: "seed-failed" }),
		run: async (args) => {
			failedCalls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(failedResult, { action: "init", ok: false, warm: "skipped" }, "a failed copy of an existing parent index never falls back to init");
	assert.deepEqual(failedCalls, [], "AGENTS.md: a worktree with a parent index is never initialized");

	const notSeedable = dir(t, "seed-not-seedable");
	writeFileSync(join(notSeedable, "package.json"), "{}\n");
	const notSeedableCalls: string[] = [];
	const notSeedableResult = await prepareReadiness(fakeInput(notSeedable, {
		seed: async () => ({ outcome: "not-seedable" }),
		run: async (args) => {
			notSeedableCalls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(notSeedableResult, { action: "init", ok: true, warm: "ok" }, "no parent index means a fresh project: init is its path");
	assert.deepEqual(notSeedableCalls, ["run:init -y"], "the ordinary init still runs");
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

test("prepareReadiness: a live CodeGraph writer lock means no sync, and ok", async (t) => {
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
	assert.deepEqual(calls, ["warm"], "a live writer is never refreshed under");
});

test("prepareReadiness: a symlinked .codegraph directory stands the automatic sync and warm-up down", async (t) => {
	const real = dir(t, "sync-symlink-real");
	writeDb(real);
	const linked = dir(t, "sync-symlink-linked");
	symlinkSync(join(real, ".codegraph"), join(linked, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(linked, {
		locksDir: dir(t, "sync-symlink-locks"),
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "none", ok: true, warm: "skipped" }, "another checkout's linked index is not this workspace's to sync or warm");
	assert.deepEqual(calls, [], "no sync and no warm-up ever touch the linked database");
});

test("prepareReadiness: a linked empty .codegraph directory is never initialized through the link", async (t) => {
	const real = dir(t, "init-link-real");
	mkdirSync(join(real, ".codegraph"));
	const linked = dir(t, "init-link-linked");
	symlinkSync(join(real, ".codegraph"), join(linked, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
	writeFileSync(join(linked, "package.json"), "{}\n");
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(linked, {
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
		warm: async () => {
			calls.push("warm");
			return true;
		},
	}));
	assert.deepEqual(result, { action: "none", ok: true, warm: "skipped" }, "the linked checkout's empty index directory is never initialized by this session");
	assert.deepEqual(calls, [], "no init and no warm-up ever write through the link");
});

test("syncBeforeSearch: a live CodeGraph writer lock means zero CLI calls", async (t) => {
	const cwd = dir(t, "search-writer-busy");
	writeDb(cwd);
	writeFileSync(join(cwd, ".codegraph", "codegraph.lock"), String(process.pid));
	const calls: string[] = [];
	await syncBeforeSearch({
		cwd,
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	});
	assert.deepEqual(calls, [], "the live writer owns the refresh");
});

test("syncBeforeSearch: a symlinked .codegraph directory means zero CLI calls", async (t) => {
	const real = dir(t, "search-symlink-real");
	writeDb(real);
	const linked = dir(t, "search-symlink-linked");
	symlinkSync(join(real, ".codegraph"), join(linked, ".codegraph"), process.platform === "win32" ? "junction" : "dir");
	const calls: string[] = [];
	await syncBeforeSearch({
		cwd: linked,
		locksDir: dir(t, "search-symlink-locks"),
		run: async (args) => {
			calls.push(args.join(" "));
			return true;
		},
	});
	assert.deepEqual(calls, [], "the linked checkout's database is never written by the automatic search refresh");
});

test("prepareReadiness: the init run's spawn lands on the init lease token", async (t) => {
	const fresh = dir(t, "init-adopt");
	writeFileSync(join(fresh, "package.json"), "{}\n");
	const locks = dir(t, "init-adopt-locks");
	const seen: Array<{ args: string; mine: boolean; writerPid?: number }> = [];
	const result = await prepareReadiness(fakeInput(fresh, {
		locksDir: locks,
		run: async (args, _cwd, _timeoutMs, onSpawn) => {
			assert.equal(typeof onSpawn, "function", "the " + args[0] + " child can report its spawn to the lease");
			onSpawn?.(4242, false);
			const token = JSON.parse(readFileSync(lockPathFor(fresh, "init", locks), "utf8")) as { pid: number; writerPid?: number };
			seen.push({ args: args.join(" "), mine: token.pid === process.pid, writerPid: token.writerPid });
			return true;
		},
		warm: async () => true,
	}));
	assert.deepEqual(result, { action: "init", ok: true, warm: "ok" });
	assert.deepEqual(seen, [
		{ args: "init -y", mine: true, writerPid: 4242 },
	], "the init child lands on the init lease token while it is held");
	assert.equal(readLeaseVerdict(lockPathFor(fresh, "init", locks)), "free", "the lease is released after the init");
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

test("prepareReadiness: a backoff that outlives the sync budget returns the first failure without a retry", async (t) => {
	const cwd = dir(t, "sync-backoff-expired");
	writeDb(cwd);
	const registry = dir(t, "sync-backoff-registry");
	const socket = join(registry, "live.sock");
	writeFileSync(socket, "");
	fakeRegistryRecord(registry, cwd, socket, process.pid);
	const calls: Array<{ args: string; timeoutMs: number }> = [];
	const realNow = Date.now;
	let resumedPastDeadline = false;
	t.mock.method(Date, "now", () => (resumedPastDeadline ? realNow() + SYNC_TIMEOUT_MS + 5_000 : realNow()));
	t.after(() => {
		t.mock.restoreAll();
	});
	const result = await prepareReadiness(fakeInput(cwd, {
		registryDir: registry,
		sleep: async () => {
			// A suspended host resumes past the deadline mid-backoff: no budget survives for a retry.
			resumedPastDeadline = true;
		},
		run: async (args, _cwd, timeoutMs) => {
			calls.push({ args: args.join(" "), timeoutMs });
			return false;
		},
		warm: async () => true,
	}));
	assert.equal(result.ok, false, "the first failure stands when the backoff outlives the whole budget");
	assert.deepEqual(calls.map((call) => call.args), ["sync -q"], "no retry starts once the remaining budget is nonpositive");
	assert.equal(calls[0]?.timeoutMs, SYNC_TIMEOUT_MS, "the one attempt ran with the full budget");
});

test("prepareReadiness: without a live daemon the sync stays single-shot and reports daemonAlive false", async (t) => {
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
			return false;
		},
		onIndexed: (indexed) => {
			events.push({ ...indexed });
		},
	}));
	assert.deepEqual(calls, ["run:sync -q"], "the daemon-less path is unchanged: sync once, no retry");
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
	await syncBeforeSearch({
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
	assert.deepEqual(calls, ["sync -q", "sync -q"], "the first failing sync is retried once beside a live daemon");
	assert.deepEqual(sleeps, [SYNC_RETRY_DELAY_MS]);
	assert.deepEqual(failures, [], "a successful retry reports nothing");

	const deadCwd = dir(t, "search-dead-detail");
	const deadFailures: Array<{ stage: string; info: Record<string, unknown> }> = [];
	await syncBeforeSearch({
		cwd: deadCwd,
		registryDir: dir(t, "search-dead-detail-registry"),
		run: async () => false,
		onFailed: (stage, info) => {
			deadFailures.push({ stage, info: { ...info } });
		},
	});
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

test("prepareReadiness: a child whose worktree index appears mid-gate never syncs it", async (t) => {
	const { worktree } = worktreePair(t);
	writeDb(worktree);
	// The gate must read "absent" while the plan reads "present" — a publish landing exactly
	// between the two checks. Only the gate's first database stat is intercepted; everything
	// else sees the real, published index.
	let gateSawAbsent = false;
	const realStatSync = fsSync.statSync;
	const dbPath = join(worktree, ".codegraph", "codegraph.db");
	t.mock.method(fsSync, "statSync", ((...args: Parameters<typeof fsSync.statSync>) => {
		if (!gateSawAbsent && String(args[0]) === dbPath) {
			gateSawAbsent = true;
			const absent = new Error("simulated pre-publication index") as NodeJS.ErrnoException;
			absent.code = "ENOENT";
			throw absent;
		}
		return realStatSync(...args);
	}) as typeof fsSync.statSync);
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	const calls: string[] = [];
	const result = await prepareReadiness(fakeInput(worktree, {
		env: { GENTLE_PI_AGENTS_CHILD: "1" },
		locksDir: dir(t, "child-publish-locks"),
		run: async (args) => {
			calls.push(`run:${args.join(" ")}`);
			return true;
		},
	}));
	assert.deepEqual(result, { action: "none", ok: true, warm: "skipped" }, "another session just published this index: the child stands down, never syncs");
	assert.deepEqual(calls, [], "a child session runs no sync of its own");
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

test("runCodegraph: a delayed Windows tree kill holds the timeout result until the kill completes", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness; the Windows settlement path itself runs through the kill seam");
	const bin = dir(t, "winkill-bin");
	const pidFile = join(bin, "child.pid");
	// The fake command never exits, so the timeout escalates to the tree kill — whose completion
	// the seam delays: the result must not settle before that completion, or the caller would
	// release its index lease while the tree can still run.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nwhile :; do sleep 0.2; done\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	let treePid: number | undefined;
	const rememberedPid = (): number | undefined => {
		if (treePid !== undefined) return treePid;
		if (!existsSync(pidFile)) return undefined;
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? (treePid = pid) : undefined;
	};
	const endFakeTree = (): void => {
		const pid = rememberedPid();
		if (pid !== undefined) killFakeTreePid(pid);
	};
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		// The pid is remembered on its own: a registered directory cleanup may already have removed
		// the file by hook time, and a failed assertion must still be able to end the tree.
		endFakeTree();
	});
	const kills: number[] = [];
	const completions: number[] = [];
	setTreeKillSeamForTests({
		platform: () => "win32",
		windowsKill: (_pid, onKilled) => {
			kills.push(Date.now());
			setTimeout(() => {
				completions.push(Date.now());
				onKilled(true);
			}, 400);
		},
	});
	t.after(() => setTreeKillSeamForTests(undefined));
	try {
		const ok = await runCodegraph(["sync", "-q"], dir(t, "winkill-cwd"), 200);
		const settledAt = Date.now();
		// The timeout's kill is the run's first attempt; a confirmation ends the attempts, so the
		// completions are observed before the assertion — a premature settlement would otherwise
		// compare against a still-pending one.
		const completionDeadline = Date.now() + 5_000;
		while (completions.length < kills.length && Date.now() < completionDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(completions.length, kills.length, "every delayed tree kill completed");
		assert.ok(kills.length >= 1, "the timeout escalated to the Windows tree kill");
		assert.equal(ok, false, "the never-exiting command reports the timeout");
		assert.ok(settledAt >= completions[completions.length - 1]!, "the result settles only after the Windows tree kill completed, never while it still runs");
	} finally {
		// The seam diverted the real kill, so the fake tree still runs: end its whole group here,
		// before the directory cleanup removes its pid file, or a failed assertion would leave it
		// holding the runner stdio open with nothing left to find it by.
		endFakeTree();
	}
});

test("goneAtSettlement: a zombie state is recognized with or without the flags macOS appends", () => {
	assert.equal(psStateSaysGone("Z"), true);
	assert.equal(psStateSaysGone("ZN"), true, "macOS appends flag letters to the state: ZN is still a zombie");
	assert.equal(psStateSaysGone("Z+"), true);
	assert.equal(psStateSaysGone("S"), false, "a sleeping process is not gone");
	assert.equal(psStateSaysGone("SN"), false);
	assert.equal(psStateSaysGone(""), false, "an unreadable sample proves nothing");
});

test("goneAtSettlement: only ESRCH proves the probed pid is gone", async (t) => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
	t.after(() => child.kill("SIGKILL"));
	await new Promise((resolve) => child.once("spawn", resolve));
	const pid = child.pid;
	assert.ok(pid !== undefined);
	assert.equal(signalZeroErrno(pid), undefined, "a live pid answers the signal-0 probe");
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await exited;
	assert.equal(signalZeroErrno(pid), "ESRCH", "the kernel ESRCH is the proof of death, never a probe that could not run");
});

test("killWindowsTree: a helper that never exits reports an unconfirmed kill within the bound", async (t) => {
	if (process.platform === "win32") return t.skip("the stand-in helper is a POSIX shell; the real taskkill path runs on the Windows CI lanes");
	const helpers: ChildProcess[] = [];
	const outcomes: boolean[] = [];
	let runningAtSettle: boolean | undefined;
	let settledAfter = 0;
	const startedAt = Date.now();
	killWindowsTree(4_242, (confirmed) => {
		outcomes.push(confirmed);
		settledAfter = Date.now() - startedAt;
		// Sampled inside the callback: the helper is still there, so the reported outcome is the
		// bounded one and not a termination the helper itself never performed.
		runningAtSettle = helpers[0]?.exitCode === null && helpers[0]?.signalCode === null;
	}, {
		boundMs: 150,
		// There is no taskkill to wedge off Windows: the injected spawn starts a helper that never
		// exits under the same stdio policy, the exact shape the bound exists for.
		spawn: (_file, _args, options) => {
			const helper = spawn("sh", ["-c", "exec sleep 30"], options);
			helpers.push(helper);
			return helper;
		},
	});
	t.after(() => {
		for (const helper of helpers) {
			try {
				helper.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
	// No wall-clock upper bound: a descheduled runner can dispatch the bound callback late, and the
	// sample taken inside it — not the delay — is what proves the outcome never waited for the
	// helper to exit. A separate watchdog keeps a stalled fixture from hanging the suite.
	const watchdog = Date.now() + 20_000;
	while (outcomes.length === 0 && Date.now() < watchdog) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.deepEqual(outcomes, [false], "a helper that never exits reports an unconfirmed kill, exactly once");
	assert.ok(settledAfter >= 150, "the outcome waits for the bound instead of taking a stall for a completed kill");
	assert.equal(helpers.length, 1, "one helper per kill");
	assert.equal(runningAtSettle, true, "the helper was still running when the bound callback ran: the outcome never waits for it to exit");
});

test("runCodegraph: an unconfirmed teardown closes this process's pipes to the abandoned writer", { timeout: 60_000 }, async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness; the Windows settlement path itself runs through the kill seam");
	const bin = dir(t, "winkill-detach-bin");
	const pidFile = join(bin, "child.pid");
	const marker = join(bin, "pipe-closed.marker");
	// The command publishes its pid and writes to its stdout forever, ignoring SIGPIPE so a closed
	// pipe surfaces as a failed write: the marker it drops then is the observable proof that this
	// process closed the run's local pipes, and a run that leaves them open never produces one.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\ntrap '' PIPE\nprintf '%s\\n' \"$$\" > \"$FAKE_PIDFILE\"\nwhile :; do\n  if ! printf 'x\\n'; then printf 'closed\\n' > \"$FAKE_MARKER\"; exit 0; fi\n  sleep 0.05\ndone\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	process.env.FAKE_PIDFILE = pidFile;
	process.env.FAKE_MARKER = marker;
	let treePid: number | undefined;
	const rememberedPid = (): number | undefined => {
		if (treePid !== undefined) return treePid;
		if (!existsSync(pidFile)) return undefined;
		const pid = Number(readFileSync(pidFile, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? (treePid = pid) : undefined;
	};
	t.after(() => {
		process.env.PATH = previousPath;
		delete process.env.FAKE_PIDFILE;
		delete process.env.FAKE_MARKER;
		// Remembered on its own: a failed assertion must still be able to end the writer, even
		// after the directory cleanup has taken its pid file.
		const pid = rememberedPid();
		if (pid !== undefined) killFakeTreePid(pid);
	});
	setTreeKillSeamForTests({
		platform: () => "win32",
		// A taskkill whose result never arrives: nothing proves the tree gone, so the run settles
		// unconfirmed beside a writer that is still running.
		windowsKill: () => {},
	});
	t.after(() => setTreeKillSeamForTests(undefined));
	const infos: { ok: boolean; teardownUnconfirmed?: boolean }[] = [];
	let runningAtSettlement: boolean | undefined;
	const ok = await runCodegraph(["sync", "-q"], dir(t, "winkill-detach-cwd"), 200, undefined, (info) => {
		infos.push(info);
		const pid = rememberedPid();
		runningAtSettlement = pid === undefined ? undefined : processRunning(pid);
	});
	assert.equal(ok, false, "the timed-out command still reports the failure");
	assert.equal(infos[infos.length - 1]?.teardownUnconfirmed, true, "dropping the local handles is never taken for proof that the writer terminated");
	assert.equal(runningAtSettlement, true, "the writer was still running when the settlement landed, so its pipes are the only thing this process could still hold");
	const deadline = Date.now() + 5_000;
	while (!existsSync(marker) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(existsSync(marker), "the settlement closed the run's read ends: the abandoned writer's next write found them gone instead of those pipes holding the launcher open");
});

test("runCodegraph: a Windows tree kill confirmed once stays confirmed when a later attempt fails", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX fake-bin harness; the Windows settlement path itself runs through the kill seam");
	const bin = dir(t, "winkill-first-confirmed-bin");
	// The command exits by itself just after the deadline, so the close-time sweep wants the tree
	// gone beside the timeout's kill. The first attempt confirms it; a later one would fail only
	// because that attempt already removed the tree — which must never downgrade the teardown.
	writeFileSync(join(bin, "codegraph"), "#!/bin/sh\nsleep 0.35\nexit 1\n");
	chmodSync(join(bin, "codegraph"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath}`;
	t.after(() => {
		process.env.PATH = previousPath;
	});
	const kills: number[] = [];
	setTreeKillSeamForTests({
		platform: () => "win32",
		windowsKill: (_pid, onKilled) => {
			kills.push(Date.now());
			// First attempt: taskkill /F did terminate the tree. Any later one: the pid is already
			// gone, so taskkill comes back with an error.
			const first = kills.length === 1;
			setTimeout(() => onKilled(first), 20);
		},
	});
	t.after(() => setTreeKillSeamForTests(undefined));
	const infos: { ok: boolean; teardownUnconfirmed?: boolean }[] = [];
	const ok = await runCodegraph(["sync", "-q"], dir(t, "winkill-first-confirmed-cwd"), 200, undefined, (info) => infos.push(info));
	assert.equal(ok, false, "the timed-out command still reports the failure");
	assert.equal(kills.length, 1, "the timeout's kill, the escalation and the close-time sweep share one attempt per run");
	assert.equal(infos[infos.length - 1]?.teardownUnconfirmed, undefined, "a confirmation already reported is final, so the settlement neither waits out the cap nor reports an unproved teardown");
});

/** A backslash without a backslash literal: keeps the win32 fixture paths transport-safe. */
const WIN_BS = String.fromCharCode(92);

/** A resolved-shim fixture: the node and entrypoint a win32 codegraph.cmd resolves to. */
const RESOLVED = {
	node: ["C:", "nodejs", "node.exe"].join(WIN_BS),
	script: ["C:", "npm-bin", "node_modules", "@colbymchenry", "codegraph", "dist", "cli.js"].join(WIN_BS),
};

/** Discriminates the seam spawn's argument forms. Array.isArray cannot exclude a readonly
 * array in its false branch (a readonly string[] is not assignable to any[]), so the recorder
 * narrows with its own predicate instead. */
const isArgVector = (value: readonly string[] | SpawnOptions | undefined): value is readonly string[] => Array.isArray(value);

/** Records every spawn a seam makes, so the win32/POSIX spawn selection is observable off
 * Windows without any real child process. */
function recordingSeam(platform: NodeJS.Platform, entry: { node: string; script: string } | null): {
	seam: SpawnCodegraphSeam;
	calls: Array<{ command: string; args?: string[]; options: SpawnOptions }>;
	resolutions: number;
} {
	const calls: Array<{ command: string; args?: string[]; options: SpawnOptions }> = [];
	let resolutions = 0;
	const seam: SpawnCodegraphSeam = {
		platform: () => platform,
		spawn: (command, argsOrOptions, maybeOptions) => {
			const options = (isArgVector(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
			calls.push(isArgVector(argsOrOptions) ? { command, args: [...argsOrOptions], options } : { command, options });
			// Only the child reference itself is returned: a pid-shaped stand-in is all spawnCodegraph does with it.
			return { pid: 4242 } as unknown as ReturnType<SpawnCodegraphSeam["spawn"]>;
		},
		resolveEntry: () => {
			resolutions += 1;
			return entry;
		},
	};
	// The count is a getter, not a snapshot: a construction-time copy could never see a later
	// resolution, so an assertion read after the call can actually fail.
	return { seam, calls, get resolutions() { return resolutions; } };
}

test("spawnCodegraph: a resolved win32 shim spawns node with the entrypoint as an argument vector", () => {
	const { seam, calls } = recordingSeam("win32", RESOLVED);
	spawnCodegraph(["sync", "-q"], ["ignore", "pipe", "pipe"], seam);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, RESOLVED.node);
	assert.deepEqual(calls[0].args, [RESOLVED.script, "sync", "-q"], "the entrypoint leads the argument vector: no cmd.exe, no shim, no quoting");
	assert.deepEqual(calls[0].options, { cwd: tmpdir(), env: process.env, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	assert.equal("shell" in calls[0].options, false, "the direct path never consults a shell");
});

test("spawnCodegraph: a literal percent rides the resolved win32 vector without the cmd.exe rejection", () => {
	const { seam, calls } = recordingSeam("win32", RESOLVED);
	const percentArg = ["C:", "repos", "%USERNAME%"].join(WIN_BS);
	assert.doesNotThrow(() => spawnCodegraph(["sync", "-q", percentArg], ["ignore", "ignore", "ignore"], seam));
	assert.deepEqual(calls[0]?.args?.slice(1), ["sync", "-q", percentArg], "an argument vector carries the percent to codegraph verbatim");
});

test("spawnCodegraph: an unresolvable shim keeps the exact cmd.exe string fallback", () => {
	const { seam, calls } = recordingSeam("win32", null);
	const args = ["sync", "-q", ["C:", "proj"].join(WIN_BS)];
	spawnCodegraph(args, ["pipe", "pipe", "ignore"], seam);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, buildWindowsCommand(args), "the fallback builds exactly the cmd.exe command line it always did");
	assert.equal(calls[0].args, undefined);
	assert.deepEqual(calls[0].options, { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
});

test("spawnCodegraph: the fallback still refuses a percent argument", () => {
	const { seam } = recordingSeam("win32", null);
	assert.throws(() => spawnCodegraph(["sync", "%USERNAME%"], ["ignore", "ignore", "ignore"], seam), /percent/);
});

test("spawnCodegraph: POSIX spawns the plain argument vector and never consults the resolver", () => {
	const recorded = recordingSeam("linux", RESOLVED);
	spawnCodegraph(["sync", "-q"], ["ignore", "pipe", "pipe"], recorded.seam);
	// Read the live count after the call: a construction-time snapshot would still read zero
	// here even if POSIX had consulted the resolver.
	assert.equal(recorded.resolutions, 0, "S11: the resolver is consulted on win32 only");
	assert.deepEqual(recorded.calls, [{ command: "codegraph", args: ["sync", "-q"], options: { cwd: tmpdir(), env: process.env, detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] } }]);
});
