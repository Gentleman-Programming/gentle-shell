import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Profile, ProfileSummary } from "../lib/sdd-profiles-catalog.ts";
import { SddProfileManager } from "../lib/sdd-profiles-manager.ts";

export const GENTLE_SDD_PROFILE_COMMAND = "gentle-sdd-profile";
export const SDD_PROFILE_TOOL_LIST = "sdd_profile_list";
export const SDD_PROFILE_TOOL_USE = "sdd_profile_use";
export const SDD_PROFILE_TOOL_RENAME = "sdd_profile_rename";
export const SDD_PROFILE_TOOL_DELETE = "sdd_profile_delete";
export const GENTLE_SDD_PROFILE_LIST_COMMAND = "gentle-sdd-profile-list";
export const GENTLE_SDD_PROFILE_SAVE_COMMAND = "gentle-sdd-profile-save";
export const GENTLE_SDD_PROFILE_RENAME_COMMAND = "gentle-sdd-profile-rename";
export const GENTLE_SDD_PROFILE_DELETE_COMMAND = "gentle-sdd-profile-delete";

const SDD_PROFILE_SHORTCUT_DEFAULT_DARWIN = "ctrl+shift+m";
const SDD_PROFILE_SHORTCUT_DEFAULT = "alt+m";

export function sddProfileShortcut(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const value = env.GENTLE_PI_SDD_PROFILES_KEY?.trim();
	if (value === undefined) {
		return platform === "darwin" ? SDD_PROFILE_SHORTCUT_DEFAULT_DARWIN : SDD_PROFILE_SHORTCUT_DEFAULT;
	}
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

const USAGE =
	"Usage: /gentle-sdd-profile list | show <name> | use <name> [--project|--global] | save <name> [description] [--project|--global] | create <name> [default_model] [effort] [--project] | set <profile> <agent> <model> [effort] | rename <old> <new> | delete <name>";

function getManager(ctx?: ExtensionContext): SddProfileManager {
	const cwd =
		ctx?.sessionManager?.getCwd?.() ?? (ctx as { cwd?: string })?.cwd ?? process.cwd();
	const extra = ctx as unknown as {
		globalDir?: string;
		activeStatePath?: string;
		globalSubagentsPath?: string;
	};
	return new SddProfileManager({
		globalDir: extra?.globalDir,
		projectDir: join(cwd, ".pi", "profiles"),
		projectSubagentsPath: join(cwd, ".pi", "subagents.json"),
		activeStatePath: extra?.activeStatePath,
		globalSubagentsPath: extra?.globalSubagentsPath,
	});
}

function formatProfileList(profiles: ProfileSummary[], activeName: string | null): string {
	if (profiles.length === 0) {
		return "No profiles. Save one: /gentle-sdd-profile save <name>.";
	}
	const lines = ["SDD profiles:"];
	for (const p of profiles) {
		const isActive = Boolean(
			activeName && p.name.toLowerCase() === activeName.toLowerCase(),
		);
		const marker = isActive ? "*" : " ";
		const detail = p.default_model ? `default ${p.default_model}` : `${p.agent_count} agents`;
		const desc = p.description ? ` - ${p.description}` : "";
		lines.push(`${marker} ${p.name} [${p.scope}] (${detail})${desc}`);
	}
	return lines.join("\n");
}

function notify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error",
): string {
	ctx.ui?.notify?.(message, level);
	return message;
}

function listProfilesText(ctx: ExtensionContext): string {
	const manager = getManager(ctx);
	return formatProfileList(manager.listProfiles(), manager.getActiveProfileName());
}

function formatProfileDetail(profile: Profile, isActive: boolean): string {
	const lines = [
		`Profile: ${profile.name}${isActive ? " (active)" : ""}`,
		`Description: ${profile.description ?? "None"}`,
		`Default model: ${profile.default_model ?? "None"}`,
		`Default effort: ${profile.default_effort ?? "None"}`,
		`Updated: ${profile.updated_at ?? "N/A"}`,
		"Agents:",
	];
	const entries = Object.entries(profile.model_profiles ?? {});
	if (entries.length === 0) {
		lines.push("  (none, inherits default)");
	} else {
		for (const [agent, cfg] of entries) {
			const effort = cfg.effort ? ` [effort: ${cfg.effort}]` : "";
			lines.push(`  - ${agent}: ${cfg.model}${effort}`);
		}
	}
	return lines.join("\n");
}
export default function gentleSddProfile(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	pi.registerCommand(GENTLE_SDD_PROFILE_COMMAND, {
		description: "Manage SDD model profiles for subagents.",
		handler: async (args: string, ctx: ExtensionContext) => {
			const manager = getManager(ctx);
			const trimmed = (args || "").trim();
			if (!trimmed) return listProfilesText(ctx);

			const parts = trimmed.split(/\s+/);
			const sub = parts[0].toLowerCase();
			const scope = parts.includes("--project") ? "project" : "global";

			if (sub === "modal") return listProfilesText(ctx);

			switch (sub) {
				case "list": {
					const profiles = manager.listProfiles();
					return formatProfileList(profiles, manager.getActiveProfileName());
				}

				case "use": {
					const name = parts[1];
					if (!name || name.startsWith("--")) {
						return notify(
							ctx,
							"Usage: /gentle-sdd-profile use <name> [--project|--global]",
							"warning",
						);
					}
					const result = manager.activateProfile(name, scope);
					return notify(ctx, result.message, result.success ? "info" : "error");
				}
				case "save": {
					const name = parts[1];
					if (!name || name.startsWith("--")) {
						return notify(
							ctx,
							"Usage: /gentle-sdd-profile save <name> [description] [--project|--global]",
							"warning",
						);
					}
					const words = parts.slice(2).filter((w) => w !== "--project" && w !== "--global");
					const description = words.length > 0 ? words.join(" ") : undefined;
					const result = manager.saveCurrentAsProfile(name, description, scope);
					return notify(ctx, result.message, result.success ? "info" : "error");
				}
				case "rename": {
					const oldName = parts[1];
					const newName = parts[2];
					if (!oldName || !newName) {
						return notify(
							ctx,
							"Usage: /gentle-sdd-profile rename <old> <new>",
							"warning",
						);
					}
					const res = manager.renameProfile(oldName, newName);
					return notify(ctx, res.message, res.success ? "info" : "warning");
				}

				case "delete": {
					const name = parts[1];
					if (!name) {
						return notify(ctx, "Usage: /gentle-sdd-profile delete <name>", "warning");
					}
					if (!manager.loadProfile(name)) {
						return notify(ctx, `Profile "${name}" not found.`, "warning");
					}
					const active = manager.getActiveProfileName();
					if (active && manager.sanitizeName(active) === manager.sanitizeName(name)) {
						return notify(
							ctx,
							`Cannot delete active profile "${name}". Activate another profile first.`,
							"warning",
						);
					}
					const deleted = manager.deleteProfile(name);
					return notify(
						ctx,
						deleted ? `Deleted profile "${name}".` : `Could not delete profile "${name}".`,
						deleted ? "info" : "warning",
					);
				}

				default: {
					if (!manager.loadProfile(parts[0])) return notify(ctx, USAGE, "warning");
					const result = manager.activateProfile(parts[0], scope);
					return notify(ctx, result.message, result.success ? "info" : "error");
				}
			}
		},
	});}
