import type { Contribution, ContributionIssue, ContributionReport } from "./plugin-contract.ts";

// The declared order has one reader, in `lib/plugin-order.ts`, because every
// read point applies it too. It is re-exported here so `/gentle:plugins` and
// its test keep one import for the audit surface.
export { PLUGINS_SCHEMA, parsePluginOrderFile, readPluginOrder } from "./plugin-order.ts";
export type { PluginOrderOptions, PluginOrderReason, PluginOrderResolution } from "./plugin-order.ts";
import { PLUGINS_SCHEMA, type PluginOrderReason, type PluginOrderResolution } from "./plugin-order.ts";

// The audit surface behind /gentle:plugins: what the contribution box loaded,
// what the contract refused, which ids were replaced, which owners the order
// file placed first, and whether another extension swapped a `ctx.ui` setter.
// Plain data and plain text on purpose (no Pi UI, no theme), so the command
// and the tests read the same model.

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

/** Which read point refused a contribution: the contract itself, or the sidebar seam. */
export type PluginAuditSkipSource = "contract" | "sidebar";

/** One refusal in the audit, tagged with the read point that made it. */
export interface PluginAuditSkip extends ContributionIssue {
	source: PluginAuditSkipSource;
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
	skipped: PluginAuditSkip[];
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
	/**
	 * What the sidebar read point refused (`readSidebarContributionReport()`).
	 * Omitted or empty means that seam reported nothing — another module
	 * instance, or no layout read yet — and the audit stays exactly as it was.
	 */
	sidebar?: ContributionReport;
	order: PluginOrderResolution;
	/** `ctx.ui` setters whose identity changed since the extension first saw the context. */
	replacedSetters?: readonly string[];
}

function slotsOf(contribution: Contribution): ContributionSlotName[] {
	return CONTRIBUTION_SLOTS.filter((slot) => contribution[slot] !== undefined);
}

/**
 * Merge every refusal into one deterministic list: the contract's own issues
 * first, in the order its read produced them, then the sidebar seam's. An
 * issue with the same id and the same detail appears once, so repeated reads
 * of an unchanged box print the same lines.
 */
function skippedIssues(contract: ContributionReport, sidebar: ContributionReport | undefined): PluginAuditSkip[] {
	const merged: PluginAuditSkip[] = [];
	const seen = new Set<string>();
	for (const [source, report] of [["contract", contract], ["sidebar", sidebar]] as const) {
		for (const issue of report?.skipped ?? []) {
			const key = `${issue.id}\u0000${issue.detail}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push({ id: issue.id, code: issue.code, detail: issue.detail, source });
		}
	}
	return merged;
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
		skipped: skippedIssues(input.report, input.sidebar),
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
 * The condition that left the order empty, in the audit's own words. A
 * maintainer asking "why is my plugin not first" reads the file's path and the
 * one check it failed, instead of a generic "malformed".
 */
const ORDER_FILE_CONDITION: Record<Exclude<PluginOrderReason, "none">, string> = {
	missing: "missing",
	unreadable: "unreadable",
	"not-json": "not JSON",
	"wrong-schema": `schema is not ${PLUGINS_SCHEMA}`,
	"wrong-shape": "wrong shape",
};

/**
 * The order-file line, or `undefined` when there is nothing to answer. A
 * missing file is the normal state for the optional `plugins.json`, so it says
 * nothing over an empty box — but the moment a contribution is loaded that
 * author expects an order and needs to learn the file is not there. Any
 * rejection of a file somebody wrote is always named, whatever the box holds.
 */
function orderFileLine(order: PluginOrderResolution, loadedCount: number): string | undefined {
	if (order.reason === "none") return undefined;
	if (order.reason === "missing" && loadedCount === 0) return undefined;
	return `order file: ${order.globalFile} (${ORDER_FILE_CONDITION[order.reason]}; insertion order is used and the file is left untouched)`;
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
	const orderLine = orderFileLine(audit.order, audit.loaded.length);
	if (orderLine !== undefined) lines.push(orderLine);
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
		lines.push(...capped(audit.skipped, limit, (issue) => `  ${issue.id} · ${issue.source === "sidebar" ? "sidebar:" : ""}${issue.code} · ${issue.detail}`, "skipped"));
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
