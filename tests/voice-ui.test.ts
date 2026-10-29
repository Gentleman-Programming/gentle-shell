import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { pushToTalkStatus, VoiceDictationView, VoiceProgressView } from "../lib/voice-ui.ts";

// The compact /gentle:voice overlays: rendering within the width, the keys
// each state accepts, and no repaint after disposal.

const ENTER = "\r";
const ESC = "\x1b";
// Kitty keyboard protocol release event for Enter (codepoint 13, event type 3).
const ENTER_RELEASE = "\x1b[13;1:3u";
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

function counters() {
	const counts = { renders: 0, stops: 0, cancels: 0 };
	return {
		counts,
		requestRender: () => { counts.renders++; },
		onStop: () => { counts.stops++; },
		onCancel: () => { counts.cancels++; },
	};
}

test("progress view shows the item, percentage and transferred size within the width", () => {
	const c = counters();
	const view = new VoiceProgressView({ theme, requestRender: c.requestRender, onCancel: c.onCancel });
	view.update({ component: "model", phase: "download", item: "encoder.int8.onnx", receivedBytes: 1, totalBytes: 2, overallReceivedBytes: 335_000_000, overallTotalBytes: 670_000_000 });
	assert.equal(c.counts.renders, 1);
	for (const width of [80, 30]) {
		const lines = view.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `fits ${width}`);
		const screen = lines.join("\n");
		assert.match(screen, /50%/);
		if (width === 80) {
			assert.match(screen, /encoder\.int8\.onnx/);
			assert.match(screen, /335 MB of 670 MB/);
		}
	}
});

test("progress view cancels once on Esc and ignores other keys", () => {
	const c = counters();
	const view = new VoiceProgressView({ theme, requestRender: c.requestRender, onCancel: c.onCancel });
	view.handleInput(ENTER);
	assert.equal(c.counts.cancels, 0);
	view.handleInput(ESC);
	view.handleInput(ESC);
	assert.equal(c.counts.cancels, 1);
	assert.match(view.render(80).join("\n"), /cancelling/i);
});

test("dictation view accepts Enter only while recording and Esc once in any state", () => {
	const c = counters();
	const view = new VoiceDictationView({ theme, requestRender: c.requestRender, onStop: c.onStop, onCancel: c.onCancel });
	assert.match(view.render(80).join("\n"), /starting|preparing/i);
	view.handleInput(ENTER);
	assert.equal(c.counts.stops, 0, "no stop before recording");
	view.setState("recording");
	assert.match(view.render(80).join("\n"), /recording/i);
	assert.match(view.render(80).join("\n"), /enter/i);
	view.handleInput(ENTER_RELEASE);
	assert.equal(c.counts.stops, 0, "key release ignored");
	view.handleInput(ENTER);
	view.handleInput(ENTER);
	assert.equal(c.counts.stops, 1);
	view.setState("transcribing");
	assert.match(view.render(80).join("\n"), /transcrib/i);
	view.handleInput(ESC);
	view.handleInput(ESC);
	assert.equal(c.counts.cancels, 1);
	for (const width of [80, 24]) assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
});

test("a disposed view ignores state changes and keys without repainting", () => {
	const c = counters();
	const view = new VoiceDictationView({ theme, requestRender: c.requestRender, onStop: c.onStop, onCancel: c.onCancel });
	view.setState("recording");
	const before = c.counts.renders;
	view.dispose();
	assert.doesNotThrow(() => view.setState("finished"));
	view.handleInput(ENTER);
	view.handleInput(ESC);
	assert.equal(c.counts.renders, before);
	assert.equal(c.counts.stops + c.counts.cancels, 0);
	const throwing = new VoiceDictationView({ theme, requestRender: () => { throw new Error("dead terminal"); }, onStop: c.onStop, onCancel: c.onCancel });
	assert.doesNotThrow(() => throwing.setState("recording"));
});

test("push-to-talk status names each phase in one line and how to finish", () => {
	assert.match(pushToTalkStatus("starting"), /keep holding Space/i);
	assert.match(pushToTalkStatus("recording"), /recording/i);
	assert.match(pushToTalkStatus("recording"), /release Space/i);
	assert.match(pushToTalkStatus("recording"), /esc cancel/i);
	assert.match(pushToTalkStatus("transcribing"), /transcrib/i);
	for (const state of ["idle", "starting", "recording", "transcribing", "finished"] as const) assert.ok(!pushToTalkStatus(state).includes("\n"), state);
});
