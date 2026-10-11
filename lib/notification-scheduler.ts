import {
	NOTIFICATION_PRIORITY, notificationSoundFor,
	type NotificationEvent, type NotificationSettings, type NotificationSound,
} from "./notification-policy.ts";

export const NOTIFICATION_TTL_MS = 2000;
export const NOTIFICATION_DEDUPE_CAPACITY = 256;
export interface NotificationOccurrence {
	sessionId: string;
	/** Run or task identity; sequence identifies the occurrence, not the state name. */
	runId: string;
	sequence: number;
	event: NotificationEvent;
	/** Same monotonic clock domain as SchedulerOptions.now. */
	occurredAt: number;
}
export interface PlaybackPermit {
	/** Backend MUST call once, synchronously immediately before spawn, after async detection/validation.
	 * false means do not spawn. Backend owns bounded playback timeout and must honor abort,
	 * settling only after its process stops. Resolving early violates serial playback. */
	start(): boolean;
}
export interface SchedulerOptions {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): number;
	clearTimeout(handle: number): void;
	player(sound: Exclude<NotificationSound, null>, signal: AbortSignal, permit: PlaybackPermit): Promise<void>;
	/** Local diagnostics only. Exceptions here are contained; at most one report per 5 seconds. */
	onError?(error: unknown): void;
	dedupeCapacity?: number;
}
interface Pending {
	sound: Exclude<NotificationSound, null>;
	priority: number;
	expiresAt: number;
	readyAt: number;
	/** Time spent waiting for started playback does not consume the remaining TTL. */
	pausedAt?: number;
}
interface Active {
	controller: AbortController;
	generation: number;
	started: boolean;
	expiryTimer?: number;
}
/** Owner supplies validated settings and TUI/parent guards (including preview). No IO or backend detection here. */
export class NotificationScheduler {
	private settings?: NotificationSettings;
	private muted = false;
	private sessionId?: string;
	private generation = 0;
	private disposed = false;
	private pending?: Pending;
	private active?: Active;
	private timer?: number;
	private lastStart = -Infinity;
	private lastError = -Infinity;
	private readonly seen = new Set<string>();
	private readonly capacity: number;
	private readonly options: SchedulerOptions;

	constructor(options: SchedulerOptions) {
		this.options = options;
		this.capacity = options.dedupeCapacity ?? NOTIFICATION_DEDUPE_CAPACITY;
		if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new RangeError("Invalid dedupe capacity");
	}
	configure(settings: NotificationSettings, muted: boolean): void {
		if (this.disposed) return;
		this.settings = structuredClone(settings); this.muted = muted;
		if (!settings.enabled || muted) this.invalidate();
		else this.schedule();
	}
	resetSession(sessionId: string): void {
		if (this.disposed || this.sessionId === sessionId) return;
		this.invalidate(); this.sessionId = sessionId; this.seen.clear();
	}
	/** Returns accepted-to-coalesce, NOT a promise of playback. Off/muted occurrences are consumed too.
	 * Selected sound is snapshotted here; priority always comes from the event, not the sound. */
	enqueue(occurrence: NotificationOccurrence): boolean {
		if (this.disposed || occurrence.sessionId !== this.sessionId) return false;
		const key = JSON.stringify([occurrence.sessionId, occurrence.runId, occurrence.sequence]);
		if (this.seen.has(key)) return false;
		this.seen.add(key);
		if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!);
		const now = this.options.now();
		const expiresAt = occurrence.occurredAt + NOTIFICATION_TTL_MS;
		if (!this.automaticEnabled() || !Number.isFinite(occurrence.occurredAt) || occurrence.occurredAt > now || now >= expiresAt) return false;
		const sound = notificationSoundFor(this.settings!, occurrence.event);
		if (sound === null) return false;
		if (this.pending && this.pending.pausedAt === undefined && now >= this.pending.expiresAt) this.pending = undefined;
		const priority = NOTIFICATION_PRIORITY[occurrence.event];
		if (this.pending && priority < this.pending.priority) return false;
		this.pending = { sound, priority, expiresAt,
			readyAt: this.pending?.readyAt ?? now + this.settings!.audio.coalesceWindowMs,
			pausedAt: this.active?.started ? now : undefined };
		this.schedule(); return true;
	}
	/** Explicit, bypasses enabled/mute only. Busy when active OR pending; never flushes autos.
	 * Preview starts count toward automatic minimum interval, but previews themselves are not throttled. */
	preview(sound: Exclude<NotificationSound, null>): boolean {
		if (this.disposed || this.active || this.pending) return false;
		this.play(sound); return true;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true; this.invalidate(); this.seen.clear();
	}
	private automaticEnabled(): boolean { return !!this.settings?.enabled && !this.muted && !this.disposed; }
	private clearTimer(): void {
		if (this.timer !== undefined) this.options.clearTimeout(this.timer);
		this.timer = undefined;
	}
	private invalidate(): void {
		this.generation++; this.pending = undefined; this.clearTimer();
		if (this.active) {
			this.active.controller.abort();
			if (this.active.expiryTimer !== undefined) this.options.clearTimeout(this.active.expiryTimer);
		}
		// Keep active reservation until backend settles, even after abort. Never overlap an uncooperative backend.
	}
	private schedule(): void {
		this.clearTimer();
		if (!this.pending || !this.automaticEnabled()) return;
		const now = this.options.now();
		if (this.pending.pausedAt !== undefined && !this.active?.started) {
			this.pending.expiresAt += now - this.pending.pausedAt;
			this.pending.pausedAt = undefined;
		}
		if (this.pending.pausedAt === undefined && now >= this.pending.expiresAt) { this.pending = undefined; return; }
		if (this.active?.started) {
			// Backend timeout bounds playback. Keep just one candidate, not an accumulating queue.
			this.pending.pausedAt ??= now;
			return;
		}
		const due = Math.max(this.pending.readyAt, this.lastStart + this.settings!.audio.minimumIntervalMs);
		if (!this.active && now >= due) {
			const pending = this.pending; this.pending = undefined;
			this.play(pending.sound, pending.expiresAt); return;
		}
		const wake = this.active ? this.pending.expiresAt : Math.min(due, this.pending.expiresAt);
		this.timer = this.options.setTimeout(() => { this.timer = undefined; this.schedule(); }, wake - now);
	}
	private play(sound: Exclude<NotificationSound, null>, expiresAt?: number): void {
		const active: Active = { controller: new AbortController(), generation: this.generation, started: false };
		this.active = active;
		const permit: PlaybackPermit = { start: () => {
			if (this.active !== active || active.started || active.controller.signal.aborted || this.disposed || active.generation !== this.generation
				|| (expiresAt !== undefined && (!this.automaticEnabled() || this.options.now() >= expiresAt))) return false;
			active.started = true; this.lastStart = this.options.now();
			if (active.expiryTimer !== undefined) this.options.clearTimeout(active.expiryTimer);
			this.schedule(); return true;
		} };
		if (expiresAt !== undefined) active.expiryTimer = this.options.setTimeout(() => {
			if (!active.started) active.controller.abort();
		}, expiresAt - this.options.now());
		// Calling synchronously also supports a player that throws before returning its promise.
		try { Promise.resolve(this.options.player(sound, active.controller.signal, permit))
			.then(() => this.finish(active), error => { this.report(error, active); this.finish(active); }); }
		catch (error) { this.report(error, active); this.finish(active); }
	}
	private report(error: unknown, active: Active): void {
		if (active.controller.signal.aborted || active.generation !== this.generation || this.disposed) return;
		const now = this.options.now();
		if (now - this.lastError < 5000) return;
		this.lastError = now;
		try { this.options.onError?.(error); } catch { /* Diagnostics must not produce unhandled rejections. */ }
	}
	private finish(active: Active): void {
		if (active.expiryTimer !== undefined) this.options.clearTimeout(active.expiryTimer);
		if (this.active === active) this.active = undefined;
		this.schedule();
	}
}
