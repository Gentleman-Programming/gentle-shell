import { existsSync, statSync as fsStatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CodeGraphProvenance {
	workspaceRoot: string;
	commitSha: string | null;
	indexTimestamp: number | null;
	indexStatus: "current" | "stale" | "missing" | "untracked";
}

export interface CodeGraphCaller {
	symbol: string;
	file: string;
	line?: number;
}

export interface CodeGraphCallee {
	symbol: string;
	file: string;
	line?: number;
}

export interface CodeGraphImpactAnalysis {
	targetSymbol?: string;
	callers: CodeGraphCaller[];
	callees: CodeGraphCallee[];
	impactedFiles: string[];
	affectedSuites: string[];
	provenance: CodeGraphProvenance;
	isFallback: boolean;
	fallbackReason?: "missing_index" | "stale_index" | "unavailable" | "parse_error";
}

// ── Provenance ────────────────────────────────────────────────────────────────

export function resolveCodeGraphProvenance(options: {
	cwd: string;
	execGit?: (args: string[]) => string;
	statSync?: (path: string) => { mtimeMs: number } | null;
	getIndexCommit?: (indexDir: string) => string | null;
}): CodeGraphProvenance {
	const { cwd } = options;
	const stat = options.statSync ?? defaultStat;
	const git = options.execGit ?? defaultGit(cwd);
	const indexStat = stat(join(cwd, ".codegraph"));

	if (!indexStat) {
		return { workspaceRoot: cwd, commitSha: null, indexTimestamp: null, indexStatus: "missing" };
	}

	const indexTimestamp = indexStat.mtimeMs;
	let commitSha: string | null = null;
	let indexStatus: CodeGraphProvenance["indexStatus"] = "current";
	try {
		commitSha = git(["rev-parse", "HEAD"]).trim() || null;
	} catch {
		return { workspaceRoot: cwd, commitSha: null, indexTimestamp, indexStatus: "untracked" };
	}
	try {
		if (git(["status", "--porcelain"]).trim().length > 0) indexStatus = "stale";
	} catch { indexStatus = "stale"; }
	try {
		if (!commitSha || !options.getIndexCommit || options.getIndexCommit(join(cwd, ".codegraph"))?.trim() !== commitSha) indexStatus = "stale";
	} catch { indexStatus = "stale"; }
	return { workspaceRoot: cwd, commitSha, indexTimestamp, indexStatus };
}

function defaultStat(path: string): { mtimeMs: number } | null {
	try { return existsSync(path) ? { mtimeMs: fsStatSync(path).mtimeMs } : null; }
	catch { return null; }
}

function defaultGit(cwd: string): (args: string[]) => string {
	return (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// ── Output parsing ────────────────────────────────────────────────────────────

const STALE_WARNING = /changed on disk after the last index sync/i;
const CALLERS_SECTION = /^callers\s+in\s+(.+?)\s*;?\s*tests?:\s*(.*)$/i;
const BLAST_RADIUS_HEADER = /blast radius\s*[—–-]+\s*what depends on these/i;
const SYMBOL_LINE = /^\s*([\w.:<>]+)\s+at\s+(.+?)(?::(\d+))?$/;
const FILE_LINE = /^\s*file:\s*(.+)$/i;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

export function parseCodeGraphExploreOutput(
	stdout: string,
	provenance: CodeGraphProvenance,
): CodeGraphImpactAnalysis {
	const prov = { ...provenance };
	if (STALE_WARNING.test(stdout)) prov.indexStatus = "stale";

	const callers: CodeGraphCaller[] = [];
	const callees: CodeGraphCallee[] = [];
	const impactedFiles = new Set<string>();
	const affectedSuites = new Set<string>();
	let targetSymbol: string | undefined;
	let inBlastRadius = false;
	let currentFile = "";
	let recognized = false;

	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (BLAST_RADIUS_HEADER.test(line)) { recognized = true; inBlastRadius = true; continue; }

		const callerMatch = line.match(CALLERS_SECTION);
		if (callerMatch) {
			recognized = true;
			const file = callerMatch[1].trim();
			if (file) impactedFiles.add(file);
			for (const s of callerMatch[2].split(",")) {
				const suite = s.trim();
				if (suite) affectedSuites.add(suite);
			}
			continue;
		}

		if (TEST_FILE.test(line)) {
			recognized = true;
			const t = line.trim();
			if (t) { affectedSuites.add(t); impactedFiles.add(t); }
		}

		const fileMatch = line.match(FILE_LINE);
		if (fileMatch) {
			recognized = true;
			currentFile = fileMatch[1].trim();
			if (currentFile) impactedFiles.add(currentFile);
			continue;
		}

		const symMatch = line.match(SYMBOL_LINE);
		if (symMatch) {
			recognized = true;
			const symbol = symMatch[1];
			const file = symMatch[2] || currentFile;
			const lineNum = symMatch[3] ? Number(symMatch[3]) : undefined;
			if (!targetSymbol) targetSymbol = symbol;
			const entry = { symbol, file, line: lineNum };
			(inBlastRadius ? callers : callees).push(entry);
			if (file) impactedFiles.add(file);
		}
	}

	if (!recognized) return createFallbackImpactAnalysis(prov, "parse_error");
	return { targetSymbol, callers, callees, impactedFiles: [...impactedFiles],
		affectedSuites: [...affectedSuites], provenance: prov, isFallback: false };
}

// ── Regression suite selection ────────────────────────────────────────────────

export function selectAffectedRegressionSuites(
	analysis: CodeGraphImpactAnalysis,
	allCandidateSuites: string[],
): { selectedSuites: string[]; strategy: "precise_graph" | "conservative_fallback" } {
	const { isFallback, provenance } = analysis;
	const { indexStatus } = provenance;

	// Conservative fallback invariant — never drop tests when index is unreliable
	if (isFallback || indexStatus !== "current") {
		return { selectedSuites: allCandidateSuites.slice(), strategy: "conservative_fallback" };
	}

	// Precise graph: intersect discovered suites with allCandidateSuites
	const affectedSet = new Set(analysis.affectedSuites);
	const selected = allCandidateSuites.filter((s) => affectedSet.has(s));
	if (selected.length === 0) return { selectedSuites: allCandidateSuites.slice(), strategy: "conservative_fallback" };

	return { selectedSuites: selected, strategy: "precise_graph" };
}

// ── Fallback factory ──────────────────────────────────────────────────────────

export function createFallbackImpactAnalysis(
	provenance: CodeGraphProvenance,
	fallbackReason: "missing_index" | "stale_index" | "unavailable" | "parse_error",
	fallbackFiles?: string[],
): CodeGraphImpactAnalysis {
	return {
		callers: [],
		callees: [],
		impactedFiles: fallbackFiles ?? [],
		affectedSuites: [],
		provenance,
		isFallback: true,
		fallbackReason,
	};
}
