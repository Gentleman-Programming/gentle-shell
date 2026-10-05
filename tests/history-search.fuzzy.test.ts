import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/history-search.ts";

const { scoreMatch, filterByQuery } = __testing;

test("scoreMatch returns 0 when the query is not found in the command", () => {
	assert.equal(scoreMatch("xyz", "ls -la"), 0);
	assert.equal(scoreMatch("git", "npm test"), 0);
	assert.equal(scoreMatch("zz", "abc"), 0);
});

test("scoreMatch returns 0 for an empty command when query is non-empty", () => {
	assert.equal(scoreMatch("ls", ""), 0);
});

test("scoreMatch returns at least 1 for any substring match", () => {
	assert.ok(scoreMatch("ls", "ls -la") >= 1);
	assert.ok(scoreMatch("git", "git status") >= 1);
	assert.ok(scoreMatch("git", "do a git push") >= 1);
});

test("scoreMatch rewards a substring that starts at index 0 as the highest score", () => {
	const startScore = scoreMatch("ls", "ls -la");
	const laterScore = scoreMatch("ls", "echo ls -la");
	assert.ok(
		startScore > laterScore,
		`expected start-of-string match (${startScore}) to beat later match (${laterScore})`,
	);
	assert.equal(startScore, 100);
});

test("filterByQuery with an empty query returns every command in input order", () => {
	const commands = ["ls -la", "git status", "npm test", "git push"];
	const filtered = filterByQuery(commands, "");
	assert.deepEqual(filtered, commands);
});

test("filterByQuery hides commands whose score is zero", () => {
	const commands = ["ls -la", "git status", "npm test"];
	const filtered = filterByQuery(commands, "git");
	assert.deepEqual(filtered, ["git status"]);
});

test("filterByQuery ranks higher-scoring matches before lower-scoring ones", () => {
	const commands = ["echo ls -la", "ls -la"];
	const filtered = filterByQuery(commands, "ls");
	assert.deepEqual(filtered[0], "ls -la");
});

test("scoreMatch is case-insensitive for both query and command", () => {
	assert.ok(scoreMatch("GIT", "git status") >= 1);
	assert.ok(scoreMatch("git", "Git Status") >= 1);
});
