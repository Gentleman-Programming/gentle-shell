import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createCoordinatorRuntime, type CoordinatorRuntimeOptions } from "./support/review-coordinator-runtime.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// odd/tasks/review-one-call.md T10: late review findings on the one-call run (S2, S5, S6).

let repo: string | undefined;
after(() => { if (repo !== undefined) rmSync(repo, { recursive: true, force: true }); });
function scratchRepo(): string {
	if (repo !== undefined) return repo;
	repo = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-one-call-followups-")));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "candidate.ts"), "export const value = 1;\n");
	writeFileSync(join(repo, "request.md"), "Fixture request context; not a real request.\n");
	return repo;
}

type Body = Record<string, any>;
const stepNames = (result: Body) => result.metrics.steps.map((step: { tool: string; operation?: string }) => step.operation === undefined ? step.tool : `${step.tool}:${step.operation}`);
const providerOperations = (calls: readonly string[]) => calls.filter((call) => !call.startsWith("status:"));

async function runOnce(options: CoordinatorRuntimeOptions, parameters?: Body) {
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", options);
	try {
		const result = await runtime.invoke("gentle_review_run", parameters ?? { lineageId: runtime.lineage });
		return { result, relayRuns: runtime.relayRuns(), closed: runtime.closed(), nativeCalls: [...runtime.nativeCalls] };
	} finally { runtime.close(); }
}

const FINDINGS = {
	statement: "Fixture advisory statement; not real review output.",
	findings: [{ id: "F1", lens: "review-risk", location: "candidate.ts:1", severity: "WARNING", disposition: "follow_up" }],
};
const reviewerResult = (findings: { id: string; claim: string }[]) => [{
	lens: "review-risk", evidence: ["fixture evidence; not real review output"], result_hash: `sha256:${"a".repeat(64)}`,
	findings: findings.map(({ id, claim }) => ({ id, lens: "risk", location: "candidate.ts:1", severity: "WARNING", claim, proof_refs: ["changed-hunk:candidate.ts:1"] })),
}];

function registeredRun() {
	const tools = new Map<string, { description: string; promptGuidelines: string[] }>();
	createGentleAiExtension({ nativeReviewCli: null, processEnv: {} })({ on() {}, registerCommand() {}, registerTool: (tool: never) => tools.set((tool as { name: string }).name, tool) } as never);
	return tools.get("gentle_review_run")!;
}

// Finding 1 (S2): the requested review intent survives the intended-untracked selection.
test("S2: selection-required carries resume_input, the run's own inputs to pass again with the chosen selection", async () => {
	const requestContextPath = join(scratchRepo(), "request.md");
	const input = { lenses: ["risk", "readability"], lensesReason: "fixture: touched the run's guards", requestContextPath };
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, scenario: "untracked-selection" });
	try {
		const run = await runtime.invoke("gentle_review_run", input);
		assert.equal(run.outcome, "selection-required", JSON.stringify(run));
		assert.deepEqual(run.resume_input, input);
		assert.deepEqual(stepNames(run), ["gentle_review:assess", "gentle_review:inspect"], "the run selects nothing and calls nothing more");
		assert.deepEqual(runtime.startRequests, []);
	} finally { runtime.close(); }
});

test("S2: gentle_review_run resumed with resume_input and the chosen selection sends the original lenses and request context to START", async () => {
	const requestContextPath = join(scratchRepo(), "request.md");
	const input = { lenses: ["risk", "readability"], lensesReason: "fixture: touched the run's guards", requestContextPath };
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, scenario: "untracked-selection" });
	try {
		const stopped = await runtime.invoke("gentle_review_run", input);
		assert.equal(stopped.outcome, "selection-required");
		const resumed = await runtime.invoke("gentle_review_run", { ...stopped.resume_input, untrackedScope: "exclude" });
		assert.deepEqual(stepNames(resumed), ["gentle_review:assess", "gentle_review:inspect", "gentle_review:start"], JSON.stringify(resumed));
		assert.equal(runtime.startRequests.length, 1);
		const start = runtime.startRequests[0]!;
		assert.deepEqual(start.lenses, ["review-risk", "review-readability"], JSON.stringify(start));
		assert.equal(start.lensesReason, input.lensesReason);
		assert.equal(start.requestContextPath, realpathSync(requestContextPath));
		assert.equal(start.untrackedScope, "exclude");
		assert.deepEqual(start.intendedUntracked, []);
	} finally { runtime.close(); }
});

const SELECTION_GUIDANCE = "On selection-required, the human or the parent chooses the intended untracked paths; resume gentle_review_run with its resume_input plus untrackedScope (\"exclude\", or \"select\" with intendedUntracked), so START keeps the requested lenses and request context.";

test("S2/S3: the run guidance resumes the run after a selection instead of a single operation that drops the requested intent", () => {
	const run = registeredRun();
	assert.ok(run.promptGuidelines.includes(SELECTION_GUIDANCE));
	const text = [run.description, ...run.promptGuidelines].join("\n");
	assert.equal(text.includes("the untracked selection through the operation its nextStep names"), false);
});

// Finding 2 (S5/S6): a cancellation that races with an approved capture keeps its findings.
test("S5/S6: cancelled right after the approved closure, the run returns cancelled with its findings and claims and dispatches nothing more", async () => {
	const claim = "Fixture reviewer claim for F1; not real review output.";
	const controller = new AbortController();
	const run = await runOnce({ hasUI: false, signal: controller.signal, onApproved: () => controller.abort(),
		advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim }]) });
	assert.equal(run.result.outcome, "cancelled", JSON.stringify(run.result));
	assert.deepEqual(run.result.advisory_findings, FINDINGS);
	assert.deepEqual(run.result.advisory_finding_claims, { F1: claim });
	assert.equal(run.result.result.outcome, "native-last-event-closure");
	assert.deepEqual(stepNames(run.result), ["gentle_review:status", "gentle_review_capture", "gentle_review_capture"], "no STATUS or acknowledgement after the cancellation");
	assert.equal(run.nativeCalls.includes("acknowledge"), false);
	assert.equal(run.nativeCalls.at(-1), "capture:recorded-output");
	assert.equal(run.closed, false);
});

test("S6: cancelled right after an approved closure without advisory_findings, the run still rejects with AbortError", async () => {
	const controller = new AbortController();
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, signal: controller.signal, onApproved: () => controller.abort() });
	try {
		await assert.rejects(runtime.invoke("gentle_review_run", { lineageId: runtime.lineage }), { name: "AbortError" });
		assert.equal(runtime.nativeCalls.at(-1), "capture:recorded-output");
		assert.equal(runtime.closed(), false);
	} finally { runtime.close(); }
});

// Finding 3 (S5): a cut claim and a claim left out by the per-closure limit are named.
test("S5: a claim cut at 1,024 bytes is listed in advisory_finding_claims_truncated; a whole claim is not", async () => {
	const claim = "é".repeat(600) + "TAIL";
	const cut = await runOnce({ advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim }]) });
	assert.equal(cut.result.outcome, "closed", JSON.stringify(cut.result));
	assert.ok(claim.startsWith(cut.result.advisory_finding_claims.F1), "the kept text is a prefix of the reviewer's claim");
	assert.deepEqual(cut.result.advisory_finding_claims_truncated, ["F1"]);
	assert.equal(Object.hasOwn(cut.result, "advisory_finding_claims_omitted"), false);
	assert.deepEqual(cut.result.advisory_findings, FINDINGS, "advisory_findings stays unchanged");
	const whole = await runOnce({ advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim: "x".repeat(1024) }]) });
	assert.equal(whole.result.advisory_finding_claims.F1, "x".repeat(1024));
	assert.equal(Object.hasOwn(whole.result, "advisory_finding_claims_truncated"), false);
	assert.equal(Object.hasOwn(whole.result, "advisory_finding_claims_omitted"), false);
});

test("S5: claims left out by the 8,192-byte closure limit are listed in advisory_finding_claims_omitted, in advisory_findings order", async () => {
	const ids = Array.from({ length: 12 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`);
	const many = { ...FINDINGS, findings: ids.map((id) => ({ id, lens: "review-risk", location: "candidate.ts:1", severity: "WARNING", disposition: "follow_up" })) };
	const claims = ids.map((id, index) => ({ id, claim: index === 9 ? "short" : `${id}:`.padEnd(1000, "x") }));
	// F12 has no reviewer finding, so it has no claim to leave out.
	const run = await runOnce({ advisoryFindings: structuredClone(many), reviewerResults: reviewerResult(claims.slice(0, 11)) });
	assert.equal(run.result.outcome, "closed", JSON.stringify(run.result));
	assert.deepEqual(Object.keys(run.result.advisory_finding_claims), ids.slice(0, 8));
	assert.deepEqual(run.result.advisory_finding_claims_omitted, ids.slice(8, 11));
	assert.equal(Object.hasOwn(run.result, "advisory_finding_claims_truncated"), false);
	assert.deepEqual(run.result.advisory_findings, many, "advisory_findings stays unchanged");
});

// Finding 4 (S2): an older provider's self-contained role vector returns the role artifact.
test("S2: after a reconciled lens group, a captured provider-role artifact continues through bound STATUS to the acknowledgement", async () => {
	const run = await runOnce({ hasUI: false, scenario: "provider-role" });
	assert.equal(run.result.outcome, "closed", JSON.stringify(run.result));
	assert.ok(run.closed);
	assert.deepEqual(providerOperations(run.nativeCalls), ["capture-result:review-risk", "capture-result:review-reliability", "capture-provider-role", "acknowledge"]);
	assert.deepEqual(stepNames(run.result), [
		"gentle_review:status",
		"gentle_review_capture_group", "gentle_review_capture_group",
		"gentle_review:status",
		"gentle_review_capture",
		"gentle_review:status",
		"gentle_review:acknowledge-approved",
	]);
	assert.equal(run.result.result.delivery, "ordinary-repository-policy");
});

const CANCELLED_GUIDANCE = "On cancelled, the run stopped after an approved closure: relay its advisory_findings and claims as on closed; resuming with lineageId reaches the acknowledgement without them.";
const CLAIM_MARKS_GUIDANCE = "advisory_finding_claims_truncated lists the ids whose claim is cut at 1,024 UTF-8 bytes and advisory_finding_claims_omitted the ids whose claim the 8,192-byte limit left out; say so when relaying them.";

test("S5/S6: the run names cancelled and the claim marks in its description and guidance", () => {
	const run = registeredRun();
	assert.match(run.description, /(^|[ (,])cancelled([ ),.]|$)/);
	assert.match(run.description, /resume_input/);
	assert.ok(run.promptGuidelines.includes(CANCELLED_GUIDANCE));
	assert.ok(run.promptGuidelines.includes(CLAIM_MARKS_GUIDANCE));
});

// Verifier observations on T10: each result names only its own state and path.
const closedOrAcknowledged = (value: unknown, path = "result"): string[] => {
	if (typeof value === "string") return /^(closed|acknowledged|burned)$/.test(value) ? [`${path}=${value}`] : [];
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, entry]) => [...(/acknowledged|^closed$/.test(key) ? [`${path}.${key}`] : []), ...closedOrAcknowledged(entry, `${path}.${key}`)]);
};

test("S5/S6: a cancelled result says nothing is closed or acknowledged, keeps the findings, and a resume by lineageId acknowledges", async () => {
	const controller = new AbortController();
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, signal: controller.signal, onApproved: () => controller.abort(),
		advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim: "x".repeat(1100) }]) });
	try {
		const cancelled = await runtime.invoke("gentle_review_run", { lineageId: runtime.lineage });
		assert.equal(cancelled.outcome, "cancelled", JSON.stringify(cancelled));
		assert.deepEqual(closedOrAcknowledged(cancelled), [], JSON.stringify(cancelled));
		for (const key of ["status", "state"]) {
			assert.equal(Object.hasOwn(cancelled.result, key), false, key);
			assert.equal(Object.hasOwn(cancelled.result.closure, key), false, `closure.${key}`);
		}
		assert.deepEqual(cancelled.advisory_findings, FINDINGS);
		assert.deepEqual(cancelled.advisory_finding_claims, { F1: "x".repeat(1024) });
		assert.deepEqual(cancelled.advisory_finding_claims_truncated, ["F1"]);
		assert.equal(cancelled.lineage_id, runtime.lineage);
		assert.equal(runtime.closed(), false);
		// The resume runs under a new, live signal.
		const resumed = await runtime.invoke("gentle_review_run", { lineageId: cancelled.lineage_id }, new AbortController().signal);
		assert.equal(resumed.outcome, "closed", JSON.stringify(resumed));
		assert.ok(runtime.closed());
		assert.equal(resumed.result.delivery, "ordinary-repository-policy");
	} finally { runtime.close(); }
});

test("S2: a selection-required result names only the resume path; the single inspect still carries its nextStep", async () => {
	const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, scenario: "untracked-selection" });
	try {
		const input = { lenses: ["risk"], lensesReason: "fixture" };
		const run = await runtime.invoke("gentle_review_run", input);
		assert.equal(run.outcome, "selection-required", JSON.stringify(run));
		assert.equal(Object.hasOwn(run.result, "nextStep"), false, "the facade's single-operation nextStep is not relayed");
		assert.doesNotMatch(JSON.stringify(run), /select-intended-untracked/);
		assert.deepEqual(run.resume_input, input);
		// The eligible paths the choice is made from stay in the provider's selection binding.
		assert.match(run.result.selectionBinding, /eligible_paths_json/);
		const inspect = await runtime.invoke("gentle_review", { operation: "inspect" });
		assert.equal(typeof inspect.selectionBinding, "string");
		assert.match(inspect.nextStep, /select-intended-untracked/, "the single operation's own result is unchanged");
	} finally { runtime.close(); }
});

test("S5: a cut at 1,024 bytes never splits a 4-byte character and is marked only when it cuts", async () => {
	const emoji = "\u{1F600}";
	for (const [label, claim, keptBytes, marked] of [
		["a*1022 + emoji + t", "a".repeat(1022) + emoji + "t", 1022, true],
		["a*1020 + emoji", "a".repeat(1020) + emoji, 1024, false],
		["emoji*300", emoji.repeat(300), 1024, true],
	] as const) {
		const run = await runOnce({ advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim }]) });
		assert.equal(run.result.outcome, "closed", label);
		const kept: string = run.result.advisory_finding_claims.F1;
		assert.equal(Buffer.byteLength(kept), keptBytes, label);
		assert.ok(kept.isWellFormed(), `${label}: no lone surrogate`);
		assert.ok(claim.startsWith(kept), `${label}: a prefix of the reviewer's claim`);
		assert.equal(Object.hasOwn(run.result, "advisory_finding_claims_truncated"), marked, label);
		if (marked) assert.deepEqual(run.result.advisory_finding_claims_truncated, ["F1"], label);
	}
});

// PR #3144 review: once an approved closure with findings is retained, a later
// abort before the acknowledgement still returns them (through the tool).
test("S5/S6: an abort while the STATUS after the approved closure is in flight returns cancelled with the findings, and a resume acknowledges", async () => {
	for (const [label, rejects] of [["STATUS returns", false], ["STATUS rejects because of the abort", true]] as const) {
		const controller = new AbortController();
		const runtime = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, signal: controller.signal,
			advisoryFindings: structuredClone(FINDINGS), reviewerResults: reviewerResult([{ id: "F1", claim: "x".repeat(1100) }]),
			onStatus: (state) => {
				if (state !== "approved" || controller.signal.aborted) return;
				controller.abort();
				if (rejects) throw Object.assign(new Error("fixture STATUS aborted"), { name: "AbortError" });
			} });
		try {
			const cancelled = await runtime.invoke("gentle_review_run", { lineageId: runtime.lineage });
			assert.equal(cancelled.outcome, "cancelled", `${label}: ${JSON.stringify(cancelled)}`);
			assert.deepEqual(closedOrAcknowledged(cancelled), [], label);
			for (const key of ["status", "state"]) assert.equal(Object.hasOwn(cancelled.result, key), false, `${label}: ${key}`);
			assert.deepEqual(cancelled.advisory_findings, FINDINGS, label);
			assert.deepEqual(cancelled.advisory_finding_claims, { F1: "x".repeat(1024) }, label);
			assert.deepEqual(cancelled.advisory_finding_claims_truncated, ["F1"], label);
			assert.equal(cancelled.lineage_id, runtime.lineage, label);
			assert.equal(runtime.nativeCalls.includes("acknowledge"), false, label);
			assert.equal(runtime.nativeCalls.at(-1), "status:approved", `${label}: nothing after the STATUS`);
			const resumed = await runtime.invoke("gentle_review_run", { lineageId: cancelled.lineage_id }, new AbortController().signal);
			assert.equal(resumed.outcome, "closed", `${label}: ${JSON.stringify(resumed)}`);
			assert.ok(runtime.closed(), label);
		} finally { runtime.close(); }
	}
});

test("S6: after the approved closure, a STATUS failure that is not an abort is blocked; without findings an abort during that STATUS still throws", async () => {
	const failing = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, advisoryFindings: structuredClone(FINDINGS),
		onStatus: (state) => { if (state === "approved") throw new Error("fixture STATUS failure"); } });
	try {
		const run = await failing.invoke("gentle_review_run", { lineageId: failing.lineage });
		assert.equal(run.outcome, "blocked", JSON.stringify(run));
		assert.equal(failing.nativeCalls.includes("acknowledge"), false);
	} finally { failing.close(); }
	const controller = new AbortController();
	const bare = createCoordinatorRuntime(scratchRepo(), "coordinator", { hasUI: false, signal: controller.signal,
		onStatus: (state) => { if (state === "approved") controller.abort(); } });
	try {
		await assert.rejects(bare.invoke("gentle_review_run", { lineageId: bare.lineage }), { name: "AbortError" });
		assert.equal(bare.nativeCalls.includes("acknowledge"), false);
	} finally { bare.close(); }
});

// PR #3144 review: resume_input names the workspace the selection was offered for.
test("S2: with workspaceRoot omitted, resume_input carries the INSPECT's resolved workspace_root and the resume STARTs there from a moved session", async (t) => {
	const root = scratchRepo();
	const sub = join(root, "nested");
	mkdirSync(sub, { recursive: true });
	const elsewhere = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-one-call-elsewhere-")));
	t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: elsewhere });
	const input = { lenses: ["risk"], lensesReason: "fixture: touched the run's guards" };
	const runtime = createCoordinatorRuntime(root, "coordinator", { hasUI: false, scenario: "untracked-selection", sessionCwd: sub });
	try {
		const stopped = await runtime.invoke("gentle_review_run", input);
		assert.equal(stopped.outcome, "selection-required", JSON.stringify(stopped));
		assert.equal(stopped.result.workspace_root, root);
		assert.deepEqual(stopped.resume_input, { ...input, workspaceRoot: root });
		runtime.moveSession(elsewhere);
		await runtime.invoke("gentle_review_run", { ...stopped.resume_input, untrackedScope: "exclude" });
		assert.equal(runtime.startRequests.length, 1);
		assert.equal(runtime.startRequests[0]!.cwd, root, "START targets the workspace the selection was offered for");
	} finally { runtime.close(); }
});
