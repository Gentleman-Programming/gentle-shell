import { isAbsolute, resolve, dirname, basename } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import type { AgentDefinition } from "./agents-config.ts";

// Exact registered Pi names, not provider display namespaces. MCP's generic
// `mcp` and dynamic `mcp__context7` gateways are deliberately NOT grants: an
// active gateway does not prove which remote methods it can safely expose.
export const RESEARCH_TOOLS = ["fetch_content", "web_search", "source_check", "get_search_content"] as const;
export const RESEARCH_CHILD_TOOLS_ENV = "GENTLE_PI_RESEARCH_TOOLS";
export const RESEARCH_SELECTION_ENV = "GENTLE_PI_RESEARCH_SELECTION";
export interface ResearchGrant {
	tools: string[];
	extensions: Record<string, string>;
}
export type ResearchSelection = Partial<Record<keyof ResearchCapabilities, ResearchGrant>>;
type Inventory = {
	getActiveTools?: () => string[];
	getAllTools?: () => Array<{ name: string; sourceInfo?: { source?: string; path?: string } }>;
};
type Capability = { status: "available" | "blocked"; tools: string[]; reason: string };
export type ResearchCapabilities = Record<"documentation" | "open-web", Capability>;

export function resolveResearchCapabilities(pi: Inventory, restriction?: readonly string[]): ResearchCapabilities {
	let names: string[] = [];
	try {
		const active = new Set(pi.getActiveTools?.() ?? []);
		names = (pi.getAllTools?.() ?? [])
			.filter(tool => active.has(tool.name) && tool.sourceInfo?.source !== "sdk" &&
				(restriction === undefined || restriction.includes(tool.name)))
			.map(tool => tool.name);
	} catch { /* Inventory failure is not a grant. */ }
	const tools = RESEARCH_TOOLS.filter(name => names.includes(name));
	const capability = (required: string[], guidance: string): Capability => {
		const missing = required.filter(name => !tools.includes(name as typeof RESEARCH_TOOLS[number]));
		return {
			status: required.some(name => tools.includes(name as typeof RESEARCH_TOOLS[number])) ? "available" : "blocked",
			tools: required.filter(name => tools.includes(name as typeof RESEARCH_TOOLS[number])),
			reason: `${missing.length === 0 ? "" : `Missing active, approved, child-reachable tools: ${missing.join(", ")}. `}${guidance}`,
		};
	};
	return {
		documentation: capability(["fetch_content"], "Fetch official documentation URLs; validate publisher and version before citing."),
		"open-web": capability(["web_search", "source_check", "fetch_content", "get_search_content"], "Use the available authorized tools for the requested questions; search snippets alone are not validated evidence."),
	};
}

export function renderResearchCapabilities(capabilities: ResearchCapabilities): string {
	return [
		"## SDD Research Capabilities",
		"Package-approved mapping intersected with active runtime tools and explicit agent restrictions:",
		...Object.entries(capabilities).map(([kind, value]) => `- ${kind}: ${value.status}; tools=${JSON.stringify(value.tools)}. ${value.reason}`),
		"Availability is not evidence. Use actual authorized tools, cite retrieved sources with publisher/version/date, and distinguish supported findings from unanswered questions.",
		"Unavailable tools limit the answers, not proposal readiness. Preserve explicit source restrictions, report useful partial findings and unavailable sources honestly, and never claim online access from inventory alone.",
		"Generic MCP and dynamic namespace gateways are not approved evidence routes. Never infer remote method access from gateway names, tool descriptions, bash, persistence tools, or remembered facts.",
	].join("\n");
}

export function researchAgent(agent: AgentDefinition, pi: Inventory, selection?: unknown) {
	const capabilities = resolveResearchCapabilities(pi, agent.tools);
	const extensionPaths = new Set<string>();
	const requested = selection && typeof selection === "object" && !Array.isArray(selection)
		? selection as Record<string, unknown> : {};
	let registered: ReturnType<NonNullable<Inventory["getAllTools"]>> = [];
	try { registered = pi.getAllTools?.() ?? []; } catch { /* No provenance, no route. */ }
	for (const [kind, capability] of Object.entries(capabilities)) {
		const value = requested[kind];
		const grant = value && typeof value === "object" ? value as Partial<ResearchGrant> : {};
		const supported: readonly string[] = kind === "documentation" ? ["fetch_content"] : RESEARCH_TOOLS;
		const exact = Object.keys(requested).every(key => Object.hasOwn(capabilities, key)) &&
			Array.isArray(grant.tools) && grant.tools.length > 0 && new Set(grant.tools).size === grant.tools.length &&
			grant.tools.every(name => supported.includes(name)) && grant.extensions &&
			Object.keys(grant.extensions).length === grant.tools.length;
		capability.tools = exact ? grant.tools!.filter(name => {
			const path = registered.find(tool => tool.name === name)?.sourceInfo?.path;
			return capability.tools.includes(name) && typeof path === "string" && isAbsolute(path) && path === grant.extensions![name];
		}) : [];
		capability.status = capability.tools.length ? "available" : "blocked";
		capability.reason = `Only individually selected tools with matching active extension provenance are usable. ${capability.reason}`;
		for (const name of capability.tools) extensionPaths.add(grant.extensions![name]);
	}
	const available = new Set(Object.values(capabilities).filter(value => value.status === "available").flatMap(value => value.tools));
	const tools = agent.tools.filter(name => available.has(name));
	return { agent: { ...agent, tools, instructions: `${agent.instructions}\n\n${renderResearchCapabilities(capabilities)}` }, capabilities, extensionPaths: [...extensionPaths] };
}

// Resolve existing ancestors for real remediation permission checks, including missing leaves.
export function canonicalArtifactPath(path: string): string {
	try { lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
		return resolve(canonicalArtifactPath(dirname(path)), basename(path));
	}
	return realpathSync(path);
}
