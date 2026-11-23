import assert from "node:assert/strict";
import test from "node:test";
import { shellUntrackedLines } from "../extensions/gentle-shell.ts";
import { DIFF_MAX_BYTES, WorktreeChangesTracker } from "../lib/shell-changes.ts";

function fixture(budget?: number) {
	const files = new Map<string, { bytes: Buffer; size: number; mtimeMs: number; regular: boolean; readable: boolean }>();
	function put(path: string, data: string | Buffer, overrides?: Partial<{ size: number; mtimeMs: number; regular: boolean; readable: boolean }>) {
		const bytes = Buffer.from(data);
		files.set(path, { bytes, size: bytes.length, mtimeMs: 1, regular: true, readable: true, ...overrides });
	}
	const reads: Array<[path: string, limit: number]> = [];
	const ranges: Array<[path: string, offset: number, length: number]> = [];
	const io = {
		lstat: async (path: string) => {
			const file = files.get(path.slice("/repo/".length))!;
			return { isFile: () => file.regular, size: file.size, mtimeMs: file.mtimeMs };
		},
		read: async (path: string, limit: number, offset = 0) => {
			const name = path.slice("/repo/".length);
			const file = files.get(name)!;
			reads.push([name, limit]);
			ranges.push([name, offset, limit]);
			if (!file.readable) throw new Error("not readable");
			return file.bytes.subarray(offset, offset + limit);
		},
	};
	let untracked: string[] | undefined;
	let roots = ["/repo"];
	const tracker = new WorktreeChangesTracker(
		async () => ({ stdout: "worktree /repo\0branch refs/heads/main\0\0", code: 0 }),
		() => async ([cmd]) => ({ stdout: cmd === "status" ? ` M tracked.ts\0${(untracked ?? [...files.keys()]).map((path) => `?? ${path}\0`).join("")}` : cmd === "diff" ? "3\t1\ttracked.ts\n" : "", code: 0 }),
		undefined, () => roots, undefined, shellUntrackedLines(io, budget),
	);
	return { put, reads, ranges, tracker, setUntracked: (paths?: string[]) => { untracked = paths; }, setRoots: (next: string[]) => { roots = next; } };
}

const listed = (tracker: WorktreeChangesTracker) => tracker.model.files.map(({ path, added, deleted }) => [path, added, deleted]);

test("untracked binaries report zero while empty, CRLF, invalid UTF-8 and unterminated text retain their counts", async () => {
	const { put, reads, tracker } = fixture();
	put("binary", Buffer.from([0, 0xff, 10, 0]));
	put("bound", Buffer.alloc(DIFF_MAX_BYTES, 10));
	put("crlf", "a\r\nb\r\n");
	put("empty", "");
	put("failed", "a\n", { readable: false });
	put("invalid-utf8", Buffer.from([0xff, 10]));
	put("link", "a\n", { regular: false });
	put("over", "a\n", { size: DIFF_MAX_BYTES + 1 });
	put("unterminated", "a\nb\nc");
	await tracker.start();
	assert.deepEqual(listed(tracker), [
		["binary", 0, 0], ["bound", DIFF_MAX_BYTES, 0], ["crlf", 2, 0], ["empty", 0, 0], ["failed", 0, 0],
		["invalid-utf8", 1, 0], ["link", 0, 0], ["over", 0, 0], ["tracked.ts", 3, 1], ["unterminated", 3, 0],
	]);
	assert.equal(tracker.model.added, DIFF_MAX_BYTES + 9);
	assert.equal(tracker.model.deleted, 1);
	assert.equal(tracker.untrackedCountsPending, false);
	const totals = new Map<string, number>();
	for (const [path, bytes] of reads) totals.set(path, (totals.get(path) ?? 0) + bytes);
	assert.deepEqual([...totals].sort(), [["binary", 4], ["bound", DIFF_MAX_BYTES], ["crlf", 6], ["failed", 2], ["invalid-utf8", 2], ["unterminated", 5]]);
});

test("a binary with NUL at byte 8000 needs only its header and never counts as pending", async () => {
	const { put, tracker, ranges } = fixture();
	const bytes = Buffer.alloc(300_000, 10);
	bytes[7999] = 0;
	put("binary", bytes);
	await tracker.start();
	assert.deepEqual(listed(tracker), [["binary", 0, 0], ["tracked.ts", 3, 1]]);
	assert.equal(tracker.untrackedCountsPending, false);
	assert.equal(tracker.model.files[0].countsUnavailable, undefined);
	await tracker.refresh();
	assert.deepEqual(ranges, [["binary", 0, 8000]], "an unchanged binary is remembered");
});

test("text beyond the first 8000 bytes is read completely without double-counting the boundary", async () => {
	const { put, tracker, ranges } = fixture();
	put("text", `${"x".repeat(8000)}\ny\nz`);
	await tracker.start();
	assert.deepEqual(listed(tracker), [["text", 3, 0], ["tracked.ts", 3, 1]]);
	assert.deepEqual(ranges, [["text", 0, 8000], ["text", 8000, 4]]);
	assert.equal(tracker.untrackedCountsPending, false);
});

test("a NUL at byte 8001 is text, as in Git", async () => {
	const { put, tracker, reads } = fixture();
	put("late-nul", `${"x".repeat(8000)}\0\nz\n`);
	await tracker.start();
	assert.deepEqual(listed(tracker), [["late-nul", 2, 0], ["tracked.ts", 3, 1]]);
	assert.equal(reads.reduce((total, [, bytes]) => total + bytes, 0), 8004);
	assert.equal(tracker.untrackedCountsPending, false);
});

test("only the bytes actually read from binary headers consume the budget", async () => {
	const { put, tracker, ranges } = fixture(80_000);
	const binary = Buffer.alloc(80_000);
	for (let i = 0; i < 10; i++) put(`bin${i}`, binary);
	await tracker.start();
	assert.equal(tracker.model.files.length, 11);
	assert.equal(tracker.model.added, 3);
	assert.equal(tracker.model.files.some((file) => file.countsUnavailable), false);
	assert.equal(tracker.untrackedCountsPending, false);
	assert.deepEqual(ranges.sort(), Array.from({ length: 10 }, (_, index) => [`bin${index}`, 0, 8000]));
});

test("an entire live set is cached; only changed size or mtime reads again", async () => {
	const { put, reads, tracker } = fixture();
	for (let i = 0; i < 2400; i++) put(`f${i}`, "a\n");
	await tracker.start();
	assert.equal(tracker.model.files.length, 2401);
	assert.equal(tracker.model.added, 2403);
	assert.equal(reads.length, 2400);
	await tracker.refresh();
	assert.equal(tracker.model.added, 2403);
	assert.equal(reads.length, 2400);
	put("f0", "\n\n", { mtimeMs: 2 }); // same size
	put("f1", "a\nb"); // same mtime
	await tracker.refresh();
	assert.deepEqual(reads.slice(2400).sort(), [["f0", 2], ["f1", 3]]);
	assert.equal(tracker.model.added, 2405);
	assert.equal(tracker.model.files.find((file) => file.path === "f0")?.diffRevision, "2:2");
});

test("the byte budget keeps every file visible and later passes finish without rereading", async () => {
	const { put, reads, tracker } = fixture(4);
	for (const path of ["a", "b", "c"]) put(path, "x\ny\n");
	await tracker.start();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["b", 0, 0], ["c", 0, 0], ["tracked.ts", 3, 1]]);
	assert.equal(tracker.untrackedCountsPending, true);
	assert.deepEqual(tracker.model.files.filter((file) => file.countsUnavailable).map((file) => file.path), ["b", "c"]);
	assert.deepEqual(reads, [["a", 4]]);
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["b", 2, 0], ["c", 0, 0], ["tracked.ts", 3, 1]]);
	assert.equal(tracker.untrackedCountsPending, true);
	assert.deepEqual(reads, [["a", 4], ["b", 4]]);
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["b", 2, 0], ["c", 2, 0], ["tracked.ts", 3, 1]]);
	assert.equal(tracker.untrackedCountsPending, false);
	assert.equal(tracker.model.files.some((file) => file.countsUnavailable), false);
	assert.deepEqual(reads, [["a", 4], ["b", 4], ["c", 4]]);
});

test("a failed untracked read does not cache zero after access is restored", async () => {
	const { put, tracker, reads } = fixture(4);
	put("a", "x\nx\n", { readable: false });
	await tracker.start();
	assert.equal(tracker.untrackedCountsPending, false, "do not poll on a read error alone");
	assert.deepEqual(listed(tracker), [["a", 0, 0], ["tracked.ts", 3, 1]]);
	put("a", "x\nx\n", { readable: true }); // Same size and mtime.
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["tracked.ts", 3, 1]]);
	assert.equal(tracker.untrackedCountsPending, false);
	assert.deepEqual(reads, [["a", 4], ["a", 4]]);
});

test("a changing early file cannot starve a stable deferred file", async () => {
	const { put, tracker } = fixture(4);
	put("a", "x\nx\n");
	put("b", "y\ny\n");
	await tracker.start();
	assert.equal(tracker.untrackedCountsPending, true);
	for (let mtimeMs = 2; mtimeMs <= 5; mtimeMs++) {
		put("a", mtimeMs % 2 ? "x\nx\n" : "xxx\n", { mtimeMs });
		await tracker.refresh();
	}
	const stable = tracker.model.files.find((file) => file.path === "b");
	assert.equal(stable?.added, 2);
	assert.equal(stable?.countsUnavailable, undefined);
});

test("leaving the untracked inventory or the registered roots forgets the cached answer", async () => {
	const { put, reads, tracker, setUntracked, setRoots } = fixture();
	put("a", "x\nx");
	await tracker.start();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["tracked.ts", 3, 1]]);
	setUntracked([]);
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["tracked.ts", 3, 1]]);
	setUntracked();
	put("a", "xxx"); // same size and mtime
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 1, 0], ["tracked.ts", 3, 1]]);
	setRoots([]);
	await tracker.refresh();
	assert.deepEqual(listed(tracker), []);
	setRoots(["/repo"]);
	put("a", "\n\n\n");
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 3, 0], ["tracked.ts", 3, 1]]);
	assert.deepEqual(reads, [["a", 3], ["a", 3], ["a", 3]]);
});

// A read that fails gives its reservation back: unreadable files must not use
// up the scan budget and leave readable files pending on every scan.
test("a failed read returns its budget, so a readable file behind it is still counted", async () => {
	const { put, tracker } = fixture(2);
	put("a", "x\n", { readable: false });
	put("z", "y\n");
	await tracker.start();
	const z = tracker.model.files.find((file) => file.path === "z");
	assert.equal(z?.added, 1);
	assert.equal(z?.countsUnavailable, undefined);
	assert.equal(tracker.untrackedCountsPending, false);
});

test("an unreadable file cannot starve readable siblings across refreshes", async () => {
	const { put, tracker } = fixture(2);
	put("a", "x\n", { readable: false });
	put("z", "y\n");
	for (let i = 0; i < 4; i++) await tracker.refresh();
	assert.equal(tracker.model.files.find((file) => file.path === "z")?.added, 1);
	assert.equal(tracker.untrackedCountsPending, false);
});

// Proposed by the independent verify: failed on the candidate before the
// budget fix (z deferred) and passes after it.
test("a short read charges only actual bytes and is retried without caching its zero", async () => {
	const { put, reads, tracker } = fixture(3);
	put("a", "x", { size: 3 });
	put("z", "y\n");
	const first = await tracker.refresh();
	assert.deepEqual(first.files.filter((f) => f.path !== "tracked.ts").map((f) =>
		[f.path, f.added, f.countsUnavailable]), [["a", 0, undefined], ["z", 1, undefined]]);
	assert.deepEqual(reads, [["a", 3], ["z", 2]]);
	put("a", "x\ny", { size: 3 }); // Same stat tuple; the last read was not a count.
	await tracker.refresh();
	assert.deepEqual(listed(tracker), [["a", 2, 0], ["tracked.ts", 3, 1], ["z", 1, 0]]);
	assert.deepEqual(reads, [["a", 3], ["z", 2], ["a", 3]]);
});
