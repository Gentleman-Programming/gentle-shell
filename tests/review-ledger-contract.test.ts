import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { REVIEW_LENS_PARITY_PATTERNS } from "./support/review-lens-parity.ts";

const ROOT = join(import.meta.dirname, "..");
const CANONICAL = "skills/_shared/review-ledger-contract.md";
const ORCHESTRATOR = ["assets/orchestrator.md", "assets/orchestrator-delegation.md"];
const REVIEW_LENSES = [
	"assets/agents/review-risk.md",
	"assets/agents/review-resilience.md",
	"assets/agents/review-readability.md",
	"assets/agents/review-reliability.md",
] as const;
const JUDGES = ["assets/agents/jd-judge-a.md", "assets/agents/jd-judge-b.md"] as const;
const FIX_AGENT = "assets/agents/jd-fix-agent.md";
const JD_SKILL = "skills/judgment-day/SKILL.md";
const JD_PROMPTS = "skills/judgment-day/references/prompts-and-formats.md";
const GENTLE_SKILL = "skills/gentle-ai/SKILL.md";
const README = "README.md";
const TECHNICAL_REFERENCE = "docs/readme-reference.md";
const CHAIN = "assets/chains/4r-review.chain.md";
const SDD_WORKFLOW = "assets/sdd-orchestrator-workflow.md";
const WORKER = "assets/agents/gentle-ai-worker.md";
const CANONICAL_LIFECYCLE_SPECS = [
	"openspec/specs/review-orchestration/spec.md",
	"openspec/specs/review-transaction/spec.md",
] as const;
const HISTORICAL_LIFECYCLE_SPECS = [
	"openspec/changes/complete-native-review-lifecycle/specs/review-orchestration/spec.md",
	"openspec/changes/complete-native-review-lifecycle/specs/review-transaction/spec.md",
] as const;

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

function union(paths: readonly string[]): string {
	return paths.map(read).join("\n");
}

function assertMatches(label: string, content: string, patterns: readonly RegExp[]): void {
	for (const pattern of patterns) assert.match(content, pattern, label);
}

function fencedBlock(path: string, heading: string): string {
	const lines = read(path).split("\n");
	const starts = lines.flatMap((line, index) => line === heading ? [index] : []);
	assert.equal(starts.length, 1, `${path} must contain one exact ${heading}`);
	const fenceStart = lines.findIndex((line, index) => index > starts[0]! && line.startsWith("```"));
	const fence = lines[fenceStart]!.match(/^(`+)/)?.[1];
	const relativeEnd = lines.slice(fenceStart + 1).findIndex((line) => line === fence);
	assert.ok(fenceStart > starts[0]! && relativeEnd >= 0, `${path} must contain a complete fenced block`);
	return lines.slice(fenceStart + 1, fenceStart + 1 + relativeEnd).join("\n");
}

function jsonBlocks(path: string): unknown[] {
	return [...read(path).matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
}

function assertNativeJsonHasNoMetadata(path: string, value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const forbidden of ["summary", "skill_resolution", "orchestration", "prose"]) {
		assert.ok(!serialized.includes(forbidden), `${path} native JSON contains ${forbidden}`);
	}
}

const JUDGMENT_DAY_DISCOVERY_PATTERNS = [
	/Judgment Day starts with exactly two blind judges and zero refuters\./,
	/Judgment Day alone may iterate discovery and scoped re-judgment, for at most two rounds\./,
	/Findings surviving round two escalate; no third-round transition exists\./,
] as const;

const JUDGMENT_DAY_STANDALONE_SEMANTICS =
	"Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent.";

const OBSOLETE_JUDGMENT_DAY_REPLACEMENT =
	/Judgment Day starts only when explicitly requested and replaces ordinary review for that lineage\./;

const JUDGMENT_DAY_SEMANTIC_SURFACES = [
	CANONICAL,
	JD_SKILL,
	JD_PROMPTS,
	...JUDGES,
	FIX_AGENT,
	"assets/orchestrator-delegation.md",
	SDD_WORKFLOW,
] as const;

const JUDGMENT_DAY_REJUDGMENT_PATTERNS = [
	/Initial discovery and scoped re-judgment are separate modes\./,
	/On controller-requested scoped re-judgment, receive only requested frozen IDs, their exact hash-bound rows, and the fix diff\./,
	/Resolve only supplied IDs and fix-line regressions; do not add findings/,
	/Return one `verified \| corroborated \| regression` resolution per requested ID\./,
] as const;

const FIX_PATTERNS = [
	/Fix only the exact controller-authorized severe IDs in the one supplied batch\./,
	/Do not add findings, alter frozen claims, authorize transitions, deliver, publish, or start another actor\./,
] as const;

test("canonical contract defines compact risk, causal admission, correction, CAS, compatibility, and the delivery boundary", () => {
	const content = read(CANONICAL);
	assertMatches(CANONICAL, content, [
		/start -> finalize -> validate/,
		/`low`[\s\S]*`medium`[\s\S]*`high`/,
		/min\(200, ceil\(original_changed_lines \/ 2\)\)/,
		/testdata\/golden\/\*\*/,
		/`reviewing`, `correction_required`, `validating`, `approved`, and `escalated`/,
		/`evidence_class`, `causal_disposition`, and concrete proof/,
		/`changed-hunk`[\s\S]*`candidate-created-path`[\s\S]*`differential-test`[\s\S]*`before-after`/,
		/Only severe `introduced`, `behavior-activated`, or `worsened` findings with valid proof can enter `correction_ids`/,
		/`pre-existing` and `base-only` findings become non-blocking follow-ups/,
		/one correction transaction/i,
		/original budget/i,
		/frozen findings and genesis scope/i,
		/content-derived revisions, compare-and-swap replacement, exact retry idempotency/i,
		/graph-v1 ordinary lineages remain readable for compatibility but reject new mutation/i,
		/Legacy graph bundle export\/import is retired/i,
		/Judgment Day remains mutable on graph-v1/i,
		/--agent=pi --materialize=true/,
		/provider-owned submission form/i,
		/self-contained authority-advancing vectors/i,
		/Commit, push, pull-request creation, and release creation are not RDD gates/i,
		/Review outcomes and receipt state are informational and never authorize, consume, rewrite, or block a Bash delivery command/i,
		/Pi does not inspect RDD mode or native authority for those commands/i,
		/Review transactions, validation, and SDD never perform delivery commands themselves/i,
		/local orchestrator and same-user process are trusted/i,
		/reviewer and validator outputs remain semantically untrusted/i,
		/do not report.*trusted local orchestrator.*security finding/i,
		/untrusted repository content.*malformed inputs.*stale authority.*path drift.*external callers/i,
		...JUDGMENT_DAY_DISCOVERY_PATTERNS,
	]);
	assert.match(read(TECHNICAL_REFERENCE), /Review outcomes and receipt state are informational; commit, push, pull-request, and release delivery follow ordinary repository policy\./);
	assert.match(read(README), /\]\(docs\/readme-reference\.md(?:#[^)]+)?\)/);
	assert.doesNotMatch(read(README), /one one-shot authorization for the exact command/i);
	assert.doesNotMatch(read(README), /review-publication-gate/i);
});

for (const path of REVIEW_LENSES) {
	test(`${path} requires causal evidence and remains a one-shot read-only result producer`, () => {
		const content = read(path);
		assertMatches(path, content, REVIEW_LENS_PARITY_PATTERNS);
	});
}

function packagePaths(): string[] {
	const manifest = JSON.parse(read("package.json")) as { files?: unknown };
	if (!Array.isArray(manifest.files)) throw new Error("package.json must declare package files");
	return manifest.files.map((entry) => {
		if (typeof entry !== "string") throw new Error("package.json files entries must be strings");
		return entry.replace(/\/+$/, "");
	});
}

function projectPath(absolutePath: string): string | undefined {
	const path = relative(ROOT, absolutePath);
	if (path === "" || path === ".." || path.startsWith(`..${sep}`)) return undefined;
	return path.split(sep).join("/");
}

function isPackagedFile(path: string, packageRoots: readonly string[]): boolean {
	const absolutePath = resolve(ROOT, path);
	const projectRelativePath = projectPath(absolutePath);
	if (!projectRelativePath || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) return false;
	return packageRoots.some((root) => projectRelativePath === root || projectRelativePath.startsWith(`${root}/`));
}

function packagedOrdinaryReviewLenses(): string[] {
	const packageRoots = packagePaths();
	return readdirSync(join(ROOT, "assets", "agents"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.startsWith("review-") && entry.name.endsWith(".md"))
		.map((entry) => `assets/agents/${entry.name}`)
		.filter((path) => isPackagedFile(path, packageRoots))
		.sort();
}

const MARKDOWN_FILE_REFERENCE = /(?:https?:\/\/[^\s)`\]]+|(?:\.{1,2}\/)?[A-Za-z0-9][A-Za-z0-9_./-]*)\.md\b/g;

function assertMarkdownFileDependenciesResolve(path: string, content: string, packageRoots: readonly string[]): void {
	const sourceDirectory = dirname(join(ROOT, path));
	const unresolved = [...content.matchAll(MARKDOWN_FILE_REFERENCE)]
		.map((match) => match[0])
		.filter((reference) => {
			if (reference.startsWith("http://") || reference.startsWith("https://")) return true;
			return ![resolve(ROOT, reference), resolve(sourceDirectory, reference)].some((candidate) => {
				const candidatePath = projectPath(candidate);
				return candidatePath !== undefined && isPackagedFile(candidatePath, packageRoots);
			});
		});
	assert.deepEqual(unresolved, [], `${path} names unavailable Markdown dependencies: ${unresolved.join(", ")}`);
}

test("packaged ordinary review lenses resolve their Markdown file dependencies", () => {
	const packageRoots = packagePaths();
	const lenses = packagedOrdinaryReviewLenses();
	assert.ok(lenses.length > 0, "package must ship at least one ordinary review lens");
	for (const path of lenses) assertMarkdownFileDependenciesResolve(path, read(path), packageRoots);
});

test("ordinary review dependencies allow packaged files and reject unresolved paths", () => {
	const packageRoots = packagePaths();
	assertMarkdownFileDependenciesResolve("assets/agents/review-risk.md", "Sources: docs/native-authority-architecture.md", packageRoots);
	assert.throws(
		() => assertMarkdownFileDependenciesResolve("assets/agents/review-risk.md", "Sources: docs/nonexistent/security.md", packageRoots),
		/unavailable Markdown dependencies: docs\/nonexistent\/security\.md/,
	);
});

test("ordinary lens prompts contain the literal compact-v2 native result envelope", () => {
	const expectedLenses = ["review-risk", "review-resilience", "review-readability", "review-reliability"];
	for (const [index, path] of REVIEW_LENSES.entries()) {
		const blocks = jsonBlocks(path);
		assert.equal(blocks.length, 1, `${path} must contain one native JSON example`);
		const envelope = blocks[0] as Record<string, unknown>;
		assert.deepEqual(Object.keys(envelope), ["review_result"]);
		const reviewResult = envelope.review_result as Record<string, unknown>;
		assert.deepEqual(Object.keys(reviewResult), ["lens_results"]);
		const lensResults = reviewResult.lens_results as Array<Record<string, unknown>>;
		assert.equal(lensResults.length, 1);
		assert.deepEqual(Object.keys(lensResults[0]!), ["lens", "findings", "evidence"]);
		assert.equal(lensResults[0]!.lens, expectedLenses[index]);
		const findings = lensResults[0]!.findings as Array<Record<string, unknown>>;
		assert.equal(findings[0]!.lens, expectedLenses[index]);
		assert.deepEqual(Object.keys(findings[0]!), [
			"id",
			"lens",
			"location",
			"severity",
			"claim",
			"evidence_class",
			"causal_disposition",
			"proof_refs",
		]);
		assertNativeJsonHasNoMetadata(path, envelope);
		assert.match(read(path), /Do not put `summary`, `skill_resolution`, prose, or orchestration metadata inside or beside the native JSON result/);
		assert.match(read(path), /If clean, use an empty `findings` array and a non-empty `evidence` array/);
		assert.doesNotMatch(read(path), /Use empty `findings` and `evidence` arrays when clean/);
	}
});

test("canonical ordinary review specs preserve the negotiated one-correction contract", () => {
	for (const path of CANONICAL_LIFECYCLE_SPECS) {
		const content = read(path);
		assert.match(content, /one correction transaction/i, path);
		assert.match(content, /original.*budget|budget.*original/i, path);
		assert.match(content, /never reruns initial lenses|without rerunning initial (?:lenses|review)/i, path);
		assert.match(content, /correction_required/, path);
		assert.match(content, /failure escalates|failed.*escalates|MUST escalate/i, path);
		assert.match(content, /forecast/i, path);
		assert.doesNotMatch(content, /up to three failed targeted attempts|third failed attempt/i, path);
	}
});

test("historical lifecycle change specs preserve their completed one-attempt design context", () => {
	for (const path of HISTORICAL_LIFECYCLE_SPECS) {
		const content = read(path);
		assert.match(content, /at most one correction|one correction batch|After the one correction|GIVEN one exact ordinary correction|one validator and one final verification/i, path);
		assert.doesNotMatch(content, /up to three failed targeted attempts/i, path);
	}
});

test("risk lens distinguishes trusted orchestration from concrete boundary bypasses", () => {
	const content = read("assets/agents/review-risk.md");
	assert.match(content, /local orchestrator and same-user process are trusted/i);
	assert.match(content, /reviewer and validator outputs remain semantically untrusted/i);
	assert.match(content, /do not report.*trusted local orchestrator.*security finding/i);
	assert.match(content, /untrusted repository content.*malformed inputs.*stale authority.*path drift.*external callers/i);
});

test("the Pi-owned adversarial role agents are retired: roles execute through Go-owned pi processes", () => {
	// gentle-pi#311 P5: the refuter and targeted validator are no longer
	// Pi-authored actors. The provider renders self-contained
	// review.capture-refuter / review.capture-validation vectors; executing
	// them makes Go materialize the role prompt, spawn its own locked-down pi
	// subprocess, and admit the raw verdict.
	for (const retired of ["assets/agents/review-refuter.md", "assets/agents/review-validator.md"]) {
		assert.throws(() => read(retired), `${retired} must be deleted`);
	}
});

for (const path of JUDGES) {
	test(`${path} preserves graph-v1 Judgment Day discovery and scoped re-judgment`, () => {
		const content = read(path);
		assertMatches(path, content, JUDGMENT_DAY_DISCOVERY_PATTERNS);
		assertMatches(path, content, JUDGMENT_DAY_REJUDGMENT_PATTERNS);
	});
}

test("Judgment Day judge prompts contain distinct graph-v1 discovery and re-judgment shapes", () => {
	for (const path of [...JUDGES, JD_PROMPTS]) {
		const blocks = jsonBlocks(path);
		assert.equal(blocks.length, 2, `${path} must contain discovery and re-judgment JSON examples`);
		const discovery = blocks[0] as Record<string, unknown>;
		assert.deepEqual(Object.keys(discovery), ["rows"]);
		const rows = discovery.rows as Array<Record<string, unknown>>;
		assert.deepEqual(Object.keys(rows[0]!), [
			"id",
			"lens",
			"location",
			"severity",
			"status_at_freeze",
			"evidence_class",
			"evidence_claim",
		]);
		assert.equal(rows[0]!.lens, "judgment-day");

		const rejudgment = blocks[1] as Record<string, unknown>;
		assert.deepEqual(Object.keys(rejudgment), ["resolutions"]);
		const resolutions = rejudgment.resolutions as Array<Record<string, unknown>>;
		assert.deepEqual(Object.keys(resolutions[0]!), ["id", "outcome"]);
		for (const block of blocks) assertNativeJsonHasNoMetadata(path, block);
		assert.match(read(path), /Do not put `summary`, `skill_resolution`, prose, or orchestration metadata inside or beside (?:either )?(?:the )?native JSON result/);
	}
	const judgePrompt = fencedBlock(JD_PROMPTS, "## Judge Prompt");
	assert.match(judgePrompt, /```json\n\{\n  "rows":/);
	assert.match(judgePrompt, /Do not put `summary`, `skill_resolution`, prose, or orchestration metadata inside or beside the native JSON result/);
	assert.doesNotMatch(judgePrompt, /End with `Skill Resolution:/);
});

test("Judgment Day canonical and packaged surfaces preserve the independent lifecycle", () => {
	for (const path of JUDGMENT_DAY_SEMANTIC_SURFACES) {
		const content = read(path);
		assert.ok(content.includes(JUDGMENT_DAY_STANDALONE_SEMANTICS), `${path} must use the current standalone Judgment Day sentence`);
		assert.doesNotMatch(content, OBSOLETE_JUDGMENT_DAY_REPLACEMENT, `${path} must reject the obsolete replacement semantics`);
	}
});

test("Judgment Day skill and prompts preserve bounded fix and re-judgment authority", () => {
	const skill = read(JD_SKILL);
	const judgePrompt = fencedBlock(JD_PROMPTS, "## Judge Prompt");
	assertMatches(JD_SKILL, skill, [...JUDGMENT_DAY_DISCOVERY_PATTERNS, ...JUDGMENT_DAY_REJUDGMENT_PATTERNS, ...FIX_PATTERNS]);
	assertMatches(JD_PROMPTS, judgePrompt, JUDGMENT_DAY_DISCOVERY_PATTERNS);
	assertMatches(JD_PROMPTS, fencedBlock(JD_PROMPTS, "## Fix Agent Prompt"), FIX_PATTERNS);
	assertMatches(FIX_AGENT, read(FIX_AGENT), FIX_PATTERNS);
});

test("Judgment Day fix routing has one canonical shape and never falls back to generic roles", () => {
	const canonicalShape = [
		"## Judgment Day activation",
		"User explicitly requested Judgment Day.",
		"## Exact authorized severe IDs",
		"- `JD-A-001`",
		"## Judgment Day correction batch",
		"Round: 1 of 2.",
		"Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`",
		"## Exact frozen finding rows",
		'{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}',
		"## Allowed edit surfaces",
	].join("\n");
	for (const [path, content] of [
		[CANONICAL, read(CANONICAL)],
		[FIX_AGENT, read(FIX_AGENT)],
		[JD_SKILL, read(JD_SKILL)],
		[JD_PROMPTS, fencedBlock(JD_PROMPTS, "## Fix Agent Prompt")],
		["assets/orchestrator-delegation.md", read("assets/orchestrator-delegation.md")],
		[SDD_WORKFLOW, read(SDD_WORKFLOW)],
	] as const) {
		assert.ok(content.includes(canonicalShape), `${path} must carry the canonical Judgment Day fix shape`);
		assert.match(content, /requires no graph-v1 or native review lineage/i);
	}
	const routing = `${read("assets/orchestrator-delegation.md")}\n${read(SDD_WORKFLOW)}`;
	assert.match(routing, /Judgment Day phase roles are never generic fallbacks\./);
	assert.match(routing, /If the generic writer chain is unavailable, use the documented native generic fallback or stop\./);
	assert.match(read(SDD_WORKFLOW), /\| default\s+\| balanced\s+\| SDD phase fallback; never a Judgment Day role\s+\|/);
});

test("orchestrator, injected skill, and technical reference defer RDD lifecycle ownership to Gentle AI", () => {
	const boundary = "This package injects the mirrored provider-bundle review execution contract into this session's system prompt at start; Gentle AI writes nothing into the Pi system prompt, and this package owns everything else here. Absent that mirrored contract, this package invents no lifecycle instructions.";
	const orchestrator = union(ORCHESTRATOR);
	assert.ok(orchestrator.includes(boundary), "orchestrator must carry the sole static ownership boundary");

	for (const [label, content] of [
		[GENTLE_SKILL, read(GENTLE_SKILL)],
		[TECHNICAL_REFERENCE, read(TECHNICAL_REFERENCE)],
	] as const) {
		assertMatches(label, content, [
			/Gentle AI dynamically supplies runtime-specific RDD instructions/i,
			/(?:sole lifecycle authority|does not define an RDD lifecycle)/i,
		]);
	}

	for (const [label, content] of [
		["orchestrator", orchestrator],
		[GENTLE_SKILL, read(GENTLE_SKILL)],
	] as const) {
		assert.doesNotMatch(content, /start -> finalize -> validate|INSPECT before START|next_transition|review\.capture-result/i, label);
	}
});

test("technical reference documents the dynamic runtime authority boundary without an old package route", () => {
	const content = read(TECHNICAL_REFERENCE);
	assert.match(content, /Gentle AI dynamically supplies runtime-specific RDD instructions/i);
	assert.match(content, /does not define an RDD lifecycle/i);
	assert.doesNotMatch(content, /New ordinary review uses compact `gentle_review` `start -> finalize -> validate`\./);
	assert.match(content, /Dangerous-command safety remains independent and authoritative/);
	assert.match(content, /Project and user overrides may shadow a package asset/);
});

test("managed contracts retain no fresh lifecycle review directive", () => {
	const managed = union([...ORCHESTRATOR, SDD_WORKFLOW, WORKER, GENTLE_SKILL, README]);
	for (const obsolete of [
		"A fresh review still follows delegated implementation.",
		"run a fresh-context review lens unless",
		"Run a fresh review before pushing a code release",
	]) assert.ok(!managed.includes(obsolete), `managed contracts retain ${obsolete}`);
	assert.match(read(SDD_WORKFLOW), /SDD phase validation does not start ordinary review or Judgment Day/);
});

test("static 4R chain runs each selected lens once and owns no orchestration", () => {
	const content = read(CHAIN);
	for (const lens of ["review-risk", "review-resilience", "review-readability", "review-reliability"]) {
		assert.equal(content.split(`## ${lens}`).length - 1, 1, `${CHAIN} must run ${lens} once`);
	}
	assert.equal(content.split("supplied `initial_review_tree`").length - 1, 4);
	for (const forbidden of ["review-refuter", "review-validator", "fix/re-review", "Ledger persistence", "final verification"]) {
		assert.ok(!content.includes(forbidden), `${CHAIN} contains ${forbidden}`);
	}
});
