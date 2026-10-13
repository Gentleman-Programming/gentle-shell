import { isAbsolute } from "node:path";

// Per-env scope of Gentle's own configuration (the config home, normally
// ~/.pi/gentle-ai). Like VS Code profiles, a named env chooses per category
// whether it shares the base configuration or keeps its own copy. Pure data
// and env parsing only: shared by the launcher and the Pi extensions.

export const CONFIG_CATEGORIES = Object.freeze(["models", "persona", "appearance", "behavior"] as const);
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

export function isConfigCategory(value: string): value is ConfigCategory {
	return (CONFIG_CATEGORIES as readonly string[]).includes(value);
}

// The files each category owns inside a config home. Models and profiles
// travel together: a profile is a snapshot of the routing, and applying one
// rewrites models.json, so splitting them would let an own profile overwrite
// a shared routing.
export const CONFIG_CATEGORY_FILES: Readonly<Record<ConfigCategory, readonly string[]>> = Object.freeze({
	models: Object.freeze(["models.json", "models.export.json", "profiles.json", "profiles.export.json"]),
	persona: Object.freeze(["persona.json"]),
	appearance: Object.freeze([
		"visual-customization.json",
		"visual-profiles.json",
		"card-style.json",
		"card-content.json",
		"animations.json",
		"banner.json",
		"notifications.json",
		"vim.json",
	]),
	behavior: Object.freeze([
		"permission-mode.json",
		"runtime-guardrails.json",
		"history-capture.json",
		"background-subagents.json",
		"double-esc-cancel.json",
		"builtin-codemode-optout.json",
	]),
});

// Files that belong to the install, never to an env: they always resolve to
// the shared config home.
export const INSTALL_CONFIG_FILES = Object.freeze(["channel.json", "dev-binary.json"]);

// Set by the launcher on the Pi process of a named env that owns some
// categories, and cleared for every other home.
export const ENV_CONFIG_HOME_ENV = "GENTLE_SHELL_ENV_CONFIG_HOME";
export const ENV_OWN_CONFIG_ENV = "GENTLE_SHELL_ENV_OWN_CONFIG";

// The categories this process keeps in its env config home. Fails closed to
// "nothing own" (the shared configuration, today's behavior) unless the env
// config home is an absolute path and the category is known.
export function ownConfigCategories(env: Record<string, string | undefined>): readonly ConfigCategory[] {
	const home = env[ENV_CONFIG_HOME_ENV];
	if (home === undefined || home.length === 0 || !isAbsolute(home)) return [];
	const listed = (env[ENV_OWN_CONFIG_ENV] ?? "").split(",").map((value) => value.trim());
	return CONFIG_CATEGORIES.filter((category) => listed.includes(category));
}

// The env config home when `category` is own in this process, else undefined.
export function envConfigHomeFor(env: Record<string, string | undefined>, category: ConfigCategory | undefined): string | undefined {
	if (category === undefined) return undefined;
	return ownConfigCategories(env).includes(category) ? env[ENV_CONFIG_HOME_ENV] : undefined;
}
