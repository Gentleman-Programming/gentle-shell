// Orchestrator selection for agent-model profiles.
//
// A profile is a complete snapshot of the routing, and the orchestrator is part
// of that routing. Unlike every agent, the orchestrator does not live in
// `models.json`: Pi keeps it in its own global `settings.json` as
// `defaultProvider` / `defaultModel` / `defaultThinkingLevel`. This module owns
// reading and writing those three keys and nothing else.
//
// The write is deliberately conservative. It re-serializes the whole file so
// every unrelated key Pi and other extensions own (`packages`, telemetry
// settings, theme, terminal options) survives, it refuses to touch a file it
// cannot parse instead of replacing it with a fresh object, and it swaps the
// destination through a sibling temp file plus a rename so an interrupted write
// can never leave truncated JSON behind.

import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	isThinkingLevel,
	normalizeModelId,
	type AgentRoutingEntry,
	type ThinkingLevel,
} from "./model-routing-authority.ts";

/** The three Pi settings keys a profile's orchestrator entry owns. */
export const ORCHESTRATOR_SETTINGS_KEYS = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
] as const;

export interface OrchestratorModelRef {
	provider: string;
	model: string;
}

/**
 * Split a `provider/model` routing id. A profile entry stores one opaque model
 * id, while Pi stores the two halves separately, so the split happens here and
 * only here. Ids without a provider half are rejected rather than guessed: an
 * orchestrator write is not the place to invent a provider.
 */
export function parseOrchestratorModelRef(modelId: unknown): OrchestratorModelRef | undefined {
	const normalized = normalizeModelId(modelId);
	if (normalized === undefined) return undefined;
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) return undefined;
	return {
		provider: normalized.slice(0, separator),
		model: normalized.slice(separator + 1),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type OrchestratorSettingsReadResult =
	| { status: "missing" }
	| { status: "invalid"; reason: string }
	| { status: "valid"; entry?: AgentRoutingEntry; value: Record<string, unknown> };

/**
 * Read the effective orchestrator selection from a Pi settings file. A settings
 * file that is absent or unreadable is reported, never silently treated as
 * "no orchestrator": the panel has to distinguish "not set" from "cannot tell".
 */
export function readOrchestratorSettings(settingsPath: string): OrchestratorSettingsReadResult {
	if (!existsSync(settingsPath)) return { status: "missing" };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		return { status: "invalid", reason: describeError(error) };
	}
	if (!isRecord(value)) return { status: "invalid", reason: "the file is not a JSON object" };
	const provider = value.defaultProvider;
	const model = value.defaultModel;
	if (typeof provider !== "string" || typeof model !== "string") {
		return { status: "valid", entry: undefined, value };
	}
	if (provider.length === 0 || model.length === 0) {
		return { status: "valid", entry: undefined, value };
	}
	const entry: AgentRoutingEntry = { model: `${provider}/${model}` };
	if (isThinkingLevel(value.defaultThinkingLevel)) entry.thinking = value.defaultThinkingLevel;
	return { status: "valid", entry, value };
}

export type OrchestratorSettingsWriteResult =
	| { status: "invalid"; reason: string }
	| { status: "unchanged" }
	| { status: "written"; previous?: string };

/**
 * Persist one orchestrator routing entry into a Pi settings file.
 *
 * `entry` is a profile routing entry: `{ model?, thinking? }`. A missing model
 * means the profile says nothing about the orchestrator, so the file is left
 * exactly as it was — a profile without an orchestrator entry must never move
 * the orchestrator, not even to "unset".
 *
 * `previous` carries the raw bytes that were there before a successful write so
 * the caller can honour its own revert contract. `undefined` means the file did
 * not exist and restoring means removing it.
 */
export function applyOrchestratorSettings(
	settingsPath: string,
	entry: AgentRoutingEntry,
): OrchestratorSettingsWriteResult {
	if (entry.model === undefined) return { status: "unchanged" };
	const reference = parseOrchestratorModelRef(entry.model);
	if (reference === undefined) {
		return {
			status: "invalid",
			reason: `model id ${JSON.stringify(entry.model)} is not a provider/model pair`,
		};
	}
	const read = readOrchestratorSettings(settingsPath);
	if (read.status === "invalid") return { status: "invalid", reason: read.reason };
	// Safe after the invalid check above: the file either parses as an object or
	// does not exist, and a missing file means there is nothing to restore.
	const previous = readPrevious(settingsPath);
	const next: Record<string, unknown> = { ...(read.status === "valid" ? read.value : {}) };
	next.defaultProvider = reference.provider;
	next.defaultModel = reference.model;
	if (entry.thinking === undefined) delete next.defaultThinkingLevel;
	else next.defaultThinkingLevel = entry.thinking;
	const text = `${JSON.stringify(next, null, 2)}\n`;
	if (previous === text) return { status: "unchanged" };
	writeFileAtomically(settingsPath, text);
	return { status: "written", previous };
}

/**
 * The model defaults Configuration › Models edits: the orchestrator's three keys
 * plus Pi's `enabledModels` (the scoped models Ctrl+P cycles). Absent means unset.
 */
export interface PiModelDefaults {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	enabledModels?: string[];
}

export const PI_MODEL_DEFAULTS_KEYS = [...ORCHESTRATOR_SETTINGS_KEYS, "enabledModels"] as const;

const MODEL_DEFAULT_TEXT_MAX = 256;
const ENABLED_MODELS_MAX = 512;

function isModelDefaultText(value: unknown): value is string {
	// eslint-disable-next-line no-control-regex
	return typeof value === "string" && value.trim().length > 0 && value.length <= MODEL_DEFAULT_TEXT_MAX && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The model defaults a settings object holds, each key only when it has the
 * shape Pi reads; a mistyped key reads as unset, exactly as Pi treats it.
 */
export function projectPiModelDefaults(settings: Record<string, unknown>): PiModelDefaults {
	const defaults: PiModelDefaults = {};
	if (isModelDefaultText(settings.defaultProvider)) defaults.defaultProvider = settings.defaultProvider;
	if (isModelDefaultText(settings.defaultModel)) defaults.defaultModel = settings.defaultModel;
	if (isThinkingLevel(settings.defaultThinkingLevel)) defaults.defaultThinkingLevel = settings.defaultThinkingLevel;
	if (Array.isArray(settings.enabledModels) && settings.enabledModels.every(isModelDefaultText)) defaults.enabledModels = [...settings.enabledModels];
	return defaults;
}

/**
 * A complete model-defaults write: only the four keys, each well-formed, no
 * duplicate scoped model. `undefined` for anything else.
 */
export function parsePiModelDefaults(value: unknown): PiModelDefaults | undefined {
	if (!isRecord(value)) return undefined;
	if (!Object.keys(value).every((key) => (PI_MODEL_DEFAULTS_KEYS as readonly string[]).includes(key))) return undefined;
	const { defaultProvider, defaultModel, defaultThinkingLevel, enabledModels } = value;
	if (defaultProvider !== undefined && !isModelDefaultText(defaultProvider)) return undefined;
	if (defaultModel !== undefined && !isModelDefaultText(defaultModel)) return undefined;
	if (defaultThinkingLevel !== undefined && !isThinkingLevel(defaultThinkingLevel)) return undefined;
	if (enabledModels !== undefined) {
		if (!Array.isArray(enabledModels) || enabledModels.length > ENABLED_MODELS_MAX || !enabledModels.every(isModelDefaultText)) return undefined;
		if (new Set(enabledModels).size !== enabledModels.length) return undefined;
	}
	return projectPiModelDefaults(value);
}

/**
 * Replace the model defaults in a Pi settings file: the four keys become exactly
 * `defaults` (an absent key is removed), every other key is kept, and a file
 * that is not a JSON object is refused, never replaced.
 */
export function writePiModelDefaults(settingsPath: string, defaults: PiModelDefaults): OrchestratorSettingsWriteResult {
	const read = readOrchestratorSettings(settingsPath);
	if (read.status === "invalid") return { status: "invalid", reason: read.reason };
	const previous = readPrevious(settingsPath);
	const next: Record<string, unknown> = { ...(read.status === "valid" ? read.value : {}) };
	for (const key of PI_MODEL_DEFAULTS_KEYS) {
		if (defaults[key] === undefined) delete next[key];
		else next[key] = defaults[key];
	}
	const text = `${JSON.stringify(next, null, 2)}\n`;
	if (previous === text) return { status: "unchanged" };
	writeFileAtomically(settingsPath, text);
	return { status: "written", previous };
}

function readPrevious(settingsPath: string): string | undefined {
	try {
		return readFileSync(settingsPath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Restore the bytes a successful orchestrator write replaced. `undefined` means
 * the write created the file, so restoring removes it.
 */
export function restoreOrchestratorSettings(
	settingsPath: string,
	previous: string | undefined,
): void {
	if (previous === undefined) {
		try {
			unlinkSync(settingsPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return;
	}
	writeFileAtomically(settingsPath, previous);
}

/**
 * Sibling temp file plus rename, with the same failure discipline as the profile
 * store: every step records its own error, cleanup never throws, and the error
 * that actually broke the write is the one reported.
 */
function writeFileAtomically(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const descriptor = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	const failures: unknown[] = [];
	try {
		writeFileSync(descriptor, text);
	} catch (error) {
		failures.push(error);
	}
	try {
		closeSync(descriptor);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 0) {
		try {
			renameSync(temporary, path);
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		unlinkSync(temporary);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
	}
	if (failures.length > 0) throw failures[0];
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
