// External-change detection for Desktop RPC's `telemetry_changed` event
// (Gentleman-Programming/gentle-shell#3586).
//
// gentle-ai owns telemetry state in `telemetry.json` inside its home directory
// (`GENTLE_AI_HOME`, else `~/.gentle-ai`). This module watches that directory
// with the shared debounced directory watcher and, once a window settles,
// re-reads the policy through the bridge (`telemetry policy --json` only,
// never `status`) and reports it only when the payload differs from the last
// one the Desktop saw. That baseline is what keeps the Desktop's own
// `set_telemetry` from echoing: its answer becomes the baseline, so the file
// change it caused re-reads to the same payload. It also drops gentle-ai's own
// heartbeat rewrites, which never move the policy. Nothing here fabricates a
// policy: a failed re-read emits nothing and keeps the old baseline.

import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	DesktopDirectoryWatcher,
	type DesktopChangeTimers,
	type DesktopDirectoryWatch,
} from "./desktop-rpc-config-watch.ts";
import { DESKTOP_TELEMETRY_EVENT } from "./desktop-rpc-telemetry.ts";
import { gentleAiProcessEnvironment } from "./native-review-cli.ts";

/** The file gentle-ai keeps its telemetry state in, inside its home directory. */
export const TELEMETRY_STATE_FILE = "telemetry.json";

/** Where the gentle-ai this extension runs keeps `telemetry.json`. */
export function telemetryStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
	// The same environment the bridge's own gentle-ai runs get, so a bundled
	// install watches its prefix's gentle-ai home and not the user's.
	const home = gentleAiProcessEnvironment(env).GENTLE_AI_HOME;
	return typeof home === "string" && home.length > 0 ? home : join(homedir(), ".gentle-ai");
}

/** Test seams; production uses `fs.watch`, real timers and the resolved directory. */
export interface DesktopTelemetryWatchOptions {
	stateDirectory?: () => string;
	watch?: DesktopDirectoryWatch;
	timers?: DesktopChangeTimers;
	exists?: (path: string) => boolean;
	debounceMs?: number;
}

export type DesktopTelemetryEmit = (event: string, data: Record<string, unknown>) => void;

/** One start()..stop() lifetime: read state is per generation so an obsolete read cannot swallow the current one's change. */
interface Generation {
	readonly watcher: DesktopDirectoryWatcher;
	reading: boolean;
	dirty: boolean;
	/** A window closed during an own write: read once the last write bracket closes. */
	pending: boolean;
}

export class DesktopTelemetryWatcher {
	private readonly options: DesktopTelemetryWatchOptions;
	private generation: Generation | undefined;
	private emit: DesktopTelemetryEmit | undefined;
	private read: (() => Promise<DesktopRpcOutcome>) | undefined;
	/** The last payload the Desktop was given, by a read, a set, or an event. */
	private known: string | undefined;
	private writes = 0;
	/** Bumped whenever the baseline moves, so a read that overlapped the move is retried. */
	private version = 0;

	constructor(options: DesktopTelemetryWatchOptions = {}) {
		this.options = options;
	}

	/** Whether an open watcher backs the event; only then is it advertised. */
	get wired(): boolean {
		return this.generation?.watcher.active === true;
	}

	/** Starts watching; a directory that cannot be watched leaves the event unwired. */
	start(read: () => Promise<DesktopRpcOutcome>, emit: DesktopTelemetryEmit): void {
		this.stop();
		try {
			const generation: Generation = {
				watcher: new DesktopDirectoryWatcher(() => void this.recompute(generation), {
					...(this.options.watch === undefined ? {} : { watch: this.options.watch }),
					...(this.options.timers === undefined ? {} : { timers: this.options.timers }),
					...(this.options.exists === undefined ? {} : { exists: this.options.exists }),
					...(this.options.debounceMs === undefined ? {} : { debounceMs: this.options.debounceMs }),
				}),
				reading: false,
				dirty: false,
				pending: false,
			};
			const watcher = generation.watcher;
			const dir = (this.options.stateDirectory ?? (() => telemetryStateDirectory()))();
			// A missing directory (fresh install) is watched through its nearest
			// existing ancestor until gentle-ai creates it.
			if (watcher.start([{ dir, names: [TELEMETRY_STATE_FILE] }]) === 0) {
				watcher.dispose();
				return;
			}
			this.generation = generation;
			this.read = read;
			this.emit = emit;
		} catch {
			/* best effort: the channel keeps working without the event */
		}
	}

	/** Session start/shutdown: the watcher, its timer and the baseline are torn down. */
	stop(): void {
		const watcher = this.generation?.watcher;
		this.generation = undefined;
		this.emit = undefined;
		this.read = undefined;
		this.known = undefined;
		this.writes = 0;
		this.version += 1;
		watcher?.dispose();
	}

	/** A payload answered to the Desktop (`get_telemetry`, `set_telemetry`) is already known. */
	observe(outcome: DesktopRpcOutcome): void {
		if (!outcome.ok) return;
		this.known = JSON.stringify(outcome.data);
		this.version += 1;
	}

	/** Brackets a `set_telemetry`: a re-read that lands mid-write is the write's, not an external change. */
	async own<T>(run: () => Promise<T>): Promise<T> {
		this.writes += 1;
		try {
			return await run();
		} finally {
			this.writes -= 1;
			// A window that closed during the write left its read pending: do it once now.
			const generation = this.generation;
			if (this.writes === 0 && generation?.pending) {
				generation.pending = false;
				void this.recompute(generation);
			}
		}
	}

	private async recompute(generation: Generation): Promise<void> {
		if (generation !== this.generation) return;
		if (this.writes > 0) {
			generation.pending = true;
			return;
		}
		if (generation.reading) {
			generation.dirty = true;
			return;
		}
		generation.reading = true;
		try {
			do {
				generation.dirty = false;
				await this.report(generation);
			} while (generation.dirty && generation === this.generation);
		} finally {
			generation.reading = false;
		}
	}

	private async report(generation: Generation): Promise<void> {
		const read = this.read;
		if (!read) return;
		const version = this.version;
		let outcome: DesktopRpcOutcome;
		try {
			outcome = await read();
		} catch {
			return;
		}
		// Torn down, or an own write settled while this read ran: not an event.
		if (generation !== this.generation || !outcome.ok) return;
		// A write in flight owns this read (its answer becomes the baseline);
		// read again once its bracket closes.
		if (this.writes > 0) {
			generation.pending = true;
			return;
		}
		if (version !== this.version) {
			// A Desktop answer landed while this read ran: read again against it.
			generation.dirty = true;
			return;
		}
		const payload = JSON.stringify(outcome.data);
		if (payload === this.known) return;
		this.known = payload;
		try {
			this.emit?.(DESKTOP_TELEMETRY_EVENT, outcome.data as Record<string, unknown>);
		} catch {
			/* a closed transport never throws back into a watcher */
		}
	}
}
