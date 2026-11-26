// A read-only display projection of the MCP servers a Pi session would load
// from `mcp.json`: name, transport, and enabled, nothing else.
//
// Pi owns `mcp.json` (its built-in MCP extension, `loadMcpConfig` in
// `@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js`), but that
// loader is not part of Pi's package exports, so this module mirrors its
// resolution instead of importing it:
//
// - the global file is `<agentDir>/mcp.json`; the project file
//   `<cwd>/<CONFIG_DIR_NAME>/mcp.json` is read only when the session trusts the
//   project (`ctx.isProjectTrusted()`), exactly as Pi passes `projectTrusted`;
// - project entries replace global entries with the same name, keeping the
//   global entry's position (a `Map`, like Pi);
// - a project entry without `command`, `url`, or `type` overrides only
//   `enabled`, `exposure`, and `toolExposure` of an existing global server;
// - an entry Pi would reject is skipped while the rest of the file still
//   loads; a file that is not JSON or not an object with an `mcpServers`
//   object loads nothing.
//
// Per-entry validation ports Pi's `validateMcpServerConfig` (pi-mcp's field
// checks, OAuth included, plus pi's exposure and `auth` checks), the namespace
// clash rule, and the global-only `auth`. A test compares this reader with
// Pi's real `loadMcpConfig` so a Pi update that changes the rules fails loudly.
//
// Only `name`, `transport`, and `enabled` are ever returned: env values,
// headers, args, command, url, cwd, OAuth settings, and paths stay here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type McpTransport = "stdio" | "http";

export interface McpServerSummary {
	name: string;
	transport: McpTransport;
	enabled: boolean;
}

export type McpLayerStatus = "missing" | "invalid" | "valid";

export interface McpConfigRead {
	global: McpLayerStatus;
	/** Absent when the project is not trusted: Pi does not read that file then. */
	project?: McpLayerStatus;
	servers: McpServerSummary[];
}

export function globalMcpConfigPath(agentHome: string): string {
	return join(agentHome, "mcp.json");
}

export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"];
const EXPOSURES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];

interface Entry {
	transport: McpTransport;
	config: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function httpUrl(value: string): boolean {
	return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

function validExposures(config: Record<string, unknown>): boolean {
	if (config.exposure !== undefined && !EXPOSURES.includes(config.exposure as string)) return false;
	if (config.toolExposure === undefined) return true;
	return isRecord(config.toolExposure) && Object.values(config.toolExposure).every((value) => EXPOSURES.includes(value as string));
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** pi-mcp `isLoopbackRedirectUri`. */
function loopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

/** pi `isClientMetadataDocumentCallback`: the redirect URIs pi's Client ID Metadata Documents list. */
function metadataDocumentCallback(callbackUrl: unknown): boolean {
	if (callbackUrl === undefined) return true;
	// `validOAuth` has already rejected a `callbackUrl` that is not a parseable
	// loopback URI before it gets here; the guard keeps this from throwing anyway.
	if (typeof callbackUrl !== "string" || !URL.canParse(callbackUrl)) return false;
	const url = new URL(callbackUrl);
	return url.hostname !== "[::1]" && url.pathname === "/callback";
}

/** pi-mcp `validateOAuth` with pi's metadata-document callback check. */
function validOAuth(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isRecord(value)) return false;
	if (value.clientId !== undefined && typeof value.clientId !== "string") return false;
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") return false;
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return false;
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !loopbackRedirectUri(value.callbackUrl)) return false;
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) return false;
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return false;
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) return false;
	const registration = value.clientRegistration;
	if (registration !== undefined && registration !== "auto" && registration !== "dcr") {
		if (registration !== "cimd") return false;
		if (value.clientId !== undefined || value.clientName !== undefined) return false;
		if (!metadataDocumentCallback(value.callbackUrl)) return false;
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) return false;
	}
	return true;
}

/** pi `checkAuth`: a provider credential goes only to https, or http on a loopback host. */
function validAuth(auth: unknown, url: string): boolean {
	if (auth === undefined) return true;
	if (!isRecord(auth) || typeof auth.provider !== "string" || !auth.provider) return false;
	const parsed = new URL(url);
	return parsed.protocol === "https:" || LOOPBACK_HOSTS.includes(parsed.hostname);
}

/**
 * The transport Pi connects a validated entry with: `createDefaultTransport`
 * (`pi-coding-agent/dist/extensions/mcp/runtime.js`) builds a streamable HTTP
 * transport whenever the entry has a `url` key and stdio otherwise, even when
 * `type: "stdio"` and `command` made the entry pass validation as stdio.
 */
function connectTransport(config: Record<string, unknown>): McpTransport {
	return "url" in config ? "http" : "stdio";
}

/** Pi's validation of one entry and the transport it connects with, or undefined when Pi would reject it. */
function validEntry(name: string, config: unknown): Entry | undefined {
	if (!SERVER_NAME.test(name) || !isRecord(config)) return undefined;
	const { enabled, timeout, description, type, url, command } = config;
	if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
	if (description !== undefined && typeof description !== "string") return undefined;
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) return undefined;
	if (type === "sse") return undefined;
	if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!httpUrl(url)) return undefined;
		if (config.headers !== undefined && !isStringRecord(config.headers)) return undefined;
		if (!validOAuth(config.oauth)) return undefined;
		if (!validExposures(config)) return undefined;
		if (!validAuth(config.auth, url)) return undefined;
		return { transport: connectTransport(config), config };
	}
	if (typeof command === "string" && (type === undefined || type === "stdio")) {
		if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"))) return undefined;
		if (config.env !== undefined && !isStringRecord(config.env)) return undefined;
		if (config.cwd !== undefined && typeof config.cwd !== "string") return undefined;
		if (!validExposures(config)) return undefined;
		return { transport: connectTransport(config), config };
	}
	return undefined;
}

const namespace = (name: string): string => name.replace(/-/g, "_");

function readLayer(path: string, scope: "global" | "project", servers: Map<string, Entry>): McpLayerStatus {
	if (!existsSync(path)) return "missing";
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return "invalid";
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) return "invalid";
	for (const [name, value] of Object.entries((parsed.mcpServers ?? {}) as Record<string, unknown>)) {
		if (scope === "project" && isRecord(value) && value.command === undefined && value.url === undefined && value.type === undefined) {
			const base = servers.get(name);
			if (!base || Object.keys(value).some((key) => !OVERRIDE_KEYS.includes(key))) continue;
			const merged = validEntry(name, { ...base.config, ...value });
			if (merged) servers.set(name, merged);
			continue;
		}
		const entry = validEntry(name, value);
		if (!entry) continue;
		if ([...servers.keys()].some((other) => other !== name && namespace(other) === namespace(name))) continue;
		if (scope === "project" && entry.transport === "http" && entry.config.auth !== undefined) continue;
		servers.set(name, entry);
	}
	return "valid";
}

/** The servers Pi's loader would produce, reduced to display facts. */
export function readMcpConfig(input: { agentHome: string; cwd: string; projectTrusted: boolean }): McpConfigRead {
	const servers = new Map<string, Entry>();
	const global = readLayer(globalMcpConfigPath(input.agentHome), "global", servers);
	const project = input.projectTrusted ? readLayer(projectMcpConfigPath(input.cwd), "project", servers) : undefined;
	return {
		global,
		...(project === undefined ? {} : { project }),
		servers: [...servers.entries()].map(([name, entry]) => ({ name, transport: entry.transport, enabled: entry.config.enabled !== false })),
	};
}
