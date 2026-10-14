import { CARD_TONE, renderCard, type CardTheme } from "./shell-card.ts";
import { stripAnsi } from "./terminal-theme.ts";

export type McpSidebarStatus = "connected" | "disabled" | "connecting";

export interface McpSidebarServer {
	name: string;
	enabled: boolean;
}

export interface McpSidebarEntry extends McpSidebarServer {
	toolCount: number;
	status: McpSidebarStatus;
}

// Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`,
// mirroring pi's mcpNamespace without importing the runtime.
function mcpNamespace(server: string): string {
	return `mcp__${server.replace(/-/g, "_")}__`;
}

export function buildMcpSidebarEntries(
	servers: McpSidebarServer[],
	toolNames: string[],
): McpSidebarEntry[] {
	return servers.map((server) => {
		const prefix = mcpNamespace(server.name);
		const toolCount = toolNames.filter((tool) => tool.startsWith(prefix)).length;
		const status: McpSidebarStatus = !server.enabled
			? "disabled"
			: toolCount > 0
				? "connected"
				: "connecting";
		return { ...server, toolCount, status };
	});
}

// Click matching reads rendered rows, which carry the card frame
// (`│`/`▎`), the float style's transparent margins (spaces), and possibly a
// `▸` selection marker. Normalize all of that away so matching works in
// every style; matching itself stays exact (`• name —`, `label —`) so
// "Disable" never shadows "Disable in this project".
export function normalizeMcpRow(row: string): string {
	let text = stripAnsi(row).trim();
	for (;;) {
		const next = text.replace(/^[│▎] /, "").replace(/^▸ /, "").replace(/ [│▎]$/, "");
		if (next === text) return text;
		text = next.trim();
	}
}

export function mcpStatusLabel(status: McpSidebarStatus): string {
	return status === "connected" ? "Connected" : status === "disabled" ? "Disabled" : "Connecting";
}

// Config-file layer: mirrors pi's mcp.json shape without importing its
// internals (loadMcpConfig is not part of pi's public exports). A project
// entry without command/url/type overrides only enabled/exposure of the
// global server with the same name.

export type McpConfigScope = "global" | "project";

export interface McpConfiguredServer {
	name: string;
	enabled: boolean;
	scope: McpConfigScope;
	hasOverride: boolean;
}

type McpRawEntry = Record<string, unknown>;

function isFullEntry(raw: McpRawEntry): boolean {
	return raw.command !== undefined || raw.url !== undefined || raw.type !== undefined;
}

function readEnabled(raw: McpRawEntry | undefined): boolean {
	return raw?.enabled === false ? false : true;
}

export function mergeMcpServers(
	globalServers: Record<string, McpRawEntry>,
	projectServers: Record<string, McpRawEntry> = {},
): McpConfiguredServer[] {
	const names = [...new Set([...Object.keys(globalServers), ...Object.keys(projectServers)])].sort();
	return names.map((name) => {
		const global = globalServers[name];
		const project = projectServers[name];
		if (project !== undefined && (global === undefined || isFullEntry(project))) {
			return { name, enabled: readEnabled(project), scope: "project" as const, hasOverride: false };
		}
		if (global === undefined) {
			return { name, enabled: readEnabled(project), scope: "global" as const, hasOverride: true };
		}
		return {
			name,
			enabled: project !== undefined && project.enabled !== undefined ? readEnabled(project) : readEnabled(global),
			scope: "global" as const,
			hasOverride: project !== undefined,
		};
	});
}

function detectIndent(raw: string): string {
	const match = raw.match(/\n(\s+)"mcpServers"/);
	if (match) return `${match[1]}  `;
	const line = raw.match(/\n(\s+)\S/);
	return line ? `${line[1]}  ` : "  ";
}

export function parseMcpServers(raw: string | undefined): Record<string, Record<string, unknown>> {
	if (raw === undefined || raw.trim() === "") return {};
	try {
		const doc = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
		return doc.mcpServers ?? {};
	} catch {
		return {};
	}
}

export function patchMcpServersFile(
	raw: string | undefined,
	name: string,
	patch: { enabled?: boolean },
	options: { asOverride?: boolean; keepEnabled?: boolean } = {},
): string {
	let doc: Record<string, unknown>;
	let indent = "  ";
	if (raw === undefined || raw.trim() === "") {
		doc = { mcpServers: {} };
	} else {
		indent = detectIndent(raw);
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("MCP config is not a JSON object; refusing to rewrite it.");
		}
		doc = parsed as Record<string, unknown>;
		if (doc.mcpServers !== undefined && (typeof doc.mcpServers !== "object" || doc.mcpServers === null || Array.isArray(doc.mcpServers))) {
			throw new Error('MCP config "mcpServers" is not an object; refusing to rewrite it.');
		}
		doc.mcpServers ??= {};
	}
	const servers = doc.mcpServers as Record<string, McpRawEntry>;
	if (options.asOverride) {
		const current = servers[name] ?? {};
		servers[name] = { ...current, ...patch };
		if (patch.enabled === true && !options.keepEnabled) delete (servers[name] as Record<string, unknown>).enabled;
		if (Object.keys(servers[name]!).length === 0) delete servers[name];
	} else {
		const current = servers[name] ?? {};
		const next = { ...current, ...patch };
		if (patch.enabled === true) delete next.enabled;
		servers[name] = next;
	}
	return JSON.stringify(doc, undefined, indent);
}

export interface McpCardOptions {
	collapsed: boolean;
}

function mcpSummary(entries: McpSidebarEntry[]): string {
	const connected = entries.filter((entry) => entry.status === "connected").length;
	const disabled = entries.filter((entry) => entry.status === "disabled").length;
	const connecting = entries.length - connected - disabled;
	const parts = [
		...(connected ? [`${connected} connected`] : []),
		...(connecting ? [`${connecting} connecting`] : []),
		...(disabled ? [`${disabled} disabled`] : []),
	];
	return parts.join(" · ") || `${entries.length} servers`;
}

export function renderMcpCard(
	entries: McpSidebarEntry[],
	options: McpCardOptions,
	theme: CardTheme,
	width: number,
): string[] {
	if (entries.length === 0) return [];
	const control = options.collapsed ? "▸ Expand" : "▾ Collapse";
	const body = options.collapsed
		? [mcpSummary(entries)]
		: entries.map((entry) => `• ${entry.name} — ${mcpStatusLabel(entry.status)} · ${entry.toolCount} ${entry.toolCount === 1 ? "tool" : "tools"}`);
	return renderCard(
		{ title: `MCP ${control}`, subtitle: mcpSummary(entries), body, tone: CARD_TONE.INFO },
		theme,
		width,
		{ expanded: true, panel: true },
	);
}

// Detail overlay actions: Tools opens the in-panel tools screen; Disable
// persists to the defining mcp.json and project variants write a project
// override (same file semantics as /mcp). Live actions (reconnect, sign in)
// have no public API, so the overlay names /mcp for those instead of faking
// them. Extension servers have no file to patch: Tools only.

export type McpDetailActionId = "tools" | "disable" | "disable-project" | "enable" | "enable-project";

export interface McpDetailAction {
	id: McpDetailActionId;
	label: string;
	hint: string;
}

function toolLabel(toolCount: number): string {
	return `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
}

export function buildExtensionDetailActions(toolCount: number): McpDetailAction[] {
	return [{ id: "tools", label: "Tools", hint: toolLabel(toolCount) }];
}

export function buildMcpDetailActions(
	server: McpConfiguredServer & { toolCount: number },
	options: { projectTrusted: boolean },
): McpDetailAction[] {
	const actions: McpDetailAction[] = [{
		id: "tools",
		label: "Tools",
		hint: server.enabled ? toolLabel(server.toolCount) : "enable to view",
	}];
	const fileHint = server.scope === "project" ? "saved to the project mcp.json" : "saved to the global mcp.json";
	if (server.enabled) {
		actions.push({ id: "disable", label: "Disable", hint: fileHint });
		if (options.projectTrusted && server.scope === "global") {
			actions.push({ id: "disable-project", label: "Disable in this project", hint: "saved to the project mcp.json" });
		}
	} else if (server.scope === "global" && server.hasOverride) {
		actions.push({ id: "enable-project", label: "Enable in this project", hint: "removes the project override" });
	} else {
		actions.push({ id: "enable", label: "Enable", hint: fileHint });
		if (options.projectTrusted && server.scope === "global") {
			actions.push({ id: "enable-project", label: "Enable only in this project", hint: "saved to the project mcp.json" });
		}
	}
	return actions;
}
