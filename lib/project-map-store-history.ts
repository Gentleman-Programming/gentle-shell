import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	parseProjectMapStoreValue,
	serializeProjectMapStoreValue,
	type ProjectMapStoreDescriptorV1,
	type ProjectMapStoreDiagnostic,
} from "./project-map-store-schema.ts";

export const PROJECT_MAP_STORE_HISTORY_LIMIT = 20;

export interface ProjectMapStoreHistoryResult {
	history: ProjectMapStoreDescriptorV1[];
	diagnostics: ProjectMapStoreDiagnostic[];
}

interface HistoryEntry {
	path: string;
	descriptor: ProjectMapStoreDescriptorV1;
}

interface HistoryFile {
	path: string;
	entry: HistoryEntry | null;
}

function historyPath(root: string, descriptor: ProjectMapStoreDescriptorV1): string {
	return join(root, "history", `${descriptor.generation}-${descriptor.epoch}.json`);
}

function diagnostic(code: ProjectMapStoreDiagnostic["code"], message: string): ProjectMapStoreDiagnostic {
	return { code, path: "$", message, severity: "error" };
}

function readHistoryFiles(root: string): { files: HistoryFile[]; diagnostics: ProjectMapStoreDiagnostic[] } {
	let names: string[];
	try {
		names = readdirSync(join(root, "history"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], diagnostics: [] };
		return { files: [], diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store history could not be read.")] };
	}
	const files: HistoryFile[] = [];
	const diagnostics: ProjectMapStoreDiagnostic[] = [];
	for (const name of names.sort()) {
		const path = join(root, "history", name);
		let bytes: string;
		try {
			bytes = readFileSync(path, "utf8");
		} catch {
			diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, `Store history entry "${name}" could not be read.`));
			files.push({ path, entry: null });
			continue;
		}
		const parsed = parseProjectMapStoreValue("descriptor", bytes);
		if (parsed.record === null) {
			diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED, `Store history entry "${name}" is corrupted.`));
			files.push({ path, entry: null });
			continue;
		}
		files.push({ path, entry: { path, descriptor: parsed.record as ProjectMapStoreDescriptorV1 } });
	}
	return { files, diagnostics };
}

export function appendProjectMapStoreHistory(root: string, descriptor: ProjectMapStoreDescriptorV1): ProjectMapStoreDiagnostic[] {
	const serialized = serializeProjectMapStoreValue("descriptor", descriptor);
	if (serialized.record === null) return serialized.diagnostics;
	try {
		writeJsonFileAtomicallySync(historyPath(root, descriptor), serialized.record);
		return [];
	} catch {
		return [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store history could not be written.")];
	}
}

export function pruneProjectMapStoreHistory(root: string): ProjectMapStoreDiagnostic[] {
	const history = readHistoryFiles(root);
	const diagnostics = [...history.diagnostics];
	const excess = Math.max(0, history.files.length - PROJECT_MAP_STORE_HISTORY_LIMIT);
	const malformed = history.files.filter((file) => file.entry === null);
	const valid = history.files
		.filter((file): file is HistoryFile & { entry: HistoryEntry } => file.entry !== null)
		.sort((left, right) => left.entry.descriptor.generation - right.entry.descriptor.generation || left.entry.descriptor.epoch.localeCompare(right.entry.descriptor.epoch));
	for (const file of [...malformed, ...valid].slice(0, excess)) {
		try {
			unlinkSync(file.path);
		} catch {
			diagnostics.push(diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store history entry could not be pruned."));
		}
	}
	return diagnostics;
}

export function readProjectMapStoreHistory(root: string, limit: number): ProjectMapStoreHistoryResult {
	try {
		const result = readHistoryFiles(root);
		const bounded = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
		const history = result.files
			.flatMap((file) => file.entry === null ? [] : [file.entry])
			.sort((left, right) => left.descriptor.generation - right.descriptor.generation || left.descriptor.epoch.localeCompare(right.descriptor.epoch))
			.slice(0, bounded)
			.map((entry) => entry.descriptor);
		return { history, diagnostics: result.diagnostics };
	} catch {
		return { history: [], diagnostics: [diagnostic(PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE, "Store history could not be read.")] };
	}
}
