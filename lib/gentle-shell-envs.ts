import { basename, dirname, join, resolve as resolvePath } from "node:path";

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
}

export interface EnvSummary {
	name: string;
	dir: string;
	isDefault: boolean;
	packages: string[];
	// Provider ids only: credential values never leave auth.json.
	providers: string[];
	provisioned: string;
	sessionCount: number;
	lastSessionAt?: string;
	base?: boolean;
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
		sessionCount: input.sessionCount,
		lastSessionAt: input.lastSessionAt,
		...(input.base ? { base: true } : {}),
	};
}
