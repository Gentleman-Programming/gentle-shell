import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";
import { readContributions, type Contribution } from "./plugin-contract.ts";

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
			{ command: "gentle:profiles", label: "Models and profiles" },
			{ command: "gentle:persona", label: "Switch persona" },
			{ command: "gentle:review-mode", label: "Review mode (receipt-driven development)" },
			{ command: "gentle:background-subagents", label: "Background subagents" },
			{ command: "gentle:double-esc-cancel", label: "Require double Esc to cancel" },
			{ command: "gentle:customize", label: "Customization · appearance + audio notifications" },
			{ command: "gentle:animations", label: "Animation mode" },
			{ command: "gentle:vim", label: "Vim opt-in · Pi slash commands" },
			{ command: "gentle:telemetry", label: "Telemetry" },
			{ command: "gentle:dev-binary", label: "Gentle AI dev binary" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: "gentle:guide", label: "Guided tour of Gentle Shell" },
			{ command: "gentle:yolo", label: "🚀 YOLO 🔥 session permission" },
			{ command: "gentle:changes", label: "Browse changes" },
			{ command: "gentle:agents", label: "Subagents" },
			{ command: "gentle:jobs", label: "Background jobs" },
			{ command: "gentle:usage", label: "Subscription usage" },
			{ command: "gentle:review-session-permission", label: "Review session permission" },
			{ command: "gentle:voice", label: "Voice dictation · local Parakeet" },
			{ command: "gentle:design", label: "Design · HTML artboards" },
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
		title: "Skills",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry" }],
	},
];

/** Group a contribution falls back to when its palette payload carries no usable group. */
const CONTRIBUTION_GROUP_FALLBACK = "Plugins";

/**
 * The group a contributed command belongs in: the group the plugin declared,
 * or a stable group derived from its owner when the declaration has none.
 */
function contributedGroup(contribution: Contribution): string {
	const group = contribution.palette?.group;
	return group !== undefined && group.trim().length > 0 ? group : `${CONTRIBUTION_GROUP_FALLBACK} · ${contribution.owner}`;
}

/**
 * Build the palette's groups for one session: keep only catalog entries
 * whose command is actually registered (so a missing extension never shows
 * a dead row), attach that registration's live description and an optional
 * shortcut hint, and drop any group left with no items. Catalog order is
 * preserved throughout.
 *
 * Community plugin contributions are merged here, at build time, never into
 * `COMMAND_PALETTE_CATALOG`: a registered command that the catalog does not
 * list is appended to the group its contribution declares (creating that
 * group after the catalog ones when it is new), so no row, group or order
 * changes when the contribution box is empty. A contribution naming a
 * command that is not registered, or one the catalog already lists, adds
 * nothing. The first contribution read for a command owns it, which keeps
 * the output reproducible across builds.
 */
export function buildCommandPaletteGroups(registered: readonly { name: string; description?: string }[], shortcuts: Readonly<Record<string, string | undefined>>): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const groups: CommandPaletteGroup[] = [];
	const catalogued = new Set<string>();
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items: CommandPaletteItem[] = [];
		for (const entry of group.items) {
			catalogued.add(entry.command);
			const found = byName.get(entry.command);
			if (!found) continue;
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command] });
		}
		groups.push({ title: group.title, items });
	}

	const contributed = new Map<string, string>();
	for (const contribution of readContributions()) {
		const command = contribution.palette?.command;
		if (command === undefined || contributed.has(command)) continue;
		contributed.set(command, contributedGroup(contribution));
	}

	for (const command of registered) {
		if (catalogued.has(command.name)) continue;
		const title = contributed.get(command.name);
		if (title === undefined) continue;
		let group = groups.find((candidate) => candidate.title === title);
		if (group === undefined) {
			group = { title, items: [] };
			groups.push(group);
		}
		group.items.push({ command: command.name, label: command.name, description: command.description, shortcut: shortcuts[command.name] });
	}

	return groups.filter((group) => group.items.length > 0);
}
