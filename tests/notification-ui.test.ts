import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openNotificationPanel } from "../lib/notification-ui.ts";
import { claimNotificationOwner, getNotificationService } from "../lib/notification-service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../lib/notification-policy.ts";
import { fileURLToPath } from "node:url";

const childEnv = process.env.GENTLE_PI_AGENTS_CHILD;
before(() => { process.env.GENTLE_PI_AGENTS_CHILD = "0"; });
after(() => { if (childEnv === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD; else process.env.GENTLE_PI_AGENTS_CHILD = childEnv; });

function harness(options: { malformed?: boolean; readError?: boolean; failWrite?: boolean } = {}) {
	const choices: (string | undefined)[] = []; const inputs: (string | undefined)[] = [];
	const confirms: unknown[] = []; const notes: string[] = []; const menus: string[][] = [];
	let writes = 0; let probes = 0; let confirmations = 0; let played = 0;
	let beforeSelect: (() => void) | undefined;
	let settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS);
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "ui-session" }, ui: {
		select: async (_title: string, items: string[]) => { menus.push(items); beforeSelect?.(); beforeSelect = undefined; return choices.shift(); },
		input: async () => inputs.shift(), confirm: async () => { confirmations++; return confirms.shift(); },
		notify: (text: string) => notes.push(text),
	} } as unknown as ExtensionContext;
	const owner = claimNotificationOwner(() => {}, { env: {},
		read: () => ({ settings, source: "global_file", malformed: options.malformed ?? false,
			readError: options.readError ?? false, globalFile: "/config/notifications.json" }),
		write: (next: NotificationSettings) => { writes++; if (options.failWrite) throw Error("private"); settings = next; return "/config/notifications.json"; },
		backend: { availability: async () => { probes++; return "available"; }, capabilities: async () => new Set(["wav", "ogg", "flac"] as const), play: async (_sound, _signal, permit) => { if (permit.start()) played++; } },
	}); owner.attach(ctx); getNotificationService()!.setMuted(ctx, false);
	return { ctx, owner, choices, inputs, confirms, notes, menus,
		panel: () => openNotificationPanel(ctx), replaceDuringSelect: () => { beforeSelect = () => owner.attach(ctx); },
		get writes() { return writes; }, get probes() { return probes; }, get confirmations() { return confirmations; }, get played() { return played; } };
}

test("panel is lazy; origin/event mapping independent; preview doesn't enable or write", async () => {
	const h = harness(); try {
		h.choices.push("Assign sound", "agent", "agent.failed", "builtin:attention", "Preview sound", "builtin:success", undefined);
		await h.panel(); for (let i = 0; i < 20; i++) await Promise.resolve();
		const state = getNotificationService()!.getState();
		assert.equal(state.settings.enabled, false); assert.equal(state.settings.audio.events["agent.failed"], "builtin:attention");
		assert.equal(state.settings.audio.events["subagent.failed"], "builtin:error"); assert.equal(h.writes, 1); assert.equal(h.played, 1);
		assert.equal(h.menus.flat().includes("session.shutdown"), false);
	} finally { h.owner.retire(); }
});

test("open/cancel, cancelled file and unsupported URL never save/probe", async () => {
	for (const input of [undefined, "https://example.test/s.wav", "relative.wav", "~/sound.wav", "/no/such/notification.wav"]) {
		const h = harness(); try {
			h.choices.push("Assign sound", "session", "session.started", "Local WAV file", undefined); h.inputs.push(input);
			await h.panel(); assert.equal(h.writes, 0); assert.equal(h.probes, 0);
			assert.equal(getNotificationService()!.getState().settings.audio.events["session.started"], null);
		} finally { h.owner.retire(); }
	}
});

test("regular valid WAV selection saves without playing, invalid content does not", async () => {
	for (const [path, valid] of [[fileURLToPath(new URL("../assets/sounds/success.wav", import.meta.url)), true],
		[fileURLToPath(new URL("../package.json", import.meta.url)), false]] as const) {
		const h = harness(); try {
			h.choices.push("Assign sound", "agent", "agent.completed", "Local WAV file", undefined); h.inputs.push(path);
			await h.panel(); assert.equal(h.writes, valid ? 1 : 0); assert.equal(h.played, 0); assert.equal(h.probes, 0);
		} finally { h.owner.retire(); }
	}
});

test("enable/disable, mute/resume, silence, restore preserve enabled; availability explicit", async () => {
	const h = harness(); try {
		h.choices.push("Enable audio", "Mute", "Resume", "Assign sound", "subagent", "subagent.failed", "Silence", "Restore preset", "Disable audio", "Restore preset", "Check availability", undefined);
		await h.panel(); const state = getNotificationService()!.getState();
		assert.equal(state.settings.enabled, false); assert.equal(state.muted, false);
		assert.equal(state.settings.audio.events["subagent.failed"], "builtin:error"); assert.equal(h.probes, 1); assert.equal(h.writes, 5);
	} finally { h.owner.retire(); }
});

for (const invalid of [{ malformed: true }, { readError: true }]) test(`recovery consent fresh on each action ${JSON.stringify(invalid)}`, async () => {
	const h = harness({ ...invalid, failWrite: true }); try {
		h.choices.push("Enable audio", "Restore preset", "Enable audio", "Restore preset", undefined);
		h.confirms.push(undefined, "yes", true, false); await h.panel();
		assert.equal(h.confirmations, 4); assert.equal(h.writes, 1);
		assert.equal(getNotificationService()!.getState().settings.enabled, false);
		assert.equal(getNotificationService()!.getState().malformed || getNotificationService()!.getState().readError, true);
		assert.equal(h.notes.some(note => note.includes("private")), false);
	} finally { h.owner.retire(); }
});

test("runtime replacement during prompt cannot write via either stale or fresh facade", async () => {
	const h = harness(); try {
		h.choices.push("Enable audio"); h.replaceDuringSelect(); await h.panel(); assert.equal(h.writes, 0);
	} finally { h.owner.retire(); }
});

test("cancel origin/event/builtin and silent preview leave settings untouched", async () => {
	for (const choices of [["Assign sound", undefined], ["Assign sound", "agent", undefined],
		["Assign sound", "agent", "agent.failed", undefined], ["Preview sound", undefined], ["Preview sound", "Silence"]]) {
		const h = harness(); try {
			h.choices.push(...choices, undefined); await h.panel();
			assert.equal(h.writes, 0); assert.equal(h.probes, 0); assert.equal(h.played, 0);
		} finally { h.owner.retire(); }
	}
});

test("literal file path with spaces passes unchanged; preview error stays local", async () => {
	const h = harness(); try {
		const service = getNotificationService()!; const validated: string[] = [];
		service.validateFile = async (_ctx, sound) => { validated.push(sound); return true; };
		service.preview = () => false;
		h.choices.push("Assign sound", "agent", "agent.failed", "Local WAV file", "Preview sound", "builtin:error", undefined);
		h.inputs.push("/local/my sound ; name.wav"); await h.panel();
		assert.deepEqual(validated, ["file:/local/my sound ; name.wav"]);
		assert.equal(service.getState().settings.audio.events["agent.failed"], "file:/local/my sound ; name.wav");
		assert.equal(h.writes, 1); assert.equal(h.probes, 0); assert.match(h.notes.at(-1)!, /busy/);
	} finally { h.owner.retire(); }
});

test("recovery confirmed once succeeds; cancelling preserves original state", async () => {
	const h = harness({ malformed: true }); try {
		const before = JSON.stringify(getNotificationService()!.getState());
		h.choices.push("Enable audio", undefined); h.confirms.push(false); await h.panel();
		assert.equal(JSON.stringify(getNotificationService()!.getState()), before); assert.equal(h.writes, 0);
		h.choices.push("Enable audio", "Restore preset", undefined); h.confirms.push(true); await h.panel();
		assert.equal(h.confirmations, 2); assert.equal(h.writes, 2);
		assert.equal(getNotificationService()!.getState().settings.enabled, true);
		assert.equal(getNotificationService()!.getState().malformed, false);
	} finally { h.owner.retire(); }
});

test("reload during file or confirmation prompt cannot persist stale choices", async () => {
	for (const confirmation of [false, true]) {
		const h = harness({ malformed: confirmation }); try {
			if (confirmation) {
				h.ctx.ui.confirm = async () => { h.owner.attach(h.ctx); return true; };
				h.choices.push("Enable audio");
			} else {
				h.ctx.ui.input = async () => { h.owner.attach(h.ctx); return "/local/sound.wav"; };
				h.choices.push("Assign sound", "agent", "agent.failed", "Local WAV file");
			}
			await h.panel(); assert.equal(h.writes, 0);
		} finally { h.owner.retire(); }
	}
});

test("input failure reports generic local diagnostic and returns to panel", async () => {
	const h = harness(); try {
		h.ctx.ui.input = async () => { throw Error("private path"); };
		h.choices.push("Assign sound", "agent", "agent.failed", "Local WAV file", undefined);
		await h.panel(); assert.equal(h.writes, 0); assert.equal(h.probes, 0);
		assert.match(h.notes.at(-1)!, /action failed/); assert.equal(h.notes.some(note => note.includes("private")), false);
	} finally { h.owner.retire(); }
});

test("headless/RPC and missing owner do not open dialogs", async () => {
	const h = harness(); try {
		for (const mode of ["rpc", "print", "json"] as const) await openNotificationPanel({ ...h.ctx, mode });
		process.env.GENTLE_PI_AGENTS_CHILD = "1"; await h.panel(); process.env.GENTLE_PI_AGENTS_CHILD = "0";
		h.owner.retire(); await h.panel(); assert.deepEqual(h.menus, []); assert.equal(h.probes, 0);
	} finally { h.owner.retire(); }
});
