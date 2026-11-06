// Shared Agents overlay geometry. Rendering and pointer routing use one bounded
// measurement so terminal resizes cannot retain stale cells.

export const AGENTS_FALLBACK_WIDTH = 12;
export const AGENTS_SPLIT_LIST_MIN_WIDTH = 22;
export const AGENTS_SPLIT_THREAD_MIN_WIDTH = 32;
const FRAME_WIDTH = 6;
const LIST_MAX_WIDTH = 34;
const LIST_RATIO = 0.32;
const CHROME_ROWS = 3;

export type AgentsViewMode = "panes" | "narrow" | "fallback";

export interface AgentsViewLayout {
	mode: AgentsViewMode;
	width: number;
	height: number;
	bodyRows: number;
	footerY: number | undefined;
	listX: number;
	listWidth: number;
	threadX: number;
	threadWidth: number;
}

export function measureAgentsViewLayout(width: number, height: number, fullscreen = false): AgentsViewLayout {
	const boundedWidth = Math.max(0, Math.floor(width));
	const boundedHeight = Math.max(0, Math.floor(height));
	if (boundedWidth < AGENTS_FALLBACK_WIDTH || boundedHeight < CHROME_ROWS) {
		return { mode: "fallback", width: boundedWidth, height: boundedHeight, bodyRows: 0, footerY: undefined, listX: 0, listWidth: 0, threadX: 0, threadWidth: 0 };
	}
	const inner = boundedWidth - 2;
	if (fullscreen || boundedWidth < AGENTS_SPLIT_LIST_MIN_WIDTH + AGENTS_SPLIT_THREAD_MIN_WIDTH + FRAME_WIDTH) {
		const viewportWidth = Math.max(0, inner - 2);
		return { mode: "narrow", width: boundedWidth, height: boundedHeight, bodyRows: boundedHeight - CHROME_ROWS, footerY: boundedHeight - 2, listX: 2, listWidth: viewportWidth, threadX: 2, threadWidth: viewportWidth };
	}
	const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(AGENTS_SPLIT_LIST_MIN_WIDTH, Math.floor(inner * LIST_RATIO)));
	const threadWidth = inner - listWidth - 4;
	return { mode: "panes", width: boundedWidth, height: boundedHeight, bodyRows: boundedHeight - CHROME_ROWS, footerY: boundedHeight - 2, listX: 2, listWidth, threadX: listWidth + 5, threadWidth };
}
