import assert from "node:assert/strict";
import test from "node:test";
import { createDownloadProgress, formatDownloadProgress } from "../scripts/download-progress.mjs";

test("formatDownloadProgress shows size, percent, rate and a bar with a known total", () => {
	const line = formatDownloadProgress({ label: "gentle-ai v4.1.1", received: 3 * 1024 * 1024, total: 6 * 1024 * 1024, elapsedMs: 2000, width: 80 });
	assert.match(line, /^gentle-ai v4\.1\.1 /);
	assert.match(line, /3\.0\/6\.0 MB/);
	assert.match(line, / 50%/);
	assert.match(line, /1\.5 MB\/s/);
	assert.match(line, /\[#+-+\]/);
	assert.ok([...line].length <= 80);
});

test("formatDownloadProgress omits percent and bar without a total and uses KB for small rates", () => {
	const line = formatDownloadProgress({ label: "x", received: 20 * 1024, total: undefined, elapsedMs: 1000, width: 80 });
	assert.match(line, /20 KB/);
	assert.match(line, /20 KB\/s/);
	assert.doesNotMatch(line, /%|\[/);
});

test("formatDownloadProgress never exceeds a narrow width and survives zero elapsed time", () => {
	const line = formatDownloadProgress({ label: "a-very-long-label", received: 1, total: 10, elapsedMs: 0, width: 12 });
	assert.ok([...line].length <= 12, line);
});

test("createDownloadProgress throttles redraws, always draws completion, and clears its line", () => {
	let now = 0;
	const writes: string[] = [];
	const progress = createDownloadProgress({ label: "x", write: (text: string) => writes.push(text), now: () => now, width: () => 60, intervalMs: 100 });
	progress.update({ received: 1, total: 10 });
	now = 50;
	progress.update({ received: 2, total: 10 });
	now = 150;
	progress.update({ received: 5, total: 10 });
	now = 160;
	progress.update({ received: 10, total: 10 });
	assert.equal(writes.length, 3, "first, throttled-through and final draws only");
	for (const text of writes) assert.match(text, /^\r.*\x1b\[K$/);
	assert.match(writes[2], /100%/);
	progress.done();
	assert.equal(writes.at(-1), "\r\x1b[K");
	progress.done();
	assert.equal(writes.length, 4, "done is idempotent");
});

test("createDownloadProgress done without any update writes nothing", () => {
	const writes: string[] = [];
	createDownloadProgress({ label: "x", write: (text: string) => writes.push(text) }).done();
	assert.deepEqual(writes, []);
});

test("formatDownloadProgress keeps the amount and percent visible when the label does not fit", () => {
	const label = "Downloading Gentle AI v4.1.1";
	const known = formatDownloadProgress({ label, received: 3 * 1024 * 1024, total: 6 * 1024 * 1024, elapsedMs: 0, width: 23 });
	assert.ok([...known].length <= 23, known);
	assert.match(known, /3\.0\/6\.0 MB/);
	assert.match(known, / 50%/);
	const unknown = formatDownloadProgress({ label, received: 20 * 1024, total: undefined, elapsedMs: 0, width: 23 });
	assert.ok([...unknown].length <= 23, unknown);
	assert.match(unknown, /20 KB/);
});

test("createDownloadProgress never throws from a failing writer, including on done", () => {
	let fail = false;
	const progress = createDownloadProgress({ label: "x", write: () => { if (fail) throw new Error("EPIPE"); } });
	progress.update({ received: 1, total: 10 });
	fail = true;
	assert.doesNotThrow(() => progress.update({ received: 10, total: 10 }));
	assert.doesNotThrow(() => progress.done());
});
