import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationScheduler, type PlaybackPermit } from "../lib/notification-scheduler.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings, type NotificationSound } from "../lib/notification-policy.ts";

class Clock {
	now = 0;
	serial = 0;
	timers = new Map<number, { at: number; fn: () => void }>();
	setTimeout = (fn: () => void, delay: number) => {
		const id = ++this.serial; this.timers.set(id, { at: this.now + delay, fn }); return id;
	};
	clearTimeout = (id: number) => { this.timers.delete(id); };
	advance(ms: number) {
		const end = this.now + ms;
		for (;;) {
			const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.now = next[1].at; this.timers.delete(next[0]); next[1].fn();
		}
		this.now = end;
	}
}
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(slow = false, dedupeCapacity = 256) {
	const clock = new Clock();
	const settings: NotificationSettings = { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), enabled: true };
	const calls: Array<{ sound: NotificationSound; signal: AbortSignal; permit: PlaybackPermit; finish: () => void; fail: () => void }> = [];
	const starts: number[] = []; const errors: unknown[] = [];
	const scheduler = new NotificationScheduler({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		dedupeCapacity, onError: error => { errors.push(error); },
		player: (sound, signal, permit) => new Promise<void>((resolve, reject) => {
			calls.push({ sound, signal, permit, finish: resolve, fail: () => reject(new Error("audio")) });
			if (!slow && permit.start()) starts.push(clock.now);
		}),
	});
	scheduler.resetSession("s"); scheduler.configure(settings, false);
	const enqueue = (sequence: number, event = "agent.completed" as const, occurredAt = clock.now) =>
		scheduler.enqueue({ sessionId: "s", runId: "r", sequence, event, occurredAt });
	return { clock, settings, calls, starts, errors, scheduler, enqueue };
}

test("burst priority belongs to event, ties latest, first coalesce deadline is fixed", () => {
	const f = fixture();
	f.settings.audio.events["agent.failed"] = "builtin:success";
	f.settings.audio.events["agent.completed"] = "builtin:error";
	f.scheduler.configure(f.settings, false);
	f.enqueue(1); f.clock.advance(200);
	f.scheduler.enqueue({ sessionId: "s", runId: "r", sequence: 2, event: "agent.failed", occurredAt: 200 });
	f.enqueue(3); f.clock.advance(99); assert.equal(f.calls.length, 0);
	f.clock.advance(1); assert.equal(f.calls[0].sound, "builtin:success");
	const ties = fixture(); ties.enqueue(1); ties.clock.advance(200);
	ties.settings.audio.events["agent.completed"] = "builtin:attention"; ties.scheduler.configure(ties.settings, false);
	ties.enqueue(2); ties.clock.advance(100); assert.equal(ties.calls[0].sound, "builtin:attention");
});

test("serial active plus one pending, minimum interval measured between starts", async () => {
	const f = fixture(); f.enqueue(1); f.clock.advance(300); f.enqueue(2); f.enqueue(3);
	f.clock.advance(500); assert.equal(f.calls.length, 1);
	f.calls[0].finish(); await tick(); f.clock.advance(499); assert.equal(f.calls.length, 1);
	f.clock.advance(1); assert.deepEqual(f.starts, [300, 1300]);
});

test("TTL exact boundary and expired pending never replay", async () => {
	const f = fixture(); assert.equal(f.enqueue(1, "agent.completed", -2000), false);
	assert.equal(f.enqueue(2, "agent.completed", -1999), true);
	f.clock.advance(300); assert.equal(f.calls.length, 0);
	f.enqueue(3); f.clock.advance(300); f.enqueue(4);
	f.clock.advance(2000); f.calls[0].finish(); await tick(); f.clock.advance(5000);
	assert.equal(f.calls.length, 1);
});

test("slow detection must acquire start permit immediately before spawn; expires and aborts", async () => {
	const f = fixture(true); f.enqueue(1); f.clock.advance(300);
	f.clock.advance(1699); assert.equal(f.calls[0].signal.aborted, false);
	f.clock.advance(1); assert.equal(f.calls[0].signal.aborted, true);
	assert.equal(f.calls[0].permit.start(), false);
	f.enqueue(2); f.clock.advance(300); assert.equal(f.calls.length, 1);
	f.calls[0].finish(); await tick(); assert.equal(f.calls.length, 2);
	assert.equal(f.calls[1].permit.start(), true);
	assert.equal(f.calls[1].permit.start(), false);
});

test("settled detection cannot start through its old permit after a new run reserves playback", async () => {
	const f = fixture(true); f.enqueue(1); f.clock.advance(300);
	const old = f.calls[0]; old.finish(); await tick();
	assert.equal(f.scheduler.enqueue({ sessionId: "s", runId: "new", sequence: 1,
		event: "agent.completed", occurredAt: f.clock.now }), true);
	f.clock.advance(300); assert.equal(f.calls.length, 2);
	assert.equal(old.signal.aborted, false); // Still inside TTL, same generation: identity must reject it.
	assert.equal(f.calls[1].permit.start(), true);
	assert.equal(old.permit.start(), false);
	assert.equal(f.calls[1].permit.start(), false);
});

test("throttle follows actual start after slow detection, not detection invocation", async () => {
	const f = fixture(true); f.enqueue(1); f.clock.advance(700);
	assert.equal(f.calls[0].permit.start(), true); f.calls[0].finish(); await tick(); f.enqueue(2);
	f.clock.advance(999); assert.equal(f.calls.length, 1);
	f.clock.advance(1); assert.equal(f.calls.length, 2);
});

test("dedupe occurrence not state, bounded cap, session memory reaped, off events consumed", async () => {
	const f = fixture(false, 2); assert.equal(f.enqueue(1), true); assert.equal(f.enqueue(1), false);
	assert.equal(f.enqueue(2), true); assert.equal(f.enqueue(3), true); assert.equal(f.enqueue(1), true);
	f.scheduler.configure({ ...f.settings, enabled: false }, false);
	assert.equal(f.enqueue(9), false); f.scheduler.configure(f.settings, false); assert.equal(f.enqueue(9), false);
	f.scheduler.resetSession("other"); assert.equal(f.enqueue(10), false);
	f.scheduler.resetSession("s"); assert.equal(f.enqueue(9), true);
	f.clock.advance(300); assert.equal(f.calls.length, 1);
});

test("off, mute and session changes abort and invalidate async; no overlap or replay", async () => {
	for (const action of ["off", "mute", "session"] as const) {
		const f = fixture(true); f.enqueue(1); f.clock.advance(300); f.enqueue(2);
		if (action === "session") f.scheduler.resetSession("next");
		else f.scheduler.configure({ ...f.settings, enabled: action !== "off" }, action === "mute");
		assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[0].permit.start(), false);
		f.scheduler.resetSession("s"); f.scheduler.configure(f.settings, false);
		f.clock.advance(5000); assert.equal(f.calls.length, 1);
		assert.equal(f.scheduler.preview("builtin:error"), false);
		f.calls[0].finish(); await tick(); f.clock.advance(5000); assert.equal(f.calls.length, 1);
		assert.equal(f.scheduler.preview("builtin:error"), true);
	}
});

test("preview bypasses off/mute, stays serial, does not flush pending or modify config", async () => {
	const f = fixture(); f.scheduler.configure({ ...f.settings, enabled: false }, true);
	const before = JSON.stringify(f.settings); assert.equal(f.scheduler.preview("builtin:error"), true);
	assert.equal(f.scheduler.preview("builtin:success"), false); assert.equal(f.enqueue(1), false);
	f.calls[0].finish(); await tick(); f.scheduler.configure(f.settings, false); f.enqueue(2);
	assert.equal(f.scheduler.preview("builtin:error"), false);
	f.clock.advance(1000); assert.equal(f.calls.length, 2); assert.equal(JSON.stringify(f.settings), before);
});

test("start at TTL minus one succeeds, exact TTL denied even when timer delivery is late", () => {
	const f = fixture(true); f.enqueue(1); f.clock.advance(1999);
	assert.equal(f.calls[0].permit.start(), true);
	f.clock.advance(1); assert.equal(f.calls[0].signal.aborted, false);
	const late = fixture(true); late.enqueue(1); late.clock.advance(300);
	late.clock.now = 2000; // Simulate blocked event loop: expiry callback has not run.
	assert.equal(late.calls[0].signal.aborted, false);
	assert.equal(late.calls[0].permit.start(), false);
});

test("large bursts still reserve only one pending; silent settings never enable or replay", async () => {
	const f = fixture(); f.enqueue(1); f.clock.advance(300);
	for (let i = 2; i < 1002; i++) f.enqueue(i);
	f.clock.advance(1000); assert.equal(f.calls.length, 1);
	f.calls[0].finish(); await tick(); assert.equal(f.calls.length, 2);
	f.calls[1].finish(); await tick(); f.clock.advance(5000); assert.equal(f.calls.length, 2);
	f.settings.audio.events = {}; f.scheduler.configure(f.settings, false);
	assert.equal(f.enqueue(2000), false);
	f.settings.audio.events["agent.completed"] = "builtin:success"; // Scheduler cloned configuration.
	assert.equal(f.enqueue(2001), false);
	f.scheduler.configure(f.settings, false); assert.equal(f.enqueue(2000), false);
});

test("dispose during detection aborts, rejects late errors silently and clears timers", async () => {
	const f = fixture(true); f.enqueue(1); f.clock.advance(300); f.enqueue(2);
	f.scheduler.dispose(); f.scheduler.dispose();
	assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[0].permit.start(), false);
	f.calls[0].fail(); await tick(); f.clock.advance(10000);
	assert.equal(f.errors.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.clock.timers.size, 0);
});

test("synchronous player errors release reservation and are contained", () => {
	const clock = new Clock(); let errors = 0;
	const scheduler = new NotificationScheduler({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		player: () => { throw new Error("sync"); }, onError: () => { errors++; } });
	assert.equal(scheduler.preview("builtin:error"), true);
	assert.equal(scheduler.preview("builtin:error"), true); assert.equal(errors, 1); scheduler.dispose();
});

test("errors caught, diagnostics locally limited even if callback throws, disposal idempotent", async () => {
	const f = fixture(); f.scheduler.configure({ ...f.settings, enabled: false }, false);
	for (let i = 0; i < 3; i++) { assert.equal(f.scheduler.preview("builtin:error"), true); f.calls[i].fail(); await tick(); }
	assert.equal(f.errors.length, 1); f.clock.advance(5000);
	f.scheduler.preview("builtin:error"); f.calls[3].fail(); await tick(); assert.equal(f.errors.length, 2);
	f.scheduler.configure(f.settings, false); f.enqueue(1); f.scheduler.dispose(); f.scheduler.dispose();
	f.clock.advance(10000); assert.equal(f.calls.length, 4); assert.equal(f.scheduler.preview("builtin:error"), false);
	const clock = new Clock();
	const scheduler = new NotificationScheduler({ now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
		player: async () => { throw new Error("audio"); }, onError: () => { throw new Error("diagnostic"); } });
	scheduler.preview("builtin:error"); await tick(); scheduler.dispose();
});
