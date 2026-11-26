/**
 * Fallback percentage when auto-compaction is off or its threshold is unknown.
 * The latch lives outside the stores so both warnings share one episode.
 */
export const CONTEXT_HIGH_PERCENT = 90;

/**
 * One warning per high episode. `observe` returns true exactly once while usage
 * stays at or above the threshold; a finite reading below it rearms the latch.
 * An unknown reading (`null`, which Pi reports right after a successful
 * compaction until the next assistant response) preserves the latch so the same
 * episode cannot warn twice. A successful compaction or a new session calls
 * `rearm` explicitly; a canceled or failed compaction must not, because the
 * context was never reduced.
 */
export class ContextHighLatch {
	private high = false;
	observe(reading: number | null | undefined, threshold = CONTEXT_HIGH_PERCENT): boolean {
		if (typeof reading !== "number" || !Number.isFinite(reading)) return false;
		if (reading < threshold) { this.high = false; return false; }
		if (this.high) return false;
		this.high = true;
		return true;
	}
	rearm(): void { this.high = false; }
}
