// Read-side Gentle Desktop config access (`get_config`).
//
// Desktop names a store, never a path: this module maps each store identifier to
// the existing owner reader and its current precedence, then reports the
// normalized content plus an opaque revision. It never writes, never repairs a
// malformed file, never watches the filesystem, and never adds a second store.
// Writes (`set_config`, `expectedRevision`, `config_changed`) belong to a later
// slice; until then every store is read-only over this channel and the three
// authoritative stores are marked mutable only for the Desktop client's
// planning, while `models`, `subagents`, and `managed_assets` are derived or
// installer-owned and stay read-only permanently.

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { managedAssetsManifestPath, readManagedAssetsManifestResult, type ManagedAssetsManifest } from "./agent-assets.ts";
import { gentlePiConfigHome, resolveGentlePiAgentHome } from "./agent-home.ts";
import { profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { evaluateProfilePin, readProfilePinStatus } from "./agent-profile-pin.ts";
import { parseAgentsConfig, readSubagentsFileResult, subagentsConfigPaths } from "./agents-config.ts";
import type { DesktopRpcOutcome, DesktopRpcState } from "./desktop-rpc.ts";
import { fallbacksFilePath, readFallbacksFile } from "./model-fallback-store.ts";
import { modelConfigPaths, normalizeModelConfig, readModelConfigFile, readSavedModelConfig } from "./model-routing-authority.ts";
import type { WorktreeResolver } from "./session-worktree-registry.ts";

export const DESKTOP_CONFIG_METHODS = ["get_config"] as const;

/** Every store this channel can read, in the order `get_snapshot` projects them. */
export const DESKTOP_CONFIG_STORES = [
	"profiles",
	"models",
	"profile_fallbacks",
	"subagents",
	"pins",
	"managed_assets",
] as const;

export type DesktopConfigStore = (typeof DESKTOP_CONFIG_STORES)[number];

/** A layer status is the owner reader's own answer, never an inferred one. */
export type DesktopConfigStatus = "ok" | "missing" | "invalid";
export type DesktopConfigLayerSource = "global" | "project" | "local" | "repo";
export type DesktopConfigScope = "global" | "global+project" | "local+repo";

export interface DesktopConfigLayer {
	source: DesktopConfigLayerSource;
	status: DesktopConfigStatus;
}

export interface DesktopConfigData {
	store: DesktopConfigStore;
	scope: DesktopConfigScope;
	/** See `storeReadOnly`: only the persistent family is written by a later slice. */
	readOnly: boolean;
	status: DesktopConfigStatus;
	/** Opaque digest of the canonical normalized content; stable across equivalent reads. */
	revision: string;
	/**
	 * Normalized owner content. Absent when the owner produced none: a missing store
	 * or one whose layers are all unreadable. `pins` is the deliberate exception —
	 * it always reports what its layers amount to, because a broken or stale pin is
	 * exactly the state an operator needs to see.
	 */
	value?: unknown;
	layers: DesktopConfigLayer[];
}

const INVALID_PARAMS = { code: "invalid_request", message: "Invalid Desktop config parameters" } as const;
const UNKNOWN_STORE = { code: "unknown_store", message: "Unknown Desktop config store" } as const;
const UNAVAILABLE = { code: "config_unavailable", message: "Config stores unavailable for this session" } as const;

/** Authoritative stores a later slice may write; read-only for this contract. */
const AUTHORITATIVE_STORES: ReadonlySet<DesktopConfigStore> = new Set(["profiles", "profile_fallbacks", "pins"]);

export function storeReadOnly(store: DesktopConfigStore): boolean {
	return !AUTHORITATIVE_STORES.has(store);
}

export function isDesktopConfigStore(value: unknown): value is DesktopConfigStore {
	return typeof value === "string" && (DESKTOP_CONFIG_STORES as readonly string[]).includes(value);
}

/** Paths are resolved by the owner helpers so a store spelling cannot move. */
export interface DesktopConfigRoots {
	cwd: string;
	configHome: string;
	agentHome: string;
	resolveWorktree?: WorktreeResolver;
}

export interface DesktopConfigOverrides {
	configHome?: string;
	agentHome?: string;
	resolveWorktree?: WorktreeResolver;
}

/**
 * The project and pin layers depend on the live session cwd, so a host without
 * one has no truthful roots to report: the bridge answers unavailable instead of
 * inventing a directory or exposing the process cwd.
 */
function withRoots(context: ExtensionContext, overrides: DesktopConfigOverrides): DesktopConfigRoots | undefined {
	if (typeof context.cwd !== "string" || context.cwd.length === 0) return undefined;
	return {
		cwd: context.cwd,
		configHome: overrides.configHome ?? gentlePiConfigHome(),
		agentHome: overrides.agentHome ?? resolveGentlePiAgentHome(),
		...(overrides.resolveWorktree === undefined ? {} : { resolveWorktree: overrides.resolveWorktree }),
	};
}

/**
 * Canonical JSON: sorted keys, `undefined` members dropped exactly like
 * `JSON.stringify` would drop them on the wire, so the digest describes the
 * content the client actually receives and formatting never moves it.
 */
function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
	return `{${entries.join(",")}}`;
}

/** Read-time content digest. It orders nothing across processes and is not a transaction token. */
export function configRevision(store: DesktopConfigStore, status: DesktopConfigStatus, value: unknown): string {
	const payload = value === undefined ? { store, status } : { store, status, value };
	return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex").slice(0, 32)}`;
}

/**
 * The projection is the JSON a client receives, so absent owner fields are
 * dropped here instead of surviving as `undefined` members that no consumer of
 * the wire format can ever see.
 */
function wireValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((entry) => wireValue(entry)) as unknown as T;
	if (value === null || typeof value !== "object") return value;
	const projected: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === undefined) continue;
		projected[key] = wireValue(entry);
	}
	return projected as T;
}

interface StoreRead {
	status: DesktopConfigStatus;
	value?: unknown;
	layers: DesktopConfigLayer[];
}

function layer(source: DesktopConfigLayerSource, status: "missing" | "invalid" | "valid"): DesktopConfigLayer {
	return { source, status: status === "valid" ? "ok" : status };
}

type LayerReadStatus = "missing" | "invalid" | "valid";

/**
 * Store status for a store the owner assembles from layers it reads independently.
 * `missing` only when every layer is absent, `invalid` only when no layer produced
 * content, and `ok` as soon as one layer is usable — the same merge the runtime
 * performs, with the broken layers still named in `layers`.
 */
function layeredStatus(...statuses: LayerReadStatus[]): DesktopConfigStatus {
	if (statuses.every((status) => status === "missing")) return "missing";
	return statuses.some((status) => status === "valid") ? "ok" : "invalid";
}

function readProfiles(root: DesktopConfigRoots): StoreRead {
	const read = readProfilesFileResult(profilesFilePath(root.configHome));
	const status: DesktopConfigStatus = read.status === "valid" ? "ok" : read.status;
	return {
		status,
		...(read.status === "valid" ? { value: read.file } : {}),
		layers: [layer("global", read.status)],
	};
}

function readModels(root: DesktopConfigRoots): StoreRead {
	const paths = modelConfigPaths(root.configHome, root.cwd);
	// The owner merge stays authoritative: it decides precedence and rejects a
	// broken layer, and `normalizeModelConfig` keeps the same safe-key policy the
	// rest of the routing uses. The per-layer reads exist only to report which
	// layer is missing or malformed.
	const global = readModelConfigFile(paths.global);
	const project = readModelConfigFile(paths.project);
	const merged = readSavedModelConfig(paths.global, paths.project);
	const status: DesktopConfigStatus = merged.status === "valid" ? "ok" : merged.status;
	return {
		status,
		...(merged.status === "valid" ? { value: normalizeModelConfig(merged.config) ?? {} } : {}),
		layers: [layer("global", global.status), layer("project", project.status)],
	};
}

function readProfileFallbacks(root: DesktopConfigRoots): StoreRead {
	const read = readFallbacksFile(fallbacksFilePath(root.configHome));
	const status: DesktopConfigStatus = read.status === "valid" ? "ok" : read.status;
	return {
		status,
		...(read.status === "valid" ? { value: read.file } : {}),
		layers: [layer("global", read.status)],
	};
}

function readSubagents(root: DesktopConfigRoots): StoreRead {
	const paths = subagentsConfigPaths({ cwd: root.cwd, home: root.agentHome, agentHome: root.agentHome });
	const global = readSubagentsFileResult(paths.global);
	const project = readSubagentsFileResult(paths.project);
	const layers = [layer("global", global.status), layer("project", project.status)];
	const status = layeredStatus(global.status, project.status);
	if (status !== "ok") return { status, layers };
	// The same parser the runtime uses, so the projection cannot drift from the
	// routing a launch would read. Like the owner, a layer that cannot be parsed is
	// skipped and the remaining layer still merges; `layers` reports which one it was.
	const value = parseAgentsConfig(
		global.status === "valid" ? global.value : undefined,
		project.status === "valid" ? project.value : undefined,
	);
	return { status, value, layers };
}

function readPins(root: DesktopConfigRoots): StoreRead {
	const status = readProfilePinStatus(root.cwd, root.resolveWorktree);
	if (!status) {
		// Outside a resolvable worktree there are no pin layers to report: say so
		// instead of pretending the repository declares nothing.
		return {
			status: "invalid",
			value: { resolved: false, invalid: [], stale: [], reason: "worktree_unresolved" },
			layers: [],
		};
	}
	const store = readProfilesFileResult(profilesFilePath(root.configHome));
	const evaluation = evaluateProfilePin(status, store.status === "valid" ? store.file.profiles : {});
	const bothMissing = status.local.status === "missing" && status.repo.status === "missing";
	const storeStatus: DesktopConfigStatus = bothMissing ? "missing" : evaluation.winner ? "ok" : "invalid";
	// The owner reports layer paths for the panel; Desktop only needs which layer
	// and what it held, so the paths are dropped here. The layers are already read,
	// so even an all-missing or unresolvable pin set is reported instead of hidden.
	return {
		status: storeStatus,
		value: {
			resolved: evaluation.winner !== undefined,
			...(evaluation.winner === undefined
				? {}
				: { winner: { source: evaluation.winner.source, profile: evaluation.winner.profile } }),
			invalid: evaluation.invalid.map((issue) => ({ source: issue.source })),
			stale: evaluation.stale.map((issue) => ({ source: issue.source, profile: issue.profile })),
		},
		layers: [layer("local", status.local.status), layer("repo", status.repo.status)],
	};
}

const OWNERSHIP_KEY_MAX_LENGTH = 256;
const OWNERSHIP_HASH_PATTERN = /^[a-fA-F0-9]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function ownershipAssetKey(key: string): boolean {
	if (key.length === 0 || key.length > OWNERSHIP_KEY_MAX_LENGTH) return false;
	if (CONTROL_CHARACTERS.test(key) || key.includes("\\")) return false;
	// An ownership key is a relative POSIX-style asset path below the agent home.
	if (key.startsWith("/") || /^[A-Za-z]:/.test(key)) return false;
	return key.includes("/") && key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * The manifest is installer state, but it reaches a protocol, so it is filtered:
 * only ownership-shaped entries are projected and an absolute path, a traversal
 * segment, or an arbitrary string can never be echoed to a Desktop client. The
 * installer's own current and legacy manifests hold sha256 digests over relative
 * keys, so they pass unchanged.
 */
function projectManagedAssets(manifest: ManagedAssetsManifest): ManagedAssetsManifest {
	return {
		schemaVersion: manifest.schemaVersion,
		assets: Object.fromEntries(
			Object.entries(manifest.assets).filter(
				([key, hash]) => ownershipAssetKey(key) && OWNERSHIP_HASH_PATTERN.test(hash),
			),
		),
	};
}

function readManagedAssets(root: DesktopConfigRoots): StoreRead {
	const read = readManagedAssetsManifestResult(managedAssetsManifestPath(root.agentHome));
	const status: DesktopConfigStatus = read.status === "valid" ? "ok" : read.status;
	return {
		status,
		...(read.status === "valid" ? { value: projectManagedAssets(read.manifest) } : {}),
		layers: [layer("global", read.status)],
	};
}

const STORE_READERS: Record<DesktopConfigStore, { scope: DesktopConfigScope; read: (root: DesktopConfigRoots) => StoreRead }> = {
	profiles: { scope: "global", read: readProfiles },
	models: { scope: "global+project", read: readModels },
	profile_fallbacks: { scope: "global", read: readProfileFallbacks },
	subagents: { scope: "global+project", read: readSubagents },
	pins: { scope: "local+repo", read: readPins },
	managed_assets: { scope: "global", read: readManagedAssets },
};

export function readConfigStore(store: DesktopConfigStore, root: DesktopConfigRoots): DesktopConfigData {
	const reader = STORE_READERS[store];
	const read = reader.read(root);
	const value = read.value === undefined ? undefined : wireValue(read.value);
	const revision = configRevision(store, read.status, value);
	return {
		store,
		scope: reader.scope,
		readOnly: storeReadOnly(store),
		status: read.status,
		revision,
		...(value === undefined ? {} : { value }),
		layers: read.layers,
	};
}

/** Params are exactly `{store}`: no path, no scope selector, no store options. */
function parseStoreParam(params: Record<string, unknown>): DesktopConfigStore | { error: typeof INVALID_PARAMS | typeof UNKNOWN_STORE } {
	const keys = Object.keys(params);
	if (keys.length !== 1 || keys[0] !== "store" || typeof params.store !== "string") {
		return { error: INVALID_PARAMS };
	}
	if (!isDesktopConfigStore(params.store)) return { error: UNKNOWN_STORE };
	return params.store;
}

/**
 * `get_config` plus the bounded `get_snapshot` projection, over the owner readers.
 *
 * The host context is bound per Desktop command, exactly like the permission
 * bridge, because the pin and project layers depend on the live session cwd.
 * Configuration reads never write, so a read can never advance a store.
 */
export class DesktopConfigBridge {
	private host: ExtensionContext | undefined;
	private readonly overrides: DesktopConfigOverrides;

	constructor(overrides: DesktopConfigOverrides = {}) {
		this.overrides = overrides;
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	reset(): void {
		this.host = undefined;
	}

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | undefined {
		if (method !== "get_config") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: UNAVAILABLE };
		const parsed = parseStoreParam(params);
		if (typeof parsed !== "string") return { ok: false, error: parsed.error };
		const root = withRoots(host, this.overrides);
		if (!root) return { ok: false, error: UNAVAILABLE };
		const data = readConfigStore(parsed, root);
		return { ok: true, data: data as unknown as Record<string, unknown> };
	}

	/** Bounded status/revision/readOnly projection; store content never enters a snapshot. */
	snapshotState(): DesktopRpcState {
		const host = this.host;
		if (!host) return {};
		const root = withRoots(host, this.overrides);
		// Without a session cwd the project and pin layers cannot be read truthfully,
		// so the snapshot stays empty rather than reporting a guess.
		if (!root) return {};
		return {
			config: {
				stores: DESKTOP_CONFIG_STORES.map((store) => {
					const reader = STORE_READERS[store];
					const read = reader.read(root);
					return {
						store,
						scope: reader.scope,
						readOnly: storeReadOnly(store),
						status: read.status,
						revision: configRevision(store, read.status, read.value),
					};
				}),
			},
		};
	}
}
