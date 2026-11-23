import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";

// The curated command set for the command palette: an OpenCode-style
// grouped menu, not a raw listing of every registered extension command.
// Only command + label live here; the live description and any shortcut
// hint are attached at build time by buildCommandPaletteGroups, from the
// actual registration and the shell's configured shortcuts.

export interface CommandPaletteCatalogItem {
	command: string;
	label: string;
}

export interface CommandPaletteCatalogGroup {
	title: string;
	items: readonly CommandPaletteCatalogItem[];
}

export const COMMAND_PALETTE_CATALOG: readonly CommandPaletteCatalogGroup[] = [
	{
		title: "Configuration",
		items: [
			{ command: "drakonc:profiles", label: "Models and profiles" },
			{ command: "drakonc:persona", label: "Switch persona" },
			{ command: "drakonc:review-mode", label: "Review mode (receipt-driven development)" },
			{ command: "drakonc:background-subagents", label: "Background subagents" },
			{ command: "drakonc:double-esc-cancel", label: "Require double Esc to cancel" },
			{ command: "drakonc:customize", label: "Customization · appearance + audio notifications" },
			{ command: "drakonc:animations", label: "Animation mode" },
			{ command: "drakonc:vim", label: "Vim opt-in · Pi slash commands" },
			{ command: "drakonc:telemetry", label: "Telemetry" },
			{ command: "drakonc:dev-binary", label: "Drakonc AI dev binary" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: "drakonc:guide", label: "Guided tour of Drakonc Shell" },
			{ command: "drakonc:yolo", label: "🚀 YOLO 🔥 session permission" },
			{ command: "drakonc:changes", label: "Browse changes" },
			{ command: "drakonc:agents", label: "Subagents" },
			{ command: "drakonc:jobs", label: "Background jobs" },
			{ command: "drakonc:usage", label: "Subscription usage" },
			{ command: "drakonc:review-session-permission", label: "Review session permission" },
			{ command: "drakonc:voice", label: "Voice dictation · local Parakeet" },
			{ command: "drakonc:design", label: "Design · HTML artboards" },
		],
	},
	{
		title: "Diagnostics",
		items: [
			{ command: "drakonc:status", label: "Drakonc AI status" },
			{ command: "drakonc:doctor", label: "Doctor" },
		],
	},
	{
		title: "Skills",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry" }],
	},
];

/**
 * Build the palette's groups for one session: keep only catalog entries
 * whose command is actually registered (so a missing extension never shows
 * a dead row), attach that registration's live description and an optional
 * shortcut hint, and drop any group left with no items. Catalog order is
 * preserved throughout.
 */
export function buildCommandPaletteGroups(registered: readonly { name: string; description?: string }[], shortcuts: Readonly<Record<string, string | undefined>>): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const groups: CommandPaletteGroup[] = [];
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items: CommandPaletteItem[] = [];
		for (const entry of group.items) {
			const found = byName.get(entry.command);
			if (!found) continue;
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command] });
		}
		if (items.length > 0) groups.push({ title: group.title, items });
	}
	return groups;
}
