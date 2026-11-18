/**
 * Keep one overlay of a kind on screen and let its opener toggle it.
 *
 * Mouse clicks outside an overlay still reach the layout behind it, so the
 * control that opened a panel (the header's `usage`, the editor's `[ Panel ]`)
 * stays clickable while the panel is up. Without a guard every click pushes
 * another identical overlay and each one needs its own Esc. Routing an opener
 * through one toggle closes the open panel on the next activation instead, so
 * there is never more than one and a single Esc always dismisses it.
 *
 * `show` receives `track(done, closeValue)`: wrap the overlay's `done` with it
 * and use the result on every close path. It forgets the open overlay
 * synchronously, before `done` runs, so an activation right after a close
 * opens a fresh one rather than reusing the settling promise. An activation
 * that arrives before the factory has run (no `done` tracked yet) reuses the
 * pending open. Once tracked, an activation closes it even if Pi has not shown
 * it yet: Pi's `custom` checks for an early `done` and then never mounts it.
 */
export type TrackClose = <T>(done: (value: T) => void, closeValue: T) => (value: T) => void;

export function singleOverlay(): <R>(show: (track: TrackClose) => Promise<R>) => Promise<R | undefined> {
	let active: { promise: Promise<unknown>; close?: () => void } | undefined;
	return <R>(show: (track: TrackClose) => Promise<R>): Promise<R | undefined> => {
		if (active) {
			const current = active;
			if (!current.close) return current.promise as Promise<R>;
			current.close();
			return Promise.resolve(undefined);
		}
		const entry: { promise: Promise<unknown>; close?: () => void } = { promise: Promise.resolve() };
		const track: TrackClose = (done, closeValue) => {
			let closed = false;
			const finish = (value: Parameters<typeof done>[0]) => {
				if (active === entry) active = undefined;
				if (closed) return;
				closed = true;
				done(value);
			};
			entry.close = () => finish(closeValue);
			return finish;
		};
		active = entry;
		let shown: Promise<R>;
		try {
			shown = show(track);
		} catch (error) {
			active = undefined;
			throw error;
		}
		const opened = shown.finally(() => {
			if (active === entry) active = undefined;
		});
		entry.promise = opened;
		return opened;
	};
}
