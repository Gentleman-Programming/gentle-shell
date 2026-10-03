import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/history-search.ts";

const { dedupeNewestFirst } = __testing;

test("dedupes identical entries keeping only the most recent", () => {
	const input = ["ls", "pwd", "ls", "cat foo", "pwd"];
	const result = dedupeNewestFirst(input);
	assert.deepEqual(result, ["pwd", "cat foo", "ls"]);
});

test("preserves order of unique first occurrences in newest-first", () => {
	const input = ["a", "b", "c", "d"];
	const result = dedupeNewestFirst(input);
	assert.deepEqual(result, ["d", "c", "b", "a"]);
});

test("empty input returns empty output", () => {
	assert.deepEqual(dedupeNewestFirst([]), []);
});

test("single entry passes through", () => {
	assert.deepEqual(dedupeNewestFirst(["only"]), ["only"]);
});

test("all-identical input collapses to one entry", () => {
	assert.deepEqual(dedupeNewestFirst(["x", "x", "x"]), ["x"]);
});
