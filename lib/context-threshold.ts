/**
 * Fixed product threshold for the high-context warning. The latch lives outside
 * the notification and visual stores so both warnings share one episode.
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
	observe(percent: number | null | undefined): boolean {
		if (typeof percent !== "number" || !Number.isFinite(percent)) return false;
		if (percent < CONTEXT_HIGH_PERCENT) { this.high = false; return false; }
		if (this.high) return false;
		this.high = true;
		return true;
	}
	rearm(): void { this.high = false; }
}
