import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { checkReviewDeliveryPreflight } from "../lib/review-delivery-preflight.ts";
import { recognizeReviewDeliveryActions } from "../lib/destructive-command-guard.ts";
import { ReviewContinuationRegistry } from "../lib/review-continuation-registry.ts";
import { NativeReviewCliV216, type NativeReviewCli } from "../lib/native-review-cli.ts";

test("committed delivery requests pass the real native client validation without an untracked inventory", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-native-validation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const commands: string[][] = [];
	const client = new NativeReviewCliV216(async request => {
		commands.push([...request.arguments]);
		if (request.arguments[1] === "status") throw new Error("process boundary reached after STATUS request validation");
		return { stdout: JSON.stringify({ schema: "gentle-ai.review-assessment/v1", risk: "high", reasons: [], changed_paths: 1, changed_lines: 1,
			candidate: { kind: "base-diff", base_ref: baseRef, consumed: false }, review_due: true, review_due_reason: "high_risk" }), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, join(root, "native-fixture.exe"));
	const cli = { reviewMode: async () => ({ status: { effective: "on" } }), assess: client.assess.bind(client), targetStatus: client.targetStatus.bind(client) } as unknown as NativeReviewCli;
	await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false);
	assert.deepEqual(commands.map(args => args[1]), ["assess", "status"], "both real client validators accept the committed-only request and reach the process adapter");
	for (const args of commands) {
		assert.ok(args.includes("--committed-only"));
		assert.ok(args.includes(baseRef));
		assert.ok(!args.some(arg => /untracked/.test(arg)), "committed-only requires no untracked inventory flags");
	}
});

test("#2997: a foreground or background delivery cannot precede an explicit committed-range assessment", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-"));
	const configHome = join(root, "config");
	mkdirSync(configHome);
	const previousConfig = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => { if (previousConfig === undefined) delete process.env.GENTLE_PI_CONFIG_HOME; else process.env.GENTLE_PI_CONFIG_HOME = previousConfig; });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q");
	writeFileSync(join(root, "app.ts"), "export const value = 1;\n");
	git("add", "."); git("commit", "-qm", "base");
	const handlers = new Map<string, Function>();
	const tools = new Map<string, { execute: Function }>();
	let nativeDue = false;
	let assessments = 0;
	let assessmentBase: string | undefined;
	let duringConfirmation = () => {};
	const cli = {
		reviewMode: async () => ({ status: { effective: "on", global: "on", cloneLocal: "", source: "global" } }),
		assess: async (request: { baseRef?: string }) => { assessments++; assessmentBase = request.baseRef; return ({ schema: "gentle-ai.review-assessment/v1", risk: nativeDue ? "high" : "medium", reasons: [], changedPaths: 1, changedLines: 2,
			candidate: { kind: "base-diff", baseRef: request.baseRef, consumed: false }, reviewDue: nativeDue, reviewDueReason: nativeDue ? "high_risk" : "under_budget" }); },
	};
	const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit() {} }, registerCommand() {}, registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); } };
	createGentleAiExtension({ nativeReviewCli: cli as never, processEnv: { GENTLE_AI_TELEMETRY: "0" } })(pi as never);
	const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "delivery", getCwd: () => root, getBranch: () => [], getEntries: () => [] }, ui: { notify() {}, confirm: async () => { duringConfirmation(); return true; } } };
	for (const [toolName, command] of [
		["bash", "git push origin HEAD"],
		["bash", "git commit -am fix && git push && gh pr create"],
		["bash_background", "gh pr checks 42 --watch && gh pr merge 42"],
	]) {
		const result = await handlers.get("tool_call")!({ toolName, toolCallId: command, input: { command } }, ctx);
		assert.equal(result?.block, true, command);
		assert.match(result.reason, /delivery|committed.range/i);
	}
	const baseRef = git("rev-parse", "HEAD");
	writeFileSync(join(root, "app.ts"), "export const value = 2;\n"); git("commit", "-qam", "change");
	const gitReads = t.mock.method(childProcess, "execFile");
	syncBuiltinESMExports();
	try {
		const assessed = await tools.get("gentle_review")!.execute("assess-committed", { operation: "assess", input: { baseRef, committedOnly: true } }, undefined, undefined, ctx);
		assert.equal(assessed.details.reviewDue, false);
		assert.equal(gitReads.mock.calls.filter(call => call.arguments[0] === "git").length, 0, "retaining the base adds no asynchronous Git snapshot reads");
	} finally { gitReads.mock.restore(); syncBuiltinESMExports(); }
	const admitted = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "push-after-assess", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(admitted?.block, undefined, "the real controller remembers the explicit range for fresh delivery checks");
	const beforeBatch = assessments;
	const batch = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "batch-delivery", input: { command: "git push origin HEAD && gh pr create" } }, ctx);
	assert.equal(batch?.block, undefined, "a non-due candidate can push and create its PR in one call");
	assert.equal(assessments - beforeBatch, 1, "the batch gets one fresh assessment, not one per action");
	const wrapped = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "wrapped-delivery", input: { command: "sh -c 'git push origin HEAD'" } }, ctx);
	assert.equal(wrapped?.block, undefined, "a shell wrapper alone is not a review blocker");
	for (const command of ["git commit -am fix && git push", "sh -c 'git commit -am fix && git push'", "git switch other && git push", "eval 'git revert HEAD && git push'"]) {
		const result = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: command, input: { command } }, ctx);
		assert.equal(result?.block, true, "a candidate-changing command still needs its own boundary");
	}
	let confirmationObserved = false;
	duringConfirmation = () => {
		confirmationObserved = true;
		duringConfirmation = () => {};
		writeFileSync(join(root, "app.ts"), "export const value = 3;\n"); git("commit", "-qam", "changed during consent");
		nativeDue = true;
	};
	const changed = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "changed-while-confirming", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(confirmationObserved, true);
	assert.equal(changed?.block, true, "command authorization cannot leave an earlier range check stale");
	nativeDue = true;
	await tools.get("gentle_review")!.execute("claimed-decline", { operation: "assess", input: { baseRef, committedOnly: true, nativeReviewOutcome: "declined" } }, undefined, undefined, ctx);
	const refused = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "untrusted-decline", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(refused?.block, true, "a model-declared decline cannot bypass a due native review");
	nativeDue = false;
	const selectedHead = git("rev-parse", "HEAD");
	const selected = await tools.get("gentle_review")!.execute("select-head", { operation: "assess", input: { baseRef: "HEAD", committedOnly: true } }, undefined, undefined, ctx);
	assert.equal(selected.details.candidate.baseRef, selectedHead, "selection assesses and retains the resolved commit, not mutable HEAD");
	writeFileSync(join(root, "app.ts"), "export const value = 4;\n"); git("commit", "-qam", "after selection");
	assert.equal((await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "after-new-commit", input: { command: "git push" } }, ctx))?.block, undefined);
	assert.equal(assessmentBase, selectedHead, "new commits remain in the selected delivery range");
	git("branch", "delivery-base", selectedHead);
	await tools.get("gentle_review")!.execute("select-branch", { operation: "assess", input: { baseRef: "delivery-base", committedOnly: true } }, undefined, undefined, ctx);
	git("branch", "-f", "delivery-base", "HEAD");
	await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "after-base-branch-moved", input: { command: "git push" } }, ctx);
	assert.equal(assessmentBase, selectedHead, "moving a selected branch does not shrink the delivery range");
	for (const input of [{ baseRef, committedOnly: false }, { baseRef: "missing-delivery-base", committedOnly: true }]) {
		try { await tools.get("gentle_review")!.execute("invalid-selection", { operation: "assess", input }, undefined, undefined, ctx); } catch { /* Rejected selectors must not replace the existing hint. */ }
		await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "after-invalid-selection", input: { command: "git push" } }, ctx);
		assert.equal(assessmentBase, selectedHead, "invalid or unresolvable selection preserves the valid pinned range");
	}
});

test("delivery recognition distinguishes executable commands from text and covers grouped shell forms", () => {
	for (const command of ["git push origin HEAD", "git -C './repo with space' push origin HEAD", "git commit -am fix && git push", "gh pr create", "gh pr merge 42 --auto", "gh -R owner/repo pr create", "until true; do gh pr merge 42; done", "sh -c 'git push'", "echo $(git push)", "eval 'git push'", "eval -- git push"]) {
		assert.ok(recognizeReviewDeliveryActions(command).some(action => action.kind === "delivery"), command);
	}
	for (const command of ["git status", "git push --dry-run origin HEAD", "git push --delete origin old", "gh pr checks 42 --watch", "echo 'git push'", "echo '$(git push)'", "printf '%s' 'gh pr merge'", "cat <<'TEXT'\ngit push\nTEXT"]) {
		assert.equal(recognizeReviewDeliveryActions(command).filter(action => action.kind === "delivery").length, 0, command);
	}
});

test("repository redirects remain delivery commands but cannot borrow the session repository", async () => {
	const commands = [
		"git --git-dir /other/.git push", "git --git-dir=/other/.git push",
		"git --work-tree /other push", "git --work-tree=/other push",
		"git --namespace other push", "git --namespace=other push",
		"GIT_DIR=/other/.git git push", "GIT_WORK_TREE=/other git push", "GIT_COMMON_DIR=/other/.git git push", "GIT_NAMESPACE=other git push",
		"env GIT_DIR=/other/.git git push", "env -C /other git push", "env --chdir /other git push", "env --chdir=/other git push", "env -C/other git push",
		"env -C /other sh -c 'git push'", "GIT_WORK_TREE=/other eval 'git push'",
		"sudo --chdir /other git push", "sudo --chdir=/other git push", "sudo -D /other git push", "sudo -D/other git push",
	];
	let modeCalls = 0;
	const cli = { reviewMode: async () => { modeCalls++; return { status: { effective: "off" } }; } } as unknown as NativeReviewCli;
	for (const command of commands) {
		const deliveries = recognizeReviewDeliveryActions(command).filter(action => action.kind === "delivery");
		assert.equal(deliveries.length, 1, command);
		assert.equal(deliveries[0].unresolvedDirectory, true, command);
		const result = await checkReviewDeliveryPreflight(process.cwd(), "bash", command, cli, () => "HEAD", () => false);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason, /literal cd or git -C/);
	}
	assert.equal(modeCalls, 0, "an unrelated off session repository cannot authorize a redirected target");
	for (const command of ["env -u GIT_DIR git push", "sudo -C 3 git push", "CI=1 git push", "env CI=1 git push"]) {
		assert.equal(recognizeReviewDeliveryActions(command).find(action => action.kind === "delivery")?.unresolvedDirectory, undefined, command);
	}
	assert.deepEqual(recognizeReviewDeliveryActions("git -C/other push"), [{ kind: "delivery", directories: ["/other"] }]);
});

test("ambiguous directory control flow cannot borrow another repository's off mode", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-directory-flow-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const other = join(root, "other");
	mkdirSync(other);
	for (const cwd of [root, other]) execFileSync("git", ["init", "-q"], { cwd });
	const seen: string[] = [];
	const cli = { reviewMode: async ({ cwd }: { cwd: string }) => {
		seen.push(cwd);
		return { status: { effective: cwd === other ? "off" : "on" } };
	} } as unknown as NativeReviewCli;
	for (const command of [
		`(cd "${other}" && pwd); git push`,
		`bash -c '(cd "${other}" && pwd); git push'`,
		`false && cd "${other}"; git push`,
		`if false; then cd "${other}"; fi; git push`,
		`cd "${other}" || true; git push`,
		`cd "${other}" && pwd; git push`,
		`cd "${other}" && git push; gh pr create`,
		`pushd "${other}" && git push`,
		'pushd "$OTHER" && git push',
		"popd && git push",
	]) {
		seen.length = 0;
		const result = await checkReviewDeliveryPreflight(root, "bash", command, cli, () => undefined, () => false);
		assert.equal(result?.block, true, command);
		assert.deepEqual(seen, [], "ambiguous directory state must be rejected before querying any repository's mode");
	}
	for (const command of [
		`cd "${other}" && git push`, `git -C "${other}" push`, `sh -c 'cd "${other}" && git push'`,
		`cd "${root}" && cd "${other}" && git push`,
		`cd "${root}" && bash -c 'cd "${other}" && git push'`,
		`cd "${other}" && echo '(quoted text)' && git push`,
	]) {
		seen.length = 0;
		assert.equal(await checkReviewDeliveryPreflight(root, "bash", command, cli, () => undefined, () => false), undefined, command);
		assert.deepEqual(seen, [other], "direct literal directory selection keeps the intended repository");
	}
	for (const command of ["git push && gh pr create", "bash -c 'git push'"]) {
		seen.length = 0;
		assert.equal((await checkReviewDeliveryPreflight(root, "bash", command, cli, () => undefined, () => false))?.block, true);
		assert.deepEqual(seen, [root], "ordinary batching and wrappers continue to assess their session repository");
	}
});

test("preflight rechecks the actual assessed range, preserves native non-due/decline and rejects drift", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-scope-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	writeFileSync(join(root, "app.ts"), "changed\n"); git("commit", "-qam", "change");
	const registry = new ReviewContinuationRegistry();
	const scope = (path: string) => registry.readCommittedRange(path);
	let active = true;
	let mode = "on", due = false, consumed = false, seenBase: string | undefined;
	let duringAssessment = () => {};
	const native = {
		reviewMode: async () => ({ status: { effective: mode } }),
		assess: async (request: { baseRef?: string }) => { seenBase = request.baseRef; duringAssessment(); return { candidate: { kind: "base-diff", baseRef, consumed }, reviewDue: due }; },
		targetStatus: async () => ({ applicability: "current_target", targetIdentity: "exact-target", projection: { kind: "base-diff" } }),
	} as unknown as NativeReviewCli;
	const check = (declined = false, selectedScope = scope) => checkReviewDeliveryPreflight(root, "bash", "git push origin HEAD", native, selectedScope, (_root, target) => declined && target === "exact-target", undefined, () => active);
	assert.equal((await check())?.block, true, "an empty dirty tree is no substitute for a committed range");
	registry.retainCommittedRange(root, baseRef);
	assert.equal(await check(), undefined, "native under-budget/passive outcomes do not force review");
	assert.equal(seenBase, baseRef);
	due = true;
	assert.equal((await check())?.block, true, "a due unacknowledged review pauses delivery");
	assert.equal(await check(true), undefined, "the exact host-recorded human decline preserves ordinary policy");
	const otherSession = new ReviewContinuationRegistry();
	assert.equal((await check(false, path => otherSession.readCommittedRange(path)))?.block, true);
	consumed = true; due = false;
	assert.equal(await check(), undefined, "fresh native acknowledged evidence can proceed to ordinary delivery checks");
	duringAssessment = () => { active = false; };
	assert.equal((await check())?.block, true, "session invalidation during native await cannot allow delivery");
	duringAssessment = () => {};
	active = true;
	writeFileSync(join(root, "app.ts"), "new change\n"); git("commit", "-qam", "new change");
	assert.equal(await check(), undefined, "a new HEAD is assessed freshly without a manual re-registration cycle");
	duringAssessment = () => { duringAssessment = () => {}; writeFileSync(join(root, "app.ts"), "raced change\n"); git("commit", "-qam", "changed during assessment"); };
	assert.equal((await check())?.block, true, "HEAD drift during the fresh read still blocks delivery");
	duringAssessment = () => { registry.retainCommittedRange(root, "HEAD"); };
	assert.equal((await check())?.block, true, "replacement of the selected range during assessment blocks delivery");
	duringAssessment = () => {};
	registry.retainCommittedRange(root, baseRef);
	mode = "off";
	assert.equal(await check(), undefined, "RDD off preserves ordinary delivery policy");
	for (const command of ["cd ~/other && git push", 'cd "$REPO" && git push', "cd && git push", 'git -C "$REPO" push', "sh -c 'cd ~/other && git push'"]) {
		const modeCalls = t.mock.fn(native.reviewMode!);
		assert.equal((await checkReviewDeliveryPreflight(root, "bash", command, { ...native, reviewMode: modeCalls }, scope, () => false))?.block, true, "unresolved directory must not inherit session repository mode");
		assert.equal(modeCalls.mock.callCount(), 0, "do not query mode for an unresolved target");
	}
	mode = "on";
	assert.equal((await checkReviewDeliveryPreflight(root, "bash", "git revert HEAD && git push", native, scope, () => false))?.block, true, "revert changes the candidate before delivery");
	const other = join(root, "other"); mkdirSync(other); git("-C", other, "init", "-q");
	const mixedModes = { ...native, reviewMode: async (request: { cwd: string }) => ({ status: { effective: request.cwd === root ? "off" : "on" } }) } as NativeReviewCli;
	assert.equal((await checkReviewDeliveryPreflight(root, "bash", `cd "${other}" && git push origin HEAD`, mixedModes, scope, () => false))?.block, true, "cd selects its target's RDD mode rather than the session mode");
	assert.equal((await checkReviewDeliveryPreflight(root, "bash", `git push origin HEAD; git -C "${other}" push origin HEAD`, mixedModes, scope, () => false))?.block, true, "a first off repository cannot bypass a second on repository");
	const abort = new AbortController();
	const uncooperative = { reviewMode: () => new Promise(() => {}), assess: () => assert.fail("No assessment after cancellation") } as unknown as NativeReviewCli;
	const pending = checkReviewDeliveryPreflight(root, "bash", "git push origin HEAD", uncooperative, scope, () => false, abort.signal);
	abort.abort();
	assert.equal((await pending)?.block, true, "an uncooperative native reader cannot retain admission after abort");
});
