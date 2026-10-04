import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveCodeGraphProvenance,
	parseCodeGraphExploreOutput,
	selectAffectedRegressionSuites,
	createFallbackImpactAnalysis,
	type CodeGraphProvenance,
} from "../lib/codegraph-analysis.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProvenance(overrides?: Partial<CodeGraphProvenance>): CodeGraphProvenance {
	return { workspaceRoot: "/repo", commitSha: "abc123", indexTimestamp: Date.now(), indexStatus: "current", ...overrides };
}

const NOOP_STAT = () => null;
const STAT_FOUND = () => ({ mtimeMs: 1_000_000 });
const GIT_OK = () => "abc123def456";
const GIT_FAIL = () => { throw new Error("not a git repo"); };

// ── Provenance extraction ─────────────────────────────────────────────────────

test("resolveCodeGraphProvenance — missing index returns missing status", () => {
	const prov = resolveCodeGraphProvenance({ cwd: "/repo", statSync: NOOP_STAT, execGit: GIT_OK });
	assert.equal(prov.indexStatus, "missing");
	assert.equal(prov.indexTimestamp, null);
	assert.equal(prov.commitSha, null);
	assert.equal(prov.workspaceRoot, "/repo");
});

test("resolveCodeGraphProvenance — current index with clean git status and matching build commit", () => {
	const prov = resolveCodeGraphProvenance({
		cwd: "/repo", statSync: STAT_FOUND, getIndexCommit: () => "deadbeef",
		execGit: (args) => args[0] === "rev-parse" ? "deadbeef" : "",
	});
	assert.equal(prov.indexStatus, "current");
	assert.equal(prov.commitSha, "deadbeef");
	assert.equal(typeof prov.indexTimestamp, "number");
});

test("resolveCodeGraphProvenance — unverifiable index build commit is stale", () => {
	const git = (args: string[]) => args[0] === "rev-parse" ? "deadbeef" : "";
	for (const getIndexCommit of [undefined, () => null, () => "", () => "other", () => { throw new Error("unreadable"); }]) {
		const prov = resolveCodeGraphProvenance({ cwd: "/repo", statSync: STAT_FOUND, execGit: git, getIndexCommit });
		assert.equal(prov.indexStatus, "stale");
	}
});

test("resolveCodeGraphProvenance — stale index when git status has modifications", () => {
	const prov = resolveCodeGraphProvenance({
		cwd: "/repo",
		statSync: STAT_FOUND,
		execGit: (args) => {
			if (args[0] === "rev-parse") return "deadbeef";
			if (args[0] === "status") return " M src/foo.ts\n";
			return "";
		},
	});
	assert.equal(prov.indexStatus, "stale");
	assert.equal(prov.commitSha, "deadbeef");
});

test("resolveCodeGraphProvenance — stale index when git status fails", () => {
	const prov = resolveCodeGraphProvenance({
		cwd: "/repo", statSync: STAT_FOUND,
		execGit: (args) => args[0] === "status" ? (() => { throw new Error("status failed"); })() : "deadbeef",
	});
	assert.equal(prov.indexStatus, "stale");
});

test("resolveCodeGraphProvenance — git failure with existing index returns untracked", () => {
	const prov = resolveCodeGraphProvenance({ cwd: "/repo", statSync: STAT_FOUND, execGit: GIT_FAIL });
	assert.equal(prov.indexStatus, "untracked");
	assert.equal(prov.commitSha, null);
	assert.ok(prov.indexTimestamp !== null);
});

// ── Output parsing ────────────────────────────────────────────────────────────

test("parseCodeGraphExploreOutput — parses callers section with test suite list", () => {
	const stdout = [
		"Blast radius — what depends on these:",
		"callers in src/lib/auth.ts; tests: tests/auth.test.ts, tests/login.test.ts",
		"callers in src/lib/session.ts; tests: tests/session.test.ts",
	].join("\n");
	const prov = makeProvenance();
	const result = parseCodeGraphExploreOutput(stdout, prov);
	assert.equal(result.isFallback, false);
	assert.ok(result.affectedSuites.includes("tests/auth.test.ts"));
	assert.ok(result.affectedSuites.includes("tests/login.test.ts"));
	assert.ok(result.affectedSuites.includes("tests/session.test.ts"));
	assert.ok(result.impactedFiles.includes("src/lib/auth.ts"));
	assert.ok(result.impactedFiles.includes("src/lib/session.ts"));
});

test("parseCodeGraphExploreOutput — marks provenance stale when stale warning found", () => {
	const stdout = "Warning: changed on disk after the last index sync, results may be incomplete.";
	const prov = makeProvenance({ indexStatus: "current" });
	const result = parseCodeGraphExploreOutput(stdout, prov);
	assert.equal(result.provenance.indexStatus, "stale");
	// original provenance object is not mutated
	assert.equal(prov.indexStatus, "current");
});

test("parseCodeGraphExploreOutput — parses callees from symbol lines before blast radius", () => {
	const stdout = [
		"file: src/core/runner.ts",
		"  resolveModel at src/core/model.ts:42",
		"  buildPrompt at src/core/prompt.ts",
		"Blast radius — what depends on these:",
		"  callSite at src/cli/main.ts:10",
	].join("\n");
	const prov = makeProvenance();
	const result = parseCodeGraphExploreOutput(stdout, prov);
	assert.ok(result.callees.some((c) => c.symbol === "resolveModel" && c.line === 42));
	assert.ok(result.callees.some((c) => c.symbol === "buildPrompt"));
	assert.ok(result.callers.some((c) => c.symbol === "callSite"));
});

test("parseCodeGraphExploreOutput — empty or unrecognized output falls back", () => {
	for (const stdout of ["", "not codegraph output"]) {
		const result = parseCodeGraphExploreOutput(stdout, makeProvenance());
		assert.equal(result.isFallback, true);
		assert.equal(result.fallbackReason, "parse_error");
	}
});

// ── Conservative fallback invariants ─────────────────────────────────────────

test("selectAffectedRegressionSuites — missing index causes conservative fallback", () => {
	const analysis = createFallbackImpactAnalysis(makeProvenance({ indexStatus: "missing" }), "missing_index");
	const all = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
	const { selectedSuites, strategy } = selectAffectedRegressionSuites(analysis, all);
	assert.equal(strategy, "conservative_fallback");
	assert.deepEqual(selectedSuites, all);
});

test("selectAffectedRegressionSuites — stale index causes conservative fallback", () => {
	const prov = makeProvenance({ indexStatus: "stale" });
	const analysis = { ...createFallbackImpactAnalysis(prov, "stale_index"), isFallback: false };
	const all = ["tests/a.test.ts", "tests/b.test.ts"];
	const { selectedSuites, strategy } = selectAffectedRegressionSuites(analysis, all);
	assert.equal(strategy, "conservative_fallback");
	assert.deepEqual(selectedSuites, all);
});

test("selectAffectedRegressionSuites — isFallback true always returns all suites", () => {
	const analysis = createFallbackImpactAnalysis(makeProvenance(), "unavailable");
	const all = ["tests/x.test.ts"];
	const { selectedSuites, strategy } = selectAffectedRegressionSuites(analysis, all);
	assert.equal(strategy, "conservative_fallback");
	assert.deepEqual(selectedSuites, all);
});

test("selectAffectedRegressionSuites — precise graph returns only matching suites", () => {
	const prov = makeProvenance({ indexStatus: "current" });
	const analysis = {
		...createFallbackImpactAnalysis(prov, "unavailable"),
		isFallback: false,
		affectedSuites: ["tests/auth.test.ts"],
	};
	const all = ["tests/auth.test.ts", "tests/unrelated.test.ts"];
	const { selectedSuites, strategy } = selectAffectedRegressionSuites(analysis, all);
	assert.equal(strategy, "precise_graph");
	assert.deepEqual(selectedSuites, ["tests/auth.test.ts"]);
});

test("selectAffectedRegressionSuites — untracked provenance or zero matches selects all", () => {
	const all = ["tests/auth.test.ts"];
	for (const analysis of [
		{ ...createFallbackImpactAnalysis(makeProvenance({ indexStatus: "untracked" }), "unavailable"), isFallback: false },
		{ ...createFallbackImpactAnalysis(makeProvenance(), "unavailable"), isFallback: false, affectedSuites: [] },
	]) {
		const { selectedSuites, strategy } = selectAffectedRegressionSuites(analysis, all);
		assert.equal(strategy, "conservative_fallback");
		assert.deepEqual(selectedSuites, all);
	}
});

// ── Fallback factory ──────────────────────────────────────────────────────────

test("createFallbackImpactAnalysis — produces safe fallback object", () => {
	const prov = makeProvenance({ indexStatus: "missing" });
	const fallback = createFallbackImpactAnalysis(prov, "missing_index", ["src/foo.ts"]);
	assert.equal(fallback.isFallback, true);
	assert.equal(fallback.fallbackReason, "missing_index");
	assert.deepEqual(fallback.callers, []);
	assert.deepEqual(fallback.callees, []);
	assert.deepEqual(fallback.affectedSuites, []);
	assert.deepEqual(fallback.impactedFiles, ["src/foo.ts"]);
	assert.equal(fallback.provenance, prov);
});

test("createFallbackImpactAnalysis — fallbackFiles defaults to empty array", () => {
	const fallback = createFallbackImpactAnalysis(makeProvenance(), "parse_error");
	assert.deepEqual(fallback.impactedFiles, []);
});

// ── Parse error / malformed output ───────────────────────────────────────────

test("parseCodeGraphExploreOutput — malformed lines do not throw, produce partial results", () => {
	const stdout = [
		"@@@ not valid @@@",
		"callers in ; tests:",
		"file:",
		"Blast radius — what depends on these:",
		"  badline:without:proper:format",
	].join("\n");
	let result: ReturnType<typeof parseCodeGraphExploreOutput> | undefined;
	assert.doesNotThrow(() => {
		result = parseCodeGraphExploreOutput(stdout, makeProvenance());
	});
	assert.ok(result !== undefined);
	assert.equal(result.isFallback, false);
});
