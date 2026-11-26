import assert from "node:assert/strict";
import { test } from "node:test";
// The chat mod's pure session reader (no host imports): what each tool's collapsed row says.
import { createFeed, ingest, summarize } from "../herdr/mods/gentle-chat/feed.js";

// S15 (odd/tasks/herdr-desktop.md, xabilarra's report): the minimal view gives every tool a
// readable one-line summary beside its name, never the raw JSON of its arguments. The expanded
// view keeps the whole arguments (the call keeps `args`).

const call = (name: string, args: unknown) => {
	const feed = createFeed();
	ingest(feed, JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name, arguments: args }] } }));
	const block = (feed.items[0] as { blocks: Array<{ call: { name: string; args: unknown; summary: string } }> }).blocks[0]!;
	return block.call;
};
const noJson = (text: string) => assert.ok(!/[{[]"/.test(text) && !text.includes("\":"), `no raw JSON in ${JSON.stringify(text)}`);

test("S15: todo says its action and its tasks, never the JSON of its list", () => {
	const write = call("todo", { action: "write", tasks: [{ title: "Spec", status: "done" }, { title: "Build", status: "in_progress" }, { title: "Ship", status: "pending" }] });
	assert.equal(write.summary, "write · 3 tasks, 1 in progress");
	assert.deepEqual(write.args, { action: "write", tasks: [{ title: "Spec", status: "done" }, { title: "Build", status: "in_progress" }, { title: "Ship", status: "pending" }] }, "the expanded view keeps every argument");
	assert.equal(summarize("todo", { action: "write", tasks: [{ title: "One", status: "pending" }] }), "write · 1 task");
	assert.equal(summarize("todo", { action: "update", id: 2, status: "done" }), "update #2 → done");
	assert.equal(summarize("todo", { action: "add", title: "Write the docs" }), "add · Write the docs");
	assert.equal(summarize("todo", { action: "list" }), "list");
});

test("S15: questions show their question text", () => {
	assert.equal(call("ask_user_choice", { question: "Which layout?\nPick one.", options: [{ label: "A" }, { label: "B" }] }).summary, "Which layout?");
	assert.equal(summarize("ask_user_question", { questions: [{ question: "Name?", header: "N" }, { question: "Colour?" }] }), "Name? (+1 more)");
	assert.equal(summarize("ask_user_question", { questions: [{ question: "Only one?" }] }), "Only one?");
});

test("S15: subagents, jobs, web, memory, codemode and review tools say what they do", () => {
	assert.equal(summarize("subagent_run", { agent: "gentle-writer", label: "S15 publisher", task: "Implement…" }), "gentle-writer · S15 publisher");
	assert.equal(summarize("subagent_run", { agent: "gentle-writer", task: "Fix the bug\nthen test" }), "gentle-writer · Fix the bug");
	assert.equal(summarize("bash_background", { command: "npm test", label: "unit tests" }), "unit tests");
	assert.equal(summarize("monitor", { command: "gh run watch 1", label: "CI", timeout_seconds: 60 }), "CI");
	assert.equal(summarize("bash_background", { command: "npm test" }), "npm test");
	assert.equal(summarize("job_stop", { job_id: "j7" }), "j7");
	assert.equal(summarize("web_search", { query: "herdr 0.1.16 changelog" }), "herdr 0.1.16 changelog");
	assert.equal(summarize("web_search", { queries: ["first query", "second"] }), "first query (+1 more)");
	assert.equal(summarize("fetch_content", { url: "https://herdr.dev/gallery/" }), "https://herdr.dev/gallery/");
	assert.equal(summarize("fetch_content", { urls: ["https://a.dev", "https://b.dev"] }), "https://a.dev (+1 more)");
	assert.equal(summarize("mem_save", { title: "Fixed the feed", content: "**What**: …", type: "bugfix" }), "Fixed the feed");
	assert.equal(summarize("mem_search", { query: "desktop feed", limit: 5 }), "desktop feed");
	assert.equal(summarize("mem_get_observation", { id: 42 }), "#42");
	assert.equal(summarize("codemode", { code: "\n// search the files\nconst r = await files.search({ q: 'x' });\nreturn r;" }), "const r = await files.search({ q: 'x' });");
	assert.equal(summarize("gentle_review", { operation: "assess" }), "assess");
	assert.equal(summarize("gentle_review_run", { operation: "start", input: "{\"mode\":\"ordinary\"}" }), "start");
});

test("S15: the existing summaries stay as they were", () => {
	assert.equal(summarize("bash", { command: "cd /w && npm test\nnext" }), "cd /w && npm test");
	assert.equal(summarize("read", { path: "/w/NOTAS.md" }), "/w/NOTAS.md");
	assert.equal(summarize("grep", { pattern: "TODO", path: "/w" }), "/w");
	assert.equal(summarize("edit", { path: "/w/a.ts", edits: [{ oldText: "a", newText: "b" }] }), "/w/a.ts");
});

test("S15: an unknown tool shows its first string value on one line, never JSON", () => {
	const nested = summarize("custom_tool", { options: { deep: [{ name: "first\nvalue" }] }, n: 3 });
	assert.equal(nested, "first");
	noJson(nested);
	assert.equal(summarize("custom_tool", { count: 3, flag: true }), "");
	assert.equal(summarize("custom_tool", {}), "");
	assert.equal(summarize("custom_tool", "plain text\nmore"), "plain text");
	for (const [name, args] of [["todo", { action: "write", tasks: [] }], ["ask_user_choice", { options: [{ label: "A" }] }], ["mystery", { a: { b: [1, 2] } }]] as const) noJson(summarize(name, args));
	assert.ok(summarize("custom_tool", { text: "x".repeat(400) }).length <= 140, "one bounded line");
});
