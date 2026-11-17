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
import { basename } from "node:path";

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
 * cannot be watched; the caller treats a throw as "no watcher here".
 */
export type DesktopDirectoryWatch = (dir: string, onChange: (filename: string | undefined) => void) => () => void;

/**
 * `fs.watch` on a directory, non-persistent; a runtime error closes it silently.
 *
 * When the watched directory itself is removed, Windows keeps reporting events
 * for it indefinitely, which keeps the process alive and never reaches the
 * `error` path. A watcher whose directory is gone is therefore closed on its
 * next event: that directory produces no further external events this session.
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
			onChange(undefined);
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
}

/**
 * Watches the given owner directories and calls `onChange` once per debounce
 * window after any relevant entry changed. Entries are filtered by name, so an
 * unrelated file in a shared directory (a repository's `.pi/`) does not trigger
 * a recompute; an event without a name is always relevant, because some
 * platforms never report one.
 */
export class DesktopDirectoryWatcher {
	private readonly watch: DesktopDirectoryWatch;
	private readonly debouncer: DesktopDebouncer;
	private closers: Array<() => void> = [];
	private disposed = false;

	constructor(onChange: () => void, options: DesktopDirectoryWatcherOptions = {}) {
		this.watch = options.watch ?? watchDesktopDirectory;
		this.debouncer = createDesktopDebouncer(
			options.timers ?? realDesktopChangeTimers,
			options.debounceMs ?? DESKTOP_CHANGE_DEBOUNCE_MS,
			onChange,
		);
	}

	/** Starts every watcher it can; answers how many directories are watched. */
	start(targets: readonly DesktopWatchTarget[]): number {
		if (this.disposed) return 0;
		const byDir = new Map<string, Set<string>>();
		for (const target of targets) {
			const names = byDir.get(target.dir) ?? new Set<string>();
			for (const name of target.names) names.add(name);
			byDir.set(target.dir, names);
		}
		for (const [dir, names] of byDir) {
			try {
				const close = this.watch(dir, (filename) => {
					if (this.disposed) return;
					if (filename !== undefined && !names.has(filename)) return;
					this.debouncer.schedule();
				});
				if (this.disposed) {
					safeClose(close);
					continue;
				}
				this.closers.push(close);
			} catch {
				/* best effort: this directory simply produces no external events */
			}
		}
		return this.closers.length;
	}

	dispose(): void {
		this.disposed = true;
		this.debouncer.cancel();
		const closers = this.closers;
		this.closers = [];
		for (const close of closers) safeClose(close);
	}
}

function safeClose(close: () => void): void {
	try {
		close();
	} catch {
		/* already closed */
	}
}
