import assert from "node:assert/strict";
import { test } from "node:test";
import * as delivery from "../lib/runtime-metrics-delivery.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("callback returns before a blocked attempt; busy events are never queued", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	let calls = 0;
	let finish!: () => void;
	assert.equal(owner.offer(() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); }), true);
	assert.equal(calls, 0, "provider callback returns before any transport work");
	assert.equal(owner.offer(async () => { calls++; }), false);
	await tick();
	assert.equal(calls, 1);
	assert.equal(new delivery.RuntimeMetricsAttempt().offer(async () => { calls++; }), false);
	finish(); await tick(); await tick();
	assert.equal(calls, 1, "busy events never replay");
	owner.dispose();
});

test("failure is silent and the next fresh event may attempt without cooldown", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	let calls = 0;
	owner.offer(async () => { calls++; throw new Error("private failure"); });
	await tick(); await tick();
	assert.equal(calls, 1);
	assert.equal(owner.offer(async () => { calls++; }), true);
	await tick(); await tick();
	assert.equal(calls, 2);
	owner.dispose();
});

test("replacement cancels an unstarted attempt without stale execution", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	let calls = 0;
	owner.offer(async () => { calls++; });
	owner.dispose(); owner.dispose();
	assert.equal(owner.offer(async () => { calls++; }), false);
	const replacement = new delivery.RuntimeMetricsAttempt();
	assert.equal(replacement.offer(async () => { calls++; }), true);
	await tick(); await tick();
	assert.equal(calls, 1);
	replacement.dispose();
});

test("shutdown aborts immediately but cannot overlap an unsettled process", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	let signal!: AbortSignal;
	let finish!: () => void;
	owner.offer(s => { signal = s; return new Promise<void>(resolve => { finish = resolve; }); });
	await tick();
	assert.equal(owner.dispose(), undefined);
	assert.equal(signal.aborted, true);
	const replacement = new delivery.RuntimeMetricsAttempt();
	assert.equal(replacement.offer(async () => {}), false);
	finish(); await tick();
	assert.equal(replacement.offer(async () => {}), true);
	await tick(); replacement.dispose();
});

test("bounded shutdown join waits for the accepted attempt without replaying busy work", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	let calls = 0;
	let finish!: () => void;
	owner.offer(() => { calls++; return new Promise<void>(resolve => { finish = resolve; }); });
	assert.equal(owner.offer(async () => { calls++; }), false);
	await tick();
	let joined = false;
	const joining = owner.waitForSettled(50).then(() => { joined = true; });
	await tick();
	assert.equal(joined, false);
	finish();
	await joining;
	assert.equal(calls, 1, "joining never queues or retries discarded work");
	owner.dispose();
});

test("bounded shutdown join returns after its deadline", async () => {
	const owner = new delivery.RuntimeMetricsAttempt();
	owner.offer(() => new Promise<void>(() => {}));
	await tick();
	await owner.waitForSettled(5);
	owner.dispose();
});
