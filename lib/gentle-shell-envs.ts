import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { CONFIG_CATEGORIES, CONFIG_CATEGORY_FILES, type ConfigCategory, isConfigCategory } from "./gentle-config-scope.ts";

// Named environments for the gentle-shell launcher: pure, side-effect-free
// helpers over injected env/config/file text. An env is an ordinary managed
// `--home` directory under the envs root; the directory itself is the
// registry, so there is no separate list to drift out of sync.

export const ENVS_DIR_ENV = "GENTLE_SHELL_ENVS_DIR";

// Set by the launcher on the Pi process when the home is a named env, so the
// Gentle Shell UI can name it. Never set for any other home.
export const ENV_NAME_ENV = "GENTLE_SHELL_ENV";

// The active env's name for display, or undefined. Only a valid name is
// trusted: the value is shown in the UI, so anything else is ignored.
export function activeEnvName(env: Record<string, string | undefined>): string | undefined {
	const name = env[ENV_NAME_ENV];
	return name !== undefined && validateEnvName(name) === undefined ? name : undefined;
}

const ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

// Lowercase only, so names stay identical on case-insensitive filesystems;
// the leading character excludes `.`, `..`, hidden dirs and flag-like names.
export function validateEnvName(name: string): string | undefined {
	if (ENV_NAME_PATTERN.test(name)) return undefined;
	return `invalid env name "${name}": use 1-40 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit`;
}

export function envsRoot(env: Record<string, string | undefined>, homedir: string): string {
	const override = env[ENVS_DIR_ENV];
	return override !== undefined && override.length > 0 ? override : join(homedir, ".gentle-shell", "envs");
}

export function envDir(root: string, name: string): string {
	return join(root, name);
}

// The env name a home directory stands for, or undefined when it is not a
// direct, validly named child of the envs root (any other --home path).
export function envNameForDir(root: string, dir: string): string | undefined {
	const resolved = resolvePath(dir);
	if (dirname(resolved) !== resolvePath(root)) return undefined;
	const name = basename(resolved);
	return validateEnvName(name) === undefined ? name : undefined;
}

// --- config.json mutations ---------------------------------------------------
// All return a new object, keep unknown keys, and never mutate their input.
// `aliases` lists every spelling of the env dir (as given and its realpath),
// because provisioned markers are keyed by realpath.

type RawConfig = Record<string, unknown>;

function provisionedRecord(config: RawConfig): Record<string, unknown> | undefined {
	const value = config.provisioned;
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function setDefaultEnvInConfig(config: RawConfig, dir: string): RawConfig {
	return { ...config, home: dir };
}

// `newProvisionedKey` is the realpath of `newDir` (provisioned markers are
// realpath-keyed); `home` keeps the plain path so it still names the env.
export function renameEnvInConfig(config: RawConfig, aliases: readonly string[], newDir: string, newProvisionedKey: string = newDir): RawConfig {
	const next: RawConfig = { ...config };
	if (typeof config.home === "string" && aliases.includes(config.home)) next.home = newDir;
	const provisioned = provisionedRecord(config);
	if (provisioned !== undefined) {
		const moved: Record<string, unknown> = {};
		let marker: unknown;
		for (const [key, value] of Object.entries(provisioned)) {
			if (aliases.includes(key)) marker ??= value;
			else moved[key] = value;
		}
		if (marker !== undefined) moved[newProvisionedKey] = marker;
		next.provisioned = moved;
	}
	return next;
}

export function removeEnvFromConfig(config: RawConfig, aliases: readonly string[]): RawConfig {
	const next: RawConfig = { ...config };
	if (typeof config.home === "string" && aliases.includes(config.home)) delete next.home;
	const provisioned = provisionedRecord(config);
	if (provisioned !== undefined) {
		next.provisioned = Object.fromEntries(Object.entries(provisioned).filter(([key]) => !aliases.includes(key)));
	}
	return next;
}

// --- per-env info ------------------------------------------------------------

export interface EnvSummaryInput {
	name: string;
	dir: string;
	isDefault: boolean;
	settingsText?: string;
	authText?: string;
	provisioned?: { gentleAi: string; gentlePi?: string; at: string };
	sessionCount: number;
	lastSessionAt?: string;
	// The install's own home (`--isolated`), listed beside the named envs.
	base?: boolean;
	// Gentle config categories this env owns; omitted means none.
	own?: readonly ConfigCategory[];
}

export interface EnvSummary {
	name: string;
	dir: string;
	isDefault: boolean;
	packages: string[];
	// Provider ids only: credential values never leave auth.json.
	providers: string[];
	provisioned: string;
	// False until gentle-shell provisioned this home; its first launch does.
	setUp?: boolean;
	sessionCount: number;
	lastSessionAt?: string;
	base?: boolean;
	// Gentle config categories this env owns (lib/gentle-config-scope.ts).
	own?: ConfigCategory[];
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function packageSources(settingsText: string | undefined): string[] {
	const packages = parseObject(settingsText)?.packages;
	if (!Array.isArray(packages)) return [];
	const sources: string[] = [];
	for (const entry of packages) {
		if (typeof entry === "string") sources.push(entry);
		else if (typeof entry === "object" && entry !== null && typeof (entry as { source?: unknown }).source === "string") {
			sources.push((entry as { source: string }).source);
		}
	}
	return sources;
}

export function summarizeEnv(input: EnvSummaryInput): EnvSummary {
	const p = input.provisioned;
	const provisioned =
		p === undefined ? "not provisioned" : `gentle-ai ${p.gentleAi} · gentle-pi ${p.gentlePi ?? "unknown"} · ${p.at.slice(0, 10)}`;
	return {
		name: input.name,
		dir: input.dir,
		isDefault: input.isDefault,
		packages: packageSources(input.settingsText),
		providers: Object.keys(parseObject(input.authText) ?? {}).sort(),
		provisioned,
		setUp: p !== undefined,
		sessionCount: input.sessionCount,
		lastSessionAt: input.lastSessionAt,
		...(input.base ? { base: true } : {}),
		own: [...(input.own ?? [])],
	};
}

// --- per-env config scope (lib/gentle-config-scope.ts) ------------------------
// Like VS Code profiles: each category of Gentle's config is either shared
// with the base home (live) or owned by the env (its own copy in
// `<env>/gentle-ai`). Only that persistent choice is stored; copying or
// starting empty is a one-time seed when a category becomes own.

export const ENV_SCOPE_FILE = ".gentle-shell-env.json";
const ENV_SCOPE_SCHEMA = 1;

// Tolerant: a missing, malformed or unknown-schema file means "share
// everything", today's behavior for every env created before scopes existed.
export function parseEnvScope(text: string | undefined): ConfigCategory[] {
	const own = parseObject(text);
	if (own === undefined || own.schema !== ENV_SCOPE_SCHEMA || !Array.isArray(own.own)) return [];
	const listed = own.own.filter((value): value is string => typeof value === "string");
	return CONFIG_CATEGORIES.filter((category) => listed.includes(category));
}

export function serializeEnvScope(own: readonly ConfigCategory[]): string {
	return `${JSON.stringify({ schema: ENV_SCOPE_SCHEMA, own: CONFIG_CATEGORIES.filter((category) => own.includes(category)) }, null, 2)}\n`;
}

export interface ScopeFlags {
	own: ConfigCategory[];
	share: ConfigCategory[];
	// Env to copy newly own categories from; undefined copies from the base home.
	from?: string;
	empty: boolean;
	error?: string;
}

function categoryList(value: string): { categories: ConfigCategory[]; error?: string } {
	if (value === "all") return { categories: [...CONFIG_CATEGORIES] };
	const categories: ConfigCategory[] = [];
	for (const raw of value.split(",").map((part) => part.trim()).filter((part) => part.length > 0)) {
		if (!isConfigCategory(raw)) return { categories, error: `unknown config category "${raw}" (use ${CONFIG_CATEGORIES.join(", ")} or all)` };
		if (!categories.includes(raw)) categories.push(raw);
	}
	return { categories };
}

// `--own <list|all>`, `--share <list|all>`, `--from <env>` and `--empty`, as
// `--flag value` or `--flag=value`.
export function parseScopeFlags(args: readonly string[]): ScopeFlags {
	const result: ScopeFlags = { own: [], share: [], from: undefined, empty: false };
	const fail = (error: string): ScopeFlags => ({ ...result, error });
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--empty") {
			result.empty = true;
			continue;
		}
		const match = /^--(own|share|from)(?:=(.*))?$/.exec(arg);
		if (match === null) return fail(`unknown option ${arg}`);
		const [, flag, inline] = match;
		const value = inline ?? args[i + 1];
		if (inline === undefined) i += 1;
		if (value === undefined || value.length === 0) return fail(`--${flag} needs a value`);
		if (flag === "from") {
			const invalid = validateEnvName(value);
			if (invalid !== undefined) return fail(invalid);
			result.from = value;
			continue;
		}
		const list = categoryList(value);
		if (list.error !== undefined) return fail(list.error);
		result[flag as "own" | "share"] = list.categories;
	}
	if (result.from !== undefined && result.empty) return fail("--from and --empty cannot be combined");
	const both = result.own.find((category) => result.share.includes(category));
	if (both !== undefined) return fail(`"${both}" cannot be both own and shared`);
	return result;
}

export type ScopeSeed = { kind: "copy"; from?: string } | { kind: "empty" };

export interface ScopeChangePlan {
	next: ConfigCategory[];
	// Categories that become own now and need their one-time seed.
	seed: ConfigCategory[];
}

export function planScopeChange(input: { current: readonly ConfigCategory[]; own: readonly ConfigCategory[]; share: readonly ConfigCategory[]; seed: ScopeSeed }): ScopeChangePlan {
	const next = CONFIG_CATEGORIES.filter((category) => !input.share.includes(category) && (input.current.includes(category) || input.own.includes(category)));
	return { next, seed: next.filter((category) => !input.current.includes(category)) };
}

export type SeedOperation = { kind: "copy"; from: string; to: string } | { kind: "remove"; path: string };

// The file operations that seed `categories` in `targetDir`: a copy of each
// file the source has, and a removal of each one it lacks (so the target
// starts from the source's defaults), or only removals when starting empty.
// Never touches a file outside these categories.
export function seedOperations(input: {
	categories: readonly ConfigCategory[];
	mode: "copy" | "empty";
	sourceDirFor: (category: ConfigCategory) => string;
	targetDir: string;
	exists: (path: string) => boolean;
}): SeedOperation[] {
	const operations: SeedOperation[] = [];
	for (const category of input.categories) {
		for (const file of CONFIG_CATEGORY_FILES[category]) {
			const to = join(input.targetDir, file);
			const from = join(input.sourceDirFor(category), file);
			if (input.mode === "copy" && input.exists(from)) operations.push({ kind: "copy", from, to });
			else operations.push({ kind: "remove", path: to });
		}
	}
	return operations;
}

export const CONFIG_CATEGORY_LABELS: Readonly<Record<ConfigCategory, string>> = Object.freeze({
	models: "models & profiles",
	persona: "persona",
	appearance: "appearance",
	behavior: "behavior",
});

export function describeEnvScope(own: readonly ConfigCategory[]): string {
	if (own.length === 0) return "shares everything with the base home";
	if (own.length === CONFIG_CATEGORIES.length) return "fully own (shares nothing)";
	const label = (list: readonly ConfigCategory[]) => list.map((category) => CONFIG_CATEGORY_LABELS[category]).join(", ");
	return `own ${label(CONFIG_CATEGORIES.filter((c) => own.includes(c)))} · shares ${label(CONFIG_CATEGORIES.filter((c) => !own.includes(c)))}`;
}
