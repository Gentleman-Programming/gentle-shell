import type { TUI } from "@earendil-works/pi-tui";

/**
 * Wrap an overlay's `done` callback so closing the overlay forces a FULL terminal
 * repaint. Pi restores the editor behind a closed overlay with an incremental
 * re-render; a fullscreen overlay's stale cell state can survive that pass — keys
 * keep working while the screen stops updating (field-reported as "selection keys
 * are dead" after /gentle:agents + Esc). `tui.invalidate()` drops the renderer's
 * cached frame; the follow-up requestRender repaints every cell. `done(result)`
 * runs first, so the overlay is fully torn down before the repaint is scheduled.
 * Paint failures are swallowed: a dead terminal must never break the close path.
 */
export function withOverlayRepaint<T>(tui: TUI, done: (result: T) => void): (result: T) => void {
	return (result: T): void => {
		done(result);
		try {
			tui.invalidate();
			tui.requestRender();
		} catch {
			/* best-effort repaint: never break the overlay close path */
		}
	};
}
