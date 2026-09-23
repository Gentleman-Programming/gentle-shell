// Agent-model profiles: named, switchable snapshots of the global
// `models.json` routing behind `/gentle:profiles`. The store lives at
// `<configHome>/profiles.json` and single-profile exports at
// `<configHome>/profiles.export.json`. Everything here is pure except the two
// path helpers and the thin read/write wrappers at the bottom; the extension
// panel owns all TUI and orchestration concerns.

import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	normalizeModelConfig,
	type AgentModelConfig,
	type AgentRoutingEntry,
} from "./model-routing-authority.ts";

export const PROFILES_KIND = "gentle-pi.agent_model_profiles";
export const PROFILES_VERSION = 1;
export const PROFILE_EXPORT_KIND = "gentle-pi.agent_model_profile";
export const PROFILE_EXPORT_VERSION = 1;

export interface AgentProfilesFile {
	kind: typeof PROFILES_KIND;
	version: typeof PROFILES_VERSION;
	active?: string;
	profiles: Record<string, AgentModelConfig>;
}

export type AgentProfileErrorCode =
	| "invalid_name"
	| "duplicate_name"
	| "missing_profile"
	| "active_profile";

export class AgentProfileError extends Error {
	readonly code: AgentProfileErrorCode;

	constructor(code: AgentProfileErrorCode, message: string) {
		super(message);
		this.name = "AgentProfileError";
		this.code = code;
	}
}

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Names that pass the slug pattern would still collide with object prototype
// members when used as record keys, so they are rejected explicitly.
const RESERVED_PROFILE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const INHERIT_MODEL_LABEL = "inherit";

/**
 * Reserved routing key for the orchestrator selection.
 *
 * A profile is a complete snapshot of the routing, and the orchestrator is part
 * of it, but the orchestrator is not an agent: it is never written to
 * `subagents.json`, never has an agent file, and its model lives in Pi's global
 * `settings.json`. The key is reserved so the routing map can carry it while
 * every agent-facing path skips it.
 */
export const PROFILE_ORCHESTRATOR_KEY = "orchestrator";

export function isProfileOrchestratorKey(key: string): boolean {
	return key === PROFILE_ORCHESTRATOR_KEY;
}

/** The profile's own orchestrator entry, when the profile defines one. */
export function readProfileOrchestrator(
	config: AgentModelConfig,
): AgentRoutingEntry | undefined {
	if (!Object.prototype.hasOwnProperty.call(config, PROFILE_ORCHESTRATOR_KEY)) return undefined;
	const entry = config[PROFILE_ORCHESTRATOR_KEY];
	return entry && Object.keys(entry).length > 0 ? entry : undefined;
}

/**
 * The routing map without its reserved orchestrator key, for every caller that
 * counts or lists roles: the orchestrator is not a role.
 */
export function profileRoleEntries(config: AgentModelConfig): Array<[string, AgentRoutingEntry]> {
	return Object.entries(config).filter(([agent]) => !isProfileOrchestratorKey(agent));
}

export function isValidProfileName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		PROFILE_NAME_PATTERN.test(value) &&
		!RESERVED_PROFILE_NAMES.has(value)
	);
}

export function emptyProfilesFile(): AgentProfilesFile {
	return { kind: PROFILES_KIND, version: PROFILES_VERSION, active: undefined, profiles: {} };
}

// ---- Parse and normalize ----

export interface ProfilesParseDrops {
	droppedProfiles: string[];
	droppedAgents: Array<{ profile: string; agent: string }>;
	/** An `active` marker that did not name a normalized profile, when present. */
	droppedActive?: string;
}

export interface NormalizedProfilesFile {
	file: AgentProfilesFile;
	drops: ProfilesParseDrops;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function requireValidName(name: string): string {
	if (!isValidProfileName(name)) {
		throw new AgentProfileError(
			"invalid_name",
			`Invalid profile name: ${JSON.stringify(name)}. Use 1-64 characters (letters, numbers, '.', '_', '-') starting with a letter or number.`,
		);
	}
	return name;
}

export function normalizeProfilesFile(value: unknown): NormalizedProfilesFile | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind !== PROFILES_KIND || value.version !== PROFILES_VERSION) return undefined;
	const rawProfiles = value.profiles;
	if (!isRecord(rawProfiles)) return undefined;
	const profiles: Record<string, AgentModelConfig> = {};
	const drops: ProfilesParseDrops = { droppedProfiles: [], droppedAgents: [] };
	for (const [name, rawConfig] of Object.entries(rawProfiles)) {
		if (!isValidProfileName(name)) {
			drops.droppedProfiles.push(name);
			continue;
		}
		const config = normalizeModelConfig(rawConfig);
		if (!config) {
			drops.droppedProfiles.push(name);
			continue;
		}
		for (const agent of Object.keys(isRecord(rawConfig) ? rawConfig : {})) {
			if (!hasOwn(config, agent)) drops.droppedAgents.push({ profile: name, agent });
		}
		profiles[name] = config;
	}
	let active: string | undefined;
	if (value.active !== undefined) {
		if (
			typeof value.active === "string" &&
			isValidProfileName(value.active) &&
			hasOwn(profiles, value.active)
		) {
			active = value.active;
		} else {
			// Never clear the marker silently: a stale `active` is exactly the state
			// an operator needs to see, not have disappear.
			drops.droppedActive =
				typeof value.active === "string" ? value.active : JSON.stringify(value.active);
		}
	}
	return { file: { kind: PROFILES_KIND, version: PROFILES_VERSION, active, profiles }, drops };
}

export type ProfilesFileParseResult =
	| { status: "invalid" }
	| { status: "valid"; file: AgentProfilesFile };

export function parseProfilesFileText(text: string): ProfilesFileParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { status: "invalid" };
	}
	const file = normalizeProfilesFile(value)?.file;
	return file ? { status: "valid", file } : { status: "invalid" };
}

function cloneProfileConfig(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(
		Object.entries(config).map(([agent, entry]) => [agent, { ...entry }]),
	);
}

function cloneProfiles(
	profiles: Record<string, AgentModelConfig>,
): Record<string, AgentModelConfig> {
	return Object.fromEntries(
		Object.entries(profiles).map(([name, config]) => [name, cloneProfileConfig(config)]),
	);
}

export function serializeProfilesFile(file: AgentProfilesFile): string {
	const payload: Record<string, unknown> = {
		kind: file.kind,
		version: file.version,
		profiles: cloneProfiles(file.profiles),
	};
	if (file.active !== undefined) payload.active = file.active;
	return `${JSON.stringify(payload, null, 2)}\n`;
}

// ---- Store mutations (each returns a new file and never mutates the input) ----

export function createProfile(
	file: AgentProfilesFile,
	name: string,
	config: AgentModelConfig,
): AgentProfilesFile {
	requireValidName(name);
	if (hasOwn(file.profiles, name)) {
		throw new AgentProfileError("duplicate_name", `Profile already exists: ${name}.`);
	}
	return { ...file, profiles: { ...file.profiles, [name]: cloneProfileConfig(config) } };
}

export function updateProfile(
	file: AgentProfilesFile,
	name: string,
	config: AgentModelConfig,
): AgentProfilesFile {
	requireValidName(name);
	if (!hasOwn(file.profiles, name)) {
		throw new AgentProfileError("missing_profile", `Profile does not exist: ${name}.`);
	}
	return { ...file, profiles: { ...file.profiles, [name]: cloneProfileConfig(config) } };
}

export function duplicateProfile(
	file: AgentProfilesFile,
	from: string,
	to: string,
): AgentProfilesFile {
	requireValidName(from);
	if (!hasOwn(file.profiles, from)) {
		throw new AgentProfileError("missing_profile", `Profile does not exist: ${from}.`);
	}
	requireValidName(to);
	if (hasOwn(file.profiles, to)) {
		throw new AgentProfileError("duplicate_name", `Profile already exists: ${to}.`);
	}
	return createProfile(file, to, file.profiles[from]);
}

export function renameProfile(
	file: AgentProfilesFile,
	from: string,
	to: string,
): AgentProfilesFile {
	requireValidName(from);
	if (!hasOwn(file.profiles, from)) {
		throw new AgentProfileError("missing_profile", `Profile does not exist: ${from}.`);
	}
	requireValidName(to);
	if (hasOwn(file.profiles, to)) {
		throw new AgentProfileError("duplicate_name", `Profile already exists: ${to}.`);
	}
	const profiles = Object.fromEntries(
		Object.entries(file.profiles).map(([name, config]) => [
			name === from ? to : name,
			cloneProfileConfig(config),
		]),
	);
	return {
		...file,
		active: file.active === from ? to : file.active,
		profiles,
	};
}

export function deleteProfile(file: AgentProfilesFile, name: string): AgentProfilesFile {
	requireValidName(name);
	if (!hasOwn(file.profiles, name)) {
		throw new AgentProfileError("missing_profile", `Profile does not exist: ${name}.`);
	}
	if (file.active === name) {
		throw new AgentProfileError(
			"active_profile",
			`Profile ${name} is active. Apply another profile before deleting it.`,
		);
	}
	return {
		...file,
		profiles: Object.fromEntries(
			Object.entries(file.profiles).filter(([profileName]) => profileName !== name),
		),
	};
}

export function setActiveProfile(file: AgentProfilesFile, name: string): AgentProfilesFile {
	requireValidName(name);
	if (!hasOwn(file.profiles, name)) {
		throw new AgentProfileError("missing_profile", `Profile does not exist: ${name}.`);
	}
	return { ...file, active: name };
}

// ---- Summaries and panel decision helpers ----

export interface ProfileModelSummary {
	model: string;
	count: number;
	roles: string[];
}

export interface ProfileSummary {
	models: ProfileModelSummary[];
	total: number;
}

export function summarizeProfile(config: AgentModelConfig): ProfileSummary {
	const byModel = new Map<string, string[]>();
	for (const [agent, entry] of profileRoleEntries(config)) {
		const model = entry?.model ?? INHERIT_MODEL_LABEL;
		const roles = byModel.get(model);
		if (roles) roles.push(agent);
		else byModel.set(model, [agent]);
	}
	const models = [...byModel.entries()]
		.map(([model, roles]) => ({
			model,
			count: roles.length,
			roles: [...roles].sort((left, right) => left.localeCompare(right)),
		}))
		.sort(
			(left, right) =>
				right.count - left.count || left.model.localeCompare(right.model),
		);
	return { models, total: models.reduce((sum, model) => sum + model.count, 0) };
}

export function formatProfileSummaryLines(summary: ProfileSummary): string[] {
	if (summary.total === 0) {
		return ["No routing entries — every agent inherits its default model."];
	}
	return summary.models.map(
		(model) =>
			`${model.count} ${model.count === 1 ? "agent" : "agents"} → ${model.model}: ${model.roles.join(", ")}`,
	);
}

export interface ProfileRoutingRow {
	agent: string;
	model: string;
	thinking: string;
}

/**
 * One row per agent, in a stable alphabetical order so the profile's routing and
 * the effective routing can be compared line by line, and with the reserved
 * orchestrator key excluded because it is rendered on its own line.
 */
export function profileRoutingRows(config: AgentModelConfig): ProfileRoutingRow[] {
	return profileRoleEntries(config)
		.map(([agent, entry]) => ({
			agent,
			model: entry?.model ?? INHERIT_MODEL_LABEL,
			thinking: entry?.thinking ?? INHERIT_MODEL_LABEL,
		}))
		.sort((left, right) => left.agent.localeCompare(right.agent));
}

/**
 * Column widths shared by every routing table in one panel, so the profile's
 * routing and the effective routing align column for column instead of each
 * section sizing itself.
 */
export function routingColumnWidths(
	...groups: ProfileRoutingRow[][]
): { agent: number; model: number } {
	const rows = groups.flat();
	return {
		agent: rows.reduce((width, row) => Math.max(width, row.agent.length), 0),
		model: rows.reduce((width, row) => Math.max(width, row.model.length), 0),
	};
}

export function formatRoutingRow(
	row: ProfileRoutingRow,
	widths: { agent: number; model: number },
): string {
	return `${row.agent.padEnd(widths.agent)}  ${row.model.padEnd(widths.model)}  ${row.thinking}`;
}

/**
 * A single line describing an orchestrator selection, for the panel header. The
 * label distinguishes "this profile sets nothing" from "settings.json cannot be
 * read", which are different operator states.
 */
export function formatOrchestratorSelection(entry: AgentRoutingEntry | undefined): string {
	if (entry?.model === undefined) {
		return entry?.thinking === undefined
			? INHERIT_MODEL_LABEL
			: `${INHERIT_MODEL_LABEL} · ${entry.thinking}`;
	}
	return entry.thinking === undefined ? entry.model : `${entry.model} · ${entry.thinking}`;
}

export interface ProfileListItem {
	id: string;
	label: string;
	description: string;
}

export function buildProfileListItems(
	file: AgentProfilesFile,
	pinned?: string,
): ProfileListItem[] {
	return Object.entries(file.profiles).map(([name, config]) => {
		const roles = profileRoleEntries(config).length;
		const active = name === file.active ? `${name} (active)` : name;
		return {
			id: name,
			// A pinned profile is the one this repository launches with, which is not the
			// same thing as the globally active profile, so both are named.
			label: name === pinned ? `${active} (pinned)` : active,
			description: `${roles} ${roles === 1 ? "role" : "roles"}`,
		};
	});
}

export function bootstrapProfilesFile(currentConfig: AgentModelConfig): AgentProfilesFile {
	const config = normalizeModelConfig(currentConfig) ?? {};
	const file = createProfile(emptyProfilesFile(), "current", config);
	return Object.keys(config).length > 0 ? setActiveProfile(file, "current") : file;
}

// ---- Single-profile export ----

export interface ProfileExport {
	name: string;
	config: AgentModelConfig;
}

export interface ProfileExportParseResult extends ProfileExport {
	droppedAgents: string[];
}

export function serializeProfileExport(name: string, config: AgentModelConfig): string {
	requireValidName(name);
	return `${JSON.stringify(
		{
			kind: PROFILE_EXPORT_KIND,
			version: PROFILE_EXPORT_VERSION,
			name,
			config: cloneProfileConfig(config),
		},
		null,
		2,
	)}\n`;
}

export function parseProfileExportTextWithDrops(
	text: string,
): ProfileExportParseResult | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	if (value.kind !== PROFILE_EXPORT_KIND || value.version !== PROFILE_EXPORT_VERSION) {
		return undefined;
	}
	if (!isValidProfileName(value.name) || !isRecord(value.config)) return undefined;
	const config = normalizeModelConfig(value.config);
	if (!config) return undefined;
	const droppedAgents = Object.keys(value.config).filter(
		(agent) => !hasOwn(config, agent),
	);
	return { name: value.name, config, droppedAgents };
}

export function parseProfileExportText(text: string): ProfileExport | undefined {
	const result = parseProfileExportTextWithDrops(text);
	return result ? { name: result.name, config: result.config } : undefined;
}

// ---- Path helpers and file wrappers ----

export type ProfilesFileReadResult =
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "valid"; file: AgentProfilesFile; drops: ProfilesParseDrops };

export function profilesFilePath(configHome: string): string {
	return join(configHome, "profiles.json");
}

export function profileExportPath(configHome: string): string {
	return join(configHome, "profiles.export.json");
}

export function readProfilesFileResult(path: string): ProfilesFileReadResult {
	if (!existsSync(path)) return { status: "missing" };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { status: "invalid" };
	}
	// Parse through normalizeProfilesFile so the caller can name every entry
	// dropped by normalization instead of losing it silently.
	const normalized = normalizeProfilesFile(value);
	if (!normalized) return { status: "invalid" };
	return { status: "valid", file: normalized.file, drops: normalized.drops };
}

/**
 * Replace a JSON store through a sibling temp file and a rename. A direct write
 * that is interrupted leaves truncated JSON, which the readers must then reject as
 * unreadable, so the destination is only ever swapped for a complete file and the
 * temp file is removed on every failure path. Shared by the profiles store and the
 * per-repository profile pin so both stores keep the same atomicity guarantee.
 */
export function writeJsonFileAtomicallySync(path: string, text: string): void {
	// Replacing a file with identical bytes is not a change, so it is skipped instead
	// of churning the mtime. Pin writes are the reason this matters: re-applying the
	// profile a repository already pins must not touch the pin file. An unreadable or
	// missing destination simply falls through to the atomic write below.
	try {
		if (readFileSync(path, "utf8") === text) return;
	} catch {
		// Fall through: the file is absent or not readable as text.
	}
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const descriptor = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	// Every step records its own failure and cleanup never throws, so the error
	// that actually broke the write is the one reported: a failing close or unlink
	// must not mask a failed write or rename, and the temp file is removed on every
	// path.
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

export function writeProfilesFileSync(path: string, file: AgentProfilesFile): void {
	writeJsonFileAtomicallySync(path, serializeProfilesFile(file));
}
