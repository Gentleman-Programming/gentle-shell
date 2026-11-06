import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createJobRegistry, createOutputTail, MAX_RUNNING_JOBS, MAX_TAIL_LINE_CHARS, TAIL_LINES, type JobExecOperations, type JobRecord } from "../lib/background-jobs.ts";

// Background jobs run a shell command while the parent keeps working or stays
// idle; the registry reports each job's own exit exactly once.

test("output tail keeps the last TAIL_LINES lines, joins partial chunks, and strips CR", () => {
	const tail = createOutputTail();
	const lines = Array.from({ length: TAIL_LINES + 5 }, (_, i) => `line ${i}`);
	tail.push(`${lines.join("\r\n")}\r\n`);
	assert.deepEqual(tail.lines(), lines.slice(5));
	tail.push("par");
	tail.push("tial");
	assert.deepEqual(tail.lines().at(-1), "partial");
	assert.equal(tail.lines().length, TAIL_LINES);
});

test("output tail bounds a line that never ends, keeping its newest characters", () => {
	const tail = createOutputTail();
	for (let i = 0; i < 50; i++) tail.push(`${"x".repeat(MAX_TAIL_LINE_CHARS)}`);
	tail.push("END");
	const [line] = tail.lines();
	assert.ok(line!.length <= MAX_TAIL_LINE_CHARS + 1, `kept ${line!.length} characters`);
	assert.ok(line!.startsWith("…") && line!.endsWith("xEND"));
	tail.push(`\n${"y".repeat(MAX_TAIL_LINE_CHARS * 3)}\nshort\n`);
	assert.ok(tail.lines().every((entry) => entry.length <= MAX_TAIL_LINE_CHARS + 1));
	assert.equal(tail.lines().at(-1), "short");
});

interface FakeRun {
	command: string;
	cwd: string;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	resolve: (exitCode: number | null) => void;
	reject: (error: Error) => void;
}

function fakeOperations() {
	const runs: FakeRun[] = [];
	const operations: JobExecOperations = {
		exec: (command, cwd, options) => new Promise((resolve, reject) => {
			const run: FakeRun = { command, cwd, onData: options.onData, signal: options.signal, resolve: (exitCode) => resolve({ exitCode }), reject };
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			runs.push(run);
		}),
	};
	return { runs, operations };
}

function setup(commandPrefix?: string) {
	const dir = mkdtempSync(join(tmpdir(), "gentle-jobs-test-"));
	const fake = fakeOperations();
	const settled: JobRecord[] = [];
	let clock = 1000;
	const registry = createJobRegistry({
		outputDir: () => dir,
		now: () => clock,
		shell: () => ({ operations: fake.operations, commandPrefix }),
		onSettled: (job) => settled.push(job),
	});
	const tick = (ms: number) => { clock += ms; };
	return { dir, fake, settled, registry, tick, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Settling closes the job's log file first, which takes real I/O turns.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("start returns a running job at once and its exit settles it exactly once with output on disk", async () => {
	const { fake, settled, registry, tick, cleanup } = setup();
	try {
		const job = registry.start({ command: "make ci", cwd: "/repo", label: "ci", ownerSessionId: "s1" });
		assert.equal(job.status, "running");
		assert.equal(job.id, "job-1");
		assert.equal(fake.runs[0]!.command, "make ci");
		assert.equal(fake.runs[0]!.cwd, "/repo");
		fake.runs[0]!.onData(Buffer.from("building\nok\n"));
		tick(4200);
		fake.runs[0]!.resolve(2);
		await settle();
		assert.equal(settled.length, 1);
		const done = settled[0]!;
		assert.equal(done.status, "exited");
		assert.equal(done.exitCode, 2);
		assert.equal(done.endedAt! - done.startedAt, 4200);
		assert.deepEqual(done.tail, ["building", "ok"]);
		assert.equal(readFileSync(done.outputPath, "utf8"), "building\nok\n");
		assert.equal(registry.get("job-1")?.status, "exited");
	} finally { cleanup(); }
});

test("a multibyte character split across output chunks reaches the tail intact", async () => {
	const { fake, settled, registry, cleanup } = setup();
	try {
		registry.start({ command: "echo", cwd: "/repo", ownerSessionId: "s1" });
		const bytes = Buffer.from("ñandú listo\n");
		fake.runs[0]!.onData(bytes.subarray(0, 1));
		fake.runs[0]!.onData(bytes.subarray(1, 5));
		fake.runs[0]!.onData(bytes.subarray(5));
		fake.runs[0]!.resolve(0);
		await settle();
		assert.deepEqual(settled[0]!.tail, ["ñandú listo"]);
	} finally { cleanup(); }
});

test("onLine receives each complete output line across chunks, and the last partial line at exit", async () => {
	const { fake, registry, cleanup } = setup();
	try {
		const lines: string[] = [];
		const job = registry.start({ command: "watch", cwd: "/repo", ownerSessionId: "s1", kind: "monitor", onLine: (line) => lines.push(line) });
		assert.equal(job.kind, "monitor");
		fake.runs[0]!.onData(Buffer.from("check lint: pa"));
		fake.runs[0]!.onData(Buffer.from("ss\r\ncheck test: fail\nlast"));
		assert.deepEqual(lines, ["check lint: pass", "check test: fail"]);
		fake.runs[0]!.resolve(0);
		await settle();
		assert.deepEqual(lines, ["check lint: pass", "check test: fail", "last"]);
		assert.equal(registry.start({ command: "x", cwd: "/repo", ownerSessionId: "s1" }).kind, "command");
	} finally { cleanup(); }
});

test("onLine bounds an endless line to its newest MAX_TAIL_LINE_CHARS characters", async () => {
	const { fake, registry, cleanup } = setup();
	try {
		const lines: string[] = [];
		registry.start({ command: "watch", cwd: "/repo", ownerSessionId: "s1", kind: "monitor", onLine: (line) => lines.push(line) });
		fake.runs[0]!.onData(Buffer.from(`${"x".repeat(MAX_TAIL_LINE_CHARS * 5)}END\nshort\n`));
		assert.equal(lines.length, 2);
		assert.ok(lines[0]!.length <= MAX_TAIL_LINE_CHARS + 1 && lines[0]!.startsWith("…") && lines[0]!.endsWith("xEND"));
		assert.equal(lines[1], "short");
		fake.runs[0]!.onData(Buffer.from("y".repeat(MAX_TAIL_LINE_CHARS * 5)));
		fake.runs[0]!.onData(Buffer.from("TAIL\n"));
		assert.ok(lines[2]!.length <= MAX_TAIL_LINE_CHARS + 1 && lines[2]!.startsWith("…") && lines[2]!.endsWith("yTAIL"));
	} finally { cleanup(); }
});

test("stopAll resolves only after every job's log file is closed", async () => {
	const { registry, cleanup } = setup();
	try {
		const job = registry.start({ command: "sleep 100", cwd: "/repo", ownerSessionId: "s1" });
		await registry.stopAll();
		assert.equal(job.status, "stopped");
		assert.equal(registry.pending(), 0);
	} finally { cleanup(); }
});

test("the shell command prefix runs before the command, but the job keeps the original command", () => {
	const { fake, registry, cleanup } = setup("shopt -s expand_aliases");
	try {
		const job = registry.start({ command: "ll", cwd: "/repo", ownerSessionId: "s1" });
		assert.equal(fake.runs[0]!.command, "shopt -s expand_aliases\nll");
		assert.equal(job.command, "ll");
		assert.equal(job.label, "ll");
	} finally { cleanup(); }
});

test("stop aborts a running job and sends no exit notice; stopping again or an unknown id is a no-op", async () => {
	const { fake, settled, registry, cleanup } = setup();
	try {
		registry.start({ command: "sleep 100", cwd: "/repo", ownerSessionId: "s1" });
		const stopped = registry.stop("job-1");
		assert.equal(stopped?.status, "stopped");
		assert.equal(fake.runs[0]!.signal?.aborted, true);
		await settle();
		assert.equal(settled.length, 0);
		assert.equal(registry.get("job-1")?.status, "stopped");
		assert.equal(registry.stop("job-1")?.status, "stopped");
		assert.equal(registry.stop("job-404"), undefined);
	} finally { cleanup(); }
});

test("a job that fails to run settles as failed with the error", async () => {
	const { fake, settled, registry, cleanup } = setup();
	try {
		registry.start({ command: "x", cwd: "/missing", ownerSessionId: "s1" });
		fake.runs[0]!.reject(new Error("Working directory does not exist: /missing"));
		await settle();
		assert.equal(settled[0]?.status, "failed");
		assert.match(settled[0]!.error!, /Working directory does not exist/);
	} finally { cleanup(); }
});

test("at most MAX_RUNNING_JOBS run at once; a finished job frees its slot", async () => {
	const { fake, registry, cleanup } = setup();
	try {
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) registry.start({ command: `c${i}`, cwd: "/repo", ownerSessionId: "s1" });
		assert.throws(() => registry.start({ command: "one more", cwd: "/repo", ownerSessionId: "s1" }), /25 background jobs are already running/);
		assert.equal(fake.runs.length, MAX_RUNNING_JOBS);
		fake.runs[0]!.resolve(0);
		await settle();
		assert.equal(registry.start({ command: "one more", cwd: "/repo", ownerSessionId: "s1" }).status, "running");
	} finally { cleanup(); }
});

test("list filters by owner session and stopAll stops every running job without notices", async () => {
	const { settled, registry, cleanup } = setup();
	try {
		registry.start({ command: "a", cwd: "/repo", ownerSessionId: "s1" });
		registry.start({ command: "b", cwd: "/repo", ownerSessionId: "s2" });
		assert.deepEqual(registry.list("s1").map((job) => job.command), ["a"]);
		assert.equal(registry.list().length, 2);
		registry.stopAll();
		await settle();
		assert.deepEqual(registry.list().map((job) => job.status), ["stopped", "stopped"]);
		assert.equal(settled.length, 0);
	} finally { cleanup(); }
});

test("a real shell job runs through Pi's bash operations and reports its exit code", { skip: process.platform === "win32" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "gentle-jobs-real-"));
	try {
		const done = new Promise<JobRecord>((resolve) => {
			const registry = createJobRegistry({ outputDir: () => dir, now: Date.now, shell: () => ({ operations: createLocalBashOperations() }), onSettled: resolve });
			registry.start({ command: "echo one; echo two >&2; exit 3", cwd: dir, ownerSessionId: "s1" });
		});
		const job = await done;
		assert.equal(job.status, "exited");
		assert.equal(job.exitCode, 3);
		assert.deepEqual([...job.tail].sort(), ["one", "two"]);
		assert.deepEqual(readFileSync(job.outputPath, "utf8").split("\n").filter(Boolean).sort(), ["one", "two"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
