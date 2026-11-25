// A read-only display projection of Pi's `settings.json` for Desktop: the
// default provider, model, and thinking level, the enabled model patterns, and
// the configured extension names. Nothing else crosses: no packages (covered by
// `get_update_status`), no theme, no `sessionDir`, no path, no command, no
// unknown key.
//
// Pi owns the file and its layering, so the read goes through Pi's exported
// `SettingsManager` (global `<agentDir>/settings.json` deep-merged with the
// project `<cwd>/<CONFIG_DIR_NAME>/settings.json` only when the project is
// trusted, plus Pi's own migrations). It is built over a read-only storage:
// `SettingsManager.create` takes a lock file next to `settings.json` even to
// read, and a Desktop read must never write, so this storage only reads the
// file and ignores any content the manager would write back. Extensions are
// named by their last path segment, shown only when it is a plain file or
// package name.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Pi's `SettingsStorage` contract: accepted by the exported `SettingsManager.fromStorage`, not exported by name. */
type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

export const PI_SETTINGS_LIMITS = Object.freeze({ enabledModels: 64, extensions: 64, text: 128 });

/** Pi's thinking levels; any other value is not displayed. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface PiSettingsView {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: string | null;
	/** `null` when no layer sets `enabledModels` (every model is available). */
	enabledModels: string[] | null;
	extensions: string[];
	/** True when a list was cut at its bound. */
	truncated: boolean;
}

export type PiSettingsLayerStatus = "missing" | "invalid" | "valid";

export interface PiSettingsRead {
	global: PiSettingsLayerStatus;
	/** Absent when the project is not trusted: Pi does not read that file then. */
	project?: PiSettingsLayerStatus;
	view?: PiSettingsView;
}

export function globalPiSettingsPath(agentHome: string): string {
	return join(agentHome, "settings.json");
}

export function projectPiSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

/** Reads the two settings files and never writes either one. */
class ReadOnlySettingsStorage implements SettingsStorage {
	private readonly paths: { global: string; project: string };
	constructor(paths: { global: string; project: string }) {
		this.paths = paths;
	}
	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		const path = this.paths[scope];
		fn(existsSync(path) ? readFileSync(path, "utf8") : undefined);
	}
}

/** A provider name: one plain token, never a path or a URL. */
const PROVIDER_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * A model id or `enabledModels` pattern in Pi's `--models` format: a bare model
 * id or `provider/modelId` (the id itself may hold more `/`, as in
 * `openrouter/anthropic/claude-3.5-sonnet`), with minimatch wildcards and an
 * optional `:thinking` suffix. Every segment starts with a letter or digit, so
 * an absolute path (`/home/...`), a `./` or `../` path, and a backslash path
 * are never displayed.
 */
const MODEL_SHAPE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9*?[][A-Za-z0-9._*?+@[\]!-]*(?::[A-Za-z]+)?$/;

/** An extension's last path segment: a plain file or package name, nothing else. */
const EXTENSION_SHAPE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

function extensionName(path: string): string | null {
	// An extension entry is a local path; a URL (which can carry userinfo) is not displayed at all.
	if (path.includes("://")) return null;
	return displayText(path.split(/[\\/]+/).filter((segment) => segment.length > 0).at(-1), EXTENSION_SHAPE);
}

/** A short display token of the given shape; too long, credential-shaped, or path-shaped is `null`, never cut. */
function displayText(value: unknown, shape: RegExp): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0 || text.length > PI_SETTINGS_LIMITS.text) return null;
	// `user:secret@host` and similar userinfo never cross.
	if (text.includes("@") && text.includes(":")) return null;
	return shape.test(text) ? text : null;
}

function bounded<T>(items: readonly T[], limit: number): { items: T[]; cut: boolean } {
	return { items: items.slice(0, limit), cut: items.length > limit };
}

function toView(manager: SettingsManager): PiSettingsView {
	const rawEnabled = manager.getEnabledModels();
	const enabled = Array.isArray(rawEnabled)
		? bounded(rawEnabled.map((entry) => displayText(entry, MODEL_SHAPE)).filter((value): value is string => value !== null), PI_SETTINGS_LIMITS.enabledModels)
		: undefined;
	// Pi's `getExtensionPaths()` spreads the merged value, so a hand-edited
	// string would come back as one entry per character; check the merged value itself.
	const rawExtensions = Array.isArray(manager.getSettings().extensions) ? manager.getExtensionPaths() : [];
	const extensionList = bounded(
		Array.isArray(rawExtensions)
			? rawExtensions.filter((entry): entry is string => typeof entry === "string").map(extensionName).filter((name): name is string => name !== null)
			: [],
		PI_SETTINGS_LIMITS.extensions,
	);
	const thinking = manager.getDefaultThinkingLevel();
	return {
		defaultProvider: displayText(manager.getDefaultProvider(), PROVIDER_SHAPE),
		defaultModel: displayText(manager.getDefaultModel(), MODEL_SHAPE),
		defaultThinkingLevel: typeof thinking === "string" && THINKING_LEVELS.includes(thinking) ? thinking : null,
		enabledModels: enabled === undefined ? null : enabled.items,
		extensions: extensionList.items,
		truncated: (enabled?.cut ?? false) || extensionList.cut,
	};
}

/**
 * The display settings Pi would run with, plus which layer files were usable.
 * When Pi's getters cannot read a merged value, the layers keep their own file
 * status (a missing file stays `missing`) and no view is returned.
 */
export function readPiSettings(input: { agentHome: string; cwd: string; projectTrusted: boolean }): PiSettingsRead {
	const paths = { global: globalPiSettingsPath(input.agentHome), project: projectPiSettingsPath(input.cwd) };
	const manager = SettingsManager.fromStorage(new ReadOnlySettingsStorage(paths), { projectTrusted: input.projectTrusted });
	const failed = new Set(manager.drainErrors().map((error) => error.scope));
	const status = (scope: "global" | "project"): PiSettingsLayerStatus => (!existsSync(paths[scope]) ? "missing" : failed.has(scope) ? "invalid" : "valid");
	let global = status("global");
	let projectStatus = input.projectTrusted ? status("project") : undefined;
	let view: PiSettingsView | undefined;
	if (global === "valid" || projectStatus === "valid") {
		try {
			view = toView(manager);
		} catch {
			// A value Pi's own getters reject makes every present layer unusable;
			// which one held it is unknown, and an absent file stays `missing`.
			if (global === "valid") global = "invalid";
			if (projectStatus === "valid") projectStatus = "invalid";
		}
	}
	return {
		global,
		...(projectStatus === undefined ? {} : { project: projectStatus }),
		...(view === undefined ? {} : { view }),
	};
}
