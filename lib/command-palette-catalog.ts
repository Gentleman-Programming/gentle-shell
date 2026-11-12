import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";
import { readContributions, type Contribution } from "./plugin-contract.ts";
import { readPluginOrder, type PluginOrderOptions } from "./plugin-order.ts";

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
			{ command: "gentle:plugins", label: "Plugins · contribution audit" },
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
 *
 * The read applies the declared owner order read from `plugins.json` on this
 * build, never a cached copy: an owner the file names comes first in that
 * sequence, and every other owner keeps registration order after it.
 */
export function buildCommandPaletteGroups(
	registered: readonly { name: string; description?: string }[],
	shortcuts: Readonly<Record<string, string | undefined>>,
	options: PluginOrderOptions = {},
): CommandPaletteGroup[] {
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

	// One order read and one contribution read per build: the declared owner
	// order fixes the appended sequence, and the owners the file does not name
	// keep registration order after the named ones.
	const contributed: Array<{ registration: { name: string; description?: string }; title: string }> = [];
	const claimed = new Set<string>();
	for (const contribution of readContributions({ order: readPluginOrder(options).order })) {
		const command = contribution.palette?.command;
		if (command === undefined || claimed.has(command) || catalogued.has(command)) continue;
		const registration = byName.get(command);
		if (registration === undefined) continue;
		claimed.add(command);
		contributed.push({ registration, title: contributedGroup(contribution) });
	}

	for (const { registration, title } of contributed) {
		let group = groups.find((candidate) => candidate.title === title);
		if (group === undefined) {
			group = { title, items: [] };
			groups.push(group);
		}
		group.items.push({ command: registration.name, label: registration.name, description: registration.description, shortcut: shortcuts[registration.name] });
	}

	return groups.filter((group) => group.items.length > 0);
}
