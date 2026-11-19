// The update facts `get_update_status` reports, read from the sources that
// already own them. Nothing here re-implements a lookup or a comparison:
//
// - Gentle Shell's version is this package's own `package.json`; its install
//   channel comes from `runningBundledPrefix` (a bundled prefix), Pi's own
//   package listing (gentle-pi loaded as the `npm:gentle-pi` Pi package, the
//   way the Gentle AI managed stack declares it), or `readChannel` (the
//   release/main record `gentle-shell upgrade` keeps).
// - Gentle Shell's latest release is `latestRelease` (the lookup `gentle-shell
//   upgrade` and the bundled startup notice use) and the latest main commit is
//   `resolveMainCommit`; the cached answer is the launcher's
//   `startupReleaseCheck` record, parsed by `parseStartupReleaseCache`.
// - Pi's version is Pi's exported `VERSION`; its latest version is
//   `publishedPi`, which only a bundled install can answer without resolving
//   a package-manager owner.
// - Packages come from Pi's exported `DefaultPackageManager`: its
//   `listConfiguredPackages` and the `checkForAvailableUpdates` check behind
//   Pi's own "Package updates are available" notice.

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { boundedVersion, packageDisplayName, type PackageKind, type ShellChannel } from "./desktop-rpc-updates.ts";
import { runningBundledPrefix } from "./gentle-shell-bundled.ts";
import { launcherConfigPath, parseRawLauncherConfig } from "./gentle-shell-launcher.ts";
import { findStartupUpdate, parseStartupReleaseCache, type StartupReleaseCache } from "./gentle-shell-startup-update.ts";

type Env = Record<string, string | undefined>;

/** One configured Pi package, already reduced to wire-safe facts. */
export interface ConfiguredPackageFacts {
	/** Private match key (scope and raw source); never sent. */
	key: string;
	name: string;
	kind: PackageKind;
	scope: "user" | "project";
	current: string | null;
	pinned: boolean | null;
	/** False for a package Pi's check never looks at: local, pinned, or not installed. */
	checkable: boolean;
}

/**
 * The reads `get_update_status` needs. Only `latestShell`, `latestPi`, and
 * `checkPackages` reach the network; every other read is local.
 */
export interface UpdateSources {
	offline: boolean;
	now(): number;
	shellVersion(): string | undefined;
	shellChannel(): Promise<ShellChannel>;
	/** The launcher's recorded latest-release lookup, if any. */
	shellReleaseCache(): StartupReleaseCache | undefined;
	/** The latest release version, or for `main` the full latest commit sha. */
	latestShell(channel: ShellChannel, signal: AbortSignal): Promise<string>;
	piVersion(): string | undefined;
	/** Undefined when no existing source can name the latest Pi for this install. */
	latestPi: ((signal: AbortSignal) => Promise<string>) | undefined;
	/** Undefined when Pi's package listing cannot be read. */
	packages(): ConfiguredPackageFacts[] | undefined;
	/** The match keys of the packages Pi's own check reports as updatable. */
	checkPackages(): Promise<Set<string>>;
}

/** Same rule as the launcher's startup check and Pi's interactive check: any value means offline. */
export function isOffline(env: Env): boolean {
	return Boolean(env.PI_OFFLINE);
}

export const packageKey = (scope: string, source: string): string => `${scope}\0${source}`;

/**
 * Whether `latest` is a newer stable release than `current`, through the
 * launcher's own stable-version comparison (the one behind the bundled
 * startup notice), fed a fresh in-memory record so it never looks anything up.
 */
export async function isNewerRelease(current: string, latest: string, nowMs: number): Promise<boolean> {
	const offer = await findStartupUpdate({ current, cache: { checkedAt: nowMs, latest }, nowMs, lookup: async () => undefined });
	return offer !== undefined;
}

/** A main-channel install is current when its version carries the latest commit, as `gentle-shell upgrade --channel main` checks. */
export function isCurrentMain(current: string, commit: string): boolean {
	return current.endsWith(`-main.${commit.slice(0, 12)}`);
}

const ownPackageRoot = (): string => dirname(dirname(fileURLToPath(import.meta.url)));

function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

interface ParsedSource { type?: unknown; name?: unknown; host?: unknown; path?: unknown; pinned?: unknown }

/**
 * Pi's own source parser. It is not part of Pi's typed surface, so the call
 * is guarded: an absent or changed parser reports the package as `unknown`
 * instead of guessing from the raw source text.
 */
function parsePiSource(manager: unknown, source: string): ParsedSource | undefined {
	const parse = (manager as { parseSource?: unknown }).parseSource;
	if (typeof parse !== "function") return undefined;
	try {
		const parsed = parse.call(manager, source);
		return parsed && typeof parsed === "object" ? (parsed as ParsedSource) : undefined;
	} catch {
		return undefined;
	}
}

function installedVersion(installedPath: string | undefined): string | null {
	if (!installedPath) return null;
	try {
		return boundedVersion(JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8").replace(/^﻿/, ""))?.version);
	} catch {
		return null;
	}
}

interface ListedPackage { source: string; scope: "user" | "project"; installedPath?: string }

function packageFacts(manager: unknown, entry: ListedPackage): ConfiguredPackageFacts {
	const parsed = parsePiSource(manager, entry.source);
	const type = parsed?.type;
	const kind: PackageKind = type === "npm" || type === "git" || type === "local" ? type : "unknown";
	const rawName = kind === "npm" ? parsed?.name : kind === "git" ? `${String(parsed?.host ?? "")}/${String(parsed?.path ?? "")}` : kind === "local" ? parsed?.path : undefined;
	const pinned = kind === "local" || typeof parsed?.pinned !== "boolean" ? null : parsed.pinned;
	const installed = typeof entry.installedPath === "string" && entry.installedPath.length > 0;
	return {
		key: packageKey(entry.scope, entry.source),
		name: packageDisplayName(kind, typeof rawName === "string" ? rawName : undefined),
		kind,
		scope: entry.scope,
		current: kind === "npm" ? installedVersion(entry.installedPath) : null,
		pinned,
		checkable: (kind === "npm" || kind === "git") && pinned === false && installed,
	};
}

export interface DefaultUpdateSourcesInput {
	cwd: string;
	env?: Env;
	home: string;
	packageRoot?: string;
	platform?: string;
	fetch?: typeof globalThis.fetch;
}

/** The production sources for one request, bound to this session's working directory. */
export function defaultUpdateSources(input: DefaultUpdateSourcesInput): UpdateSources {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	const packageRoot = input.packageRoot ?? ownPackageRoot();
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const signalled = (signal: AbortSignal) => (url: string, init: RequestInit = {}) => fetchImpl(url, { ...init, signal });
	let manager: DefaultPackageManager | undefined;
	const packageManager = (): DefaultPackageManager => {
		if (!manager) {
			const agentDir = getAgentDir();
			manager = new DefaultPackageManager({ cwd: input.cwd, agentDir, settingsManager: SettingsManager.create(input.cwd, agentDir) });
		}
		return manager;
	};
	const listed = (): ListedPackage[] => packageManager().listConfiguredPackages()
		.filter((entry) => typeof entry?.source === "string" && (entry.scope === "user" || entry.scope === "project"));
	const bundledPrefix = (): string | undefined => runningBundledPrefix(env);

	return {
		offline: isOffline(env),
		now: () => Date.now(),
		shellVersion() {
			try {
				return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
			} catch {
				return undefined;
			}
		},
		async shellChannel() {
			if (bundledPrefix() !== undefined) return "bundled";
			try {
				const own = safeRealpath(packageRoot) ?? packageRoot;
				const managed = listed().some((entry) => {
					const parsed = parsePiSource(packageManager(), entry.source);
					return parsed?.type === "npm" && parsed.name === "gentle-pi" && typeof entry.installedPath === "string" && safeRealpath(entry.installedPath) === own;
				});
				if (managed) return "gentle-ai-managed";
			} catch {
				/* An unreadable package listing says nothing about the channel. */
			}
			try {
				const { readChannel } = await import("../scripts/main-channel.mjs");
				const state = await readChannel({ env, home: input.home }, { readFile });
				return state?.channel === "main" ? "main" : state?.channel === "release" ? "release" : "unknown";
			} catch {
				return "unknown";
			}
		},
		shellReleaseCache() {
			try {
				const override = env.GENTLE_SHELL_CONFIG;
				const path = override !== undefined && override.length > 0 ? override : launcherConfigPath(input.home);
				return parseStartupReleaseCache(parseRawLauncherConfig(readFileSync(path, "utf8")).startupReleaseCheck);
			} catch {
				return undefined;
			}
		},
		async latestShell(channel, signal) {
			const { latestRelease, resolveMainCommit, SHELL_REPOSITORY } = await import("../scripts/main-channel.mjs");
			if (channel === "main") return resolveMainCommit(SHELL_REPOSITORY, { fetch: signalled(signal) });
			if (channel === "unknown") throw new Error("unknown channel");
			return latestRelease(signalled(signal));
		},
		piVersion: () => VERSION,
		latestPi: bundledPrefix() === undefined ? undefined : async () => {
			const { prefixLayout, publishedPi } = await import("../scripts/bundled-install.mjs");
			const layout = prefixLayout({ platform, env, home: input.home, root: bundledPrefix()! });
			return publishedPi(layout, { platform, env });
		},
		packages() {
			try {
				const pm = packageManager();
				return listed().map((entry) => packageFacts(pm, entry));
			} catch {
				return undefined;
			}
		},
		async checkPackages() {
			const updates = await packageManager().checkForAvailableUpdates();
			return new Set(updates.map((update) => packageKey(update.scope, update.source)));
		},
	};
}
