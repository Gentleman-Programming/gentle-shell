// Gentle Desktop config access (`get_config`) and the bounded write slice
// (`set_config`).
//
// Desktop names a store, never a path: this module maps each store identifier to
// the existing owner reader and its current precedence, then reports the
// normalized content plus an opaque revision. Writes exist only for the three
// stores whose owners already accept validated, atomic writes — `profiles`,
// `profile_fallbacks`, and `pins` — and they go through those same owner writers,
// so no invariant is re-implemented here. A pin layer is set or cleared through
// the owner's `writeProfilePinSync` / `clearProfilePinSync`, one explicitly named
// layer per request. `models`, `subagents`, and `managed_assets` are derived or
// installer-owned and answer a typed `read_only` error to every write. There is no
// second store, no cached copy, and no filesystem watcher.
//
// The write revision is the digest of the exact single file the owner rewrites,
// which is why `pins` reports one revision per layer instead of the merged read
// revision. `expectedRevision` is re-checked against a fresh read immediately
// before the owner write, in the same synchronous step, so an interleaved Desktop
// request in this process cannot pass the check with a stale token. That is a
// per-process serialization, not a cross-process transaction: there is no lock,
// so a second `pi` process can still write between the check and the rename.

import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { managedAssetsManifestPath, readManagedAssetsManifestResult, type ManagedAssetsManifest } from "./agent-assets.ts";
import { gentlePiConfigHome, resolveGentlePiAgentHome } from "./agent-home.ts";
import {
	isValidProfileName,
	normalizeProfilesFile,
	parseProfilesFileText,
	profilesFilePath,
	readProfilesFileResult,
	serializeProfilesFile,
	writeProfilesFileSync,
	type ProfilesParseDrops,
} from "./agent-profiles.ts";
import { evaluateProfilePin, clearProfilePinSync, readProfilePinStatus, writeProfilePinSync } from "./agent-profile-pin.ts";
import { parseAgentsConfig, readSubagentsFileResult, subagentsConfigPaths } from "./agents-config.ts";
import type { DesktopRpcOutcome, DesktopRpcState } from "./desktop-rpc.ts";
import { fallbacksFilePath, normalizeFallbacksFile, readFallbacksFile, writeFallbacksFile } from "./model-fallback-store.ts";
import { modelConfigPaths, normalizeModelConfig, readModelConfigFile, readSavedModelConfig } from "./model-routing-authority.ts";
import type { WorktreeResolver } from "./session-worktree-registry.ts";

export const DESKTOP_CONFIG_METHODS = ["get_config", "set_config"] as const;
/** Advertised only because this module wires the writer that publishes it. */
export const DESKTOP_CONFIG_EVENTS = ["config_changed"] as const;
export const DESKTOP_CONFIG_EVENT = "config_changed";

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
	/** See `storeReadOnly`: only the persistent family is written by this slice. */
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
	/**
	 * One entry per file this store's owner rewrites, each with its own write
	 * revision. Present only for stores this slice may write.
	 */
	writeTargets?: DesktopConfigWriteTargetInfo[];
}

/**
 * A write target is one file, not one store: `profiles` and `profile_fallbacks`
 * each own a single global file, while `pins` owns two independent layers that a
 * request must select explicitly.
 */
export type DesktopConfigWriteTarget = "global" | "local" | "repo";

export interface DesktopConfigWriteTargetInfo {
	target: DesktopConfigWriteTarget;
	status: DesktopConfigStatus;
	/** Digest of the target's current content, not of a merged multi-layer read. */
	writeRevision: string;
}

const INVALID_PARAMS = { code: "invalid_request", message: "Invalid Desktop config parameters" } as const;
const UNKNOWN_STORE = { code: "unknown_store", message: "Unknown Desktop config store" } as const;
const UNAVAILABLE = { code: "config_unavailable", message: "Config stores unavailable for this session" } as const;
const READ_ONLY = { code: "read_only", message: "Config store is read-only over Desktop RPC" } as const;
const INVALID_DATA = { code: "invalid_data", message: "Invalid config data for this store" } as const;
const UNKNOWN_PIN_PROFILE = { code: "invalid_data", message: "Pin target profile is not defined by the profiles store" } as const;
const MISSING_REVISION = { code: "revision_conflict", message: "expectedRevision is required before writing" } as const;
const STALE_REVISION = { code: "revision_conflict", message: "Config changed since expectedRevision was read" } as const;
const WRITE_FAILED = { code: "write_failed", message: "Config store write failed" } as const;

/** Authoritative stores this slice may write; every other store is read-only. */
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
 * Write-time digest of exactly one target file. It is deliberately a different
 * token from the read `revision` (the payload names the target), because the value
 * a write replaces is one file while a multi-layer read describes a merge: a pin
 * layer's write revision must not be confusable with the merged `pins` revision.
 */
export function configWriteRevision(
	store: DesktopConfigStore,
	target: DesktopConfigWriteTarget,
	status: DesktopConfigStatus,
	value: unknown,
): string {
	const payload = value === undefined ? { store, target, status } : { store, target, status, value };
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
	const writeTargets = writeTargetsFor(store, root);
	return {
		store,
		scope: reader.scope,
		readOnly: storeReadOnly(store),
		status: read.status,
		revision,
		...(value === undefined ? {} : { value }),
		layers: read.layers,
		...(writeTargets === undefined ? {} : { writeTargets }),
	};
}

function layerWriteInfo(
	store: DesktopConfigStore,
	target: DesktopConfigWriteTarget,
	status: DesktopConfigStatus,
	value: unknown,
): DesktopConfigWriteTargetInfo {
	return { target, status, writeRevision: configWriteRevision(store, target, status, value) };
}

/**
 * The files a store's owner rewrites, one entry each, or `undefined` for a store
 * this slice never writes. `pins` returns an empty list outside a resolvable Git
 * worktree: there is no truthful pin target then, so none is reported or written.
 */
function writeTargetsFor(
	store: DesktopConfigStore,
	root: DesktopConfigRoots,
): DesktopConfigWriteTargetInfo[] | undefined {
	switch (store) {
		case "profiles": {
			const read = readProfilesFileResult(profilesFilePath(root.configHome));
			const status: DesktopConfigStatus = read.status === "valid" ? "ok" : read.status;
			return [layerWriteInfo(store, "global", status, read.status === "valid" ? read.file : undefined)];
		}
		case "profile_fallbacks": {
			const read = readFallbacksFile(fallbacksFilePath(root.configHome));
			const status: DesktopConfigStatus = read.status === "valid" ? "ok" : read.status;
			return [layerWriteInfo(store, "global", status, read.status === "valid" ? read.file : undefined)];
		}
		case "pins": {
			const status = readProfilePinStatus(root.cwd, root.resolveWorktree);
			if (!status) return [];
			return (["local", "repo"] as const).map((source) => {
				const layerRead = source === "local" ? status.local : status.repo;
				const layerStatus: DesktopConfigStatus = layerRead.status === "valid" ? "ok" : layerRead.status;
				return layerWriteInfo(
					store,
					source,
					layerStatus,
					layerRead.status === "valid" ? { profile: layerRead.profile } : undefined,
				);
			});
		}
		default:
			return undefined;
	}
}

// ---- Write slice: validated, owner-delegated, revision-guarded ----

/**
 * One write plan: either a typed rejection before anything is touched, or the
 * exact target, its revision as re-read now, whether the content really differs,
 * and the owner writer to call.
 */
type WritePlan =
	| { error: { code: string; message: string } }
	| { target: DesktopConfigWriteTarget; writeRevision: string; changed: boolean; write: () => void };

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `expectedRevision` is mandatory and is compared before the payload is validated,
 * so "you did not prove you saw the current state" never depends on what the data
 * happens to look like. Absent, empty, and non-string tokens are the same answer.
 */
function revisionConflict(
	expected: string,
	current: string,
): typeof STALE_REVISION | undefined {
	return expected === current ? undefined : STALE_REVISION;
}

/**
 * The owner normalizer drops entries it cannot keep (an illegal profile name, an
 * unsafe agent key, a stale `active` marker, an unknown workflow mode). Writing
 * that result would silently delete operator data, so any drop rejects the write
 * instead.
 */
function hasNormalizationDrops(drops: ProfilesParseDrops): boolean {
	return (
		drops.droppedProfiles.length > 0 ||
		drops.droppedAgents.length > 0 ||
		drops.droppedActive !== undefined ||
		(drops.droppedWorkflow?.length ?? 0) > 0
	);
}

function planProfilesWrite(data: unknown, root: DesktopConfigRoots, expected: string): WritePlan {
	const normalized = normalizeProfilesFile(data);
	if (!normalized || hasNormalizationDrops(normalized.drops)) return { error: INVALID_DATA };
	const file = normalized.file;
	// The request must already be in the owner's canonical form: anything the
	// normalizer would rewrite (the `effort` alias, an organic workflow entry) is
	// rejected instead of being applied behind the client's back.
	if (canonicalJson(file) !== canonicalJson(data)) return { error: INVALID_DATA };
	// The owner's serializer must be lossless for this file; data it cannot
	// round-trip is data this channel refuses to write.
	const reparsed = parseProfilesFileText(serializeProfilesFile(file));
	if (reparsed.status !== "valid" || canonicalJson(reparsed.file) !== canonicalJson(file)) {
		return { error: INVALID_DATA };
	}
	const path = profilesFilePath(root.configHome);
	const current = readProfilesFileResult(path);
	const currentStatus: DesktopConfigStatus = current.status === "valid" ? "ok" : current.status;
	const currentValue = current.status === "valid" ? current.file : undefined;
	const writeRevision = configWriteRevision("profiles", "global", currentStatus, currentValue);
	const conflict = revisionConflict(expected, writeRevision);
	if (conflict) return { error: conflict };
	const changed = current.status !== "valid" || canonicalJson(currentValue) !== canonicalJson(file);
	return { target: "global", writeRevision, changed, write: () => writeProfilesFileSync(path, file) };
}

function planFallbacksWrite(data: unknown, root: DesktopConfigRoots, expected: string): WritePlan {
	const normalized = normalizeFallbacksFile(data);
	// The owner normalizer drops an empty chain and an emptied profile block. A
	// Desktop write must be lossless, so the normalized value has to equal the
	// request exactly; anything else would delete content the client sent.
	if (!normalized || canonicalJson(normalized) !== canonicalJson(data)) return { error: INVALID_DATA };
	const path = fallbacksFilePath(root.configHome);
	const current = readFallbacksFile(path);
	const currentStatus: DesktopConfigStatus = current.status === "valid" ? "ok" : current.status;
	const currentValue = current.status === "valid" ? current.file : undefined;
	const writeRevision = configWriteRevision("profile_fallbacks", "global", currentStatus, currentValue);
	const conflict = revisionConflict(expected, writeRevision);
	if (conflict) return { error: conflict };
	const changed = current.status !== "valid" || canonicalJson(currentValue) !== canonicalJson(normalized);
	return { target: "global", writeRevision, changed, write: () => writeFallbacksFile(path, normalized) };
}

function planPinsWrite(data: unknown, root: DesktopConfigRoots, expected: string): WritePlan {
	if (!isRecordValue(data)) return { error: INVALID_DATA };
	if (!Object.keys(data).every((key) => key === "source" || key === "profile")) return { error: INVALID_DATA };
	const source = data.source;
	// The layer is chosen by the request, never by which file happens to exist.
	if (source !== "local" && source !== "repo") return { error: INVALID_DATA };
	// `profile: null` is the explicit clear; every other value must be a pinnable
	// name. There is no "clear everything" and no implicit clear by omission.
	const requested = data.profile;
	let profile: string | undefined;
	if (requested !== null) {
		if (!isValidProfileName(requested)) return { error: INVALID_DATA };
		profile = requested;
		// The invariant the `/gentle:profiles` panel enforces: only a profile the store
		// still defines can be pinned, so this channel never writes a stale pin.
		const store = readProfilesFileResult(profilesFilePath(root.configHome));
		if (store.status !== "valid" || !Object.prototype.hasOwnProperty.call(store.file.profiles, profile)) {
			return { error: UNKNOWN_PIN_PROFILE };
		}
	}
	const status = readProfilePinStatus(root.cwd, root.resolveWorktree);
	if (!status) return { error: UNAVAILABLE };
	const layer = source === "local" ? status.local : status.repo;
	const path = source === "local" ? status.localPath : status.repoPath;
	const layerStatus: DesktopConfigStatus = layer.status === "valid" ? "ok" : layer.status;
	const writeRevision = configWriteRevision(
		"pins",
		source,
		layerStatus,
		layer.status === "valid" ? { profile: layer.profile } : undefined,
	);
	const conflict = revisionConflict(expected, writeRevision);
	if (conflict) return { error: conflict };
	// Clearing a layer that holds no file is already the desired state; a layer that
	// exists but is not a readable pin is still removed by an explicit clear.
	if (profile === undefined) {
		return {
			target: source,
			writeRevision,
			changed: layer.status !== "missing",
			write: () => clearProfilePinSync(path),
		};
	}
	return {
		target: source,
		writeRevision,
		changed: !(layer.status === "valid" && layer.profile === profile),
		write: () => writeProfilePinSync(path, profile),
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
 * `get_config` and the bounded `set_config` writer, over the owner readers and
 * the three owner writers.
 *
 * The host context is bound per Desktop command, exactly like the permission
 * bridge, because the pin and project layers depend on the live session cwd.
 * Reads never write, so a read can never advance a store.
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
		// Only the config methods are this bridge's business; anything else falls
		// through to the next domain (the permission bridge) untouched.
		if (method !== "get_config" && method !== "set_config") return undefined;
		const host = this.host;
		if (!host) return { ok: false, error: UNAVAILABLE };
		return method === "get_config" ? this.read(host, params) : this.write(host, params);
	}

	private read(host: ExtensionContext, params: Record<string, unknown>): DesktopRpcOutcome {
		const parsed = parseStoreParam(params);
		if (typeof parsed !== "string") return { ok: false, error: parsed.error };
		const root = withRoots(host, this.overrides);
		if (!root) return { ok: false, error: UNAVAILABLE };
		const data = readConfigStore(parsed, root);
		return { ok: true, data: data as unknown as Record<string, unknown> };
	}

	/**
	 * `set_config`: validate the store-specific data with the owner, re-check
	 * `expectedRevision` against a fresh read, then let the owner write.
	 *
	 * Everything here is synchronous on purpose. Pi dispatches Desktop prompts
	 * concurrently, and only an `await` can interleave another request, so the check
	 * and the owner's atomic rename cannot be split by another Desktop request in
	 * this process. That is a per-process guarantee only; it is not a cross-process
	 * transaction (see `docs/desktop-rpc.md`).
	 */
	private write(host: ExtensionContext, params: Record<string, unknown>): DesktopRpcOutcome {
		for (const key of Object.keys(params)) {
			if (key !== "store" && key !== "data" && key !== "expectedRevision") {
				return { ok: false, error: INVALID_PARAMS };
			}
		}
		if (typeof params.store !== "string" || params.data === undefined) {
			return { ok: false, error: INVALID_PARAMS };
		}
		if (!isDesktopConfigStore(params.store)) return { ok: false, error: UNKNOWN_STORE };
		// A read-only store is rejected before its data is inspected: the reason a
		// write cannot happen is the store itself, not the payload.
		if (storeReadOnly(params.store)) return { ok: false, error: READ_ONLY };
		// A usable revision is required before the payload is validated: absent, empty,
		// and non-string tokens are all "the client did not prove current state".
		const expected =
			typeof params.expectedRevision === "string" && params.expectedRevision.length > 0
				? params.expectedRevision
				: undefined;
		if (expected === undefined) return { ok: false, error: MISSING_REVISION };
		const root = withRoots(host, this.overrides);
		if (!root) return { ok: false, error: UNAVAILABLE };

		const store = params.store;
		const plan =
			store === "profiles"
				? planProfilesWrite(params.data, root, expected)
				: store === "profile_fallbacks"
					? planFallbacksWrite(params.data, root, expected)
					: planPinsWrite(params.data, root, expected);
		if ("error" in plan) return { ok: false, error: plan.error };

		// Identical content is not a change: the owner writer would skip the rename
		// anyway, and skipping it here keeps a no-op free of a rewrite and an event.
		if (plan.changed) {
			try {
				plan.write();
			} catch {
				// Owner failures carry paths and OS detail; none of it crosses the contract.
				return { ok: false, error: WRITE_FAILED };
			}
		}

		// The response reports what the store now holds, re-read through the owner,
		// not an echo of the request. The resulting write revision also decides
		// whether this request really changed anything.
		const after = readConfigStore(store, root);
		const writeRevision = after.writeTargets?.find((entry) => entry.target === plan.target)?.writeRevision;
		const changed = writeRevision !== plan.writeRevision;
		const data = { ...after, writeTarget: plan.target, writeRevision, changed } as Record<string, unknown>;
		if (!changed) return { ok: true, data };
		return {
			ok: true,
			data,
			event: {
				name: DESKTOP_CONFIG_EVENT,
				data: {
					store: after.store,
					scope: after.scope,
					writeTarget: plan.target,
					revision: after.revision,
					writeRevision,
					source: "desktop",
				},
			},
		};
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
