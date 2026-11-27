// Mobile layout rules of the Gentle Tower web app, as pure functions so a
// node test can pin them without a browser (tests/tower-responsive.test.ts).
// The scene constants mirror web/tower/src/art.ts, which cannot be imported
// here because it touches `document` at module load; keep them in sync.

/** The scene's width in scene units; the building spans x 172..688 inside it. */
export const SCENE_W = 720;
/** One floor's height in scene units (art.ts FH). */
export const FH = 100;
/** The lobby strip under the floors (art.ts LOBBY_H). */
export const LOBBY_H = 66;
/** At or below this CSS width, or with a coarse pointer, panels become a bottom sheet. */
export const SHEET_MAX_WIDTH = 720;
/** The smallest floor tap target we accept, in CSS pixels. */
export const MIN_FLOOR_CSS = 44;
/** The collapsed bottom sheet (its tab row) reserve, in CSS pixels. */
export const SHEET_RESERVE = 72;

export interface BuildingFit {
	/** CSS pixels per scene unit; the canvas is displayed at SCENE_W * scale. */
	scale: number;
	/** One floor's height in CSS pixels; never below MIN_FLOOR_CSS. */
	floorHeight: number;
	/** The scene's full height in CSS pixels at this scale. */
	contentHeight: number;
}

/**
 * Fits the building to a viewport. At 720px and up this is exactly today's
 * desktop rule (scale never below 1); below it the building shrinks to the
 * width, with the floor height's 44px minimum taking precedence over fitting
 * (a sub-320px viewport crops the sky rather than the tap targets). The
 * content height follows the scene's own stacking: the lobby grows with the
 * floors and the sky fills the height it is given, so the page scrolls when
 * the floors do not fit the viewport.
 */
export function fitBuilding(width: number, height: number, floorCount: number): BuildingFit {
	const scale = width >= SCENE_W ? Math.max(1, width / SCENE_W) : Math.max(width / SCENE_W, MIN_FLOOR_CSS / FH);
	const floorHeight = FH * scale;
	const sceneUnits = Math.max(height / scale - 32 - LOBBY_H, 60 + floorCount * FH);
	return { scale, floorHeight, contentHeight: (sceneUnits + LOBBY_H + 32) * scale };
}

/** Whether the panels render as a bottom sheet: a narrow viewport or a touch screen. */
export function useBottomSheet(width: number, coarsePointer: boolean): boolean {
	return width <= SHEET_MAX_WIDTH || coarsePointer;
}

/** The height reserve for the collapsed sheet, for callers sizing the scene. */
export function sheetReserve(width: number, coarsePointer: boolean): number {
	return useBottomSheet(width, coarsePointer) ? SHEET_RESERVE : 0;
}

/** The two panels that share the bottom sheet's area: the task list and the intercom. */
export type SheetPanel = "tasks" | "talk";

/**
 * Which of the two shared panels keeps the bottom sheet: the one the user opened
 * last, and Talk when nothing was tracked (an explicit choice, so a resize into
 * sheet mode always leaves exactly one panel in the shared area).
 */
export function sheetWinner(last: SheetPanel | undefined): SheetPanel {
	return last ?? "talk";
}
