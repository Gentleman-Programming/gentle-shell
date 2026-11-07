import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NativeReviewIntegrationError, NativeReviewCliError, NATIVE_REVIEW_ERROR_CODE, NATIVE_REVIEW_OPERATION, NATIVE_REQUEST_CONTEXT_UNSUPPORTED_MESSAGE, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { ReviewContinuationRegistry } from "../lib/review-continuation-registry.ts";
import { prepareBoundSessionRepository } from "../lib/bounded-writer-admission.ts";
import { decodeReviewFailureV2, type AuthorityRepairAssessmentV1, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";

interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ details?: unknown }>;
}

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<unknown>;

interface Runtime {
	controller: RegisteredTool;
	toolCall: ToolCallHandler;
	lifecycle(name: string, event: unknown, ctx: ExtensionContext): Promise<void>;
}

function runtime(
	nativeReviewCli: NativeReviewCli | null,
	candidateViews: CandidateViewRegistry | null = null,
): Runtime {
	const tools = new Map<string, RegisteredTool>();
	let toolCall: ToolCallHandler | undefined;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const dependencies = { nativeReviewCli, candidateViews, processEnv: { GENTLE_PI_AGENTS_CHILD: "0" } } as unknown as Parameters<typeof createGentleAiExtension>[0];
	createGentleAiExtension(dependencies)({
		on(name: string, handler: ToolCallHandler) {
			if (name === "tool_call") toolCall = handler;
			handlers.set(name, handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown);
		},
		registerTool(definition: RegisteredTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	assert.ok(toolCall);
	return { controller, toolCall, async lifecycle(name, event, ctx) { await handlers.get(name)?.(event, ctx); } };
}

function context(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext;
}

test("repository preparation retains capture routes in the session registry used by later STATUS", async t => {
	const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-preparation-registry-")));
	const cwd = join(fixture, "project");
	mkdirSync(cwd);
	const homes = { HOME: join(fixture, "home"), USERPROFILE: join(fixture, "home"), GENTLE_PI_AGENT_HOME: join(fixture, "agents"), PI_CODING_AGENT_DIR: join(fixture, "agents"), GENTLE_PI_CONFIG_HOME: join(fixture, "config"), GENTLE_PI_GENTLE_AI_DEV_BINARY: "" };
	for (const path of new Set(Object.values(homes).filter(Boolean))) mkdirSync(path, { recursive: true });
	const previous = Object.fromEntries(Object.keys(homes).map(key => [key, process.env[key]]));
	Object.assign(process.env, homes);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(fixture, { recursive: true, force: true });
	});
	const reads: Array<{ owner: ReviewContinuationRegistry; found: boolean }> = [];
	const read = ReviewContinuationRegistry.prototype.readCapture;
	t.mock.method(ReviewContinuationRegistry.prototype, "readCapture", function(this: ReviewContinuationRegistry, binding: string) {
		const value = read.call(this, binding);
		reads.push({ owner: this, found: value !== undefined });
		return value;
	});
	const status = targetStatusFixture({ authorityState: "correction_required" });
	const input = { name: "correction_plan", schema: "https://gentle-ai.dev/schema/review/correction-plan/v1", captureOperation: "review.capture-correction-plan", arguments: [{ name: "lineage", value: "native-lineage", token: "--lineage=native-lineage" }, { name: "target", value: status.targetIdentity, token: `--target=${status.targetIdentity}` }] };
	status.nextTransition = { kind: "collect", reasonCode: "correction_plan_required", collect: { inputs: [input] } };
	status.raw = { ...status.raw, next_transition: { kind: "collect", reason_code: "correction_plan_required" } };
	const emptyConfig = join(fixture, "empty.gitconfig");
	writeFileSync(emptyConfig, "");
	const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))), GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1" };
	const native = fakeNative({
		reviewMode: async () => ({ operation: "status", scope: "global", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } }),
		targetStatus: async () => {
			if (!existsSync(join(cwd, ".git"))) execFileSync("git", ["init", "--quiet", cwd], { env: gitEnv, windowsHide: true });
			return status;
		},
	});
	const h = runtime(native);
	const manager = { getSessionId: () => "preparation-registry", getCwd: () => cwd, getEntries: () => [], getBranch: () => [] };
	const session = { ...context(cwd), sessionManager: manager } as unknown as ExtensionContext;
	try {
		await h.lifecycle("session_start", { reason: "startup" }, session);
		assert.equal(reads.length, 0);
		assert.equal(await prepareBoundSessionRepository(manager, cwd), true);
		assert.ok(reads.length > 0, "native preparation must actually retain capture routing");
		const prepared = reads[0].owner;
		const beforeStatus = reads.length;
		await h.controller.execute("after-preparation", { operation: "status", lineageId: "native-lineage" }, undefined, undefined, session);
		assert.ok(reads.length > beforeStatus);
		assert.equal(reads[beforeStatus].owner, prepared, "later STATUS must reuse the preparation registry");
		assert.equal(reads[beforeStatus].found, true, "preparation routing must still exist before STATUS refreshes it");
	} finally { await h.lifecycle("session_shutdown", { reason: "quit" }, session); }
});

function repository(t: test.TestContext, prefix = "gentle-pi-workspace-root-"): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	t.after(() => {
		if (process.platform !== "win32") {
			try { execFileSync("chmod", ["-R", "u+w", cwd], { stdio: "ignore" }); } catch { /* best effort */ }
		}
		rmSync(cwd, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Workspace Test", "-c", "user.email=workspace@example.invalid", "commit", "-m", "initial"], { cwd });
	return cwd;
}

for (const operation of ["inspect", "start"] as const) {
	for (const mode of ["on", "off", "unknown", "missing", "malformed", "throws"] as const) {
		test(`non-Git ${operation} requires validated RDD on: ${mode}`, async () => {
			const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-bootstrap-target-")));
			writeFileSync(join(cwd, "candidate.txt"), "unchanged candidate\n");
			const requests: string[] = [];
			const native = fakeNative({
				reviewMode: mode === "missing" ? undefined : (async () => {
					if (mode === "throws") throw new Error("mode unavailable");
					return { operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: mode === "malformed" ? "on" : mode, source: mode === "malformed" ? "invalid" : "global" } };
				}) as NonNullable<NativeReviewCli["reviewMode"]>,
				targetStatus: async (request) => {
					requests.push(request.cwd);
					// Stop at entry: this contract does not exercise START or consent.
					throw new Error("native preparation reached");
				},
			});
			for (const explicit of [false, true]) {
				requests.length = 0;
				const result = await __testing.executeReviewControllerOperation({
					operation, ...(explicit ? { workspaceRoot: cwd } : {}),
					...(operation === "start" ? { input: JSON.stringify({ mode: "ordinary" }) } : {}),
				}, explicit ? process.cwd() : cwd, native);
				assert.equal(result.status, "blocked");
				assert.deepEqual(requests, mode === "on" ? [cwd] : []);
			}
			assert.equal(readFileSync(join(cwd, "candidate.txt"), "utf8"), "unchanged candidate\n");
		});
	}
}

for (const operation of ["inspect", "start"] as const) {
	for (const transition of ["shutdown", "replacement", "same-manager-rebind", "changed-id", "cancelled", "live"] as const) {
		test(`explicit non-Git ${operation} pins lifecycle across held mode: ${transition}`, async t => {
			const fixture = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-explicit-lifecycle-")));
			const home = join(fixture, "home");
			const project = join(fixture, "project");
			mkdirSync(home); mkdirSync(project);
			writeFileSync(join(project, "candidate.txt"), "unchanged candidate\n");
			const previous = { HOME: process.env.HOME, GENTLE_PI_AGENT_HOME: process.env.GENTLE_PI_AGENT_HOME, GENTLE_PI_CONFIG_HOME: process.env.GENTLE_PI_CONFIG_HOME };
			Object.assign(process.env, { HOME: home, GENTLE_PI_AGENT_HOME: join(fixture, "agent"), GENTLE_PI_CONFIG_HOME: join(fixture, "config") });
			t.after(() => {
				for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
				rmSync(fixture, { recursive: true, force: true });
			});
			let entered!: () => void;
			const modeEntered = new Promise<void>(resolve => { entered = resolve; });
			let release!: () => void;
			const heldMode = new Promise<void>(resolve => { release = resolve; });
			let hold = false;
			let statuses = 0;
			let starts = 0;
			const native = fakeNative({
				reviewMode: async () => {
					if (hold) { entered(); await heldMode; }
					return { operation: "status", scope: "global", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } };
				},
				targetStatus: async request => {
					statuses++;
					assert.equal(request.cwd, project);
					// Only the fake provider mutates this disposable project. Stop before consent/START.
					execFileSync("git", ["init", "--quiet", project]);
					throw new Error("fixture preparation completed");
				},
				start: async () => { starts++; throw new Error("unexpected START"); },
			});
			const h = runtime(native);
			const session = { ...context(home), sessionManager: { getSessionId: () => "same-id", getCwd: () => home, getEntries: () => [], getBranch: () => [] } } as unknown as ExtensionContext;
			await h.lifecycle("session_start", { reason: "startup" }, session);
			assert.equal(statuses, 0);
			hold = true;
			const abort = new AbortController();
			const pending = h.controller.execute("held-explicit", { operation, workspaceRoot: project, ...(operation === "start" ? { input: JSON.stringify({ mode: "ordinary" }) } : {}) }, abort.signal, undefined, session);
			// Observe rejection immediately, so a revoked call cannot become unhandled.
			const settled = pending.then(result => ({ result }), error => ({ error }));
			await modeEntered;
			if (transition === "shutdown") await h.lifecycle("session_shutdown", { reason: "quit" }, session);
			if (transition === "replacement") {
				const successor = { ...session, sessionManager: { getSessionId: () => "same-id", getCwd: () => home, getEntries: () => [], getBranch: () => [] } } as unknown as ExtensionContext;
				assert.notEqual(successor.sessionManager, session.sessionManager);
				await h.lifecycle("session_start", { reason: "new" }, successor);
			}
			if (transition === "same-manager-rebind") await h.lifecycle("session_start", { reason: "reload" }, session);
			if (transition === "changed-id") session.sessionManager.getSessionId = () => "changed-id";
			if (transition === "cancelled") abort.abort();
			release();
			await settled;
			assert.equal(abort.signal.aborted, transition === "cancelled", "lifecycle revocation is independent of caller abort");
			assert.equal(statuses, transition === "live" ? 1 : 0, "revoked original context cannot reach native bootstrap STATUS");
			assert.equal(starts, 0);
			assert.equal(existsSync(join(project, ".git")), transition === "live");
			assert.equal(existsSync(join(home, ".git")), false, "explicit selection never initializes HOME");
			assert.equal(readFileSync(join(project, "candidate.txt"), "utf8"), "unchanged candidate\n");
			await h.lifecycle("session_shutdown", { reason: "quit" }, session);
		});
	}
}

test("invalid bootstrap target selectors reject before native STATUS", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-bootstrap-invalid-")));
	let statusCalls = 0;
	const native = fakeNative({
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } }),
		targetStatus: async () => { statusCalls += 1; throw new Error("must not reach STATUS"); },
	});
	for (const parameters of [
		{ operation: "inspect", input: JSON.stringify({ baseRef: "HEAD" }) },
		{ operation: "inspect", input: JSON.stringify({ baseRef: "missing-ref", committedOnly: true }) },
		{ operation: "start", input: JSON.stringify({ mode: "ordinary", focus: "invalid" }) },
		{ operation: "start", input: JSON.stringify({ mode: "ordinary", policyPath: "../outside" }) },
	]) {
		const result = await __testing.executeReviewControllerOperation(parameters, cwd, native);
		assert.equal(result.status, "blocked");
	}
	for (const workspaceRoot of ["relative", join(cwd, "missing")]) {
		await assert.rejects(__testing.executeReviewControllerOperation({ operation: "inspect", workspaceRoot }, cwd, native));
	}
	assert.equal(statusCalls, 0);
});

test("START forwards the agent lens selection in canonical order and rejects malformed selections before native STATUS", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	const startRequests: Parameters<NativeReviewCli["start"]>[0][] = [];
	const { controller } = runtime(fakeNative({
		start: async (request) => {
			startRequests.push(request);
			return { lineageId: "lens-selection-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-risk", "review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true };
		},
	}));
	const started = await controller.execute("start-lenses", { operation: "start", input: JSON.stringify({ mode: "ordinary", lenses: ["reliability", "review-risk"], lensesReason: "changes token parsing" }) }, undefined, undefined, context(cwd));
	assert.notEqual((started.details as { status?: string }).status, "blocked");
	assert.equal(startRequests.length, 1);
	assert.deepEqual(startRequests[0]?.lenses, ["review-risk", "review-reliability"]);
	assert.equal(startRequests[0]?.lensesReason, "changes token parsing");

	let statusCalls = 0;
	const native = fakeNative({
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "on", cloneLocal: "", effective: "on", source: "global" } }),
		targetStatus: async () => { statusCalls += 1; throw new Error("must not reach STATUS"); },
		start: async () => { throw new Error("must not reach START"); },
	});
	for (const input of [
		{ mode: "ordinary", lenses: ["risk"] },
		{ mode: "ordinary", lensesReason: "why" },
		{ mode: "ordinary", lenses: [], lensesReason: "why" },
		{ mode: "ordinary", lenses: "risk", lensesReason: "why" },
		{ mode: "ordinary", lenses: ["security"], lensesReason: "why" },
		{ mode: "ordinary", lenses: ["risk", "review-risk"], lensesReason: "why" },
		{ mode: "ordinary", lenses: ["risk"], lensesReason: " " },
		{ mode: "ordinary", lenses: ["risk"], lensesReason: "x".repeat(501) },
		{ mode: "ordinary", lenses: ["risk"], lensesReason: "why", focus: "risk" },
	]) {
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify(input) }, cwd, native);
		assert.equal(result.status, "blocked", JSON.stringify(input));
		assert.equal(result.reason, "lenses-invalid", JSON.stringify(input));
		assert.equal(result.outcome, "native-start-input-invalid", JSON.stringify(input));
	}
	assert.equal(statusCalls, 0);
});

test("START resolves an explicit request file against the selected workspace", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	writeFileSync(join(cwd, "spec with spaces.md"), "Requested behavior");
	const starts: Parameters<NativeReviewCli["start"]>[0][] = [];
	const { controller } = runtime(fakeNative({ start: async request => {
		starts.push(request);
		return { lineageId: "intent-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-risk"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true };
	} }));
	await controller.execute("request-start", { operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath: "spec with spaces.md" }) }, undefined, undefined, context(cwd));
	assert.equal(starts.length, 1);
	assert.equal(starts[0].requestContextPath, join(cwd, "spec with spaces.md"));
	for (const requestContextPath of [42, "", " spaced ", "nul\0path"]) {
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath }) }, cwd, fakeNative());
		assert.equal(result.reason, "request-context-invalid");
	}
});

test("START with explicit intent never silently adopts existing authority", async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "new-spec.md"), "Requested behavior");
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath: "new-spec.md" }) }, cwd, fakeNative({
		targetStatus: async () => targetStatusFixture(),
		start: async () => { throw new Error("existing intent must not be replaced"); },
	}));
	assert.equal(result.reason, "request-context-requires-fresh-review");
	assert.equal(result.mutation_performed, false);
});

test("request context rejects missing paths and dangling directory aliases before native lookup", async t => {
 const cwd = repository(t);
 symlinkSync(join(cwd, "missing"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
 let calls = 0;
 const native = fakeNative({ targetStatus: async () => { calls++; throw new Error("unresolved path reached native"); } });
 for (const requestContextPath of ["missing.md", "alias/request.md"]) {
  const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath }) }, cwd, native);
  assert.equal(result.reason, "request-context-unresolved-path");
  assert.equal(result.next_action, "supply-an-existing-resolvable-requestContextPath");
 }
 assert.equal(calls, 0);
});

test("request context expands home paths and forwards the canonical external file", async t => {
 const cwd = repository(t);
 const external = mkdtempSync(join(homedir(), "request-context-test-"));
 t.after(() => rmSync(external, { recursive: true, force: true }));
 const path = join(external, "spec.md"); writeFileSync(path, "Requested behavior");
 symlinkSync(external, join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
 const starts: string[] = [];
 const native = fakeNative({ targetStatus: async request => { starts.push(request.requestContextPath!); throw new Error("canonical path observed; stop before START"); } });
 const relativeHomePath = path.slice(homedir().length + 1).replaceAll("\\", "/");
 for (const requestContextPath of ["alias/spec.md", "~/" + relativeHomePath, ...(process.platform === "win32" ? ["~\\" + relativeHomePath.replaceAll("/", "\\")] : [])]) {
  await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath }) }, cwd, native);
 }
 assert.equal(starts.length, process.platform === "win32" ? 3 : 2);
 assert.ok(starts.every(value => value === realpathSync(path)));
});

test("repository discovery ignores ambient Git root overrides", async (t) => {
	const sessionRoot = repository(t);
	const targetRoot = repository(t, "gentle-pi-isolated-target-");
	const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	process.env.GIT_DIR = join(sessionRoot, ".git");
	process.env.GIT_WORK_TREE = sessionRoot;
	const requests: string[] = [];
	await __testing.executeReviewControllerOperation({ operation: "inspect", workspaceRoot: targetRoot }, sessionRoot,
		fakeNative({ targetStatus: async (request) => { requests.push(request.cwd); throw new Error("entry only"); } }));
	assert.deepEqual(requests, [targetRoot]);
});

test("non-Git bound and maintenance routes cannot use preparation entry", async () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-bootstrap-bound-")));
	let statusCalls = 0;
	const native = fakeNative({ targetStatus: async () => { statusCalls += 1; throw new Error("must not reach STATUS"); } });
	for (const parameters of [
		{ operation: "status" },
		{ operation: "inspect", lineageId: "bound" },
		{ operation: "start", input: JSON.stringify({ mode: "judgment-day" }) },
		{ operation: "reset", input: "{}" },
	]) await assert.rejects(__testing.executeReviewControllerOperation(parameters, cwd, native));
	assert.equal(statusCalls, 0);
});

function addWorktree(t: test.TestContext, cwd: string, branch: string): string {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-workspace-worktrees-")));
	t.after(() => {
		try { execFileSync("git", ["worktree", "remove", "--force", join(parent, branch)], { cwd }); } catch {}
		rmSync(parent, { recursive: true, force: true });
	});
	const worktree = join(parent, branch);
	execFileSync("git", ["worktree", "add", "-b", branch, worktree], { cwd });
	return worktree;
}

function fakeNative(overrides: Partial<NativeReviewCli> = {}): NativeReviewCli {
	return {
		start: async () => ({ lineageId: "native-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 2, changedLines: 7, correctionBudget: 4, action: "created", lensesRequired: true }),
		reviewStatus: async () => ({ schema: "gentle-ai.review-authority-status/v1", repository: "/repo", complete: true, authoritative: true, status: "clean", entries: [], locks: [], diagnostics: [], raw: { schema: "gentle-ai.review-authority-status/v1", operation: "review/status", repository: "/repo", complete: true, authoritative: true, status: "clean", entries: [], locks: [], diagnostics: [] } }),
		targetStatus: async (request) => request.lineageId === undefined
			? candidateStartTargetStatus(request)
			: candidateTargetStatus(request, request.lineageId),
		...overrides,
	};
}

const UNSUPPORTED_REPAIR_ASSESSMENT: AuthorityRepairAssessmentV1 = {
	schema: "gentle-ai.review-authority-repair-assessment/v1",
	status: "unsupported",
	counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 },
	supportedOperations: ["review/complete-fix", "review/validate-fix"],
	authorizationSchema: "gentle-ai.review-repair-authorization/v1",
};

function targetStatusFixture(options: {
	applicability?: "current_target" | "unrelated";
	action?: ReviewStatusV3["action"];
	lineageId?: string;
	authorityState?: NonNullable<ReviewStatusV3["authority"]>["state"];
	baseTree?: string;
	currentCandidateTree?: string;
	paths?: readonly string[];
	intendedUntracked?: readonly string[];
} = {}): ReviewStatusV3 {
	const applicability = options.applicability ?? "current_target";
	const action = options.action ?? (applicability === "current_target" ? "stop" : "start");	const lineageId = options.lineageId ?? "native-lineage";
	const authorityState = options.authorityState ?? "reviewing";
	const sha = `sha256:${"a".repeat(64)}`;
	const tree = options.currentCandidateTree ?? "b".repeat(40);
	const baseTree = options.baseTree ?? tree;
	const paths = options.paths ?? ["app.ts"];
	const intendedUntracked = options.intendedUntracked ?? [];
	const projection = {
		schema: "gentle-ai.review-integration.projection/v1" as const,
		kind: "current-changes" as const,
		projection: "workspace" as const,
		baseTree,
		initialReviewTree: tree,
		currentCandidateTree: tree,
		pathsDigest: sha,
		paths,
		intendedUntracked,
		intendedUntrackedProof: sha,
		initialSnapshotIdentity: sha,
		currentSnapshotIdentity: sha,
	};
	const rawRepair = {
		schema: UNSUPPORTED_REPAIR_ASSESSMENT.schema,
		status: UNSUPPORTED_REPAIR_ASSESSMENT.status,
		counts: {
			lineages: 0, compact_lineages: 0, legacy_lineages: 0, events: 0, bytes: 0,
			eligible_candidates: 0, unsupported_lineages: 0, conflicts: 0,
		},
		supported_operations: UNSUPPORTED_REPAIR_ASSESSMENT.supportedOperations,
		authorization_schema: UNSUPPORTED_REPAIR_ASSESSMENT.authorizationSchema,
	};
	const raw: Record<string, unknown> = {
		schema: "gentle-ai.review-integration.status/v3",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.status",
		applicability,
		receipt: { status: applicability === "current_target" ? "expected_missing" : "not_applicable" },
		action,
		replayability: "not_replayable",
		target_identity: sha,
		repair: rawRepair,
		projection: {
			schema: projection.schema,
			kind: projection.kind,
			projection: projection.projection,
			base_tree: baseTree,
			initial_review_tree: tree,
			current_candidate_tree: tree,
			paths_digest: sha,
			paths,
			intended_untracked: intendedUntracked,
			intended_untracked_proof: sha,
			initial_snapshot_identity: sha,
			current_snapshot_identity: sha,
		},
		candidates: [],
	};
	if (applicability === "current_target") {
		raw.authority = { version: "compact-v2", lineage_id: lineageId, state: authorityState, generation: 1, revision: sha };
		raw.frozen = { tier: "medium", original_changed_lines: 2, correction_budget: 1 };
	}
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability,
		...(applicability === "current_target" ? { authority: { version: "compact-v2" as const, lineageId, state: authorityState, generation: 1, revision: sha } } : {}),
		receipt: { status: applicability === "current_target" ? "expected_missing" : "not_applicable" },
		action,
		replayability: "not_replayable",
		...(applicability === "current_target" ? { frozen: { tier: "medium" as const, originalChangedLines: 2, correctionBudget: 1 } } : {}),
		targetIdentity: sha,
		projection,
		repair: UNSUPPORTED_REPAIR_ASSESSMENT,
		candidates: [],
		raw,
	};
}

function candidateStartTargetStatus(request: Parameters<NonNullable<NativeReviewCli["targetStatus"]>>[0]): ReviewStatusV3 {
	let candidate: ReturnType<CandidateViewRegistry["create"]> | undefined;
	try {
		candidate = new CandidateViewRegistry().create({
			contributorRoot: request.cwd,
			...(request.baseRef === undefined ? {} : { baseRef: request.baseRef, committedOnly: true }),
			...(request.intendedUntracked === undefined ? {} : { intendedUntracked: request.intendedUntracked }),
		});
		return targetStatusFixture({
			applicability: "unrelated",
			action: "start",
			baseTree: candidate.baseTree,
			currentCandidateTree: candidate.candidateTree,
			paths: candidate.paths,
			intendedUntracked: request.intendedUntracked,
		});
	} finally {
		candidate?.cleanup();
	}
}

function candidateTargetStatus(request: Parameters<NonNullable<NativeReviewCli["targetStatus"]>>[0], lineageId: string): ReviewStatusV3 {
	let candidate: ReturnType<CandidateViewRegistry["create"]> | undefined;
	try {
		candidate = new CandidateViewRegistry().create({ contributorRoot: request.cwd });
		return targetStatusFixture({
			lineageId,
			baseTree: candidate.baseTree,
			currentCandidateTree: candidate.candidateTree,
			paths: candidate.paths,
		});
	} finally {
		candidate?.cleanup();
	}
}

test("INSPECT and STATUS operate on the explicit workspace root while the session cwd stays elsewhere", async (t) => {
	const sessionCwd = repository(t);
	const worktree = addWorktree(t, sessionCwd, "feat-binding");
	const observedCwds: string[] = [];
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => {
			observedCwds.push(request.cwd);
			return targetStatusFixture();
		},
	}));
	await controller.execute("inspect-b", { operation: "inspect", workspaceRoot: worktree }, undefined, undefined, context(sessionCwd));
	await controller.execute("status-b", { operation: "status", lineageId: "native-lineage", workspaceRoot: worktree }, undefined, undefined, context(sessionCwd));
	await controller.execute("inspect-default", { operation: "inspect" }, undefined, undefined, context(sessionCwd));
	assert.deepEqual(observedCwds, [realpathSync(worktree), realpathSync(worktree), sessionCwd]);
});

// gentle-pi#599: inspect without an explicit workspaceRoot against a parent
// repository that wraps an untracked nested Git repository fails at the
// native preflight with a decoded, actionable `invalid_request` envelope. The
// facade used to discard that envelope's cause, code, retry_safe, and
// next_action in favor of a generic `native-status-unavailable` outcome
// indistinguishable from authority corruption. It must preserve the native
// envelope instead.
test("inspect without workspaceRoot preserves the native invalid_request cause for a nested foreign Git repository", async (t) => {
	const sessionCwd = repository(t);
	const { controller } = runtime(fakeNative({
		targetStatus: async () => {
			throw new NativeReviewIntegrationError(decodeReviewFailureV2({
				schema: "gentle-ai.review-integration.failure/v2",
				contract: "gentle-ai.review-integration/v2",
				operation: "review.status",
				phase: "preflight",
				code: "invalid_request",
				message: "The negotiated review request is invalid.",
				mutation_outcome: "not_started",
				authority_applicability: "not_evaluated",
				retry_safe: true,
				replayability: "not_replayable",
				required_inputs: [],
				next_action: "correct_request",
				cause: "untracked directory \"engram\" holds another Git repository that is not a linked worktree of this one, so it cannot enter the review candidate: add it to .gitignore, move it outside this repository, or register it as a linked worktree",
			}));
		},
	}));
	const result = await controller.execute("inspect-nested-foreign-repo", { operation: "inspect" }, undefined, undefined, context(sessionCwd));
	const details = result.details as {
		status?: string;
		outcome?: string;
		next_action?: string;
		native_failure?: { code?: string; cause?: string; retry_safe?: boolean };
	};
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-status-unavailable");
	assert.equal(details.native_failure?.code, "invalid_request");
	assert.equal(details.native_failure?.retry_safe, true);
	assert.match(details.native_failure?.cause ?? "", /engram/);
	assert.equal(details.next_action, "correct_request");
});

// gentle-shell#213: the host-side 30 s budget on a read-only STATUS/inspect
// read used to dead-end in the corrupt-authority outcome with no runnable
// step. A read-only inventory timeout names the read-only command to rerun.
function hostStatusTimeout(): NativeReviewCliError {
	return new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.TIMEOUT, NATIVE_REVIEW_OPERATION.STATUS, true, false, "native process timed out", {
		operation: NATIVE_REVIEW_OPERATION.STATUS, error_code: NATIVE_REVIEW_ERROR_CODE.TIMEOUT, timed_out: true, output_limit_exceeded: false,
	});
}

for (const operation of ["status", "inspect"] as const) test(`a host timeout on read-only ${operation} returns a rerunnable status command`, async (t) => {
	const sessionCwd = repository(t);
	let calls = 0;
	const { controller } = runtime(fakeNative({ targetStatus: async () => { calls++; throw hostStatusTimeout(); } }));
	const result = await controller.execute(`timeout-${operation}`, { operation }, undefined, undefined, context(sessionCwd));
	const details = result.details as Record<string, unknown>;
	assert.equal(calls, 1);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-status-timed-out");
	assert.equal(details.inventory_complete, false);
	assert.equal(details.mutation_performed, false);
	assert.equal(details.mutation_outcome, "none");
	assert.equal(details.next_action, "rerun-native-status");
	assert.equal(details.remediation_command, "gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition");
	assert.equal((details.diagnostics as Record<string, unknown>)?.timed_out, true);
	const blocker = details.blocker as Record<string, unknown>;
	assert.equal(blocker.category, "provider-unavailable");
	assert.equal(blocker.actor, "user");
	assert.equal(blocker.automatic_retry, false);
	assert.equal(blocker.next_step, "The read-only review inventory read timed out before it completed. Nothing was mutated; rerun the returned remediation_command when ready. Pi does not retry automatically.");
});

test("a host timeout on the STATUS read behind a recovery authorization keeps the inventory-unavailable outcome", () => {
	for (const operation of ["recover", "repair", "start"] as const) {
		const result = __testing.nativeStatusFailed(operation, hostStatusTimeout());
		assert.equal(result.outcome, "native-status-unavailable");
		assert.equal(result.next_action, "require-complete-native-authority-inventory");
		assert.equal("remediation_command" in result, false);
	}
	assert.deepEqual(__testing.nativeStatusFailed("recover", hostStatusTimeout()), {
		operation: "recover", status: "blocked", outcome: "native-status-unavailable",
		lineage_created: false, mutation_performed: false, mutation_outcome: "none",
		diagnostics: { operation: NATIVE_REVIEW_OPERATION.STATUS, error_code: NATIVE_REVIEW_ERROR_CODE.TIMEOUT, timed_out: true, output_limit_exceeded: false },
		inventory_complete: false, next_action: "require-complete-native-authority-inventory",
	});
});

test("corrupt-authority STATUS failures keep the inventory-unavailable outcome", () => {
	for (const code of [NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE, NATIVE_REVIEW_ERROR_CODE.NON_ZERO]) {
		const result = __testing.nativeStatusFailed("status", new NativeReviewCliError(code, NATIVE_REVIEW_OPERATION.STATUS, true, false, "corrupt"));
		assert.equal(result.outcome, "native-status-unavailable");
		assert.equal(result.next_action, "require-complete-native-authority-inventory");
		assert.equal("remediation_command" in result, false);
	}
	assert.deepEqual(__testing.nativeStatusFailed("status", new Error("opaque")), {
		operation: "status", status: "blocked", outcome: "native-status-unavailable",
		lineage_created: false, mutation_performed: false, mutation_outcome: "none",
		inventory_complete: false, next_action: "require-complete-native-authority-inventory",
	});
});

for (const operation of ["status", "inspect"] as const) test(`a native ${operation} timeout envelope is forwarded as-is and read once`, async (t) => {
	const sessionCwd = repository(t);
	let calls = 0;
	const { controller } = runtime(fakeNative({
		targetStatus: async () => {
			calls++;
			throw new NativeReviewIntegrationError(decodeReviewFailureV2({
				schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2",
				operation: "review.status", phase: "native_running", code: "timeout", message: "The review status read timed out.",
				mutation_outcome: "not_started", authority_applicability: "not_evaluated", retry_safe: true,
				replayability: "not_replayable", required_inputs: [], next_action: "retry",
			}));
		},
	}));
	const result = await controller.execute(`native-timeout-${operation}`, { operation }, undefined, undefined, context(sessionCwd));
	const details = result.details as Record<string, unknown>;
	assert.equal(calls, 1);
	assert.equal(details.outcome, operation === "inspect" ? "native-status-unavailable" : undefined);
	assert.equal(details.next_action, "retry");
	assert.equal((details.native_failure as Record<string, unknown>)?.retry_safe, true);
	assert.equal((details.native_failure as Record<string, unknown>)?.code, "timeout");
	assert.equal("remediation_command" in details, false);
});

test("START freezes the candidate from the explicit workspace root and returns the actor binding envelope", async (t) => {
	const sessionCwd = repository(t);
	writeFileSync(join(sessionCwd, "unrelated.ts"), "export const unrelated = true;\n");
	const worktree = addWorktree(t, sessionCwd, "feat-candidate");
	writeFileSync(join(worktree, "app.ts"), "export const value = 2; // worktree candidate\n");
	const candidateViews = new CandidateViewRegistry();
	const startRequests: Parameters<NativeReviewCli["start"]>[0][] = [];
	const { controller, toolCall } = runtime(fakeNative({
		start: async (request) => {
			startRequests.push(request);
			return { lineageId: "worktree-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true };
		},
	}), candidateViews);
	const started = await controller.execute("start-b", { operation: "start", workspaceRoot: worktree, input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context(sessionCwd));
	const details = started.details as {
		workspace_root: string;
		actor_binding: { workspace_root: string; candidate_root: string; candidate_tree: string; candidate_paths: readonly string[] };
	};
	const root = realpathSync(worktree);
	assert.equal(details.workspace_root, root);
	assert.equal(details.actor_binding.workspace_root, root);
	assert.deepEqual(details.actor_binding.candidate_paths, ["app.ts"]);
	const view = candidateViews.resolveForLens("worktree-lineage", "review-reliability");
	assert.equal(details.actor_binding.candidate_root, view.root);
	assert.equal(details.actor_binding.candidate_tree, view.candidateTree);
	assert.deepEqual(startRequests, [{ cwd: root, targetIdentity: `sha256:${"a".repeat(64)}`, projection: "workspace" }]);
	assert.notEqual(startRequests[0]?.cwd, view.root);
	assert.equal(readFileSync(join(view.root, "app.ts"), "utf8"), "export const value = 2; // worktree candidate\n");
	assert.equal(view.paths.includes("unrelated.ts"), false);
	const dispatch = { agent: "review-reliability", task: "review the change", mode: "task" };
	assert.equal(await toolCall({ toolName: "subagent_run", input: dispatch }, context(sessionCwd)), undefined);
	assert.match(dispatch.task, /Controller-owned review lineage: `worktree-lineage`/);
	assert.ok(dispatch.task.includes(view.root));
	assert.ok(dispatch.task.includes(view.candidateTree));
	candidateViews.cleanup(view.token);
});

test("an omitted workspaceRoot canonicalizes a nested same-worktree session before supported operations", async (t) => {
	const root = repository(t);
	const sessionCwd = join(root, "nested");
	mkdirSync(sessionCwd);
	writeFileSync(join(root, "app.ts"), "export const value = 3;\n");
	const candidateViews = new CandidateViewRegistry();
	const targetStatusCwds: string[] = [];
	const startRequests: Parameters<NativeReviewCli["start"]>[0][] = [];
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => { targetStatusCwds.push(request.cwd); return request.lineageId === undefined ? candidateStartTargetStatus(request) : candidateTargetStatus(request, request.lineageId); },
		start: async (request) => {
			startRequests.push(request);
			return { lineageId: "session-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true };
		},
	}), candidateViews);
	const ctx = context(sessionCwd);
	await controller.execute("inspect-session", { operation: "inspect" }, undefined, undefined, ctx);
	const started = await controller.execute("start-session", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, ctx);
	const status = await controller.execute("status-session", { operation: "status", lineageId: "session-lineage" }, undefined, undefined, ctx);
	const details = started.details as { workspace_root: string; actor_binding: { workspace_root: string; candidate_root: string; candidate_paths: readonly string[] } };
	assert.equal(details.workspace_root, root);
	assert.equal(details.actor_binding.workspace_root, root);
	assert.equal((status.details as { workspace_root: string }).workspace_root, root);
	assert.deepEqual(details.actor_binding.candidate_paths, ["app.ts"]);
	assert.deepEqual(startRequests, [{ cwd: root, targetIdentity: `sha256:${"a".repeat(64)}`, projection: "workspace" }]);
	const view = candidateViews.resolveForLens("session-lineage", "review-reliability");
	assert.equal(details.actor_binding.candidate_root, view.root);
	assert.ok(targetStatusCwds.every((cwd) => cwd === root), JSON.stringify(targetStatusCwds));
	candidateViews.cleanup(view.token);
});

test("an explicit nested foreign workspace root canonically owns inspect, status, and START", async (t) => {
	const sessionCwd = repository(t, "gentle-pi-session-a-");
	const target = repository(t, "gentle-pi-target-b-");
	const nested = join(target, "nested");
	mkdirSync(nested);
	writeFileSync(join(target, "app.ts"), "export const value = 2; // target B\n");
	const root = realpathSync(target);
	const targetStatusCwds: string[] = [];
	const targetStatusRequests: Parameters<NonNullable<NativeReviewCli["targetStatus"]>>[0][] = [];
	const startCwds: string[] = [];
	const candidateViews = new CandidateViewRegistry();
	let initialCrossRootStatus = true;
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => {
			targetStatusCwds.push(request.cwd);
			targetStatusRequests.push(request);
			if (request.lineageId === "cross-root-lineage" && initialCrossRootStatus) {
				initialCrossRootStatus = false;
				return request.untrackedScope === "select"
					? targetStatusFixture({ lineageId: request.lineageId, authorityState: "correction_required" })
					: targetStatusFixture({ applicability: "unrelated", action: "start" });
			}
			return request.lineageId === undefined
				? candidateStartTargetStatus(request)
				: candidateTargetStatus(request, request.lineageId);
		},
		start: async (request) => {
			startCwds.push(request.cwd);
			return { lineageId: "cross-root-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true };
		},
	}), candidateViews);

	const digest = `sha256:${"b".repeat(64)}`;
	const intendedUntracked = ["selected-b.ts", "selected-a.ts"];
	const inspect = await controller.execute("inspect-target-b", { operation: "inspect", workspaceRoot: nested }, undefined, undefined, context(sessionCwd));
	const status = await controller.execute("status-target-b", { operation: "status", lineageId: "cross-root-lineage", workspaceRoot: nested, input: JSON.stringify({ untrackedScope: "select", expectedUntrackedInventory: digest, intendedUntracked }) }, undefined, undefined, context(sessionCwd));
	const started = await controller.execute("start-target-b", { operation: "start", workspaceRoot: nested, input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context(sessionCwd));

	for (const result of [inspect, status, started]) {
		assert.equal((result.details as { workspace_root?: string }).workspace_root, root);
	}
	const statusDetails = status.details as { status?: string; result?: { authority?: { state?: string } } };
	assert.equal(statusDetails.status, "blocked");
	assert.equal(statusDetails.result?.authority?.state, "correction_required");
	assert.deepEqual(targetStatusRequests[1], { cwd: root, lineageId: "cross-root-lineage", untrackedScope: "select", expectedUntrackedInventory: digest, intendedUntracked, agent: "pi" });
	assert.ok(targetStatusCwds.every((cwd) => cwd === root), JSON.stringify(targetStatusCwds));
	assert.deepEqual(startCwds, [root]);
	candidateViews.cleanup(candidateViews.resolveForLens("cross-root-lineage", "review-reliability").token);
});


test("STATUS relays exclude selection and rejects malformed input before native status", async (t) => {
	const cwd = repository(t);
	const requests: Parameters<NonNullable<NativeReviewCli["targetStatus"]>>[0][] = [];
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => {
			requests.push(request);
			return targetStatusFixture({ lineageId: request.lineageId });
		},
	}));
	const digest = `sha256:${"c".repeat(64)}`;
	const excluded = await controller.execute("status-exclude", { operation: "status", lineageId: "excluded-lineage", input: JSON.stringify({ untrackedScope: "exclude", expectedUntrackedInventory: digest, intendedUntracked: [] }) }, undefined, undefined, context(cwd));
	assert.equal((excluded.details as { status?: string }).status, "blocked");
	assert.deepEqual(requests, [{ cwd, lineageId: "excluded-lineage", untrackedScope: "exclude", expectedUntrackedInventory: digest, intendedUntracked: [], agent: "pi" }]);

	for (const [input, reason] of [
		[{}, "untracked-selection-invalid"],
		[{ untrackedScope: "select", expectedUntrackedInventory: digest, intendedUntracked: [] }, "untracked-selection-invalid"],
		[{ untrackedScope: "select" }, "untracked-selection-invalid"],
		[{ untrackedScope: "exclude", expectedUntrackedInventory: digest, intendedUntracked: [], unexpected: true }, "unknown-field"],
	] as const) {
		const rejected = await controller.execute("status-invalid", { operation: "status", input: JSON.stringify(input) }, undefined, undefined, context(cwd));
		assert.equal((rejected.details as { reason?: string }).reason, reason);
	}
	assert.equal(requests.length, 1);
});

test("an explicit foreign workspace root works when the Pi session cwd is not a Git repository", async (t) => {
	const target = repository(t, "gentle-pi-target-b-non-git-session-");
	const nested = join(target, "nested");
	mkdirSync(nested);
	const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-non-git-session-")));
	t.after(() => rmSync(nonGit, { recursive: true, force: true }));
	const observed: string[] = [];
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => {
			observed.push(request.cwd);
			return targetStatusFixture();
		},
	}));
	const result = await controller.execute("inspect-target-from-non-git", { operation: "inspect", workspaceRoot: nested }, undefined, undefined, context(nonGit));
	assert.equal((result.details as { workspace_root?: string }).workspace_root, realpathSync(target));
	assert.deepEqual(observed, [realpathSync(target)]);
});

test("omitted workspaceRoot fails closed for the same lineage bound to two target repositories", async (t) => {
	const rootA = repository(t, "gentle-pi-ambiguous-a-");
	const rootB = repository(t, "gentle-pi-ambiguous-b-");
	const candidateViews = new CandidateViewRegistry();
	const viewA = candidateViews.create({ contributorRoot: rootA });
	const viewB = candidateViews.create({ contributorRoot: rootB });
	candidateViews.bindCurrent({ token: viewA.token, lineageId: "shared-lineage", selectedLenses: ["review-reliability"] });
	candidateViews.bindCurrent({ token: viewB.token, lineageId: "shared-lineage", selectedLenses: ["review-reliability"] });
	let nativeCalls = 0;
	const { controller } = runtime(fakeNative({
		targetStatus: async (request) => {
			nativeCalls += 1;
			return targetStatusFixture({ lineageId: request.lineageId });
		},
	}), candidateViews);
	await assert.rejects(
		controller.execute("ambiguous-omission", { operation: "status", lineageId: "shared-lineage" }, undefined, undefined, context(rootA)),
		/workspaceRoot/,
	);
	assert.equal(nativeCalls, 0);
	const explicit = await controller.execute("explicit-b", { operation: "status", lineageId: "shared-lineage", workspaceRoot: rootB }, undefined, undefined, context(rootA));
	assert.equal((explicit.details as { workspace_root?: string }).workspace_root, realpathSync(rootB));
	assert.equal(nativeCalls, 1);
	candidateViews.cleanupTerminal("shared-lineage", "approved", rootA);
	candidateViews.cleanupTerminal("shared-lineage", "approved", rootB);
});

test("workspaceRoot fails closed before any native call for invalid target paths", async (t) => {
	const sessionCwd = repository(t);
	const worktree = addWorktree(t, sessionCwd, "feat-guard");
	const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-non-git-")));
	t.after(() => rmSync(nonGit, { recursive: true, force: true }));
	const filePath = join(worktree, "app.ts");
	let nativeCalls = 0;
	const counting = fakeNative({
		start: async () => { nativeCalls += 1; throw new Error("native start must not run"); },
		targetStatus: async () => { nativeCalls += 1; throw new Error("native status must not run"); },
		reviewStatus: async () => { nativeCalls += 1; throw new Error("native review status must not run"); },
	});
	const { controller } = runtime(counting);
	const rejected: Array<{ label: string; workspaceRoot: string }> = [
		{ label: "missing directory", workspaceRoot: join(nonGit, "missing") },
		{ label: "file path", workspaceRoot: filePath },
		{ label: "relative path", workspaceRoot: "relative/worktree" },
	];
	for (const { label, workspaceRoot } of rejected) {
		for (const operation of ["inspect", "start", "status"] as const) {
			await assert.rejects(
				controller.execute(`${operation}-${label}`, {
					operation,
					...(operation === "start" ? { input: JSON.stringify({ mode: "ordinary" }) } : {}),
					...(operation === "status" ? { lineageId: "native-lineage" } : {}),
					workspaceRoot,
				}, undefined, undefined, context(sessionCwd)),
				/workspaceRoot/,
				`${operation} must fail closed for ${label}`,
			);
		}
	}
	for (const operation of ["inspect", "start"] as const) {
		const result = await controller.execute(`non-git-${operation}`, {
			operation, workspaceRoot: nonGit,
			...(operation === "start" ? { input: JSON.stringify({ mode: "ordinary" }) } : {}),
		}, undefined, undefined, context(sessionCwd));
		assert.equal((result.details as Record<string, unknown>).outcome, "native-repository-bootstrap-not-authorized");
	}
	await assert.rejects(controller.execute("non-git-bound", { operation: "status", workspaceRoot: nonGit, lineageId: "bound" }, undefined, undefined, context(sessionCwd)), /workspaceRoot/);
	assert.equal(nativeCalls, 0);
});

function providerRoleBinding(lineageId: string) {
	return {
		name: "provider_targeted_validator",
		schema: "https://gentle-ai.dev/schema/review/targeted-validator/v1",
		captureOperation: "review.capture-validation",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: `sha256:${"a".repeat(64)}`, token: `--target=sha256:${"a".repeat(64)}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "execute", value: "true", token: "--execute=true" },
		],
	};
}

test("same-session START binding migrates to one validation capture without a FINALIZE operation", async (t) => {
	const sessionCwd = repository(t);
	const worktree = addWorktree(t, sessionCwd, "feat-last-event");
	writeFileSync(join(worktree, "app.ts"), "export const value = 2;\n");
	const candidateViews = new CandidateViewRegistry();
	const lineageId = "workspace-last-event";
	const binding = providerRoleBinding(lineageId);
	let captureCalls = 0;
	const native = fakeNative({
		targetStatus: async (request) => request.lineageId === undefined
			? candidateStartTargetStatus(request)
			: ({ ...candidateTargetStatus(request, lineageId), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [binding] } } } as unknown as ReviewStatusV3),
		start: async () => ({ lineageId, state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: true }),
		captureProviderRole: async (request) => {
			captureCalls += 1;
			assert.equal(request.captureOperation, "review.capture-validation");
			return { schema: "gentle-ai.review-last-event-closure/v1", operation: "review/capture-validation", lineageId, state: "approved", storeRevision: `sha256:${"a".repeat(64)}` };
		},
	});
	const { controller } = runtime(native, candidateViews);
	await controller.execute("start", { operation: "start", workspaceRoot: worktree, input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context(sessionCwd));
	const captured = await __testing.executeReviewCaptureOperation({ lineageId, workspaceRoot: worktree, collectBinding: JSON.stringify(binding) }, sessionCwd, native, undefined, candidateViews);
	assert.equal(captured.outcome, "native-last-event-closure");
	assert.equal(captured.status, "closed");
	assert.equal(captureCalls, 1);
	candidateViews.cleanupTerminal(lineageId, "approved", realpathSync(worktree));
});

test("an explicit linked-worktree root owns STATUS collect capture over the session candidate root", async (t) => {
	const sessionCwd = repository(t);
	const worktree = addWorktree(t, sessionCwd, "feat-explicit-capture");
	const lineageId = "explicit-worktree-capture";
	const binding = providerRoleBinding(lineageId);
	const observedRoots: string[] = [];
	const native = {
		targetStatus: async (request: { cwd: string }) => {
			observedRoots.push(request.cwd);
			return { ...targetStatusFixture({ lineageId }), nextTransition: { kind: "collect", reasonCode: "provider_role_required", collect: { inputs: [binding] } } } as unknown as ReviewStatusV3;
		},
		captureProviderRole: async () => ({ schema: "gentle-ai.review-last-event-closure/v1", operation: "review.capture-validation", lineageId, state: "approved", storeRevision: `sha256:${"a".repeat(64)}` }),
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewCaptureOperation({ lineageId, workspaceRoot: worktree, collectBinding: JSON.stringify(binding) }, sessionCwd, native);
	assert.equal(result.outcome, "native-last-event-closure");
	assert.deepEqual(observedRoots, [realpathSync(worktree)]);
});

test("request-context capability refusal remains clear in the public facade", async (t) => {
 const cwd = repository(t);
 writeFileSync(join(cwd, "spec.md"), "Requested behavior");
 const error = new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE, NATIVE_REVIEW_OPERATION.STATUS, false, false, NATIVE_REQUEST_CONTEXT_UNSUPPORTED_MESSAGE);
 const native = fakeNative({ targetStatus: async () => { throw error; } });
 for (const operation of ["inspect", "start"] as const) {
  const result = await __testing.executeReviewControllerOperation({ operation, ...(operation === "start" ? { input: JSON.stringify({ mode: "ordinary", requestContextPath: "spec.md" }) } : {}) }, cwd, native);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, NATIVE_REQUEST_CONTEXT_UNSUPPORTED_MESSAGE);
  assert.equal(result.mutation_performed, false);
 }
});

test("request context applies sensitive-path policy before any native lookup", async () => {
 let calls = 0;
 const native = fakeNative({ targetStatus: async () => { calls++; throw new Error("must not read sensitive paths"); } });
 for (const path of [".envrc", ".netrc", "~\\.netrc", ".env", ".env.local", ".ssh/id_rsa", "secrets/request.md", "C:/private/KEY.PEM", "docs/../.env", "secrets\\request.md"]) {
  const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath: path }) }, process.cwd(), native);
  assert.equal(result.reason, "request-context-sensitive-path", path);
  assert.equal(result.mutation_performed, false);
 }
 assert.equal(calls, 0);
});

test("request context rejects a harmless alias resolving into a sensitive directory", async (t) => {
 const cwd = repository(t); mkdirSync(join(cwd, "secrets")); writeFileSync(join(cwd, "secrets", "request.md"), "private fixture");
 symlinkSync(join(cwd, "secrets"), join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
 let calls = 0;
 const native = fakeNative({ targetStatus: async () => { calls++; throw new Error("must not read aliased secrets"); } });
 const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", requestContextPath: "alias/request.md" }) }, cwd, native);
 assert.equal(result.reason, "request-context-sensitive-path"); assert.equal(calls, 0);
});
