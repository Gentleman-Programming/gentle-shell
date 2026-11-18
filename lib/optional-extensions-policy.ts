import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const OPTIONAL_EXTENSION_IDS = [
	"gentle-design",
	"gentle-guide",
	"gentle-todo",
	"codegraph-tools",
	"gentle-music",
	"gentle-fast",
	"gentle-voice",
] as const;

export type OptionalExtensionId = (typeof OPTIONAL_EXTENSION_IDS)[number];
export const OPTIONAL_EXTENSIONS_SCHEMA = "gentle-pi.optional-extensions/v1";

interface OptionalExtensionsOptions {
	gentlePiConfigHome?: string;
}

export interface OptionalExtensionsResolution {
	enabled: OptionalExtensionId[];
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

const VALID_IDS: ReadonlySet<string> = new Set(OPTIONAL_EXTENSION_IDS);

export function isOptionalExtensionId(value: string): value is OptionalExtensionId {
	return VALID_IDS.has(value);
}

export function parseOptionalExtensionsFile(raw: string): OptionalExtensionId[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (record.schema !== OPTIONAL_EXTENSIONS_SCHEMA || !Array.isArray(record.enabled)) return undefined;
		const deduped: OptionalExtensionId[] = [];
		for (const item of record.enabled) {
			if (typeof item !== "string" || !isOptionalExtensionId(item)) return undefined;
			if (!deduped.includes(item)) deduped.push(item);
		}
		return deduped;
	} catch {
		return undefined;
	}
}

export function resolveOptionalExtensionsPolicy(
	options: OptionalExtensionsOptions = {},
): OptionalExtensionsResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "optional-extensions.json");
	try {
		const parsed = parseOptionalExtensionsFile(readFileSync(globalFile, "utf8"));
		return {
			enabled: parsed ?? [],
			source: "global_file",
			malformed: parsed === undefined,
			globalFile,
		};
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return {
			enabled: [],
			source: missing ? "default" : "global_file",
			malformed: !missing,
			globalFile,
		};
	}
}

export function isOptionalExtensionEnabled(
	id: OptionalExtensionId,
	options: OptionalExtensionsOptions = {},
): boolean {
	return resolveOptionalExtensionsPolicy(options).enabled.includes(id);
}

export function writeOptionalExtensionsPolicy(
	enabled: readonly OptionalExtensionId[],
	options: OptionalExtensionsOptions = {},
): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "optional-extensions.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	const normalized = OPTIONAL_EXTENSION_IDS.filter((id) => enabled.includes(id));
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(
			temporary,
			`${JSON.stringify({ schema: OPTIONAL_EXTENSIONS_SCHEMA, enabled: normalized }, null, 2)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
