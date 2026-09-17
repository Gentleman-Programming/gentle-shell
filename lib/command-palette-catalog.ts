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
			{ command: "gentle:models", label: "Assign models and effort" },
			{ command: "gentle:profiles", label: "Agent-model profiles" },
			{ command: "gentle:persona", label: "Switch persona" },
			{ command: "gentle:review-mode", label: "Review mode (receipt-driven development)" },
			{ command: "gentle:background-subagents", label: "Background subagents" },
			{ command: "gentle:telemetry", label: "Telemetry" },
			{ command: "gentle:banner", label: "Startup banner" },
			{ command: "gentle:banner-color", label: "Banner color" },
			{ command: "gentle:toggle-rose", label: "Toggle banner rose" },
			{ command: "gentle:toggle-text-logo", label: "Toggle banner text logo" },
			{ command: "gentle:dev-binary", label: "Gentle AI dev binary" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: "gentle:changes", label: "Browse captured changes" },
			{ command: "gentle:agents", label: "Subagents" },
			{ command: "gentle:usage", label: "Subscription usage" },
			{ command: "gentle:review-session-permission", label: "Review session permission" },
		],
	},
	{
		title: "Diagnostics",
		items: [
			{ command: "gentle:status", label: "Gentle AI status" },
			{ command: "gentle:doctor", label: "Doctor" },
		],
	},
	{
		title: "SDD",
		items: [
			{ command: "gentle:sdd-preflight", label: "SDD preflight" },
			{ command: "gentle-sdd-status", label: "SDD status" },
			{ command: "gentle-sdd-continue", label: "SDD continue" },
			{ command: "gentle-sdd-init", label: "SDD init" },
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
