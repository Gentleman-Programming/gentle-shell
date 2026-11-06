// Shared across extension instances, including a cancelled process still exiting.
let busy = false;

/** One accepted attempt, never a queue. Defer resolver/process work beyond the
 * provider callback. Busy events are discarded rather than captured for later.
 * The transport must settle only after its process exits. Print-mode shutdown
 * may join the one accepted attempt for a bounded deadline; it never queues or
 * retries work. Every other disposal remains immediate.
 */
export class RuntimeMetricsAttempt {
	#closed = false;
	#scheduled?: ReturnType<typeof setImmediate>;
	#abort?: AbortController;
	#settled?: Promise<void>;
	#release?: () => void;
	offer(work: (signal: AbortSignal) => Promise<unknown>): boolean {
		if (this.#closed || busy) return false;
		busy = true;
		const abort = new AbortController();
		this.#abort = abort;
		let release!: () => void;
		const settled = new Promise<void>(resolve => { release = resolve; });
		this.#settled = settled;
		this.#release = release;
		this.#scheduled = setImmediate(() => {
			this.#scheduled = undefined;
			void (async () => {
				try { if (!abort.signal.aborted) await work(abort.signal); }
				catch { /* An attempt is always best effort; never retry or report. */ }
				finally {
					this.#abort = undefined;
					busy = false;
					if (this.#settled === settled) {
						this.#settled = undefined;
						this.#release = undefined;
					}
					release();
				}
			})();
		});
		return true;
	}
	/** Await only the already accepted attempt, up to the caller's deadline. */
	async waitForSettled(timeoutMs: number): Promise<void> {
		const settled = this.#settled;
		if (!settled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([settled, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#scheduled) {
			clearImmediate(this.#scheduled);
			this.#scheduled = undefined;
			busy = false;
			this.#settled = undefined;
			this.#release?.();
			this.#release = undefined;
		}
		this.#abort?.abort();
		this.#abort = undefined;
	}
}
