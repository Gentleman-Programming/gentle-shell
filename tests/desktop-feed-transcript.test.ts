import assert from "node:assert/strict";
import test from "node:test";
import { hasTranscript } from "../herdr/mods/gentle-chat/feed.js";

// The chat renders a session's conversation only when the feed names a Pi session file.
// A metadata-only feed from another agent has none, and the view must say so instead of
// reading whatever jsonl sits in the terminal's folder.
test("a feed naming a Pi session file has a transcript", () => {
	assert.equal(hasTranscript({ sessionFile: "/home/someone/agent/sessions/p/1.jsonl" }), true);
});

test("a feed without a session file has none", () => {
	assert.equal(hasTranscript({ sessionId: "other-agent", cwd: "/repo" }), false);
	assert.equal(hasTranscript(undefined), false);
	assert.equal(hasTranscript({ sessionFile: 42 }), false);
	assert.equal(hasTranscript({ sessionFile: "/repo/transcript.ndjson" }), false);
});
