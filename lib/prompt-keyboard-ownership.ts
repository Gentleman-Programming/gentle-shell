import type { Component, TUI } from "@earendil-works/pi-tui";

// Keyboard ownership between an open overlay (the command palette) and the
// agent prompt that Pi mounts below it.
//
// Pi mounts an extension prompt in the editor slot and focuses the newest
// component, so a prompt that arrives while an overlay is open steals the
// keyboard from that overlay: arrow keys then move the invisible prompt
// selection under the palette instead of the visible palette selection. The
// overlay is the topmost visible UI, so it keeps the keyboard while it is
// open, and the prompt gets it back once the overlay closes.

/** The agent prompt currently waiting for an answer, if any. */
let pendingPrompt: Component | undefined;

/** Register the agent prompt that is mounted in the editor slot and waiting for an answer. */
export function setPendingAgentPrompt(component: Component | undefined): void {
	pendingPrompt = component;
}

/** The agent prompt currently waiting for an answer, if any. */
export function pendingAgentPrompt(): Component | undefined {
	return pendingPrompt;
}

/**
 * The focused component of a pi-tui screen. `getFocusedComponent()` is
 * implemented by every screen (TuiBase) but it is not part of the exported
 * `TUI` interface, so it is read through a narrow structural type instead of
 * a blanket cast.
 */
function focusedComponent(tui: TUI): Component | null {
	const screen = tui as TUI & { getFocusedComponent?: () => Component | null };
	return typeof screen.getFocusedComponent === "function" ? screen.getFocusedComponent() : null;
}

/**
 * Keep an open overlay as the keyboard owner while a pending agent prompt holds it.
 *
 * The listener runs before the TUI dispatches a key, so re-asserting the
 * overlay's focus here sends the key to the overlay that is actually visible
 * on top. The key is never consumed: the overlay still needs it.
 *
 * Returns a release function (unsubscribes the input listener).
 */
export function holdOverlayKeyboard(options: { tui: TUI; focusOverlay(): void }): () => void {
	return options.tui.addInputListener(() => {
		const prompt = pendingPrompt;
		if (!prompt) return undefined;
		// Only the pending agent prompt may take the keyboard away from the
		// overlay: any other focused component is the user's own business.
		if (focusedComponent(options.tui) !== prompt) return undefined;
		options.focusOverlay();
		return undefined;
	});
}

/** Hand the keyboard back to the pending agent prompt (after the overlay closed). */
export function restorePendingAgentPrompt(tui: TUI): void {
	const prompt = pendingPrompt;
	if (!prompt) return;
	// Hiding an overlay restores the focus it had before it opened, which is
	// stale by then; the prompt that waited below it gets the keyboard now.
	if (focusedComponent(tui) === prompt) return;
	tui.setFocus(prompt);
}
