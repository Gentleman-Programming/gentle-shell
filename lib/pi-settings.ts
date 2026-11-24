// A read-only display projection of Pi's `settings.json` for Desktop: the
// default provider, model, and thinking level, the enabled model patterns, the
// configured package and extension names, the theme name, and whether a custom
// session directory is set. Nothing else crosses: no `sessionDir` value, no
// path, no command, no unknown key.
//
// Pi owns the file and its layering, so the read goes through Pi's exported
// `SettingsManager` (global `<agentDir>/settings.json` deep-merged with the
// project `<cwd>/<CONFIG_DIR_NAME>/settings.json` only when the project is
// trusted, plus Pi's own migrations). It is built over a read-only storage:
// `SettingsManager.create` takes a lock file next to `settings.json` even to
// read, and a Desktop read must never write, so this storage only reads the
// file and ignores any content the manager would write back. Package sources
// are classified by Pi's own source parser and named by the same wire-safe
// projection `get_update_status` uses (`packageDisplayName`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { packageDisplayName, type PackageKind } from "./desktop-rpc-updates.ts";

/** Pi's `SettingsStorage` contract: accepted by the exported `SettingsManager.fromStorage`, not exported by name. */
type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

export const PI_SETTINGS_LIMITS = Object.freeze({ enabledModels: 64, packages: 64, extensions: 64, text: 128 });

/** Pi's thinking levels; any other value is not displayed. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface PiSettingsPackage {
	name: string;
	kind: PackageKind;
}

export interface PiSettingsView {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: string | null;
	/** `null` when no layer sets `enabledModels` (every model is available). */
	enabledModels: string[] | null;
	packages: PiSettingsPackage[];
	extensions: string[];
	theme: string | null;
	customSessionDir: boolean;
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

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A short display token: never a path, URL, or control text; too long is dropped, not cut. */
function displayText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text.length === 0 || text.length > PI_SETTINGS_LIMITS.text || CONTROL_CHARACTERS.test(text)) return null;
	if (text.includes("://") || text.includes("\\") || text.startsWith("/") || text.startsWith("~") || text.startsWith(".") || /^[A-Za-z]:/.test(text)) return null;
	return text;
}

function bounded<T>(items: readonly T[], limit: number): { items: T[]; cut: boolean } {
	return { items: items.slice(0, limit), cut: items.length > limit };
}

interface ParsedSource { type?: unknown; name?: unknown; host?: unknown; path?: unknown }

/** Pi's own source parser; it is not typed public surface, so the call is guarded. */
function parseSource(manager: unknown, source: string): ParsedSource | undefined {
	const parse = (manager as { parseSource?: unknown }).parseSource;
	if (typeof parse !== "function") return undefined;
	try {
		const parsed = parse.call(manager, source);
		return parsed && typeof parsed === "object" ? (parsed as ParsedSource) : undefined;
	} catch {
		return undefined;
	}
}

function packageView(manager: unknown, entry: unknown): PiSettingsPackage {
	const source = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? (entry as { source?: unknown }).source : undefined;
	const parsed = typeof source === "string" ? parseSource(manager, source) : undefined;
	const type = parsed?.type;
	const kind: PackageKind = type === "npm" || type === "git" || type === "local" ? type : "unknown";
	const rawName = kind === "npm" ? parsed?.name : kind === "git" ? `${String(parsed?.host ?? "")}/${String(parsed?.path ?? "")}` : kind === "local" ? parsed?.path : undefined;
	return { name: packageDisplayName(kind, typeof rawName === "string" ? rawName : undefined), kind };
}

function project(manager: SettingsManager, packages: DefaultPackageManager): PiSettingsView {
	const rawEnabled = manager.getEnabledModels();
	const enabled = Array.isArray(rawEnabled) ? bounded(rawEnabled.map(displayText).filter((value): value is string => value !== null), PI_SETTINGS_LIMITS.enabledModels) : undefined;
	const rawPackages = manager.getPackages();
	const packageList = bounded(Array.isArray(rawPackages) ? rawPackages.map((entry) => packageView(packages, entry)) : [], PI_SETTINGS_LIMITS.packages);
	const rawExtensions = manager.getExtensionPaths();
	const extensionList = bounded(
		Array.isArray(rawExtensions) ? rawExtensions.filter((entry): entry is string => typeof entry === "string").map((entry) => packageDisplayName("local", entry)) : [],
		PI_SETTINGS_LIMITS.extensions,
	);
	const thinking = manager.getDefaultThinkingLevel();
	const sessionDir = manager.getSessionDir();
	return {
		defaultProvider: displayText(manager.getDefaultProvider()),
		defaultModel: displayText(manager.getDefaultModel()),
		defaultThinkingLevel: typeof thinking === "string" && THINKING_LEVELS.includes(thinking) ? thinking : null,
		enabledModels: enabled === undefined ? null : enabled.items,
		packages: packageList.items,
		extensions: extensionList.items,
		theme: displayText(manager.getTheme()),
		customSessionDir: typeof sessionDir === "string" && sessionDir.length > 0,
		truncated: (enabled?.cut ?? false) || packageList.cut || extensionList.cut,
	};
}

/** The display settings Pi would run with, plus which layer files were usable. */
export function readPiSettings(input: { agentHome: string; cwd: string; projectTrusted: boolean }): PiSettingsRead {
	const paths = { global: globalPiSettingsPath(input.agentHome), project: projectPiSettingsPath(input.cwd) };
	const manager = SettingsManager.fromStorage(new ReadOnlySettingsStorage(paths), { projectTrusted: input.projectTrusted });
	const failed = new Set(manager.drainErrors().map((error) => error.scope));
	const status = (scope: "global" | "project"): PiSettingsLayerStatus => (!existsSync(paths[scope]) ? "missing" : failed.has(scope) ? "invalid" : "valid");
	const global = status("global");
	const projectStatus = input.projectTrusted ? status("project") : undefined;
	const usable = global === "valid" || projectStatus === "valid";
	const packages = new DefaultPackageManager({ cwd: input.cwd, agentDir: input.agentHome, settingsManager: manager });
	return {
		global,
		...(projectStatus === undefined ? {} : { project: projectStatus }),
		...(usable ? { view: project(manager, packages) } : {}),
	};
}
