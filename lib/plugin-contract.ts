// Community plugin contributions, slice 1 of 2.
//
// A third-party Pi package contributes without importing gentle-pi and without
// depending on extension load order. Pi evaluates every extension with
// `moduleCache: false`, so two evaluations of this file never share a module
// instance; `globalThis[CONTRIBUTIONS]` is the only meeting point. The map key
// is the namespaced contribution id, so a foreign package can fill the box with
// nothing but the symbol and a plain `Map`.
//
// This module is a leaf on purpose: no filesystem, no Pi API, no gentle-pi
// internals, so every read point and the tests can import it.

/** The only version this reader accepts. Anything else is skipped, never guessed. */
export const CONTRACT_VERSION = 1;

/** Process-wide, versioned key a plugin reaches with `Symbol.for`, not with an import. */
export const CONTRIBUTIONS = Symbol.for("gentle-pi.contributions/v1");

export interface PluginRowPreview {
	title: string;
	sample: string;
}

export interface PluginRowChoice {
	setting: string;
	value: string;
	current(): boolean;
	hint?: string;
	applyOnMove?: boolean;
}

/**
 * The public row contract, deliberately not the internal `CustomizeRow` type.
 * The customize read point adapts it, so this slice can grow without exposing
 * gentle-pi internals to plugin authors.
 */
export interface PluginRow {
	category: string;
	label: string | (() => string);
	preview?: () => PluginRowPreview;
	choice?: PluginRowChoice;
	visible?: () => boolean;
	action(): void | Promise<void>;
}

/** The component stays opaque here; the sidebar reader owns its own typing. */
export interface PluginSidebarSection {
	key: string;
	bottom: boolean;
	rail: unknown;
}

export interface PluginPaletteCommand {
	command: string;
	/** Optional: missing, empty or blank means the palette derives a group from the owner. */
	group?: string;
}

export interface Contribution {
	id: string;
	owner: string;
	contract: number;
	rows?: PluginRow[];
	sidebar?: PluginSidebarSection;
	palette?: PluginPaletteCommand;
}

export type ContributionIssueCode =
	| "invalid-contribution"
	| "incompatible-contract"
	| "invalid-id"
	| "duplicate-id"
	| "malformed-rows"
	| "malformed-sidebar"
	| "malformed-palette";

/** One thing the reader refused, with the id it was stored under. */
export interface ContributionIssue {
	id: string;
	code: ContributionIssueCode;
	detail: string;
}

/** What the last read refused and which ids a later set was refused for. */
export interface ContributionReport {
	skipped: ContributionIssue[];
	replaced: string[];
}

/** Audit sink: called once per read, never by default. */
export type ContributionReporter = (report: ContributionReport) => void;

export interface ContributionReadOptions {
	/** Owners to place first, in this order; everything else keeps insertion order. */
	order?: readonly string[];
}

const STATE = Symbol.for("gentle-pi.contributions/v1/state");

interface ContributionState {
	replaced: Set<string>;
	duplicates: Set<string>;
	report: ContributionReport;
	reporter: ContributionReporter | undefined;
}

type SymbolHolder = { [key: symbol]: unknown };

function emptyReport(): ContributionReport {
	return { skipped: [], replaced: [] };
}

function stateOf(store: Map<string, Contribution>): ContributionState {
	// SAFETY: prepare() installs exactly one ContributionState under STATE before any reader runs.
	return (store as unknown as SymbolHolder)[STATE] as ContributionState;
}

/**
 * Attach replacement tracking once per process slot. Re-evaluating this module
 * finds the state already present, so a second evaluation never double-wraps
 * `set` or drops the ids a previous evaluation recorded. A set for an id that
 * already holds a contribution is refused outright: the first value stays in
 * the box, so no package can overwrite another package's contribution.
 */
function prepare(store: Map<string, Contribution>): void {
	const state: ContributionState = { replaced: new Set(), duplicates: new Set(), report: emptyReport(), reporter: undefined };
	Object.defineProperty(store, STATE, { value: state, enumerable: false, configurable: true });
	const nativeSet = store.set;
	Object.defineProperty(store, "set", {
		enumerable: false,
		configurable: true,
		value(id: string, contribution: Contribution): Map<string, Contribution> {
			if (store.has(id)) {
				state.replaced.add(id);
				// Re-setting the exact stored entry changed nothing, so it is replaced but not a conflict.
				if (store.get(id) !== contribution) state.duplicates.add(id);
				return store;
			}
			return nativeSet.call(store, id, contribution);
		},
	});
}

/**
 * The contribution box, created on demand. A plain `Map` a foreign package
 * already installed under `CONTRIBUTIONS` is adopted rather than replaced, so
 * the package only needs the symbol.
 */
export function contributionSlot(): Map<string, Contribution> {
	// SAFETY: the symbol index signature is the process-wide slot this module and plugins agree on.
	const holder = globalThis as unknown as SymbolHolder;
	const current = holder[CONTRIBUTIONS];
	const store = current instanceof Map ? (current as Map<string, Contribution>) : new Map<string, Contribution>();
	if (store !== current) holder[CONTRIBUTIONS] = store;
	if (!(STATE in store)) prepare(store);
	return store;
}

/** Set the audit sink. `undefined` restores silence, which is the test default. */
export function setContributionReporter(reporter: ContributionReporter | undefined): void {
	stateOf(contributionSlot()).reporter = reporter;
}

/** What the last read refused and replaced, as a copy no caller can mutate. */
export function readContributionReport(): ContributionReport {
	const report = stateOf(contributionSlot()).report;
	return { skipped: report.skipped.map((issue) => ({ ...issue })), replaced: [...report.replaced] };
}

/**
 * Every valid contribution: the `order` owners first (insertion order within an
 * owner), then everything else in insertion order. Stored entries are never
 * mutated; a contribution whose payload is partially malformed loads with only
 * that payload dropped, while a property read that throws refuses the whole
 * contribution. A refused duplicate id is reported and keeps its first value.
 */
export function readContributions(options: ContributionReadOptions = {}): Contribution[] {
	const store = contributionSlot();
	const state = stateOf(store);
	const loaded = new Map<string, Contribution>();
	const skipped: ContributionIssue[] = [];
	for (const [key, value] of store) {
		const contribution = normalize(key, value, skipped);
		if (contribution !== undefined) loaded.set(key, contribution);
	}
	for (const key of store.keys()) {
		if (state.duplicates.has(key)) {
			skipped.push(issue(key, "duplicate-id", "a later set for this id was refused; the first contribution wins"));
		}
	}

	const order = Array.isArray(options.order) ? options.order : [];
	const ordered: Contribution[] = [];
	const used = new Set<string>();
	for (const owner of order) {
		for (const [key, contribution] of loaded) {
			if (contribution.owner !== owner || used.has(key)) continue;
			used.add(key);
			ordered.push(contribution);
		}
	}
	for (const [key, contribution] of loaded) {
		if (used.has(key)) continue;
		used.add(key);
		ordered.push(contribution);
	}

	const report: ContributionReport = { skipped, replaced: [...state.replaced] };
	state.report = report;
	if (state.reporter) {
		try {
			state.reporter(report);
		} catch {
			// An audit sink must never break the panel.
		}
	}
	return ordered;
}

/**
 * The wrapper every reader uses for `label`, `preview`, `visible`, `current`
 * and `action`: a throwing or rejecting plugin callback degrades to `fallback`
 * and reaches `onError`, while an async callback is still awaited.
 */
export function guard<T>(run: () => T | Promise<T>, fallback: T, onError: (error: unknown) => void): T | Promise<T> {
	try {
		const result = run();
		if (!isThenable(result)) return result;
		return Promise.resolve(result).then(
			(value) => value as T,
			(error: unknown) => {
				report(onError, error);
				return fallback;
			},
		);
	} catch (error) {
		report(onError, error);
		return fallback;
	}
}

function report(onError: (error: unknown) => void, error: unknown): void {
	try {
		onError(error);
	} catch {
		// A broken reporter must not break the panel either.
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function callable(value: unknown): value is (...args: never[]) => unknown {
	return typeof value === "function";
}

function issue(id: string, code: ContributionIssueCode, detail: string): ContributionIssue {
	return { id, code, detail };
}

/**
 * `id` must be `<owner>.<name>` with both sides non-empty, must match the map
 * key, and must agree with the declared owner. The name may contain dots.
 */
function validIdentity(key: string, value: Contribution): boolean {
	if (typeof value.id !== "string" || typeof value.owner !== "string") return false;
	if (value.id !== key) return false;
	const separator = value.id.indexOf(".");
	if (separator <= 0 || separator === value.id.length - 1) return false;
	return value.owner === value.id.slice(0, separator);
}

function validChoice(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (!nonEmptyString(value.setting) || typeof value.value !== "string") return false;
	if (!callable(value.current)) return false;
	if (value.hint !== undefined && typeof value.hint !== "string") return false;
	if (value.applyOnMove !== undefined && typeof value.applyOnMove !== "boolean") return false;
	return true;
}

function validRow(value: unknown): value is PluginRow {
	if (!isRecord(value)) return false;
	if (!nonEmptyString(value.category)) return false;
	if (typeof value.label !== "string" && !callable(value.label)) return false;
	if (!callable(value.action)) return false;
	if (value.preview !== undefined && !callable(value.preview)) return false;
	if (value.visible !== undefined && !callable(value.visible)) return false;
	if (value.choice !== undefined && !validChoice(value.choice)) return false;
	return true;
}

function validSidebar(value: unknown): value is PluginSidebarSection {
	return isRecord(value) && nonEmptyString(value.key) && typeof value.bottom === "boolean" && "rail" in value;
}

function validPalette(value: unknown): value is PluginPaletteCommand {
	return isRecord(value) && nonEmptyString(value.command) && (value.group === undefined || typeof value.group === "string");
}

function cloneRow(value: PluginRow): PluginRow {
	return value.choice === undefined ? { ...value } : { ...value, choice: { ...value.choice } };
}

function normalize(key: string, value: Contribution, skipped: ContributionIssue[]): Contribution | undefined {
	const issues: ContributionIssue[] = [];
	try {
		if (!isRecord(value)) {
			skipped.push(issue(key, "invalid-contribution", "entry is not an object"));
			return undefined;
		}
		if (value.contract !== CONTRACT_VERSION) {
			skipped.push(issue(key, "incompatible-contract", `contract ${String(value.contract)} is not ${CONTRACT_VERSION}`));
			return undefined;
		}
		if (!validIdentity(key, value)) {
			skipped.push(issue(key, "invalid-id", "id must be a namespaced `<owner>.<name>` and equal its map key"));
			return undefined;
		}

		const contribution: Contribution = { id: key, owner: value.owner, contract: CONTRACT_VERSION };
		const rows = value.rows;
		if (rows !== undefined) {
			if (Array.isArray(rows) && rows.every(validRow)) contribution.rows = rows.map(cloneRow);
			else issues.push(issue(key, "malformed-rows", "rows must be an array of well-formed plugin rows"));
		}
		const sidebar = value.sidebar;
		if (sidebar !== undefined) {
			if (validSidebar(sidebar)) contribution.sidebar = { ...sidebar };
			else issues.push(issue(key, "malformed-sidebar", "sidebar must carry a key, a boolean bottom and a rail"));
		}
		const palette = value.palette;
		if (palette !== undefined) {
			if (validPalette(palette)) contribution.palette = { ...palette };
			else issues.push(issue(key, "malformed-palette", "palette must carry a command and, if present, a string group"));
		}
		skipped.push(...issues);
		return contribution;
	} catch {
		// Any property read can be a plugin getter: a throw is a refusal, never an escape.
		skipped.push(issue(key, "invalid-contribution", "reading the contribution threw"));
		return undefined;
	}
}
