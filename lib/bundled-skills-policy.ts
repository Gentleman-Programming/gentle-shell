import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export const ALL_BUNDLED_SKILLS = [
	"branch-pr",
	"chained-pr",
	"cognitive-doc-design",
	"comment-writer",
	"design",
	"gentle-ai",
	"gentle-ui-design",
	"issue-creation",
	"judgment-day",
	"rdd-defect-workflow",
	"skill-creator",
	"skill-improver",
	"skill-registry",
	"tui-design",
	"work-unit-commits",
] as const;

export const DEFAULT_ENABLED_BUNDLED_SKILLS = [
	"branch-pr",
	"chained-pr",
	"cognitive-doc-design",
	"comment-writer",
	"gentle-ai",
	"judgment-day",
	"work-unit-commits",
] as const;

export type BundledSkillId = (typeof ALL_BUNDLED_SKILLS)[number];
export const BUNDLED_SKILLS_SCHEMA = "gentle-pi.bundled-skills/v1";

interface BundledSkillsOptions {
	gentlePiConfigHome?: string;
}

export interface BundledSkillsResolution {
	enabled: BundledSkillId[];
	source: "global_file" | "default";
	malformed: boolean;
	globalFile: string;
}

const VALID_SKILLS: ReadonlySet<string> = new Set(ALL_BUNDLED_SKILLS);

export function isBundledSkillId(value: string): value is BundledSkillId {
	return VALID_SKILLS.has(value);
}

export function parseBundledSkillsFile(raw: string): BundledSkillId[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (record.schema !== BUNDLED_SKILLS_SCHEMA || !Array.isArray(record.enabled)) return undefined;
		const deduped: BundledSkillId[] = [];
		for (const item of record.enabled) {
			if (typeof item !== "string" || !isBundledSkillId(item)) return undefined;
			if (!deduped.includes(item)) deduped.push(item);
		}
		return deduped;
	} catch {
		return undefined;
	}
}

export function resolveBundledSkillsPolicy(options: BundledSkillsOptions = {}): BundledSkillsResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "bundled-skills.json");
	try {
		const parsed = parseBundledSkillsFile(readFileSync(globalFile, "utf8"));
		return {
			enabled: parsed ?? [...DEFAULT_ENABLED_BUNDLED_SKILLS],
			source: "global_file",
			malformed: parsed === undefined,
			globalFile,
		};
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return {
			enabled: [...DEFAULT_ENABLED_BUNDLED_SKILLS],
			source: missing ? "default" : "global_file",
			malformed: !missing,
			globalFile,
		};
	}
}

export function writeBundledSkillsPolicy(
	enabled: readonly BundledSkillId[],
	options: BundledSkillsOptions = {},
): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "bundled-skills.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	const normalized = ALL_BUNDLED_SKILLS.filter((id) => enabled.includes(id));
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(
			temporary,
			`${JSON.stringify({ schema: BUNDLED_SKILLS_SCHEMA, enabled: normalized }, null, 2)}\n`,
			{ flag: "wx", mode: 0o600 },
		);
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}

export interface SystemPromptSkillsOptions {
	skills?: Array<{ name?: string; filePath?: string }>;
}

/** Filters bundled gentle-pi skills out of `systemPromptOptions.skills` unless
 * enabled in `bundled-skills.json`, keeping non-bundled skills untouched. */
export function filterBundledSystemPromptSkills(
	systemPromptOptions: SystemPromptSkillsOptions | undefined,
	bundledSkillsRoot: string,
	options: BundledSkillsOptions = {},
): void {
	if (!systemPromptOptions || !Array.isArray(systemPromptOptions.skills)) return;
	const enabled = new Set<string>(resolveBundledSkillsPolicy(options).enabled);
	systemPromptOptions.skills = systemPromptOptions.skills.filter((skill) => {
		const filePath = skill?.filePath;
		if (typeof filePath !== "string" || filePath.length === 0) return true;
		const rel = relative(bundledSkillsRoot, filePath);
		if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return true;
		const folder = rel.split(sep)[0];
		if (!folder || !isBundledSkillId(folder)) return true;
		return enabled.has(folder);
	});
}
