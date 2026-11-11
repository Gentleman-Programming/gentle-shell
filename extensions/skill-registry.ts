import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, type FSWatcher, watch } from "node:fs";
import {
	access,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "../lib/append-system-prompt.ts";
import { isHomeOrBroadUserDirectory } from "../lib/bounded-writer-admission.ts";
import { resolveSessionWorktree } from "../lib/session-worktree-registry.ts";

const REGISTRY_REL_PATH = ".atl/skill-registry.md";
const CACHE_REL_PATH = ".atl/.skill-registry.cache.json";
const SECTION_MARKER = "## Skills";
const EXCLUDE_NAMES = new Set(["_shared", "skill-registry"]);
const EXCLUDE_PREFIXES = ["sdd-"];
// The registry skill's shipped name. Excluded from the session view only: the
// shared disk index keeps byte parity with the Gentle AI CLI writer.
const SESSION_EXCLUDE_NAMES = new Set(["gentle-ai-skill-registry"]);
const WATCH_DEBOUNCE_MS = 500;
// inotify budgets are finite (ENOSPC/EMFILE) and recursive watches degrade
// silently on exhausted systems -- WSL2 hits this constantly -- so a slow
// poll is the floor that keeps regeneration working when the OS cannot
// deliver change events. Each poll validates the rendered disk bytes.
const WATCH_FALLBACK_POLL_MS = 2_000;
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

async function userSkillDirs(): Promise<string[]> {
	const home = resolve(homedir());
	// Match CodexConfigDir: an invalid override stays at its resolved location,
	// rather than silently falling back to ~/.codex.
	let codex = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, ".codex");
	if (process.env.CODEX_HOME) {
		try {
			if ((await stat(codex)).isDirectory()) codex = await realpath(codex);
		} catch { /* Invalid overrides are not redirected. */ }
	}
	return [
		join(home, ".pi/agent/skills"),
		join(home, ".config/agents/skills"),
		join(home, ".agents/skills"),
		join(home, ".kimi-code/skills"),
		join(home, ".kimi/skills"),
		join(home, ".config/opencode/skills"),
		join(home, ".config/kilo/skills"),
		join(home, ".claude/skills"),
		join(home, ".gemini/skills"),
		join(home, ".gemini/config/skills"),
		join(home, ".gemini/antigravity/skills"),
		join(home, ".gemini/antigravity-desktop/skills"),
		join(home, ".gemini/antigravity-cli/skills"),
		join(home, ".cursor/skills"),
		join(home, ".copilot/skills"),
		join(codex, "skills"),
		join(home, ".codeium/windsurf/skills"),
		join(home, ".qwen/skills"),
		join(home, ".kiro/skills"),
		join(home, ".openclaw/skills"),
		join(home, ".hermes/skills"),
		join(home, ".trae/skills"),
	];
}

function projectSkillDirs(cwd: string): string[] {
	cwd = resolve(cwd);
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
		join(cwd, ".hermes/skills"),
	];
}

// gentle-shell#373: only storage-capacity/permission faults degrade the
// registry to a typed unavailable result. Anything else (ELOOP, ENOSPC, a
// failing device) keeps its own diagnostic through the ordinary error path.
function isStorageUnavailableError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOTDIR" || code === "EISDIR" || code === "EEXIST";
}

function isMissingSkillFileError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function findSkillFiles(root: string): Promise<string[]> {
	if (!(await pathExists(root))) return [];
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}

	const directSkills: string[] = [];
	const nestedSkills: string[] = [];
	for (const entry of entries) {
		// Excluded directory names remain excluded even if frontmatter aliases them.
		if (isExcluded(entry.name)) continue;
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
			if (skillInfo.isFile()) directSkills.push(candidate);
			continue;
		} catch (error) {
			if (!isMissingSkillFileError(error)) continue;
		}
		if (entry.isSymbolicLink()) continue;

		let nestedEntries;
		try {
			nestedEntries = await readdir(skillDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const nestedEntry of nestedEntries) {
			if (nestedEntry.isSymbolicLink() || isExcluded(nestedEntry.name)) continue;
			const nestedSkillDir = join(skillDir, nestedEntry.name);
			let nestedDirInfo;
			try {
				nestedDirInfo = await stat(nestedSkillDir);
			} catch {
				continue;
			}
			if (!nestedDirInfo.isDirectory()) continue;

			const nestedCandidate = join(nestedSkillDir, "SKILL.md");
			try {
				const nestedSkillInfo = await stat(nestedCandidate);
				if (nestedSkillInfo.isFile()) nestedSkills.push(nestedCandidate);
			} catch {
				// Missing or unreadable skill files are ignored; the registry is best-effort.
			}
		}
	}
	return [...directSkills.sort(compareUtf8), ...nestedSkills.sort(compareUtf8)];
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
		const m = line.match(/^(\w+):(.*)$/);
		if (!m) continue;
		const key = m[1];
		let value = trimUnicodeWhitespace(m[2]);
		if (value === ">" || value === ">-" || value === "|" || value === "|-") {
			const block: string[] = [];
			while (i + 1 < lines.length) {
				const next = lines[i + 1];
				if (trimUnicodeWhitespace(next) === "") {
					block.push("");
					i++;
					continue;
				}
				if (!next.startsWith(" ") && !next.startsWith("\t")) break;
				block.push(trimUnicodeWhitespace(next));
				i++;
			}
			value = trimUnicodeWhitespace(block.join(" "));
		} else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
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
		const clean = comparablePath(resolve(dir));
		if (seen.has(clean)) continue;
		try {
			if (!(await stat(clean)).isDirectory()) continue;
			await access(clean, constants.R_OK);
		} catch { continue; }
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

const UNICODE_WHITESPACE = "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const whitespaceRuns = new RegExp(`[${UNICODE_WHITESPACE}]+`, "g");
const whitespaceEdges = new RegExp(`^[${UNICODE_WHITESPACE}]+|[${UNICODE_WHITESPACE}]+$`, "g");
function trimUnicodeWhitespace(value: string): string {
	return value.replace(whitespaceEdges, "");
}
function normalizeSkillDescription(description: string): string {
	return trimUnicodeWhitespace(description.replace(whitespaceRuns, " "));
}
function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left), Buffer.from(right));
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
	return out.sort((a, b) => compareUtf8(a.name, b.name));
}

function resolvedScopeLabel(skill: ResolvedSkill): string {
	const scope = skill.sourceInfo?.scope === "project" ? "project" : "user";
	return skill.sourceInfo?.origin === "package" ? `${scope} · package` : scope;
}

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

function mergeResolvedWithLoose(
	resolved: SkillEntry[],
	loose: SkillEntry[],
	cwd: string,
	suppressedPaths: readonly string[] = [],
): SkillEntry[] {
	const resolvedPaths = new Set(resolved.map((entry) => comparablePath(entry.path)));
	// Every runtime-resolved path was filtered by Pi's own rules, so a skill Pi
	// hides (disableModelInvocation or an excluded name) must never come back
	// as an active row through a loose root that still holds its SKILL.md.
	for (const path of suppressedPaths) resolvedPaths.add(comparablePath(path));
	const filteredLoose = loose.filter((entry) => !resolvedPaths.has(comparablePath(entry.path)));
	return dedupeBySkillName([...resolved, ...filteredLoose], cwd);
}

function scopeForPath(cwd: string, path: string): string {
	const cleanCwd = comparablePath(cwd);
	const projectPrefix = cleanCwd.endsWith(sep) ? cleanCwd : `${cleanCwd}${sep}`;
	return comparablePath(path).startsWith(projectPrefix) ? "project" : "user";
}

function markdownCell(value: string): string {
	const trimmed = trimUnicodeWhitespace(value.replace(/\n/g, " ").replace(/\|/g, "\\|"));
	return trimmed.length > 0 ? trimmed : "—";
}

function renderRows(cwd: string, entries: SkillEntry[], withScope = true): string[] {
	return entries.map((entry) => {
		const scope = withScope ? ` ${markdownCell(entry.scope ?? scopeForPath(cwd, entry.path))} |` : "";
		return `| \`${markdownCell(entry.name)}\` | ${markdownCell(entry.description)} |${scope} \`${markdownCell(entry.path)}\` |`;
	});
}

function renderRegistry(cwd: string, sources: string[], entries: SkillEntry[]): string {
	return [
		`# Skill Registry — ${basename(cwd)}`, "",
		"<!-- Shared disk skill registry; generated by Gentle Shell or Gentle AI. -->", "",
		"## Sources scanned", "", ...sources.map((source) => `- ${source}`), "",
		"## Contract", "",
		"**Delegator use only.** This disk index is not a summary and excludes session-only runtime skills. Pi delegators use their effective session view; other delegators use these rows. Pass exact `SKILL.md` paths to subagents.", "",
		"`SKILL.md` remains the source of truth. Do not inject generated summaries or compact rules by default; pass paths so subagents load the full runtime contract and preserve author intent.", "",
		SECTION_MARKER, "", "| Skill | Trigger / description | Scope | Path |", "| --- | --- | --- | --- |",
		...renderRows(cwd, entries), "", "## Loading protocol", "",
		"1. Match task context and target files against the effective view's `Trigger / description` column.",
		"2. Pass only the matching `Path` values to the subagent under `## Skills to load before work`.",
		"3. Instruct the subagent to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.",
		"4. If no matching skill exists, proceed without project skill injection and report `skill_resolution: none`.", "",
	].join("\n");
}

async function scanDisk(cwd: string): Promise<{ sources: string[]; entries: SkillEntry[] }> {
	const dirs = await uniqueExistingDirs([...projectSkillDirs(cwd), ...await userSkillDirs()]);
	const entries: SkillEntry[] = [];
	for (const dir of dirs) {
		for (const file of await findSkillFiles(dir)) {
			const entry = await loadSkill(file);
			if (entry) entries.push(entry);
		}
	}
	const sources = dirs.map((dir) => {
		const rel = relative(cwd, dir);
		return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? dir : rel || ".";
	});
	return { sources, entries };
}

const EFFECTIVE_BEGIN = "<!-- gentle-pi effective skills begin -->";
const EFFECTIVE_END = "<!-- gentle-pi effective skills end -->";
function clearEffectivePrompt(options: AppendableSystemPromptOptions | undefined): void {
	if (!options) return;
	const current = options.appendSystemPrompt ?? "";
	const start = current.indexOf(EFFECTIVE_BEGIN);
	if (start < 0) return;
	const end = current.indexOf(EFFECTIVE_END, start);
	if (end < 0) return;
	const prefix = current.slice(0, start).replace(/\n\n$/, "");
	options.appendSystemPrompt = prefix + current.slice(end + EFFECTIVE_END.length);
}

// Pi already lists every skill it loaded in `<available_skills>`, so only the
// effective winners Pi did not list are rendered; nothing is emitted when
// there are none. Rows keep dedupeBySkillName's name order across turns.
function unlistedEntries(effective: SkillEntry[], listed: SkillEntry[]): SkillEntry[] {
	const listedPaths = new Set(listed.map((entry) => comparablePath(entry.path)));
	return effective.filter((entry) => !listedPaths.has(comparablePath(entry.path)) && !SESSION_EXCLUDE_NAMES.has(entry.name));
}

// Mirrors Pi 1.5.2 buildSystemPromptSections (dist/core/system-prompt.js:101-108):
// `<available_skills>` renders only when `read` or `bash` is a selected tool,
// and an absent tool list defaults to read, bash, edit and write.
function piRendersAvailableSkills(options: { selectedTools?: unknown }): boolean {
	const selected = Array.isArray(options.selectedTools) ? options.selectedTools : ["read", "bash", "edit", "write"];
	return ["read", "bash"].some((tool) => selected.includes(tool));
}

function appendEffectivePrompt(options: AppendableSystemPromptOptions, cwd: string, entries: SkillEntry[], piListed: boolean): void {
	if (entries.length === 0) return;
	appendSystemPromptOnce(options, [
		EFFECTIVE_BEGIN,
		piListed
			? "## Effective session skills: on disk, not loaded by Pi; `<available_skills>` lists the rest"
			: "## Effective session skills: all skills (Pi renders no `<available_skills>` without `read` or `bash`)",
		"| Skill | Trigger / description | Path |",
		"| --- | --- | --- |",
		...renderRows(cwd, entries, false), EFFECTIVE_END,
	].join("\n"));
}

async function readOptional(path: string): Promise<Buffer | undefined> {
	try { return await readFile(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

// Stage each complete file beside its target, then replace it atomically.
// Registry and cache are deliberately separate publications, not a transaction.
async function writeAtomic(path: string, content: string): Promise<void> {
	let mode = 0o666 & ~process.umask();
	try { mode = (await stat(path)).mode & 0o7777; }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let created = false;
	try {
		const file = await open(temporary, "wx", mode);
		created = true;
		try { await file.chmod(mode); await file.writeFile(content, "utf8"); }
		finally { await file.close(); }
		await rename(temporary, path);
		created = false;
	} catch (error) {
		if (typeof error === "object" && error !== null && "path" in error && (error as NodeJS.ErrnoException).path === temporary) {
			(error as NodeJS.ErrnoException).path = path;
		}
		throw error;
	} finally {
		if (created) await unlink(temporary).catch(() => undefined);
	}
}

interface RegenResult {
	regenerated: boolean;
	skillCount: number;
	reason: string;
	warning?: string;
}

const execFileAsync = promisify(execFile);
// A tracking check that cannot answer (for example a repository rooted at HOME)
// fails closed through the ordinary detection-failure path instead of hanging.
let gitTimeoutMs = 5000;

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
export async function automaticWriteWarning(
	cwd: string,
	targets: string[],
	remedy = "Run /skill-registry:refresh to deliberately regenerate runtime files.",
): Promise<string | undefined> {
	let tracked: string[];
	try {
		const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "-z", "--", ...targets], {
			cwd,
			env: { ...process.env, LC_ALL: "C" },
			timeout: gitTimeoutMs,
			windowsHide: true,
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

async function regenerateRegistry(cwd: string, force: boolean, intentional = false): Promise<RegenResult> {
	cwd = resolve(cwd);
	const { sources, entries } = await scanDisk(cwd);
	const deduped = dedupeBySkillName(entries, cwd);
	const md = renderRegistry(cwd, sources, deduped);
	const cache = `${JSON.stringify({ schema: 1, registry_sha256: createHash("sha256").update(md).digest("hex") })}\n`;
	const registryPath = join(cwd, REGISTRY_REL_PATH);
	const cachePath = join(cwd, CACHE_REL_PATH);
	try {
		const registryChanged = !(await readOptional(registryPath))?.equals(Buffer.from(md));
		const cacheChanged = !(await readOptional(cachePath))?.equals(Buffer.from(cache));
		if (!registryChanged && !cacheChanged) return { regenerated: false, skillCount: deduped.length, reason: "cache-hit" };
		if (!intentional) {
			const warning = await automaticWriteWarning(cwd, [REGISTRY_REL_PATH, CACHE_REL_PATH]);
			if (warning) return { regenerated: false, skillCount: 0, reason: "tracked-target", warning };
		}
		await mkdir(join(cwd, ".atl"), { recursive: true });
		if (registryChanged) await writeAtomic(registryPath, md);
		if (cacheChanged) await writeAtomic(cachePath, cache);
		return { regenerated: registryChanged, skillCount: deduped.length, reason: registryChanged ? (force ? "forced" : "fingerprint-changed") : "cache-hit" };
	} catch (error) {
		if (isStorageUnavailableError(error)) {
			const path = typeof (error as NodeJS.ErrnoException).path === "string" ? (error as NodeJS.ErrnoException).path as string : registryPath;
			const relativePath = relative(cwd, path).split(sep).join("/") || REGISTRY_REL_PATH;
			return {
				regenerated: false,
				skillCount: 0,
				reason: "storage-unavailable",
				warning: `Skill registry is unavailable: ${relativePath} is not writable (${(error as NodeJS.ErrnoException).code}). Restore write access, then run /skill-registry:refresh.`,
			};
		}
		throw error;
	}
}

const watchedCwds = new Set<string>();
const watcherPolls = new Map<string, ReturnType<typeof setInterval>>();
// Debounced watcher refreshes, cleared on shutdown so none fires into a
// replaced or reloaded session.
const watcherTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Startup regeneration runs after session_start returns; watcher refreshes
// wait for it so an older startup scan never overwrites a newer refresh.
const pendingStartups = new Map<string, Promise<void>>();
let startupGeneration = 0;

// A repository rooted at HOME (or a broad user folder) makes every Git call
// scan the user's whole tree. gentle-ai owns the single user-facing warning.
function repositoryRootedAtHome(cwd: string): boolean {
	const root = resolveSessionWorktree(cwd, cwd)?.root;
	return root !== undefined && isHomeOrBroadUserDirectory(root);
}

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
	state: SkillRegistryExtensionGlobal = globalThis as typeof globalThis & SkillRegistryExtensionGlobal,
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
	for (const poll of watcherPolls.values()) clearInterval(poll);
	watcherPolls.clear();
	for (const timer of watcherTimers.values()) clearTimeout(timer);
	watcherTimers.clear();
	watchedCwds.clear();
}

/**
 * Pi's runner throws on any access to a ctx made stale by reload or session
 * replacement (/reload, /resume, /new). Late async notices must neither reach
 * that ctx nor let its throw escape as an uncaught exception.
 */
function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	try {
		void ctx.sessionManager;
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// The session ended; nobody is left to show this notice to.
	}
}

async function startSkillRegistryWatcher(
	cwd: string,
	notify: (message: string, level?: "info" | "warning") => void,
): Promise<void> {
	if (watchedCwds.has(cwd)) return;
	watchedCwds.add(cwd);
	const generation = startupGeneration;
	const dirs = await uniqueExistingDirs([
		...projectSkillDirs(cwd),
		...await userSkillDirs(),
	]);
	if (generation !== startupGeneration) return;
	// The poll re-asks a state the watchers already answered: without this,
	// an unchanged tracked-target warning would repeat every poll interval.
	let lastWarning: string | undefined;
	const refresh = () => {
		if (generation !== startupGeneration) return;
		const previous = watcherTimers.get(cwd);
		if (previous) clearTimeout(previous);
		watcherTimers.set(cwd, setTimeout(() => {
			watcherTimers.delete(cwd);
			void (async () => {
				try {
					await pendingStartups.get(cwd);
					if (generation !== startupGeneration) return;
					const result = await regenerateRegistry(cwd, false);
					if (generation !== startupGeneration) return;
					if (result.warning) {
						if (result.warning !== lastWarning) notify(result.warning, "warning");
						lastWarning = result.warning;
					} else {
						lastWarning = undefined;
						if (result.regenerated) {
							notify(`Skill registry refreshed (${result.skillCount} skills)`, "info");
						}
					}
				} catch (error) {
					if (generation !== startupGeneration) return;
					notify(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			})();
		}, WATCH_DEBOUNCE_MS));
	};
	for (const dir of dirs) {
		try {
			const watcher = watch(dir, { recursive: true }, refresh);
			watcher.on("error", (error) => {
				// Recursive rescans can fail after watch() returns (e.g. a removed
				// assets directory). Without this listener Node terminates Pi.
				watcher.close();
				activeWatchers.delete(watcher);
				notify(`Skill registry watcher stopped: ${error.message}. Run /skill-registry:refresh to update manually.`, "warning");
			});
			activeWatchers.add(watcher);
		} catch {
			// Some filesystems do not support recursive watches; session_start/manual refresh still work.
		}
	}
	// Watchers may be absent (unsupported filesystem) or silently eventless
	// (exhausted inotify budget): the poll keeps regeneration alive either way.
	if (!watcherPolls.has(cwd)) watcherPolls.set(cwd, setInterval(refresh, WATCH_FALLBACK_POLL_MS));
}

export const __testing = {
	projectSkillDirs,
	userSkillDirs,
	findSkillFiles,
	isMissingSkillFileError,
	isStorageUnavailableError,
	uniqueExistingDirs,
	dedupeBySkillName,
	toResolvedEntry,
	mergeResolvedWithLoose,
	scopeForPath,
	normalizeSkillDescription,
	parseFrontmatter,
	renderRegistry,
	regenerateRegistry,
	ensureAtlIgnored,
	shouldSkipSkillRegistryStartup,
	shouldSkipDuplicateExtensionLoad,
	startSkillRegistryWatcher,
	closeSkillRegistryWatchers,
	activeWatcherCount() {
		return activeWatchers.size;
	},
	async startupSettled(): Promise<void> {
		await Promise.all(pendingStartups.values());
	},
	setGitTimeoutMs(ms: number): number {
		const previous = gitTimeoutMs;
		gitTimeoutMs = ms;
		return previous;
	},
};

export default function (pi: ExtensionAPI) {
	if (shouldSkipDuplicateExtensionLoad()) return;
	// This capture belongs to this extension instance, never to the shared file.
	let lastResolvedSkills: ResolvedSkill[] = [];

	pi.on("session_shutdown", () => {
		startupGeneration += 1;
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
		if (repositoryRootedAtHome(ctx.cwd)) return;
		const cwd = ctx.cwd;
		const generation = startupGeneration;
		const notifyWarning = (message: string) => notifyIfLive(ctx, message, "warning");
		const regenerate = async () => {
			if (generation !== startupGeneration) return;
			try {
				const ignoreWarning = await ensureAtlIgnored(cwd);
				if (ignoreWarning) notifyWarning(ignoreWarning);
				const quarantinedLegacy = await quarantineLegacyProjectRegistry(cwd, notifyWarning);
				const result = await regenerateRegistry(cwd, quarantinedLegacy);
				if (result.warning) notifyWarning(result.warning);
				if (result.regenerated) {
					notifyIfLive(ctx, `Skill registry refreshed (${result.skillCount} skills)`, "info");
				}
				if (quarantinedLegacy) {
					notifyWarning("Disabled stale project-local skill registry extension; using package registry with project skills first.");
				}
				if (quarantinedLegacy) {
					setTimeout(() => {
						if (generation !== startupGeneration) return;
						void (async () => {
							try {
								const result = await regenerateRegistry(cwd, true);
								if (result.warning) notifyWarning(result.warning);
							} catch (error) {
								notifyWarning(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
							}
						})();
					}, WATCH_DEBOUNCE_MS);
				}
			} catch (error) {
				notifyWarning(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		};
		// Pi awaits session_start handlers one after another, so the Git tracking
		// checks and the skill scan run after startup instead of inside it.
		const startup = new Promise<void>((resolve) => setImmediate(resolve))
			.then(regenerate)
			.catch(() => { /* A replaced session's stale UI must not surface here. */ })
			.finally(() => { if (pendingStartups.get(cwd) === startup) pendingStartups.delete(cwd); });
		pendingStartups.set(cwd, startup);
		try {
			if (ctx.hasUI) {
				await startSkillRegistryWatcher(cwd, (message, level = "info") => {
					notifyIfLive(ctx, message, level);
				});
			}
		} catch (error) {
			notifyWarning(`Skill registry refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const options = event.systemPromptOptions;
		clearEffectivePrompt(options);
		if (shouldSkipSkillRegistryStartup(pi) || !options) return;
		const skills = options.skills;
		if (Array.isArray(skills) && skills.every(isResolvedSkill)) {
			lastResolvedSkills = skills.map(trimResolvedSkill);
		}
		try {
			const { entries } = await scanDisk(resolve(ctx.cwd));
			const resolved = lastResolvedSkills.map((skill) => toResolvedEntry(skill, ctx.cwd))
				.filter((entry): entry is SkillEntry => entry !== undefined);
			const effective = mergeResolvedWithLoose(resolved, entries, ctx.cwd, lastResolvedSkills.map((skill) => skill.filePath));
			const piListed = piRendersAvailableSkills(options as { selectedTools?: unknown });
			appendEffectivePrompt(options, ctx.cwd, unlistedEntries(effective, piListed ? resolved : []), piListed);
		} catch {
			// Preserve best-effort behavior without advertising a stale or incomplete view.
		}
	});

	pi.registerCommand("skill-registry:refresh", {
		description: "Regenerate .atl/skill-registry.md from local skill sources.",
		handler: async (_args, ctx) => {
			try {
				await ensureAtlIgnored(ctx.cwd, true);
				const result = await regenerateRegistry(ctx.cwd, true, true);
				if (result.reason === "storage-unavailable") {
					ctx.ui.notify(result.warning ?? "Skill registry is unavailable.", "warning");
					return;
				}
				ctx.ui.notify(
					result.regenerated
						? `Skill registry: ${result.skillCount} skill(s) written to ${REGISTRY_REL_PATH}`
						: `Skill registry: ${result.skillCount} skill(s) unchanged in ${REGISTRY_REL_PATH}`,
					"info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Skill registry refresh failed: ${message}`, "warning");
			}
		},
	});
}
