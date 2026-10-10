import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NotificationPlayer, validateNotificationAudio } from "./notification-audio.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
	DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_EVENTS, isNotificationSettings, isNotificationSound,
	resolveNotificationSettings, restoreNotificationPreset, writeNotificationSettings,
	type NotificationOptions, type NotificationResolution, type NotificationSettings, type NotificationSound,
} from "./notification-policy.ts";
import { NotificationScheduler, type NotificationOccurrence, type SchedulerOptions } from "./notification-scheduler.ts";

export interface NotificationServiceDependencies {
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	policy?: NotificationOptions;
	read?: () => NotificationResolution;
	write?: (settings: NotificationSettings) => string;
	backend?: Pick<NotificationPlayer, "play" | "availability" | "capabilities">;
	setTimeout?: SchedulerOptions["setTimeout"];
	clearTimeout?: SchedulerOptions["clearTimeout"];
}
export interface NotificationState extends NotificationResolution {
	muted: boolean;
	supportedEvents: readonly NotificationOccurrence["event"][];
}
/** UI consumers only retrieve this facade. They never claim a lease or subscribe to events. */
export interface NotificationService {
	getState(): NotificationState;
	setConfig(ctx: ExtensionContext, settings: NotificationSettings, options?: { confirmRecovery?: boolean }): boolean;
	restorePreset(ctx: ExtensionContext, options?: { confirmRecovery?: boolean }): boolean;
	setMuted(ctx: ExtensionContext, muted: boolean): boolean;
	preview(ctx: ExtensionContext, sound: Exclude<NotificationSound, null>): boolean;
	availability(ctx: ExtensionContext): Promise<"available" | "unavailable">;
	/** Selection-time validation only; never discovers or starts a player. */
	validateFile(ctx: ExtensionContext, sound: `file:${string}`): Promise<boolean>;
}
interface Holder {
	muted: boolean;
	epoch: number;
	ownerLease?: symbol;
	retire?: () => void;
	service?: NotificationService;
	startupNotified: boolean;
	sourceSession?: string;
	highwater: Map<string, number>;
	/** A retired scheduler's backend must settle before any replacement can play. */
	playback?: object;
}
const HOLDER = Symbol.for("gentle-pi.notification-service.v1");
function holder(): Holder {
	const root = globalThis as typeof globalThis & { [HOLDER]?: Holder };
	return root[HOLDER] ??= { muted: false, epoch: 0, startupNotified: false, highwater: new Map() };
}
export function getNotificationService(): NotificationService | undefined { return holder().service; }
export function notificationContextAllowed(ctx: ExtensionContext, env: NodeJS.ProcessEnv = process.env): boolean {
	// Dialog-capable interactive RPC is intentionally NOT an audio host.
	return ctx.mode === "tui" && env.GENTLE_PI_AGENTS_CHILD !== "1";
}

/** Owner-only claim; factory collision invalidates old hooks before the new owner attaches. */
export function claimNotificationOwner(retireRuntime: () => void, deps: NotificationServiceDependencies = {}) {
	const shared = holder(); shared.retire?.();
	const lease = Symbol("notification-owner"); const epoch = ++shared.epoch;
	shared.ownerLease = lease;
	const now = deps.now ?? (() => performance.now());
	const env = deps.env ?? process.env;
	const backend = deps.backend ?? new NotificationPlayer();
	let ctx: ExtensionContext | undefined; let sessionId: string | undefined;
	let scheduler: NotificationScheduler | undefined; let disposed = false; let attachment = 0;
	let resolution: NotificationResolution | undefined;
	const diagnostics = new Set<string>();
	const current = () => !disposed && shared.ownerLease === lease && shared.epoch === epoch;
	const allowed = (candidate?: ExtensionContext) => current() && !!ctx && !!candidate
		&& notificationContextAllowed(candidate, env) && notificationContextAllowed(ctx, env)
		&& candidate.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getSessionId() === sessionId;
	const report = (category: string, message: string) => {
		if (!allowed(ctx) || diagnostics.has(category)) return;
		diagnostics.add(category);
		try { ctx!.ui.notify(message, "warning"); } catch { /* Local diagnostics cannot fail a run. */ }
	};
	const read = () => {
		resolution = structuredClone((deps.read ?? (() => resolveNotificationSettings(deps.policy)))());
		if (resolution.malformed || resolution.readError) {
			resolution.settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS);
			report("config", "Notification configuration unavailable or invalid; audio disabled.");
		}
	};
	const makeScheduler = () => {
		scheduler = new NotificationScheduler({ now,
			// SAFETY: scheduler treats this handle as opaque; Node's Timeout is returned unchanged to clearTimeout.
			setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
			clearTimeout: deps.clearTimeout ?? (id => clearTimeout(id)),
			player: async (sound, signal, permit) => {
				if (!allowed(ctx) || shared.playback || signal.aborted) return;
				const reservation = {}; shared.playback = reservation;
				try {
					const available = await backend.availability();
					if (signal.aborted || !allowed(ctx)) return;
					if (available === "unavailable") { report("backend", "Notification audio backend unavailable."); return; }
					await backend.play(sound, signal, { start: () => allowed(ctx) && permit.start() });
				} finally { if (shared.playback === reservation) shared.playback = undefined; }
			},
			onError: () => report("playback", "Notification audio could not be played."),
		});
		scheduler.resetSession(sessionId!); scheduler.configure(resolution!.settings, shared.muted);
	};
	const shutdown = () => {
		scheduler?.dispose(); scheduler = undefined; ctx = undefined; sessionId = undefined;
		attachment++;
		if (shared.ownerLease === lease) shared.service = undefined;
	};
	const service: NotificationService = {
		getState: () => ({ ...structuredClone(resolution!), muted: shared.muted,
			// Quit cannot await lazy detection/playback without delaying cleanup/exit.
			supportedEvents: NOTIFICATION_EVENTS.filter(event => event !== "session.shutdown") }),
		setConfig: (candidate, settings, options = {}) => {
			if (!allowed(candidate) || !resolution || !isNotificationSettings(settings, deps.policy?.pathFlavor)
				|| ((resolution.malformed || resolution.readError) && options.confirmRecovery !== true)) return false;
			try {
				const snapshot = structuredClone(settings);
				const globalFile = (deps.write ?? (value => writeNotificationSettings(value, deps.policy)))(snapshot);
				// Invalidate even enabled->enabled changes: pending mappings must not become stale.
				scheduler?.dispose();
				resolution = { settings: snapshot, globalFile, source: "global_file", malformed: false, readError: false };
				makeScheduler(); return true;
			} catch { report("write", "Notification configuration could not be saved."); return false; }
		},
		restorePreset: (candidate, options) => service.setConfig(candidate, restoreNotificationPreset(resolution!.settings), options),
		setMuted: (candidate, muted) => {
			if (!allowed(candidate) || typeof muted !== "boolean") return false;
			shared.muted = muted; scheduler?.configure(resolution!.settings, muted); return true;
		},
		preview: (candidate, sound) => allowed(candidate) && !shared.playback && isNotificationSound(sound, deps.policy?.pathFlavor)
			&& sound !== null && !!scheduler?.preview(sound),
		validateFile: async (candidate, sound) => {
			if (!allowed(candidate) || !isNotificationSound(sound) || !sound.startsWith("file:")) return false;
			const activeScheduler = scheduler;
			try {
				const handle = await open(sound.slice(5), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const stat = await handle.stat();
					if (!stat.isFile() || stat.size < 44 || stat.size > 2 * 1024 * 1024) return false;
					const bytes = Buffer.alloc(stat.size + 1);
					const { bytesRead } = await handle.read(bytes);
					if (bytesRead !== stat.size) return false;
					const { format } = validateNotificationAudio(bytes.subarray(0, bytesRead));
					// Assignment-time rejection: a player that cannot play this container must never receive it.
					if (format !== "wav" && !(await backend.capabilities()).has(format)) return false;
					return allowed(candidate) && scheduler === activeScheduler;
				} finally { await handle.close(); }
			} catch { return false; }
		},
		availability: async candidate => {
			if (!allowed(candidate)) return "unavailable";
			const activeScheduler = scheduler;
			try {
				const result = await backend.availability();
				return allowed(candidate) && scheduler === activeScheduler ? result : "unavailable";
			} catch { return "unavailable"; }
		},
	};
	const bindService = (): NotificationService => {
		const generation = attachment;
		const live = () => generation === attachment && current();
		return {
			getState: service.getState,
			setConfig: (candidate, settings, options) => live() && service.setConfig(candidate, settings, options),
			restorePreset: (candidate, options) => live() && service.restorePreset(candidate, options),
			setMuted: (candidate, muted) => live() && service.setMuted(candidate, muted),
			preview: (candidate, sound) => live() && service.preview(candidate, sound),
			availability: candidate => live() ? service.availability(candidate) : Promise.resolve("unavailable"),
			validateFile: (candidate, sound) => live() ? service.validateFile(candidate, sound) : Promise.resolve(false),
		};
	};
	const retire = () => {
		if (disposed) return;
		shutdown(); disposed = true; retireRuntime();
		if (shared.ownerLease === lease) { shared.ownerLease = undefined; shared.retire = undefined; }
	};
	shared.retire = retire;
	return { now, current, allowed, shutdown, retire,
		acceptSource: (producerId: string, runId: string, sequence: number) => {
			if (!allowed(ctx)) return false;
			const key = JSON.stringify([producerId, runId]);
			if (sequence <= (shared.highwater.get(key) ?? 0)) return false;
			shared.highwater.set(key, sequence); return true;
		},
		attach: (candidate: ExtensionContext) => {
			if (!current()) return false;
			shutdown();
			if (!notificationContextAllowed(candidate, env)) return false;
			ctx = candidate; sessionId = candidate.sessionManager.getSessionId();
			if (shared.sourceSession !== sessionId) { shared.highwater.clear(); shared.sourceSession = sessionId; }
			read(); makeScheduler(); shared.service = bindService(); return true;
		},
		enqueue: (event: NotificationOccurrence) => allowed(ctx) && scheduler?.enqueue(event),
		startup: () => {
			if (!allowed(ctx) || shared.startupNotified) return false;
			shared.startupNotified = true; return true;
		},
	};
}
