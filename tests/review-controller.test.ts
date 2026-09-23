import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import gentleAi, { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	REVIEW_MODE,
	REVIEW_TRANSITION,
	ReviewTransactionStore,
	createReviewState,
	setReviewMutationLockPlatformForTesting,
	type ReviewBudgetV1,
} from "../lib/review-transaction.ts";
import { ordinaryValidatorRequest } from "../lib/review-policy-ordinary.ts";
import { domainHashV1 } from "../lib/review-canonical.ts";
import { resolveRepositoryAuthorityV1 } from "../lib/review-repository.ts";
import { REVIEW_LENS, REVIEW_ROUTE } from "../lib/review-triggers.ts";
import { qualifiedReviewLockPlatform, testSnapshot } from "./review-test-fixtures.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

setReviewMutationLockPlatformForTesting(qualifiedReviewLockPlatform());

interface ReviewToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
}

interface RegisteredReviewTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: readonly string[];
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ReviewToolResult>;
}

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

interface RuntimeRegistration {
	controller: RegisteredReviewTool;
	toolCall: ToolCallHandler;
}

interface RepositoryFixture {
	parent: string;
	repository: string;
	baseCommit: string;
	baseTree: string;
}

function budget(): ReviewBudgetV1 {
	return {
		review_batches: 1,
		review_actors: 1,
		refuter_batches: 1,
		fix_batches: 1,
		validator_runs: 1,
		final_verifications: 1,
		judgment_rounds: 0,
		judge_runs: 0,
	};
}

function registerRuntime(): RuntimeRegistration {
	const handlers = new Map<string, ToolCallHandler>();
	const tools = new Map<string, RegisteredReviewTool>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		registerTool(definition: RegisteredReviewTool) {
			tools.set(definition.name, definition);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const controller = tools.get("gentle_review");
	const toolCall = handlers.get("tool_call");
	assert.ok(controller, "the supported review controller tool must be registered");
	assert.ok(toolCall, "the lifecycle gate hook must be registered");
	return { controller, toolCall };
}

function extensionContext(
	repository: string,
	hasUI = false,
	confirm: (title: string, message: string) => Promise<boolean> = async () => true,
): ExtensionContext {
	return {
		cwd: repository,
		hasUI,
		ui: {
			confirm,
		},
	} as unknown as ExtensionContext;
}

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd: repository,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createRepository(t: test.TestContext): RepositoryFixture {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-review-controller-")));
	const repository = join(parent, "repo");
	mkdirSync(repository);
	t.after(() => rmSync(parent, { recursive: true, force: true }));
	git(repository, "init", "-b", "main");
	writeFileSync(join(repository, "app.ts"), "export const value = 1;\n");
	git(repository, "add", ".");
	git(
		repository,
		"-c",
		"user.name=Review Controller",
		"-c",
		"user.email=review-controller@example.invalid",
		"commit",
		"-m",
		"base",
	);
	const baseCommit = git(repository, "rev-parse", "HEAD");
	const baseTree = git(repository, "rev-parse", "HEAD^{tree}");
	git(repository, "branch", "base", baseCommit);
	writeFileSync(join(repository, "app.ts"), "export const value = 2;\n");
	return { parent, repository, baseCommit, baseTree };
}

function details(result: ReviewToolResult): Record<string, unknown> {
	assert.ok(result.details && typeof result.details === "object");
	return result.details as Record<string, unknown>;
}

async function controllerCall(
	controller: RegisteredReviewTool,
	ctx: ExtensionContext,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return details(await controller.execute("review-tool-call", params, undefined, undefined, ctx));
}

function createTerminalAuthority(fixture: RepositoryFixture, lineageId: string, completeTree: string): void {
	const store = ReviewTransactionStore.forRepository(fixture.repository, { mutationLockPlatform: qualifiedReviewLockPlatform() });
	store.create(
		createReviewState({
			lineageId,
			mode: REVIEW_MODE.ORDINARY,
			snapshot: testSnapshot({
				baseTree: fixture.baseTree,
				completeTree,
				genesisPaths: ["app.ts"],
				route: REVIEW_ROUTE.STANDARD,
				lenses: [REVIEW_LENS.READABILITY],
			}),
			evidenceHash: "c".repeat(64),
			budget: budget(),
		}),
		`${lineageId}-start`,
	);
	for (const [transition, input, suffix] of [
		[REVIEW_TRANSITION.ORDINARY_DISCOVERY, { rows: [] }, "discovery"],
		[REVIEW_TRANSITION.ORDINARY_EVIDENCE, { deterministicResults: [] }, "evidence"],
		[REVIEW_TRANSITION.ORDINARY_FINAL_VERIFICATION, { passed: true }, "verify"],
	] as const) {
		store.runReducerOperation({
			lineageId,
			transition,
			idempotencyKey: `${lineageId}-${suffix}`,
			input,
		});
	}
}

test("controller keeps graph-v1 ordinary mutation read-only while preserving repository-file input confinement", async (t) => {
	const fixture = createRepository(t);
	const lineageId = "controller-file-validator";
	const store = ReviewTransactionStore.forRepository(fixture.repository, { mutationLockPlatform: qualifiedReviewLockPlatform() });
	store.create(createReviewState({
		lineageId,
		mode: REVIEW_MODE.ORDINARY,
		snapshot: testSnapshot({
			baseTree: fixture.baseTree,
			completeTree: fixture.baseTree,
			route: REVIEW_ROUTE.STANDARD,
			lenses: [REVIEW_LENS.RISK],
		}),
		evidenceHash: "c".repeat(64),
		budget: budget(),
	}), "start");
	store.runReducerOperation({
		lineageId,
		transition: REVIEW_TRANSITION.ORDINARY_DISCOVERY,
		idempotencyKey: "freeze",
		input: { rows: [{
			id: "RISK-001",
			lens: REVIEW_LENS.RISK,
			location: "src/auth.ts:10",
			severity: "BLOCKER",
			status_at_freeze: "open",
			evidence_class: "deterministic",
			evidence_claim: "The access check is absent on the protected branch.",
		}] },
	});
	store.runReducerOperation({
		lineageId,
		transition: REVIEW_TRANSITION.ORDINARY_EVIDENCE,
		idempotencyKey: "evidence",
		input: { deterministicResults: [{ id: "RISK-001", outcome: "corroborated" }] },
	});
	store.runReducerOperation({
		lineageId,
		transition: REVIEW_TRANSITION.ORDINARY_FIX,
		idempotencyKey: "fix",
		input: { candidateTree: "d".repeat(40), fixedIds: ["RISK-001"], fixDiff: "diff --git a/src/auth.ts b/src/auth.ts\n", changedPaths: ["src/auth.ts"] },
	});
	const validatorInput = JSON.stringify({
		request: ordinaryValidatorRequest(store.read(lineageId), {
			originalAcceptanceTests: { passed: true, evidenceHash: "a".repeat(64) },
			correctionRegressions: [{ findingId: "RISK-001", evidenceHash: "b".repeat(64), passed: true }],
			originalCriterionRegressions: [],
			followUps: [],
		}),
		results: [{ id: "RISK-001", outcome: "verified" }],
	});
	const inputPath = join(fixture.repository, "validator-input.json");
	writeFileSync(inputPath, validatorInput);
	const { controller } = registerRuntime();
	const ctx = extensionContext(fixture.repository);

	writeFileSync(inputPath, JSON.stringify({ request: {}, results: [] }));
	await assert.rejects(
		controller.execute("modified-validator-input", { operation: "advance", lineageId, idempotencyKey: "modified", transition: REVIEW_TRANSITION.ORDINARY_VALIDATION, inputPath }, undefined, undefined, ctx),
		/graph-v1 ordinary.*read-only/i,
	);
	await assert.rejects(
		controller.execute("escaped-validator-input", { operation: "advance", lineageId, idempotencyKey: "escaped", transition: REVIEW_TRANSITION.ORDINARY_VALIDATION, inputPath: join(fixture.parent, "escaped.json") }, undefined, undefined, ctx),
		/repository/i,
	);
	await assert.rejects(
		controller.execute("ambiguous-validator-input", { operation: "advance", lineageId, idempotencyKey: "ambiguous", transition: REVIEW_TRANSITION.ORDINARY_VALIDATION, input: validatorInput, inputPath }, undefined, undefined, ctx),
		/exactly one/i,
	);
	const symlinkPath = join(fixture.repository, "validator-input-link.json");
	symlinkSync(inputPath, symlinkPath);
	await assert.rejects(
		controller.execute("symlink-validator-input", { operation: "advance", lineageId, idempotencyKey: "symlink", transition: REVIEW_TRANSITION.ORDINARY_VALIDATION, inputPath: symlinkPath }, undefined, undefined, ctx),
		/regular non-symlink/i,
	);

	writeFileSync(inputPath, validatorInput);
	await assert.rejects(
		controller.execute("valid-read-only-validator-input", { operation: "advance", lineageId, idempotencyKey: "validate", transition: REVIEW_TRANSITION.ORDINARY_VALIDATION, inputPath }, undefined, undefined, ctx),
		/graph-v1 ordinary.*read-only/i,
	);
});

test("controller rejects graph-style ADVANCE without graph-v1 authority", async (t) => {
	const fixture = createRepository(t);
	const lineageId = "controller-correction-evidence";
	const { controller } = registerRuntime();
	const ctx = extensionContext(fixture.repository);
	await controllerCall(controller, ctx, {
		operation: "start", lineageId, idempotencyKey: "start",
		input: JSON.stringify({ mode: REVIEW_MODE.ORDINARY, projection: { kind: "complete" }, policyHash: "a".repeat(64), evidenceHash: "b".repeat(64), budget: budget() }),
	});
	await assert.rejects(
		controller.execute("compact-advance", { operation: "advance", lineageId, idempotencyKey: "discover", transition: REVIEW_TRANSITION.ORDINARY_DISCOVERY, input: JSON.stringify({ rows: [] }) }, undefined, undefined, ctx),
		/CURRENT pointer has no valid quorum/i,
	);
});











test("controller successfully starts the explicitly supported judgment-day mode", async (t) => {
	const fixture = createRepository(t);
	const { controller } = registerRuntime();
	const started = await controllerCall(controller, extensionContext(fixture.repository), {
		operation: "start",
		lineageId: "judgment-day-start",
		idempotencyKey: "judgment-day-start-key",
		input: JSON.stringify({ mode: "judgment-day", projection: { kind: "complete" }, policyHash: "a".repeat(64), evidenceHash: "b".repeat(64), budget: budget() }),
	});
	assert.equal(started.operation, "start");
	assert.equal((started.state as Record<string, unknown>).mode, "judgment-day");
});

test("general STATUS returns the typed native-status-unsupported boundary without authority selection", () => {
	const result = __testing.nativeStatusUnsupported("status");
	assert.deepEqual(result, {
		operation: "status",
		status: "blocked",
		outcome: "native-status-unsupported",
		mutation_performed: false,
		inventory_complete: false,
		next_action: "require-upstream-read-only-native-status-inventory",
		remediation_command: "gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition",
		evidence: {
			native_contract: "gentle-ai/2.1.4",
			general_status: "unsupported",
			claimant_inventory: "unsupported",
		},
	});
});

test("gentle-pi#185: general STATUS on a non-negotiated native CLI names the exact status command to run", async (t) => {
	// The legacy `correctionForecast` restoration guard this issue originally
	// reported (extensions/gentle-ai.ts, then around line 5329) was scoped to
	// `targetStatus !== undefined` and skipped restoring a candidate view when
	// the native CLI lacked negotiated STATUS support, reproducing the #176
	// empty-registry failure. That entire manual FINALIZE lifecycle (and the
	// `correctionForecast` guard with it) has since been replaced by the
	// STATUS/capture-driven flow: every operation now checks negotiated STATUS
	// support up front, so no candidate-view restoration is ever attempted on
	// a non-negotiated CLI. This test proves the current equivalent boundary
	// (`nativeStatusUnsupported`) fails closed with an actionable envelope
	// instead of a bare machine token, so a non-negotiated CLI can never
	// surface as a silent empty-registry failure.
	const fixture = createRepository(t);
	const { controller } = registerRuntime();
	const result = await controllerCall(controller, extensionContext(fixture.repository), { operation: "status" });
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "native-status-unsupported");
	assert.equal(
		result.remediation_command,
		"gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition",
	);
});

test("failed START gives exact mode and serialization guidance and creates no lineage", async (t) => {
	const fixture = createRepository(t);
	const { controller } = registerRuntime();
	const ctx = extensionContext(fixture.repository);

	await assert.rejects(
		controller.execute("unsupported-start", {
			operation: "start",
			lineageId: "unsupported-start",
			idempotencyKey: "unsupported-start-key",
			input: JSON.stringify({ mode: "standard" }),
		}, undefined, undefined, ctx),
		/only "ordinary" or "judgment-day".*JSON string.*no lineage was created.*do not call STATUS or ADVANCE/is,
	);
	await assert.rejects(
		controller.execute("nested-start-input", {
			operation: "start",
			lineageId: "nested-start-input",
			idempotencyKey: "nested-start-input-key",
			input: { mode: "ordinary" },
		}, undefined, undefined, ctx),
		/START input must be a JSON string.*no lineage was created.*do not call STATUS or ADVANCE/is,
	);
	await assert.rejects(
		controller.execute("invalid-json-start-input", {
			operation: "start",
			lineageId: "invalid-json-start-input",
			idempotencyKey: "invalid-json-start-input-key",
			input: "{not-json}",
		}, undefined, undefined, ctx),
		/START input must be a JSON string encoding an object.*no lineage was created.*do not call STATUS or ADVANCE/is,
	);
	assert.equal(existsSync(join(fixture.repository, ".git", "gentle-ai", "reviews", "graph-v1")), false);
});


test("shipped controller fails closed while static prompts defer RDD lifecycle ownership to Gentle AI", () => {
	const { controller } = registerRuntime();
	const toolContract = [
		controller.description,
		controller.promptSnippet ?? "",
		...(controller.promptGuidelines ?? []),
		JSON.stringify(controller.parameters),
	].join("\n");

	assert.match(toolContract, /native-input-required.*never.*invent/is);
	assert.match(toolContract, /output.*lost|response.*lost|ambiguous.*START/is);
	assert.match(toolContract, /ambiguous START output.*target-scoped native status.*declared action.*ambiguous gentle_review_capture.*never replays/is);
	assert.doesNotMatch(toolContract, /START throws.*lineage does not exist/is);

	const boundary = "This package injects the mirrored provider-bundle review execution contract into this session's system prompt at start; Gentle AI writes nothing into the Pi system prompt, and this package owns everything else here. Absent that mirrored contract, this package invents no lifecycle instructions.";
	const core = readFileSync("assets/orchestrator.md", "utf8");
	assert.match(core, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	for (const path of ["assets/orchestrator-delegation.md", "skills/gentle-ai/SKILL.md"]) {
		const contract = readFileSync(path, "utf8");
		assert.doesNotMatch(contract, /INSPECT before START|start -> finalize -> validate|next_transition|review\.capture-result/is, path);
	}
	assert.match(readFileSync("skills/gentle-ai/SKILL.md", "utf8"), /sole lifecycle authority/i);
});
