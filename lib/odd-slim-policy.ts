import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const ODD_OPTIONAL_MODULES = [
	"tracking",
	"verification",
	"4r-review",
	"judgment-day",
] as const;

export type OddOptionalModule = (typeof ODD_OPTIONAL_MODULES)[number];
export const ODD_SLIM_SCHEMA = "gentle-pi.odd-slim/v1";

export interface OddSlimPolicy {
	enabled: boolean;
	modules: OddOptionalModule[];
}

interface OddSlimOptions {
	gentlePiConfigHome?: string;
}

export interface OddSlimResolution {
	policy: OddSlimPolicy;
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

const VALID_MODULES: ReadonlySet<string> = new Set(ODD_OPTIONAL_MODULES);

export function isOddOptionalModule(value: string): value is OddOptionalModule {
	return VALID_MODULES.has(value);
}

export function parseOddSlimFile(raw: string): OddSlimPolicy | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (record.schema !== ODD_SLIM_SCHEMA || typeof record.enabled !== "boolean" || !Array.isArray(record.modules)) {
			return undefined;
		}
		const deduped: OddOptionalModule[] = [];
		for (const item of record.modules) {
			if (typeof item !== "string" || !isOddOptionalModule(item)) return undefined;
			if (!deduped.includes(item)) deduped.push(item);
		}
		return { enabled: record.enabled, modules: deduped };
	} catch {
		return undefined;
	}
}

export function resolveOddSlimPolicy(options: OddSlimOptions = {}): OddSlimResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "odd-slim.json");
	try {
		const parsed = parseOddSlimFile(readFileSync(globalFile, "utf8"));
		return {
			policy: parsed ?? { enabled: false, modules: [] },
			source: "global_file",
			malformed: parsed === undefined,
			globalFile,
		};
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return {
			policy: { enabled: false, modules: [] },
			source: missing ? "default" : "global_file",
			malformed: !missing,
			globalFile,
		};
	}
}

export function writeOddSlimPolicy(policy: OddSlimPolicy, options: OddSlimOptions = {}): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "odd-slim.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	const normalized: OddSlimPolicy = {
		enabled: Boolean(policy.enabled),
		modules: ODD_OPTIONAL_MODULES.filter((mod) => policy.modules.includes(mod)),
	};
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: ODD_SLIM_SCHEMA, ...normalized }, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
