import assert from "node:assert/strict";
import test from "node:test";
import { describeAttachment, formatBytes, ImageAttachments, imageToken } from "../lib/image-attachments.ts";

// A 2×1 PNG header: signature, IHDR length/type, width 2, height 1.
const PNG_2X1 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00,
]);
const png = () => ({ bytes: PNG_2X1, mimeType: "image/png" });
const base64 = Buffer.from(PNG_2X1).toString("base64");

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];

test("pasted images get sequential whitespace-free chips and keep one in-memory copy", () => {
	const attachments = new ImageAttachments();
	const first = attachments.add(png());
	const second = attachments.add(png());
	assert.equal(first.token, "[Image#1]");
	assert.equal(second.token, imageToken(2));
	assert.doesNotMatch(first.token, /\s/);
	assert.deepEqual(first.dimensions, { widthPx: 2, heightPx: 1 });
	assert.equal(first.base64, base64);
	assert.equal(first.byteLength, PNG_2X1.length);
	assert.equal("bytes" in first, false);
	assert.equal(attachments.size, 2);
});

test("referenced chips follow draft order, appear once, and ignore unregistered tokens", () => {
	const attachments = new ImageAttachments();
	attachments.add(png());
	attachments.add(png());
	const ids = attachments.referenced("see [Image#2] then [Image#9] and [Image#1] [Image#2]").map((attachment) => attachment.id);
	assert.deepEqual(ids, [2, 1]);
	assert.deepEqual(attachments.referenced("the chip was deleted"), []);
});

test("submitting a draft attaches every chip still in the text as a real image", () => {
	const attachments = new ImageAttachments();
	attachments.add(png());
	attachments.add(png());
	const submitted = attachments.submit("what changed in [Image#2]?", true);
	assert.deepEqual(submitted, {
		text: "what changed in [Image#2]?",
		images: [{ type: "image", data: base64, mimeType: "image/png" }],
		omitted: 0,
	});
	// The deleted chip (#1) was never sent; both are released once the editor is empty.
	assert.equal(attachments.size, 0);
});

test("numbers never repeat, so a chip recalled from history cannot bind to a newer image", () => {
	const attachments = new ImageAttachments();
	attachments.add(png());
	attachments.submit("describe [Image#1]", true);
	const next = attachments.add(png());
	assert.equal(next.token, "[Image#2]");
	// Up-arrow recall of the earlier prompt: its chip is no longer registered.
	assert.deepEqual(attachments.referenced("describe [Image#1]"), []);
	assert.deepEqual(attachments.spans("describe [Image#1]"), []);
	attachments.clear();
	assert.equal(attachments.add(png()).token, "[Image#3]");
});

test("a submit Pi runs late keeps the chips of the draft already in the editor", () => {
	const attachments = new ImageAttachments();
	attachments.add(png());
	attachments.add(png());
	attachments.add(png());
	// Queued during compaction: `[Image#1]` is sent after `[Image#2]` was pasted
	// into a new draft; `[Image#3]` was pasted and deleted again.
	const submitted = attachments.submit("look [Image#1]", true, "and now [Image#2]");
	assert.equal(submitted?.images.length, 1);
	assert.deepEqual(attachments.referenced("and now [Image#2]").map((attachment) => attachment.id), [2]);
	assert.equal(attachments.size, 1);
	assert.equal(attachments.submit("and now [Image#2]", true)?.images.length, 1);
	assert.equal(attachments.size, 0);
});

test("a model without image input gets a plain note instead of a silent drop", () => {
	const attachments = new ImageAttachments();
	attachments.add(png());
	const submitted = attachments.submit("look at [Image#1] and [Image#4]", false);
	assert.deepEqual(submitted, {
		text: "look at [Image#1 omitted: the current model does not accept images] and [Image#4]",
		images: [],
		omitted: 1,
	});
});

test("drafts without registered chips pass through untouched and release stale images", () => {
	const attachments = new ImageAttachments();
	assert.equal(attachments.submit("plain [Image#1] text", true), undefined);
	attachments.add(png());
	assert.equal(attachments.submit("chip deleted before submit", true), undefined);
	assert.equal(attachments.size, 0);
});

test("a registered chip is one segment, so one Backspace removes it", () => {
	const attachments = new ImageAttachments();
	const text = "a [Image#1] b";
	// No registered chip yet: the host segmentation is returned as-is.
	const native = graphemes(text);
	assert.equal(attachments.segment(text, native), native);
	attachments.add(png());
	const merged = [...attachments.segment(text, graphemes(text))].map((segment) => segment.segment);
	assert.deepEqual(merged, ["a", " ", "[Image#1]", " ", "b"]);
	assert.deepEqual(attachments.spans(text), [{ start: 2, end: 11 }]);
	const unregistered = "x [Image#7]";
	assert.equal([...attachments.segment(unregistered, graphemes(unregistered))].length, unregistered.length);
});

test("chip descriptions name format, pixel size and weight", () => {
	assert.equal(describeAttachment({ mimeType: "image/png", byteLength: 86_016, dimensions: { widthPx: 1280, heightPx: 720 } }), "png · 1280×720 · 84 KB");
	assert.equal(describeAttachment({ mimeType: "image/jpeg", byteLength: 512 }), "jpg · 512 B");
	assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
