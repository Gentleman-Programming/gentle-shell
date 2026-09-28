import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { installBackgroundCacheWarming, type WarmingState } from "../lib/background-cache-warming.ts";

test("native warming decisions use only current owned live background work", () => {
	let handler: Parameters<Parameters<typeof installBackgroundCacheWarming>[0]["on"]>[1];
	let state: WarmingState = { sessionId: "parent", ownedTaskIds: new Set(["task"]), tasks: [
		{ id: "task", parentSessionId: "parent", mode: "background", status: "queued" },
	] };
	installBackgroundCacheWarming({ on(event, callback) {
		assert.equal(event, "cache_warming_decision");
		handler = callback;
	} }, () => state);
	const candidate = { warmCost: 0.01, missCost: 0.1, continuationProbability: 0.15, action: "stop" as const };
	assert.deepEqual(handler!(candidate), { action: "warm" });
	state.tasks[0].status = "running";
	assert.deepEqual(handler!(candidate), { action: "warm" });
	for (const status of ["waiting", "completed", "failed", "cancelled", "timed_out"] as const) {
		state.tasks[0].status = status;
		assert.equal(handler!(candidate), undefined, status);
	}
	state.tasks[0].status = "running";
	for (const patch of [
		{ sessionId: undefined }, { sessionId: "other" }, { ownedTaskIds: new Set<string>() },
		{ tasks: [] }, { tasks: [{ ...state.tasks[0], mode: "task" }] },
	]) {
		const original = state;
		state = { ...state, ...patch };
		assert.equal(handler!(candidate), undefined);
		state = original;
	}
	for (const warmCost of [0.06, 1, NaN, Infinity, -1]) {
		assert.deepEqual(handler!({ ...candidate, warmCost }), { action: "stop" });
	}
	for (const missCost of [0, -1, NaN, Infinity]) {
		assert.deepEqual(handler!({ ...candidate, missCost }), { action: "stop" });
	}
	assert.deepEqual(handler!({ ...candidate, warmCost: 0, missCost: 0.05 }), { action: "warm" });
	assert.deepEqual(handler!({ ...candidate, warmCost: 0, missCost: 0.049 }), { action: "stop" });
	state.tasks = [];
	assert.equal(handler!({ ...candidate, action: "warm" }), undefined, "ordinary idle keeps native action");
});

// Supplemental architecture guard; the extension lifecycle is exercised in gentle-agents.test.ts.
test("warming helper has no maintenance capabilities", () => {
	const helper = readFileSync(new URL("../lib/background-cache-warming.ts", import.meta.url), "utf8");
	assert.doesNotMatch(helper, /setTimeout|setInterval|sendMessage|sendUserMessage|subagent_|runner\./);
});

test("background prompt prohibits cache polling and documents explicit native idle opt-in", () => {
	const prompt = readFileSync(new URL("../assets/orchestrator-delegation.md", import.meta.url), "utf8");
	assert.match(prompt, /completion or cache maintenance/);
	assert.match(prompt, /user-requested inspection, relevant scope change, input request, or suspected abnormal behavior/);
	assert.match(prompt, /Never relaunch equivalent work merely because it is queued or running/);
	const docs = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	assert.match(docs, /"cacheWarming": "idle"/);
	assert.match(docs, /\$0\.05/);
	assert.match(docs, /"streaming".*no idle decision/s);
});
