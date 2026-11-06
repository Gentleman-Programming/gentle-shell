import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gentleTps from "../extensions/gentle-tps.ts";

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

function assistant(usage: Partial<Usage>) {
	return { role: "assistant", content: [], usage };
}

const smallUsage = { input: 7, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 32 };
const smallNotification = `TPS 20.0 tok/s. out ${(20).toLocaleString()}, in ${(7).toLocaleString()}, cache r/w ${(3).toLocaleString()}/${(2).toLocaleString()}, total ${(32).toLocaleString()}, 1.0s`;

function harness(t: TestContext) {
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const notifications: { message: string; type: string | undefined }[] = [];
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
	};
	gentleTps({ on: (name: string, handler: (event: any, ctx: any) => void) => {
		assert.equal(handlers.has(name), false, `duplicate handler: ${name}`);
		handlers.set(name, handler);
	} } as unknown as ExtensionAPI);

	return {
		ctx,
		handlers,
		notifications,
		start(time: number) {
			now = time;
			assert.ok(handlers.has("agent_start"));
			handlers.get("agent_start")!({ type: "agent_start" }, ctx);
		},
		end(time: number, messages: unknown[]) {
			now = time;
			assert.ok(handlers.has("agent_end"));
			handlers.get("agent_end")!({ type: "agent_end", messages }, ctx);
		},
	};
}

test("reports aggregate assistant usage over the whole agent run", (t) => {
	const h = harness(t);
	assert.deepEqual([...h.handlers.keys()], ["agent_start", "agent_end"]);
	h.start(0);
	h.end(2_500, [
		{ role: "user", usage: { input: 90_000, output: 90_000, cacheRead: 90_000, cacheWrite: 90_000, totalTokens: 90_000 } },
		assistant({ input: 1_500, output: 1_000, cacheRead: 4_000, cacheWrite: 42, totalTokens: 6_542 }),
		{ role: "toolResult", usage: { input: 90_000, output: 90_000, cacheRead: 90_000, cacheWrite: 90_000, totalTokens: 90_000 } },
		assistant({ input: 250, output: 25, cacheRead: 100, cacheWrite: 8, totalTokens: 383 }),
		assistant({}),
	]);
	// Number formatting follows the host locale, just like the existing notification.
	assert.deepEqual(h.notifications, [{
		message: `TPS 410.0 tok/s. out ${(1_025).toLocaleString()}, in ${(1_750).toLocaleString()}, cache r/w ${(4_100).toLocaleString()}/${(50).toLocaleString()}, total ${(6_925).toLocaleString()}, 2.5s`,
		type: "info",
	}]);
});

test("ignores an end without a start and consumes a successful end once", (t) => {
	const h = harness(t);
	h.end(1_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, []);
	h.start(2_000);
	h.end(3_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, [{ message: smallNotification, type: "info" }]);
	h.end(4_000, [assistant({ ...smallUsage, output: 200 })]);
	assert.deepEqual(h.notifications, [{ message: smallNotification, type: "info" }]);
	h.start(5_000);
	h.end(7_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, [
		{ message: smallNotification, type: "info" },
		{ message: `TPS 10.0 tok/s. out ${(20).toLocaleString()}, in ${(7).toLocaleString()}, cache r/w ${(3).toLocaleString()}/${(2).toLocaleString()}, total ${(32).toLocaleString()}, 2.0s`, type: "info" },
	]);
});

test("suppresses headless runs and consumes their ends", (t) => {
	const h = harness(t);
	h.ctx.hasUI = false;
	h.start(1_000);
	h.end(2_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, []);
	h.ctx.hasUI = true;
	h.end(3_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, []);
	h.start(4_000);
	h.end(5_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, [{ message: smallNotification, type: "info" }]);
});

test("suppresses nonpositive elapsed time and consumes the end", (t) => {
	const h = harness(t);
	for (const endTime of [1_000, 999]) {
		h.start(1_000);
		h.end(endTime, [assistant(smallUsage)]);
		assert.deepEqual(h.notifications, []);
		h.end(2_000, [assistant(smallUsage)]);
		assert.deepEqual(h.notifications, []);
	}
});

test("suppresses nonpositive assistant output and consumes the end", (t) => {
	const h = harness(t);
	for (const output of [0, -1]) {
		h.start(1_000);
		h.end(2_000, [assistant({ ...smallUsage, output }), { role: "toolResult", usage: smallUsage }]);
		assert.deepEqual(h.notifications, []);
		h.end(3_000, [assistant(smallUsage)]);
		assert.deepEqual(h.notifications, []);
	}
});

test("a new start replaces the previous start time", (t) => {
	const h = harness(t);
	h.start(1_000);
	h.start(3_000);
	h.end(4_000, [assistant(smallUsage)]);
	assert.deepEqual(h.notifications, [{ message: smallNotification, type: "info" }]);
});
