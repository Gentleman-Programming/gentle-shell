import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTRY_REL_PATH = ".atl/skill-registry.md";
const CACHE_REL_PATH = ".atl/.skill-registry.cache.json";
const SECTION_MARKER = "## Skills";
const EXCLUDE_NAMES = new Set(["_shared", "skill-registry"]);
const EXCLUDE_PREFIXES = ["sdd-"];
const WATCH_DEBOUNCE_MS = 500;
const REGISTRY_SCHEMA_VERSION = 9;
const NO_SKILL_REGISTRY_FLAG = "no-skill-registry";
const NO_SKILL_REGISTRY_ENV = "GENTLE_PI_NO_SKILL_REGISTRY";
const LEGACY_PROJECT_REGISTRY_REL_PATH = ".pi/extensions/skill-registry.ts";
const LEGACY_PROJECT_REGISTRY_DISABLED_REL_PATH =
	".pi/extensions/skill-registry.ts.disabled";
const SKILL_REGISTRY_EXTENSION_SOURCE_KEY =
	"__gentlePiSkillRegistryExtensionSource";
const activeWatchers = new Set<FSWatcher>();

interface SkillRegistryExtensionGlobal {
	[SKILL_REGISTRY_EXTENSION_SOURCE_KEY]?: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

interface SkillEntry {
	name: string;
	path: string;
	description: string;
	scope?: string;
}

// Structural mirror of pi's runtime-resolved skill record. Kept local on
// purpose: this seam must not import pi internals.
export interface ResolvedSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir?: string;
	disableModelInvocation?: boolean;
	sourceInfo?: {
		path?: string;
		source?: string;
		scope?: "user" | "project" | "temporary";
		origin?: "package" | "top-level";
		baseDir?: string;
	};
}

function userSkillDirs(): string[] {
	const home = homedir();
	return [
		join(home, ".pi/agent/skills"),
		join(home, ".config/agents/skills"),
		join(home, ".agents/skills"),
		join(home, ".kimi/skills"),
		join(home, ".config/opencode/skills"),
		join(home, ".config/kilo/skills"),
		join(home, ".claude/skills"),
		join(home, ".gemini/skills"),
		join(home, ".gemini/antigravity/skills"),
		join(home, ".trae/skills"),
		join(home, ".cursor/skills"),
		join(home, ".copilot/skills"),
		join(home, ".codex/skills"),
		join(home, ".codeium/windsurf/skills"),
		join(home, ".qwen/skills"),
		join(home, ".kiro/skills"),
		join(home, ".openclaw/skills"),
	];
}

function projectSkillDirs(cwd: string): string[] {
	return [
		join(cwd, "skills"),
		join(cwd, ".opencode/skills"),
		join(cwd, ".claude/skills"),
		join(cwd, ".gemini/skills"),
		join(cwd, ".trae/skills"),
		join(cwd, ".cursor/skills"),
		join(cwd, ".github/skills"),
		join(cwd, ".codex/skills"),
		join(cwd, ".qwen/skills"),
		join(cwd, ".kiro/skills"),
		join(cwd, ".openclaw/skills"),
		join(cwd, ".pi/skills"),
		join(cwd, ".agent/skills"),
		join(cwd, ".agents/skills"),
		join(cwd, ".atl/skills"),
	];
}

async function findSkillFiles(root: string): Promise<string[]> {
	if (!(await pathExists(root))) return [];
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const out: string[] = [];
	for (const entry of entries) {
		const skillDir = join(root, entry.name);
		let dirInfo;
		try {
			dirInfo = await stat(skillDir);
		} catch {
			continue;
		}
		if (!dirInfo.isDirectory()) continue;

		const candidate = join(skillDir, "SKILL.md");
		try {
			const skillInfo = await stat(candidate);
			if (skillInfo.isFile()) out.push(candidate);
		} catch {
			// Missing or unreadable skill files are ignored; the registry is best-effort.
		}
	}
	return out.sort();
}

function parseFrontmatter(source: string): { name?: string; description?: string; body: string } {
	const normalized = source.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---\n")) return { body: normalized };
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return { body: normalized };
	const fm = normalized.slice(4, end);
	const body = normalized.slice(end + 4).replace(/^\n/, "");
	const out: { name?: string; description?: string } = {};
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		let value = m[2].trim();
		if (value === ">" || value === ">-" || value === "|" || value === "|-") {
			const block: string[] = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				if (next.trim() === "") {
					block.push("");
					i++;
					continue;
				}
				if (!next.startsWith(" ") && !next.startsWith("\t")) break;
				block.push(next.trim());
				i++;
			}
			value = block.join(" ").trim();
		} else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key === "name") out.name = value;
		else if (key === "description") out.description = value;
	}
	return { ...out, body };
}

function deriveSkillName(file: string, frontmatterName: string | undefined): string {
	if (frontmatterName) return frontmatterName;
	return basename(join(file, ".."));
}

function isExcluded(name: string): boolean {
	if (EXCLUDE_NAMES.has(name)) return true;
	return EXCLUDE_PREFIXES.some((p) => name.startsWith(p));
}

function comparablePath(path: string): string {
	const clean = normalize(path);
	return clean.length > 1 ? clean.replace(/[\\/]+$/, "") : clean;
}

async function uniqueExistingDirs(dirs: string[]): Promise<string[]> {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const dir of dirs) {
		const clean = comparablePath(dir);
		if (seen.has(clean) || !(await pathExists(clean))) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

async function loadSkill(file: string): Promise<SkillEntry | undefined> {
	let source: string;
	try {
		source = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const fm = parseFrontmatter(source);
	const name = deriveSkillName(file, fm.name);
	if (isExcluded(name)) return undefined;
	return {
		name,
		path: file,
		description: normalizeSkillDescription(fm.description ?? ""),
	};
}

function normalizeSkillDescription(description: string): string {
	return description.replace(/\s+/g, " ").trim();
}

function dedupeBySkillName(entries: SkillEntry[], cwd: string): SkillEntry[] {
	const cleanCwd = comparablePath(cwd);
	const projectPrefix = cleanCwd.endsWith(sep) ? cleanCwd : `${cleanCwd}${sep}`;
	const buckets = new Map<string, SkillEntry[]>();
	for (const entry of entries) {
		const list = buckets.get(entry.name) ?? [];
		list.push(entry);
		buckets.set(entry.name, list);
	}
	const out: SkillEntry[] = [];
	for (const [, list] of buckets) {
		const projectScoped = list.find((e) =>
			e.scope?.startsWith("project") ||
			(e.scope === undefined && comparablePath(e.path).startsWith(projectPrefix)),
		);
		out.push(projectScoped ?? list[0]);
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

function resolvedScopeLabel(skill: ResolvedSkill): string {
	const scope = skill.sourceInfo?.scope === "project" ? "project" : "user";
	return skill.sourceInfo?.origin === "package" ? `${scope} · package` : scope;
}

// Runtime capture state: pi-resolved skills from the latest before_agent_start
// event, trimmed to only the fields the registry seam consumes. Never retain
// the full runtime event objects.
let lastResolvedSkills: ResolvedSkill[] = [];

function trimResolvedSkill(skill: ResolvedSkill): ResolvedSkill {
	const trimmed: ResolvedSkill = {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
	};
	if (skill.disableModelInvocation === true) trimmed.disableModelInvocation = true;
	if (skill.sourceInfo) {
		trimmed.sourceInfo = {
			scope: skill.sourceInfo.scope,
			origin: skill.sourceInfo.origin,
		};
	}
	return trimmed;
}

function isResolvedSourceInfo(value: unknown): value is NonNullable<ResolvedSkill["sourceInfo"]> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const sourceInfo = value as NonNullable<ResolvedSkill["sourceInfo"]>;
	return (
		(sourceInfo.scope === undefined ||
			sourceInfo.scope === "user" ||
			sourceInfo.scope === "project" ||
			sourceInfo.scope === "temporary") &&
		(sourceInfo.origin === undefined || sourceInfo.origin === "package" || sourceInfo.origin === "top-level")
	);
}

function isResolvedSkill(value: unknown): value is ResolvedSkill {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const skill = value as Partial<ResolvedSkill>;
	return (
		typeof skill.name === "string" &&
		typeof skill.description === "string" &&
		typeof skill.filePath === "string" &&
		(skill.disableModelInvocation === undefined || typeof skill.disableModelInvocation === "boolean") &&
		(skill.sourceInfo === undefined || isResolvedSourceInfo(skill.sourceInfo))
	);
}

async function applyResolvedSkillsUpdate(cwd: string, skills: ResolvedSkill[]): Promise<RegenResult> {
	lastResolvedSkills = skills.map(trimResolvedSkill);
	return regenerateRegistry(cwd, false, lastResolvedSkills);
}

function toResolvedEntry(skill: ResolvedSkill, cwd: string): SkillEntry | undefined {
	// cwd is reserved: pi-resolved paths are already absolute, but the seam stays
	// symmetric with the loose scan for future scoping needs.
	void cwd;
	if (skill.disableModelInvocation === true) return undefined;
	if (isExcluded(skill.name)) return undefined;
	return {
		name: skill.name,
		path: skill.filePath,
		description: normalizeSkillDescription(skill.description),
		scope: resolvedScopeLabel(skill),
	};
}

function mergeResolvedWithLoose(resolved: SkillEntry[], loose: SkillEntry[], cwd: string): SkillEntry[] {
	const resolvedPaths = new Set(resolved.map((entry) => comparablePath(entry.path)));
	const filteredLoose = loose.filter((entry) => !resolvedPaths.has(comparablePath(entry.path)));
	return dedupeBySkillName([...resolved, ...filteredLoose], cwd);
}

function scopeForPath(cwd: string, path: string): string {
	const cleanCwd = comparablePath(cwd);
	const projectPrefix = cleanCwd.endsWith(sep) ? cleanCwd : `${cleanCwd}${sep}`;
	return comparablePath(path).startsWith(projectPrefix) ? "project" : "user";
}

function markdownCell(value: string): string {
	const trimmed = value.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
	return trimmed.length > 0 ? trimmed : "—";
}

function isCacheFile(value: unknown): value is { fingerprint: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"fingerprint" in value &&
		typeof value.fingerprint === "string"
	);
}

async function fingerprint(files: string[], resolved: ResolvedSkill[] = []): Promise<string> {
	const resolvedLines = resolved.map((skill) =>
		JSON.stringify([
			"resolved",
			skill.name,
			normalizeSkillDescription(skill.description),
			skill.filePath,
			skill.disableModelInvocation === true,
			skill.sourceInfo?.scope ?? "",
			skill.sourceInfo?.origin ?? "",
		]),
	);
	const fileLines: string[] = [];
	for (const file of files) {
		try {
			const info = await stat(file);
			let contentHash: string;
			try {
				contentHash = createHash("sha1").update(await readFile(file)).digest("hex");
			} catch {
				fileLines.push(`${file}:unreadable`);
				continue;
			}
			fileLines.push(`${file}:${info.mtimeMs}:${info.size}:${contentHash}`);
		} catch {
			fileLines.push(`${file}:missing`);
		}
	}
	return createHash("sha1")
		.update([`schema:${REGISTRY_SCHEMA_VERSION}`, ...resolvedLines, ...fileLines.sort()].join("\n"))
		.digest("hex");
}

function renderRegistry(cwd: string, sources: string[], entries: SkillEntry[], resolvedCount = 0): string {
	const projectName = basename(cwd);
	const today = new Date().toISOString().slice(0, 10);
	const lines: string[] = [];
	lines.push(`# Skill Registry — ${projectName}`);
	lines.push("");
	lines.push("<!-- Auto-generated by gentle-pi extensions/skill-registry.ts. Run /skill-registry:refresh to regenerate. -->");
	lines.push("");
	lines.push(`Last updated: ${today}`);
	lines.push("");
	lines.push("## Sources scanned");
	lines.push("");
	if (resolvedCount > 0) {
		lines.push(`- Pi-resolved runtime authority (before_agent_start.systemPromptOptions.skills): ${resolvedCount} skill(s)`);
	}
	for (const src of sources) {
		lines.push(`- ${src}`);
	}
	lines.push("");
	lines.push("## Contract");
	lines.push("");
	lines.push("**Delegator use only.** This registry is an index, not a summary. Any agent that launches subagents reads it to select relevant skills, then passes exact `SKILL.md` paths for the subagent to read before work.");
	lines.push("");
	lines.push("`SKILL.md` remains the source of truth. Do not inject generated summaries or compact rules by default; pass paths so subagents load the full runtime contract and preserve author intent.");
	lines.push("");
	lines.push(SECTION_MARKER);
	lines.push("");
	lines.push("| Skill | Trigger / description | Scope | Path |");
	lines.push("| --- | --- | --- | --- |");
	for (const entry of entries) {
		lines.push(`| \`${markdownCell(entry.name)}\` | ${markdownCell(entry.description)} | ${markdownCell(entry.scope ?? scopeForPath(cwd, entry.path))} | \`${markdownCell(entry.path)}\` |`);
	}
	lines.push("");
	lines.push("## Loading protocol");
	lines.push("");
	lines.push("1. Match task context and target files against the `Trigger / description` column.");
	lines.push("2. Pass only the matching `Path` values to the subagent under `## Skills to load before work`.");
	lines.push("3. Instruct the subagent to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.");
	lines.push("4. If no matching skill exists, proceed without project skill injection and report `skill_resolution: none`.");
	return `${lines.join("\n").trimEnd()}\n`;
}

interface RegenResult {
	regenerated: boolean;
	skillCount: number;
	reason: string;
	warning?: string;
}

const execFileAsync = promisify(execFile);

// A failed Git lookup is genuinely non-Git only when no ancestor has metadata.
// lstat also detects dangling redirects; permission failures remain fail-closed.
async function hasNoGitMetadata(cwd: string): Promise<boolean> {
	if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return false;
	const ceilings = (process.env.GIT_CEILING_DIRECTORIES ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path));
	let directory = resolve(cwd);
	for (;;) {
		// Git does not inspect ancestors at or above its discovery ceiling.
		if (directory !== resolve(cwd) && ceilings.includes(directory)) return true;
		try {
			await lstat(join(directory, ".git"));
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		}
		const parent = dirname(directory);
		if (parent === directory) return true;
		directory = parent;
	}
}

// Freshness (including forced self-heal) never grants automatic write permission.
async function automaticWriteWarning(
	cwd: string,
	targets: string[],
	remedy = "Run /skill-registry:refresh to deliberately regenerate runtime files.",
): Promise<string | undefined> {
	let tracked: string[];
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z", "--", ...targets], {
			cwd,
			env: { ...process.env, LC_ALL: "C" },
		});
		tracked = stdout.split("\0").filter(Boolean);
	} catch (error) {
		const failure = error as { code?: number | string; stderr?: string };
		// A missing cwd cannot hold tracked targets, but git cannot even spawn there.
		if (failure.code === "ENOENT" && !(await pathExists(cwd))) return undefined;
		if (failure.code === 128 && failure.stderr?.startsWith("fatal: not a git repository") && await hasNoGitMetadata(cwd)) return undefined;
		throw new Error(`Cannot verify Git tracking for ${targets.join(", ")}; automatic writes skipped. Resolve Git detection, or deliberately run /skill-registry:refresh.`);
	}
	if (tracked.length === 0) return undefined;
	return `Skill registry automatic writes skipped for tracked targets: ${tracked.join(", ")}. ${remedy}`;
}

async function ensureAtlIgnored(cwd: string, intentional = false): Promise<string | undefined> {
	const atlDir = join(cwd, ".atl");
	const gitignorePath = join(atlDir, ".gitignore");
	if (!intentional) {
		const warning = await automaticWriteWarning(cwd, [".atl/.gitignore"]);
		if (warning) return warning;
	}
	if (await pathExists(gitignorePath)) {
		const existing = await readFile(gitignorePath, "utf8");
		const ignoreRules = existing
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		if (ignoreRules.at(-1) === "*") {
			return;
		}
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		await writeFile(gitignorePath, `${existing}${prefix}*\n`);
		return;
	}
	await mkdir(atlDir, { recursive: true });
	await writeFile(gitignorePath, "*\n");
}

function isGeneratedLegacyProjectRegistry(source: string): boolean {
	return (
		source.includes("Auto-generated by .pi/extensions/skill-registry.ts") &&
		source.includes("const REGISTRY_REL_PATH = \".atl/skill-registry.md\"") &&
		source.includes("function projectSkillDirs(cwd: string): string[]") &&
		source.includes("function regenerateRegistry(cwd: string, force: boolean)") &&
		(!source.includes('join(cwd, "skills")') ||
			source.includes("const dirs = [...userSkillDirs(), ...projectSkillDirs(cwd)]") ||
			source.includes("if (rules.length === 0) return undefined"))
	);
}

async function nextLegacyDisabledPath(cwd: string): Promise<string> {
	const base = join(cwd, LEGACY_PROJECT_REGISTRY_DISABLED_REL_PATH);
	if (!(await pathExists(base))) return base;
	for (let i = 1; i < 100; i++) {
		const candidate = `${base}.${i}`;
		if (!(await pathExists(candidate))) return candidate;
	}
	return `${base}.${Date.now()}`;
}

async function quarantineLegacyProjectRegistry(cwd: string, notifyWarning: (message: string) => void): Promise<boolean> {
	const legacyPath = join(cwd, LEGACY_PROJECT_REGISTRY_REL_PATH);
	if (!(await pathExists(legacyPath))) return false;
	let source = "";
	try {
		source = await readFile(legacyPath, "utf8");
	} catch {
		return false;
	}
	if (!isGeneratedLegacyProjectRegistry(source)) return false;
	const disabledPath = await nextLegacyDisabledPath(cwd);
	const warning = await automaticWriteWarning(
		cwd,
		[LEGACY_PROJECT_REGISTRY_REL_PATH, relative(cwd, disabledPath).split(sep).join("/")],
		"Review and manually handle the tracked legacy extension (and any tracked quarantine destination) before retrying startup; refresh only regenerates registry runtime files.",
	);
	if (warning) {
		notifyWarning(warning);
		return false;
	}
	try {
		await rename(legacyPath, disabledPath);
		return true;
	} catch {
		return false;
	}
}

async function regenerateRegistry(
	cwd: string,
	force: boolean,
	resolved: ResolvedSkill[] = [],
	intentional = false,
): Promise<RegenResult> {
	const existingDirs = await uniqueExistingDirs([
		...projectSkillDirs(cwd),
		...userSkillDirs(),
	]);
	const files: string[] = [];
	for (const dir of existingDirs) {
		files.push(...(await findSkillFiles(dir)));
	}
	const cachePath = join(cwd, CACHE_REL_PATH);
	const registryPath = join(cwd, REGISTRY_REL_PATH);
	const fp = await fingerprint(files, resolved);
	let cached: string | undefined;
	if (await pathExists(cachePath)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
			cached = isCacheFile(parsed) ? parsed.fingerprint : undefined;
		} catch {
			cached = undefined;
		}
	}
	if (!force && cached === fp && (await pathExists(registryPath))) {
		return { regenerated: false, skillCount: 0, reason: "cache-hit" };
	}
	if (!intentional) {
		const warning = await automaticWriteWarning(cwd, [REGISTRY_REL_PATH, CACHE_REL_PATH]);
		if (warning) return { regenerated: false, skillCount: 0, reason: "tracked-target", warning };
	}
	const entries: SkillEntry[] = [];
	for (const file of files) {
		const entry = await loadSkill(file);
		if (entry) entries.push(entry);
	}
	const resolvedEntries: SkillEntry[] = [];
	for (const skill of resolved) {
		const entry = toResolvedEntry(skill, cwd);
		if (entry) resolvedEntries.push(entry);
	}
	const deduped = mergeResolvedWithLoose(resolvedEntries, entries, cwd);
	const sources = existingDirs.map((d) => {
		const rel = relative(cwd, d);
		return rel.startsWith("..") ? d : rel || ".";
	});
	const md = renderRegistry(cwd, sources, deduped, resolvedEntries.length);
	await mkdir(join(cwd, ".atl"), { recursive: true });
	await writeFile(registryPath, md);
	await writeFile(cachePath, JSON.stringify({ fingerprint: fp }, null, 2));
	return {
		regenerated: true,
		skillCount: deduped.length,
		reason: force ? "forced" : "fingerprint-changed",
	};
}

const watchedCwds = new Set<string>();

function isTruthyEnv(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasCliArg(args: string[], ...names: string[]): boolean {
	return args.some((arg) => names.includes(arg));
}

function shouldSkipSkillRegistryStartup(
	pi: Pick<ExtensionAPI, "getFlag">,
	argv = process.argv.slice(2),
	env = process.env,
): boolean {
	return (
		// gentle-shell#1690: delegated children share the parent's cwd; the
		// parent owns .atl/ writes, the legacy rename and the watcher.
		env.GENTLE_PI_AGENTS_CHILD === "1" ||
		pi.getFlag(NO_SKILL_REGISTRY_FLAG) === true ||
		isTruthyEnv(env[NO_SKILL_REGISTRY_ENV]) ||
		hasCliArg(argv, "--no-skills", "-ns")
	);
}

function normalizeExtensionSource(source: string): string {
	return source.split(/[?#]/, 1)[0];
}

function extensionSourcePath(source: string): string | undefined {
	const cleanSource = normalizeExtensionSource(source);
	if (!cleanSource.startsWith("file:")) return undefined;
	try {
		return comparablePath(fileURLToPath(cleanSource));
	} catch {
		return undefined;
	}
}

function shouldSkipDuplicateExtensionLoad(
	source = import.meta.url,
	cwd = process.cwd(),
	state = globalThis as typeof globalThis & SkillRegistryExtensionGlobal,
): boolean {
	const currentPath = extensionSourcePath(source);
	const projectLocalPath = comparablePath(join(cwd, "extensions", "skill-registry.ts"));
	if (currentPath && currentPath !== projectLocalPath && existsSync(projectLocalPath)) {
		return true;
	}

	const currentSource = currentPath ?? normalizeExtensionSource(source);
	const existingSource = state[SKILL_REGISTRY_EXTENSION_SOURCE_KEY];
	if (!existingSource) {
		state[SKILL_REGISTRY_EXTENSION_SOURCE_KEY] = currentSource;
		return false;
	}
	return existingSource !== currentSource;
}

function closeSkillRegistryWatchers(): void {
	for (const watcher of activeWatchers) {
		try {
			watcher.close();
		} catch {
			// Best-effort shutdown; stale handles must not block process exit.
		}
	}
	activeWatchers.clear();
	watchedCwds.clear();
}

async function startSkillRegistryWatcher(
	cwd: string,
	notify: (message: string, level?: "info" | "warning") => void,
): Promise<void> {
	if (watchedCwds.has(cwd)) return;
	watchedCwds.add(cwd);
	const dirs = await uniqueExistingDirs([
		...projectSkillDirs(cwd),
		...userSkillDirs(),
	]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const refresh = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			void (async () => {
				try {
					const result = await regenerateRegistry(cwd, false, lastResolvedSkills);
					if (result.warning) notify(result.warning, "warning");
					if (result.regenerated) {
						notify(`Skill registry refreshed (${result.skillCount} skills)`, "info");
					}
				} catch (error) {
					notify(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			})();
		}, WATCH_DEBOUNCE_MS);
	};
	for (const dir of dirs) {
		try {
			const watcher = watch(dir, { recursive: true }, refresh);
			activeWatchers.add(watcher);
		} catch {
			// Some filesystems do not support recursive watches; session_start/manual refresh still work.
		}
	}
}

export const __testing = {
	projectSkillDirs,
	userSkillDirs,
	findSkillFiles,
	uniqueExistingDirs,
	dedupeBySkillName,
	toResolvedEntry,
	mergeResolvedWithLoose,
	scopeForPath,
	normalizeSkillDescription,
	parseFrontmatter,
	renderRegistry,
	regenerateRegistry,
	applyResolvedSkillsUpdate,
	ensureAtlIgnored,
	shouldSkipSkillRegistryStartup,
	shouldSkipDuplicateExtensionLoad,
	startSkillRegistryWatcher,
	closeSkillRegistryWatchers,
	activeWatcherCount() {
		return activeWatchers.size;
	},
};

export default function (pi: ExtensionAPI) {
	if (shouldSkipDuplicateExtensionLoad()) return;

	pi.on("session_shutdown", () => {
		closeSkillRegistryWatchers();
		lastResolvedSkills = [];
	});

	pi.registerFlag(NO_SKILL_REGISTRY_FLAG, {
		description: "Skip the Gentle AI skill registry refresh and watcher on startup.",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (shouldSkipSkillRegistryStartup(pi)) return;
		const notifyWarning = (message: string) => {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
		};
		try {
			const ignoreWarning = await ensureAtlIgnored(ctx.cwd);
			if (ignoreWarning) notifyWarning(ignoreWarning);
			const quarantinedLegacy = await quarantineLegacyProjectRegistry(ctx.cwd, notifyWarning);
			const result = await regenerateRegistry(ctx.cwd, quarantinedLegacy);
			if (result.warning) notifyWarning(result.warning);
			if (result.regenerated && ctx.hasUI) {
				ctx.ui.notify(
					`Skill registry refreshed (${result.skillCount} skills)`,
					"info",
				);
			}
			if (quarantinedLegacy && ctx.hasUI) {
				ctx.ui.notify(
					"Disabled stale project-local skill registry extension; using package registry with project skills first.",
					"warning",
				);
			}
			if (ctx.hasUI) {
				await startSkillRegistryWatcher(ctx.cwd, (message, level = "info") => {
					ctx.ui.notify(message, level);
				});
			}
			if (quarantinedLegacy) {
				setTimeout(() => {
					void (async () => {
						try {
							const result = await regenerateRegistry(ctx.cwd, true);
							if (result.warning) notifyWarning(result.warning);
						} catch (error) {
							notifyWarning(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					})();
				}, WATCH_DEBOUNCE_MS);
			}
		} catch (error) {
			if (ctx.hasUI) {
				const message =
					error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Skill registry refresh failed: ${message}`,
					"warning",
				);
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (shouldSkipSkillRegistryStartup(pi)) return;
		const skills = event.systemPromptOptions?.skills;
		if (!Array.isArray(skills) || !skills.every(isResolvedSkill)) return;
		try {
			const result = await applyResolvedSkillsUpdate(ctx.cwd, skills);
			if (result.regenerated && ctx.hasUI) {
				ctx.ui.notify(
					`Skill registry refreshed (${result.skillCount} skills)`,
					"info",
				);
			}
		} catch {
			// Keep the runtime capture best-effort; a failed refresh must never break the agent turn.
		}
	});

	pi.registerCommand("skill-registry:refresh", {
		description: "Regenerate .atl/skill-registry.md from local skill sources.",
		handler: async (_args, ctx) => {
			try {
				await ensureAtlIgnored(ctx.cwd, true);
				const result = await regenerateRegistry(ctx.cwd, true, lastResolvedSkills, true);
				ctx.ui.notify(
					`Skill registry: ${result.skillCount} skill(s) written to ${REGISTRY_REL_PATH}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Skill registry refresh failed: ${message}`, "warning");
			}
		},
	});
}
