import { visibleWidth } from "@earendil-works/pi-tui";
import type { ShellBarTheme } from "./shell-bar.ts";

export function renderSidebarBanner(theme: ShellBarTheme, width: number): string[] {
	const label = "◆ Drakonc Shell ◆";
	const space = width - visibleWidth(label);
	if (space < 0) return [];
	// Drakoncman's accent is pink; card titles use a separate champagne role.
	const title = theme.fg("accent", "◆") + " " + theme.fg("text", "Drakonc Shell") + " " + theme.fg("accent", "◆");
	return [" ".repeat(Math.floor(space / 2)) + title + " ".repeat(Math.ceil(space / 2))];
}
