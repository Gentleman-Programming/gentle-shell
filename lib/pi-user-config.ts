// Pi's own user configuration files that Desktop clients edit through config
// stores instead of the file endpoints: the custom models file
// `<agentHome>/models.json` (`custom_models`) and the MCP servers files
// `<agentHome>/mcp.json` and `<cwd>/.pi/mcp.json` (`mcp`; the project one is
// read by Pi only in a trusted project, paths from `mcp-config.ts`).
//
// Validation is Pi's own: models documents are checked against the JSON schema
// Pi publishes with its package (`schemas/models.schema.json`, generated from the
// schema its loader compiles), and every MCP server entry goes through Pi's
// `validateMcpServerConfig`. The file-level rules around them mirror Pi's
// loaders (`ModelConfig.load`, the MCP extension's `readConfigFile`).
//
// Secrets never cross the wire: every string in a secret position is replaced by
// `SECRET_MARKER` on read, and a write that sends the marker back in the same
// position keeps the value the file holds there.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";

/** What a secret reads as; sent back in the same position, it keeps the stored value. */
export const SECRET_MARKER = "•••";

export type JsonRecord = Record<string, unknown>;

export type PiConfigFileRead = { status: "missing" } | { status: "invalid"; reason: string } | { status: "valid"; document: JsonRecord };

export function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy built from own entries, so a `__proto__` key stays a plain member. */
function mapRecord(record: JsonRecord, map: (key: string, value: unknown) => unknown): JsonRecord {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(key, value)]));
}

function own(record: unknown, key: string): unknown {
	return isJsonRecord(record) && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** The file's text without a byte-order mark, as Pi reads it; `undefined` when absent. */
function readText(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8");
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Writes a whole document, replacing the file atomically (owner-only mode, it may hold secrets). */
export function writePiConfigDocument(path: string, document: JsonRecord): void {
	writeJsonFileAtomicallySync(path, `${JSON.stringify(document, null, 2)}\n`);
}

/** Every string value of a string map (`headers`, `env`) becomes the marker. */
function redactStringMap(map: unknown): unknown {
	return isJsonRecord(map) ? mapRecord(map, (_key, value) => (typeof value === "string" ? SECRET_MARKER : value)) : map;
}

/** A secret the client did not see is kept: the marker becomes the stored value, if there is one. */
class MarkerError extends Error {}

function restoreSecret(value: unknown, current: unknown, where: string): unknown {
	if (value !== SECRET_MARKER) return value;
	if (typeof current !== "string") throw new MarkerError(`${where}: "${SECRET_MARKER}" keeps a stored value, and there is none`);
	return current;
}

function restoreStringMap(map: unknown, current: unknown, where: string): unknown {
	if (!isJsonRecord(map)) return map;
	return mapRecord(map, (key, value) => restoreSecret(value, own(current, key), `${where}.${key}`));
}

// ---- Custom models: <agentHome>/models.json ----

export function customModelsPath(agentHome: string): string {
	return join(agentHome, "models.json");
}

interface SchemaError {
	keyword: string;
	instancePath: string;
	message: string;
	params?: { requiredProperties?: string[] };
}

interface ModelsValidator {
	Check(value: unknown): boolean;
	Errors(value: unknown): Iterable<SchemaError>;
}

let modelsValidator: ModelsValidator | null | undefined;

/** Pi's published models.json schema, compiled once; `null` when this Pi ships none. */
function customModelsValidator(): ModelsValidator | null {
	if (modelsValidator !== undefined) return modelsValidator;
	try {
		const schema = JSON.parse(readFileSync(join(getPackageDir(), "schemas", "models.schema.json"), "utf8")) as TSchema;
		modelsValidator = Compile(schema) as unknown as ModelsValidator;
	} catch {
		modelsValidator = null;
	}
	return modelsValidator;
}

/** Pi's `stripJsonComments`: `//` line comments and trailing commas, string literals untouched. */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

/** The error Pi's loader reports, as `path: message` (`providers.x.models.0.id: …`). */
function schemaErrorLine(error: SchemaError): string {
	const base = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	const required = error.keyword === "required" ? error.params?.requiredProperties?.[0] : undefined;
	const path = required ? (base ? `${base}.${required}` : required) : base || "root";
	return `${path}: ${error.message}`;
}

/** Why Pi would refuse this models document, or `undefined` when it loads it. */
export function customModelsProblem(document: unknown): string | undefined {
	const validator = customModelsValidator();
	if (!validator) return "Pi's models.json schema is not available";
	if (validator.Check(document)) return undefined;
	const first = [...validator.Errors(document)][0];
	return first ? schemaErrorLine(first) : "does not match Pi's models.json schema";
}

/** Reads models.json as Pi's `ModelConfig.load` does: comments allowed, then Pi's schema. */
export function readCustomModels(agentHome: string): PiConfigFileRead {
	let text: string | undefined;
	try {
		text = readText(customModelsPath(agentHome));
	} catch {
		return { status: "invalid", reason: "unreadable" };
	}
	if (text === undefined) return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(text));
	} catch {
		return { status: "invalid", reason: "not JSON" };
	}
	const problem = customModelsProblem(parsed);
	if (problem !== undefined || !isJsonRecord(parsed)) return { status: "invalid", reason: problem ?? "not an object" };
	return { status: "valid", document: parsed };
}

function redactModelEntry(model: unknown): unknown {
	return isJsonRecord(model) ? mapRecord(model, (key, value) => (key === "headers" ? redactStringMap(value) : value)) : model;
}

function redactProvider(provider: unknown): unknown {
	if (!isJsonRecord(provider)) return provider;
	return mapRecord(provider, (key, value) => {
		if (key === "apiKey") return typeof value === "string" ? SECRET_MARKER : value;
		if (key === "headers") return redactStringMap(value);
		if (key === "models") return Array.isArray(value) ? value.map(redactModelEntry) : value;
		if (key === "modelOverrides") return isJsonRecord(value) ? mapRecord(value, (_id, entry) => redactModelEntry(entry)) : value;
		return value;
	});
}

/** The document a client sees: `apiKey` and every header value become the marker. */
export function redactCustomModels(document: JsonRecord): JsonRecord {
	return mapRecord(document, (key, value) => (key === "providers" && isJsonRecord(value) ? mapRecord(value, (_id, provider) => redactProvider(provider)) : value));
}

function currentModel(provider: unknown, id: unknown): unknown {
	const models = own(provider, "models");
	return Array.isArray(models) ? models.find((model) => isJsonRecord(model) && model.id === id) : undefined;
}

function restoreProvider(provider: unknown, current: unknown, where: string): unknown {
	if (!isJsonRecord(provider)) return provider;
	return mapRecord(provider, (key, value) => {
		if (key === "apiKey") return restoreSecret(value, own(current, "apiKey"), `${where}.apiKey`);
		if (key === "headers") return restoreStringMap(value, own(current, "headers"), `${where}.headers`);
		if (key === "models" && Array.isArray(value)) {
			// Models are matched by id, so a client may reorder them.
			return value.map((model, index) => isJsonRecord(model)
				? mapRecord(model, (field, entry) => field === "headers" ? restoreStringMap(entry, own(currentModel(current, model.id), "headers"), `${where}.models.${index}.headers`) : entry)
				: model);
		}
		if (key === "modelOverrides" && isJsonRecord(value)) {
			return mapRecord(value, (id, override) => isJsonRecord(override)
				? mapRecord(override, (field, entry) => field === "headers" ? restoreStringMap(entry, own(own(own(current, "modelOverrides"), id), "headers"), `${where}.modelOverrides.${id}.headers`) : entry)
				: override);
		}
		return value;
	});
}

export type RestoreResult = { document: JsonRecord } | { error: string };

/** A client document with every marker replaced by the stored secret at the same place. */
export function restoreCustomModels(document: unknown, current: JsonRecord | undefined): RestoreResult {
	if (!isJsonRecord(document)) return { error: "root: must be an object" };
	try {
		return {
			document: mapRecord(document, (key, value) => key === "providers" && isJsonRecord(value)
				? mapRecord(value, (id, provider) => restoreProvider(provider, own(own(current, "providers"), id), `providers.${id}`))
				: value),
		};
	} catch (error) {
		if (error instanceof MarkerError) return { error: error.message };
		throw error;
	}
}

// ---- MCP servers: <agentHome>/mcp.json and <cwd>/.pi/mcp.json ----

export type McpLayer = "global" | "project";

type McpServerValidator = (name: string, raw: unknown) => unknown;

let mcpValidator: McpServerValidator | null | undefined;

/** Pi's `validateMcpServerConfig` (pi-mcp's shared fields plus Pi's own); `null` when this Pi has none. */
function mcpServerValidator(): McpServerValidator | null {
	if (mcpValidator !== undefined) return mcpValidator;
	try {
		const file = join(getPackageDir(), "dist", "core", "mcp-servers.js");
		const validate = own(createRequire(file)(file), "validateMcpServerConfig");
		mcpValidator = typeof validate === "function" ? (validate as McpServerValidator) : null;
	} catch {
		mcpValidator = null;
	}
	return mcpValidator;
}

/** Reads an mcp.json as Pi's MCP extension does: a JSON object whose `mcpServers`, if any, is an object. */
export function readMcpLayer(path: string): PiConfigFileRead {
	let text: string | undefined;
	try {
		text = readText(path);
	} catch {
		return { status: "invalid", reason: "unreadable" };
	}
	if (text === undefined) return { status: "missing" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { status: "invalid", reason: "not JSON" };
	}
	if (!isJsonRecord(parsed) || (parsed.mcpServers !== undefined && !isJsonRecord(parsed.mcpServers))) {
		return { status: "invalid", reason: 'expected an object with an "mcpServers" object' };
	}
	return { status: "valid", document: parsed };
}

/** A server URL carrying userinfo or a query string may hold a credential, so it crosses only as the marker. */
function urlMayHoldSecret(url: string): boolean {
	if (!URL.canParse(url)) return false;
	const parsed = new URL(url);
	return parsed.username !== "" || parsed.password !== "" || parsed.search !== "";
}

function redactMcpServer(server: unknown): unknown {
	if (!isJsonRecord(server)) return server;
	return mapRecord(server, (key, value) => {
		if (key === "env" || key === "headers") return redactStringMap(value);
		if (key === "url" && typeof value === "string" && urlMayHoldSecret(value)) return SECRET_MARKER;
		if (key === "oauth" && isJsonRecord(value)) return mapRecord(value, (field, entry) => (field === "clientSecret" && typeof entry === "string" ? SECRET_MARKER : entry));
		return value;
	});
}

/** The document a client sees: `env` and `headers` values, `oauth.clientSecret`, and a URL with userinfo or a query become the marker. */
export function redactMcpDocument(document: JsonRecord): JsonRecord {
	return mapRecord(document, (key, value) => (key === "mcpServers" && isJsonRecord(value) ? mapRecord(value, (_name, server) => redactMcpServer(server)) : value));
}

function restoreMcpServer(server: unknown, current: unknown, where: string): unknown {
	if (!isJsonRecord(server)) return server;
	return mapRecord(server, (key, value) => {
		if (key === "env" || key === "headers") return restoreStringMap(value, own(current, key), `${where}.${key}`);
		if (key === "url") return restoreSecret(value, own(current, key), `${where}.url`);
		if (key === "oauth" && isJsonRecord(value)) {
			return mapRecord(value, (field, entry) => field === "clientSecret" ? restoreSecret(entry, own(own(current, "oauth"), "clientSecret"), `${where}.oauth.clientSecret`) : entry);
		}
		return value;
	});
}

/** A client document with every marker replaced by the stored secret of the same server. */
export function restoreMcpDocument(document: unknown, current: JsonRecord | undefined): RestoreResult {
	if (!isJsonRecord(document)) return { error: "root: must be an object" };
	try {
		return {
			document: mapRecord(document, (key, value) => key === "mcpServers" && isJsonRecord(value)
				? mapRecord(value, (name, server) => restoreMcpServer(server, own(own(current, "mcpServers"), name), `mcpServers.${name}`))
				: value),
		};
	} catch (error) {
		if (error instanceof MarkerError) return { error: error.message };
		throw error;
	}
}

const MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];

/** pi-mcp's `mcpNamespace`: names that differ only in `-` and `_` share one. */
function mcpNamespace(name: string): string {
	return `mcp__${name.replace(/-/g, "_")}`;
}

/**
 * The servers a layer contributes, and the problems Pi's loader would report for
 * it, by the loader's own rules: a project entry without a transport overrides
 * `enabled`/`exposure`/`toolExposure` of a global server, `auth` is global-only,
 * and names sharing a namespace clash. `base` holds the global servers when the
 * layer is the project one.
 */
export function collectMcpServers(document: JsonRecord, layer: McpLayer, base: ReadonlyMap<string, JsonRecord> = new Map()): { servers: Map<string, JsonRecord>; problems: string[] } {
	const servers = new Map(base);
	const problems: string[] = [];
	const validate = mcpServerValidator();
	if (!validate) return { servers, problems: ["Pi's MCP server validator is not available"] };
	if (document.mcpServers !== undefined && !isJsonRecord(document.mcpServers)) return { servers, problems: ['expected an object with an "mcpServers" object'] };
	if (document.autoEnableCodemode !== undefined && typeof document.autoEnableCodemode !== "boolean") problems.push("autoEnableCodemode must be a boolean");
	for (const [name, value] of Object.entries((document.mcpServers ?? {}) as JsonRecord)) {
		// pi-mcp's `isMcpServerOverride`: an entry that names no transport.
		if (layer === "project" && isJsonRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined) {
			const global = base.get(name);
			const extra = Object.keys(value).filter((key) => !MCP_OVERRIDE_KEYS.includes(key));
			if (!global) problems.push(`server "${name}" needs "command" or "url", or a global server to override`);
			else if (extra.length > 0) problems.push(`server "${name}": an override can only set ${MCP_OVERRIDE_KEYS.join(", ")}`);
			else {
				const config = validate(name, { ...global, ...value });
				if (typeof config === "string") problems.push(config);
				else servers.set(name, config as JsonRecord);
			}
			continue;
		}
		const config = validate(name, value);
		if (typeof config === "string") {
			problems.push(config);
			continue;
		}
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash) {
			problems.push(`server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (layer === "project" && isJsonRecord(config) && "url" in config && config.auth) {
			problems.push(`server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		servers.set(name, config as JsonRecord);
	}
	return { servers, problems };
}
