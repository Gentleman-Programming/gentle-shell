import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildNotificationRows } from "../lib/notification-customize.ts";
import { claimNotificationOwner, getNotificationService } from "../lib/notification-service.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationEvent, type NotificationSettings, type NotificationSound } from "../lib/notification-policy.ts";
import { VisualCustomizeView, type CustomizeInline, type CustomizeRow } from "../lib/visual-customize-view.ts";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real packaged WAVs so a valid path uses an existing fixture, never a synthetic name. */
const WAV_FIXTURE = fileURLToPath(new URL("../assets/sounds/success.wav", import.meta.url));
const WAV_FIXTURES = {
	success: fileURLToPath(new URL("../assets/sounds/success.wav", import.meta.url)),
	error: fileURLToPath(new URL("../assets/sounds/error.wav", import.meta.url)),
	attention: fileURLToPath(new URL("../assets/sounds/attention.wav", import.meta.url)),
} as const;
/** Fixed verified targets per basic group (S15): the group owns its own file, never a global preset. */
const GROUPS = [
	{ prefix: "Success:", fixture: WAV_FIXTURES.success, targets: ["agent.completed", "subagent.completed"] },
	{ prefix: "Error:", fixture: WAV_FIXTURES.error, targets: ["agent.failed", "subagent.failed", "subagent.timed_out"] },
	{ prefix: "Attention:", fixture: WAV_FIXTURES.attention, targets: ["agent.attention"] },
] as const;
/** Friendly tone name expected for each default group. */
const GROUP_TONE: Readonly<Record<string, string>> = { "Success:": "success tone", "Error:": "error tone", "Attention:": "attention tone" };
function groupEvents(targets: readonly string[], sound: NotificationSound): Partial<Record<NotificationEvent, NotificationSound>> {
	return Object.fromEntries(targets.map(target => [target, sound])) as Partial<Record<NotificationEvent, NotificationSound>>;
}

function harness(options: { malformed?: boolean; failWrite?: boolean; events?: Partial<Record<NotificationEvent, NotificationSound>> } = {}) {
	const notes: string[] = [];
	const nested = { select: 0, input: 0, confirm: 0 };
	let writes = 0; let probes = 0; let played = 0;
	let settings: NotificationSettings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS);
	if (options.events) settings.audio.events = structuredClone(options.events);
	const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "nc-session" }, ui: {
		select: async () => { nested.select++; return undefined; },
		input: async () => { nested.input++; return undefined; },
		confirm: async () => { nested.confirm++; return false; },
		notify: (text: string) => notes.push(text),
	} } as unknown as ExtensionContext;
	const owner = claimNotificationOwner(() => {}, { env: {},
		read: () => ({ settings, source: "global_file", malformed: options.malformed ?? false, readError: false, globalFile: "/config/notifications.json" }),
		write: (next: NotificationSettings) => { writes++; if (options.failWrite) throw Error("private"); settings = next; return "/config/notifications.json"; },
		backend: { availability: async () => { probes++; return "available"; }, capabilities: async () => new Set(["wav", "ogg", "flac"] as const), play: async (_sound, _signal, permit) => { if (permit.start()) played++; } },
	});
	owner.attach(ctx); getNotificationService()!.setMuted(ctx, false);
	return { ctx, owner, notes, nested, get writes() { return writes; }, get probes() { return probes; }, get played() { return played; },
		rows: () => buildNotificationRows(ctx) };
}

function findRow(rows: CustomizeRow[], label: string | RegExp): CustomizeRow {
	const found = rows.find(row => { const text = typeof row.label === "function" ? row.label() : row.label; return typeof label === "string" ? text.startsWith(label) : label.test(text); });
	assert.ok(found, `missing row ${label}`);
	return found!;
}

/** `visible()` is optional; undefined means visible and a throwing callback fails closed. */
function isVisible(row: CustomizeRow): boolean {
	try { return (row as CustomizeRow & { visible?: () => boolean }).visible?.() !== false; } catch { return false; }
}
function visibleRows(rows: CustomizeRow[]): CustomizeRow[] { return rows.filter(isVisible); }
function keyhintOf(row: CustomizeRow): string { return (row as CustomizeRow & { keyhint?: string }).keyhint ?? ""; }

function fakeInline(inputs: (string | undefined)[] = [], confirms: boolean[] = []): CustomizeInline {
	return { input: async () => inputs.shift(), confirm: async () => confirms.shift() ?? false, disposed: false };
}
function label(row: CustomizeRow): string { return typeof row.label === "function" ? row.label() : row.label; }

test("Notifications rows toggle and mute directly without any nested native dialog", async () => {
	const h = harness(); try {
		const rows = h.rows();
		await findRow(rows, "Audio notifications: off").action(fakeInline());
		assert.equal(getNotificationService()!.getState().settings.enabled, true);
		assert.equal(h.writes, 1);
		await findRow(rows, "Audio: unmuted").action(fakeInline());
		assert.equal(getNotificationService()!.getState().muted, true);
		assert.equal(h.writes, 1, "mute persists in-process without writing configuration");
		assert.deepEqual(h.nested, { select: 0, input: 0, confirm: 0 });
	} finally { h.owner.retire(); }
});

test("labels and previews never probe, play or write and the card exposes no availability row", () => {
	const h = harness(); try {
		const rows = h.rows();
		for (const row of rows) { label(row); row.preview?.(); }
		assert.equal(h.probes, 0); assert.equal(h.played, 0); assert.equal(h.writes, 0);
		assert.equal(rows.some(row => label(row).startsWith("Audio availability:")), false, "availability is removed from the card");
		assert.equal(h.probes, 0, "rendering every row still never probes the backend");
	} finally { h.owner.retire(); }
});

test("event rows cycle independently and p tests the selected sound without writing", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const failed = findRow(rows, "agent.failed:");
		assert.match(label(failed), /builtin:error/);
		await failed.action(fakeInline());
		assert.equal(getNotificationService()!.getState().settings.audio.events["agent.failed"], "builtin:attention");
		assert.equal(getNotificationService()!.getState().settings.audio.events["agent.completed"], "builtin:success");
		assert.equal(h.writes, 1);
		assert.equal(failed.key!("p", fakeInline()), true);
		await tick(); await tick();
		assert.equal(h.played, 1);
		assert.equal(h.writes, 1, "preview never writes");
		assert.deepEqual(h.nested, { select: 0, input: 0, confirm: 0 });
	} finally { h.owner.retire(); }
});

test("f opens an inline field; a valid WAV saves while invalid content never writes", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const validated: string[] = [];
		getNotificationService()!.validateFile = async (_ctx, sound) => { validated.push(sound); return true; };
		const event = findRow(rows, "agent.failed:");
		const pending = event.key!("f", fakeInline(["/local/my sound.wav"]));
		assert.ok(pending, "the f shortcut consumes the key through an async task");
		await pending;
		await tick(); await tick();
		assert.deepEqual(validated, ["file:/local/my sound.wav"]);
		assert.equal(getNotificationService()!.getState().settings.audio.events["agent.failed"], "file:/local/my sound.wav");
		assert.equal(h.writes, 1);
		assert.equal(h.nested.input, 0, "the row never opens a native input dialog");
	} finally { h.owner.retire(); }

	const invalid = harness(); try {
		const rows = invalid.rows();
		findRow(rows, "agent.failed:").key!("f", fakeInline([fileURLToPath(new URL("../package.json", import.meta.url))]));
		await tick(); await tick();
		assert.equal(invalid.writes, 0);
	} finally { invalid.owner.retire(); }
});

test("cancelled file input and unsupported URL never validate or write", async () => {
	for (const input of [undefined, "https://example.test/sound.wav"]) {
		const h = harness(); try {
			const rows = h.rows();
			findRow(rows, "agent.failed:").key!("f", fakeInline([input]));
			await tick(); await tick();
			assert.equal(h.writes, 0);
		} finally { h.owner.retire(); }
	}
});

test("malformed configuration needs fresh strict consent per attempt; a failed write grants none", async () => {
	for (const failWrite of [false, true]) {
		const h = harness({ malformed: true, failWrite }); try {
			const rows = h.rows();
			const enable = findRow(rows, "Audio notifications:");
			await enable.action(fakeInline([], [false]));
			assert.equal(h.writes, 0, "cancel preserves the file and settings");
			assert.equal(getNotificationService()!.getState().malformed, true);
			await enable.action(fakeInline([], [true]));
			assert.equal(h.writes, 1, `confirmed attempt must run once (failWrite=${failWrite})`);
			if (failWrite) {
				assert.equal(getNotificationService()!.getState().malformed, true);
				await enable.action(fakeInline([], [false]));
				assert.equal(h.writes, 1, "a failed write cannot reuse prior consent");
				await enable.action(fakeInline([], [true]));
				assert.equal(h.writes, 2);
			}
		} finally { h.owner.retire(); }
	}
});

test("owner replacement during validation cannot persist a stale choice", async () => {
	const h = harness(); try {
		const rows = h.rows();
		getNotificationService()!.validateFile = async () => { h.owner.attach(h.ctx); return true; };
		findRow(rows, "agent.failed:").key!("f", fakeInline(["/local/sound.wav"]));
		await tick(); await tick();
		assert.equal(h.writes, 0);
	} finally { h.owner.retire(); }
});

test("closing the card during validation cannot persist a choice", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const fake = fakeInline(["/local/sound.wav"]);
		getNotificationService()!.validateFile = async () => { fake.disposed = true; return true; };
		findRow(rows, "agent.failed:").key!("f", fake);
		await tick(); await tick();
		assert.equal(h.writes, 0);
	} finally { h.owner.retire(); }
});

function customizeView(rows: CustomizeRow[], onClose: () => void = () => {}) {
	return new VisualCustomizeView({ rows, theme: { fg: (_role: string, text: string) => text }, rowsAvailable: () => 24, requestRender: () => {}, onClose,
		profiles: { list: () => [], save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
}

/** Navigates the controls pane until the given label prefix carries the selection marker. */
function selectControl(view: VisualCustomizeView, prefix: string): void {
	view.render(76);
	view.handleInput("\x1b[C");
	for (let i = 0; i < 60; i++) {
		if (view.render(76).join("\n").includes(`\u25b8 ${prefix}`)) return;
		view.handleInput("\x1b[B");
	}
	assert.fail(`could not select a control labelled ${prefix}`);
}

/** Detailed event rows are folded by default: expand Advanced inside the same card, then select. */
async function expandAndSelect(view: VisualCustomizeView, prefix: string): Promise<void> {
	selectControl(view, "Advanced");
	view.handleInput("\r");
	await tick();
	selectControl(view, prefix);
}

test("an in-flight local sound validation keeps busy, blocking a second field and any write until it settles", async () => {
	const h = harness(); try {
		const rows = h.rows();
		let resolveValidation!: (value: boolean) => void;
		const validated: string[] = [];
		getNotificationService()!.validateFile = (_ctx, sound) => { validated.push(sound); return new Promise<boolean>(resolve => { resolveValidation = resolve; }); };
		const view = customizeView(rows);
		await expandAndSelect(view, "agent.failed:");
		assert.match(view.render(160).join("\n"), /agent\.failed:/);
		view.handleInput("f");
		assert.match(view.render(160).join("\n"), /Local audio path/);
		view.handleInput(WAV_FIXTURE);
		view.handleInput("\r");
		await tick();
		assert.deepEqual(validated, [`file:${WAV_FIXTURE}`], "the submitted value is validated exactly once");
		// Validation is still pending: `f` must not open a second field and Enter must not write.
		view.handleInput("f");
		view.handleInput("\r");
		await tick();
		assert.doesNotMatch(view.render(160).join("\n"), /Local audio path/, "a second f cannot open another field while busy");
		assert.equal(h.writes, 0, "no write before the deferred validation resolves");
		// Resolve: a single write, then busy releases for the next edit.
		resolveValidation(true);
		await tick(); await tick();
		assert.equal(h.writes, 1, "the resolved validation writes exactly once");
		assert.equal(getNotificationService()!.getState().settings.audio.events["agent.failed"], `file:${WAV_FIXTURE}`);
		view.handleInput("f");
		assert.match(view.render(160).join("\n"), /Local audio path/, "busy is released so the next edit opens a fresh field");
	} finally { h.owner.retire(); }
});

test("Escape cancels the inline field while the async key task is busy and releases it", async () => {
	const h = harness(); try {
		const rows = h.rows();
		getNotificationService()!.validateFile = async () => { throw new Error("validation must not run after a cancelled field"); };
		const view = customizeView(rows);
		await expandAndSelect(view, "agent.failed:");
		view.handleInput("f");
		assert.match(view.render(160).join("\n"), /Local audio path/);
		view.handleInput("\x1b");
		await tick(); await tick();
		assert.doesNotMatch(view.render(160).join("\n"), /Local audio path/, "Escape cancels the inline field");
		assert.equal(h.writes, 0, "a cancelled field never validates or writes");
		view.handleInput("f");
		assert.match(view.render(160).join("\n"), /Local audio path/, "busy is released after the cancelled key task");
	} finally { h.owner.retire(); }
});

test("disposing the card while validation is in flight never writes the stale choice", async () => {
	const h = harness(); try {
		const rows = h.rows();
		let resolveValidation!: (value: boolean) => void;
		getNotificationService()!.validateFile = () => new Promise<boolean>(resolve => { resolveValidation = resolve; });
		const view = customizeView(rows);
		await expandAndSelect(view, "agent.failed:");
		view.handleInput("f");
		view.render(160);
		view.handleInput(WAV_FIXTURE);
		view.handleInput("\r");
		await tick();
		view.dispose();
		resolveValidation(true);
		await tick(); await tick();
		assert.equal(h.writes, 0, "a disposed card must not persist the validated choice");
	} finally { h.owner.retire(); }
});

test("missing owner yields unavailable labels and no writes or nested dialogs", async () => {
	const h = harness(); try {
		h.owner.retire();
		const rows = h.rows();
		assert.match(label(rows[0]!), /unavailable/);
		await findRow(rows, "Audio notifications:").action(fakeInline());
		assert.equal(h.writes, 0);
		assert.deepEqual(h.nested, { select: 0, input: 0, confirm: 0 });
	} finally { h.owner.retire(); }
});

test("event rows cover supported events and never expose session.shutdown", () => {
	const h = harness(); try {
		const labels = h.rows().map(label);
		assert.ok(labels.some(value => value.startsWith("agent.failed:")));
		assert.ok(labels.some(value => value.startsWith("subagent.timed_out:")));
		assert.ok(labels.some(value => value.startsWith("session.started:")));
		assert.ok(!labels.some(value => value.includes("session.shutdown")));
	} finally { h.owner.retire(); }
});

test("p on every basic non-event notification control stays on the audio card, opens no profiles and never previews", () => {
	const h = harness(); try {
		const rows = h.rows();
		const targets = ["Audio notifications:", "Audio: unmuted", "Advanced"];
		const listed: number[] = [];
		const view = new VisualCustomizeView({ rows, theme: { fg: (_role: string, text: string) => text }, rowsAvailable: () => 24, requestRender: () => {}, onClose: () => {}, profiles: {
			list: () => { listed.push(1); return []; }, save: () => {}, apply: () => {}, delete: () => {}, reset: () => {},
		} });
		for (const [i, target] of targets.entries()) {
			selectControl(view, target);
			assert.ok(view.render(76).join("\n").includes(`\u25b8 ${target}`), `non-event row ${i} (${target}) must be the selected control`);
			view.handleInput("p");
			const frame = view.render(76).join("\n");
			assert.equal(view.title(), "Audio notifications", `non-event row ${i} must keep the audio header`);
			assert.match(frame, /Audio notifications/, `non-event row ${i} must stay on the audio card`);
			assert.doesNotMatch(frame, /Visual profiles/, `non-event row ${i} must not open the profile pane`);
			assert.equal(h.played, 0, `non-event row ${i} must not autoplay audio`);
		}
		assert.deepEqual(listed, [], "the profile catalog must never be listed from Notifications controls");
	} finally { h.owner.retire(); }
});

test("the basic card exposes exactly six human controls and an Advanced toggle without raw ids", () => {
	const h = harness(); try {
		const labels = visibleRows(h.rows()).map(label);
		assert.equal(labels.length, 6, "the basic card must expose exactly six controls");
		assert.ok(labels.some(text => text.startsWith("Audio notifications:")), "the global switch row is required");
		assert.ok(labels.some(text => /^Audio: (?:un)?muted/.test(text)), "the process mute row is required");
		assert.ok(labels.some(text => text.startsWith("Success:")), "a Success group row is required");
		assert.ok(labels.some(text => text.startsWith("Error:")), "an Error group row is required");
		assert.ok(labels.some(text => text.startsWith("Attention:")), "an Attention group row is required");
		assert.ok(labels.some(text => /^Advanced/.test(text)), "an Advanced toggle row is required");
		assert.equal(labels.some(text => text.startsWith("Audio availability:")), false, "the availability row is removed");
		assert.equal(labels.some(text => text.startsWith("Audio: restore preset")), false, "the restore row is removed");
		for (const text of labels) {
			assert.doesNotMatch(text, /builtin:/, `a basic label leaks a builtin id: ${text}`);
			assert.doesNotMatch(text, /(?:agent|subagent|session)\./, `a basic label leaks a raw event id: ${text}`);
		}
	} finally { h.owner.retire(); }
});

test("default groups read as their unambiguous human tone", () => {
	const h = harness(); try {
		const rows = h.rows();
		assert.equal(label(findRow(rows, "Success:")), "Success: success tone");
		assert.equal(label(findRow(rows, "Error:")), "Error: error tone");
		assert.equal(label(findRow(rows, "Attention:")), "Attention: attention tone");
	} finally { h.owner.retire(); }
});

test("Advanced folds the thirteen detailed event rows inside the same card without writes, probes or playback", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const detail = () => visibleRows(rows).map(label).filter(text => /^(?:agent|subagent|session)\./.test(text));
		assert.equal(detail().length, 0, "detailed event rows stay folded by default");
		const toggle = findRow(rows, /^Advanced/);
		await toggle.action(fakeInline());
		assert.equal(detail().length, 13, "expanding reveals the thirteen detailed rows");
		await toggle.action(fakeInline());
		assert.equal(detail().length, 0, "collapsing folds them again");
		assert.equal(h.writes, 0); assert.equal(h.probes, 0); assert.equal(h.played, 0);
	} finally { h.owner.retire(); }
});

test("global controls and the fold toggle advertise no sound key while group and detail rows do", async () => {
	const h = harness(); try {
		const rows = h.rows();
		for (const prefix of ["Audio notifications:", "Audio: unmuted", "Advanced"])
			assert.doesNotMatch(keyhintOf(findRow(rows, prefix)), /f sound/, `${prefix} is not a per-type file target`);
		for (const { prefix } of GROUPS) assert.match(keyhintOf(findRow(rows, prefix)), /f sound/, `${prefix} assigns its own sound`);
		await findRow(rows, /^Advanced/).action(fakeInline());
		for (const prefix of ["agent.failed:", "agent.completed:"]) assert.match(keyhintOf(findRow(rows, prefix)), /f sound/);
	} finally { h.owner.retire(); }
});

test("a group edit writes exactly its target events and preserves every other override", async () => {
	const h = harness(); try {
		const rows = h.rows();
		await findRow(rows, "Success:").action(fakeInline());
		const events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.completed"], "builtin:error");
		assert.equal(events["subagent.completed"], "builtin:error");
		assert.equal(events["agent.failed"], "builtin:error", "error targets stay untouched");
		assert.equal(events["agent.attention"], "builtin:attention", "attention target stays untouched");
		assert.equal(events["subagent.waiting"], null, "unrelated events keep their value");
		assert.equal(h.writes, 1);
	} finally { h.owner.retire(); }
});

test("error and attention groups target verified events only and never add subagent.waiting", async () => {
	const h = harness({ events: { "agent.failed": "builtin:error", "subagent.failed": "builtin:error", "subagent.timed_out": "builtin:error", "agent.attention": "builtin:attention", "subagent.waiting": "builtin:error" } }); try {
		const rows = h.rows();
		await findRow(rows, "Error:").action(fakeInline());
		let events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.failed"], "builtin:attention");
		assert.equal(events["subagent.failed"], "builtin:attention");
		assert.equal(events["subagent.timed_out"], "builtin:attention");
		await findRow(rows, "Attention:").action(fakeInline());
		events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.attention"], null);
		assert.equal(events["subagent.waiting"], "builtin:error", "attention never silently includes subagent.waiting");
	} finally { h.owner.retire(); }
});

test("a group whose targets diverge reads Custom until an explicit Enter applies the recommended tone", async () => {
	const h = harness({ events: { "agent.completed": "builtin:success", "subagent.completed": null } }); try {
		const rows = h.rows();
		const success = findRow(rows, "Success:");
		assert.equal(label(success), "Success: Custom (varies)");
		assert.equal(h.writes, 0);
		await success.action(fakeInline());
		const events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.completed"], "builtin:success");
		assert.equal(events["subagent.completed"], "builtin:success");
		assert.equal(h.writes, 1);
	} finally { h.owner.retire(); }
});

test("an omitted group reads silence and its edit writes only its targets without merging the preset", async () => {
	const h = harness({ events: {} }); try {
		const rows = h.rows();
		const success = findRow(rows, "Success:");
		assert.equal(label(success), "Success: silence");
		await success.action(fakeInline());
		const events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.completed"], "builtin:success");
		assert.equal(events["subagent.completed"], "builtin:success");
		assert.equal(events["agent.failed"], undefined, "no preset merge adds untouched events");
		assert.equal(events["agent.attention"], undefined);
	} finally { h.owner.retire(); }
});

test("group p previews an unambiguous tone and mixed groups only point at Advanced without playback or writes", async () => {
	const h = harness(); try {
		const success = findRow(h.rows(), "Success:");
		assert.ok(success.key, "group rows handle their own p shortcut");
		assert.ok(await Promise.resolve(success.key!("p", fakeInline())), "p is consumed");
		await tick(); await tick();
		assert.equal(h.played, 1, "an unambiguous group previews its tone");
		assert.equal(h.writes, 0);
	} finally { h.owner.retire(); }
	const mixed = harness({ events: { "agent.completed": "builtin:success", "subagent.completed": null } }); try {
		const rows = mixed.rows();
		const success = findRow(rows, "Success:");
		assert.equal(label(success), "Success: Custom (varies)");
		success.key!("p", fakeInline());
		await tick(); await tick();
		assert.equal(mixed.played, 0, "a mixed group never plays an arbitrary tone");
		assert.equal(mixed.writes, 0);
		assert.equal(label(success), "Success: Custom (varies)", "rendering and p never normalize the mixed state");
	} finally { mixed.owner.retire(); }
});

test("Advanced expansion is ephemeral: rebuilding the card starts folded", async () => {
	const h = harness(); try {
		const first = h.rows();
		await findRow(first, /^Advanced/).action(fakeInline());
		assert.equal(visibleRows(first).map(label).filter(text => /^(?:agent|subagent|session)\./.test(text)).length, 13);
		const second = h.rows();
		assert.equal(visibleRows(second).map(label).filter(text => /^(?:agent|subagent|session)\./.test(text)).length, 0, "reopening folds the detailed rows");
	} finally { h.owner.retire(); }
});

test("collapsed detailed rows are unreachable and never open the WAV field through the shared card", async () => {
	const h = harness(); try {
		const rows = h.rows();
		let resolved = 0;
		getNotificationService()!.validateFile = async () => { resolved++; return true; };
		const view = customizeView(rows);
		view.render(76);
		view.handleInput("\x1b[C");
		for (let i = 0; i < 40; i++) {
			assert.doesNotMatch(view.render(76).join("\n"), /agent\.failed:/, "a folded event row must not be reachable");
			view.handleInput("f");
			view.handleInput("\x1b[B");
		}
		await tick(); await tick();
		assert.equal(resolved, 0, "f on folded rows never opens the WAV field");
		assert.equal(h.writes, 0);
	} finally { h.owner.retire(); }
});

for (const { prefix, fixture, targets } of GROUPS) {
	test(`${prefix} f assigns one validated WAV to all its targets in one atomic write`, async () => {
		const h = harness(); try {
			const rows = h.rows();
			const validated: string[] = [];
			getNotificationService()!.validateFile = async (_ctx, sound) => { validated.push(sound); return true; };
			const before = structuredClone(getNotificationService()!.getState().settings.audio.events);
			const pending = findRow(rows, prefix).key!("f", fakeInline([fixture]));
			assert.ok(pending, "the group f consumes the key as an async task");
			await Promise.resolve(pending);
			await tick(); await tick();
			assert.deepEqual(validated, [`file:${fixture}`], "the file is validated exactly once");
			const events = getNotificationService()!.getState().settings.audio.events;
			for (const target of targets) assert.equal(events[target as NotificationEvent], `file:${fixture}`, `${target} must take the group WAV`);
			for (const [key, value] of Object.entries(before)) {
				if ((targets as readonly string[]).includes(key)) continue;
				assert.deepEqual(events[key as NotificationEvent], value, `${key} must stay untouched`);
			}
			assert.equal(h.writes, 1, "one atomic write");
			assert.equal(getNotificationService()!.getState().settings.enabled, false, "enabled is preserved");
		} finally { h.owner.retire(); }
	});
}

test("group f keeps configuration silent when the file is invalid, cancelled, owner replaced or the card disposed", async () => {
	for (const mode of ["invalid", "cancel", "owner", "dispose"] as const) {
		const h = harness(); try {
			const rows = h.rows();
			const success = findRow(rows, "Success:");
			const inline: CustomizeInline = fakeInline([mode === "cancel" ? undefined : WAV_FIXTURES.success]);
			getNotificationService()!.validateFile = async () => {
				if (mode === "owner") h.owner.attach(h.ctx);
				if (mode === "dispose") inline.disposed = true;
				return mode !== "invalid";
			};
			await Promise.resolve(success.key!("f", inline));
			await tick(); await tick();
			assert.equal(h.writes, 0, `mode=${mode} must never write configuration`);
		} finally { h.owner.retire(); }
	}
});

test("a uniform file group shows the basename, prefills its path and previews that exact file", async () => {
	const file: `file:${string}` = `file:${WAV_FIXTURES.success}`;
	const h = harness({ events: { "agent.completed": file, "subagent.completed": file } }); try {
		const rows = h.rows();
		const success = findRow(rows, "Success:");
		assert.equal(label(success), `Success: ${basename(WAV_FIXTURES.success)}`);
		assert.doesNotMatch(label(success), /builtin:|file:|agent\.|subagent\./, "the main label stays human and raw-reference free");
		getNotificationService()!.validateFile = async () => true;
		const requests: string[] = [];
		const inline: CustomizeInline = { input: async request => { requests.push(request.value); return WAV_FIXTURES.success; }, confirm: async () => false, disposed: false };
		await Promise.resolve(success.key!("f", inline));
		await tick(); await tick();
		assert.deepEqual(requests, [WAV_FIXTURES.success], "the field is prefilled with the current file path");
		assert.equal(success.key!("p", fakeInline()), true);
		await tick(); await tick();
		assert.equal(h.played, 1, "p previews the group's exact file");
		assert.equal(h.writes, 1, "assigning the current file still validates and writes once");
	} finally { h.owner.retire(); }
});

test("a mixed group f overrides all its targets with one file and preserves other groups", async () => {
	const h = harness({ events: { "agent.completed": "builtin:success", "subagent.completed": null, "agent.failed": "builtin:error", "agent.attention": "builtin:attention" } }); try {
		const rows = h.rows();
		getNotificationService()!.validateFile = async () => true;
		await Promise.resolve(findRow(rows, "Success:").key!("f", fakeInline([WAV_FIXTURES.attention])));
		await tick(); await tick();
		const events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.completed"], `file:${WAV_FIXTURES.attention}`);
		assert.equal(events["subagent.completed"], `file:${WAV_FIXTURES.attention}`);
		assert.equal(events["agent.failed"], "builtin:error", "other groups stay stable");
		assert.equal(events["agent.attention"], "builtin:attention");
		assert.equal(h.writes, 1);
	} finally { h.owner.retire(); }
});

test("group targets never intersect unsupported siblings such as subagent.waiting", async () => {
	const h = harness({ events: { "agent.attention": "builtin:attention", "subagent.waiting": "builtin:error" } }); try {
		const rows = h.rows();
		getNotificationService()!.validateFile = async () => true;
		await Promise.resolve(findRow(rows, "Attention:").key!("f", fakeInline([WAV_FIXTURES.attention])));
		await tick(); await tick();
		const events = getNotificationService()!.getState().settings.audio.events;
		assert.equal(events["agent.attention"], `file:${WAV_FIXTURES.attention}`);
		assert.equal(events["subagent.waiting"], "builtin:error", "the attention group never intersects subagent.waiting");
	} finally { h.owner.retire(); }
});

test("the rendered basic card shows three independent group choices and hides per-event rows until Advanced", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const view = customizeView(rows);
		view.render(76);
		view.handleInput("\x1b[C");
		const frame = () => view.render(76).join("\n");
		for (const { prefix } of GROUPS) assert.match(frame(), new RegExp(prefix), `${prefix} must be visible on the basic card`);
		assert.doesNotMatch(frame(), /agent\.failed:/, "no per-event technical row is visible before Advanced");
		selectControl(view, "Success:");
		assert.match(frame(), /f sound/, "the selected group advertises its own file key");
		selectControl(view, "Advanced:");
		view.handleInput("\r");
		await tick();
		assert.match(frame(), /agent\.failed:/, "Advanced reveals the per-event exceptions");
	} finally { h.owner.retire(); }
});

for (const { prefix, fixture, targets } of GROUPS) {
	test(`the selected ${prefix.slice(0, -1)} basic preview is human with no builtin:, file: refs or raw event ids`, async () => {
		const builtin = harness(); try {
			const view = customizeView(builtin.rows());
			selectControl(view, prefix);
			const frame = view.render(90).join("\n");
			assert.match(frame, new RegExp(`${prefix} ${GROUP_TONE[prefix]}`), "the friendly tone label must be visible in the body");
			assert.doesNotMatch(frame, /builtin:/, "the basic body/preview must not leak a builtin id");
			assert.doesNotMatch(frame, /file:/, "the basic body/preview must not leak a raw file ref");
			assert.doesNotMatch(frame, /(?:agent|subagent|session)\./, "the basic body/preview must not leak a raw event id");
		} finally { builtin.owner.retire(); }

		const own = harness({ events: groupEvents(targets, `file:${fixture}`) }); try {
			const name = basename(fixture);
			const view = customizeView(own.rows());
			selectControl(view, prefix);
			const frame = view.render(90).join("\n");
			assert.match(frame, new RegExp(`${prefix} ${name}`), "a uniform file group shows the friendly basename");
			assert.doesNotMatch(frame, /file:/, "the basic preview must not leak the file: ref");
			assert.doesNotMatch(frame, new RegExp(fixture.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the absolute path must not appear");
			assert.doesNotMatch(frame, /builtin:/);
			assert.doesNotMatch(frame, /(?:agent|subagent|session)\./);
		} finally { own.owner.retire(); }
	});
}

test("a mixed basic group preview reads Custom (varies) without raw references", async () => {
	const h = harness({ events: { "agent.completed": "builtin:success", "subagent.completed": null } }); try {
		const view = customizeView(h.rows());
		selectControl(view, "Success:");
		const frame = view.render(90).join("\n");
		assert.match(frame, /Success: Custom \(varies\)/, "the mixed label must be friendly");
		assert.doesNotMatch(frame, /builtin:/, "mixed preview must not pick or leak a builtin");
		assert.doesNotMatch(frame, /file:/, "mixed preview must not leak a raw file ref");
		assert.doesNotMatch(frame, /(?:agent|subagent|session)\./, "mixed preview must not leak raw event ids");
	} finally { h.owner.retire(); }
});

test("the Advanced per-event rows intentionally keep raw ids and builtin refs", async () => {
	const h = harness(); try {
		const rows = h.rows();
		const view = customizeView(rows);
		view.render(76);
		view.handleInput("\x1b[C");
		selectControl(view, "Advanced:");
		view.handleInput("\r");
		await tick();
		selectControl(view, "agent.failed:");
		const frame = view.render(90).join("\n");
		assert.match(frame, /agent\.failed: builtin:error/, "advanced details intentionally show the raw event id and builtin ref");
	} finally { h.owner.retire(); }
});
