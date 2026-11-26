import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// The mods import the host module "herdr", which only exists inside the Herdr app. Load the real
// snapshot.js with that import pointed at a stub, so the shipped code is what runs.
const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "herdr", "mods", "gentle-status", "snapshot.js");
const STUB = "data:text/javascript," + encodeURIComponent([
	"export const agents = () => []; export const terminals = () => []; export const panes = () => [];",
	"export const focused = () => null; export const layout = () => null; export const watchFolder = () => () => {};",
	"export const run = () => {}; export const shared = () => undefined; export const setShared = () => {};",
	"export const home = () => globalThis.__livenessHome;",
	"export const exec = (...args) => globalThis.__livenessExec(...args);",
].join("\n"));

type ExecResult = { code: number; stdout: string; stderr?: string };
type ExecCall = { command: string; args: string[] };

let loads = 0;
async function loadSnapshot(t: test.TestContext, host: { home: string; exec: (call: ExecCall) => ExecResult | Promise<ExecResult> }) {
	const dir = mkdtempSync(join(tmpdir(), "liveness-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const source = readFileSync(SNAPSHOT, "utf8").replace(/from "herdr";/, `from "${STUB}";`);
	assert.ok(source.includes(STUB), "the herdr import was redirected to the stub");
	const file = join(dir, "snapshot.mjs");
	writeFileSync(file, source);
	const calls: ExecCall[] = [];
	const g = globalThis as Record<string, unknown>;
	g.__livenessHome = host.home;
	g.__livenessExec = async (command: string, args: string[]) => { calls.push({ command, args }); return host.exec({ command, args }); };
	t.after(() => { delete g.__livenessHome; delete g.__livenessExec; });
	// A fresh module instance per test: liveFeeds keeps a module-level cache of recent checks.
	const mod = await import(`${pathToFileURL(file).href}?load=${++loads}`);
	return { mod, calls };
}

const WINDOWS_HOME = "C:/Users/dev";
const feedFor = (pid: number, startedAt?: number) => ({ identity: { pid, sessionId: `s${pid}`, ...(startedAt === undefined ? {} : { startedAt }) } });
const tasklist = (...pids: number[]) => ({ code: 0, stdout: ["System Idle Process", ...pids.map((p) => `app${p}.exe`)].map((name, i) => `"${name}","${i === 0 ? 0 : pids[i - 1]}","Console","1","10,000 K"`).join("\r\n") + "\r\n" });

test("should drop a feed whose publisher is not in the Windows process list", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.deepEqual(live.map((f: { identity: { pid: number } }) => f.identity.pid), [200]);
});

test("should ask tasklist, not ps, on a Windows host when the enumeration fails", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	await mod.liveFeeds([feedFor(200)]);
	assert.deepEqual(calls.map((c) => c.command), ["powershell", "tasklist"]);
});

test("should keep every feed when the Windows process list cannot be read", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => { throw new Error("no tasklist"); } });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.equal(live.length, 2);
});

test("should drop a feed whose pid now belongs to a process started at a different time", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` }),
	});
	assert.deepEqual(await mod.liveFeeds([feedFor(200, startedAt)]), []);
});

test("should keep a feed whose pid runs a process started when the publisher started", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 800}\r\n` }),
	});
	assert.equal((await mod.liveFeeds([feedFor(200, startedAt)])).length, 1);
});

test("should fall back to the pid alone when the feed carries no start time", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
	assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1);
	assert.deepEqual(calls.map((c) => c.command), ["powershell", "tasklist"]);
});

test("should keep a listed feed on the pid alone, unconfirmed, when the OS creation time cannot be read", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => { if (command === "tasklist") return tasklist(200); throw new Error("no creation time"); } });
	const live = await mod.liveFeeds([feedFor(200, 1_700_000_000_000), feedFor(100, 1_700_000_000_000)]);
	assert.deepEqual(live.map((f: { identity: { pid: number } }) => f.identity.pid), [200]);
	assert.ok(calls.length > 1, "the creation time was asked for before falling back to the pid");
});

test("should keep checking with ps on a POSIX host", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: "/home/dev", exec: ({ command }) => (command === "ps" ? { code: 1, stdout: "  200\n" } : { code: 2, stdout: "" }) });
	const live = await mod.liveFeeds([feedFor(100), feedFor(200)]);
	assert.deepEqual(live.map((f: { identity: { pid: number } }) => f.identity.pid), [200]);
	assert.deepEqual(calls.map((c) => c.command), ["ps"]);
});

test("should parse the pids out of tasklist CSV output", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => ({ code: 1, stdout: "" }) });
	assert.deepEqual([...mod.parseTasklistPids(tasklist(4, 4321).stdout)].sort((a: number, b: number) => a - b), [0, 4, 4321]);
	assert.equal(mod.parseTasklistPids("").size, 0);
});

test("should treat processes whose start times differ by more than the tolerance as different", async (t) => {
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => ({ code: 1, stdout: "" }) });
	assert.equal(mod.sameProcess(1_000_000, 1_000_000 + 2_000), true);
	assert.equal(mod.sameProcess(1_000_000, 1_000_000 + 60_000), false);
	assert.equal(mod.sameProcess(undefined, 5), true);
});

test("should keep a Linux home that contains a backslash on the ps path", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: "/home/team\\dev", exec: ({ command }) => (command === "ps" ? { code: 0, stdout: "  200\n" } : { code: 2, stdout: "" }) });
	assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1);
	assert.deepEqual(calls.map((c) => c.command), ["ps"]);
});

test("should treat a drive path and a UNC path as a Windows host", async (t) => {
	for (const home of ["C:\\Users\\dev", "C:/Users/dev", "\\\\server\\share\\dev"]) {
		const { mod, calls } = await loadSnapshot(t, { home, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" }) });
		await mod.liveFeeds([feedFor(200)]);
		assert.equal(calls[0]?.command, "powershell", home);
		assert.equal(calls[1]?.command, "tasklist", home);
	}
});

test("should drop a recycled pid that started seconds after an OS-stamped publisher", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 8_000}\r\n` }),
	});
	const stamped = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	assert.deepEqual(await mod.liveFeeds([stamped]), []);
});

test("should keep the wide tolerance for a start time the publisher only estimated", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt + 8_000}\r\n` }),
	});
	assert.equal((await mod.liveFeeds([feedFor(200, startedAt)])).length, 1);
});

test("should judge each feed against the process start time on its own when two share a pid", async (t) => {
	const older = Date.UTC(2026, 10, 19, 12, 0, 0);
	const newer = older + 3_600_000;
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${newer}\r\n` }),
	});
	const feeds = [
		{ identity: { pid: 200, sessionId: "newer", startedAt: newer, startedAtSource: "os" } },
		{ identity: { pid: 200, sessionId: "older", startedAt: older, startedAtSource: "os" } },
		{ identity: { pid: 200, sessionId: "unstamped" } },
	];
	const live = await mod.liveFeeds(feeds);
	assert.deepEqual(live.map((f: { identity: { sessionId: string } }) => f.identity.sessionId), ["newer", "unstamped"]);
});

test("should recheck the creation time after the liveness cache expires even if the pid never left the list", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	let osStart = startedAt;
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${osStart}\r\n` }),
	});
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	assert.equal((await mod.liveFeeds([feed])).length, 1);
	osStart = startedAt + 3_600_000; // the pid was reused by a process that started much later
	clock += 6_000; // past ALIVE_MS
	assert.deepEqual(await mod.liveFeeds([feed]), []);
});

test("should start the liveness interval when the check completes, not when it starts", async (t) => {
	for (const home of [WINDOWS_HOME, "/home/dev"]) {
		let clock = 1_000_000;
		t.mock.method(Date, "now", () => clock);
		const { mod, calls } = await loadSnapshot(t, {
			home,
			exec: ({ command }) => {
				clock += 8_000; // the query itself takes longer than ALIVE_MS
				return command === "powershell" ? { code: 0, stdout: "200,\r\n" } : { code: 0, stdout: "  200\n" };
			},
		});
		assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1, `${home}: the first call lists the running feed`);
		const first = calls.length;
		assert.ok(first > 0, `${home}: the first call ran a check`);
		assert.equal(calls[0].command, home === WINDOWS_HOME ? "powershell" : "ps", `${home}: the first call used the platform's process check`);
		assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1, `${home}: the second call still lists it`);
		assert.equal(calls.length, first, `${home}: an immediate second call reuses the result`);
		clock += 5_000;
		await mod.liveFeeds([feedFor(200)]);
		assert.ok(calls.length > first, `${home}: the result expires ALIVE_MS after the check ended`);
		(Date.now as unknown as { mock: { restore(): void } }).mock.restore();
	}
});

const pidsOf = (feeds: { identity: { pid: number } }[]) => feeds.map((f) => f.identity.pid);

test("should read presence and creation time from one enumeration and not ask tasklist", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod, calls } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: `200,${startedAt}\r\n300,\r\n` } : { code: 1, stdout: "" }),
	});
	const stamped = { identity: { pid: 200, sessionId: "a", startedAt, startedAtSource: "os" } };
	const live = await mod.liveFeeds([stamped, feedFor(300, startedAt), feedFor(400, startedAt)]);
	assert.deepEqual(pidsOf(live), [200, 300], "a pid listed without a creation time keeps the pid-only verdict; an absent pid is dropped");
	assert.deepEqual(calls.map((c) => c.command), ["powershell"]);
});

test("should keep a confirmed creation-time mismatch when a later check only sees the pid", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	for (const later of ["tasklist", "no creation time"]) {
		let phase = 0;
		const { mod, calls } = await loadSnapshot(t, {
			home: WINDOWS_HOME,
			exec: ({ command }) => {
				if (phase === 0) return command === "powershell" ? { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` } : { code: 1, stdout: "" };
				if (later === "tasklist") return command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" };
				return command === "powershell" ? { code: 0, stdout: "200,\r\n" } : { code: 1, stdout: "" };
			},
		});
		let clock = 1_000_000;
		t.mock.method(Date, "now", () => clock);
		const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
		assert.deepEqual(await mod.liveFeeds([feed]), [], `${later}: the mismatch drops the feed`);
		phase = 1;
		clock += 6_000;
		const before = calls.length;
		assert.deepEqual(await mod.liveFeeds([feed]), [], `${later}: a pid-only verdict does not bring it back`);
		assert.deepEqual(calls.slice(before).map((c) => c.command), later === "tasklist" ? ["powershell", "tasklist"] : ["powershell"], `${later}: the process list was asked again once the negative verdict expired`);
		(Date.now as unknown as { mock: { restore(): void } }).mock.restore();
	}
});

test("should keep a confirmed creation-time mismatch through an absent pid and a later pid-only presence", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const replies = [`200,${startedAt + 3_600_000}\r\n`, "", "200,\r\n"];
	let phase = 0;
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: replies[phase] } : { code: 1, stdout: "" }) });
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	assert.deepEqual(await mod.liveFeeds([feed]), [], "the mismatch drops the feed");
	for (phase = 1; phase < replies.length; phase++) {
		clock += 6_000;
		assert.deepEqual(await mod.liveFeeds([feed]), [], `phase ${phase}: the feed stays dropped (${phase === 1 ? "pid absent" : "pid-only presence"})`);
	}
});

test("should keep the verdict of a current feed when the sweep runs after a failed enumeration", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const others = Array.from({ length: 300 }, (_, i) => feedFor(1000 + i));
	let fail = false;
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => {
			if (fail) throw new Error("no process list");
			const rows = [`200,${startedAt + 3_600_000}`, ...others.map((f) => `${f.identity.pid},`)].join("\r\n") + "\r\n";
			return command === "powershell" ? { code: 0, stdout: rows } : { code: 1, stdout: "" };
		},
	});
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	const listed = await mod.liveFeeds([feed, ...others]);
	assert.equal(listed.length, 300, "more than 256 identities are cached, and the replaced pid is dropped");
	assert.ok(!listed.some((f: { identity: { pid: number } }) => f.identity.pid === 200), "the confirmed mismatch drops the feed");
	fail = true;
	clock += 120_000;
	assert.deepEqual(await mod.liveFeeds([feed]), [], "the sweep after a failed enumeration kept the current feed's negative verdict");
});

test("should evaluate snapshots with the same pid and start time but different sources independently", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const osStart = startedAt + 5_000;
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: `200,${osStart}\r\n` } : { code: 1, stdout: "" }) });
	const feeds = [
		{ identity: { pid: 200, sessionId: "os", startedAt, startedAtSource: "os" } },
		{ identity: { pid: 200, sessionId: "estimate", startedAt, startedAtSource: "estimate" } },
	];
	const live = await mod.liveFeeds(feeds);
	assert.deepEqual(live.map((f: { identity: { sessionId: string } }) => f.identity.sessionId), ["estimate"]);
});

test("should ask the process list once for a pid shared by several feeds", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: `200,${startedAt}\r\n` } : { code: 1, stdout: "" }) });
	await mod.liveFeeds([
		{ identity: { pid: 200, sessionId: "a", startedAt, startedAtSource: "os" } },
		{ identity: { pid: 200, sessionId: "b", startedAt, startedAtSource: "estimate" } },
	]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].args.at(-1)?.match(/@\(([^)]*)\)/)?.[1], "200");
});

test("should let a later matching creation time clear an earlier mismatch", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	let osStart = startedAt + 3_600_000;
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: `200,${osStart}\r\n` } : { code: 1, stdout: "" }) });
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	assert.deepEqual(await mod.liveFeeds([feed]), []);
	osStart = startedAt;
	clock += 6_000;
	assert.equal((await mod.liveFeeds([feed])).length, 1);
});

test("should not let a check that started earlier overwrite the verdict of a later one", async (t) => {
	t.mock.method(Date, "now", () => 1_000_000);
	for (const home of [WINDOWS_HOME, "/home/dev"]) {
		const pending: ((result: ExecResult) => void)[] = [];
		const { mod } = await loadSnapshot(t, { home, exec: () => new Promise<ExecResult>((resolve) => { pending.push(resolve); }) });
		const feed = feedFor(200);
		const first = mod.liveFeeds([feed]);
		const second = mod.liveFeeds([feed]);
		assert.equal(pending.length, 2, `${home}: both checks started before either finished`);
		const windows = home === WINDOWS_HOME;
		pending[1](windows ? { code: 0, stdout: "" } : { code: 1, stdout: "" });
		assert.deepEqual(await second, [], `${home}: the later check found the publisher gone`);
		pending[0](windows ? { code: 0, stdout: "200,\r\n" } : { code: 0, stdout: "  200\n" });
		assert.deepEqual(await first, [], `${home}: the first caller receives an empty feed`);
		assert.deepEqual(await mod.liveFeeds([feed]), [], `${home}: the stale result did not bring the feed back`);
	}
});

test("should keep a confirmed mismatch whichever overlapping check finishes first when the other only sees the pid", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const mismatchReply = { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` };
	const pidOnlyReply = { code: 0, stdout: "200,\r\n" };
	t.mock.method(Date, "now", () => 1_000_000);
	for (const order of ["later pid-only finishes first", "earlier mismatch finishes first"]) {
		const pending: ((result: ExecResult) => void)[] = [];
		const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => new Promise<ExecResult>((resolve) => { pending.push(resolve); }) });
		const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
		const first = mod.liveFeeds([feed]);
		const second = mod.liveFeeds([feed]);
		assert.equal(pending.length, 2, `${order}: both checks started before either finished`);
		if (order === "later pid-only finishes first") {
			pending[1](pidOnlyReply);
			await second;
			pending[0](mismatchReply);
			assert.deepEqual(await first, [], `${order}: the first caller does not receive the replaced feed`);
		} else {
			pending[0](mismatchReply);
			assert.deepEqual(await first, [], `${order}: the mismatch drops the feed`);
			pending[1](pidOnlyReply);
			await second;
		}
		assert.deepEqual(await mod.liveFeeds([feed]), [], `${order}: the feed stays hidden afterwards`);
	}
});

test("should keep a confirmed mismatch past the age limit while its feed is absent from a pruning refresh", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const others = Array.from({ length: 300 }, (_, i) => feedFor(1000 + i));
	let phase = 0;
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => {
			if (command !== "powershell") return { code: 1, stdout: "" };
			if (phase === 0) return { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` };
			if (phase === 1) return { code: 0, stdout: others.map((f) => `${f.identity.pid},`).join("\r\n") + "\r\n" };
			return { code: 0, stdout: "200,\r\n" };
		},
	});
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	assert.deepEqual(await mod.liveFeeds([feed]), [], "the mismatch drops the feed");
	phase = 1;
	clock += 120_000;
	assert.equal((await mod.liveFeeds(others)).length, 300, "a refresh without the feed fills the cache and runs the pruning sweep");
	phase = 2;
	clock += 120_000;
	assert.deepEqual(await mod.liveFeeds([feed]), [], "the feed returns with only its pid visible and stays hidden");
});

test("should keep a publisher that was absent hidden when a later check only sees its pid again", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	let phase = 0;
	const { mod } = await loadSnapshot(t, {
		home: WINDOWS_HOME,
		exec: ({ command }) => {
			if (phase === 0) return command === "powershell" ? { code: 0, stdout: "" } : { code: 1, stdout: "" };
			return command === "tasklist" ? tasklist(200) : { code: 1, stdout: "" };
		},
	});
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const stamped = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	const unstamped = { identity: { pid: 300, sessionId: "u" } };
	assert.deepEqual(await mod.liveFeeds([stamped, unstamped]), [], "both are absent and dropped");
	phase = 1;
	clock += 6_000;
	const live = await mod.liveFeeds([stamped, { identity: { pid: 200, sessionId: "u2" } }, { identity: { pid: 300, sessionId: "u" } }]);
	assert.ok(!live.some((f: { identity: { sessionId: string } }) => f.identity.sessionId === "s"), "the stamped publisher that was absent stays hidden on a pid-only check");
});

test("should recheck a verdict whose age is negative because the clock moved backward", async (t) => {
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "powershell" ? { code: 0, stdout: "200,\r\n" } : { code: 1, stdout: "" }) });
	let clock = 10_000_000;
	t.mock.method(Date, "now", () => clock);
	assert.equal((await mod.liveFeeds([feedFor(200)])).length, 1);
	const before = calls.length;
	clock -= 3_600_000;
	await mod.liveFeeds([feedFor(200)]);
	assert.ok(calls.length > before, "the process list was asked again instead of trusting a verdict from the future");
});

test("should not let a pid-only check erase a comparable match before an earlier check reports a mismatch", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const pending: ((result: ExecResult) => void)[] = [];
	const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => new Promise<ExecResult>((resolve) => { pending.push(resolve); }) });
	let clock = 1_000_000;
	t.mock.method(Date, "now", () => clock);
	const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
	const a = mod.liveFeeds([feed]);
	const b = mod.liveFeeds([feed]);
	assert.equal(pending.length, 2);
	pending[1]({ code: 0, stdout: `200,${startedAt}\r\n` });
	assert.equal((await b).length, 1, "the later check matched");
	clock += 6_000;
	const c = mod.liveFeeds([feed]);
	assert.equal(pending.length, 3);
	pending[2]({ code: 0, stdout: "200,\r\n" });
	assert.equal((await c).length, 1, "the newest check only saw the pid");
	pending[0]({ code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` });
	await a;
	assert.equal((await mod.liveFeeds([feed])).length, 1, "the late mismatch did not override the later comparable match");
});

test("should settle on the latest comparable evidence whichever order three overlapping checks finish in", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const replies = {
		match: { code: 0, stdout: `200,${startedAt}\r\n` },
		mismatch: { code: 0, stdout: `200,${startedAt + 3_600_000}\r\n` },
		pidOnly: { code: 0, stdout: "200,\r\n" },
	};
	const kinds = ["mismatch", "match", "pidOnly"] as const; // the checks start in this order: 1, 2, 3
	const orders: number[][] = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]];
	for (const order of orders) {
		const pending: ((result: ExecResult) => void)[] = [];
		const { mod } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: () => new Promise<ExecResult>((resolve) => { pending.push(resolve); }) });
		let clock = 1_000_000;
		t.mock.method(Date, "now", () => clock);
		const feed = { identity: { pid: 200, sessionId: "s", startedAt, startedAtSource: "os" } };
		const calls = [mod.liveFeeds([feed])];
		calls.push(mod.liveFeeds([feed]));
		calls.push(mod.liveFeeds([feed]));
		assert.equal(pending.length, 3, "three checks are in flight");
		for (const index of order) { pending[index](replies[kinds[index]]); await calls[index]; }
		const label = order.map((i) => kinds[i]).join(" -> ");
		assert.equal((await mod.liveFeeds([feed])).length, 1, `${label}: the match (check 2) is newer than the mismatch (check 1), so the feed is listed`);
		(Date.now as unknown as { mock: { restore(): void } }).mock.restore();
	}
});

test("should share one verdict between snapshots whose startedAtSource only differs outside the two classes sameProcess uses", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt}
` }) });
	const withSource = (startedAtSource: unknown) => ({ identity: { pid: 200, sessionId: "s200", startedAt, startedAtSource } });
	await mod.liveFeeds([withSource("estimate")]);
	const before = calls.length;
	await mod.liveFeeds([withSource({ odd: true })]);
	await mod.liveFeeds([withSource("clock")]);
	assert.equal(calls.length, before, "an unrecognised source reuses the estimate verdict instead of opening a new cache entry");
});

test("should keep telling an OS-stamped snapshot apart from an estimated one", async (t) => {
	const startedAt = Date.UTC(2026, 10, 19, 12, 0, 0);
	const { mod, calls } = await loadSnapshot(t, { home: WINDOWS_HOME, exec: ({ command }) => (command === "tasklist" ? tasklist(200) : { code: 0, stdout: `200,${startedAt}
` }) });
	const withSource = (startedAtSource: string) => ({ identity: { pid: 200, sessionId: "s200", startedAt, startedAtSource } });
	await mod.liveFeeds([withSource("estimate")]);
	const before = calls.length;
	await mod.liveFeeds([withSource("os")]);
	assert.ok(calls.length > before, "the os class is checked on its own");
});
