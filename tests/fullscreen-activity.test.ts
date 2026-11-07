import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
	FULLSCREEN_ACTIVITY_EVENT,
	FullscreenActivityMonitor,
	emitFullscreenActivity,
	withFullscreenOverlay,
	type FullscreenActivityEvent,
} from "../lib/fullscreen-activity.ts";

interface RecordedEmitter {
	handlers: Map<string, Array<(data: unknown) => void>>;
	emitted: Array<{ channel: string; data: unknown }>;
	events: {
		emit(channel: string, data: unknown): void;
		on(channel: string, handler: (data: unknown) => void): () => void;
	};
	listen(channel: string, data: unknown): void;
}

function recordedEmitter(): RecordedEmitter {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const events = {
		on(channel: string, handler: (data: unknown) => void) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () => {
				const current = handlers.get(channel) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) current.splice(index, 1);
			};
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
	};
	return {
		handlers,
		emitted,
		events,
		listen: (channel: string, data: unknown) => events.emit(channel, data),
	};
}

test("emitFullscreenActivity publishes the documented open/close payload", () => {
	const emitter = recordedEmitter();

	emitFullscreenActivity(emitter, "gentle-shell:profiles", true);
	emitFullscreenActivity(emitter, "gentle-shell:profiles", false);

	assert.deepEqual(emitter.emitted, [
		{ channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: true, source: "gentle-shell:profiles" } },
		{ channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: false, source: "gentle-shell:profiles" } },
	]);
});

test("monitor tracks one entry per source on open and releases it on close", () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);

	emitFullscreenActivity(emitter, "gentle-agents:tasks", true);
	assert.equal(monitor.isActive(), true);

	emitFullscreenActivity(emitter, "gentle-agents:tasks", false);
	assert.equal(monitor.isActive(), false);
});

test("monitor tolerates duplicate opens with multiple close events", () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);

	emitFullscreenActivity(emitter, "gentle-guide:tour", true);
	emitFullscreenActivity(emitter, "gentle-guide:tour", true);
	emitFullscreenActivity(emitter, "gentle-guide:tour", false);
	emitFullscreenActivity(emitter, "gentle-guide:tour", false);

	assert.equal(monitor.isActive(), false);
});

test("monitor keeps counting while a second source stays open", () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);

	emitFullscreenActivity(emitter, "gentle-agents:tasks", true);
	emitFullscreenActivity(emitter, "gentle-stats:summary", true);
	assert.equal(monitor.isActive(), true);

	emitFullscreenActivity(emitter, "gentle-agents:tasks", false);
	assert.equal(monitor.isActive(), true, "closing one menu must not release the wait while another is open");

	emitFullscreenActivity(emitter, "gentle-stats:summary", false);
	assert.equal(monitor.isActive(), false);
});

test("monitor ignores events without the documented shape", () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);

	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: true } as unknown);
	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: "yes", source: "broken" } as unknown);
	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: true, source: "" } as unknown);

	assert.equal(monitor.isActive(), false);
});

test("waitIfActive resolves when all activity closes, not midway", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	emitFullscreenActivity(emitter, "gentle-shell:profiles", true);

	let resolved = false;
	const pending = monitor.waitIfActive().then(() => {
		resolved = true;
	});
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	assert.equal(resolved, false, "defer must hold while the menu is open");

	emitFullscreenActivity(emitter, "gentle-shell:profiles", false);
	await pending;
	assert.equal(resolved, true);
});

test("waitIfActive returns immediately when activity is already closed", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);

	await monitor.waitIfActive();
	assert.equal(monitor.isActive(), false);
});

test("waitIfActive resolves nothing stuck when a scaled set releases one by one", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	for (const source of ["gentle-shell:a", "gentle-shell:b", "gentle-shell:c"]) {
		emitFullscreenActivity(emitter, source, true);
	}

	const pending = monitor.waitIfActive();
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	for (const source of ["gentle-shell:a", "gentle-shell:b", "gentle-shell:c"]) {
		emitFullscreenActivity(emitter, source, false);
	}
	await pending;
	assert.equal(monitor.isActive(), false);
});

test("waitIfActive keeps waiting when a new menu opens during the defer", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	emitFullscreenActivity(emitter, "gentle-shell:profiles", true);

	const pending = monitor.waitIfActive();
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	emitFullscreenActivity(emitter, "gentle-shell:profiles", false);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	emitFullscreenActivity(emitter, "gentle-shell:palette", true);
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
	emitFullscreenActivity(emitter, "gentle-shell:palette", false);

	await pending;
	assert.equal(monitor.isActive(), false);
});

test("waitIfActive honors an already aborted signal without mounting", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	emitFullscreenActivity(emitter, "gentle-shell:profiles", true);

	const controller = new AbortController();
	controller.abort();
	await monitor.waitIfActive(controller.signal);

	assert.equal(monitor.isActive(), true, "aborting the wait must not replace the deferred ask with an open request");
});

test("withFullscreenOverlay emits open before the run and close after it resolves", async () => {
	const emitter = recordedEmitter();
	const order: string[] = [];

	await withFullscreenOverlay(emitter, "gentle-shell:profiles", async () => {
		order.push("run");
		assert.deepEqual(emitter.emitted, [
			{ channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: true, source: "gentle-shell:profiles" } },
		], "the open event must already be visible to anything observing inside the run");
		return "answer";
	});

	assert.equal(order[0], "run");
	assert.deepEqual(emitter.emitted[1], { channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: false, source: "gentle-shell:profiles" } });
});

test("withFullscreenOverlay emits close even when the run throws", async () => {
	const emitter = recordedEmitter();

	await assert.rejects(
		withFullscreenOverlay(emitter, "gentle-shell:profiles", async () => {
			throw new Error("menu render failed");
		}),
		/menu render failed/,
	);

	assert.deepEqual(emitter.emitted, [
		{ channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: true, source: "gentle-shell:profiles" } },
		{ channel: FULLSCREEN_ACTIVITY_EVENT, data: { active: false, source: "gentle-shell:profiles" } },
	]);
});

test("withFullscreenOverlay and emitFullscreenActivity never emit an unnamed source", async () => {
	const emitter = recordedEmitter();

	emitFullscreenActivity(emitter, "", true);
	await withFullscreenOverlay(emitter, "", async () => undefined);

	assert.deepEqual(emitter.emitted, [], "an unnamed activity must not be published as it would poison everyone's waits");
});

test("FullscreenActivityEvent payload contract stays narrow", () => {
	const sample: FullscreenActivityEvent = { active: true, source: "gentle-shell:profiles" };
	assert.deepEqual(Object.keys(sample).sort(), ["active", "source"]);
});

test("attach subscribes once even when it is called twice", () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();

	const first = monitor.attach(emitter.events);
	const second = monitor.attach(emitter.events);

	assert.equal((emitter.handlers.get(FULLSCREEN_ACTIVITY_EVENT) ?? []).length, 1, "a repeated attach must reuse its subscription instead of leaking a second listener");
	assert.equal(typeof first, "function", "attach hands back the unsubscribe it installed");
	assert.equal(second, first, "a repeated attach hands back the same unsubscribe");
});

test("the attach unsubscribe releases a pending wait instead of hanging it", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	const unsubscribe = monitor.attach(emitter.events);

	assert.equal(typeof unsubscribe, "function", "attach must return an unsubscribe so a torn-down extension stops listening");
	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: true, source: "gentle-shell:profiles" });
	const waiting = monitor.waitIfActive();
	unsubscribe?.();

	assert.equal(await waiting, "released", "a detached monitor must not leave a deferred ask waiting forever");
	assert.equal(monitor.isActive(), false, "a detached monitor tracks no activity");
	assert.equal((emitter.handlers.get(FULLSCREEN_ACTIVITY_EVENT) ?? []).length, 0, "the listener is gone from the bus");
});

test("a released wait leaves no abort listener on the caller's signal", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	const controller = new AbortController();

	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: true, source: "gentle-shell:profiles" });
	const waiting = monitor.waitIfActive(controller.signal);
	await Promise.resolve();
	emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: false, source: "gentle-shell:profiles" });

	assert.equal(await waiting, "released");
	assert.equal(getEventListeners(controller.signal, "abort").length, 0, "a released wait must remove its abort listener, not abandon it on the caller's signal");
});

test("repeated defers on one signal do not accumulate abort listeners", async () => {
	const emitter = recordedEmitter();
	const monitor = new FullscreenActivityMonitor();
	monitor.attach(emitter.events);
	const controller = new AbortController();

	for (let round = 0; round < 3; round += 1) {
		const source = `gentle-shell:menu-${round}`;
		emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: true, source });
		const waiting = monitor.waitIfActive(controller.signal);
		await Promise.resolve();
		assert.equal(getEventListeners(controller.signal, "abort").length, 1, "one listener per in-flight wait, never more");
		emitter.listen(FULLSCREEN_ACTIVITY_EVENT, { active: false, source });
		assert.equal(await waiting, "released");
	}

	assert.equal(getEventListeners(controller.signal, "abort").length, 0, "three released waits must not leave three listeners behind");
});

test("attach refuses a bus that cannot subscribe instead of silently disabling the defer", () => {
	const monitor = new FullscreenActivityMonitor();

	assert.throws(
		() => monitor.attach({ emit() {} } as never),
		/requires an EventBus with on\(\)/,
		"a bus that cannot subscribe is a contract violation: failing loudly beats a defer that silently never happens",
	);
	assert.equal(monitor.isActive(), false, "a refused attach tracks no activity");
});

