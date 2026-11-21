import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectProbe, daemonFor, daemonHealth, exploreViaDaemon, liveDaemons, mcpLineReader, mcpReplyKind, parseMcpReply, registeredDaemons, resetDaemonRegistryMemo, setPipeProbeForTests, socketPresent } from "../lib/codegraph-daemon.ts";
import type { McpReply, PipeProbeOutcome } from "../lib/codegraph-daemon.ts";
import { canonicalRoot } from "../lib/codegraph-canonical.ts";

function dir(t: test.TestContext, name: string): string {
	const cwd = mkdtempSync(join(tmpdir(), `gentle-codegraph-daemon-${name}-`));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

interface FakeDaemon {
	socketPath: string;
	registryDir: string;
	/** Resolves when the server is listening and its socket file exists. */
	ready: Promise<void>;
	/** How many clients the server accepted; the budget tests assert no socket was opened. */
	connections: () => number;
}

/**
 * The path the fake daemon binds: a unique \\.\pipe\ name on Windows — an IPC path there must live
 * in the pipe namespace or server.listen fails and daemon.ready never resolves, the same pipe
 * handling lib/codegraph-daemon.ts speaks — and the socket file next to the registry elsewhere.
 */
function fakeDaemonSocketPath(platform: NodeJS.Platform, home: string): string {
	if (platform === "win32") return `\\\\.\\pipe\\gentle-shell-codegraph-daemon-${randomUUID()}`;
	return join(home, "daemon.sock");
}

/**
 * An in-process daemon speaking the CodeGraph socket protocol: a hello line as soon as a client
 * connects, then initialize and one tools/call reply per the given scripts.
 */
/** Registration knobs for one fake daemon: a shared registry directory, its record file name,
 * and its age - the ordering tests need two live daemons in one registry. */
interface FakeDaemonOptions {
	registryDir?: string;
	recordName?: string;
	startedAt?: number;
}

function fakeDaemon(
	t: test.TestContext,
	project: string,
	hello: string | undefined,
	initialize: object,
	call: object,
	options: FakeDaemonOptions = {},
): FakeDaemon {
	const home = dir(t, "home");
	const registryDir = options.registryDir ?? join(home, ".codegraph", "daemons");
	mkdirSync(registryDir, { recursive: true });
	const socketPath = fakeDaemonSocketPath(process.platform, home);
	let resolveReady: () => void = () => {};
	let rejectReady: (error: Error) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	let connections = 0;
	const server = net.createServer((socket) => {
		connections++;
		// A client that settles mid-conversation destroys its socket; on Windows named pipes
		// the server's in-flight write then fails asynchronously with EPIPE, and an unhandled
		// 'error' event would rethrow into the test run (win-only, RID 20261118-165111).
		socket.on("error", () => {});
		if (hello !== undefined) socket.write(`${hello}\n`);
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				const message = JSON.parse(line) as { id?: number; method?: string };
				if (message.method === "initialize") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: initialize })}\n`);
				if (message.method === "tools/call") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: call })}\n`);
			}
		});
	});
	// A listen failure — a socket path past the platform's length limit, a busy pipe — arrives as an
	// 'error' event; routed into the promise it rejects ready with the cause instead of hanging.
	server.on("error", rejectReady);
	server.listen(socketPath, () => resolveReady());
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	writeFileSync(join(registryDir, options.recordName ?? "record.json"), JSON.stringify({ root: project, socketPath, startedAt: options.startedAt ?? 1, pid: process.pid }));
	return { socketPath, registryDir, ready, connections: () => connections };
}

const HELLO = JSON.stringify({ codegraph: "1.6.0", protocol: 1 });
const INITIALIZED = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "0" } };
const ANSWER = { content: [{ type: "text", text: "daemon answer" }], isError: false };

test("exploreViaDaemon answers through the daemon socket without spawning a process", async (t) => {
	const project = dir(t, "project");
	const daemon = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER);
	await daemon.ready;
	const result = await exploreViaDaemon(project, "codegraph_explore", { query: "main" }, 2_000, daemon.registryDir);
	assert.deepEqual(result, { status: "ok", text: "daemon answer" });
});

test("the fake daemon binds a unique Windows named pipe and a socket file elsewhere", (t) => {
	const home = dir(t, "socket-path");
	const pipe = fakeDaemonSocketPath("win32", home);
	assert.ok(pipe.startsWith("\\\\.\\pipe\\"), "a Windows IPC path must live in the \\\\.\\pipe\\ namespace");
	assert.ok(!pipe.includes(home), "the pipe name carries no filesystem path");
	assert.notEqual(pipe, fakeDaemonSocketPath("win32", home), "every daemon binds its own pipe");
	assert.equal(fakeDaemonSocketPath("darwin", home), join(home, "daemon.sock"), "other platforms keep the socket file next to the registry");
	assert.equal(fakeDaemonSocketPath("linux", home), join(home, "daemon.sock"));
});

test("exploreViaDaemon treats a protocol mismatch or a broken reply as unavailable", async (t) => {
	const wrongProtocol = dir(t, "wrong-protocol");
	const wrong = fakeDaemon(t, wrongProtocol, JSON.stringify({ codegraph: "1.6.0", protocol: 2 }), INITIALIZED, ANSWER);
	await wrong.ready;
	assert.deepEqual(await exploreViaDaemon(wrongProtocol, "codegraph_query", { query: "x" }, 2_000, wrong.registryDir), { status: "unavailable" });

	const brokenJson = dir(t, "broken-json");
	const broken = fakeDaemon(t, brokenJson, HELLO, INITIALIZED, { content: [{ type: "text", text: "x" }], isError: true });
	await broken.ready;
	assert.deepEqual(await exploreViaDaemon(brokenJson, "codegraph_query", { query: "x" }, 2_000, broken.registryDir), { status: "unavailable" });
});

test("exploreViaDaemon reports a daemon that accepts but never says hello as a timeout", async (t) => {
	const project = dir(t, "silent");
	const daemon = fakeDaemon(t, project, undefined, INITIALIZED, ANSWER);
	await daemon.ready;
	assert.deepEqual(
		await exploreViaDaemon(project, "codegraph_explore", { query: "main" }, 5_000, daemon.registryDir, 50),
		{ status: "timeout" },
	);
});

test("daemonHealth: a serving daemon is ok, a silent one wedged, no live daemon unreachable", async (t) => {
	const healthy = dir(t, "health-ok");
	const good = fakeDaemon(t, healthy, HELLO, INITIALIZED, ANSWER);
	await good.ready;
	assert.equal(await daemonHealth(healthy, good.registryDir), "ok", "a daemon that answers the probe serves");

	const wedged = dir(t, "health-wedged");
	const silent = fakeDaemon(t, wedged, undefined, INITIALIZED, ANSWER);
	await silent.ready;
	assert.equal(await daemonHealth(wedged, silent.registryDir, 50), "wedged", "alive but silent is wedged, not unreachable");

	const absent = dir(t, "health-absent");
	assert.equal(await daemonHealth(absent, join(absent, "registry")), "unreachable", "no live daemon sockets: no connection attempted");

	const gone = dir(t, "health-gone");
	const goneRegistry = join(gone, "registry");
	mkdirSync(goneRegistry, { recursive: true });
	writeFileSync(join(goneRegistry, "daemon.sock"), "");
	writeFileSync(join(goneRegistry, "record.json"), JSON.stringify({ root: gone, socketPath: join(goneRegistry, "daemon.sock"), startedAt: 1, pid: process.pid }));
	assert.equal(await daemonHealth(gone, goneRegistry), "unreachable", "a socket file without a listener is nobody to talk to, not a wedged daemon");
});

test("daemonHealth checks older candidates before declaring the project daemon wedged", async (t) => {
	const project = dir(t, "health-fallback");
	const registryDir = dir(t, "health-fallback-registry");
	const silent = fakeDaemon(t, project, undefined, INITIALIZED, ANSWER, { registryDir, recordName: "newer.json", startedAt: 2 });
	const older = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER, { registryDir, recordName: "older.json", startedAt: 1 });
	await silent.ready;
	await older.ready;
	assert.equal(await daemonHealth(project, registryDir, 50), "ok", "the newest is silent but the older daemon still serves, so the project is not wedged");
});

test("daemonHealth starts the shared probe deadline before socket discovery", async (t) => {
	// On Windows every uncached or inconclusive pipe probe can spend 250ms, so discovery must run
	// inside the caller's health budget, not before it starts: the probe discovery spends carries
	// the leftover of the one shared deadline, never a fresh full budget.
	const project = dir(t, "health-deadline");
	const registry = dir(t, "health-deadline-registry");
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root: project, socketPath: namedPipe("gentle-shell-health-deadline"), startedAt: 1, pid: process.pid }));
	const seen: Array<{ path: string; timeoutMs: number }> = [];
	setPipeProbeForTests((path, timeoutMs) => {
		seen.push({ path, timeoutMs });
		return "open";
	});
	t.after(() => setPipeProbeForTests(undefined));
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", platformDescriptor));
	await daemonHealth(project, registry, 50, 200);
	assert.deepEqual(seen.map((probe) => probe.path), [namedPipe("gentle-shell-health-deadline")], "discovery probed the daemon's own pipe");
	const probe = seen[0];
	assert.ok(probe !== undefined && probe.timeoutMs > 0 && probe.timeoutMs <= 200, "discovery's probe spent the shared health budget, never a fresh 250ms one");
});

test("daemonHealth queries the newest daemon before probing an older candidate", async (t) => {
	// Bulk discovery probed every candidate before the first query, so on Windows an older pipe's
	// probe could spend the whole shared deadline and the gate answered unreachable without ever
	// asking the healthy newest daemon — warm-up then spawned a second daemon for a project the
	// newest one already served. The mocked clock is pinned to a fixed base and moves only inside
	// the older pipe's probe, so exactly that probe decides the deadline is spent — never however
	// long a paused runner takes before the newest daemon is asked, which real-time offsetting let
	// spend the deadline — while the real socket handshake gets a separate, generous budget of its
	// own. The newest daemon is a plain socket file here and the platform mock routes only the
	// older record's pipe-shaped path through the probe layer.
	const project = dir(t, "health-interleave");
	const registry = dir(t, "health-interleave-registry");
	const healthy = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER, { registryDir: registry, recordName: "newest.json", startedAt: 2 });
	await healthy.ready;
	const olderPipe = namedPipe("gentle-shell-health-interleave-old");
	writeFileSync(join(registry, "older.json"), JSON.stringify({ root: project, socketPath: olderPipe, startedAt: 1, pid: process.pid }));
	const fixedNow = 1_700_000_000_000;
	let offset = 0;
	const probed: string[] = [];
	t.mock.method(Date, "now", () => fixedNow + offset);
	setPipeProbeForTests((path) => {
		if (path !== olderPipe) return "open";
		probed.push(path);
		// The older pipe's probe burns the rest of the budget, like a pipe that never answers.
		offset = 10_000;
		return "inconclusive";
	});
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
	t.after(() => {
		setPipeProbeForTests(undefined);
		Object.defineProperty(process, "platform", platformDescriptor);
	});
	assert.equal(await daemonHealth(project, registry, 2_000, 2_000), "ok", "the newest daemon answered before the older pipe's probe spent the budget");
	assert.equal(healthy.connections(), 1, "the gate really asked the newest daemon");
	assert.deepEqual(probed, [], "the older candidate was never probed once the newest daemon answered");
});

test("null and other non-object JSON replies never reach dispatch on either transport", async (t) => {
	// JSON.parse accepts null, numbers, strings, arrays and booleans too; reading .codegraph or .id on
	// null throws outside every conversation's error handling, so only a reply object may leave the parser.
	assert.equal(parseMcpReply("null"), undefined);
	assert.equal(parseMcpReply("42"), undefined);
	assert.equal(parseMcpReply('"a string"'), undefined);
	assert.equal(parseMcpReply("[1,2]"), undefined);
	assert.equal(parseMcpReply("true"), undefined);
	assert.deepEqual(parseMcpReply('{"id":2}'), { id: 2 }, "a reply object still parses");

	// The stdio warm-up drives this same reader and hands every line to mcpReplyKind (lib/codegraph-readiness.ts):
	// null and non-object lines come back as undefined and the conversation keeps going instead of
	// dying on message.id.
	const kinds: Array<"initialize" | "call" | undefined> = [];
	const readStdout = mcpLineReader((message) => {
		kinds.push(message === undefined ? undefined : mcpReplyKind(message));
		return false;
	});
	assert.equal(readStdout(Buffer.from('null\n42\n{"jsonrpc":"2.0","id":1}\n')), false);
	assert.deepEqual(kinds, [undefined, undefined, "initialize"], "rejected lines are skipped and the valid reply still dispatches");

	// The socket conversation reads message.codegraph with the same exposure: a daemon that opens
	// with null is merely unavailable, never an uncaught exception.
	const nullHello = dir(t, "null-hello");
	const daemon = fakeDaemon(t, nullHello, "null", INITIALIZED, ANSWER);
	await daemon.ready;
	assert.deepEqual(await exploreViaDaemon(nullHello, "codegraph_explore", { query: "main" }, 2_000, daemon.registryDir), { status: "unavailable" });

	const healthy = dir(t, "healthy");
	const good = fakeDaemon(t, healthy, HELLO, INITIALIZED, ANSWER);
	await good.ready;
	assert.deepEqual(await exploreViaDaemon(healthy, "codegraph_explore", { query: "main" }, 2_000, good.registryDir), { status: "ok", text: "daemon answer" }, "a well-formed conversation still dispatches");
});

test("daemonFor picks the newest of two live daemons in equivalent spellings", async (t) => {
	const project = dir(t, "newest");
	const registryDir = dir(t, "newest-registry");
	const older = fakeDaemon(t, `${project}//`, HELLO, INITIALIZED, ANSWER, { registryDir, recordName: "older.json", startedAt: 1 });
	const newer = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER, { registryDir, recordName: "newer.json", startedAt: 2 });
	await older.ready;
	await newer.ready;
	const found = daemonFor(project, registryDir);
	assert.equal(found.alive, true, "both daemons are live for the project");
	assert.equal(found.root, project, "daemonFor answers with the newer daemon's spelling, not the older one's");
});

test("two live daemons: the newer socket receives the call first", async (t) => {
	const project = dir(t, "order");
	const registryDir = dir(t, "order-registry");
	const newer = fakeDaemon(t, project, HELLO, INITIALIZED, { ...ANSWER, content: [{ type: "text", text: "newer answer" }] }, { registryDir, recordName: "newer.json", startedAt: 2 });
	const older = fakeDaemon(t, project, HELLO, INITIALIZED, { ...ANSWER, content: [{ type: "text", text: "older answer" }] }, { registryDir, recordName: "older.json", startedAt: 1 });
	await newer.ready;
	await older.ready;
	assert.deepEqual(
		await exploreViaDaemon(project, "codegraph_explore", { query: "main" }, 2_000, registryDir),
		{ status: "ok", text: "newer answer" },
		"the newer daemon answers, so the older socket never receives the call",
	);
});

test("a silent newer daemon hands the remaining budget to the older socket", async (t) => {
	const project = dir(t, "fallback");
	const registryDir = dir(t, "fallback-registry");
	const silent = fakeDaemon(t, project, undefined, INITIALIZED, ANSWER, { registryDir, recordName: "newer.json", startedAt: 2 });
	const older = fakeDaemon(t, project, HELLO, INITIALIZED, { ...ANSWER, content: [{ type: "text", text: "older answer" }] }, { registryDir, recordName: "older.json", startedAt: 1 });
	await silent.ready;
	await older.ready;
	assert.deepEqual(
		await exploreViaDaemon(project, "codegraph_explore", { query: "main" }, 5_000, registryDir, 50),
		{ status: "ok", text: "older answer" },
		"the newer daemon stayed silent, so the older one answered within the remaining budget",
	);
});

test("exploreViaDaemon opens no socket once the deadline is spent", async (t) => {
	const project = dir(t, "spent");
	const daemon = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER);
	await daemon.ready;
	assert.deepEqual(await exploreViaDaemon(project, "codegraph_explore", { query: "main" }, 0, daemon.registryDir), { status: "unavailable" }, "a spent deadline answers without a conversation");
	assert.equal(daemon.connections(), 0, "the clamp inside ask must not buy one more socket attempt");
});

test("registeredDaemons reads the registry once per project per window", (t) => {
	const project = dir(t, "memo");
	const registry = dir(t, "memo-registry");
	const record = join(registry, "record.json");
	const entry = { root: project, socketPath: join(registry, "daemon.sock"), pid: process.pid };
	writeFileSync(record, JSON.stringify({ ...entry, startedAt: 1 }));
	const read = registeredDaemons(project, registry);
	assert.equal(read.length, 1);
	writeFileSync(record, JSON.stringify({ ...entry, startedAt: 2 }));
	assert.deepEqual(registeredDaemons(project, registry), read, "within the window the second read is the memoized first one");
	resetDaemonRegistryMemo();
	const fresh = registeredDaemons(project, registry);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0]?.startedAt, 2, "after the reset the mutated record is read again");
});

test("registry roots in any separator spelling match the project", async (t) => {
	const project = dir(t, "spelling");
	const daemon = fakeDaemon(t, `${project}//`, HELLO, INITIALIZED, ANSWER);
	await daemon.ready;
	const found = daemonFor(project, daemon.registryDir);
	assert.equal(found.alive, true, "a trailing double separator is the same project");
	assert.equal(found.root, `${project}//`, "the registered spelling is returned as-is");
});

test("liveDaemons keeps only the records whose pid is alive and socket present", (t) => {
	const project = dir(t, "live");
	const registry = dir(t, "live-registry");
	const liveSocket = join(registry, "live.sock");
	writeFileSync(liveSocket, "");
	const deadSocket = join(registry, "dead-pid.sock");
	writeFileSync(deadSocket, "");
	const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
	assert.ok(typeof exited.pid === "number" && exited.pid > 0);
	writeFileSync(join(registry, "one.json"), JSON.stringify({ root: project, socketPath: liveSocket, startedAt: 2, pid: process.pid }));
	writeFileSync(join(registry, "two.json"), JSON.stringify({ root: project, socketPath: deadSocket, startedAt: 3, pid: exited.pid }));
	writeFileSync(join(registry, "three.json"), JSON.stringify({ root: project, socketPath: join(registry, "gone.sock"), startedAt: 1, pid: process.pid }));
	assert.deepEqual(liveDaemons(project, registry).map((entry) => entry.socketPath), [liveSocket], "a dead pid and a missing socket file are not live daemons");
});

test("mcpLineReader buffers chunks, skips empty and unparseable lines, stops on a truthy reply", () => {
	const ids: Array<number | undefined> = [];
	const read = mcpLineReader((message) => {
		ids.push(message === undefined ? undefined : message.id);
		return ids.length === 2;
	});
	assert.equal(read(Buffer.from('{"id":1')), false, "a line without its newline is buffered, not delivered");
	assert.equal(read(Buffer.from('}\n\nnot json\n{"id":2}\n{"id":3}\n')), false, "an unbounded reader never reports overflow");
	assert.deepEqual(ids, [1, undefined], "an unparseable line is handed over as undefined; lines after the truthy stop are never read");

	const bounded = mcpLineReader(() => true, 9);
	assert.equal(bounded('{"id":1}\n'), false, "under the cap lines are read");
	assert.equal(bounded("0123456789"), true, "past the cap the reader answers overflow before reading a line");
});

test("mcpLineReader caps each frame on its own, not the chunk that carries it", () => {
	const replies: Array<McpReply | undefined> = [];
	const read = mcpLineReader((message) => {
		replies.push(message);
		return false;
	}, 9);
	// A reply just under the cap followed by blank lines in the same chunk: the blank lines
	// belong to no frame, so the reply is delivered instead of rejected as a runaway.
	assert.equal(read('{"id":2}\n\n\n\n\n\n\n\n'), false, "an under-cap frame plus trailing blank lines is not a runaway");
	assert.deepEqual(replies, [{ id: 2 }], "the under-cap reply reached dispatch");
	assert.equal(read('{"id":3}\n'), false);
	assert.deepEqual(replies, [{ id: 2 }, { id: 3 }], "the reader keeps working after the blank-line chunk");
	assert.equal(read("0123456789\n"), true, "a single complete frame over the cap stays rejected");
});

test("mcpLineReader keeps a multibyte character split across Buffer chunks intact", () => {
	const lines: Array<McpReply | undefined> = [];
	const read = mcpLineReader((message) => {
		lines.push(message);
		return false;
	});
	// é is the two UTF-8 bytes C3 A9; the split lands between them, so a per-chunk toString turns
	// each half into a replacement character and the reply text is silently corrupted.
	const reply = JSON.stringify({ id: 2, result: { content: [{ type: "text", text: "café" }] } }) + "\n";
	const bytes = Buffer.from(reply, "utf8");
	const splitAt = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
	assert.ok(splitAt > 0, "the split must land inside é's bytes");
	read(bytes.subarray(0, splitAt));
	assert.equal(lines.length, 0, "the half-finished line is buffered, not delivered");
	read(bytes.subarray(splitAt));
	assert.deepEqual(lines, [{ id: 2, result: { content: [{ type: "text", text: "café" }] } }], "é survives the chunk boundary");
});

/** A backslash without a backslash literal: pipe paths stay clear of escape-transport mangling. */
const DAEMON_BS = String.fromCharCode(92);

/** A path in the Windows pipe namespace, built without backslash literals. */
function namedPipe(name: string): string {
	return ["", "", ".", "pipe", name].join(DAEMON_BS);
}

test("socketPresent on win32 probes the daemon's own pipe with a short budget", (t) => {
	const open = namedPipe("gentle-shell-probe-open");
	const refused = namedPipe("gentle-shell-probe-refused");
	const odd = namedPipe("gentle-shell-probe-odd");
	const seen: Array<{ path: string; timeoutMs: number }> = [];
	let answer: PipeProbeOutcome = "open";
	setPipeProbeForTests((path, timeoutMs) => {
		seen.push({ path, timeoutMs });
		return answer;
	});
	t.after(() => setPipeProbeForTests(undefined));
	assert.equal(socketPresent(open, "win32"), true, "a pipe that accepts the connect is present");
	assert.equal(socketPresent(open, "win32"), true, "the second check inside the window is answered from the cache");
	assert.deepEqual(seen, [{ path: open, timeoutMs: 250 }], "one probe budgeted at 250ms replaces listing every named pipe on the machine");
	answer = "refused";
	assert.equal(socketPresent(refused, "win32"), false, "a clean refusal is the one proof of absence");
	assert.equal(socketPresent(refused, "win32"), false, "an absent pipe is never remembered");
	assert.equal(seen.length, 3, "every absent check probes again");
	answer = "inconclusive";
	assert.equal(socketPresent(odd, "win32"), true, "a timeout or odd error still counts as present rather than risk missing a live daemon");
	assert.equal(socketPresent(odd, "win32"), true, "a fail-safe answer is not remembered as a positive one");
	assert.equal(seen.length, 5, "every inconclusive check probes again");
});

test("socketPresent keeps the plain socket-file check off Windows and never probes", (t) => {
	const registry = dir(t, "posix-check");
	const socketFile = join(registry, "daemon.sock");
	writeFileSync(socketFile, "");
	let probes = 0;
	setPipeProbeForTests(() => {
		probes++;
		return "open";
	});
	t.after(() => setPipeProbeForTests(undefined));
	assert.equal(socketPresent(socketFile, "darwin"), true, "a socket file is still a filesystem check");
	assert.equal(socketPresent(join(registry, "gone.sock"), "darwin"), false, "a missing socket file is still absent");
	assert.equal(socketPresent(namedPipe("gentle-shell-probe-posix"), "darwin"), false, "a pipe-shaped path off Windows is only a file check too");
	assert.equal(probes, 0, "the probe layer is never consulted off Windows");
});

test("swapping the probe layer starts with an empty cache", (t) => {
	const pipe = namedPipe("gentle-shell-probe-swap");
	setPipeProbeForTests(() => "open");
	assert.equal(socketPresent(pipe, "win32"), true);
	let probes = 0;
	setPipeProbeForTests(() => {
		probes++;
		return "open";
	});
	t.after(() => setPipeProbeForTests(undefined));
	assert.equal(socketPresent(pipe, "win32"), true);
	assert.equal(probes, 1, "a remembered positive dies with the layer that recorded it");
});

test("the real probe worker settles through the shared cell on both outcomes", async (t) => {
	// The pipe-shaped name is relative, so both the listener and the probe worker resolve it against
	// the working directory: a short temporary one keeps the bind inside the platform's socket path
	// length limit.
	const home = dir(t, "probe-real");
	const before = process.cwd();
	process.chdir(home);
	const pipe = namedPipe(`p-${randomUUID().slice(0, 8)}`);
	const server = net.createServer(() => {});
	const listening = new Promise<void>((resolve, reject) => {
		server.on("error", reject);
		server.listen(pipe, () => resolve());
	});
	t.after(() => {
		process.chdir(before);
		return new Promise<void>((resolve) => server.close(() => resolve())).then(() => rmSync(join(home, pipe), { force: true }));
	});
	await listening;
	// The raw worker outcomes are asserted directly with a test-controlled budget: a worker that
	// misses a fixed 250ms budget answers inconclusive, and socketPresent maps inconclusive to
	// present, so the mapped answer alone would pass or fail vacuously on a slow runner.
	assert.equal(connectProbe(pipe, 2_000), "open", "the worker's connect lands in the shared cell and wakes the waiter as open");
	const absent = namedPipe(`a-${randomUUID().slice(0, 8)}`);
	assert.equal(connectProbe(absent, 2_000), "refused", "a pipe name with no listener is a clean refusal, not an inconclusive one");
	// The mapped contract stays fail-safe on top of the raw outcomes: an open pipe is present, and
	// a worker that misses its budget is inconclusive — still present, never a false absence; the
	// refusal-to-absent mapping is pinned by the fake-probe tests above.
	assert.equal(socketPresent(pipe, "win32"), true, "the mapped open answer stays present");
});

test("socketPresent spends a caller's deadline instead of the full probe budget", (t) => {
	const pipe = namedPipe("gentle-shell-probe-deadline");
	const seen: Array<{ path: string; timeoutMs: number }> = [];
	setPipeProbeForTests((path, timeoutMs) => {
		seen.push({ path, timeoutMs });
		return "inconclusive";
	});
	t.after(() => setPipeProbeForTests(undefined));
	assert.equal(socketPresent(pipe, "win32", Date.now() - 1), true, "a spent deadline skips the probe; inconclusive still counts as present");
	assert.deepEqual(seen, [], "no probe runs once the deadline is gone");
	// The clock is held fixed across the deadline setup and the call: a scheduling pause between
	// the two Date.now reads must not decide this assertion — the probe budget is the leftover the
	// caller handed in, never whatever the host scheduler happened to leave.
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	assert.equal(socketPresent(pipe, "win32", now + 20), true, "a shrunken budget still probes fail-safe");
	assert.equal(seen.length, 1, "the leftover budget bought exactly one probe");
	const probe = seen[0];
	assert.ok(probe !== undefined && probe.timeoutMs > 0 && probe.timeoutMs <= 20, "the probe got the leftover, never the full 250ms");
});

test("daemonFor on win32 lives through the probe and the memoized canonical fold", (t) => {
	const project = dir(t, "win32-fold");
	const registry = dir(t, "win32-fold-registry");
	const pipe = namedPipe("gentle-shell-win32-fold");
	writeFileSync(join(registry, "record.json"), JSON.stringify({ root: `${project}//`, socketPath: pipe, startedAt: 1, pid: process.pid }));
	assert.equal(canonicalRoot(project, "win32"), canonicalRoot(`${project}//`, "win32"), "both spellings unfold once through the memo");
	const seen: string[] = [];
	setPipeProbeForTests((path) => {
		seen.push(path);
		return "open";
	});
	t.after(() => setPipeProbeForTests(undefined));
	const found = daemonFor(project, registry, "win32");
	assert.equal(found.alive, true, "the pid is alive and the pipe accepted the probe");
	assert.equal(found.root, `${project}//`, "the registered spelling is returned as-is");
	assert.deepEqual(seen, [pipe], "the liveness check probed the daemon's own pipe, not the whole machine");
	setPipeProbeForTests(() => "refused");
	assert.equal(daemonFor(project, registry, "win32").alive, false, "a refused pipe is not a live daemon even with a live pid");
});

test("mcpLineReader applies the frame cap to the raw remainder on the partial path too", () => {
	const replies: Array<McpReply | undefined> = [];
	const read = mcpLineReader((message) => {
		replies.push(message);
		return false;
	}, 9);
	// The complete line keeps its trimmed measure: a frame just under the cap still lands when its
	// newline arrives separately, and the blank lines after it belong to no frame.
	assert.equal(read('{"id":2}'), false, "a frame under the cap is buffered while its newline is pending");
	assert.equal(read("\n"), false);
	assert.deepEqual(replies, [{ id: 2 }], "the split arrival still dispatches the frame");
	replies.length = 0;
	assert.equal(read('{"id":3}'), false);
	assert.equal(read("  \n"), false, "a short reply followed by separate blank lines keeps working");
	assert.deepEqual(replies, [{ id: 3 }]);
	assert.equal(read("0123456789"), true, "a partial frame whose content itself breaks the cap still answers overflow");
	// The unfinished remainder takes a raw measure instead: the buffer itself is the memory the cap
	// guards, so whitespace with no newline to trim it against crosses the cap as surely as content.
	assert.equal(read(" ".repeat(10)), true, "a whitespace-only remainder past the cap is overflow, not free memory");
	const flood = mcpLineReader(() => false, 9);
	assert.equal(flood(" ".repeat(5)), false, "whitespace accumulates across chunks while it fits the cap");
	assert.equal(flood(" ".repeat(5)), true, "the raw cap stops the accumulation once it does not");
});

test("mcpLineReader applies one frame measure whether the newline shares the chunk or follows it", () => {
	const replies: Array<McpReply | undefined> = [];
	const read = mcpLineReader((message) => {
		replies.push(message);
		return false;
	}, 9);
	// The same padded reply in both chunk layouts: separator whitespace is not frame content, so
	// a frame whose trimmed content fits the cap dispatches identically whether its newline arrived
	// with the frame or follows separately — a raw remainder measure rejects only the split one.
	assert.equal(read('{"id":2}  \n'), false, "the padded frame under the cap passes in one chunk");
	assert.deepEqual(replies, [{ id: 2 }], "the padded reply reached dispatch");
	replies.length = 0;
	assert.equal(read('{"id":2}  '), false, "the same padded frame is buffered while its newline is pending");
	assert.equal(read("\n"), false, "and dispatches when the newline follows separately");
	assert.deepEqual(replies, [{ id: 2 }], "the split arrival dispatches the same padded frame");
});
