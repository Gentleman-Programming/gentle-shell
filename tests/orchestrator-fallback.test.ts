import assert from "node:assert/strict";
import test from "node:test";
import { ModelCooldown } from "../lib/model-fallback-policy.ts";
import { createOrchestratorFallback } from "../lib/orchestrator-fallback.ts";

const failed = (errorMessage: string) => [{ role: "user", content: "hi" }, { role: "assistant", content: [], stopReason: "error", errorMessage }];
const ok = [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }];

function setup(options: { chain?: Array<{ model: string; thinking?: "low" | "high" }>; catalog?: string[]; refuse?: string[]; throwing?: string[] } = {}) {
	let current = "orc/primary";
	const log: string[] = [];
	const fallback = createOrchestratorFallback({
		chain: () => options.chain ?? [{ model: "orc/second", thinking: "high" }, { model: "orc/third" }],
		current: () => current,
		available: (model) => (options.catalog ?? ["orc/primary", "orc/second", "orc/third"]).includes(model),
		setModel: async (model) => {
			if (options.throwing?.includes(model)) throw new Error("OAuth token expired");
			if (options.refuse?.includes(model)) return false;
			current = model;
			log.push(`model ${model}`);
			return true;
		},
		setThinking: (level) => log.push(`thinking ${level}`),
		announce: (change) => log.push(`notice ${change.from}->${change.to} ${change.category}`),
		resume: (message) => log.push(`resume ${/continue/i.test(message)}`),
		cooldown: new ModelCooldown(),
		now: () => 1000,
	});
	return { fallback, log, current: () => current };
}

test("an orchestrator turn that hits its usage limit switches the session model and resumes", async () => {
	const { fallback, log, current } = setup();
	assert.equal(await fallback.onSettled(failed("insufficient_quota: monthly usage limit")), true);
	assert.equal(current(), "orc/second");
	assert.deepEqual(log, ["model orc/second", "thinking high", "notice orc/primary->orc/second quota", "resume true"]);
});

test("the orchestrator never switches on errors another model would repeat, on success or without a chain", async () => {
	const context = setup();
	assert.equal(await context.fallback.onSettled(failed("prompt is too long: maximum context length")), false);
	assert.equal(await context.fallback.onSettled(ok), false);
	assert.equal(await context.fallback.onSettled([{ role: "assistant", content: [], stopReason: "aborted" }]), false);
	assert.deepEqual(context.log, []);
	const none = setup({ chain: [] });
	assert.equal(await none.fallback.onSettled(failed("rate limit exceeded")), false);
});

test("models outside the catalog or refused by Pi are skipped, and a spent chain stops", async () => {
	const skip = setup({ catalog: ["orc/primary", "orc/third"] });
	assert.equal(await skip.fallback.onSettled(failed("overloaded")), true);
	assert.equal(skip.current(), "orc/third", "a model Pi does not know is skipped");
	const refused = setup({ refuse: ["orc/second"] });
	assert.equal(await refused.fallback.onSettled(failed("overloaded")), true);
	assert.equal(refused.current(), "orc/third");
	assert.equal(await refused.fallback.onSettled(failed("overloaded")), false, "every model was tried once");
});

test("a successful turn ends the episode: a later failure may use the chain again", async () => {
	const { fallback, current } = setup({ chain: [{ model: "orc/second" }] });
	assert.equal(await fallback.onSettled(failed("network error")), true);
	assert.equal(await fallback.onSettled(ok), false);
	assert.equal(current(), "orc/second");
	assert.equal(await fallback.onSettled(failed("network error")), false, "orc/primary cools down and orc/second just failed");
});

test("an aborted run never resumes on a fallback, and a model Pi throws on gives way to the next", async () => {
	const aborted = setup();
	assert.equal(await aborted.fallback.onSettled(failed("insufficient_quota"), { aborted: true }), false);
	assert.deepEqual(aborted.log, [], "the user stopped it: no switch, no resume");
	const throwing = setup({ throwing: ["orc/second"] });
	assert.equal(await throwing.fallback.onSettled(failed("insufficient_quota")), true);
	assert.equal(throwing.current(), "orc/third");
});
