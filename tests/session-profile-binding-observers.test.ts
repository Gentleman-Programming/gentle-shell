import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bindSessionProfile,
	clearSessionProfileBinding,
	observeSessionProfileBindings,
	readSessionProfileBinding,
	readSessionProfileStartupNone,
	recordSessionProfileStartupNone,
	resetSessionProfileBindingsForTesting,
} from "../lib/session-profile-binding.ts";

// Binding-store observers (gentle-shell-gpui parity, T1, L32): every launch and
// resume path writes this store, so an observer can never break a write.

test("a throwing observer never breaks a binding write, and the others still hear every write", (t) => {
	resetSessionProfileBindingsForTesting();
	t.after(resetSessionProfileBindingsForTesting);
	const heard: string[] = [];
	const stopThrowing = observeSessionProfileBindings(() => { throw new Error("observer failure"); });
	const stop = observeSessionProfileBindings((sessionId) => heard.push(sessionId));
	t.after(stopThrowing);
	bindSessionProfile("s1", "fast", {});
	assert.equal(readSessionProfileBinding("s1")?.name, "fast");
	recordSessionProfileStartupNone("s1");
	assert.equal(readSessionProfileStartupNone("s1"), true);
	clearSessionProfileBinding("s1");
	assert.equal(readSessionProfileBinding("s1"), undefined);
	assert.deepEqual(heard, ["s1", "s1", "s1"]);
	stop();
	bindSessionProfile("s1", "fast", {});
	assert.equal(heard.length, 3, "unsubscribe stops the calls");
});

test("an observer that writes from inside its callback does not loop", (t) => {
	resetSessionProfileBindingsForTesting();
	t.after(resetSessionProfileBindingsForTesting);
	let calls = 0;
	const stop = observeSessionProfileBindings((sessionId) => {
		calls += 1;
		if (readSessionProfileBinding(sessionId)) clearSessionProfileBinding(sessionId);
	});
	t.after(stop);
	bindSessionProfile("s2", "fast", {});
	assert.equal(calls, 2);
	assert.equal(readSessionProfileBinding("s2"), undefined);
});
