import type { EventBus } from "@earendil-works/pi-coding-agent";

/**
 * Shared event contract between fullscreen overlay menus and deferred dialogs.
 * Menus never import dialogs and dialogs never import menus: this channel is
 * the only coupling, so any future overlay menu defers asks for free.
 */
export const FULLSCREEN_ACTIVITY_EVENT = "gentle-pi:fullscreen-activity";

/** Publish side of the contract; `source` must be unique per menu instance. */
export interface FullscreenActivityEvent {
	active: boolean;
	source: string;
}

/**
 * `events` stays optional: production call sites pass `pi`, but profile flow
 * types only guarantee a bus-present `LiveSession` with `events` optional, and
 * test fixtures legitimately pass store-only instances. No bus means no
 * publishing — the menu keeps its native behavior and asks never defer.
 */
export interface FullscreenActivityEmitter {
	events?: EventBus;
}

/**
 * Validate one payload with the record guards consumers already use for
 * `gentle-pi:ask-user-*:blocked` events: malformed sources must never start or
 * release a wait.
 */
function asFullscreenActivityEvent(data: unknown): FullscreenActivityEvent | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const candidate = data as { active?: unknown; source?: unknown };
	if (typeof candidate.active !== "boolean") return undefined;
	if (typeof candidate.source !== "string" || candidate.source.length === 0) return undefined;
	return { active: candidate.active, source: candidate.source };
}

/** Publish one open (`active: true`) or close (`active: false`) transition. */
export function emitFullscreenActivity(emitter: FullscreenActivityEmitter, source: string, active: boolean): void {
	if (source.length === 0) return;
	emitter.events?.emit(FULLSCREEN_ACTIVITY_EVENT, { active, source });
}

/**
 * Emit the open around a fullscreen overlay menu interaction and the close in
 * every exit path (answer, cancel, error), so a thrown menu render never leaves
 * ask dialogs deferred forever.
 */
export async function withFullscreenOverlay<R>(
	emitter: FullscreenActivityEmitter,
	source: string,
	run: () => Promise<R>,
): Promise<R> {
	emitFullscreenActivity(emitter, source, true);
	try {
		return await run();
	}
	finally {
		emitFullscreenActivity(emitter, source, false);
	}
}

/**
 * Track open fullscreen overlay menus from the shared channel. The wait set is
 * a `Map<source, opens>`: duplicate opens of the same source must not deadlock
 * a wait that two close events would release.
 */
export class FullscreenActivityMonitor {
	private readonly openCounts = new Map<string, number>();
	private readonly waiters = new Set<() => void>();

	/** Subscribe once per extension from the shared bus. */
	attach(events: EventBus | undefined): void {
		events?.on?.(FULLSCREEN_ACTIVITY_EVENT, (data) => {
			const event = asFullscreenActivityEvent(data);
			if (event === undefined) return;
			if (event.active) {
				this.openCounts.set(event.source, (this.openCounts.get(event.source) ?? 0) + 1);
			}
			else {
				const remaining = (this.openCounts.get(event.source) ?? 0) - 1;
				if (remaining > 0) this.openCounts.set(event.source, remaining);
				else this.openCounts.delete(event.source);
			}
			if (this.openCounts.size === 0) {
				for (const waiter of [...this.waiters]) waiter();
				this.waiters.clear();
			}
		});
	}

	isActive(): boolean {
		return this.openCounts.size > 0;
	}

	/**
	 * Resolve when no fullscreen menu is open, waiting while activity runs, and
	 * report what ended the wait: dialogs mount on `released` and return their
	 * cancelled shape on `aborted` without ever reaching a fabricated mount.
	 *
	 * Menu activity appearing while the ask is already mounted is the accepted
	 * residual race; the defer covers the ask's entry, not continuous
	 * reconciliation.
	 */
	async waitIfActive(signal?: AbortSignal): Promise<"released" | "aborted"> {
		while (this.openCounts.size > 0) {
			if (signal?.aborted) return "aborted";
			let waitAborted = false;
			await new Promise<void>((resolve) => {
				if (this.openCounts.size === 0) {
					resolve();
					return;
				}
				this.waiters.add(resolve);
				if (signal !== undefined) {
					signal.addEventListener("abort", () => {
						waitAborted = true;
						resolve();
					}, { once: true });
				}
			});
			if (waitAborted) return "aborted";
		}
		return "released";
	}
}
