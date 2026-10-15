import { chmodSync, closeSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { detectJsonFormatting } from "./gentle-shell-launcher.ts";

// `gentle-shell home import-pi`: a one-time, opt-in copy of the user's pi
// sign-ins and MCP servers into a separate Gentle Shell home, as an
// alternative to --link. Only the files and settings keys below are read;
// packages, extensions, caches, AGENTS.md and sessions are never copied, so
// the target home keeps its own provisioning. Nothing is ever overwritten and
// the source is only read.

// auth.json holds OAuth tokens and API keys: always private in the copy.
const IMPORTED_FILES: readonly { name: string; mode?: number }[] = [
	{ name: "auth.json", mode: 0o600 },
	{ name: "mcp.json" },
];

// Pi 1.2.0's own settings for the default model (SettingsManager
// get/setDefaultProvider, DefaultModel, DefaultThinkingLevel).
export const IMPORTED_SETTINGS_KEYS: readonly string[] = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];

export interface ImportPiFs {
	// lstat: a symbolic link is "other", never followed.
	kind: (path: string) => "missing" | "file" | "dir" | "other";
	mode: (path: string) => number;
	readText: (path: string) => string;
	// Creates `to` with exactly `mode`; throws when it already exists.
	copyNew: (from: string, to: string, mode: number) => void;
	// Temp file next to `path`, then a rename onto it.
	writeAtomic: (path: string, text: string) => void;
}

export type ImportPiStatus = "copied" | "would copy" | "present" | "not found" | "skipped" | "failed";

export interface ImportPiItem {
	item: string;
	status: ImportPiStatus;
	// The copy's mode, or why the item was skipped or failed. Never file content.
	detail?: string;
}

export interface ImportPiResult {
	items: ImportPiItem[];
	failed: boolean;
}

function tempPathFor(path: string): string {
	return join(dirname(path), `.${basename(path)}.gentle-shell-${process.pid}.tmp`);
}

function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Nothing left to clean up.
	}
}

function writeTemp(path: string, data: string | Buffer, mode: number): string {
	const temp = tempPathFor(path);
	const fd = openSync(temp, "wx", mode);
	try {
		try {
			writeFileSync(fd, data);
		} finally {
			closeSync(fd);
		}
		chmodSync(temp, mode); // the umask must not change the mode
	} catch (error) {
		// A partial copy may hold credentials: never leave it behind.
		removeQuietly(temp);
		throw error;
	}
	return temp;
}

export const nodeImportPiFs: ImportPiFs = {
	kind: (path) => {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) return "other";
			return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
			throw error;
		}
	},
	mode: (path) => lstatSync(path).mode & 0o777,
	readText: (path) => readFileSync(path, "utf8"),
	copyNew: (from, to, mode) => {
		const temp = writeTemp(to, readFileSync(from), mode);
		try {
			linkSync(temp, to); // EEXIST instead of replacing a file that appeared meanwhile
		} finally {
			removeQuietly(temp);
		}
	},
	writeAtomic: (path, text) => {
		const mode = lstatSync(path, { throwIfNoEntry: false })?.mode;
		const temp = writeTemp(path, text, mode === undefined ? 0o600 : mode & 0o777);
		try {
			renameSync(temp, path);
		} catch (error) {
			removeQuietly(temp);
			throw error;
		}
	},
};

function reason(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function importFile(name: string, mode: number | undefined, input: { source: string; target: string; dryRun: boolean; fs: ImportPiFs }): ImportPiItem {
	const { fs } = input;
	const from = join(input.source, name);
	const to = join(input.target, name);
	// Classification can throw too (ENOTDIR under a file): one failed item, never an aborted report.
	try {
		const kind = fs.kind(from);
		if (kind === "missing") return { item: name, status: "not found" };
		if (kind !== "file") return { item: name, status: "skipped", detail: "not a regular file" };
		if (fs.kind(to) !== "missing") return { item: name, status: "present" };
		const copyMode = mode ?? fs.mode(from);
		const detail = `${copyMode.toString(8).padStart(4, "0")}`;
		if (input.dryRun) return { item: name, status: "would copy", detail };
		fs.copyNew(from, to, copyMode);
		return { item: name, status: "copied", detail };
	} catch (error) {
		return { item: name, status: "failed", detail: reason(error) };
	}
}

function importSettings(input: { source: string; target: string; dryRun: boolean; fs: ImportPiFs }): ImportPiItem[] {
	try {
		return planAndWriteSettings(input);
	} catch (error) {
		// An unreadable settings.json stays one failed item, never an aborted report.
		return [{ item: "settings.json", status: "failed", detail: reason(error) }];
	}
}

function planAndWriteSettings(input: { source: string; target: string; dryRun: boolean; fs: ImportPiFs }): ImportPiItem[] {
	const { fs } = input;
	const from = join(input.source, "settings.json");
	const to = join(input.target, "settings.json");
	const sourceKind = fs.kind(from);
	if (sourceKind === "missing") return [{ item: "settings.json", status: "not found" }];
	if (sourceKind !== "file") return [{ item: "settings.json", status: "skipped", detail: "not a regular file" }];
	const source = parseObject(fs.readText(from));
	if (source === undefined) return [{ item: "settings.json", status: "skipped", detail: `${from} is not a JSON object` }];
	const targetKind = fs.kind(to);
	if (targetKind !== "missing" && targetKind !== "file") return [{ item: "settings.json", status: "skipped", detail: `${to} is not a regular file` }];
	const targetText = targetKind === "missing" ? undefined : fs.readText(to);
	const target = targetText === undefined ? {} : parseObject(targetText);
	if (target === undefined) return [{ item: "settings.json", status: "skipped", detail: `${to} is not a JSON object` }];

	const items: ImportPiItem[] = [];
	const added: Record<string, unknown> = {};
	for (const key of IMPORTED_SETTINGS_KEYS) {
		const item = `settings.json ${key}`;
		if (!Object.hasOwn(source, key)) items.push({ item, status: "not found" });
		else if (Object.hasOwn(target, key)) items.push({ item, status: "present" });
		else if (typeof source[key] !== "string") items.push({ item, status: "skipped", detail: "not a string" });
		else {
			added[key] = source[key];
			items.push({ item, status: input.dryRun ? "would copy" : "copied" });
		}
	}
	if (input.dryRun || Object.keys(added).length === 0) return items;
	try {
		// Keep the target's own indentation and trailing-newline style.
		const style = targetText === undefined ? { indent: undefined, trailingNewline: true } : detectJsonFormatting(targetText);
		const body = JSON.stringify({ ...target, ...added }, null, style.indent ?? 2);
		fs.writeAtomic(to, style.trailingNewline ? `${body}\n` : body);
		return items;
	} catch (error) {
		const detail = reason(error);
		return items.map((entry) => (entry.status === "copied" ? { ...entry, status: "failed", detail } : entry));
	}
}

// Copies what the target lacks. A dry run reads the same files and writes
// nothing. The caller has already made sure `target` is a home this launcher
// owns (and exists, unless this is a dry run).
export function importPi(input: { source: string; target: string; dryRun: boolean; fs?: ImportPiFs }): ImportPiResult {
	const options = { ...input, fs: input.fs ?? nodeImportPiFs };
	const items = IMPORTED_FILES.map((file) => importFile(file.name, file.mode, options));
	items.push(...importSettings(options));
	return { items, failed: items.some((item) => item.status === "failed") };
}

function describe(item: ImportPiItem): string {
	switch (item.status) {
		case "copied":
		case "would copy":
			return item.detail !== undefined && item.item === "auth.json" ? `${item.status} (${item.detail})` : item.status;
		case "present":
			return "already present, kept";
		case "not found":
			return "not found";
		case "skipped":
			return `skipped: ${item.detail}`;
		case "failed":
			return `failed: ${item.detail}`;
	}
}

export function formatImportPiReport(result: ImportPiResult, context: { source: string; target: string; dryRun: boolean }): string[] {
	const lines = [
		context.dryRun
			? `Dry run: would import from ${context.source} into ${context.target} (nothing is written)`
			: `Importing from ${context.source} into ${context.target}`,
	];
	for (const item of result.items) lines.push(`  ${item.item}: ${describe(item)}`);
	const count = (...statuses: ImportPiStatus[]) => result.items.filter((item) => statuses.includes(item.status)).length;
	const imported = count("copied", "would copy");
	const rest = `${count("present")} already present, ${count("not found")} not found, ${count("skipped")} skipped`;
	if (result.failed) lines.push(`Import failed for ${count("failed")} item(s); ${count("copied")} copied and kept. ${rest}.`);
	else if (imported === 0) lines.push(`Nothing to import: ${rest}.`);
	else lines.push(`${context.dryRun ? "Would import" : "Imported"} ${imported} item(s); ${rest}.`);
	return lines;
}
