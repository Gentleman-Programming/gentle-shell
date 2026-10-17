import {
	buildMcpSidebarEntries,
	mergeMcpServers,
	mcpStatusLabel,
	parseMcpServers,
	type McpSidebarEntry,
} from "./mcp-sidebar.ts";

// Session data provider: joins mcp.json files (global + project override,
// same shape pi itself loads) with live tool names and extension-registered
// servers. Pure: the extension owns file reads and pi access, and memoizes
// on file mtimes plus the tool list.

export interface McpSessionInput {
	globalPath: string;
	projectPath: string;
	globalRaw: string | undefined;
	projectRaw: string | undefined;
	tools: McpSessionTool[];
	/** Servers registered via pi.registerMcpServer(). */
	registered: string[];
}

export interface McpSessionTool {
	name: string;
	description: string;
}

export interface McpSessionEntry extends McpSidebarEntry {
	scope: "global" | "project" | "extension";
	hasOverride: boolean;
	source: string;
	/** Short tool names (the mcp__<server>__ prefix stripped) with descriptions. */
	tools: McpSessionTool[];
}

function shortTools(server: string, tools: McpSessionTool[]): McpSessionTool[] {
	const prefix = `mcp__${server.replace(/-/g, "_")}__`;
	return tools
		.filter((tool) => tool.name.startsWith(prefix))
		.map((tool) => ({ name: tool.name.slice(prefix.length), description: tool.description }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildMcpSession(input: McpSessionInput): McpSessionEntry[] {
	const configured = mergeMcpServers(parseMcpServers(input.globalRaw), parseMcpServers(input.projectRaw));
	const configuredNames = new Set(configured.map((server) => server.name));
	const extra = [...new Set(input.registered)].filter((name) => !configuredNames.has(name)).sort();
	const toolNames = input.tools.map((tool) => tool.name);
	const base = buildMcpSidebarEntries(
		[...configured.map(({ name, enabled }) => ({ name, enabled })), ...extra.map((name) => ({ name, enabled: true }))],
		toolNames,
	);
	const byName = new Map(base.map((entry) => [entry.name, entry]));
	return [
		...configured.map((server) => {
			const found = byName.get(server.name);
			if (!found) throw new Error(`MCP session entry missing for configured server "${server.name}"`);
			return {
				...found,
				scope: server.scope,
				hasOverride: server.hasOverride,
				source: server.scope === "project" ? input.projectPath : input.globalPath,
				tools: shortTools(server.name, input.tools),
			};
		}),
		...extra.map((name) => {
			const found = byName.get(name);
			if (!found) throw new Error(`MCP session entry missing for registered server "${name}"`);
			return {
				...found,
				scope: "extension" as const,
				hasOverride: false,
				source: "extension",
				tools: shortTools(name, input.tools),
			};
		}),
	];
}

export { mcpStatusLabel };
export type { McpSidebarEntry };
