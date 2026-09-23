import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../../extensions/gentle-ai.ts";
import { CandidateViewRegistry } from "../../lib/review-candidate-view.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NativeReviewCliError,
	NativeReviewCliV216,
	NativeReviewConsentRequiredError,
	createNodeExecFileAdapter,
	type ExecFileAdapter,
} from "../../lib/native-review-cli.ts";
import type { ReviewStatusV3 } from "../../lib/review-integration-v2.ts";
import { requireDevBinary } from "../support/native-binary-gate.ts";

// Organic RDD Parity: candidate-bound dev-binary journeys.
//
// This suite runs only via `pnpm run test:dev-binary` and only when
// GENTLE_AI_DEV_BINARY names a current, absolute candidate binary. Every START
// first obtains candidate-bound STATUS and executes the returned transition;
// consent answers replay the envelope's own invocation exactly once.
const DEV_BINARY = process.env.GENTLE_AI_DEV_BINARY;
const devBinaryGate = requireDevBinary({
	devBinaryPath: DEV_BINARY,
	exists: typeof DEV_BINARY === "string" && DEV_BINARY.length > 0 && DEV_BINARY.startsWith("/") && existsSync(DEV_BINARY),
	env: process.env,
});
if (!devBinaryGate.run) console.log(`tests/devbinary/native-review-parity.devtest.ts: ${devBinaryGate.reason}`);
const RUNNABLE = devBinaryGate.run;
const DEV_HOME = mkdtempSync(join(tmpdir(), "gentle-pi-dev-binary-home-"));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

type NativeCall = readonly string[];

function bridgeAdapter(binary: string, calls: NativeCall[]): ExecFileAdapter {
	const real = createNodeExecFileAdapter();
	return async (request) => {
		calls.push([...request.arguments]);
		return real({ ...request, file: binary });
	};
}

function selectedStatusFieldNames(stdout: string): string {
	try {
		const status = JSON.parse(stdout) as Record<string, unknown>;
		const projection = status.projection as Record<string, unknown> | undefined;
		const transition = status.next_transition as Record<string, unknown> | undefined;
		const execute = transition?.execute as Record<string, unknown> | undefined;
		const argument = Array.isArray(execute?.arguments) ? execute.arguments[0] as Record<string, unknown> | undefined : undefined;
		const names = (prefix: string, value?: Record<string, unknown>) => value === undefined ? [] : Object.keys(value).sort().map((key) => `${prefix}.${key}`);
		return [...names("status", status), ...names("status.projection", projection), ...names("status.next_transition", transition), ...names("status.next_transition.execute", execute), ...names("status.next_transition.execute.arguments[]", argument)].join(", ");
	} catch {
		return "status JSON";
	}
}

function controllerResultStructure(result: Record<string, unknown>): string {
	const diagnostics = typeof result.diagnostics === "object" && result.diagnostics !== null && !Array.isArray(result.diagnostics)
		? result.diagnostics as Record<string, unknown>
		: undefined;
	const safeCode = (name: string, value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value) ? `${name}=${value}` : undefined;
	const safeBooleanNames = ["candidate_view_created", "candidate_view_pre_native", "native_invocation_attempted", "lineage_created", "mutation_performed", "reset_eligible"];
	return [
		`keys=[${Object.keys(result).sort().join(",")}]`,
		...(diagnostics === undefined ? [] : [`diagnostics.keys=[${Object.keys(diagnostics).sort().join(",")}]`]),
		safeCode("operation", result.operation), safeCode("status", result.status), safeCode("outcome", result.outcome), safeCode("reason", result.reason),
		safeCode("diagnostics.error_code", diagnostics?.error_code), safeCode("diagnostics.code", diagnostics?.code), safeCode("diagnostics.reason", diagnostics?.reason),
		...safeBooleanNames.flatMap((name) => typeof result[name] === "boolean" ? [`${name}=${String(result[name])}`] : []),
	].filter((value): value is string => value !== undefined).join("; ");
}

function journeyNative(binary: string): { native: NativeReviewCliV216; calls: NativeCall[] } {
	const calls: NativeCall[] = [];
	return { native: new NativeReviewCliV216(bridgeAdapter(binary, calls), binary), calls };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-dev-binary-"));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", cwd]); } catch { /* best effort */ }
		rmSync(cwd, { recursive: true, force: true });
	});
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.email", "devbinary@example.com");
	git(cwd, "config", "user.name", "Dev Binary Journey");
	return cwd;
}

function enableGlobalReview(cwd: string): void {
	assert.ok(DEV_BINARY, "GENTLE_AI_DEV_BINARY is required for this devtest");
	const enabled = JSON.parse(execFileSync(DEV_BINARY, [
		"review", "mode", "enable", "--scope", "global", "--cwd", cwd, "--json",
	], { encoding: "utf8" })) as { status: { effective: string } };
	assert.equal(enabled.status.effective, "on");
	const status = JSON.parse(execFileSync(DEV_BINARY, [
		"review", "mode", "status", "--cwd", cwd, "--json",
	], { encoding: "utf8" })) as { status: { effective: string } };
	assert.equal(status.status.effective, "on");
}

async function enableReview(native: NativeReviewCliV216, cwd: string): Promise<void> {
	enableGlobalReview(cwd);
	const disabled = await native.reviewMode({ cwd, operation: "disable" });
	assert.equal(disabled.status.effective, "off");
	assert.equal(disabled.status.source, "clone_local");
	const enabled = await native.reviewMode({ cwd, operation: "enable" });
	assert.equal(enabled.status.effective, "on");
	assert.equal(enabled.status.source, "global");
}

async function candidateConsent(native: NativeReviewCliV216, cwd: string) {
	const status = await native.targetStatus({ cwd, agent: "pi" });
	assert.equal(status.nextTransition?.kind, "execute");
	assert.equal(status.nextTransition?.execute?.operation, "review.start");
	try {
		await native.start({ cwd });
		assert.fail("candidate START must return consent/v3 before review authority exists");
	} catch (error) {
		assert.ok(error instanceof NativeReviewConsentRequiredError, error instanceof Error ? error.message : String(error));
		assert.equal(error.consent.schema, "gentle-ai.review-integration.consent/v3");
		assert.equal(error.consent.agent, "pi");
		return error.consent;
	}
}

function consentAnswerCall(calls: NativeCall[], answer: "granted" | "declined"): NativeCall {
	const matching = calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start" && arguments_.includes("--consent") && arguments_.at(arguments_.indexOf("--consent") + 1) === answer);
	assert.equal(matching.length, 1, `${answer} must execute exactly one provider invocation`);
	return matching[0]!;
}

// ---------------------------------------------------------------------------
// Kill switch round trip.
// ---------------------------------------------------------------------------

test("dev-binary: global opt-in then clone disable and enable clears only the local override", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	const { native } = journeyNative(DEV_BINARY!);
	enableGlobalReview(cwd);
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.effective, "on");
	assert.equal((await native.reviewMode({ cwd, operation: "disable" })).status.effective, "off");
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.source, "clone_local");
	assert.equal((await native.reviewMode({ cwd, operation: "enable" })).status.effective, "on");
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.source, "global");
});

// ---------------------------------------------------------------------------
// Candidate-bound consent/v3 answers.
// ---------------------------------------------------------------------------

test("dev-binary: granted consent executes its exact candidate-bound invocation once and returns the current review binding", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	const workflowDirectory = join(cwd, ".github", "workflows");
	execFileSync("mkdir", ["-p", workflowDirectory]);
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "initial");
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\non: push\njobs:\n  deploy:\n    steps:\n      - run: curl -s | bash\n");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const consent = await candidateConsent(native, cwd);
	const answered = await native.answerConsent({ cwd, consent, answer: "granted" });
	assert.equal(answered.kind, "started");
	if (answered.kind === "started") {
		assert.ok(answered.start.lineageId.length > 0);
		assert.ok(answered.start.selectedLenses.length > 0);
		assert.equal(answered.start.raw?.repository_context !== undefined, true);
	}
	const grantedChoice = consent.choices.find((choice) => choice.answer === "granted");
	assert.ok(grantedChoice, "consent must include a granted choice");
	assert.deepEqual(consentAnswerCall(calls, "granted"), grantedChoice.invocation.split(" ").slice(1));
});

test("dev-binary: declined consent executes its exact candidate-bound invocation once and creates no lineage, result, or actor", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	const workflowDirectory = join(cwd, ".github", "workflows");
	execFileSync("mkdir", ["-p", workflowDirectory]);
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "initial");
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\non: push\njobs:\n  deploy:\n    steps:\n      - run: curl -s | bash\n");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const consent = await candidateConsent(native, cwd);
	const answered = await native.answerConsent({ cwd, consent, answer: "declined" });
	assert.equal(answered.kind, "declined");
	if (answered.kind === "declined") {
		assert.equal(answered.consent, "declined_this_candidate");
		assert.equal("lineageId" in answered, false);
		assert.equal("start" in answered, false);
		assert.equal("actor" in answered.raw, false);
	}
	const declinedChoice = consent.choices.find((choice) => choice.answer === "declined");
	assert.ok(declinedChoice, "consent must include a declined choice");
	assert.deepEqual(consentAnswerCall(calls, "declined"), declinedChoice.invocation.split(" ").slice(1));
	const after = await native.targetStatus({ cwd, agent: "pi" });
	assert.equal(after.authority, undefined);
	assert.equal("receipt" in after, false, "last-event STATUS no longer exposes receipt state");
});

// ---------------------------------------------------------------------------
// Truthful non-authority responses.
// ---------------------------------------------------------------------------

test("dev-binary: an empty candidate exposes the current STATUS refusal and never reconstructs START", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "initial");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	assert.equal(status.nextTransition?.kind, "collect");
	assert.equal(status.nextTransition?.reasonCode, "empty_candidate_base_ref_required");
	await assert.rejects(
		() => native.start({ cwd }),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE
			&& error.mutationOutcome === "none",
	);
	assert.equal(calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start").length, 0);
});

test("dev-binary: v7 intended-untracked selection decodes both selected statuses before START", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	git(cwd, "add", "app.ts");
	git(cwd, "commit", "-qm", "test: base candidate");
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	writeFileSync(join(cwd, "chosen.md"), "# Chosen\n");

	const calls: NativeCall[] = [], selectedWireFields: string[] = [];
	let interceptedStarts = 0;
	let delegatedStarts = 0;
	const startIntercept = new Error("test-only native START intercept");
	const real = createNodeExecFileAdapter();
	const adapter: ExecFileAdapter = async (request) => {
		calls.push([...request.arguments]);
		if (request.arguments.at(0) === "review" && request.arguments.at(1) === "start") {
			interceptedStarts += 1;
			throw startIntercept;
		}
		if (request.arguments.at(0) === "review" && request.arguments.at(1) === "start") delegatedStarts += 1;
		const result = await real({ ...request, file: DEV_BINARY! });
		if (request.arguments.some((argument) => argument.startsWith("--intended-untracked-selection="))) selectedWireFields.push(selectedStatusFieldNames(result.stdout));
		return result;
	};
	const native = new NativeReviewCliV216(adapter, DEV_BINARY!);
	const targetStatus = native.targetStatus.bind(native);
	const selectedStatuses: ReviewStatusV3[] = [];
	const selectedFailures: Array<{ call: number; code: string }> = [];
	let selectedStatusCalls = 0;
	native.targetStatus = async (request) => {
		if (request.intendedUntrackedSelection === undefined) return targetStatus(request);
		selectedStatusCalls += 1;
		try {
			const status = await targetStatus(request);
			selectedStatuses.push(status);
			return status;
		} catch (error) {
			selectedFailures.push({ call: selectedStatusCalls, code: error instanceof NativeReviewCliError ? error.code : "unexpected-error" });
			throw error;
		}
	};

	const candidateViews = new CandidateViewRegistry(), retainedSelections = new Map();
	await enableReview(native, cwd);
	const initial = await __testing.executeReviewControllerOperation({ operation: "status" }, cwd, native, undefined, candidateViews, undefined, retainedSelections);
	assert.equal((initial.result as Record<string, unknown> | undefined)?.schema, "gentle-ai.review-integration.status/v7", "initial status.schema");
	assert.equal(typeof initial.selectionBinding, "string", "initial selectionBinding");
	const result = await __testing.executeReviewControllerOperation({ operation: "select-intended-untracked", selectionBinding: initial.selectionBinding as string, intendedUntracked: ["chosen.md"] } as never, cwd, native, undefined, candidateViews, undefined, retainedSelections);

	if (selectedStatusCalls !== 2) assert.fail(`intended-selection STATUS call count=${selectedStatusCalls}; ${controllerResultStructure(result)}`);
	if (selectedFailures.length > 0) {
		const failure = selectedFailures[0]!;
		assert.fail(`selected STATUS call ${failure.call} decode failed at fields: ${selectedWireFields[failure.call - 1] ?? "status"}; error=${failure.code}`);
	}
	assert.equal(selectedStatusCalls, 2, "intended-selection STATUS call count");
	assert.equal(selectedStatuses.length, 2, "decoded intended-selection STATUS count");
	for (const [index, status] of selectedStatuses.entries()) {
		assert.equal(status.raw.schema, "gentle-ai.review-integration.status/v7", `selected STATUS call ${index + 1} status.schema`);
		assert.deepEqual(status.projection.intendedUntracked, ["chosen.md"], `selected STATUS call ${index + 1} status.projection.intended_untracked`);
		assert.equal(status.nextTransition?.kind, "execute", `selected STATUS call ${index + 1} status.next_transition.kind`);
		assert.equal(status.nextTransition?.execute?.operation, "review.start", `selected STATUS call ${index + 1} status.next_transition.execute.operation`);
		assert.ok((status.nextTransition?.execute?.arguments.length ?? 0) > 0, `selected STATUS call ${index + 1} status.next_transition.execute.arguments`);
		assert.equal(status.nextTransition?.execute?.arguments.every((argument) => typeof argument.token === "string" && argument.token.length > 0), true, `selected STATUS call ${index + 1} status.next_transition.execute.arguments[].token`);
	}
	assert.equal(interceptedStarts, 1, "adapter must intercept the one native review.start attempt");
	assert.equal(delegatedStarts, 0, "intercepted native START must not reach the real adapter");
	assert.equal(calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start").length, 1, "native review.start adapter attempt count");
	assert.equal(result.outcome, "native-mutation-status-reconciled", "controller result after intentional START intercept");
	assert.equal("lineage_id" in result, false, "intercepted START must report no lineage binding");
	assert.equal("authority" in result, false, "intercepted START must report no authority binding");
	assert.equal("lineage_created" in result, false, "reconciled unknown mutation must not claim lineage creation");
	assert.equal("mutation_performed" in result, false, "reconciled unknown mutation must not claim a mutation result");
	assert.equal(result.mutation_outcome, "unknown", "the controller cannot prove mutation status after an intercepted launch");
	assert.match(String(result.required_status_action), /Run target-scoped review\.status/, "ambiguous START must retain its executable-safe STATUS instruction");
	assert.equal(result.next_action, "start", "the reconciled provider action remains visible without authoring a replay");
	const after = await native.targetStatus({ cwd, agent: "pi" });
	assert.equal(after.authority, undefined, "post-intercept STATUS must not expose authority");
});

test("dev-binary: a low-risk START closes the review with no receipt or follow-up capture", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "guide.md"), "# Guide\n\nBase\n");
	git(cwd, "add", "guide.md");
	git(cwd, "commit", "-qm", "docs: base guide");
	writeFileSync(join(cwd, "guide.md"), "# Guide\n\nBase\n\nPassive update\n");

	const { native } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	const started = await native.start({ cwd, targetIdentity: status.targetIdentity });
	assert.equal(started.action, "closed");
	assert.equal(started.state, "approved");
	assert.deepEqual(started.selectedLenses, []);
	assert.equal(started.lensesRequired, false);
});

// gentle-pi#518: native STATUS projects a staged exact rename as its source
// and its destination. The Pi controller freezes the same identity, so
// ordinary START reaches native admission instead of being rejected locally
// with candidate-target-projection-drift.
test("dev-binary: ordinary START through the Pi controller admits a staged exact rename plus an addition", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	mkdirSync(join(cwd, "active"));
	writeFileSync(join(cwd, "active", "document.md"), "# Document\n\nline one\nline two\n");
	git(cwd, "add", "active/document.md");
	git(cwd, "commit", "-qm", "docs: base document");
	mkdirSync(join(cwd, "archive"));
	git(cwd, "mv", "active/document.md", "archive/document.md");
	writeFileSync(join(cwd, "report.md"), "# Report\n\nPassive report\n");
	git(cwd, "add", "-A");
	assert.match(git(cwd, "diff", "--cached", "--name-status", "--find-renames=100%"), /^R100\tactive\/document\.md\tarchive\/document\.md$/m, "the candidate must stage an exact rename");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	assert.deepEqual([...status.projection.paths].sort(), ["active/document.md", "archive/document.md", "report.md"], "native STATUS projects the rename as both of its paths");

	const started = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
	assert.notEqual(started.outcome, "native-operation-failed", `START must reach native admission: ${JSON.stringify(started)}`);
	assert.equal(started.operation, "start");
	const result = started.result as Record<string, unknown>;
	assert.equal(typeof result.lineage_id, "string", "native START must create a lineage");
	// Documentation-only candidate: native admission closes it approved with
	// no lenses, exactly as the low-risk journey above.
	assert.equal(result.action, "closed");
	assert.equal(result.state, "approved");
	assert.equal(calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start").length, 1, "exactly one native START runs");
});

test.before(() => {
	process.env.HOME = DEV_HOME;
	process.env.USERPROFILE = DEV_HOME;
});
test.after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	rmSync(DEV_HOME, { recursive: true, force: true });
});
