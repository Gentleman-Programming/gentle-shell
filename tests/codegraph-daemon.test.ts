import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemonFor, exploreViaDaemon, liveDaemons, mcpLineReader, registeredDaemons, resetDaemonRegistryMemo } from "../lib/codegraph-daemon.ts";

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
}

/**
 * An in-process daemon speaking the CodeGraph socket protocol: a hello line as soon as a client
 * connects, then initialize and one tools/call reply per the given scripts.
 */
function fakeDaemon(
	t: test.TestContext,
	project: string,
	hello: string | undefined,
	initialize: object,
	call: object,
): FakeDaemon {
	const home = dir(t, "home");
	const registryDir = join(home, ".codegraph", "daemons");
	mkdirSync(registryDir, { recursive: true });
	const socketPath = join(home, "daemon.sock");
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const server = net.createServer((socket) => {
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
	server.listen(socketPath, () => resolveReady());
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	writeFileSync(join(registryDir, "record.json"), JSON.stringify({ root: project, socketPath, startedAt: 1, pid: process.pid }));
	return { socketPath, registryDir, ready };
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

test("daemonFor and the sockets iterate live daemons newest first", async (t) => {
	const project = dir(t, "newest");
	const daemon = fakeDaemon(t, project, HELLO, INITIALIZED, ANSWER);
	await daemon.ready;
	const found = daemonFor(project, daemon.registryDir);
	assert.equal(found.alive, true);
	assert.equal(found.root, project);
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
