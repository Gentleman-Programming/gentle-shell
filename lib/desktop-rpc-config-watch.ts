// Best-effort change detection for Desktop RPC's external-change events.
//
// Two pieces, both side-effect free until started and both safe to dispose
// twice: a trailing debouncer over injectable timers, and a directory watcher
// that turns "something in one of these owner directories changed" into one
// debounced callback. Neither ever throws into the caller: a directory that
// cannot be watched (missing, unsupported platform, watcher limits) is skipped,
// and a watcher that later errors is closed. Revisions stay the source of truth;
// this module only decides *when* to recompute them.

import { existsSync, watch as fsWatch } from "node:fs";
import { basename, dirname } from "node:path";

/** Debounce window shared by config and permission change detection. */
export const DESKTOP_CHANGE_DEBOUNCE_MS = 250;

export interface DesktopChangeTimers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export const realDesktopChangeTimers: DesktopChangeTimers = {
	set(fn, ms) {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return timer;
	},
	clear(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Watches one directory and calls `onChange` with the changed entry name when
 * the platform reports one. Answers a closer, or throws when the directory
 * cannot be watched; the caller treats a throw as "no watcher here". When the
 * directory itself disappears the watcher closes itself and calls `onChange`
 * one last time with `removed: true`, so the caller can watch for its return.
 */
export type DesktopDirectoryWatch = (
	dir: string,
	onChange: (filename: string | undefined, removed?: boolean) => void,
) => () => void;

/**
 * `fs.watch` on a directory, non-persistent; a runtime error closes it silently.
 *
 * When the watched directory itself is removed, Windows keeps reporting events
 * for it indefinitely, which keeps the process alive and never reaches the
 * `error` path. A watcher whose directory is gone is therefore closed on its
 * next event and reports `removed`; `DesktopDirectoryWatcher` then watches the
 * nearest existing ancestor until the directory comes back.
 */
export const watchDesktopDirectory: DesktopDirectoryWatch = (dir, onChange) => {
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		try {
			watcher.close();
		} catch {
			/* already closed */
		}
	};
	const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
		if (closed) return;
		if (!existsSync(dir)) {
			close();
			onChange(undefined, true);
			return;
		}
		onChange(typeof filename === "string" && filename.length > 0 ? basename(filename) : undefined);
	});
	watcher.on("error", close);
	return close;
};

export interface DesktopDebouncer {
	/** (Re)starts the window; the callback runs once, `ms` after the last call. */
	schedule(): void;
	cancel(): void;
	/** Whether a window is open, i.e. a change is waiting for its recompute. */
	pending(): boolean;
}

export function createDesktopDebouncer(timers: DesktopChangeTimers, ms: number, run: () => void): DesktopDebouncer {
	let handle: unknown;
	let pending = false;
	const cancel = () => {
		if (!pending) return;
		pending = false;
		try {
			timers.clear(handle);
		} catch {
			/* timer already gone */
		}
		handle = undefined;
	};
	return {
		schedule() {
			cancel();
			pending = true;
			handle = timers.set(() => {
				if (!pending) return;
				pending = false;
				handle = undefined;
				try {
					run();
				} catch {
					/* change detection never throws into a timer */
				}
			}, ms);
		},
		cancel,
		pending: () => pending,
	};
}

/** One owner directory and the entry names in it that belong to a store. */
export interface DesktopWatchTarget {
	dir: string;
	names: readonly string[];
}

export interface DesktopDirectoryWatcherOptions {
	watch?: DesktopDirectoryWatch;
	timers?: DesktopChangeTimers;
	debounceMs?: number;
	/** Directory existence check; injectable so tests can use abstract paths. */
	exists?: (path: string) => boolean;
}

/**
 * Watches the given owner directories and calls `onChange` once per debounce
 * window after any relevant entry changed. Entries are filtered by name, so an
 * unrelated file in a shared directory (a repository's `.pi/`) does not trigger
 * a recompute; an event without a name is always relevant, because some
 * platforms never report one.
 *
 * A target directory that does not exist yet (a project without `.pi/`, a fresh
 * `<git common dir>/gentle-ai/`) is watched through its nearest existing
 * ancestor, non-recursively, for the creation of the next path segment only.
 * When that segment appears, the ancestor watcher is closed and the target is
 * armed again one level closer, until the real directory is watched; each
 * upgrade schedules one recompute, because the owner file may already have been
 * written before the closer watcher existed. A watched directory that is later
 * removed falls back to the same ancestor watching, so its recreation is seen.
 */
export class DesktopDirectoryWatcher {
	private readonly watch: DesktopDirectoryWatch;
	private readonly exists: (path: string) => boolean;
	private readonly debouncer: DesktopDebouncer;
	private readonly closers = new Set<() => void>();
	private disposed = false;

	constructor(onChange: () => void, options: DesktopDirectoryWatcherOptions = {}) {
		this.watch = options.watch ?? watchDesktopDirectory;
		this.exists = options.exists ?? existsSync;
		this.debouncer = createDesktopDebouncer(
			options.timers ?? realDesktopChangeTimers,
			options.debounceMs ?? DESKTOP_CHANGE_DEBOUNCE_MS,
			onChange,
		);
	}

	/** Starts every watcher it can; answers how many watchers are open. */
	start(targets: readonly DesktopWatchTarget[]): number {
		if (this.disposed) return 0;
		const byDir = new Map<string, Set<string>>();
		for (const target of targets) {
			const names = byDir.get(target.dir) ?? new Set<string>();
			for (const name of target.names) names.add(name);
			byDir.set(target.dir, names);
		}
		for (const [dir, names] of byDir) this.arm(dir, names);
		return this.closers.size;
	}

	/** Whether a detected change is still waiting for its debounced recompute. */
	hasPending(): boolean {
		return !this.disposed && this.debouncer.pending();
	}

	dispose(): void {
		this.disposed = true;
		this.debouncer.cancel();
		const closers = [...this.closers];
		this.closers.clear();
		for (const close of closers) safeClose(close);
	}

	private arm(dir: string, names: ReadonlySet<string>): void {
		if (this.disposed) return;
		let present: boolean;
		try {
			present = this.exists(dir);
		} catch {
			present = false;
		}
		if (present) {
			const close = this.open(dir, (filename, removed) => {
				if (removed) {
					// The real watcher already closed itself; watch for the directory
					// to come back, and recompute: its stores just changed.
					if (close) this.release(close);
					this.arm(dir, names);
					this.debouncer.schedule();
					return;
				}
				if (filename !== undefined && !names.has(filename)) return;
				this.debouncer.schedule();
			});
			return;
		}
		const pending = this.nearestExisting(dir);
		if (!pending) return;
		let upgraded = false;
		const close = this.open(pending.ancestor, (filename) => {
			if (upgraded) return;
			if (filename !== undefined && filename !== basename(pending.next)) return;
			let created: boolean;
			try {
				created = this.exists(pending.next);
			} catch {
				created = false;
			}
			if (!created) return;
			upgraded = true;
			if (close) this.release(close);
			this.arm(dir, names);
			this.debouncer.schedule();
		});
	}

	/** The closest existing ancestor of `dir` and the missing child below it. */
	private nearestExisting(dir: string): { ancestor: string; next: string } | undefined {
		let next = dir;
		let ancestor = dirname(dir);
		while (ancestor !== next) {
			try {
				if (this.exists(ancestor)) return { ancestor, next };
			} catch {
				return undefined;
			}
			next = ancestor;
			ancestor = dirname(ancestor);
		}
		return undefined;
	}

	/** Opens one watcher, or none: a directory that cannot be watched is skipped. */
	private open(
		dir: string,
		onEvent: (filename: string | undefined, removed?: boolean) => void,
	): (() => void) | undefined {
		try {
			const close = this.watch(dir, (filename, removed) => {
				if (this.disposed) return;
				onEvent(filename, removed);
			});
			if (this.disposed) {
				safeClose(close);
				return undefined;
			}
			this.closers.add(close);
			return close;
		} catch {
			/* best effort: this directory simply produces no external events */
			return undefined;
		}
	}

	private release(close: () => void): void {
		this.closers.delete(close);
		safeClose(close);
	}
}

function safeClose(close: () => void): void {
	try {
		close();
	} catch {
		/* already closed */
	}
}
