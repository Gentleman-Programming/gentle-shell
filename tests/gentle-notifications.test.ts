import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createNotificationExtension } from "../extensions/gentle-notifications.ts";
import { getNotificationService } from "../lib/notification-service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_EVENTS, type NotificationSettings } from "../lib/notification-policy.ts";
import { NOTIFICATION_SOURCE_EVENT, NOTIFICATION_ATTENTION_EVENT } from "../lib/notification-events.ts";
import type { SchedulerOptions } from "../lib/notification-scheduler.ts";

const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let nextSession = 0;
interface Options {
	sessionId?: string;
	enabled?: boolean; mode?: string; child?: boolean; malformed?: boolean; readError?: boolean; absent?: boolean;
	deferred?: boolean; slowProbe?: boolean; holdPlayback?: boolean; noUnsubscribe?: boolean; unavailable?: boolean; fail?: boolean;
	capabilities?: Set<"wav" | "ogg" | "flac">;
}
function harness(options: Options = {}) {
	const id = options.sessionId ?? `parent-${++nextSession}`;
	const native = new Map<string, Set<(event: any, ctx: ExtensionContext) => unknown>>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const listen = (map: Map<string, Set<any>>, key: string, fn: any) => {
		if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(fn);
		return () => { map.get(key)!.delete(fn); };
	};
	// SAFETY: only lifecycle hooks and the bus are used by this factory; a minimal fake traps that contract.
	const pi = { on: (key: string, fn: any) => {
		const off = listen(native, key, fn); return options.noUnsubscribe ? undefined : off;
	}, events: { on: (key: string, fn: any) => listen(bus, key, fn), emit: (key: string, data: unknown) => {
		for (const fn of [...bus.get(key) ?? []]) fn(data);
	} } } as unknown as ExtensionAPI;
	let time = 100; let nextTimer = 0; let probes = 0; let writes = 0; let attempts = 0;
	const timers = new Map<number, { fn: () => void; at: number }>();
	const played: string[] = []; const signals: AbortSignal[] = []; const permits: Parameters<SchedulerOptions["player"]>[2][] = [];
	const releases: (() => void)[] = []; const probeReleases: (() => void)[] = []; const notes: string[] = [];
	let settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS);
	settings.enabled = options.enabled ?? !options.absent; settings.audio.minimumIntervalMs = 0; settings.audio.coalesceWindowMs = 0;
	settings.audio.events = Object.fromEntries(NOTIFICATION_EVENTS.map(e => [e,
		e.endsWith("failed") ? "builtin:error" : e === "agent.cancelled" ? "builtin:attention" : "builtin:success"]));
	// SAFETY: this owner reads only mode, session identity and local notify, never session entries/model APIs.
	const ctx = { mode: options.mode ?? "tui", hasUI: true, sessionManager: { getSessionId: () => id },
		ui: { notify: (s: string) => notes.push(s) } } as unknown as ExtensionContext;
	const deps = { now: () => time, env: { GENTLE_PI_AGENTS_CHILD: options.child ? "1" : "0", GENTLE_SHELL_INTERACTIVE_HOST: "1" },
		setTimeout: (fn: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { fn, at: time + delay }); return id; },
		clearTimeout: (id: number) => { timers.delete(id); },
		read: () => ({ settings: structuredClone(settings), source: options.absent ? "default" as const : "global_file" as const,
			malformed: options.malformed ?? false, readError: options.readError ?? false, globalFile: "/config/notifications.json" }),
		write: (s: NotificationSettings) => { writes++; settings = structuredClone(s); return "/config/notifications.json"; },
		backend: { availability: async () => {
			probes++; if (options.slowProbe) await new Promise<void>(resolve => probeReleases.push(resolve));
			return options.unavailable ? "unavailable" as const : "available" as const;
		}, capabilities: async () => options.capabilities ?? new Set(["wav", "ogg", "flac"] as const), play: async (sound: string, signal: AbortSignal, permit: Parameters<SchedulerOptions["player"]>[2]) => {
			attempts++; signals.push(signal); permits.push(permit);
			if (options.deferred) await new Promise<void>(resolve => releases.push(resolve));
			if (permit.start()) played.push(sound);
			if (options.holdPlayback) await new Promise<void>(resolve => releases.push(resolve));
			if (options.fail) throw new Error("private backend detail");
		} },
	};
	const retire = createNotificationExtension(pi, deps);
	const emit = async (type: string, data: object = {}, context = ctx) => {
		for (const fn of [...native.get(type) ?? []]) await fn({ type, ...data }, context);
		await drain();
	};
	const start = async (reason = "reload") => { await emit("session_start", { reason }); getNotificationService()?.setMuted(ctx, false); await drain(); };
	const source = (sequence: number, extra: object = {}) => pi.events.emit(NOTIFICATION_SOURCE_EVENT, {
		source: "subagent", producerId: "producer", sessionId: id, parentSessionId: id, taskId: "task",
		runId: "run", sequence, occurredAt: time, event: "subagent.completed", status: "completed", ...extra,
	});
	const advance = (ms: number) => { time += ms;
		for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
	};
	return { id, pi, ctx, deps, retire, emit, start, source, played, signals, permits, releases, probeReleases, notes, native, bus, timers, advance,
		get probes() { return probes; }, get writes() { return writes; }, get attempts() { return attempts; } };
}
const listeners = (map: Map<string, Set<any>>) => [...map.values()].reduce((n, set) => n + set.size, 0);

for (const absent of [false, true]) test(`off/absent=${absent}: lazy, preview bypasses mute/off without writing`, async () => {
	const h = harness({ enabled: false, absent }); try {
		await h.start(); await h.emit("agent_start"); await h.emit("agent_before_settle", { outcome: "completed" }); await h.emit("agent_settled");
		assert.equal(h.probes, 0); assert.equal(h.attempts, 0); assert.equal(h.writes, 0);
		const service = getNotificationService()!; service.setMuted(h.ctx, true);
		assert.equal(service.preview(h.ctx, "builtin:success"), true); await drain();
		assert.deepEqual(h.played, ["builtin:success"]); assert.equal(h.writes, 0);
		assert.equal(await service.availability(h.ctx), "available"); assert.equal(h.probes, 2);
	} finally { h.retire(); }
});

test("settled uses latest boundary, never agent_end; fallback only corresponding run", async () => {
	const h = harness(); try {
		await h.start();
		for (const [outcome, sound] of [["completed", "builtin:success"], ["error", "builtin:error"], ["aborted", "builtin:attention"]]) {
			await h.emit("agent_start"); h.played.length = 0;
			await h.emit("agent_before_settle", { outcome: "error" }); await h.emit("agent_before_settle", { outcome });
			await h.emit("turn_end", { outcome: "error" }); await h.emit("agent_end"); assert.deepEqual(h.played, []);
			await h.emit("agent_settled"); await h.emit("agent_settled"); assert.deepEqual(h.played, [sound]);
		}
		await h.emit("agent_start"); h.played.length = 0; await h.emit("turn_end", { outcome: "completed" }); await h.emit("agent_settled");
		assert.deepEqual(h.played, ["builtin:success"]);
		await h.emit("agent_start"); h.played.length = 0; await h.emit("agent_settled"); assert.deepEqual(h.played, []);
		await h.emit("agent_start"); h.played.length = 0; await h.emit("agent_before_settle", { outcome: "unknown" }); await h.emit("agent_settled");
		assert.deepEqual(h.played, []); assert.equal(h.native.has("agent_end"), false);
	} finally { h.retire(); }
});

test("subagent validation, highwater beyond cap, foreign/future/history sources silent", async () => {
	const h = harness(); try {
		await h.start();
		for (const extra of [{ parentSessionId: "foreign" }, { sessionId: "foreign", parentSessionId: "foreign" },
			{ occurredAt: 101 }, { occurredAt: 99 }, { source: "main" }, { sequence: 0 }, { status: "failed" }]) { h.source(1, extra); await drain(); }
		assert.deepEqual(h.played, []);
		for (let i = 1; i <= 260; i++) { h.source(i); await drain(); }
		assert.equal(h.played.length, 260); h.source(1); h.source(259); h.source(260); await drain(); assert.equal(h.played.length, 260);
		h.source(1, { producerId: "new", runId: "new" }); await drain(); assert.equal(h.played.length, 261);
	} finally { h.retire(); }
});

test("attention is active main edge only, generic/own UI prompts and idle ignored", async () => {
	const h = harness(); try {
		await h.start(); h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: true }); await drain(); assert.equal(h.played.length, 0);
		await h.emit("agent_start"); h.played.length = 0; await h.emit("ui_prompt_start", { kind: "confirm" }); assert.equal(h.played.length, 0);
		h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: true }); await drain();
		h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: true }); await drain(); assert.equal(h.played.length, 1);
		h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: false }); h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: true }); await drain();
		assert.equal(h.played.length, 2); await h.emit("agent_settled"); h.pi.events.emit(NOTIFICATION_ATTENTION_EVENT, { active: true }); await drain(); assert.equal(h.played.length, 2);
	} finally { h.retire(); }
});

for (const options of [{ child: true }, { mode: "rpc" }, { mode: "print" }, { mode: "json" }]) test(`silent guard ${JSON.stringify(options)}`, async () => {
	const h = harness(options); try {
		await h.start(); await h.emit("agent_start"); h.source(1); const service = getNotificationService();
		assert.equal(service?.preview(h.ctx, "builtin:success") ?? false, false);
		assert.equal(await service?.availability(h.ctx) ?? "unavailable", "unavailable");
		assert.equal(h.probes, 0); assert.equal(h.attempts, 0); assert.deepEqual(h.notes, []);
	} finally { h.retire(); }
});

test("duplicate factory retires listeners; mute survives same-id shutdown/runtime rebuild", async () => {
	const a = harness(); await a.start(); const old = getNotificationService()!; old.setMuted(a.ctx, true);
	const b = harness({ sessionId: a.id }); try {
		await b.emit("session_start", { reason: "reload" }); assert.equal(getNotificationService()!.getState().muted, true);
		assert.equal(listeners(a.native), 0); assert.equal(listeners(a.bus), 0); assert.equal(old.preview(a.ctx, "builtin:success"), false);
		await b.emit("session_shutdown", { reason: "reload" }); await b.emit("session_shutdown", { reason: "quit" });
		assert.equal(b.timers.size, 0); assert.equal(listeners(b.bus), 0);
		await b.emit("session_start", { reason: "reload" }); assert.equal(getNotificationService()!.getState().muted, true);
		getNotificationService()!.setMuted(b.ctx, false); b.source(1); await drain(); assert.equal(b.played.length, 1);
	} finally { a.retire(); b.retire(); }
});

test("late validation permit cannot spawn after shutdown or overlap replacement owner", async () => {
	const a = harness({ deferred: true }); await a.start(); a.source(1); await drain(); assert.equal(a.attempts, 1);
	await a.emit("session_shutdown", { reason: "reload" }); assert.equal(a.signals[0].aborted, true);
	const b = harness(); try {
		await b.start(); assert.equal(getNotificationService()!.preview(b.ctx, "builtin:success"), false);
		a.releases[0](); await drain(); assert.equal(a.permits[0].start(), false); assert.equal(a.played.length, 0);
		assert.equal(getNotificationService()!.preview(b.ctx, "builtin:success"), true); await drain(); assert.equal(b.played.length, 1);
	} finally { a.retire(); b.retire(); }
});

for (const invalid of [{ malformed: true }, { readError: true }]) test(`invalid config ${JSON.stringify(invalid)}: no implicit write, recovery consent, restore`, async () => {
	const h = harness(invalid); try {
		await h.start(); h.source(1); await drain(); assert.equal(h.attempts, 0); assert.equal(h.notes.length, 1);
		const service = getNotificationService()!; const state = service.getState(); assert.equal(state.settings.enabled, false);
		state.settings.enabled = true; assert.equal(service.getState().settings.enabled, false);
		assert.equal(service.setConfig(h.ctx, { ...state.settings, enabled: true }), false); assert.equal(h.writes, 0);
		assert.equal(service.setConfig(h.ctx, { ...state.settings, enabled: true },
			{ confirmRecovery: "yes" as unknown as boolean }), false); assert.equal(h.writes, 0);
		assert.equal(service.setConfig(h.ctx, { ...state.settings, enabled: true }, { confirmRecovery: true }), true);
		assert.equal(service.restorePreset(h.ctx), true); assert.equal(service.getState().settings.enabled, true);
		assert.equal(service.getState().supportedEvents.includes("session.shutdown"), false);
	} finally { h.retire(); }
});

test("facade is disposable even for same-id restart", async () => {
	const h = harness(); try {
		await h.start(); const old = getNotificationService()!;
		await h.emit("session_shutdown", { reason: "reload" }); await h.start();
		assert.equal(old.preview(h.ctx, "builtin:success"), false);
		assert.equal(old.setConfig(h.ctx, old.getState().settings), false); assert.equal(h.writes, 0);
	} finally { h.retire(); }
});

test("same process factory rebuild preserves producer highwater with no duplicate replay", async () => {
	const a = harness(); await a.start(); a.source(290); await drain(); assert.equal(a.played.length, 1);
	const b = harness({ sessionId: a.id }); try {
		await b.start(); b.source(290); b.source(1); await drain(); assert.equal(b.played.length, 0);
		b.source(291); await drain(); assert.equal(b.played.length, 1);
	} finally { a.retire(); b.retire(); }
});

test("startup occurs once per process, never resume/fork history or quit", async () => {
	const h = harness(); try {
		await h.start("startup"); assert.equal(h.played.length, 1);
		for (const reason of ["reload", "resume", "fork", "new", "startup"]) {
			await h.emit("session_shutdown", { reason: "quit" }); await h.start(reason);
		}
		assert.equal(h.played.length, 1);
		const duplicateModule = await import(new URL("../lib/notification-service.ts?runtime-copy", import.meta.url).href);
		assert.equal(duplicateModule.getNotificationService(), getNotificationService());
	} finally { h.retire(); }
});

test("slow availability abort plus late rejection never spawns or notifies after shutdown", async () => {
	const h = harness({ slowProbe: true }); try {
		await h.start(); h.source(1); await drain(); assert.equal(h.probes, 1);
		await h.emit("session_shutdown", { reason: "quit" }); h.probeReleases[0](); await drain();
		assert.equal(h.attempts, 0); assert.equal(h.timers.size, 0); assert.deepEqual(h.notes, []);
	} finally { h.retire(); }
	const late = harness({ deferred: true, fail: true }); try {
		await late.start(); late.source(1); await drain(); await late.emit("session_shutdown", { reason: "quit" });
		late.releases[0](); await drain(); assert.equal(late.played.length, 0); assert.deepEqual(late.notes, []);
	} finally { late.retire(); }
});

test("active playback abort retains serial reservation through close even across factory collision", async () => {
	const a = harness({ holdPlayback: true }); await a.start(); a.source(1); await drain(); assert.equal(a.played.length, 1);
	const b = harness(); try {
		await b.start(); assert.equal(a.signals[0].aborted, true);
		assert.equal(getNotificationService()!.preview(b.ctx, "builtin:success"), false);
		b.source(1); await drain(); assert.equal(b.attempts, 0);
		a.releases[0](); await drain(); b.source(2); await drain(); assert.equal(b.played.length, 1);
	} finally { a.retire(); b.retire(); }
});

test("settings change cancels pending/stale mappings; mute consumes events with no replay", async () => {
	const h = harness(); try {
		await h.start(); const service = getNotificationService()!; const settings = service.getState().settings;
		settings.audio.coalesceWindowMs = 300; service.setConfig(h.ctx, settings);
		h.source(1); assert.equal(h.timers.size, 1); assert.equal(service.preview(h.ctx, "builtin:success"), false);
		settings.audio.events["subagent.completed"] = "builtin:error"; service.setConfig(h.ctx, settings);
		assert.equal(h.timers.size, 0); h.advance(300); await drain(); assert.equal(h.played.length, 0);
		h.source(2); service.setMuted(h.ctx, true); h.advance(300); service.setMuted(h.ctx, false); h.source(2); await drain(); assert.equal(h.played.length, 0);
		h.source(3); h.advance(300); await drain(); assert.deepEqual(h.played, ["builtin:error"]);
		settings.enabled = false; service.setConfig(h.ctx, settings); service.restorePreset(h.ctx); assert.equal(service.getState().settings.enabled, false);
	} finally { h.retire(); }
});

test("local diagnostics are once/category, generic only, outside-context facade silent", async () => {
	for (const unavailable of [true, false]) {
		const h = harness({ unavailable, fail: !unavailable }); try {
			await h.start(); h.source(1); await drain(); h.advance(6000); h.source(2); await drain();
			assert.equal(h.notes.length, 1); assert.equal(h.notes[0].includes("private backend detail"), false);
			const service = getNotificationService()!;
			const foreign = { ...h.ctx, mode: "rpc" as const };
			assert.equal(service.preview(foreign, "builtin:success"), false);
			assert.equal(service.setConfig(foreign, service.getState().settings), false);
			const probes = h.probes; assert.equal(await service.availability(foreign), "unavailable"); assert.equal(h.probes, probes);
			const wrongSession = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "foreign" } };
			assert.equal(service.preview(wrongSession, "builtin:success"), false);
		} finally { h.retire(); }
	}
});

test("supported subagent states are all live-wired, waiting is not main attention", async () => {
	const h = harness(); try {
		await h.start(); let sequence = 0;
		for (const status of ["queued", "running", "waiting", "completed", "failed", "cancelled", "timed_out"]) {
			h.source(++sequence, { status, event: `subagent.${status}` }); await drain();
		}
		assert.equal(h.played.length, 7); assert.equal(h.played[4], "builtin:error");
	} finally { h.retire(); }
});

test("new session invalidates old context, permits and pending without replay", async () => {
	const h = harness(); try {
		await h.start(); const old = getNotificationService()!;
		await h.emit("session_shutdown", { reason: "new" });
		const fresh = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "fresh-parent" } };
		await h.emit("session_start", { reason: "new" }, fresh);
		const service = getNotificationService()!; service.setMuted(fresh, false);
		assert.equal(old.preview(h.ctx, "builtin:success"), false); h.source(100); await drain(); assert.equal(h.played.length, 0);
		assert.equal(service.preview(h.ctx, "builtin:success"), false);
		assert.equal(service.preview(fresh, "builtin:success"), true); await drain(); assert.equal(h.played.length, 1);
	} finally { h.retire(); }
});

test("legacy native handlers without unsubscribe become inert when their lease is retired", async () => {
	const a = harness({ noUnsubscribe: true }); await a.start(); const b = harness(); try {
		await b.start(); await a.emit("session_start", { reason: "startup" }); await a.emit("agent_start");
		await a.emit("agent_before_settle", { outcome: "completed" }); await a.emit("agent_settled");
		await a.emit("session_shutdown", { reason: "quit" }); assert.equal(a.attempts, 0);
		b.source(1); await drain(); assert.equal(b.played.length, 1); assert.equal(listeners(a.bus), 0);
	} finally { a.retire(); b.retire(); }
});

// Byte-exact fixtures so assignment-capability rejection is verified without external encoders.
function oggPage(headerType: number, granule: number, body: Buffer, seqno = 0): Buffer {
	const segments = body.length === 0 ? 0 : Math.ceil(body.length / 255);
	const table = Buffer.alloc(segments); let remaining = body.length;
	for (let i = 0; i < segments; i++) { table[i] = Math.min(255, remaining); remaining -= table[i]!; }
	const head = Buffer.alloc(27); head.write("OggS", 0); head[4] = 0; head[5] = headerType;
	head.writeUInt32LE(granule >>> 0, 6); head.writeUInt32LE(0, 10); head.writeUInt32LE(0, 14);
	head.writeUInt32LE(seqno, 18); head.writeUInt32LE(0, 22); head[26] = segments;
	return Buffer.concat([head, table, body]);
}
function vorbisId(): Buffer {
	const b = Buffer.alloc(30); b[0] = 0x01; b.write("vorbis", 1); b[11] = 1; b.writeUInt32LE(8000, 12); b[29] = 0x01; return b;
}
function oggVorbis(): Buffer {
	return Buffer.concat([oggPage(0x02, 0, vorbisId(), 0), oggPage(0x00, 8000, Buffer.alloc(0), 1)]);
}
function flac(): Buffer {
	const sampleRate = 8000; const totalSamples = 8000; const b = Buffer.alloc(46);
	b.write("fLaC", 0); b[4] = 0x80; b[7] = 34; const s = 8;
	b[s + 10] = (sampleRate >> 12) & 0xff; b[s + 11] = (sampleRate >> 4) & 0xff; b[s + 12] = (sampleRate & 0x0f) << 4;
	b[s + 13] = 0xf0; b.writeUInt32BE(totalSamples, s + 14); return b;
}

for (const capabilities of [["wav"], ["wav", "ogg", "flac"]] as const) {
	test(`validateFile gates OGG/FLAC on the detected player capabilities ${JSON.stringify(capabilities)}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "gentle-notification-validate-"));
		const wavPath = join(dir, "sound.wav"); const oggPath = join(dir, "sound.ogg"); const flacPath = join(dir, "sound.flac");
		await writeFile(wavPath, Buffer.alloc(0)); await writeFile(oggPath, oggVorbis()); await writeFile(flacPath, flac());
		const h = harness({ capabilities: new Set(capabilities) }); try {
			await h.start(); const service = getNotificationService()!;
			assert.equal(await service.validateFile(h.ctx, `file:${wavPath}`), false, "an empty file is never a valid sound");
			const wavBytes = Buffer.alloc(44 + 4); wavBytes.write("RIFF", 0); wavBytes.writeUInt32LE(wavBytes.length - 8, 4);
			wavBytes.write("WAVEfmt ", 8); wavBytes.writeUInt32LE(16, 16); wavBytes.writeUInt16LE(1, 20); wavBytes.writeUInt16LE(1, 22);
			wavBytes.writeUInt32LE(8000, 24); wavBytes.writeUInt32LE(16000, 28); wavBytes.writeUInt16LE(2, 32);
			wavBytes.writeUInt16LE(16, 34); wavBytes.write("data", 36); wavBytes.writeUInt32LE(4, 40);
			await writeFile(wavPath, wavBytes);
			assert.equal(await service.validateFile(h.ctx, `file:${wavPath}`), true, "WAV stays accepted for every player");
			const supports = new Set(capabilities);
			assert.equal(await service.validateFile(h.ctx, `file:${oggPath}`), supports.has("ogg"), "OGG requires the player capability");
			assert.equal(await service.validateFile(h.ctx, `file:${flacPath}`), supports.has("flac"), "FLAC requires the player capability");
		} finally { h.retire(); await rm(dir, { recursive: true, force: true }); }
	});
}
