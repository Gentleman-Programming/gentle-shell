import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Gentle AI agent tool overlay: a load-time layer that adds/removes subagent
// tools without editing the package-owned agent files. Mirrors the routing
// layer (`models.json`): applied at load, never written back, so package
// ownership and upgrade behavior stay untouched (gentle-shell#3133).
//
// Sources merge low -> high (higher wins on a per-tool conflict):
//   1. extension drop-ins under `<configHome>/agent-overlays.d/*.json`
//   2. global `<configHome>/tools.json`
//   3. project `<cwd>/.pi/gentle-ai/tools.json`

export interface ToolOverlayEntry {
	add: string[];
	remove: string[];
}

export interface ToolOverlayResult {
	entries: Record<string, ToolOverlayEntry>;
	notices: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readOverlayFile(path: string, notices: string[]): Record<string, ToolOverlayEntry> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		notices.push(`ignored invalid tool overlay ${path}`);
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		notices.push(`ignored invalid tool overlay ${path}`);
		return undefined;
	}
	const entries: Record<string, ToolOverlayEntry> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (!isPlainObject(value)) {
			notices.push(`ignored invalid entry for "${name}" in ${path}`);
			continue;
		}
		const add = value.add;
		const remove = value.remove;
		if ((add !== undefined && !isStringArray(add)) || (remove !== undefined && !isStringArray(remove))) {
			notices.push(`ignored invalid entry for "${name}" in ${path}`);
			continue;
		}
		entries[name] = {
			add: isStringArray(add) ? add : [],
			remove: isStringArray(remove) ? remove : [],
		};
	}
	return entries;
}

export function loadToolOverlays(configHome: string, cwd: string): ToolOverlayResult {
	const notices: string[] = [];
	const addByAgent = new Map<string, Set<string>>();
	const removeByAgent = new Map<string, Set<string>>();

	const sources: Array<Record<string, ToolOverlayEntry> | undefined> = [];

	const dropInDir = join(configHome, "agent-overlays.d");
	if (existsSync(dropInDir)) {
		for (const file of readdirSync(dropInDir).filter((entry) => entry.endsWith(".json")).sort()) {
			sources.push(readOverlayFile(join(dropInDir, file), notices));
		}
	}

	const globalPath = join(configHome, "tools.json");
	if (existsSync(globalPath)) sources.push(readOverlayFile(globalPath, notices));

	const projectPath = join(cwd, ".pi", "gentle-ai", "tools.json");
	if (existsSync(projectPath)) sources.push(readOverlayFile(projectPath, notices));

	for (const entries of sources) {
		if (entries === undefined) continue;
		for (const [name, entry] of Object.entries(entries)) {
			const addSet = addByAgent.get(name) ?? new Set<string>();
			const removeSet = removeByAgent.get(name) ?? new Set<string>();
			for (const tool of entry.add) {
				addSet.add(tool);
				removeSet.delete(tool);
			}
			for (const tool of entry.remove) {
				removeSet.add(tool);
				addSet.delete(tool);
			}
			addByAgent.set(name, addSet);
			removeByAgent.set(name, removeSet);
		}
	}

	const entries: Record<string, ToolOverlayEntry> = {};
	for (const name of new Set([...addByAgent.keys(), ...removeByAgent.keys()])) {
		entries[name] = {
			add: [...(addByAgent.get(name) ?? new Set<string>())],
			remove: [...(removeByAgent.get(name) ?? new Set<string>())],
		};
	}

	return { entries, notices };
}

export function applyToolOverlay(tools: string[], overlay: ToolOverlayEntry | undefined): string[] {
	if (overlay === undefined) return tools;
	const removeSet = new Set(overlay.remove);
	return [...new Set([...tools, ...overlay.add])].filter((tool) => !removeSet.has(tool));
}
