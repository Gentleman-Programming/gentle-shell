import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BUILTIN_NOTIFICATION_IDS, isNotificationSound, type NotificationEvent, type NotificationSettings, type NotificationSound } from "./notification-policy.ts";
import { getNotificationService, notificationContextAllowed, type NotificationService } from "./notification-service.ts";

/**
 * Native dialogs, outside the transcript. No owner creation, commands or visual-store writes.
 * @deprecated Superseded by the direct rows in `lib/notification-customize.ts`; kept as an
 * unused test-covered fallback, not wired into `/gentle:customize` anymore.
 */
export async function openNotificationPanel(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || !notificationContextAllowed(ctx)) return;
	const fresh = (expected: NotificationService) => {
		const service = getNotificationService();
		return service === expected ? service : undefined;
	};
	const notify = (message: string, error = false) => ctx.ui.notify(message, error ? "warning" : "info");
	const chooseSound = async (expected: NotificationService): Promise<NotificationSound | undefined> => {
		const choice = await ctx.ui.select("Notification sound", ["Silence", ...BUILTIN_NOTIFICATION_IDS.map(id => `builtin:${id}`), "Local WAV file"]);
		if (!fresh(expected) || choice === undefined) return undefined;
		if (choice === "Silence") return null;
		if (choice !== "Local WAV file") return isNotificationSound(choice) ? choice : undefined;
		const path = await ctx.ui.input("Local WAV file", "Absolute path (no URLs or shell expansion)");
		const service = fresh(expected);
		if (!service || path === undefined) return undefined;
		const sound = `file:${path}` as const;
		if (!isNotificationSound(sound) || !await service.validateFile(ctx, sound)) {
			if (fresh(expected)) notify("Select a readable regular PCM WAV (≤2 MiB, ≤10 seconds); absolute local path only.", true);
			return undefined;
		}
		return fresh(expected) ? sound : undefined;
	};
	const save = async (expected: NotificationService, change?: (settings: NotificationSettings) => void) => {
		let service = fresh(expected);
		if (!service) return;
		const state = service.getState();
		let confirmRecovery = false;
		if (state.malformed || state.readError) {
			confirmRecovery = await ctx.ui.confirm("Replace invalid notification configuration?",
				"The existing configuration is invalid or unreadable. Replace it with these settings? Cancellation leaves it untouched.") === true;
			if (!confirmRecovery) return;
		}
		service = fresh(expected);
		if (!service) return;
		// Read again after all prompts: never overwrite another action with an old snapshot.
		const settings = service.getState().settings;
		change?.(settings);
		const saved = change ? service.setConfig(ctx, settings, { confirmRecovery }) : service.restorePreset(ctx, { confirmRecovery });
		notify(saved ? "Notification preferences saved." : "Notification preferences not saved; choose again to retry.", !saved);
	};
	while (true) {
		const service = getNotificationService();
		if (!service) return;
		const state = service.getState();
		const enable = state.settings.enabled ? "Disable audio" : "Enable audio";
		const mute = state.muted ? "Resume" : "Mute";
		const action = await ctx.ui.select(`Notifications · audio ${state.settings.enabled ? "on" : "off"} · ${state.muted ? "muted" : "unmuted"}`,
			[enable, "Assign sound", "Preview sound", mute, "Check availability", "Restore preset"]);
		if (!fresh(service) || action === undefined) return;
		try {
			if (action === enable) await save(service, settings => { settings.enabled = action === "Enable audio"; });
			else if (action === mute) fresh(service)?.setMuted(ctx, action === "Mute");
			else if (action === "Restore preset") await save(service);
			else if (action === "Check availability") {
				const result = await fresh(service)!.availability(ctx);
				if (fresh(service)) notify(`Notification audio backend: ${result}.`);
			} else if (action === "Preview sound") {
				const sound = await chooseSound(service);
				const current = fresh(service);
				if (current && sound !== undefined && sound !== null && !current.preview(ctx, sound)) notify("Preview unavailable or audio busy; try again.", true);
			} else if (action === "Assign sound") {
				const origins = [...new Set(service.getState().supportedEvents.map(event => event.split(".")[0]!))];
				const origin = await ctx.ui.select("Notification origin", origins);
				let current = fresh(service);
				if (!current || origin === undefined || !origins.includes(origin)) continue;
				const events = current.getState().supportedEvents.filter(event => event.startsWith(`${origin}.`));
				const event = await ctx.ui.select("Notification event", [...events]);
				current = fresh(service);
				if (!current || !events.includes(event as NotificationEvent)) continue;
				const sound = await chooseSound(service);
				if (sound !== undefined) await save(service, settings => { settings.audio.events[event as NotificationEvent] = sound; });
			}
		} catch {
			if (fresh(service)) notify("Notification action failed; no automatic retry.", true);
		}
		if (!fresh(service)) return;
	}
}
