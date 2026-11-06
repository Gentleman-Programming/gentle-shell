import { matchesKey } from "@earendil-works/pi-tui";
import {
	assignKeymap, commandKeymapId, effectiveKey, KEYMAP_ACTIONS, keymapEnvLock, keymapSavedNotice, keymapSource,
	keymapsUnwritable, prepareKeymapChange, readKeymaps, resetKeymap, writeKeymaps, type KeymapBindings, type PiKeybindings,
} from "./keymaps.ts";
import type { CustomizeInline, CustomizeRow } from "./visual-customize-view.ts";

// The Keymaps category of /gentle:customize: one row per Gentle action and
// per palette command without a built-in action. Enter captures the next key
// press, ⌫ disables the key, r restores the default. Every change goes to
// keymaps.json (lib/keymaps.ts) and applies after /reload, which the last
// row runs.

export interface KeymapRowsOptions {
	env: NodeJS.ProcessEnv;
	configHome: string;
	/** Pi's resolved keybindings, so reserved keys are refused; undefined skips that check. */
	keybindings(): PiKeybindings | undefined;
	/** Palette commands (command + label); those with a built-in action are listed once, as that action. */
	commands: readonly { command: string; label: string }[];
	notify(message: string, type: "info" | "warning" | "error"): void;
	reload(): void | Promise<void>;
}

const ROW_HINT = "Enter assign · ⌫ disable · r default · Esc close";

export function buildKeymapRows(options: KeymapRowsOptions): CustomizeRow[] {
	let bindings: KeymapBindings = readKeymaps(options.configHome).bindings;
	/** The saved bindings, or undefined (reported) when the file cannot be safely rewritten. */
	const writable = (): KeymapBindings | undefined => {
		const file = readKeymaps(options.configHome);
		const unwritable = keymapsUnwritable(file);
		if (unwritable) {
			options.notify(unwritable, "error");
			return undefined;
		}
		bindings = file.bindings;
		return bindings;
	};
	const save = (next: KeymapBindings, id: string, name: string) => {
		writeKeymaps(options.configHome, next);
		bindings = next;
		options.notify(keymapSavedNotice(id, name, options.env, bindings), "info");
	};
	const row = (id: string, name: string, envName?: string): CustomizeRow => ({
		category: "Keymaps",
		label: () => {
			const key = effectiveKey(id, options.env, bindings) ?? "none";
			return keymapSource(id, options.env, bindings) === "env" ? `${name}: ${key} (${envName})` : `${name}: ${key}`;
		},
		keyhint: ROW_HINT,
		action: async (inline: CustomizeInline) => {
			// Refuse before asking for a key the user could not save anyway.
			const locked = keymapEnvLock(id, options.env);
			if (locked) return options.notify(locked, "warning");
			if (!writable()) return;
			const data = await inline.capture(`Press the new key for ${name}`);
			if (data === undefined || inline.disposed) return;
			const change = prepareKeymapChange(id, data, options.env, readKeymaps(options.configHome), options.keybindings());
			if (change.kind === "refused") return options.notify(change.message, change.type);
			if (change.confirm && (!(await inline.confirm(change.confirm)) || inline.disposed)) return;
			save(change.bindings, id, name);
		},
		key: (data: string) => {
			const disable = matchesKey(data, "backspace") || data === "\x7f";
			if (!disable && data !== "r") return false;
			const locked = keymapEnvLock(id, options.env);
			if (locked) { options.notify(locked, "warning"); return true; }
			const current = writable();
			if (current) save(disable ? assignKeymap(current, id, null) : resetKeymap(current, id), id, name);
			return true;
		},
	});
	const rows = KEYMAP_ACTIONS.map((action) => row(action.id, action.label, action.env));
	for (const { command, label } of options.commands) {
		const id = commandKeymapId(command);
		if (id.startsWith("command:")) rows.push(row(id, `/${command} · ${label}`));
	}
	rows.push({ category: "Keymaps", label: "Reload now to apply keymap changes", keyhint: "Enter reload · Esc close", action: () => options.reload() });
	return rows;
}
