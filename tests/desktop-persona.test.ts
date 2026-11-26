import assert from "node:assert/strict";
import { test } from "node:test";
import { loadChatUi } from "./support/chat-ui.ts";

test("should show the persona mode the feed carries as a capitalized name in the Chat header", async (t) => {
	const ui = await loadChatUi(t);
	assert.equal(ui.personaLabel("gentleman"), "Gentleman");
	assert.equal(ui.personaLabel("neutral"), "Neutral");
	assert.equal(ui.personaLabel({ name: "neutral" }), "Neutral");
});

test("should leave the Chat header persona empty when the feed carries none", async (t) => {
	const ui = await loadChatUi(t);
	assert.equal(ui.personaLabel(null), null);
	assert.equal(ui.personaLabel(undefined), null);
	assert.equal(ui.personaLabel(""), null);
});
