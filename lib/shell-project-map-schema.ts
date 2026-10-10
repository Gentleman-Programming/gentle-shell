import { readFileSync } from "node:fs";

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const PROJECT_MAP_SCHEMA_V1 = "gentle-shell.project-map/v1" as const;
export const PROJECT_MAP_SURFACES = ["productUx", "web", "api", "data", "security", "operations", "tests"] as const;
export type ProjectMapSurface = (typeof PROJECT_MAP_SURFACES)[number];
export const PROJECT_MAP_STATES = ["done", "active", "review", "ready", "blocked", "planned"] as const;
export type ProjectMapState = (typeof PROJECT_MAP_STATES)[number];
export const PROJECT_MAP_APPROVAL_STATES = ["draft", "approved"] as const;
export type ProjectMapApprovalState = (typeof PROJECT_MAP_APPROVAL_STATES)[number];
export const PROJECT_MAP_ARTIFACT_PATH = "openspec/project-map.json";
export const PROJECT_MAP_RUNTIME_FIELDS = ["session", "sessionId", "session_id", "worktree", "branch", "lease", "leases", "heartbeat", "heartbeats", "claim", "claims", "blockers", "generation"] as const;
export const PROJECT_MAP_DIAGNOSTIC_CODES = {
	UNSUPPORTED_SCHEMA: "project-map/unsupported-schema-version",
	UNKNOWN_FIELD: "project-map/unknown-field",
	FORBIDDEN_RUNTIME_FIELD: "project-map/forbidden-runtime-field",
	MISSING_FIELD: "project-map/missing-field",
	INVALID_FIELD: "project-map/invalid-field",
	DUPLICATE_ID: "project-map/duplicate-id",
	UNKNOWN_REFERENCE: "project-map/unknown-reference",
	DEPENDENCY_CYCLE: "project-map/dependency-cycle",
	MISSING_FEATURE_DOCUMENT: "project-map/missing-feature-document",
	INVALID_JSON: "project-map/invalid-json",
	UNREADABLE_ARTIFACT: "project-map/unreadable-artifact",
} as const;
export type ProjectMapDiagnosticCode = (typeof PROJECT_MAP_DIAGNOSTIC_CODES)[keyof typeof PROJECT_MAP_DIAGNOSTIC_CODES];

export interface ProjectMapDiagnostic {
	code: ProjectMapDiagnosticCode;
	path: string;
	message: string;
	severity: "error" | "warning";
}

export interface ProjectMapFoundationV1 {
	id: string;
	outcome: string;
	state: ProjectMapState;
	evidence?: string[];
}

export interface ProjectMapCapabilityV1 {
	id: string;
	outcome: string;
	foundationRefs: string[];
	dependsOn: string[];
	contracts: string[];
	featureDocs: string[];
	surfaces: ProjectMapSurface[];
	state: ProjectMapState;
}

export interface ProjectMapApprovalV1 {
	state: ProjectMapApprovalState;
	approvedAt?: string;
	approvedBy?: string;
}

export interface ProjectMapV1 {
	version: typeof PROJECT_MAP_SCHEMA_V1;
	project: { id: string; name: string };
	approval: ProjectMapApprovalV1;
	foundations: ProjectMapFoundationV1[];
	capabilities: ProjectMapCapabilityV1[];
}

export interface ProjectMapValidationOptions {
	strictFeatureDocs?: boolean;
	featureDocExists?: (repositoryRelativePath: string) => boolean;
}

export interface ProjectMapValidationResult {
	map: ProjectMapV1 | null;
	diagnostics: ProjectMapDiagnostic[];
}

type RecordValue = Record<string, unknown>;

type IndexedStrings = {
	entries: string[];
	indices: number[];
};

type CapabilityCollectionIndices = {
	foundationRefs: number[];
	dependsOn: number[];
	featureDocs: number[];
};

type ValidatedCapability = {
	capability: ProjectMapCapabilityV1;
	indices: CapabilityCollectionIndices;
};

function compareIdentifiers(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(
	diagnostics: ProjectMapDiagnostic[],
	code: ProjectMapDiagnosticCode,
	path: string,
	message: string,
	severity: "error" | "warning" = "error",
): void {
	diagnostics.push({ code, path, message, severity });
}

function validateUnknownFields(value: RecordValue, allowed: readonly string[], path: string, diagnostics: ProjectMapDiagnostic[]): void {
	const allowedFields = new Set(allowed);
	const runtimeFields = new Set<string>(PROJECT_MAP_RUNTIME_FIELDS);
	for (const key of Object.keys(value)
		.filter((key) => !allowedFields.has(key))
		.sort((left, right) => {
			const leftRuntimeIndex = PROJECT_MAP_RUNTIME_FIELDS.indexOf(left as (typeof PROJECT_MAP_RUNTIME_FIELDS)[number]);
			const rightRuntimeIndex = PROJECT_MAP_RUNTIME_FIELDS.indexOf(right as (typeof PROJECT_MAP_RUNTIME_FIELDS)[number]);
			if (leftRuntimeIndex !== -1 && rightRuntimeIndex !== -1) return leftRuntimeIndex - rightRuntimeIndex;
			if (leftRuntimeIndex !== -1) return -1;
			if (rightRuntimeIndex !== -1) return 1;
			return compareIdentifiers(left, right);
		})) {
		diagnostic(
			diagnostics,
			runtimeFields.has(key) ? PROJECT_MAP_DIAGNOSTIC_CODES.FORBIDDEN_RUNTIME_FIELD : PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_FIELD,
			`${path}.${key}`,
			runtimeFields.has(key) ? `Runtime coordination field "${key}" is forbidden.` : `Unknown field "${key}".`,
		);
	}
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length <= 64 && IDENTIFIER.test(value);
}

function validateIdentifier(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[]): value is string {
	if (!isIdentifier(value)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected a kebab-case identifier of at most 64 characters.");
		return false;
	}
	return true;
}

function validateOutcome(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[]): value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected a non-empty outcome string.");
		return false;
	}
	return true;
}

function validateState(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[]): value is ProjectMapState {
	if (typeof value !== "string" || !PROJECT_MAP_STATES.includes(value as ProjectMapState)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected a supported lifecycle state.");
		return false;
	}
	return true;
}

function optionalStringArray(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[]): IndexedStrings | null {
	if (!Array.isArray(value)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected an array of non-empty strings.");
		return null;
	}
	const entries: string[] = [];
	const indices: number[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const entry = value[index];
		const entryPath = `${path}[${index}]`;
		if (typeof entry !== "string" || entry.length === 0) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, entryPath, "Expected a non-empty string.");
			continue;
		}
		if (seen.has(entry)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, entryPath, "Duplicate array entry.");
			continue;
		}
		seen.add(entry);
		entries.push(entry);
		indices.push(index);
	}
	return { entries, indices };
}

function optionalCollection(value: RecordValue, field: string, path: string, diagnostics: ProjectMapDiagnostic[]): IndexedStrings {
	if (value[field] === undefined) return { entries: [], indices: [] };
	return optionalStringArray(value[field], `${path}.${field}`, diagnostics) ?? { entries: [], indices: [] };
}

export function isSafeFeatureDocumentPath(value: string): boolean {
	return !/^[\\/]/.test(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes("..");
}

/**
 * Reports whether a string is a real ISO-8601 instant. `Date.parse` alone is not enough:
 * it normalizes rolled-over calendar dates such as `2026-02-30` into March, so every
 * component is range-checked against the calendar it claims to be in.
 */
function daysInMonth(year: number, month: number): number {
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Reports whether a string is a real ISO-8601 instant. `Date.parse` alone is not enough:
 * it normalizes rolled-over calendar dates such as `2026-02-30` into March, so every
 * component is range-checked against the calendar it claims to be in. The calendar check
 * is arithmetic rather than a `Date` round-trip because `Date.UTC` maps years 0 through 99
 * onto 1900 through 1999, which would reject valid instants such as `0050-01-01T00:00:00Z`.
 */
export function isIsoInstant(value: string): boolean {
	const match = ISO_INSTANT.exec(value);
	if (!match) return false;
	const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
	if (day < 1 || day > daysInMonth(year, month)) return false;
	return !Number.isNaN(Date.parse(value));
}

function validateFoundation(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[], identifiers: Set<string>): ProjectMapFoundationV1 | null {
	if (!isRecord(value)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected a foundation object.");
		return null;
	}
	validateUnknownFields(value, ["id", "outcome", "state", "evidence"], path, diagnostics);
	let valid = true;
	for (const field of ["id", "outcome", "state"] as const) {
		if (value[field] === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.${field}`, `Missing required field "${field}".`);
			valid = false;
		}
	}
	const id = value.id;
	if (id !== undefined && !validateIdentifier(id, `${path}.id`, diagnostics)) valid = false;
	if (typeof id === "string" && isIdentifier(id)) {
		if (identifiers.has(id)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.DUPLICATE_ID, `${path}.id`, `Duplicate foundation identifier "${id}".`);
			valid = false;
		} else identifiers.add(id);
	}
	if (value.outcome !== undefined && !validateOutcome(value.outcome, `${path}.outcome`, diagnostics)) valid = false;
	if (value.state !== undefined && !validateState(value.state, `${path}.state`, diagnostics)) valid = false;
	let evidence: string[] | undefined;
	if (value.evidence !== undefined) {
		const evidenceValues = optionalStringArray(value.evidence, `${path}.evidence`, diagnostics);
		evidence = evidenceValues?.entries;
		if (evidence === undefined) valid = false;
	}
	if (!valid || typeof id !== "string" || typeof value.outcome !== "string" || typeof value.state !== "string") return null;
	return { id, outcome: value.outcome, state: value.state as ProjectMapState, ...(evidence === undefined ? {} : { evidence }) };
}

function validateApproval(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[]): ProjectMapApprovalV1 | null {
	if (!isRecord(value)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected an approval object.");
		return null;
	}
	validateUnknownFields(value, ["state", "approvedAt", "approvedBy"], path, diagnostics);
	let valid = true;
	if (value.state === undefined) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.state`, 'Missing required field "state".');
		valid = false;
	} else if (typeof value.state !== "string" || !PROJECT_MAP_APPROVAL_STATES.includes(value.state as ProjectMapApprovalState)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.state`, "Expected a supported approval state.");
		valid = false;
	}
	const approvedAt = value.approvedAt;
	const approvedBy = value.approvedBy;
	if (value.state === "approved") {
		if (approvedAt === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.approvedAt`, 'Missing required field "approvedAt".');
			valid = false;
		} else if (typeof approvedAt !== "string" || !isIsoInstant(approvedAt)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.approvedAt`, "Expected an ISO-8601 instant.");
			valid = false;
		}
		if (approvedBy === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.approvedBy`, 'Missing required field "approvedBy".');
			valid = false;
		} else if (typeof approvedBy !== "string" || approvedBy.trim().length === 0) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.approvedBy`, "Expected a non-empty approver identity.");
			valid = false;
		}
	} else if (value.state === "draft") {
		for (const field of ["approvedAt", "approvedBy"] as const) {
			if (value[field] !== undefined) {
				diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.${field}`, `A draft map may not carry "${field}".`);
				valid = false;
			}
		}
	}
	if (!valid || typeof value.state !== "string") return null;
	return {
		state: value.state as ProjectMapApprovalState,
		...(typeof approvedAt === "string" ? { approvedAt } : {}),
		...(typeof approvedBy === "string" ? { approvedBy } : {}),
	};
}

function validateCapability(value: unknown, path: string, diagnostics: ProjectMapDiagnostic[], identifiers: Set<string>, surfacesRequired: boolean): ValidatedCapability | null {
	if (!isRecord(value)) {
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path, "Expected a capability object.");
		return null;
	}
	validateUnknownFields(value, ["id", "outcome", "foundationRefs", "dependsOn", "contracts", "featureDocs", "surfaces", "state"], path, diagnostics);
	let valid = true;
	for (const field of ["id", "outcome", "surfaces", "state"] as const) {
		if (value[field] === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `${path}.${field}`, `Missing required field "${field}".`);
			valid = false;
		}
	}
	const id = value.id;
	if (id !== undefined && !validateIdentifier(id, `${path}.id`, diagnostics)) valid = false;
	if (typeof id === "string" && isIdentifier(id)) {
		if (identifiers.has(id)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.DUPLICATE_ID, `${path}.id`, `Duplicate capability identifier "${id}".`);
			valid = false;
		} else identifiers.add(id);
	}
	if (value.outcome !== undefined && !validateOutcome(value.outcome, `${path}.outcome`, diagnostics)) valid = false;
	const foundationRefs = optionalCollection(value, "foundationRefs", path, diagnostics);
	const dependsOn = optionalCollection(value, "dependsOn", path, diagnostics);
	const contracts = optionalCollection(value, "contracts", path, diagnostics);
	const featureDocs = optionalCollection(value, "featureDocs", path, diagnostics);
	for (let index = 0; index < featureDocs.entries.length; index += 1) {
		if (!isSafeFeatureDocumentPath(featureDocs.entries[index])) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.featureDocs[${featureDocs.indices[index]}]`, "Feature document paths must be repository-relative and may not contain '..'.");
			valid = false;
		}
	}
	let surfaces: ProjectMapSurface[] = [];
	if (!Array.isArray(value.surfaces)) {
		if (value.surfaces !== undefined) diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.surfaces`, "Expected an array of supported surfaces.");
		valid = false;
	} else if (value.surfaces.length === 0) {
		if (surfacesRequired) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.surfaces`, "An approved capability requires a non-empty array of supported surfaces.");
			valid = false;
		}
	} else {
		const seen = new Set<string>();
		for (let index = 0; index < value.surfaces.length; index += 1) {
			const surface = value.surfaces[index];
			if (typeof surface !== "string" || !PROJECT_MAP_SURFACES.includes(surface as ProjectMapSurface) || seen.has(surface)) {
				diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, `${path}.surfaces[${index}]`, "Expected a unique supported surface.");
				valid = false;
				continue;
			}
			seen.add(surface);
			surfaces.push(surface as ProjectMapSurface);
		}
	}
	if (value.state !== undefined && !validateState(value.state, `${path}.state`, diagnostics)) valid = false;
	if (!valid || typeof id !== "string" || typeof value.outcome !== "string" || typeof value.state !== "string") return null;
	return {
		capability: { id, outcome: value.outcome, foundationRefs: foundationRefs.entries, dependsOn: dependsOn.entries, contracts: contracts.entries, featureDocs: featureDocs.entries, surfaces, state: value.state as ProjectMapState },
		indices: { foundationRefs: foundationRefs.indices, dependsOn: dependsOn.indices, featureDocs: featureDocs.indices },
	};
}

function detectDependencyCycles(
	capabilities: ProjectMapCapabilityV1[],
	originalIndices: Map<string, number>,
	collectionIndices: Map<string, CapabilityCollectionIndices>,
	diagnostics: ProjectMapDiagnostic[],
): void {
	const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
	const discovery = new Map<string, number>();
	const lowLinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	let nextDiscovery = 0;
	const visit = (id: string): void => {
		discovery.set(id, nextDiscovery);
		lowLinks.set(id, nextDiscovery);
		nextDiscovery += 1;
		stack.push(id);
		onStack.add(id);
		const capability = byId.get(id);
		if (capability) {
			for (const dependency of capability.dependsOn) {
				if (!byId.has(dependency)) continue;
				if (!discovery.has(dependency)) {
					visit(dependency);
					lowLinks.set(id, Math.min(lowLinks.get(id) as number, lowLinks.get(dependency) as number));
				} else if (onStack.has(dependency)) {
					lowLinks.set(id, Math.min(lowLinks.get(id) as number, discovery.get(dependency) as number));
				}
			}
		}
		if (lowLinks.get(id) !== discovery.get(id)) return;
		const component: string[] = [];
		let member: string;
		do {
			member = stack.pop() as string;
			onStack.delete(member);
			component.push(member);
		} while (member !== id);
		components.push(component.sort(compareIdentifiers));
	};
	for (const id of [...byId.keys()].sort(compareIdentifiers)) {
		if (!discovery.has(id)) visit(id);
	}
	for (const members of components
		.filter((members) => members.length > 1 || byId.get(members[0])?.dependsOn.includes(members[0]))
		.sort((left, right) => compareIdentifiers(left[0], right[0]))) {
		const memberSet = new Set(members);
		const stackMembers: string[] = [];
		const active = new Map<string, number>();
		const findCycle = (id: string): { members: string[]; source: string; dependencyIndex: number } | null => {
			active.set(id, stackMembers.length);
			stackMembers.push(id);
			const capability = byId.get(id) as ProjectMapCapabilityV1;
			for (let dependencyIndex = 0; dependencyIndex < capability.dependsOn.length; dependencyIndex += 1) {
				const dependency = capability.dependsOn[dependencyIndex];
				if (!memberSet.has(dependency)) continue;
				const activeIndex = active.get(dependency);
				if (activeIndex !== undefined) return { members: [...stackMembers.slice(activeIndex), dependency], source: id, dependencyIndex };
				const cycle = findCycle(dependency);
				if (cycle) return cycle;
			}
			stackMembers.pop();
			active.delete(id);
			return null;
		};
		const cycle = findCycle(members[0]);
		if (!cycle) continue;
		const capabilityIndex = originalIndices.get(cycle.source);
		const originalDependencyIndex = collectionIndices.get(cycle.source)?.dependsOn[cycle.dependencyIndex];
		diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.DEPENDENCY_CYCLE, `$.capabilities[${capabilityIndex}].dependsOn[${originalDependencyIndex}]`, `Dependency cycle among ${members.join(", ")}; observed path ${cycle.members.join(" -> ")}.`);
	}
}

export function validateProjectMap(value: unknown, options: ProjectMapValidationOptions = {}): ProjectMapValidationResult {
	try {
		const diagnostics: ProjectMapDiagnostic[] = [];
		if (!isRecord(value)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$", "Expected a project map object.");
			return { map: null, diagnostics };
		}
		if (value.version === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, "$.version", "Missing required field \"version\".");
			return { map: null, diagnostics };
		}
		if (typeof value.version !== "string") {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$.version", "Expected the schema version string.");
			return { map: null, diagnostics };
		}
		if (value.version !== PROJECT_MAP_SCHEMA_V1) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA, "$.version", `Unsupported schema version \"${value.version}\".`);
			return { map: null, diagnostics };
		}
		validateUnknownFields(value, ["version", "project", "approval", "foundations", "capabilities"], "$", diagnostics);
		let project: { id: string; name: string } | null = null;
		if (value.project === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, "$.project", "Missing required field \"project\".");
		} else if (!isRecord(value.project)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$.project", "Expected a project object.");
		} else {
			validateUnknownFields(value.project, ["id", "name"], "$.project", diagnostics);
			let valid = true;
			for (const field of ["id", "name"] as const) {
				if (value.project[field] === undefined) {
					diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, `$.project.${field}`, `Missing required field \"${field}\".`);
					valid = false;
				}
			}
			if (value.project.id !== undefined && !validateIdentifier(value.project.id, "$.project.id", diagnostics)) valid = false;
			if (value.project.name !== undefined && (typeof value.project.name !== "string" || value.project.name.trim().length === 0)) {
				diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$.project.name", "Expected a non-empty project name.");
				valid = false;
			}
			if (valid && typeof value.project.id === "string" && typeof value.project.name === "string") project = { id: value.project.id, name: value.project.name };
		}
		const foundations: ProjectMapFoundationV1[] = [];
		const foundationIds = new Set<string>();
		if (value.foundations !== undefined) {
			if (!Array.isArray(value.foundations)) diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$.foundations", "Expected an array of foundations.");
			else for (let index = 0; index < value.foundations.length; index += 1) {
				const foundation = validateFoundation(value.foundations[index], `$.foundations[${index}]`, diagnostics, foundationIds);
				if (foundation) foundations.push(foundation);
			}
		}
		let approval: ProjectMapApprovalV1 = { state: "draft" };
		if (value.approval !== undefined) {
			const validatedApproval = validateApproval(value.approval, "$.approval", diagnostics);
			if (validatedApproval) approval = validatedApproval;
		}
		const surfacesRequired = approval.state === "approved";
		const capabilities: ProjectMapCapabilityV1[] = [];
		const capabilityIds = new Set<string>();
		const originalIndices = new Map<string, number>();
		const collectionIndices = new Map<string, CapabilityCollectionIndices>();
		if (value.capabilities === undefined) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FIELD, "$.capabilities", "Missing required field \"capabilities\".");
		} else if (!Array.isArray(value.capabilities)) {
			diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, "$.capabilities", "Expected an array of capabilities.");
		} else {
			for (let index = 0; index < value.capabilities.length; index += 1) {
				const validated = validateCapability(value.capabilities[index], `$.capabilities[${index}]`, diagnostics, capabilityIds, surfacesRequired);
				if (validated) {
					capabilities.push(validated.capability);
					originalIndices.set(validated.capability.id, index);
					collectionIndices.set(validated.capability.id, validated.indices);
				}
			}
		}
		for (const capability of capabilities) {
			const index = originalIndices.get(capability.id);
			const indices = collectionIndices.get(capability.id) as CapabilityCollectionIndices;
			for (let referenceIndex = 0; referenceIndex < capability.foundationRefs.length; referenceIndex += 1) {
				if (!foundationIds.has(capability.foundationRefs[referenceIndex])) diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE, `$.capabilities[${index}].foundationRefs[${indices.foundationRefs[referenceIndex]}]`, `Unknown foundation reference \"${capability.foundationRefs[referenceIndex]}\".`);
			}
			for (let dependencyIndex = 0; dependencyIndex < capability.dependsOn.length; dependencyIndex += 1) {
				if (!capabilityIds.has(capability.dependsOn[dependencyIndex])) diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.UNKNOWN_REFERENCE, `$.capabilities[${index}].dependsOn[${indices.dependsOn[dependencyIndex]}]`, `Unknown capability reference \"${capability.dependsOn[dependencyIndex]}\".`);
			}
			if (options.featureDocExists) {
				for (let documentIndex = 0; documentIndex < capability.featureDocs.length; documentIndex += 1) {
					const documentPath = capability.featureDocs[documentIndex];
					if (!isSafeFeatureDocumentPath(documentPath)) continue;
					let exists = false;
					try {
						exists = options.featureDocExists(documentPath);
					} catch {
						exists = false;
					}
					if (!exists) diagnostic(diagnostics, PROJECT_MAP_DIAGNOSTIC_CODES.MISSING_FEATURE_DOCUMENT, `$.capabilities[${index}].featureDocs[${indices.featureDocs[documentIndex]}]`, `Feature document \"${documentPath}\" does not exist.`, options.strictFeatureDocs === false ? "warning" : "error");
				}
			}
		}
		detectDependencyCycles(capabilities, originalIndices, collectionIndices, diagnostics);
		if (!project || diagnostics.some((entry) => entry.severity === "error")) return { map: null, diagnostics };
		return { map: canonicalizeProjectMap({ version: PROJECT_MAP_SCHEMA_V1, project, approval, foundations, capabilities }), diagnostics };
	} catch {
		return { map: null, diagnostics: [{ code: PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_FIELD, path: "$", message: "Project map validation failed.", severity: "error" }] };
	}
}

export function parseProjectMap(text: string, options?: ProjectMapValidationOptions): ProjectMapValidationResult {
	try {
		return validateProjectMap(JSON.parse(text), options);
	} catch {
		return { map: null, diagnostics: [{ code: PROJECT_MAP_DIAGNOSTIC_CODES.INVALID_JSON, path: "$", message: "Invalid JSON project map.", severity: "error" }] };
	}
}

export function readProjectMapFile(path: string, options?: ProjectMapValidationOptions): ProjectMapValidationResult {
	try {
		return parseProjectMap(readFileSync(path, "utf8"), options);
	} catch {
		return { map: null, diagnostics: [{ code: PROJECT_MAP_DIAGNOSTIC_CODES.UNREADABLE_ARTIFACT, path: "$", message: "Project map artifact could not be read.", severity: "error" }] };
	}
}

export function canonicalizeProjectMap(map: ProjectMapV1): ProjectMapV1 {
	const surfaceOrder = new Map(PROJECT_MAP_SURFACES.map((surface, index) => [surface, index]));
	return {
		version: PROJECT_MAP_SCHEMA_V1,
		project: {
			id: map.project.id,
			name: map.project.name,
		},
		approval: {
			state: map.approval.state,
			...(map.approval.approvedAt === undefined ? {} : { approvedAt: map.approval.approvedAt }),
			...(map.approval.approvedBy === undefined ? {} : { approvedBy: map.approval.approvedBy }),
		},
		foundations: map.foundations
			.map((foundation) => ({
				id: foundation.id,
				outcome: foundation.outcome,
				state: foundation.state,
				...(foundation.evidence === undefined ? {} : { evidence: [...foundation.evidence].sort(compareIdentifiers) }),
			}))
			.sort((left, right) => compareIdentifiers(left.id, right.id)),
		capabilities: map.capabilities
			.map((capability) => ({
				id: capability.id,
				outcome: capability.outcome,
				foundationRefs: [...capability.foundationRefs].sort(compareIdentifiers),
				dependsOn: [...capability.dependsOn].sort(compareIdentifiers),
				contracts: [...capability.contracts].sort(compareIdentifiers),
				featureDocs: [...capability.featureDocs].sort(compareIdentifiers),
				surfaces: [...capability.surfaces].sort((left, right) => (surfaceOrder.get(left) ?? 0) - (surfaceOrder.get(right) ?? 0)),
				state: capability.state,
			}))
			.sort((left, right) => compareIdentifiers(left.id, right.id)),
	};
}

export function serializeProjectMap(map: ProjectMapV1): string {
	return `${JSON.stringify(canonicalizeProjectMap(map), null, 2)}\n`;
}
