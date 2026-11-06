import type { TUI } from "@earendil-works/pi-tui";

/**
 * Wrap an overlay's `done` callback so closing the overlay forces the terminal
 * to repaint the full cell buffer. Pi restores the editor behind a closed
 * overlay with an incremental diff render; a fullscreen overlay's stale cell
 * state can survive that pass — keys keep working while the screen stops
 * updating (field-reported as "selection keys are dead" after /gentle:agents
 * + Esc). `tui.requestRender(true)` resets the renderer's written-frame state
 * so the next paint rewrites EVERY cell to the terminal, clearing the ghost —
 * without rebuilding component rows, which on long sessions costs seconds of
 * full-transcript re-render (the reason plain `invalidate()` is avoided
 * here). `done(result)` runs first, so the overlay is fully torn down before
 * the forced paint is scheduled. Failures are swallowed: a dead terminal must
 * never break the close path.
 */
export function withOverlayRepaint<T>(tui: TUI, done: (result: T) => void): (result: T) => void {
	return (result: T): void => {
		done(result);
		try {
			tui.requestRender(true);
		} catch {
			/* best-effort repaint: never break the overlay close path */
		}
	};
}
