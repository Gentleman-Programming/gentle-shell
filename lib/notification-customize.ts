import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_NOTIFICATION_IDS, NOTIFICATION_EVENTS,
	type NotificationEvent, type NotificationSettings, type NotificationSound,
} from "./notification-policy.ts";
import { getNotificationService, type NotificationService } from "./notification-service.ts";
import type { CustomizeInline, CustomizeRow } from "./visual-customize-view.ts";

/** Inline sound options: silence, builtins, then custom. Priority belongs to the event. */
const SOUND_CYCLE: readonly NotificationSound[] = [null, ...BUILTIN_NOTIFICATION_IDS.map(id => `builtin:${id}` as const)];
/** Human labels for the builtin tones; the basic card never prints a `builtin:` id. */
const HUMAN_TONES: Readonly<Record<string, string>> = Object.freeze({
	"builtin:success": "success tone",
	"builtin:error": "error tone",
	"builtin:attention": "attention tone",
});
const CUSTOM_SOUND = "custom";
/** Footer hint shared by every row that can assign its own sound (basic groups and per-event exceptions). */
const SOUND_ROW_HINT = "←/→ choose · Enter apply · f sound · p test · Esc close";

interface GroupPlan {
	name: string;
	targets: readonly NotificationEvent[];
}
/** Fixed, verified targets per basic type. Attention never intersects `subagent.waiting`. */
const GROUP_PLANS: readonly GroupPlan[] = [
	{ name: "Success", targets: ["agent.completed", "subagent.completed"] },
	{ name: "Error", targets: ["agent.failed", "subagent.failed", "subagent.timed_out"] },
	{ name: "Attention", targets: ["agent.attention"] },
];

/** Human basename for a local audio reference; never leaks the absolute path or the `file:` prefix. */
function fileBasename(ref: NotificationSound): string {
	const path = ref !== null && ref.startsWith("file:") ? ref.slice(5) : "";
	return path.split(/[\\/]/).pop() || path;
}
/** Basic label for a uniform selection: human tone, silence or file basename. */
function selectionLabel(sound: NotificationSound): string {
	if (sound === null) return "silence";
	if (sound.startsWith("builtin:")) return HUMAN_TONES[sound] ?? "tone";
	return fileBasename(sound);
}
type GroupSelection = { kind: "uniform"; sound: NotificationSound } | { kind: "mixed" };
/** A group is uniform only when every target resolves to the identical reference; missing keys count as silence. */
function groupSelection(settings: NotificationSettings, group: GroupPlan): GroupSelection {
	const values = group.targets.map(target => settings.audio.events[target] ?? null);
	const first = values[0] ?? null;
	return values.every(value => value === first) ? { kind: "uniform", sound: first } : { kind: "mixed" };
}
function groupSelectionLabel(settings: NotificationSettings, group: GroupPlan): string {
	const selection = groupSelection(settings, group);
	return selection.kind === "mixed" ? "Custom (varies)" : selectionLabel(selection.sound);
}

/** Preview description for the Advanced per-event rows. */
function soundDescription(sound: NotificationSound): string {
	if (sound === null) return "silence";
	return sound.startsWith("builtin:") ? `${sound} · builtin tone` : `local sound ${fileBasename(sound)}`;
}

/**
 * Builds the Notifications category for the shared customize card. The basic
 * card exposes the global switch, process mute and three independent type
 * groups (Success/Error/Attention) that each own their included tone or a
 * local sound (WAV/OGG/FLAC), plus the `Advanced` toggle. Per-event exceptions stay folded
 * behind `Advanced`. Every label/preview is read-only, and every action
 * resolves the owner facade at action time: importing or rendering this module
 * never discovers a player, reads a file or writes settings. Rows use the
 * inline bridge instead of nested `ctx.ui.select/input/confirm` dialogs. The
 * service keeps `restorePreset`/`availability` as an internal contract, but the
 * card no longer surfaces them.
 */
export function buildNotificationRows(ctx: ExtensionContext): CustomizeRow[] {
	const category = "Notifications" as const;
	let advanced = false;
	const notify = (message: string, error = false): void => { ctx.ui.notify(message, error ? "warning" : "info"); };
	const serviceOrNotify = (): NotificationService | undefined => {
		const service = getNotificationService();
		if (!service) notify("Audio notifications are unavailable in this session.", true);
		return service;
	};
	const state = () => getNotificationService()?.getState();
	/** Recovery consent is per attempt, strictly boolean, and re-resolved after every prompt. */
	const withRecovery = async (inline: CustomizeInline, run: (service: NotificationService, confirmRecovery: boolean) => boolean): Promise<void> => {
		const initial = serviceOrNotify();
		if (!initial) return;
		let confirmRecovery = false;
		const resolution = initial.getState();
		if (resolution.malformed || resolution.readError) {
			confirmRecovery = await inline.confirm("Replace invalid audio configuration? The existing file is malformed or unreadable.");
			if (!confirmRecovery || inline.disposed) return;
		}
		const service = getNotificationService();
		if (!service || inline.disposed) return;
		const ok = run(service, confirmRecovery);
		notify(ok ? "Audio notification preferences saved." : "Audio notification preferences not saved; choose again to retry.", !ok);
	};
	const mutate = (inline: CustomizeInline, change: (settings: NotificationSettings) => void): Promise<void> =>
		withRecovery(inline, (service, confirmRecovery) => {
			const settings = structuredClone(service.getState().settings);
			change(settings);
			return service.setConfig(ctx, settings, { confirmRecovery });
		});
	/** One atomic write touching exactly `targets`; every other key (and `enabled`) is preserved. */
	const setTargets = (inline: CustomizeInline, targets: readonly NotificationEvent[], sound: NotificationSound): Promise<void> =>
		mutate(inline, settings => { for (const target of targets) settings.audio.events[target] = sound; });
	const previewSound = (sound: NotificationSound): void => {
		const service = serviceOrNotify();
		if (!service) return;
		if (sound === null) { notify("Silence has no sound to preview; assign one first."); return; }
		if (!service.preview(ctx, sound)) notify("Preview unavailable or audio busy; try again.", true);
	};
	/**
	 * The only place a local sound is read: shared by the three basic groups and the
	 * Advanced per-event rows. Reuses the service's validated `validateFile` (WAV/OGG/FLAC,
	 * ≤2 MiB, ≤10 s, no shell/URLs) and re-checks owner/disposal before the
	 * single atomic write. Returns the field task so the view keeps the card busy.
	 */
	const chooseFileFor = async (inline: CustomizeInline, targets: readonly NotificationEvent[], prefill: string): Promise<boolean> => {
		const expected = serviceOrNotify();
		if (!expected) return true;
		const path = await inline.input({ prompt: "Local audio path (WAV/OGG/FLAC, absolute, no URLs)", value: prefill });
		if (path === undefined) return true;
		const sound = `file:${path}` as const;
		if (getNotificationService() !== expected) return true;
		const valid = await expected.validateFile(ctx, sound);
		// A replaced owner, closed card or changed session invalidates the validated choice before any write.
		if (!valid || inline.disposed || getNotificationService() !== expected) {
			if (!inline.disposed && getNotificationService() === expected) notify("Select a readable local sound (WAV/OGG/FLAC, ≤2 MiB, ≤10 seconds); absolute local path only.", true);
			return true;
		}
		await setTargets(inline, targets, sound);
		return true;
	};

	const rows: CustomizeRow[] = [];
	const choices = <T>(row: Omit<CustomizeRow, "action" | "choice">, setting: string,
		options: readonly { value: T; label: string }[], read: () => T | undefined,
		apply: (value: T, inline: CustomizeInline) => unknown): void => {
		for (const option of options) rows.push({ ...row,
			choice: { setting, value: option.label, current: () => read() === option.value, applyOnMove: false },
			action: async inline => { await apply(option.value, inline); },
		});
	};
	const onOff = [{ value: false, label: "off" }, { value: true, label: "on" }];
	const sounds: { value: NotificationSound | typeof CUSTOM_SOUND; label: string }[] = [
		...SOUND_CYCLE.map(value => ({ value, label: selectionLabel(value) })), { value: CUSTOM_SOUND, label: "custom" },
	];
	const soundValue = (sound: NotificationSound): NotificationSound | typeof CUSTOM_SOUND => sound?.startsWith("file:") ? CUSTOM_SOUND : sound;
	choices({
		category,
		label: () => { const current = state(); return `Audio notifications: ${current ? (current.settings.enabled ? "on" : "off") : "unavailable"}`; },
		preview: () => {
			const current = state();
			return { title: "Audio notifications · global switch",
				sample: current ? `opt-in audio · ${current.settings.enabled ? "enabled" : "disabled"} · mute: ${current.muted ? "on" : "off"} · separate from visual settings` : "Unavailable in this session" };
		},
	}, "Enabled", onOff, () => state()?.settings.enabled,
		(enabled, inline) => mutate(inline, settings => { settings.enabled = enabled; }));
	choices({
		category,
		label: () => { const current = state(); return `Audio: ${current ? (current.muted ? "muted" : "unmuted") : "unavailable"}`; },
		preview: () => ({ title: "Audio · process mute", sample: "mute survives reload and session replacement; restarting Pi clears it; muted or disabled events are never replayed" }),
	}, "Mute", onOff, () => state()?.muted, muted => {
		const service = serviceOrNotify();
		if (service && !service.setMuted(ctx, muted)) notify("Audio mute could not be changed.", true);
	});
	for (const group of GROUP_PLANS) {
		choices({
			category,
			keyhint: SOUND_ROW_HINT,
			label: () => { const current = state(); return current ? `${group.name}: ${groupSelectionLabel(current.settings, group)}` : `${group.name}: unavailable`; },
			preview: () => {
				const current = state();
				if (!current) return { title: `${group.name} sounds`, sample: "Unavailable in this session" };
				const selection = groupSelection(current.settings, group);
				const detail = selection.kind === "mixed" ? `mixes several sounds across ${group.targets.length} events · expand Advanced for per-event exceptions`
					: selection.sound === null ? "silence · choose a tone or assign your own sound with f"
					: selection.sound.startsWith("builtin:") ? `${selectionLabel(selection.sound)} · builtin tone · f assigns your own sound`
					: `${selectionLabel(selection.sound)} (own group file) · f replaces it`;
				return { title: `${group.name} sounds · applies to ${group.targets.length} event${group.targets.length === 1 ? "" : "s"}`, sample: `${group.name}: ${groupSelectionLabel(current.settings, group)} · ${detail} · p tests the configured sound` };
			},
			key: (data, inline) => {
				if (matchesKey(data, "p")) {
					const service = getNotificationService();
					if (!service) return true;
					const selection = groupSelection(service.getState().settings, group);
					if (selection.kind === "mixed") notify("This group mixes sounds; expand Advanced to review per-event exceptions.");
					else previewSound(selection.sound);
					return true;
				}
				if (matchesKey(data, "f")) {
					const current = state();
					const selection = current ? groupSelection(current.settings, group) : undefined;
					return chooseFileFor(inline, group.targets, selection?.kind === "uniform" && selection.sound?.startsWith("file:") ? selection.sound.slice(5) : "");
				}
				return false;
			},
		}, group.name, sounds, () => {
			const current = state();
			if (!current) return undefined;
			const selection = groupSelection(current.settings, group);
			return selection.kind === "mixed" ? CUSTOM_SOUND : soundValue(selection.sound);
		}, (sound, inline) => {
			if (sound !== CUSTOM_SOUND) return setTargets(inline, group.targets, sound);
			const current = state();
			const selection = current ? groupSelection(current.settings, group) : undefined;
			return chooseFileFor(inline, group.targets, selection?.kind === "uniform" && selection.sound?.startsWith("file:") ? selection.sound.slice(5) : "");
		});
	}
	choices({
		category,
		label: () => `Advanced: ${advanced ? "hide" : "show"} per-event exceptions`,
		preview: () => ({ title: "Advanced · per-event exceptions", sample: advanced ? "hiding folds the per-event rows again; the basic type choices are unaffected" : "reveals one-off per-event overrides; the basic type choices stay independent" }),
	}, "Advanced", [{ value: false, label: "hidden" }, { value: true, label: "shown" }], () => advanced, value => { advanced = value; });
	const events = getNotificationService()?.getState().supportedEvents
		?? NOTIFICATION_EVENTS.filter(event => event !== "session.shutdown");
	for (const event of events) {
		choices({
			category,
			visible: () => advanced,
			keyhint: SOUND_ROW_HINT,
			label: () => { const current = state(); const sound = current?.settings.audio.events[event] ?? null; return `${event}: ${sound === null ? "silence" : sound}`; },
			preview: () => {
				const sound = state()?.settings.audio.events[event] ?? null;
				return { title: `${event} · audio event`, sample: `${event}: ${sound === null ? "silence" : sound} · ${soundDescription(sound)} · Enter applies the chosen option · f local sound · p test sound` };
			},
			key: (data, inline) => {
				if (matchesKey(data, "p")) { previewSound(getNotificationService()?.getState().settings.audio.events[event] ?? null); return true; }
				if (matchesKey(data, "f")) return chooseFileFor(inline, [event], "");
				return false;
			},
		}, event, sounds, () => { const current = state(); return current ? soundValue(current.settings.audio.events[event] ?? null) : undefined; },
			(sound, inline) => sound === CUSTOM_SOUND ? chooseFileFor(inline, [event], "") : setTargets(inline, [event], sound));
	}
	return rows;
}
