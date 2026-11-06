import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "./agent-home.ts";

// gentle-pi replaces Pi's replaceable builtin codemode with its compact
// renderer (lib/codemode-renderer.ts), and Pi warns at every startup when a
// builtin loses its tool to another extension. Pi's only per-builtin opt-out
// is a `-builtin:<name>` entry in the settings `extensions` array. The
// gentle-shell launcher adds it silently to homes it owns (bin/gentle-shell.mjs,
// #1612); a user-owned Pi home only gets it after the user accepts a
// one-time prompt, and a declined prompt is remembered per settings file.
export const BUILTIN_CODEMODE_EXTENSION = "builtin:codemode";
export const BUILTIN_CODEMODE_OPTOUT_ENTRY = `-${BUILTIN_CODEMODE_EXTENSION}`;
export const BUILTIN_CODEMODE_OPTOUT_SCHEMA = "gentle-pi.builtin-codemode-optout/v1";

export type BuiltinCodemodeOptOutOutcome =
	| "no-ui"
	| "explicit-entry"
	| "unwritable"
	| "declined-before"
	| "accepted"
	| "declined"
	| "failed";

export interface BuiltinCodemodeOptOutOptions {
	/** Pi agent dir whose settings.json receives the entry; defaults to getAgentDir(). */
	agentDir?: string;
	/** gentle-pi config home holding the remembered decline; defaults to gentlePiConfigHome(). */
	configHome?: string;
	/** Effective (merged) settings `extensions`, e.g. from pi.getSettings(). */
	effectiveExtensions?: unknown;
}

export interface BuiltinCodemodeOptOutContext {
	hasUI: boolean;
	mode: string;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

/** True when `extensions` already holds any explicit (`+`, `-`, `!`, or bare) entry for the builtin. */
export function hasExplicitBuiltinEntry(extensions: unknown, builtin = BUILTIN_CODEMODE_EXTENSION): boolean {
	return Array.isArray(extensions) && extensions.some((entry) => typeof entry === "string" && entry.replace(/^[+!-]/, "") === builtin);
}

// Pure: mirrors withBuiltinExtensionExcluded in bin/gentle-shell.mjs. Returns
// `settingsText` with `-<builtin>` appended to its `extensions` array (created
// when absent), or undefined when nothing should change — the text does not
// parse as a JSON object, `extensions` exists but is not an array, or the
// array already holds an explicit entry for the builtin, which is the user's
// own decision. Keeps every other key and entry, the text's indentation, and
// its trailing newline.
export function withBuiltinExtensionExcluded(settingsText: string, builtin = BUILTIN_CODEMODE_EXTENSION): string | undefined {
	let settings: unknown;
	try {
		settings = JSON.parse(settingsText);
	} catch {
		return undefined;
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const extensions = Object.prototype.hasOwnProperty.call(settings, "extensions") ? (settings as { extensions: unknown }).extensions : [];
	if (!Array.isArray(extensions) || hasExplicitBuiltinEntry(extensions, builtin)) return undefined;
	const indent = settingsText.match(/\{\r?\n([ \t]+)/)?.[1];
	const serialized = JSON.stringify({ ...settings, extensions: [...extensions, `-${builtin}`] }, null, indent);
	return settingsText.endsWith("\n") ? `${serialized}\n` : serialized;
}

export function builtinCodemodeOptOutStatePath(configHome = gentlePiConfigHome()): string {
	return join(configHome, "builtin-codemode-optout.json");
}

function readIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function readDeclined(configHome: string): string[] {
	try {
		const value: unknown = JSON.parse(readIfExists(builtinCodemodeOptOutStatePath(configHome)) ?? "null");
		if (typeof value !== "object" || value === null || (value as { schema?: unknown }).schema !== BUILTIN_CODEMODE_OPTOUT_SCHEMA) return [];
		const declined = (value as { declined?: unknown }).declined;
		return Array.isArray(declined) ? declined.filter((path): path is string => typeof path === "string") : [];
	} catch { return []; }
}

/** Same-directory rename prevents readers from seeing a partially written state file. */
function recordDeclined(configHome: string, settingsPath: string): void {
	const declined = readDeclined(configHome);
	if (declined.includes(settingsPath)) return;
	mkdirSync(configHome, { recursive: true });
	const path = builtinCodemodeOptOutStatePath(configHome);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: BUILTIN_CODEMODE_OPTOUT_SCHEMA, declined: [...declined, settingsPath] })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
}

// Writes through a symlinked settings.json to its real target, so the link
// stays a link, with the same temp-file-then-rename and file mode as the
// launcher's writeFileAtomically.
function writeSettingsAtomically(path: string, data: string): void {
	const target = realpathSync(path);
	const mode = statSync(target).mode & 0o777;
	const temporary = join(dirname(target), `.${basename(target)}.gentle-pi-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, data, { flag: "wx" });
		chmodSync(temporary, mode);
		renameSync(temporary, target);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename already consumed the temporary file. */ }
	}
}

function promptMessage(settingsPath: string): string {
	return [
		"Pi warns at startup that the builtin codemode extension was not loaded, because gentle-pi replaces it with its compact codemode renderer.",
		`Adding "${BUILTIN_CODEMODE_OPTOUT_ENTRY}" to the "extensions" list in ${settingsPath} silences that warning from the next launch. gentle-pi keeps its compact codemode either way.`,
		"Nothing is written unless you accept. If you decline, gentle-pi will not ask again.",
	].join("\n\n");
}

// Asks once, in an interactive TUI only, whether to add the opt-out to the
// agent settings.json, and writes only on acceptance. A missing settings.json
// is never created: Pi and `pi install` own that file. Never throws.
export async function offerBuiltinCodemodeOptOut(ctx: BuiltinCodemodeOptOutContext, options: BuiltinCodemodeOptOutOptions = {}): Promise<BuiltinCodemodeOptOutOutcome> {
	try {
		if (!ctx.hasUI || ctx.mode !== "tui") return "no-ui";
		if (hasExplicitBuiltinEntry(options.effectiveExtensions)) return "explicit-entry";
		const settingsPath = resolve(options.agentDir ?? getAgentDir(), "settings.json");
		const configHome = options.configHome ?? gentlePiConfigHome();
		const currentText = readIfExists(settingsPath);
		if (currentText === undefined) return "unwritable";
		try {
			if (hasExplicitBuiltinEntry((JSON.parse(currentText) as { extensions?: unknown } | null)?.extensions)) return "explicit-entry";
		} catch { /* Malformed JSON is reported as unwritable below. */ }
		if (withBuiltinExtensionExcluded(currentText) === undefined) return "unwritable";
		if (readDeclined(configHome).includes(settingsPath)) return "declined-before";

		const accepted = (await ctx.ui.confirm("Silence Pi's builtin codemode warning?", promptMessage(settingsPath))) === true;
		if (!accepted) {
			recordDeclined(configHome, settingsPath);
			ctx.ui.notify(`gentle-pi will not ask again. To silence the warning later, add "${BUILTIN_CODEMODE_OPTOUT_ENTRY}" to "extensions" in ${settingsPath}.`, "info");
			return "declined";
		}
		// The dialog may have stayed open while the file changed; re-read it.
		const freshText = readIfExists(settingsPath);
		const newText = freshText === undefined ? undefined : withBuiltinExtensionExcluded(freshText);
		if (newText === undefined) return "unwritable";
		writeSettingsAtomically(settingsPath, newText);
		ctx.ui.notify(`Added "${BUILTIN_CODEMODE_OPTOUT_ENTRY}" to ${settingsPath}. The builtin codemode warning disappears from the next launch.`, "info");
		return "accepted";
	} catch {
		return "failed";
	}
}
