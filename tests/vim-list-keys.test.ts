import assert from "node:assert/strict";
import test from "node:test";
import { VimListKeys, vimListIndex } from "../lib/vim-list-keys.ts";

test("gg jumps to the first row and G to the last", () => {
	const keys = new VimListKeys();
	assert.equal(keys.action("g"), "pending", "the first g waits for the second");
	assert.equal(keys.action("g"), "first", "gg selects the first row");
	assert.equal(keys.action("G"), "last", "G selects the last row");
	assert.equal(keys.action("\x1b[103;2u"), "last", "the CSI-u encoded Shift+G matches too");
	assert.equal(keys.action("\x1b[103u"), "pending", "a CSI-u encoded g waits as well");
	assert.equal(keys.action("\x1b[103u"), "first");
});

test("ctrl+d and ctrl+u move half a page", () => {
	const keys = new VimListKeys();
	assert.equal(keys.action("\x04"), "halfDown");
	assert.equal(keys.action("\x15"), "halfUp");
});

test("any other key cancels a pending g and is left to the view", () => {
	const keys = new VimListKeys();
	keys.action("g");
	assert.equal(keys.action("j"), undefined, "j is the view's own key");
	assert.equal(keys.action("g"), "pending", "the interrupted g does not complete a gg");
	keys.reset();
	assert.equal(keys.action("g"), "pending", "reset drops the pending g");
});

test("vimListIndex clamps every jump to the list", () => {
	assert.equal(vimListIndex("first", 5, 10, 8), 0);
	assert.equal(vimListIndex("last", 5, 10, 8), 9);
	assert.equal(vimListIndex("halfDown", 5, 10, 8), 9, "5 + 4");
	assert.equal(vimListIndex("halfDown", 8, 10, 8), 9, "clamped at the last row");
	assert.equal(vimListIndex("halfUp", 1, 10, 8), 0, "clamped at the first row");
	assert.equal(vimListIndex("halfDown", 0, 10, 1), 1, "a page of one row still moves one");
});
