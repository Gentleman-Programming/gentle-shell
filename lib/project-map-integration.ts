import type { ProjectMapState } from "./shell-project-map-schema.ts";

/**
 * Integration readiness: which capability can be integrated next, and what is the
 * evidence?
 *
 * This module is a pure projection over already-read values — it performs no I/O of
 * its own, and every reader stays injected at the composition site, the same rule the
 * session-tab layer follows. It never writes, never merges and never resolves anything:
 * readiness is informational, exactly as a readiness receipt's `authority: "none"` says.
 */

export type ProjectMapIntegrationCheck = "verified" | "mismatched" | "unverified";

export interface ProjectMapIntegrationDiagnostic {
	code: string;
	path: string;
	message: string;
	severity: "error" | "warning";
}

export interface ProjectMapIntegrationChecks {
	dependencies: ProjectMapIntegrationCheck;
	contracts: ProjectMapIntegrationCheck;
	blockers: ProjectMapIntegrationCheck;
	coverage: ProjectMapIntegrationCheck;
	freshness: ProjectMapIntegrationCheck;
	conflicts: ProjectMapIntegrationCheck;
	verification: ProjectMapIntegrationCheck;
	tasks: ProjectMapIntegrationCheck;
	review: ProjectMapIntegrationCheck;
}

export interface ProjectMapIntegrationCandidate {
	capabilityId: string;
	outcome: string;
	state: ProjectMapState;
	branch: string | null;
	worktreeRoot: string | null;
	baseCommit: string | null;
	dependencyReady: boolean;
	complete: boolean;
	openBlockers: number;
	proposedContracts: number;
	nextSafeAction: string | null;
	verification: { command: string | null; source: "manifest" | "not-declared" };
	review: { lineages: number };
	tasks: { path: string; done: number; total: number } | null;
	/** The paths this candidate shares with another, as reported by the overlap reader. */
	overlaps: string[];
	/** How far behind the target the branch is, when it could be measured. */
	behindBy: number | null;
	/** Whatever reason the reader that produced a check wanted to carry, keyed by check. */
	reasons: Partial<Record<keyof ProjectMapIntegrationChecks, string>>;
	checks: ProjectMapIntegrationChecks;
	ready: boolean;
}

export interface ProjectMapIntegrationReadiness {
	available: boolean;
	target: string | null;
	candidates: ProjectMapIntegrationCandidate[];
	diagnostics: ProjectMapIntegrationDiagnostic[];
}

export interface ProjectMapIntegrationCapability {
	id: string;
	outcome: string;
	state: ProjectMapState;
	dependsOn: readonly string[];
	contracts: readonly string[];
	featureDocs: readonly string[];
}

/**
 * The checks a candidate must pass to be ready. Two checks are deliberately absent:
 * `review`, because review evidence is evidence and not authorization, and `coverage`,
 * because coverage is *this run's own output* — a readiness receipt — and gating on it made
 * the first receipt unreachable from inside the product, since the only issuer is the run it
 * would have had to satisfy. Both are still reported; neither can hold a candidate back.
 */
export const PROJECT_MAP_INTEGRATION_GATING_CHECKS = ["dependencies", "contracts", "blockers", "verification", "freshness", "conflicts", "tasks"] as const;
/** Checks reported to the reader that never gate. `coverage` states whether a receipt exists. */
export const PROJECT_MAP_INTEGRATION_REPORTED_CHECKS = ["coverage", "review"] as const;

export interface ProjectMapIntegrationInput {
	map: { capabilities: readonly ProjectMapIntegrationCapability[] } | null;
	coordination: {
		satellites: readonly { capabilityId: string; sessionId: string }[];
		capabilities: readonly { capabilityId: string; dependencyReady: boolean; complete: boolean; openBlockers: number; proposedContracts: number; nextSafeAction: string }[];
		conflicts: readonly { code: string; capabilityId?: string; sessionId?: string; message: string }[];
	};
	worktreeBindings: readonly { capabilityId: string; sessionId: string; branch: string; worktreeRoot: string; baseCommit: string }[];
	/** The project's own test command, read from package.json scripts.test; null when undeclared. */
	verification: { testCommand: string | null };
	/** The branch integration would land on, or null when it could not be resolved. */
	target: string | null;
	/** Review evidence per capability. Evidence only: it never gates a candidate. */
	review: ReadonlyMap<string, { lineages: number }>;
	tasks: ReadonlyMap<string, { path: string; done: number; total: number }>;
	/** Verification results supplied by the repository-facing slice; anything absent stays unverified. */
	checks: ReadonlyMap<string, Partial<ProjectMapIntegrationChecks>>;
	/** Evidence the readers measured, kept beside the check states rather than inside them. */
	evidence?: ReadonlyMap<string, { behindBy?: number | null; overlaps?: readonly string[] }>;
	/** The reason a reader gave for a check, so the report can repeat it instead of inventing one. */
	reasons?: ReadonlyMap<string, Partial<Record<keyof ProjectMapIntegrationChecks, string>>>;
	diagnostics?: readonly ProjectMapIntegrationDiagnostic[];
}

const CYCLE_CODE = "project-map-integration/dependency-cycle";

/**
 * Orders the candidates so a dependency always precedes the capability that depends
 * on it, breaking ties by id so the report is deterministic. A cycle cannot reach here
 * through the map's own validation, but if one does it is reported and the remaining
 * candidates are appended in id order rather than dropped.
 */
function orderCandidates(capabilities: readonly ProjectMapIntegrationCapability[], diagnostics: ProjectMapIntegrationDiagnostic[]): ProjectMapIntegrationCapability[] {
	const inScope = new Set(capabilities.map((capability) => capability.id));
	const remaining = new Map(capabilities.map((capability) => [capability.id, new Set(capability.dependsOn.filter((dependency) => inScope.has(dependency)))]));
	const ordered: ProjectMapIntegrationCapability[] = [];
	const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
	while (remaining.size > 0) {
		const ready = [...remaining.entries()].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
		if (ready.length === 0) {
			const stuck = [...remaining.keys()].sort();
			diagnostics.push({
				code: CYCLE_CODE,
				path: `$.capabilities.${stuck[0]}`,
				message: `A dependency cycle among ${stuck.join(", ")} prevents ordering; they are reported in id order instead.`,
				severity: "warning",
			});
			for (const id of stuck) {
				ordered.push(byId.get(id)!);
				remaining.delete(id);
			}
			break;
		}
		for (const id of ready) {
			ordered.push(byId.get(id)!);
			remaining.delete(id);
			for (const dependencies of remaining.values()) dependencies.delete(id);
		}
	}
	return ordered;
}

function check(value: boolean, whenFalse: ProjectMapIntegrationCheck = "mismatched"): ProjectMapIntegrationCheck {
	return value ? "verified" : whenFalse;
}

export function deriveProjectMapIntegrationReadiness(input: ProjectMapIntegrationInput): ProjectMapIntegrationReadiness {
	const diagnostics: ProjectMapIntegrationDiagnostic[] = [...(input.diagnostics ?? [])];
	if (input.map === null) return { available: false, target: input.target, candidates: [], diagnostics };

	const projected = new Map(input.coordination.capabilities.map((capability) => [capability.capabilityId, capability]));
	const verification = input.verification.testCommand === null
		? { command: null, source: "not-declared" as const }
		: { command: input.verification.testCommand, source: "manifest" as const };

	const candidates = orderCandidates(input.map.capabilities.filter((capability) => capability.state !== "done"), diagnostics).map((capability) => {
		const coverage = projected.get(capability.id);
		// The store keeps one worktree binding per capability, so the first match is the one.
		const binding = input.worktreeBindings.find((candidate) => candidate.capabilityId === capability.id);
		const supplied = input.checks.get(capability.id) ?? {};
		const evidence = input.evidence?.get(capability.id);
		const checks: ProjectMapIntegrationChecks = {
			dependencies: check(coverage?.dependencyReady === true),
			contracts: check((coverage?.proposedContracts ?? 0) === 0),
			blockers: check((coverage?.openBlockers ?? 0) === 0),
			coverage: check(coverage?.complete === true),
			verification: check(verification.command !== null, "unverified"),
			freshness: supplied.freshness ?? "unverified",
			conflicts: supplied.conflicts ?? "unverified",
			tasks: supplied.tasks ?? "unverified",
			review: supplied.review ?? "unverified",
		};
		return {
			capabilityId: capability.id,
			outcome: capability.outcome,
			state: capability.state,
			branch: binding?.branch ?? null,
			worktreeRoot: binding?.worktreeRoot ?? null,
			baseCommit: binding?.baseCommit ?? null,
			dependencyReady: coverage?.dependencyReady === true,
			complete: coverage?.complete === true,
			openBlockers: coverage?.openBlockers ?? 0,
			proposedContracts: coverage?.proposedContracts ?? 0,
			nextSafeAction: coverage?.nextSafeAction ?? null,
			verification,
			review: { lineages: input.review.get(capability.id)?.lineages ?? 0 },
			tasks: input.tasks.get(capability.id) ?? null,
			overlaps: [...(evidence?.overlaps ?? [])],
			behindBy: evidence?.behindBy ?? null,
			reasons: input.reasons?.get(capability.id) ?? {},
			checks,
			ready: capability.state !== "blocked" && PROJECT_MAP_INTEGRATION_GATING_CHECKS.every((name) => checks[name] === "verified"),
		};
	});

	return { available: true, target: input.target, candidates, diagnostics };
}

/**
 * The report a user reads. It is deliberately blunt about what it does not know:
 * every candidate lists what verified, what mismatched and what stayed unverified,
 * and the last line says that none of it grants anything.
 */
export function renderProjectMapIntegrationReport(readiness: ProjectMapIntegrationReadiness, options: { limit?: number } = {}): string[] {
	if (!readiness.available) return ["The approved Project Map could not be read, so integration readiness is unknown."];
	const limit = options.limit ?? Number.POSITIVE_INFINITY;
	const shown = readiness.candidates.slice(0, limit);
	const lines = [`Integration readiness → ${readiness.target ?? "target unknown"}`];
	for (const candidate of shown) {
		lines.push(`${candidate.ready ? "✓" : "✕"} ${candidate.capabilityId} · ${candidate.branch ?? "no branch"} · ${candidate.state}`);
		const verified = PROJECT_MAP_INTEGRATION_GATING_CHECKS.filter((name) => candidate.checks[name] === "verified");
		lines.push(`  verified: ${verified.length === 0 ? "none" : verified.join(", ")}`);
		for (const name of PROJECT_MAP_INTEGRATION_GATING_CHECKS) {
			if (candidate.checks[name] !== "mismatched") continue;
			lines.push(`  mismatch: ${name} — ${mismatchReason(candidate, name, readiness.target)}`);
		}
		const unverified = [...PROJECT_MAP_INTEGRATION_GATING_CHECKS, ...PROJECT_MAP_INTEGRATION_REPORTED_CHECKS].filter((name) => candidate.checks[name] === "unverified");
		lines.push(`  unverified: ${unverified.length === 0 ? "none" : unverified.join(", ")}`);
		// A reader who is told a check is unverified deserves to know why, especially when
		// the reason is that nothing can verify it yet.
		for (const name of unverified) {
			const reason = candidate.reasons[name];
			if (reason !== undefined) lines.push(`    ${name}: ${reason}`);
		}
		lines.push(`  coverage: ${candidate.checks.coverage === "verified" ? "a readiness receipt already covers it" : "no readiness receipt recorded yet"}`);
		if (candidate.behindBy !== null) lines.push(`  behind ${readiness.target} by ${candidate.behindBy}`);
		lines.push(`  verification: ${candidate.verification.command ?? "not declared"}`);
		lines.push(`  tasks: ${candidate.tasks === null ? "none declared" : `${candidate.tasks.path} ${candidate.tasks.done}/${candidate.tasks.total}`}`);
		lines.push(`  review: ${candidate.review.lineages === 0 ? "none recorded" : `${candidate.review.lineages} lineage${candidate.review.lineages === 1 ? "" : "s"}`}`);
	}
	if (readiness.candidates.length > shown.length) {
		const left = readiness.candidates.length - shown.length;
		lines.push(`${left} more candidate${left === 1 ? "" : "s"} not shown`);
	}
	lines.push(`Next safe integration action: ${readiness.candidates.find((candidate) => candidate.ready)?.capabilityId ?? "none"}`);
	lines.push("Readiness grants nothing: commit, push, PR and merge stay ordinary repository policy.");
	return lines;
}

/** Prefers the reason the reader gave; otherwise states the fact the candidate already carries. */
function mismatchReason(candidate: ProjectMapIntegrationCandidate, name: keyof ProjectMapIntegrationChecks, target: string | null): string {
	const supplied = candidate.reasons[name];
	if (supplied !== undefined) return supplied;
	if (name === "conflicts") return candidate.overlaps.length === 0 ? "a likely conflict was detected" : `likely conflict on ${candidate.overlaps.join(", ")}`;
	if (name === "blockers") return `${candidate.openBlockers} open blocker${candidate.openBlockers === 1 ? "" : "s"}`;
	if (name === "contracts") return `${candidate.proposedContracts} proposed contract${candidate.proposedContracts === 1 ? "" : "s"} without a decision`;
	if (name === "dependencies") return "a dependency is not ready";
	if (name === "freshness") return `the branch base is not contained in ${target ?? "the integration target"}`;
	return "the map and the feature document disagree";
}
