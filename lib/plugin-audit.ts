import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import type { Contribution, ContributionIssue, ContributionReport } from "./plugin-contract.ts";

// The audit surface behind /gentle:plugins: what the contribution box loaded,
// what the contract refused, which ids were replaced, which owners the order
// file placed first, and whether another extension swapped a `ctx.ui` setter.
// Plain data and plain text on purpose (no Pi UI, no theme), so the command
// and the tests read the same model.

/** The only `plugins.json` shape this reader accepts. Anything else is ignored, never guessed. */
export const PLUGINS_SCHEMA = "gentle-pi.plugins/v1";
const PLUGINS_FILE = "plugins.json";

export interface PluginOrderOptions {
	/** Defaults to the gentle-pi config home; only a test passes it. */
	gentlePiConfigHome?: string;
}

export interface PluginOrderResolution {
	/** Owners to place first, in this order. Empty means "no explicit order". */
	order: string[];
	/** `default` is a missing file: insertion order, exactly today's behavior. */
	source: "global_file" | "default";
	/** A file exists but is unreadable, not JSON or wrongly schemated. */
	malformed: boolean;
	globalFile: string;
}

/**
 * The explicit owner order, `undefined` when the text is not a valid file.
 * Mirrors `parseCardStyleFile`: two keys exactly, this schema, and no coercion.
 */
export function parsePluginOrderFile(raw: string): string[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (Object.keys(record).length !== 2 || record.schema !== PLUGINS_SCHEMA) return undefined;
		const order = record.order;
		if (!Array.isArray(order) || !order.every((owner) => typeof owner === "string" && owner.length > 0)) return undefined;
		return [...order];
	} catch {
		return undefined;
	}
}

/**
 * A missing `plugins.json` means no explicit order. A malformed, wrongly
 * schemated or unreadable one also means no explicit order — the same
 * "malformed reads as default" contract as `lib/card-style-policy.ts` — so a
 * hand edit can break arbitration but never `/gentle:plugins`, and this reader
 * never throws and never rewrites the file.
 */
export function readPluginOrder(options: PluginOrderOptions = {}): PluginOrderResolution {
	const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), PLUGINS_FILE);
	try {
		const order = parsePluginOrderFile(readFileSync(globalFile, "utf8"));
		return order === undefined
			? { order: [], source: "global_file", malformed: true, globalFile }
			: { order, source: "global_file", malformed: false, globalFile };
	} catch (error) {
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { order: [], source: missing ? "default" : "global_file", malformed: !missing, globalFile };
	}
}

/** The three payloads a contribution can carry, in the order the audit prints them. */
export const CONTRIBUTION_SLOTS = ["rows", "sidebar", "palette"] as const;
export type ContributionSlotName = (typeof CONTRIBUTION_SLOTS)[number];

/** One loaded contribution: its identity and the slots it fills. */
export interface PluginAuditEntry {
	id: string;
	owner: string;
	contract: number;
	slots: ContributionSlotName[];
}

/** Where an owner's position came from: the order file, or the box's insertion order. */
export type PluginOwnerSource = "plugins.json" | "insertion";

export interface PluginAuditOwner {
	owner: string;
	source: PluginOwnerSource;
}

/** The audit model the formatter and the overlay render. */
export interface PluginAudit {
	loaded: PluginAuditEntry[];
	skipped: ContributionIssue[];
	replacedIds: string[];
	owners: PluginAuditOwner[];
	replacedSetters: string[];
	order: PluginOrderResolution;
}

export interface PluginAuditInput {
	/** In their effective order: `readContributions({ order })` already applies the file order. */
	contributions: readonly Contribution[];
	/** The report of that read: what the contract refused and which ids a later set replaced. */
	report: ContributionReport;
	order: PluginOrderResolution;
	/** `ctx.ui` setters whose identity changed since the extension first saw the context. */
	replacedSetters?: readonly string[];
}

function slotsOf(contribution: Contribution): ContributionSlotName[] {
	return CONTRIBUTION_SLOTS.filter((slot) => contribution[slot] !== undefined);
}

/**
 * Group the already-ordered contributions into the audit model. It never
 * re-orders: `readContributions` owns that, so the file order is applied in
 * exactly one place. An owner counts as "plugins.json" when the order file
 * named it, whatever position the read gave it.
 */
export function buildPluginAudit(input: PluginAuditInput): PluginAudit {
	const loaded = input.contributions.map((contribution) => ({
		id: contribution.id,
		owner: contribution.owner,
		contract: contribution.contract,
		slots: slotsOf(contribution),
	}));
	const owners: PluginAuditOwner[] = [];
	const seen = new Set<string>();
	for (const entry of loaded) {
		if (seen.has(entry.owner)) continue;
		seen.add(entry.owner);
		owners.push({ owner: entry.owner, source: input.order.order.includes(entry.owner) ? "plugins.json" : "insertion" });
	}
	return {
		loaded,
		skipped: input.report.skipped.map((issue) => ({ ...issue })),
		replacedIds: [...input.report.replaced],
		owners,
		replacedSetters: [...(input.replacedSetters ?? [])],
		order: { ...input.order, order: [...input.order.order] },
	};
}

export interface PluginAuditFormatOptions {
	/** Rows per list before the omission line. */
	limit?: number;
}

/** How many entries each list prints before it reports the rest as omitted. */
export const PLUGIN_AUDIT_LIMIT = 10;

function counted(count: number, noun: string): string {
	return `${count} ${noun}`;
}

function capped<T>(items: readonly T[], limit: number, line: (item: T) => string, noun: string): string[] {
	const shown = items.slice(0, limit).map(line);
	if (items.length > limit) shown.push(`  … and ${items.length - limit} more ${noun}`);
	return shown;
}

/**
 * The audit as plain text lines, bounded so a box with hundreds of entries
 * still fits a terminal: every capped list ends with how many it omitted.
 * No colors and no theme, so the same lines serve the overlay and `notify`.
 */
export function formatPluginAudit(audit: PluginAudit, options: PluginAuditFormatOptions = {}): string[] {
	const limit = Math.max(1, Math.floor(options.limit ?? PLUGIN_AUDIT_LIMIT));
	const summary = [`Gentle plugins: ${counted(audit.loaded.length, "loaded")}, ${counted(audit.skipped.length, "skipped")}`];
	if (audit.replacedIds.length > 0) summary.push(`${counted(audit.replacedIds.length, "replaced")}`);
	const lines: string[] = [summary.join(", ")];
	if (audit.order.malformed) {
		lines.push(`order file: ${audit.order.globalFile} (malformed or unreadable; insertion order is used and the file is left untouched)`);
	}
	if (audit.owners.length > 0) {
		lines.push(`order: ${audit.owners.map((owner) => `${owner.owner} (${owner.source})`).join(", ")}`);
	}
	if (audit.loaded.length === 0) {
		lines.push(audit.skipped.length > 0 ? "No contribution passed the contract." : "No community contributions are registered.");
	} else {
		lines.push(`loaded (${audit.loaded.length}):`);
		lines.push(
			...capped(
				audit.loaded,
				limit,
				(entry) => `  ${entry.id} · contract ${entry.contract} · ${entry.slots.length > 0 ? entry.slots.join(", ") : "no payload"}`,
				"loaded",
			),
		);
	}
	if (audit.skipped.length > 0) {
		lines.push(`skipped (${audit.skipped.length}):`);
		lines.push(...capped(audit.skipped, limit, (issue) => `  ${issue.id} · ${issue.code} · ${issue.detail}`, "skipped"));
	}
	if (audit.replacedIds.length > 0) {
		const ids = audit.replacedIds.slice(0, limit).join(", ");
		const omitted = audit.replacedIds.length - limit;
		lines.push(omitted > 0 ? `replaced ids: ${ids} … and ${omitted} more` : `replaced ids: ${ids}`);
	}
	if (audit.replacedSetters.length > 0) {
		lines.push("ctx.ui replacements (best-effort):");
		lines.push(
			...capped(audit.replacedSetters, limit, (setter) => `  ctx.ui.${setter}: replaced by another extension`, "setters"),
		);
	}
	return lines;
}

/** The `ctx.ui` setters a plugin could coopt; only identity changes are detectable. */
export const UI_SETTERS = ["setHeader", "setWidget", "setFooter", "setEditorComponent", "setStatus"] as const;
export type UiSetterName = (typeof UI_SETTERS)[number];
export type UiSetterSnapshot = Record<UiSetterName, unknown>;

/**
 * Best-effort only: this records the current identity of each `ctx.ui` setter.
 * A replacement another extension installed *before* gentle-plugins first saw
 * the context is already in place when the snapshot is taken, so it can never
 * be detected — the finding is a hint, never a guarantee.
 */
export function captureUiSetters(ui: Record<string, unknown>): UiSetterSnapshot {
	const snapshot = {} as UiSetterSnapshot;
	for (const name of UI_SETTERS) snapshot[name] = ui[name];
	return snapshot;
}

/** The setters whose identity changed since `snapshot`, in a stable order. */
export function replacedUiSetters(snapshot: UiSetterSnapshot, ui: Record<string, unknown>): UiSetterName[] {
	return UI_SETTERS.filter((name) => ui[name] !== snapshot[name]);
}
