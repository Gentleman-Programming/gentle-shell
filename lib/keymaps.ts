import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseKey } from "@earendil-works/pi-tui";
import { gentlePiConfigHome } from "./agent-home.ts";

// User keymaps: the single registry every Gentle shortcut reads. Each action
// keeps its historical environment variable (which still wins, so existing
// setups are unchanged) and its default key; `keymaps.json` under the Gentle
// config home stores what the user assigned in /gentle:customize or the
// command palette. Pi reads extension shortcuts only at startup and on
// /reload, so a saved change applies after a reload. Pure apart from the
// read/write helpers, so the extensions and their tests share it.

export const KEYMAPS_FILE = "keymaps.json";
const KEYMAPS_SCHEMA = 1;
export const KEYMAP_RELOAD_NOTICE = "Run /reload to apply it.";
const COMMAND_PREFIX = "command:";

export interface KeymapAction {
	id: string;
	label: string;
	/** The environment variable that overrides this key: "" or "off" disables it. */
	env: string;
	defaultKey?: string;
	/** The slash command this action opens, so the palette can show its key. */
	command?: string;
}

export const KEYMAP_ACTIONS: readonly KeymapAction[] = [
	{ id: "commands", label: "Command palette", env: "GENTLE_PI_COMMANDS_KEY", defaultKey: "alt+k", command: "gentle:commands" },
	{ id: "changes", label: "Browse changes", env: "GENTLE_PI_SHELL_CHANGES_KEY", defaultKey: "alt+g", command: "gentle:changes" },
	{ id: "usage", label: "Subscription usage", env: "GENTLE_PI_SHELL_USAGE_KEY", defaultKey: "alt+u", command: "gentle:usage" },
	{ id: "preset", label: "Cycle visual preset", env: "GENTLE_PI_SHELL_PRESET_KEY", defaultKey: "alt+l" },
	{ id: "agents.view", label: "Subagents overlay", env: "GENTLE_PI_AGENTS_VIEW_KEY", defaultKey: "alt+a", command: "gentle:agents" },
	{ id: "agents.stop", label: "Stop active subagents", env: "GENTLE_PI_AGENTS_STOP_KEY", defaultKey: "alt+s" },
	{ id: "agents.collapse", label: "Collapse the agents card", env: "GENTLE_PI_AGENTS_KEY", defaultKey: "ctrl+shift+a" },
	{ id: "jobs.collapse", label: "Collapse the jobs card", env: "GENTLE_PI_JOBS_KEY", defaultKey: "ctrl+shift+j" },
	{ id: "todo.collapse", label: "Collapse the todo list", env: "GENTLE_PI_TODO_KEY", defaultKey: "ctrl+shift+t" },
	{ id: "stats.view", label: "Usage stats", env: "GENTLE_PI_STATS_VIEW_KEY", command: "gentle:stats" },
];

// Pi refuses extension shortcuts on these editor-global keybindings
// (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS in Pi's extension runner,
// which is not exported): a Gentle keymap on one of their keys is skipped.
export const RESERVED_PI_KEYBINDINGS: readonly string[] = [
	"app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle",
	"app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.tools.expand",
	"app.thinking.toggle", "app.editor.external", "app.message.copy", "app.message.followUp",
	"tui.input.submit", "tui.select.confirm", "tui.select.cancel", "tui.input.copy", "tui.editor.deleteToLineEnd",
];

/** Saved assignments: a key, or null for an action the user disabled. */
export type KeymapBindings = Readonly<Record<string, string | null>>;

export interface KeymapFile {
	bindings: KeymapBindings;
	path: string;
	/** True when the file exists but could not be read or parsed; its bindings are then ignored. */
	malformed: boolean;
}

/** The subset of Pi's KeybindingsManager the checks need. */
export interface PiKeybindings {
	getKeys(keybinding: string): readonly string[];
	getResolvedBindings?(): Readonly<Record<string, unknown>>;
}

export type KeymapSource = "env" | "saved" | "default" | "none";

export type KeymapCheck =
	| { kind: "ok" }
	| { kind: "blocked"; message: string }
	| { kind: "confirm"; message: string; displaces?: string };

const ACTIONS_BY_ID = new Map(KEYMAP_ACTIONS.map((action) => [action.id, action]));
const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"];

export function keymapAction(id: string): KeymapAction | undefined {
	return ACTIONS_BY_ID.get(id);
}

/** The keymap id of a slash command: its built-in action when it has one, else `command:<name>`. */
export function commandKeymapId(command: string): string {
	return KEYMAP_ACTIONS.find((action) => action.command === command)?.id ?? `${COMMAND_PREFIX}${command}`;
}

/** The slash command a `command:<name>` keymap runs, or undefined for a built-in action id. */
export function keymapCommand(id: string): string | undefined {
	return id.startsWith(COMMAND_PREFIX) && id.length > COMMAND_PREFIX.length ? id.slice(COMMAND_PREFIX.length) : undefined;
}

export function keymapLabel(id: string): string {
	return keymapAction(id)?.label ?? `/${keymapCommand(id) ?? id}`;
}

function envValue(action: KeymapAction | undefined, env: NodeJS.ProcessEnv): string | undefined {
	return action ? env[action.env]?.trim() : undefined;
}

/**
 * The key an action uses: its environment variable when set ("" or "off"
 * disables it), else the saved assignment (null disables it), else its
 * default. A `command:<name>` id has no environment variable or default.
 */
export function effectiveKey(id: string, env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): string | undefined {
	const action = keymapAction(id);
	const fromEnv = envValue(action, env);
	if (fromEnv !== undefined) return fromEnv === "" || fromEnv.toLowerCase() === "off" ? undefined : fromEnv;
	if (Object.hasOwn(bindings, id)) return bindings[id] ?? undefined;
	return action?.defaultKey;
}

export function keymapSource(id: string, env: NodeJS.ProcessEnv = process.env, bindings: KeymapBindings = {}): KeymapSource {
	if (envValue(keymapAction(id), env) !== undefined) return "env";
	if (Object.hasOwn(bindings, id)) return "saved";
	return keymapAction(id)?.defaultKey ? "default" : "none";
}

/** Every `command:<name>` id with a saved key, in file order. */
export function commandKeymapIds(bindings: KeymapBindings): string[] {
	return Object.keys(bindings).filter((id) => keymapCommand(id) !== undefined && bindings[id]);
}

/** Lowercase and order modifiers as ctrl, shift, alt, super; undefined for an unknown modifier. */
export function normalizeKeyId(key: string): string | undefined {
	const parts = key.trim().toLowerCase().split("+");
	const base = parts.pop();
	if (!base) return undefined;
	const modifiers = new Set<string>();
	for (const part of parts) {
		if (!MODIFIER_ORDER.includes(part)) return undefined;
		modifiers.add(part);
	}
	return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), base].join("+");
}

/**
 * The assignable key of one raw key press. A key without ctrl, alt or super
 * (letters, Enter, arrows, shift+letter) would stop the user from typing, so
 * only modified keys and f1-f12 are accepted.
 */
export function keyFromInput(data: string): { key: string } | { error: string } {
	const parsed = parseKey(data);
	const key = parsed === undefined ? undefined : normalizeKeyId(parsed);
	if (key === undefined) return { error: "That key is not recognized by the terminal. Try another combination." };
	const modifiers = key.split("+").slice(0, -1);
	if (modifiers.some((modifier) => modifier !== "shift") || /^f([1-9]|1[0-2])$/.test(key)) return { key };
	return { error: `${key} is needed for typing. Use a combination with ctrl or alt, or f1-f12.` };
}

function sameKey(left: string | undefined, right: string): boolean {
	return left !== undefined && normalizeKeyId(left) === normalizeKeyId(right);
}

function keysOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The id of the action already on `key`, excluding `ownId`. */
export function keymapOwner(key: string, env: NodeJS.ProcessEnv, bindings: KeymapBindings, ownId?: string): string | undefined {
	const ids = [...KEYMAP_ACTIONS.map((action) => action.id), ...commandKeymapIds(bindings)];
	return ids.find((id) => id !== ownId && sameKey(effectiveKey(id, env, bindings), key));
}

/** Why `id` cannot be changed here: its environment variable controls it. */
export function keymapEnvLock(id: string, env: NodeJS.ProcessEnv): string | undefined {
	const action = keymapAction(id);
	return action && envValue(action, env) !== undefined ? `${action.label} is set by ${action.env}; unset it to change the key here.` : undefined;
}

/**
 * Whether `key` can go on `id`: blocked when the action is controlled by its
 * environment variable or the key is one Pi reserves; a confirmation when the
 * key belongs to another Gentle action (which then loses it) or overrides a
 * non-reserved Pi keybinding.
 */
export function checkKeymap(id: string, key: string, env: NodeJS.ProcessEnv, bindings: KeymapBindings, keybindings?: PiKeybindings): KeymapCheck {
	const locked = keymapEnvLock(id, env);
	if (locked) return { kind: "blocked", message: locked };
	if (keybindings) {
		const reserved = RESERVED_PI_KEYBINDINGS.find((binding) => keybindings.getKeys(binding).some((piKey) => sameKey(piKey, key)));
		if (reserved) return { kind: "blocked", message: `${key} is reserved by Pi (${reserved}); choose another key.` };
	}
	const owner = keymapOwner(key, env, bindings, id);
	if (owner) {
		const ownerAction = keymapAction(owner);
		if (ownerAction && envValue(ownerAction, env) !== undefined) return { kind: "blocked", message: `${key} is used by ${ownerAction.label} through ${ownerAction.env}.` };
		return { kind: "confirm", message: `${key} is used by ${keymapLabel(owner)}. Move it to ${keymapLabel(id)}?`, displaces: owner };
	}
	const resolved = keybindings?.getResolvedBindings?.() ?? {};
	const builtin = Object.keys(resolved).find((binding) => keysOf(resolved[binding]).some((piKey) => sameKey(piKey, key)));
	if (builtin) return { kind: "confirm", message: `${key} is Pi's ${builtin}. Use it for ${keymapLabel(id)} instead?` };
	return { kind: "ok" };
}

/** Why `file` cannot be rewritten; undefined when it can. */
export function keymapsUnwritable(file: KeymapFile): string | undefined {
	return file.malformed ? `Keymaps: ${file.path} is unreadable or malformed; fix or delete it to change keys.` : undefined;
}

export type KeymapChange =
	| { kind: "refused"; message: string; type: "warning" | "error" }
	| { kind: "ready"; key: string; bindings: Record<string, string | null>; confirm?: string };

/**
 * The change one raw key press makes to `id`: refused (environment lock,
 * unwritable file, typing key, reserved key) or the new bindings, with the
 * question to ask first when the key moves from another action.
 */
export function prepareKeymapChange(id: string, data: string, env: NodeJS.ProcessEnv, file: KeymapFile, keybindings?: PiKeybindings): KeymapChange {
	const locked = keymapEnvLock(id, env);
	if (locked) return { kind: "refused", message: locked, type: "warning" };
	const unwritable = keymapsUnwritable(file);
	if (unwritable) return { kind: "refused", message: unwritable, type: "error" };
	const parsed = keyFromInput(data);
	if ("error" in parsed) return { kind: "refused", message: parsed.error, type: "warning" };
	const check = checkKeymap(id, parsed.key, env, file.bindings, keybindings);
	if (check.kind === "blocked") return { kind: "refused", message: check.message, type: "warning" };
	const confirm = check.kind === "confirm" ? check : undefined;
	return { kind: "ready", key: parsed.key, bindings: assignKeymap(file.bindings, id, parsed.key, confirm?.displaces), confirm: confirm?.message };
}

/** What the user is told after a saved change. */
export function keymapSavedNotice(id: string, name: string, env: NodeJS.ProcessEnv, bindings: KeymapBindings): string {
	return `${name}: ${effectiveKey(id, env, bindings) ?? "none"}. ${KEYMAP_RELOAD_NOTICE}`;
}

/** A copy of `bindings` with `id` on `key` (null disables it) and `displaces`, when given, disabled. */
export function assignKeymap(bindings: KeymapBindings, id: string, key: string | null, displaces?: string): Record<string, string | null> {
	const next: Record<string, string | null> = { ...bindings, [id]: key === null ? null : normalizeKeyId(key) ?? key };
	if (displaces && displaces !== id) next[displaces] = null;
	return next;
}

/** A copy of `bindings` without `id`, so it goes back to its default key. */
export function resetKeymap(bindings: KeymapBindings, id: string): Record<string, string | null> {
	const next: Record<string, string | null> = { ...bindings };
	delete next[id];
	return next;
}

function parseKeymapFile(raw: string): KeymapBindings | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const { schema, bindings } = value as { schema?: unknown; bindings?: unknown };
		if (schema !== KEYMAPS_SCHEMA || typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return undefined;
		const result: Record<string, string | null> = {};
		for (const [id, key] of Object.entries(bindings)) {
			if (id === "" || (key !== null && (typeof key !== "string" || normalizeKeyId(key) === undefined))) return undefined;
			result[id] = key;
		}
		return result;
	} catch {
		return undefined;
	}
}

export function readKeymaps(configHome: string): KeymapFile {
	const path = join(configHome, KEYMAPS_FILE);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { bindings: {}, path, malformed: !missing };
	}
	const bindings = parseKeymapFile(raw);
	return { bindings: bindings ?? {}, path, malformed: bindings === undefined };
}

/** The keymaps file of the Gentle config home `env` resolves to. */
export function loadKeymaps(env: NodeJS.ProcessEnv = process.env): KeymapFile {
	return readKeymaps(gentlePiConfigHome(env));
}

/** Same-directory rename, so a reader never sees a partially written file. */
export function writeKeymaps(configHome: string, bindings: KeymapBindings): string {
	const path = join(configHome, KEYMAPS_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(configHome, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: KEYMAPS_SCHEMA, bindings }, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
	return path;
}
