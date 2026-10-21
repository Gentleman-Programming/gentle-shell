import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGentlePiAgentHome } from "./agent-home.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ASSETS_DIR = join(PACKAGE_ROOT, "assets");
const MANAGED_ASSETS_MANIFEST = "managed-assets.json";
const MANAGED_ASSETS_LOCK = "managed-assets.lock";
const MANAGED_ASSETS_SCHEMA_VERSION = 1;
const MANAGED_ASSETS_LOCK_TIMEOUT_MS = 5_000;
const MANAGED_ASSETS_LOCK_RETRY_MS = 25;
const LEGACY_MANAGED_ASSET_MANIFESTS = Object.freeze([
	{ path: join(ASSETS_DIR, "migrations", "managed-assets-v0.10.7.json"), version: "0.10.7" },
	{ path: join(ASSETS_DIR, "migrations", "managed-assets-v0.13.json"), version: "0.13.0" },
	{ path: join(ASSETS_DIR, "migrations", "managed-assets-v0.14.json"), version: "0.14.0" },
	{ path: join(ASSETS_DIR, "migrations", "managed-assets-v2.5.0.json"), version: "2.5.0" },
]);

const ASSET_OWNER_BY_KEY = Object.freeze({
	"agents/gentle-ai-explore.md": "delegation",
	"agents/gentle-ai-verify.md": "delegation",
	"agents/gentle-ai-worker.md": "delegation",
	"agents/jd-fix-agent.md": "review",
	"agents/jd-judge-a.md": "review",
	"agents/jd-judge-b.md": "review",
	"agents/review-readability.md": "review",
	"agents/review-reliability.md": "review",
	"agents/review-resilience.md": "review",
	"agents/review-risk.md": "review",
	"agents/review-refuter.md": "review",
	"agents/review-validator.md": "review",
	"chains/4r-review.chain.md": "review",
	"gentle-ai/support/strict-tdd.md": "delegation",
	"gentle-ai/support/strict-tdd-verify.md": "delegation",
} as const);

export type PackageAssetOwner = (typeof ASSET_OWNER_BY_KEY)[keyof typeof ASSET_OWNER_BY_KEY];

export function getPackageAssetOwner(ownershipKey: string): PackageAssetOwner | undefined {
	return Object.hasOwn(ASSET_OWNER_BY_KEY, ownershipKey)
		? ASSET_OWNER_BY_KEY[ownershipKey as keyof typeof ASSET_OWNER_BY_KEY]
		: undefined;
}

function gentlePiAgentHome(): string {
	return resolveGentlePiAgentHome();
}


interface ManagedAssetsManifest {
	schemaVersion: number;
	assets: Record<string, string>;
}

interface LegacyManagedAssetsManifest extends ManagedAssetsManifest {
	packageVersion: string;
}

interface ManagedAssetsLockOwner {
	schemaVersion: 1;
	token: string;
	pid: number;
	createdAtMs: number;
}

/** @internal The hold option exists only to make process-lock regression tests deterministic. */
interface PackageAssetInstallLockOptions {
	timeoutMs?: number;
	retryMs?: number;
	holdLockMs?: number;
}


function emptyManagedAssetsManifest(): ManagedAssetsManifest {
	return {
		schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION,
		assets: {},
	};
}

function readManagedAssetsManifest(path: string): ManagedAssetsManifest {
	if (!existsSync(path)) return emptyManagedAssetsManifest();
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== MANAGED_ASSETS_SCHEMA_VERSION ||
			!isRecord(parsed.assets)
		) {
			return emptyManagedAssetsManifest();
		}
		const assets = Object.fromEntries(
			Object.entries(parsed.assets).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
		return { schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION, assets };
	} catch {
		return emptyManagedAssetsManifest();
	}
}

function managedAssetHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function readManagedAssetsLockOwner(lockPath: string): ManagedAssetsLockOwner | undefined {
	try {
		if (!lstatSync(lockPath).isFile()) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
		if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.token !== "string" || parsed.token.length === 0 || (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) || typeof parsed.createdAtMs !== "number" || !Number.isFinite(parsed.createdAtMs)) return undefined;
		return parsed as unknown as ManagedAssetsLockOwner;
	} catch {
		return undefined;
	}
}

function waitForManagedAssetsLock(milliseconds: number): void {
	if (milliseconds <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function normalizedLockDuration(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}

function acquireManagedAssetsLock(
	agentHome: string,
	options: PackageAssetInstallLockOptions = {},
): { path: string; owner: ManagedAssetsLockOwner } {
	const lockParent = join(agentHome, "gentle-ai");
	const lockPath = join(lockParent, MANAGED_ASSETS_LOCK);
	const timeoutMs = normalizedLockDuration(options.timeoutMs, MANAGED_ASSETS_LOCK_TIMEOUT_MS);
	const retryMs = Math.max(1, normalizedLockDuration(options.retryMs, MANAGED_ASSETS_LOCK_RETRY_MS));
	const deadline = Date.now() + timeoutMs;
	mkdirSync(lockParent, { recursive: true });
	for (;;) {
		const owner: ManagedAssetsLockOwner = {
			schemaVersion: 1,
			token: randomUUID(),
			pid: process.pid,
			createdAtMs: Date.now(),
		};
		try {
			writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
			return { path: lockPath, owner };
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (!lstatSync(lockPath).isFile()) {
					throw new Error(`Managed-assets lock path is unsafe and must be a regular file: ${lockPath}`);
				}
			} catch (inspectionError) {
				if (isRecord(inspectionError) && inspectionError.code === "ENOENT") continue;
				throw inspectionError;
			}
			if (Date.now() >= deadline) {
				throw new Error(`Timed out acquiring managed-assets lock file ${lockPath}. Verify no installer is active before removing this exact lock file.`);
			}
			waitForManagedAssetsLock(retryMs);
		}
	}
}

function releaseManagedAssetsLock(lock: { path: string; owner: ManagedAssetsLockOwner }): void {
	if (readManagedAssetsLockOwner(lock.path)?.token !== lock.owner.token) return;
	try {
		unlinkSync(lock.path);
	} catch {
		// An unreadable or replaced lock remains for an operator to inspect.
	}
}

function withManagedAssetsLock<T>(
	agentHome: string,
	action: () => T,
	options: PackageAssetInstallLockOptions | undefined,
): T {
	const lock = acquireManagedAssetsLock(agentHome, options);
	try {
		waitForManagedAssetsLock(normalizedLockDuration(options?.holdLockMs, 0));
		return action();
	} finally {
		releaseManagedAssetsLock(lock);
	}
}

function readLegacyManagedAssets(
	path: string,
	version: string,
): LegacyManagedAssetsManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== MANAGED_ASSETS_SCHEMA_VERSION ||
			parsed.packageVersion !== version ||
			!isRecord(parsed.assets)
		) {
			return undefined;
		}
		const assets = Object.fromEntries(
			Object.entries(parsed.assets).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
		return {
			schemaVersion: MANAGED_ASSETS_SCHEMA_VERSION,
			packageVersion: version,
			assets,
		};
	} catch {
		return undefined;
	}
}

function readLegacyManagedAssetHashes(): Record<string, readonly string[]> {
	const hashes: Record<string, string[]> = {};
	for (const manifest of LEGACY_MANAGED_ASSET_MANIFESTS) {
		const assets = readLegacyManagedAssets(manifest.path, manifest.version)?.assets;
		if (!assets) continue;
		for (const [ownershipKey, hash] of Object.entries(assets)) {
			const known = hashes[ownershipKey] ?? [];
			if (!known.includes(hash)) known.push(hash);
			hashes[ownershipKey] = known;
		}
	}
	return hashes;
}

function updateAgentFrontmatterRouting(
	content: string,
	routingLines: readonly string[],
): string {
	if (!content.startsWith("---\n")) return content;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return content;
	const frontmatter = content.slice(4, endIndex);
	const body = content.slice(endIndex);
	const lines = frontmatter
		.split("\n")
		.filter((line) => !/^(?:model|thinking):/.test(line));
	if (routingLines.length > 0) {
		const descriptionIndex = lines.findIndex((line) =>
			line.startsWith("description:"),
		);
		const insertIndex =
			descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(1, lines.length);
		lines.splice(insertIndex, 0, ...routingLines);
	}
	return `---\n${lines.join("\n")}${body}`;
}

function legacyComparableAssetContent(
	ownershipKey: string,
	content: string,
): string {
	return ownershipKey.startsWith("agents/")
		? updateAgentFrontmatterRouting(content, [])
		: content;
}

function migrateLegacyAssetContent(
	ownershipKey: string,
	installedContent: string,
	packagedContent: string,
): string {
	if (!ownershipKey.startsWith("agents/")) return packagedContent;
	if (!installedContent.startsWith("---\n")) return packagedContent;
	const endIndex = installedContent.indexOf("\n---", 4);
	if (endIndex === -1) return packagedContent;
	const routingLines = installedContent
		.slice(4, endIndex)
		.split("\n")
		.filter((line) => /^(?:model|thinking):/.test(line));
	return updateAgentFrontmatterRouting(packagedContent, routingLines);
}

function replaceManagedAssetFileAtomically(path: string, content: string): void {
	const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
	let mode: number | undefined;
	try {
		const stat = lstatSync(path);
		if (stat.isFile()) mode = stat.mode & 0o777;
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
	}
	try {
		writeFileSync(temporaryPath, content, {
			encoding: "utf8",
			flag: "wx",
			...(mode === undefined ? {} : { mode }),
		});
		renameSync(temporaryPath, path);
	} finally {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// A renamed or otherwise inaccessible temporary file needs no further action.
		}
	}
}

export function updatePackageManagedSddAgentOwnership(
	installedPath: string,
	previousContent: string,
	nextContent: string,
	lockOptions?: PackageAssetInstallLockOptions,
): boolean {
	const agentHome = gentlePiAgentHome();
	const relativePath = relative(join(agentHome, "agents"), installedPath);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return false;
	}
	const ownershipKey = `agents/${relativePath.split(sep).join("/")}`;
	return withManagedAssetsLock(agentHome, () => {
		const manifestPath = join(agentHome, "gentle-ai", MANAGED_ASSETS_MANIFEST);
		const manifest = readManagedAssetsManifest(manifestPath);
		if (manifest.assets[ownershipKey] !== managedAssetHash(previousContent)) {
			return false;
		}
		const installedContent = readFileSync(installedPath, "utf8");
		// The next-content branch preserves the prior internal caller contract:
		// callers that wrote the file before this function still receive a managed
		// manifest update. New callers take the previous-content branch below so
		// the file and manifest update share this lock.
		if (installedContent !== nextContent && installedContent !== previousContent) {
			return false;
		}
		try {
			if (installedContent === previousContent) {
				replaceManagedAssetFileAtomically(installedPath, nextContent);
			}
			manifest.assets[ownershipKey] = managedAssetHash(nextContent);
			replaceManagedAssetFileAtomically(
				manifestPath,
				JSON.stringify(manifest, null, 2),
			);
		} catch (error) {
			try {
				replaceManagedAssetFileAtomically(installedPath, previousContent);
			} catch (rollbackError) {
				throw new Error(
					`Managed routing update failed and could not restore ${installedPath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					{ cause: error },
				);
			}
			throw error;
		}
		return true;
	}, lockOptions);
}

export function hasPackageAssetOwnerInstallation(owner: PackageAssetOwner): boolean {
	const agentHome = gentlePiAgentHome();
	const manifest = readManagedAssetsManifest(join(agentHome, "gentle-ai", MANAGED_ASSETS_MANIFEST));
	return Object.keys(manifest.assets).some((key) => getPackageAssetOwner(key) === owner) ||
		Object.entries(ASSET_OWNER_BY_KEY).some(([key, candidate]) =>
			candidate === owner && existsSync(join(agentHome, key)),
		);
}

export function isPackageManagedSddAsset(
	installedPath: string,
	ownershipKey: string,
): boolean {
	const manifest = readManagedAssetsManifest(
		join(gentlePiAgentHome(), "gentle-ai", MANAGED_ASSETS_MANIFEST),
	);
	const expectedHash = manifest.assets[ownershipKey];
	if (expectedHash === undefined || !existsSync(installedPath)) return false;
	try {
		return (
			managedAssetHash(readFileSync(installedPath, "utf8")) ===
			expectedHash
		);
	} catch {
		return false;
	}
}


function copyDirectoryFiles(
	sourceDir: string,
	targetDir: string,
	ownershipPrefix: string,
	force: boolean,
	manifest: ManagedAssetsManifest,
	legacyAssetHashes: (() => Readonly<Record<string, readonly string[]>>) | undefined,
	selected?: ReadonlySet<string>,
): { copied: number; skipped: number } {
	if (!existsSync(sourceDir)) return { copied: 0, skipped: 0 };
	if (selected && ![...selected].some(key => key.startsWith(`${ownershipPrefix}/`))) {
		return { copied: 0, skipped: 0 };
	}
	mkdirSync(targetDir, { recursive: true });
	let copied = 0;
	let skipped = 0;
	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		const ownershipKey = `${ownershipPrefix}/${entry.name}`;
		if (entry.isDirectory()) {
			const child = copyDirectoryFiles(
				sourcePath,
				targetPath,
				ownershipKey,
				force,
				manifest,
				legacyAssetHashes,
				selected,
			);
			copied += child.copied;
			skipped += child.skipped;
			continue;
		}
		if (!entry.isFile() || (selected && !selected.has(ownershipKey))) continue;
		const source = readFileSync(sourcePath, "utf8");
		let nextSource = source;
		if (existsSync(targetPath)) {
			if (!force) {
				skipped += 1;
				continue;
			}
			const managedHash = manifest.assets[ownershipKey];
			let installedContent: string | undefined;
			try {
				installedContent = readFileSync(targetPath, "utf8");
			} catch {
				installedContent = undefined;
			}
			const installedHash = installedContent === undefined
				? undefined
				: managedAssetHash(installedContent);
			if (managedHash === undefined) {
				const legacyHashes = legacyAssetHashes?.()[ownershipKey];
				const comparableLegacyHash = installedContent === undefined
					? undefined
					: managedAssetHash(
							legacyComparableAssetContent(ownershipKey, installedContent),
						);
				if (
					legacyHashes === undefined ||
					comparableLegacyHash === undefined ||
					!legacyHashes.includes(comparableLegacyHash)
				) {
					delete manifest.assets[ownershipKey];
					skipped += 1;
					continue;
				}
				nextSource = migrateLegacyAssetContent(
					ownershipKey,
					installedContent,
					source,
				);
			} else if (installedHash !== managedHash) {
				delete manifest.assets[ownershipKey];
				skipped += 1;
				continue;
			} else if (ownershipKey === "agents/sdd-research.md" && installedContent !== undefined) {
				// Keep routing adopted by the legacy migration on subsequent refreshes.
				nextSource = migrateLegacyAssetContent(ownershipKey, installedContent, source);
			}
		}
		writeFileSync(targetPath, nextSource);
		manifest.assets[ownershipKey] = managedAssetHash(nextSource);
		copied += 1;
	}
	return { copied, skipped };
}

// Assets retired by gentle-pi#311 P5: the Pi-owned adversarial review actors.
// The refuter and validator verdicts now execute through Go-owned pi
// processes via provider-rendered self-contained vectors, so these agent
// definitions have no runtime consumer. The migration manifests under
// assets/migrations are append-only legacy-hash HISTORY (adoption evidence
// for force-installs) with no removal semantics, so history stays untouched
// and retirement happens here: an installed copy is deleted only when its
// content hash proves package ownership (current manifest or legacy
// history); user-modified copies are left in place and only lose managed
// ownership.
const RETIRED_MANAGED_ASSETS = Object.freeze([
	// Canonical spec composition now belongs to archive (gentle-pi#1051).
	"agents/sdd-sync.md",
	...[
		"apply", "archive", "design", "explore", "init", "onboard", "proposal",
		"remediate", "research", "spec", "status", "tasks", "verify",
	].map(name => `agents/sdd-${name}.md`),
	"chains/sdd-full.chain.md",
	"chains/sdd-plan.chain.md",
	"chains/sdd-verify.chain.md",
	"gentle-ai/support/sdd-status-contract.md",
	"agents/review-refuter.md",
	"agents/review-validator.md",
]);

function removeRetiredManagedAssets(
	agentHome: string,
	manifest: ManagedAssetsManifest,
	selected?: ReadonlySet<string>,
): void {
	let legacyHashes: Record<string, readonly string[]> | undefined;
	for (const ownershipKey of RETIRED_MANAGED_ASSETS) {
		if (selected && !selected.has(ownershipKey) && !(ownershipKey.includes("sdd-") && selected.has("gentle-ai/support/strict-tdd.md"))) continue;
		const installedPath = join(agentHome, ...ownershipKey.split("/"));
		if (!existsSync(installedPath)) {
			delete manifest.assets[ownershipKey];
			continue;
		}
		let installedContent: string | undefined;
		try {
			installedContent = readFileSync(installedPath, "utf8");
		} catch {
			installedContent = undefined;
		}
		if (installedContent === undefined) continue;
		const installedHash = managedAssetHash(installedContent);
		const managed = manifest.assets[ownershipKey] === installedHash;
		const legacy = (legacyHashes ??= readLegacyManagedAssetHashes())[ownershipKey]?.includes(
			managedAssetHash(legacyComparableAssetContent(ownershipKey, installedContent)),
		) === true;
		if (managed || legacy) {
			try {
				rmSync(installedPath);
			} catch {
				continue;
			}
		}
		// Managed copies are gone; user-modified copies stay but stop being
		// package-managed either way.
		delete manifest.assets[ownershipKey];
	}
}

export function installPackageAssets(
	_cwd: string,
	force: boolean,
	owners?: readonly PackageAssetOwner[],
	lockOptions?: PackageAssetInstallLockOptions,
): { agents: number; chains: number; support: number; skipped: number } {
	const agentHome = gentlePiAgentHome();
	return withManagedAssetsLock(agentHome, () => {
		const selected = owners === undefined ? undefined : new Set(
			Object.entries(ASSET_OWNER_BY_KEY).filter(([, owner]) => owners.includes(owner)).map(([key]) => key),
		);
		const manifestPath = join(agentHome, "gentle-ai", MANAGED_ASSETS_MANIFEST);
		let legacyAssetHashes: (() => Readonly<Record<string, readonly string[]>>) | undefined;
		if (force) {
			let cachedLegacyAssetHashes: Record<string, readonly string[]> | undefined;
			legacyAssetHashes = () =>
				(cachedLegacyAssetHashes ??= readLegacyManagedAssetHashes());
		}
		const manifest = readManagedAssetsManifest(manifestPath);
		removeRetiredManagedAssets(agentHome, manifest, selected);
		const agents = copyDirectoryFiles(
			join(ASSETS_DIR, "agents"),
			join(agentHome, "agents"),
			"agents",
			force,
			manifest,
			legacyAssetHashes,
			selected,
		);
		const chains = copyDirectoryFiles(
			join(ASSETS_DIR, "chains"),
			join(agentHome, "chains"),
			"chains",
			force,
			manifest,
			legacyAssetHashes,
			selected,
		);
		const support = copyDirectoryFiles(
			join(ASSETS_DIR, "support"),
			join(agentHome, "gentle-ai", "support"),
			"gentle-ai/support",
			force,
			manifest,
			legacyAssetHashes,
			selected,
		);
		mkdirSync(dirname(manifestPath), { recursive: true });
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		return {
			agents: agents.copied,
			chains: chains.copied,
			support: support.copied,
			skipped: agents.skipped + chains.skipped + support.skipped,
		};
	}, lockOptions);
}
