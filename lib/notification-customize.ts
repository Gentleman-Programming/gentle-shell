import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_NOTIFICATION_IDS, NOTIFICATION_EVENTS,
	type NotificationEvent, type NotificationSettings, type NotificationSound,
} from "./notification-policy.ts";
import { getNotificationService, type NotificationService } from "./notification-service.ts";
import type { CustomizeInline, CustomizeRow } from "./visual-customize-view.ts";

/** Silence first, then the builtins; Enter wraps back to silence. Priority is the event's, not the sound's. */
const SOUND_CYCLE: readonly NotificationSound[] = [null, ...BUILTIN_NOTIFICATION_IDS.map(id => `builtin:${id}` as const)];
/** Human labels for the builtin tones; the basic card never prints a `builtin:` id. */
const HUMAN_TONES: Readonly<Record<string, string>> = Object.freeze({
	"builtin:success": "success tone",
	"builtin:error": "error tone",
	"builtin:attention": "attention tone",
});
/** Footer hint shared by every row that can assign its own sound (basic groups and per-event exceptions). */
const SOUND_ROW_HINT = "Tab panes · Enter change · f sound · p test · Esc close";

interface GroupPlan {
	name: string;
	recommended: `builtin:${typeof BUILTIN_NOTIFICATION_IDS[number]}`;
	targets: readonly NotificationEvent[];
}
/** Fixed, verified targets per basic type. Attention never intersects `subagent.waiting`. */
const GROUP_PLANS: readonly GroupPlan[] = [
	{ name: "Success", recommended: "builtin:success", targets: ["agent.completed", "subagent.completed"] },
	{ name: "Error", recommended: "builtin:error", targets: ["agent.failed", "subagent.failed", "subagent.timed_out"] },
	{ name: "Attention", recommended: "builtin:attention", targets: ["agent.attention"] },
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
	rows.push({
		category,
		label: () => { const current = state(); return `Audio notifications: ${current ? (current.settings.enabled ? "on" : "off") : "unavailable"}`; },
		preview: () => {
			const current = state();
			return { title: "Audio notifications · global switch",
				sample: current ? `opt-in audio · ${current.settings.enabled ? "enabled" : "disabled"} · mute: ${current.muted ? "on" : "off"} · separate from visual settings` : "Unavailable in this session" };
		},
		action: async inline => {
			const service = serviceOrNotify();
			if (!service) return;
			const enabled = !service.getState().settings.enabled;
			await mutate(inline, settings => { settings.enabled = enabled; });
		},
	});
	rows.push({
		category,
		label: () => { const current = state(); return `Audio: ${current ? (current.muted ? "muted" : "unmuted") : "unavailable"}`; },
		preview: () => ({ title: "Audio · process mute", sample: "mute survives reload and session replacement; restarting Pi clears it; muted or disabled events are never replayed" }),
		action: () => {
			const service = serviceOrNotify();
			if (!service) return;
			if (!service.setMuted(ctx, !service.getState().muted)) notify("Audio mute could not be changed.", true);
		},
	});
	for (const group of GROUP_PLANS) {
		rows.push({
			category,
			keyhint: SOUND_ROW_HINT,
			label: () => { const current = state(); return current ? `${group.name}: ${groupSelectionLabel(current.settings, group)}` : `${group.name}: unavailable`; },
			preview: () => {
				const current = state();
				if (!current) return { title: `${group.name} sounds`, sample: "Unavailable in this session" };
				const selection = groupSelection(current.settings, group);
				const detail = selection.kind === "mixed" ? `mixes several sounds across ${group.targets.length} events · expand Advanced for per-event exceptions`
					: selection.sound === null ? "silence · Enter cycles tone or assign your own sound with f"
					: selection.sound.startsWith("builtin:") ? `${selectionLabel(selection.sound)} · builtin tone · f assigns your own sound`
					: `${selectionLabel(selection.sound)} (own group file) · f replaces it`;
				return { title: `${group.name} sounds · applies to ${group.targets.length} event${group.targets.length === 1 ? "" : "s"}`, sample: `${detail} · p tests the selected sound` };
			},
			action: async inline => {
				const service = serviceOrNotify();
				if (!service) return;
				const selection = groupSelection(service.getState().settings, group);
				const next = selection.kind === "mixed" ? group.recommended
					: SOUND_CYCLE[(SOUND_CYCLE.indexOf(selection.sound) + 1) % SOUND_CYCLE.length]!;
				await setTargets(inline, group.targets, next);
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
					const service = getNotificationService();
					const selection = service ? groupSelection(service.getState().settings, group) : undefined;
					const prefill = selection?.kind === "uniform" && selection.sound !== null && selection.sound.startsWith("file:")
						? selection.sound.slice(5) : "";
					return chooseFileFor(inline, group.targets, prefill);
				}
				return false;
			},
		});
	}
	rows.push({
		category,
		label: () => `Advanced: ${advanced ? "hide" : "show"} per-event exceptions`,
		preview: () => ({ title: "Advanced · per-event exceptions", sample: advanced ? "hiding folds the per-event rows again; the basic type choices are unaffected" : "reveals one-off per-event overrides; the basic type choices stay independent" }),
		action: () => { advanced = !advanced; },
	});
	const events = getNotificationService()?.getState().supportedEvents
		?? NOTIFICATION_EVENTS.filter(event => event !== "session.shutdown");
	for (const event of events) {
		rows.push({
			category,
			visible: () => advanced,
			keyhint: SOUND_ROW_HINT,
			label: () => { const current = state(); const sound = current?.settings.audio.events[event] ?? null; return `${event}: ${sound === null ? "silence" : sound}`; },
			preview: () => {
				const sound = state()?.settings.audio.events[event] ?? null;
				return { title: `${event} · audio event`, sample: `selected: ${soundDescription(sound)} · Enter cycles silence/success/error/attention · f local sound · p test sound` };
			},
			action: async inline => {
				const service = serviceOrNotify();
				if (!service) return;
				const current = service.getState().settings.audio.events[event] ?? null;
				const index = SOUND_CYCLE.findIndex(candidate => candidate === current);
				const next = SOUND_CYCLE[(index + 1) % SOUND_CYCLE.length]!;
				await mutate(inline, settings => { settings.audio.events[event] = next; });
			},
			key: (data, inline) => {
				if (matchesKey(data, "p")) { previewSound(getNotificationService()?.getState().settings.audio.events[event] ?? null); return true; }
				// Return the field/validation promise so the view keeps the card busy until it settles.
				if (matchesKey(data, "f")) return chooseFileFor(inline, [event], "");
				return false;
			},
		});
	}
	return rows;
}
