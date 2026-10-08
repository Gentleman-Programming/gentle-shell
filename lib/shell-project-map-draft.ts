import {
	PROJECT_MAP_SCHEMA_V1,
	PROJECT_MAP_SURFACES,
	canonicalizeProjectMap,
	isSafeFeatureDocumentPath,
	type ProjectMapCapabilityV1,
	type ProjectMapFoundationV1,
	type ProjectMapState,
	type ProjectMapSurface,
	type ProjectMapV1,
} from "./shell-project-map-schema.ts";

import { surfaceForDeclaredPath } from "./project-map-surface-table.ts";
import { readProjectMapTestCommand } from "./project-map-integration-documents.ts";

export interface ProjectMapDraftSources {
	packageJson?: unknown;
	oddTaskDocuments?: { path: string; text: string }[];
}

export interface ProjectMapDraftResult {
	map: ProjectMapV1 | null;
	assumptions: string[];
	omissions: string[];
}

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER_MAX_LENGTH = 64;
const WORK_UNIT = /^-\s+\[([ xX~])\]\s*\*\*(.+?)\*\*(.*)$/;
const UNREADABLE_WORK_UNIT = /^-\s+\[([^\]]*)\]\s*\*\*(.+)/;
const DESCRIPTION_WORK_UNIT = /^(\s*)-\s+\[([ xX~])\]\s*\*\*(.+?)\*\*(.*)$/;
const BULLET = /^(?:[-*+]|\d+[.)])\s+/;
// After a body's optional list marker is stripped, only a line beginning exactly with this bold
// marker (allowing the colon inside or immediately after the closing bold marker) declares paths.
const ALLOWED_EDIT_SURFACES_MARKER = /^\*\*Allowed edit surfaces:?\*\*:?[\t ]*/;
// Like allowed edit surfaces, the colon may sit inside or immediately after the bold marker.
const BELONGS_TO_MARKER = /^\*\*Belongs to:?\*\*:?[\t ]*/;
const WORK_UNIT_PREFIX_MARKER = /^\*\*Work unit prefix:?\*\*:?[\t ]*/;
const DEFAULT_WORK_UNIT_PREFIX = "FP-";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The lowercase kebab-case form of a name, or `null` when it cannot be one at all. */
function normalizeToKebab(name: string): string | null {
	const withoutScope = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
	const normalized = withoutScope
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length === 0 || !IDENTIFIER.test(normalized) ? null : normalized;
}

function normalizeExactIdentifier(name: string): string | null {
	const normalized = normalizeToKebab(name);
	return normalized === null || normalized.length > IDENTIFIER_MAX_LENGTH ? null : normalized;
}

/**
 * The identifier a title normalizes to, or `null` when it cannot be one.
 *
 * Exported so the reader that explains a capability and the generator that names it share one
 * definition: two functions that disagree about a title would produce a capability nobody can
 * look up, which is the same defect class as a reader that cannot read what the writer writes.
 * A title past the identifier limit is truncated here rather than refused, and because the
 * reader truncates with this same function its lookup keeps agreeing with the generator's name.
 */
export function normalizeIdentifier(name: string): string | null {
	const normalized = normalizeToKebab(name);
	if (normalized === null || normalized.length <= IDENTIFIER_MAX_LENGTH) return normalized;

	let truncated = "";
	let words = 0;
	for (const word of normalized.split("-")) {
		const candidate = truncated.length === 0 ? word : `${truncated}-${word}`;
		if (candidate.length > IDENTIFIER_MAX_LENGTH) break;
		truncated = candidate;
		words += 1;
	}
	// A hard cut can land on the separator that made the input too long, and a trailing hyphen is
	// not an identifier. The word-assembly result never ends that way, so only the fallback trims.
	const fallback = normalized.slice(0, IDENTIFIER_MAX_LENGTH).replace(/-+$/, "");
	const truncatedTo = words >= 2 ? truncated : fallback;
	return truncatedTo.length === 0 ? null : truncatedTo;
}

/** The prefix and title the document wrote inside a bold work-unit label. */
export interface ProjectMapWorkUnitLabel {
	head: string;
	title: string;
}

/** Splits a bold label at its first separator while preserving the functional-point prefix. */
export function splitWorkUnitLabel(label: string): ProjectMapWorkUnitLabel {
	const separator = label.indexOf("—");
	if (separator === -1) return { head: "", title: label.trim() };
	let headEnd = separator + "—".length;
	while (/\s/.test(label[headEnd] ?? "")) headEnd += 1;
	return { head: label.slice(0, headEnd), title: label.slice(headEnd).trim() };
}

export interface ProjectMapDescription {
	title: string;
	lines: string[];
}

export interface ProjectMapStep {
	code: string;
	title: string;
	state: ProjectMapState;
	path: string;
}

function projectMapStateFromCheckbox(checkbox: string): ProjectMapState {
	return checkbox === " " ? "planned" : checkbox === "~" ? "active" : "done";
}

/**
 * Collects a functional point's sub-elements from the same work-unit grammar the draft reads.
 * Documents and declarations retain their sorted, written order; repeated coded entries therefore
 * keep their first declaration.
 */
export function collectProjectMapSteps(documents: readonly { path: string; text: string }[], code: string, delegablePrefix: string | null = null): ProjectMapStep[] {
	if (code.trim().length === 0) return [];
	const steps: ProjectMapStep[] = [];
	const seen = new Set<string>();
	for (const document of [...documents].sort((left, right) => comparePaths(left.path, right.path))) {
		const declared = readDeclaredProjectMapParent(document.text);
		const documentPrefix = delegablePrefix === null ? null : readDeclaredWorkUnitPrefix(document.path, document.text, [], delegablePrefix);
		const declaredParentIsUsable = declared.code !== null && documentPrefix !== null && isDelegableWorkUnitCode(declared.code, documentPrefix);
		for (const rawLine of document.text.split("\n")) {
			const match = DESCRIPTION_WORK_UNIT.exec(rawLine.replace(/\r$/, ""));
			if (match === null) continue;
			const label = match[3]!.replace(/\s+/g, " ").trim();
			const split = splitWorkUnitLabel(label);
			const unitCode = (split.head.length === 0 ? label : split.head.replace(/—\s*$/, "")).trim();
			if (declared.hasDeclaration) {
				if (!declaredParentIsUsable || declared.code !== code || (documentPrefix !== null && isDelegableWorkUnitLabel(label, documentPrefix))) continue;
				const stepCode = split.head.length === 0 ? "" : unitCode;
				if (stepCode.length > 0 && seen.has(stepCode)) continue;
				if (stepCode.length > 0) seen.add(stepCode);
				steps.push({ code: stepCode, title: split.title, state: projectMapStateFromCheckbox(match[2]!), path: document.path });
				continue;
			}
			// D2 says a letter or a dot, and it means any letter: `\p{L}` with the unicode flag, so an
			// accented continuation is a continuation too. The row rule stays ASCII by nature, because
			// what it accepts is digits and hyphens.
			const extendsCode = unitCode.startsWith(code) && unitCode.length > code.length && /^[\p{L}.]/u.test(unitCode.slice(code.length));
			if (!extendsCode || seen.has(unitCode)) continue;
			seen.add(unitCode);
			steps.push({ code: unitCode, title: split.title, state: projectMapStateFromCheckbox(match[2]!), path: document.path });
		}
	}
	return steps;
}

/**
 * Reads a work unit's title and indented body by capability id.
 *
 * Blank body lines are skipped; every non-blank following line must be indented further than the
 * work unit, and its list marker is removed. This remains deliberately more tolerant than the
 * top-level generator, because descriptions may explain nested work units.
 */
export function readProjectMapWorkUnit(documentText: string, capabilityId: string, rowCode?: string): ProjectMapDescription | null {
	if (capabilityId.trim().length === 0) return null;
	const lines = documentText.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const match = DESCRIPTION_WORK_UNIT.exec(lines[index]!.replace(/\r$/, ""));
		if (match === null) continue;
		const label = match[3]!.trim();
		const { title, head } = splitWorkUnitLabel(label);
		const code = (head.length === 0 ? label : head.replace(/—\s*$/, "")).trim();
		if (rowCode === undefined ? normalizeIdentifier(title) !== capabilityId : code !== rowCode) continue;
		return { title, lines: readWorkUnitBody(lines, index + 1, match[1]!.length) };
	}
	return null;
}

function readWorkUnitBody(lines: string[], start: number, indentation: number): string[] {
	const body: string[] = [];
	for (let index = start; index < lines.length; index += 1) {
		const raw = lines[index]!.replace(/\r$/, "");
		if (raw.trim().length === 0) continue;
		if (raw.length - raw.trimStart().length <= indentation) break;
		const text = raw.trim().replace(BULLET, "").replace(/\s+/g, " ").trim();
		if (text.length > 0) body.push(text);
	}
	return body;
}

function comparePaths(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function isDelegableWorkUnitCode(code: string, prefix: string): boolean {
	return code.startsWith(prefix) && /^\d+(?:-\d+)*$/.test(code.slice(prefix.length));
}

function isDelegableWorkUnitLabel(label: string, prefix: string): boolean {
	const { head } = splitWorkUnitLabel(label);
	const code = head.length === 0 ? label.trim() : head.replace(/—\s*$/, "").trim();
	return isDelegableWorkUnitCode(code, prefix);
}

interface DeclaredProjectMapParent {
	code: string | null;
	hasDeclaration: boolean;
	hasUnreadableDeclaration: boolean;
}

/** Reads the first readable parent declaration, retaining unreadable markers anywhere for reporting. */
function readDeclaredProjectMapParent(documentText: string): DeclaredProjectMapParent {
	let code: string | null = null;
	let hasDeclaration = false;
	let hasUnreadableDeclaration = false;
	for (const rawLine of documentText.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim().replace(BULLET, "");
		const marker = BELONGS_TO_MARKER.exec(line);
		if (marker === null) continue;
		hasDeclaration = true;
		const codes = [...line.slice(marker[0].length).matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
		if (codes.length !== 1) {
			hasUnreadableDeclaration = true;
			continue;
		}
		if (code === null) code = codes[0]!;
	}
	return { code, hasDeclaration, hasUnreadableDeclaration };
}

/** Resolves each document independently; invalid and repeated markers never replace a prefix. */
function readDeclaredWorkUnitPrefix(path: string, text: string, omissions: string[], defaultPrefix = DEFAULT_WORK_UNIT_PREFIX): string {
	let prefix: string | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim().replace(BULLET, "");
		const marker = WORK_UNIT_PREFIX_MARKER.exec(line);
		if (marker === null) continue;
		const value = line.slice(marker[0].length);
		const spans = [...value.matchAll(/`([^`]*)`/g)];
		if (spans.length !== 1 || /[\s`]/.test(spans[0]![1]!) || spans[0]![1]!.length === 0
			|| value.replace(/`[^`]*`/g, "").includes("`")) {
			omissions.push(`${path} has an unreadable **Work unit prefix:** declaration that was ignored.`);
			continue;
		}
		if (prefix !== null) {
			omissions.push(`${path} has a duplicate **Work unit prefix:** declaration that was ignored; the first readable declaration "${prefix}" was used instead.`);
			continue;
		}
		prefix = spans[0]![1]!;
	}
	return prefix ?? defaultPrefix;
}

interface ExtractedWorkUnits {
	capabilities: { capability: ProjectMapCapabilityV1; line: string }[];
	stepCount: number;
	prefix: string;
}

function extractWorkUnits(path: string, text: string, omissions: string[]): ExtractedWorkUnits {
	const delegablePrefix = readDeclaredWorkUnitPrefix(path, text, omissions);
	const capabilities: { capability: ProjectMapCapabilityV1; line: string }[] = [];
	let stepCount = 0;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const match = WORK_UNIT.exec(line);
		if (!match) {
			if (UNREADABLE_WORK_UNIT.test(line)) {
				omissions.push(`The work unit line "${line}" in ${path} cannot be read as a capability, so it was omitted.`);
			}
			continue;
		}
		const label = match[2].replace(/\s+/g, " ").trim();
		const id = normalizeIdentifier(splitWorkUnitLabel(label).title);
		if (id === null) {
			omissions.push(`The work unit line "${line}" in ${path} cannot be normalized into a capability identifier.`);
		}
		if (delegablePrefix !== null && !isDelegableWorkUnitLabel(label, delegablePrefix)) {
			stepCount += 1;
			continue;
		}
		if (id === null) continue;
		capabilities.push({
			capability: {
				id,
				outcome: label,
				foundationRefs: [],
				dependsOn: [],
				contracts: [],
				featureDocs: [path],
				surfaces: [],
				state: projectMapStateFromCheckbox(match[1]),
			},
			line,
		});
	}
	return { capabilities, stepCount, prefix: delegablePrefix };
}

function declaredEditSurfacePaths(documentText: string, capabilityId: string, rowCode?: string): { path: string; surfaceName?: string }[] {
	const description = readProjectMapWorkUnit(documentText, capabilityId, rowCode);
	// Guard only: a generated capability cannot reach it because extraction and lookup share one
	// document, label parser, and identifier normalization, but this primitive accepts any id.
	if (description === null) return [];
	const declaration = description.lines.find((line) => ALLOWED_EDIT_SURFACES_MARKER.test(line));
	if (declaration === undefined) return [];
	const entries = declaration.replace(ALLOWED_EDIT_SURFACES_MARKER, "");
	return [...entries.matchAll(/(?:([^\s`,:]+):\s*)?`([^`]+)`/g)].map((match) => ({ path: match[2]!, surfaceName: match[1] }));
}

function deriveCapabilitySurfaces(document: { path: string; text: string }, capability: ProjectMapCapabilityV1, omissions: string[]): ProjectMapSurface[] {
	const matched = new Set<ProjectMapSurface>();
	const unmatched: string[] = [];
	const label = splitWorkUnitLabel(capability.outcome);
	const code = (label.head.length === 0 ? capability.outcome : label.head.replace(/—\s*$/, "")).trim();
	let openName: string | undefined;
	for (const { path, surfaceName } of declaredEditSurfacePaths(document.text, capability.id, code)) {
		if (surfaceName !== undefined) openName = surfaceName;
		if (openName !== undefined && !(PROJECT_MAP_SURFACES as readonly string[]).includes(openName)) {
			omissions.push(`The capability "${capability.id}" declared by ${document.path} has an unknown canonical surface name "${openName}" for declared path: ${path}.`);
			continue;
		}
		const surface = openName === undefined ? surfaceForDeclaredPath(path) : openName as ProjectMapSurface;
		if (surface === null) unmatched.push(path);
		else matched.add(surface);
	}
	if (unmatched.length > 0) {
		omissions.push(`The capability "${capability.id}" declared by ${document.path} has paths that matched no canonical surface prefix: ${unmatched.join(", ")}.`);
	}
	return PROJECT_MAP_SURFACES.filter((surface) => matched.has(surface)) as ProjectMapSurface[];
}

/**
 * Reports the source-owned projection in project, foundation and stored-capability order;
 * each stored capability id is visited once at its first position, and generated-only
 * capabilities follow in canonical id order. Repeated generated capability ids use the
 * first occurrence for field comparison. Foundation ordering is unchanged.
 * Approval is human-owned and ignored.
 * Empty generated surfaces preserve human declarations rather than signal staleness.
 * Known limit: a document that stops declaring an Allowed edit surfaces line is not detected
 * as a change, because its regenerated empty list also looks like a human's own declaration.
 */
export function projectMapSourceChanges(stored: ProjectMapV1, generated: ProjectMapV1): string[] {
	const changes: string[] = [];
	const render = (value: unknown): string => Array.isArray(value) ? JSON.stringify(value) : String(value);
	for (const field of ["id", "name"] as const) {
		if (stored.project[field] !== generated.project[field]) {
			changes.push(`Project ${field} changed: ${stored.project[field]} → ${generated.project[field]}.`);
		}
	}

	function compareEntries<T extends { id: string }>(
		label: string,
		before: T[],
		after: T[],
		fields: readonly (keyof T)[],
		shouldCompare: (entry: T, field: keyof T) => boolean = () => true,
		canonicalCapabilityIds = false,
	): void {
		const generatedById = new Map<string, T>();
		for (const entry of after) {
			if (!canonicalCapabilityIds || !generatedById.has(entry.id)) generatedById.set(entry.id, entry);
		}
		const storedIds = new Set(before.map((entry) => entry.id));
		const visitedIds = new Set<string>();
		for (const entry of before) {
			if (canonicalCapabilityIds && visitedIds.has(entry.id)) continue;
			visitedIds.add(entry.id);
			const next = generatedById.get(entry.id);
			if (next === undefined) {
				changes.push(`${label} "${entry.id}" was removed.`);
				continue;
			}
			for (const field of fields) {
				if (shouldCompare(next, field) && JSON.stringify(entry[field]) !== JSON.stringify(next[field])) {
					changes.push(`${label} "${entry.id}": ${String(field)} ${render(entry[field])} → ${render(next[field])}.`);
				}
			}
		}
		const addedIds = canonicalCapabilityIds ? [...generatedById.keys()].sort() : after.map((entry) => entry.id);
		for (const id of addedIds) {
			if (!storedIds.has(id)) changes.push(`${label} "${id}" was added.`);
		}
	}

	compareEntries("Foundation", stored.foundations, generated.foundations, ["outcome", "state", "evidence"]);
	compareEntries("Capability", stored.capabilities, generated.capabilities,
		["outcome", "state", "foundationRefs", "dependsOn", "contracts", "featureDocs", "surfaces"],
		(entry, field) => field !== "surfaces" || entry.surfaces.length > 0,
		true,
	);
	return changes;
}

/** The display reads document declarations, never a project's configuration. */
export function deriveProjectMap(sources: Pick<ProjectMapDraftSources, "packageJson" | "oddTaskDocuments">, fallbackName: string): ProjectMapDraftResult {
	const omissions: string[] = [];
	const manifest = isRecord(sources.packageJson) ? sources.packageJson : null;
	const name = typeof manifest?.name === "string" && manifest.name.trim().length > 0 ? manifest.name.trim() : fallbackName;
	const projectId = normalizeIdentifier(name) ?? "project";
	const capabilities: ProjectMapCapabilityV1[] = [];
	const seen = new Set<string>();
	const identifiers = new Set<string>();
	for (const document of [...(sources.oddTaskDocuments ?? [])].sort((a, b) => comparePaths(a.path, b.path))) {
		if (!/^odd\/tasks\/[^/]+\.md$/.test(document.path) || !isSafeFeatureDocumentPath(document.path)) continue;
		for (const { capability } of extractWorkUnits(document.path, document.text, omissions).capabilities) {
			const label = splitWorkUnitLabel(capability.outcome);
			const code = (label.head.length === 0 ? capability.outcome : label.head.replace(/—\s*$/, "")).trim();
			if (seen.has(code)) continue;
			seen.add(code);
			// Titles are presentation, not row identity. A collision must not erase another FP.
			if (identifiers.has(capability.id)) {
				const base = normalizeIdentifier(`${label.title} ${code}`) ?? normalizeIdentifier(code)!;
				capability.id = base;
				let suffix = 2;
				while (identifiers.has(capability.id)) capability.id = `${base.slice(0, 54)}-${suffix++}`;
			}
			identifiers.add(capability.id);
			capability.surfaces = deriveCapabilitySurfaces(document, capability, omissions);
			capabilities.push(capability);
		}
	}
	if (capabilities.length === 0) {
		omissions.push("No FP work units were found in odd/tasks/*.md. Documents declare their prefix with **Work unit prefix:** followed by one backticked literal; without it the map expects FP-.");
		return { map: null, assumptions: [], omissions };
	}
	const scripts = manifest?.scripts;
	const hasTooling = isRecord(scripts) && Object.values(scripts).some((command) => typeof command === "string" && command.trim().length > 0);
	const foundations: ProjectMapFoundationV1[] = manifest === null ? [] : [{
		id: "repository-tooling",
		outcome: "The repository and its declared tooling are present and consistent.",
		state: hasTooling ? "done" : "planned",
		...(hasTooling ? { evidence: ["package.json"] } : {}),
	}];
	return {
		map: canonicalizeProjectMap({ version: PROJECT_MAP_SCHEMA_V1, project: { id: projectId, name }, approval: { state: "draft" }, foundations, capabilities }),
		assumptions: [], omissions,
	};
}

export function generateProjectMapDraft(sources: ProjectMapDraftSources): ProjectMapDraftResult {
	const assumptions: string[] = [];
	const omissions: string[] = [];

	const packageJson = sources.packageJson;
	let projectId: string | null = null;
	let projectName: string | null = null;
	if (!isRecord(packageJson)) {
		omissions.push("package.json is absent or is not an object, so the project identity could not be derived.");
	} else {
		const rawName = packageJson.name;
		if (typeof rawName !== "string" || rawName.trim().length === 0) {
			omissions.push("package.json declares no usable \"name\", so the project identity could not be derived.");
		} else {
			projectName = rawName.trim();
			projectId = normalizeExactIdentifier(projectName);
			if (projectId === null) {
				omissions.push(`package.json declares the name "${projectName}", which cannot be normalized into a project identifier.`);
			}
		}
	}

	const foundations: ProjectMapFoundationV1[] = [];
	if (isRecord(packageJson) && projectName !== null) {
		const scripts = packageJson.scripts;
		const declaresTooling =
			isRecord(scripts) && Object.values(scripts).some((command) => typeof command === "string" && command.trim().length > 0);
		foundations.push({
			id: "repository-tooling",
			outcome: "The repository and its declared tooling are present and consistent.",
			state: declaresTooling ? "done" : "planned",
			...(declaresTooling ? { evidence: ["package.json"] } : {}),
		});
		if (!declaresTooling) omissions.push("package.json declares no usable script command, so the repository tooling foundation stays planned.");
	}

	if (isRecord(packageJson)) {
		const declaresGate = readProjectMapTestCommand(JSON.stringify(packageJson)) !== null;
		foundations.push({
			id: "quality-gates",
			outcome: "The project declares the automated gates that guard a change.",
			state: declaresGate ? "done" : "planned",
			...(declaresGate ? { evidence: ["package.json"] } : {}),
		});
		if (!declaresGate) omissions.push("package.json declares no usable scripts.test, so the quality gates foundation stays planned.");
	}

	omissions.push("No structured source in this step names product capabilities; they must come from the ODD work-unit extraction or from the human.");
	const capabilities: ProjectMapCapabilityV1[] = [];
	const declaredBy = new Map<string, { path: string; line: string }>();
	const resolvedPrefixes = new Set<string>();
	const documents = Array.isArray(sources.oddTaskDocuments)
		? sources.oddTaskDocuments
			.filter(
				(document): document is { path: string; text: string } =>
					isRecord(document) && typeof document.path === "string" && document.path.length > 0 && typeof document.text === "string",
			)
			.filter((document) => {
				if (isSafeFeatureDocumentPath(document.path)) return true;
				omissions.push(`${document.path} is not a safe repository-relative path, so it was skipped rather than recorded as a feature document.`);
				return false;
			})
			.sort((left, right) => comparePaths(left.path, right.path))
		: [];
	if (!Array.isArray(sources.oddTaskDocuments)) {
		omissions.push("No ODD task documents were supplied, so no capability could be extracted from work units.");
	}
	const capabilityDocuments = documents.filter((document) => /^odd\/tasks\/[^/]+\.md$/.test(document.path));

	let stepCount = 0;
	for (const document of capabilityDocuments) {
		const extracted = extractWorkUnits(document.path, document.text, omissions);
		resolvedPrefixes.add(extracted.prefix);
		stepCount += extracted.stepCount;
		if (extracted.capabilities.length === 0 && extracted.stepCount === 0) {
			omissions.push(`${document.path} declares no work unit this generator can read, so it contributed no capability.`);
		}
		for (const extractedWorkUnit of extracted.capabilities) {
			const { capability, line } = extractedWorkUnit;
			const existing = declaredBy.get(capability.id);
			if (existing !== undefined) {
				if (existing.path === document.path) {
					omissions.push(`The capability "${capability.id}" is declared twice in ${document.path}: "${existing.line}" and "${line}"; the first declaration wins.`);
				} else {
					omissions.push(`The capability "${capability.id}" is declared by both ${existing.path}, line "${existing.line}", and ${document.path}, line "${line}"; the first document in sorted order wins.`);
				}
				continue;
			}
			declaredBy.set(capability.id, { path: document.path, line });
			capability.surfaces = deriveCapabilitySurfaces(document, capability, omissions);
			capabilities.push(capability);
		}
	}
	// Only retained extraction rows can honour a parent, including when a roadmap limits sources.
	const rowCodes = new Set(capabilities.map((capability) => {
		const label = splitWorkUnitLabel(capability.outcome);
		return (label.head.length === 0 ? capability.outcome : label.head.replace(/—\s*$/, "")).trim();
	}));
	for (const document of documents) {
		const declared = readDeclaredProjectMapParent(document.text);
		if (!declared.hasDeclaration) continue;
		const usable = declared.code !== null
			&& isDelegableWorkUnitCode(declared.code, readDeclaredWorkUnitPrefix(document.path, document.text, [])) && rowCodes.has(declared.code);
		if (!usable) {
			const reason = declared.code === null ? "" : `: "${declared.code}" is not a functional point this map declares`;
			omissions.push(`${document.path} declares an unusable **Belongs to:** declaration${reason}, so its work units were associated with no functional-point row.`);
		} else if (declared.hasUnreadableDeclaration) {
			omissions.push(`${document.path} has an unreadable **Belongs to:** marker that was ignored; the readable declaration "${declared.code}" was used instead.`);
		}
	}
	const prefixSummary = [...(resolvedPrefixes.size === 0 ? [DEFAULT_WORK_UNIT_PREFIX] : resolvedPrefixes)].map((prefix) => `"${prefix}"`).join(", ");
	assumptions.push(
		`${stepCount} work unit${stepCount === 1 ? " was" : "s were"} read as steps instead of capabilities because their codes do not match their document's resolved prefix (${prefixSummary}).`,
	);
	if (capabilities.length === 0) {
		omissions.push("No supplied source names a product capability, so the draft carries none; capabilities must come from the ODD work-unit extraction or from the human.");
	}

	assumptions.push("Every generated map is a draft: this generator never marks a map approved, and approval requires a human actor and an explicit transition.");
	assumptions.push("A generated foundation is done only when its named structured source carries a well-formed declaration of it; done therefore means declared, not verified.");
	assumptions.push("Foundation identifiers are generic proposals derived from repository tooling, and the human is expected to replace or extend them with the project's real foundations.");
	assumptions.push("Project identity is derived from the package manifest name, with the scope removed and the remainder normalized to lowercase kebab-case.");
	assumptions.push("An ODD work unit becomes a capability named after its title, a checked box becomes done and an unchecked box becomes planned, and the declaring document becomes its feature document. The checkbox is a declaration of completion, not verified progress.");
	assumptions.push("Generated capability surfaces were derived from the capability's own declared edit surfaces through the canonical surface table by default, with explicit canonical names taking precedence; a capability without that line remains undeclared.");

	if (projectId === null || projectName === null) {
		return { map: null, assumptions, omissions };
	}

	return {
		map: canonicalizeProjectMap({
			version: PROJECT_MAP_SCHEMA_V1,
			project: { id: projectId, name: projectName },
			approval: { state: "draft" },
			foundations,
			capabilities,
		}),
		assumptions,
		omissions,
	};
}
