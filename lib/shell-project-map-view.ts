import {
	PROJECT_MAP_ARTIFACT_PATH,
	PROJECT_MAP_SURFACES,
	readProjectMapFile,
	type ProjectMapCapabilityV1,
	type ProjectMapDiagnostic,
	type ProjectMapState,
	type ProjectMapSurface,
	type ProjectMapV1,
} from "./shell-project-map-schema.ts";

// The Project Map card, as pure data. Nothing here imports the TUI runtime, so the
// classification, the coverage arithmetic, and the rendered lines stay verifiable without
// the SDK. `lib/shell-project-map-card.ts` composes this descriptor through `renderCard`,
// and that composition is the only part that needs the runtime.

export const PROJECT_MAP_STATE_GLYPH: Record<ProjectMapState, string> = {
	done: "✓",
	active: "◉",
	review: "◉",
	ready: "○",
	blocked: "✕",
	planned: "○",
};

export const PROJECT_MAP_GROUPS = ["foundations", "capabilities"] as const;
export type ProjectMapGroup = (typeof PROJECT_MAP_GROUPS)[number];

/** Also the click target text: the card reads a rendered header back with the same label. */
export const PROJECT_MAP_GROUP_LABEL: Record<ProjectMapGroup, string> = {
	foundations: "Foundations",
	capabilities: "Product capabilities",
};

const GROUP_HEADER = /[▾▸] (Foundations|Product capabilities) \d+\/\d+/;

/**
 * Reads a rendered group header back to the group it names. The header format lives here, next
 * to the code that writes it, so a click target cannot drift from the rendered text; content
 * rows cannot match because capability and foundation identifiers are lowercase kebab-case.
 */
export function projectMapGroupFromHeader(line: string): ProjectMapGroup | undefined {
	const match = GROUP_HEADER.exec(line);
	if (match === null) return undefined;
	return PROJECT_MAP_GROUPS.find((group) => PROJECT_MAP_GROUP_LABEL[group] === match[1]);
}

/** `true` hides the rows while retaining the group header. */
export interface ProjectMapCollapseState {
	foundations: boolean;
	capabilities: boolean;
}

export const PROJECT_MAP_EXPANDED: ProjectMapCollapseState = { foundations: false, capabilities: false };

/** Return a new state so session owners can retain or replace it safely. */
export function toggleProjectMapGroup(collapse: ProjectMapCollapseState, group: ProjectMapGroup): ProjectMapCollapseState {
	return { ...collapse, [group]: !collapse[group] };
}

const SURFACE_LABEL: Record<ProjectMapSurface, string> = {
	productUx: "Product/UX",
	web: "Web",
	api: "API",
	data: "Data",
	security: "Security",
	operations: "Ops",
	tests: "Tests",
};

const MAX_DIAGNOSTICS = 3;

/**
 * Runtime coordination state: active claims, leases, heartbeats, session bindings, and
 * worktrees. It belongs to the shared cross-worktree store, which does not exist yet, so
 * the only honest value is "unavailable" and the card renders no overlay rows from it.
 */
export interface ProjectMapOverlay {
	readonly unavailable: true;
}

export const PROJECT_MAP_OVERLAY_UNAVAILABLE: ProjectMapOverlay = { unavailable: true };

export interface ProjectMapCoverageEntry {
	surface: ProjectMapSurface;
	declared: number;
	done: number;
}

export type ProjectMapCardState =
	| { kind: "no-fp"; path: string; overlay: ProjectMapOverlay }
	| { kind: "empty"; path: string; overlay: ProjectMapOverlay }
	| { kind: "invalid"; path: string; diagnostics: ProjectMapDiagnostic[]; overlay: ProjectMapOverlay }
	| { kind: "ready"; path: string; map: ProjectMapV1; coverage: ProjectMapCoverageEntry[]; overlay: ProjectMapOverlay; derived?: boolean };

export type ProjectMapSelection = string | undefined;

export interface ProjectMapCardBody {
	lines: string[];
	headers: Array<{ line: number; group: ProjectMapGroup }>;
	selected?: number;
	/** Capability targets share the same body indices as the rendered descriptor. */
	capabilities: Array<{ line: number; id: string; height: number; /** The body column of the marker that explains it. */ help: number }>;
}

export interface ProjectMapCardDescriptor {
	title: string;
	subtitle: string;
	body: string[];
	/** `info` is the theme's own card frame; `error` is the one state that is a failure. */
	tone: "info" | "error";
}

/**
 * Per-surface coverage. `declared` counts the capabilities that state the surface and
 * `done` those that also reached `done`. A surface nothing declares stays at zero of zero,
 * which the explanation renders as unknown: an undeclared surface is an absence of evidence, not
 * evidence of absence.
 */
export function projectMapCoverage(map: ProjectMapV1): ProjectMapCoverageEntry[] {
	return PROJECT_MAP_SURFACES.map((surface) => {
		const declaring = map.capabilities.filter((capability) => capability.surfaces.includes(surface));
		return { surface, declared: declaring.length, done: declaring.filter((capability) => capability.state === "done").length };
	});
}

export function projectMapCardState(path: string, overlay: ProjectMapOverlay = PROJECT_MAP_OVERLAY_UNAVAILABLE): ProjectMapCardState {
	const read = readProjectMapFile(path);
	if (read.map === null) {
		// A missing or unreadable artifact leaves the card empty. An artifact that was read but
		// rejected, including malformed JSON, remains invalid so its diagnostic stays visible.
		const unreadable = read.diagnostics.length > 0 && read.diagnostics.every((diagnostic) => diagnostic.code === "project-map/unreadable-artifact");
		if (unreadable) return { kind: "empty", path, overlay };
		return { kind: "invalid", path, diagnostics: read.diagnostics, overlay };
	}
	return { kind: "ready", path, map: read.map, coverage: projectMapCoverage(read.map), overlay };
}

/**
 * Wraps body text into lines that already fit a narrow card. The card renderer
 * would wrap them anyway, but a pre-wrapped line keeps the descriptor honest about its own
 * width and makes the bound testable without the runtime.
 */
function boundedLines(text: string, budget = CARD_BODY_BUDGET): string[] {
	if (text.length <= budget) return [text];
	// A continuation keeps the indent of the line it continues. Without it a wrapped body
	// line lands at column 0 and reads as a new row of its own, which is what made a wrapped
	// coverage line look like three unrelated lines.
	const indent = /^\s*/.exec(text)?.[0] ?? "";
	const room = Math.max(8, budget - indent.length);
	const lines: string[] = [];
	let current = "";
	const flush = (): void => {
		if (current.length === 0) return;
		lines.push(`${indent}${current}`);
		current = "";
	};
	for (const word of text.trimStart().split(/\s+/)) {
		// A token with no spaces in it — an identifier, a path — is cut hard rather than left to
		// overrun the budget, because every line this returns is drawn as one card line.
		let rest = word;
		while (rest.length > room) {
			flush();
			lines.push(`${indent}${rest.slice(0, room)}`);
			rest = rest.slice(room);
		}
		const candidate = current.length === 0 ? rest : `${current} ${rest}`;
		if (candidate.length > room) {
			flush();
			current = rest;
			continue;
		}
		current = candidate;
	}
	flush();
	return lines;
}

/**
 * Map-level roll-up text, one unwrapped line per surface in canonical schema order.
 * An undeclared surface renders `—`: absence of evidence, never a zero.
 */
export function projectMapCoverageLines(map: ProjectMapV1, coverage: ProjectMapCoverageEntry[]): string[] {
	return PROJECT_MAP_SURFACES.map((surface) => {
		const entry = coverage.find((entry) => entry.surface === surface)!;
		const label = SURFACE_LABEL[entry.surface];
		if (entry.declared === 0) return `${label} —`;
		const share = Math.round((entry.done / entry.declared) * 100);
		// Coverage is an identifier roll-up: labels are for rows, while this compact list names
		// the capabilities that declare the surface.
		const capabilities = map.capabilities
			.filter((capability) => capability.surfaces.includes(entry.surface))
			.map((capability) => `${capability.id} ${PROJECT_MAP_STATE_GLYPH[capability.state]}`)
			.join(", ");
		return `${label} ${share}% (${entry.done}/${entry.declared}): ${capabilities}`;
	});
}

function completed(items: { state: ProjectMapState }[]): number {
	return items.filter((item) => item.state === "done").length;
}

export function projectMapSummaryLine(map: ProjectMapV1): string {
	return `${completed(map.foundations)}/${map.foundations.length} foundations · ${completed(map.capabilities)}/${map.capabilities.length} capabilities`;
}

/**
 * The reasons the map alone can state for a capability that cannot be worked on: its own
 * `blocked` declaration, and the foundations or dependencies it references that are not `done`.
 *
 * Runtime evidence is deliberately absent — the coordination store's blockers are a different
 * fact and are read where they live — and so are references the map does not declare, because a
 * dangling id is a schema problem, not a blocker. The strings are display text and Spanish,
 * because their only reader is the explanation the user opens with `?`.
 */
export function projectMapStaticBlockers(map: ProjectMapV1, capabilityId: string): string[] {
	const capability = map.capabilities.find((entry) => entry.id === capabilityId);
	if (capability === undefined) return [];
	const foundations = new Map(map.foundations.map((entry) => [entry.id, entry]));
	const capabilities = new Map(map.capabilities.map((entry) => [entry.id, entry]));
	const blockers: string[] = [];
	if (capability.state === "blocked") blockers.push("estado bloqueado");
	for (const id of capability.foundationRefs) {
		const foundation = foundations.get(id);
		if (foundation !== undefined && foundation.state !== "done") blockers.push(`fundamento ${id} ${PROJECT_MAP_STATE_GLYPH[foundation.state]}`);
	}
	for (const id of capability.dependsOn) {
		const dependency = capabilities.get(id);
		if (dependency !== undefined && dependency.state !== "done") blockers.push(`dependencia ${id} ${PROJECT_MAP_STATE_GLYPH[dependency.state]}`);
	}
	return blockers;
}

/**
 * The width a body line is built to fit, when the caller does not know it yet.
 *
 * A capability row is truncated to this budget rather than wrapped: a card that lists
 * capabilities is a list, and a row that spills onto a second line loses its glyph and its
 * indent, so it reads as two unrelated lines. `renderCard` wraps anything longer than the real
 * inner width, which is why the real width is threaded down from the render path.
 */
const CARD_BODY_BUDGET = 60;

/**
 * Cuts a label that does not fit at its end, keeping its head: the functional point's code and
 * the beginning of its name are what a reader scans a row for, and the row's click metadata and
 * the `?` explanation still carry the whole label, so dropping the tail loses nothing the row
 * alone was holding. One character of room leaves `…` alone; text that already fits comes back
 * unchanged.
 */
function endTruncate(text: string, room: number): string {
	if (room <= 0) return "";
	if (text.length <= room) return text;
	return `${text.slice(0, room - 1)}…`;
}

/**
 * The marker that opens a capability's explanation, and the body column it occupies.
 *
 * The column is derived from the row's own prefix rather than written down twice, so the hit
 * range the card tests cannot drift away from the row the card paints.
 */
export const PROJECT_MAP_HELP_MARKER = "?";
/** Todo's row budget applies only to capability body rows, not headers or foundations. */
const ROW_CAP = 12;
const GLYPH_ROLE: Partial<Record<ProjectMapState, string>> = { planned: "muted", active: "accent", done: "success" };
const OUTCOME_ROLE: Partial<Record<ProjectMapState, string>> = { planned: "text", active: "accent", done: "dim" };
const ROW_INDENT = "  ";
const ROW_SELECTED = "▸ ";
export const PROJECT_MAP_HELP_COLUMN = ROW_INDENT.length;

/** Paints one segment of a row with a theme role. The default leaves the row plain. */
export type ProjectMapRowPaint = (role: string, text: string) => string;
const IDENTITY_PAINT: ProjectMapRowPaint = (_role, text) => text;

/**
 * The label a row paints. The schema permits a hand-edited outcome, so the whitespace is
 * collapsed here rather than trusted: a newline would otherwise become a second rendered row.
 *
 * One definition on purpose: the card's digest folds in this same label, so a second copy of the
 * rule would let the painted text and the cache key drift apart.
 */
function paintedLabel(capability: ProjectMapCapabilityV1): string {
	return capability.outcome.replace(/\s+/g, " ");
}

/**
 * One capability row, ending at its label with all width after the markers available to it.
 * Below the markers' floor the row is as short as its own markers allow, which is wider than
 * the width it was given. The label is truncated rather than wrapped to keep one body line.
 */
function capabilityRow(capability: ProjectMapCapabilityV1, selected: boolean, innerWidth: number, paint: ProjectMapRowPaint): string {
	const outcome = paintedLabel(capability);
	const plainHead = `${selected ? ROW_SELECTED : ROW_INDENT}${PROJECT_MAP_HELP_MARKER} ${PROJECT_MAP_STATE_GLYPH[capability.state]} `;
	// Measure the plain head, not the bytes of the painted escape sequences.
	const glyphRole = GLYPH_ROLE[capability.state];
	const outcomeRole = OUTCOME_ROLE[capability.state];
	const glyph = PROJECT_MAP_STATE_GLYPH[capability.state];
	const label = endTruncate(outcome, innerWidth - plainHead.length);
	const head = `${selected ? ROW_SELECTED : ROW_INDENT}${paint("muted", PROJECT_MAP_HELP_MARKER)} ${glyphRole === undefined ? glyph : paint(glyphRole, glyph)} `;
	return `${head}${outcomeRole === undefined ? label : paint(outcomeRole, label)}`;
}

export function projectMapCardBody(state: ProjectMapCardState, collapse: ProjectMapCollapseState = PROJECT_MAP_EXPANDED, selection?: ProjectMapSelection, innerWidth = CARD_BODY_BUDGET, paint: ProjectMapRowPaint = IDENTITY_PAINT): ProjectMapCardBody {
	const body: ProjectMapCardBody = { lines: [], headers: [], capabilities: [] };
	const add = (line: string): number => {
		const index = body.lines.length;
		body.lines.push(...boundedLines(line, innerWidth));
		return index;
	};
	/** A row that must stay one line: wrapping it would cost it its glyph and its indent. */
	const addRow = (line: string): number => {
		const index = body.lines.length;
		body.lines.push(line);
		return index;
	};
	if (state.kind === "no-fp") return body;
	if (state.kind === "empty") return body;
	if (state.kind === "invalid") {
		add("The Project Map artifact is not valid:");
		for (const diagnostic of state.diagnostics.slice(0, MAX_DIAGNOSTICS)) add(`  ${diagnostic.path}: ${diagnostic.message}`);
		return body;
	}
	const { map } = state;
	if (map.foundations.length > 0) {
		const line = add(`${collapse.foundations ? "▸" : "▾"} ${PROJECT_MAP_GROUP_LABEL.foundations} ${completed(map.foundations)}/${map.foundations.length}`);
		body.headers.push({ line, group: "foundations" });
		if (!collapse.foundations) for (const foundation of map.foundations) add(`  ${PROJECT_MAP_STATE_GLYPH[foundation.state]} ${foundation.id}`);
	}
	const capabilityHeader = add(`${collapse.capabilities ? "▸" : "▾"} ${PROJECT_MAP_GROUP_LABEL.capabilities} ${completed(map.capabilities)}/${map.capabilities.length}`);
	body.headers.push({ line: capabilityHeader, group: "capabilities" });
	if (!collapse.capabilities) {
		let visible = map.capabilities;
		let more = 0;
		if (map.capabilities.length > ROW_CAP) {
			const done = completed(map.capabilities);
			const open = map.capabilities.filter((capability) => capability.state !== "done");
			// Mirror Todo's bodyRows: a done summary, open rows in order, then overflow.
			const summaryRows = done > 0 ? 1 : 0;
			if (done > 0) addRow(`${ROW_INDENT}${paint("success", "✓")} ${paint("muted", `${done} done`)}`);
			const room = ROW_CAP - summaryRows - (open.length > ROW_CAP - summaryRows ? 1 : 0);
			visible = open.slice(0, room);
			more = Math.max(0, open.length - room);
		}
		for (const capability of visible) {
			const selected = capability.id === selection;
			const line = addRow(capabilityRow(capability, selected, innerWidth, paint));
			// Every capability row is exactly one body line, so the click target is that line.
			body.capabilities.push({ line, id: capability.id, height: 1, help: PROJECT_MAP_HELP_COLUMN });
			if (selected) body.selected = line;
		}
		if (more > 0) addRow(`${ROW_INDENT}${paint("muted", `… ${more} more`)}`);
	}
	return body;
}

export function projectMapCardDescriptor(state: ProjectMapCardState, collapse: ProjectMapCollapseState = PROJECT_MAP_EXPANDED, selection?: ProjectMapSelection, innerWidth = CARD_BODY_BUDGET, paint: ProjectMapRowPaint = IDENTITY_PAINT): ProjectMapCardDescriptor {
	const body = projectMapCardBody(state, collapse, selection, innerWidth, paint).lines;
	// The owner's decision: with nothing to show, the card is its title and nothing else —
	// no message, no instruction and no subtitle, in both empty states.
	if (state.kind === "no-fp") return { title: "Project Map", subtitle: "", tone: "info", body };
	if (state.kind === "empty") return { title: "Project Map", subtitle: "", tone: "info", body };
	if (state.kind === "invalid") return { title: "Project Map", subtitle: "invalid", tone: "error", body };
	return {
		title: "Project Map",
		subtitle: `${state.map.project.name} · ${completed(state.map.capabilities)}/${state.map.capabilities.length}`,
		// The frame is the theme's card frame, the same rose look Status and Todos paint;
		// artifact approval is independent of this capability-progress display.
		tone: "info",
		body,
	};
}

/**
 * A stable digest of the descriptor the card renders. Width and theme are already part of the
 * layout's section cache key, so this follows descriptor changes without reinterpreting state.
 */
export function projectMapCardDigest(state: ProjectMapCardState, collapse: ProjectMapCollapseState = PROJECT_MAP_EXPANDED, selection?: ProjectMapSelection): string {
	const descriptor = projectMapCardDescriptor(state, collapse, selection, CARD_BODY_BUDGET);
	const labels = state.kind === "ready" ? state.map.capabilities.map(paintedLabel) : [];
	return `project-map/${state.kind}:${JSON.stringify({ title: descriptor.title, subtitle: descriptor.subtitle, tone: descriptor.tone, body: descriptor.body, labels })}`;
}
