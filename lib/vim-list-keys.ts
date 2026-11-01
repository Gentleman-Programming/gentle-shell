import { Key, matchesKey } from "@earendil-works/pi-tui";

/** A list-wide vim jump: gg, G, ctrl+d or ctrl+u. */
export type VimListAction = "first" | "last" | "halfDown" | "halfUp";

/**
 * The vim jump keys every list view shares: gg (first row), G (last row) and
 * ctrl+d/ctrl+u (half a page). One instance per view keeps the half-typed gg.
 * Every other key returns undefined, cancels a pending g and stays with the view.
 */
export class VimListKeys {
	private pendingG = false;

	action(data: string): VimListAction | "pending" | undefined {
		if (matchesKey(data, "g")) {
			this.pendingG = !this.pendingG;
			return this.pendingG ? "pending" : "first";
		}
		this.pendingG = false;
		if (matchesKey(data, "shift+g")) return "last";
		if (matchesKey(data, Key.ctrl("d"))) return "halfDown";
		if (matchesKey(data, Key.ctrl("u"))) return "halfUp";
		return undefined;
	}

	reset(): void {
		this.pendingG = false;
	}
}

/** The index an action lands on in a list of `length` rows paged by `page`. */
export function vimListIndex(action: VimListAction, index: number, length: number, page: number): number {
	const half = Math.max(1, Math.floor(page / 2));
	const target = action === "first" ? 0 : action === "last" ? length - 1 : index + (action === "halfDown" ? half : -half);
	return Math.max(0, Math.min(length - 1, target));
}
