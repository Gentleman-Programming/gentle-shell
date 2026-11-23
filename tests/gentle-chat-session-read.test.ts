// Gentle Chat reads a big session history (> 1 MiB) through `sh` (herdr/mods/gentle-chat/session.js).
// Native Windows has no `sh`: Herdr's `exec` rejects when the program cannot start, and the read
// must still return the new lines (issue #3352, Chat part) instead of `text: null`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ExecResult = { code: number; stdout: string; stderr: string };
type Exec = (command: string, args?: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
const state = globalThis as unknown as { __gentleChatExec: Exec; __gentleChatExecCalls: string[] };
state.__gentleChatExecCalls = [];

// The Herdr runtime module, with `exec` routed to the test. Only `exec` is used by these reads.
const HERDR = `data:text/javascript,${encodeURIComponent(`
const noop = () => null;
export const exec = (command, args, options) => { globalThis.__gentleChatExecCalls.push(command); return globalThis.__gentleChatExec(command, args, options); };
export const agents = () => [], terminals = () => [], panes = () => [], focused = noop, home = () => "/nonexistent-home", layout = noop, watchFolder = () => new Promise(() => {}), run = noop, shared = noop, setShared = noop;
`)}`;
registerHooks({ resolve(specifier, context, next) {
	if (specifier === "herdr") return { url: HERDR, shortCircuit: true };
	return next(specifier, context);
} });

const { readAfter, readTail } = await import("../herdr/mods/gentle-chat/session.js");

// No `sh` (native Windows): Herdr's exec rejects because the program cannot start.
const noSh: Exec = async (command) => { throw new Error(`failed to start ${command}: program not found`); };
// A real `sh`, shaped like Herdr's exec result (stdout as text).
const realSh: Exec = (command, args = [], options = {}) => new Promise((resolve) => {
	execFile(command, args, { encoding: "utf8", timeout: options.timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
		resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
	});
});
const hasSh = process.platform !== "win32";

const line = (i: number) => `${JSON.stringify({ type: "message", i, text: `añ🚀 ${"x".repeat(180)}` })}\n`;
function bigSession(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-chat-read-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	let body = "";
	for (let i = 0; body.length < 1.5 * 1024 * 1024; i++) body += line(i);
	writeFileSync(file, body);
	return { file, size: Buffer.byteLength(body) };
}

test("a history over 1 MiB still reads its new lines when exec cannot start sh", async (t) => {
	const { file, size } = bigSession(t);
	appendFileSync(file, `${line(100_000)}${line(100_001)}{"half":`);
	state.__gentleChatExec = noSh;
	state.__gentleChatExecCalls = [];
	const r = await readAfter(file, size, undefined, true);
	assert.deepEqual(state.__gentleChatExecCalls, ["sh"]);
	assert.equal(r.text, `${line(100_000)}${line(100_001)}`);
	assert.equal(r.end, size + Buffer.byteLength(r.text));
	assert.equal(r.more, false);
	assert.equal(r.size, size + Buffer.byteLength(`${line(100_000)}${line(100_001)}{"half":`));
	// Nothing new: an empty read at the same position, not a reset.
	const again = await readAfter(file, r.end, undefined, true);
	assert.deepEqual({ text: again.text, end: again.end, more: again.more }, { text: "", end: r.end, more: false });
});

test("without sh, a shrunk or missing history still resets (text null)", async (t) => {
	const { file, size } = bigSession(t);
	state.__gentleChatExec = noSh;
	assert.equal((await readAfter(file, size + 10, undefined, true)).text, null);
	assert.equal((await readAfter(`${file}.gone`, 0, undefined, true)).text, null);
});

test("incremental reads give the same lines, ends and sizes through sh, without sh and read whole", { skip: !hasSh && "needs a POSIX sh" }, async (t) => {
	const { file, size } = bigSession(t);
	appendFileSync(file, `${line(200_000)}${line(200_001)}{"partial":`);
	const read = async (exec: Exec | null, pos: number, max?: number) => {
		if (exec) state.__gentleChatExec = exec;
		const r = await readAfter(file, pos, max, exec !== null);
		return { text: r.text, end: r.end, more: r.more, size: r.size };
	};
	// The appended lines and a mid-file position (a line start). A capped read slices differently
	// through sh (`max * 3` bytes), so capped reads are compared by following `more` below.
	const mid = Buffer.byteLength(Array.from({ length: 2000 }, (_, i) => line(i)).join(""));
	for (const [pos, max] of [[size, undefined], [mid, undefined]] as const) {
		const whole = await read(null, pos, max);
		const viaSh = await read(realSh, pos, max);
		const fallback = await read(noSh, pos, max);
		assert.equal(viaSh.text, whole.text, `sh text at ${pos}`);
		assert.equal(viaSh.end, whole.end, `sh end at ${pos}`);
		assert.equal(viaSh.size, whole.size, `sh size at ${pos}`);
		assert.deepEqual(fallback, whole, `no-sh read at ${pos}`);
	}
	assert.deepEqual(await read(noSh, 0, 64 * 1024), await read(null, 0, 64 * 1024), "a capped no-sh read");
	// Following `more` from 0 reaches the same end either way.
	for (const exec of [realSh, noSh]) {
		let pos = 0;
		let text = "";
		for (let r = await read(exec, pos, 256 * 1024); ; r = await read(exec, pos, 256 * 1024)) {
			text += r.text;
			pos = r.end;
			if (!r.more) break;
		}
		assert.equal(pos, Buffer.byteLength(text));
		assert.equal(text, (await read(null, 0)).text);
	}
});

test("the tail of a history over 1 MiB is the same with or without sh", async (t) => {
	const { file, size } = bigSession(t);
	const tails = [];
	for (const exec of hasSh ? [realSh, noSh] : [noSh]) {
		state.__gentleChatExec = exec;
		state.__gentleChatExecCalls = [];
		tails.push(await readTail(file, 64 * 1024, 20, 3 * 1024 * 1024));
		assert.deepEqual(state.__gentleChatExecCalls, [], "an in-root tail reads the file, not sh");
	}
	const [tail] = tails;
	for (const other of tails) assert.deepEqual(other, tail);
	assert.equal(tail.size, size);
	assert.equal(tail.end, size);
	assert.ok(tail.start > 0 && size - tail.start <= 64 * 1024, "the last 64 KiB, from its first whole line");
	assert.ok(tail.text.startsWith("{\"type\":\"message\""));
	assert.equal(Buffer.byteLength(tail.text), size - tail.start);
});
