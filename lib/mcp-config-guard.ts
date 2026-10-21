import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface McpConfigStatus {
	/** True if `mcp.json` exists and defines at least one server. */
	hasConfiguredServers: boolean;
	/** Number of servers configured in `mcp.json`. */
	serverCount: number;
	/** True if `settings.json` extensions array explicitly excludes `builtin:mcp` (e.g. `"-builtin:mcp"`). */
	isBuiltinMcpExcluded: boolean;
	/** Path to `settings.json`. */
	settingsPath: string;
	/** Path to `mcp.json`. */
	mcpPath: string;
}

/**
 * Inspects whether Pi built-in MCP is suppressed via settings.json while
 * mcp.json defines servers.
 */
export function inspectMcpConfigStatus(agentDir: string = getAgentDir()): McpConfigStatus {
	const settingsPath = join(agentDir, "settings.json");
	const mcpPath = join(agentDir, "mcp.json");

	let isBuiltinMcpExcluded = false;
	try {
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (Array.isArray(settings?.extensions)) {
				isBuiltinMcpExcluded = settings.extensions.some(
					(e: unknown) => typeof e === "string" && e.replace(/^[+!]/, "") === "-builtin:mcp",
				);
			}
		}
	} catch {
		// Ignore parse errors; leave false
	}

	let serverCount = 0;
	try {
		if (existsSync(mcpPath)) {
			const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
			const servers = mcp?.mcpServers;
			if (servers && typeof servers === "object" && !Array.isArray(servers)) {
				serverCount = Object.keys(servers).length;
			}
		}
	} catch {
		// Ignore parse errors; leave 0
	}

	return {
		hasConfiguredServers: serverCount > 0,
		serverCount,
		isBuiltinMcpExcluded,
		settingsPath,
		mcpPath,
	};
}

/**
 * Removes `"-builtin:mcp"` from settings.json extensions array if present.
 * Returns true if the file was modified, false otherwise.
 */
export function removeBuiltinMcpExclusion(agentDir: string = getAgentDir()): boolean {
	const settingsPath = join(agentDir, "settings.json");
	try {
		if (!existsSync(settingsPath)) return false;
		const raw = readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw);
		if (!Array.isArray(settings?.extensions)) return false;

		const filtered = settings.extensions.filter(
			(e: unknown) => typeof e !== "string" || e.replace(/^[+!]/, "") !== "-builtin:mcp",
		);

		if (filtered.length === settings.extensions.length) return false;

		const indent = raw.match(/\{\r?\n([ \t]+)/)?.[1] ?? 2;
		const updated = JSON.stringify({ ...settings, extensions: filtered }, null, indent);
		writeFileSync(settingsPath, raw.endsWith("\n") ? `${updated}\n` : updated, "utf8");
		return true;
	} catch {
		return false;
	}
}
