import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	assert.deepEqual(commands.map(args => args[1]), ["status", "assess", "status"], "the untracked inventory read, then both real client validators accept the committed-only request and reach the process adapter");
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

test("#2997: escaped newlines preserve shell word comment boundaries", async () => {
	const continued = String.fromCharCode(92, 10);
	for (const command of [`${continued}git push`, `${continued} git push`, `g${continued}it push`, `git pu${continued}sh`, `git${continued} push`, `"g${continued}it" push`, `echo prefix${continued}#; git push`, `echo prefix${continued}${continued}#; git push`]) {
		assert.equal(recognizeReviewDeliveryActions(command).filter(action => action.kind === "delivery").length, 1, command);
		let assessments = 0;
		const cli = { reviewMode: async () => ({ status: { effective: "on" } }), assess: async () => { assessments++; return { reviewDue: true }; } } as unknown as NativeReviewCli;
		assert.equal((await checkReviewDeliveryPreflight(process.cwd(), "bash", command, cli, () => "HEAD", () => false))?.block, true);
		assert.equal(assessments, 1);
	}
	for (const command of [`'g${continued}it' push`, `echo ${continued}#; git push`, `${continued}# git push &`, `echo ${continued}${continued}# git push &`]) {
		assert.deepEqual(recognizeReviewDeliveryActions(command), [], command);
	}
});

test("#2997: comments inside backticks preserve subsequent parent deliveries", async () => {
	for (const command of ["echo prefix`true # note`; git push", "echo `true # note`; git push", "echo `true # note`; git push &", "echo `true # note`; export GIT_DIR=/other; git push"]) {
		const delivery = recognizeReviewDeliveryActions(command).filter(action => action.kind === "delivery");
		assert.equal(delivery.length, 1, command);
	}
	let assessments = 0;
	const cli = {
		reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async () => { assessments++; return { reviewDue: true }; },
	} as unknown as NativeReviewCli;
	const result = await checkReviewDeliveryPreflight(process.cwd(), "bash", "echo `true # note`; git push", cli, () => "HEAD", () => false);
	assert.equal(result?.block, true);
	assert.equal(assessments, 1, "the trailing parent delivery must still be assessed");
});

test("#2997: shell background lists cannot use a foreground review check", async () => {
	const commands = [
		"sleep 30 && git push &", "git push && echo done &", "git push || echo failed &",
		"sleep 30 && git push &&\n echo done &", "git push ||\n echo failed &", "git push |\n cat &",
		"git push &&\n # continuation & comment\n echo done &",
		"bash -c 'sleep 30 && git push &'", "bash -c 'git push' &",
		"(git push; echo done) &", "{ git push; echo done; } &",
		"if true; then git push; fi &", "until true; do gh pr merge 42; done &",
		'echo "$(git push)" &', "echo `git push` &",
	];
	let assessments = 0;
	const cli = {
		reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async ({ baseRef }: { baseRef: string }) => { assessments++; return { candidate: { kind: "base-diff", baseRef }, reviewDue: false }; },
	} as unknown as NativeReviewCli;
	for (const command of commands) {
		const result = await checkReviewDeliveryPreflight(process.cwd(), "bash", command, cli, () => "HEAD", () => false);
		assert.equal(result?.block, true, command);
		assert.match(result!.reason, /background|foreground/, command);
	}
	assert.equal(assessments, 0, "deferred execution must be separated before assessment");
	const off = { reviewMode: async () => ({ status: { effective: "off" } }) } as unknown as NativeReviewCli;
	for (const command of commands) assert.equal(await checkReviewDeliveryPreflight(process.cwd(), "bash", command, off, () => undefined, () => false), undefined, "known RDD off preserves ordinary command policy");
	for (const command of ["git push # publish & notify", "git push # $(git push &)", "git push # `git push &`", "git push # comment with unmatched ' &",
		"git push &&\n echo done", "git push # comment &\n echo done",
		"sleep 1 & git push", "git push 2>&1 | tail -1", "git push &>/dev/null", "git push && echo done", "git push; echo `sleep 1 &`"]) {
		assert.equal(await checkReviewDeliveryPreflight(process.cwd(), "bash", command, cli, () => "HEAD", () => false), undefined, command);
	}
});

test("#2997: exported Git routing cannot borrow an unrelated RDD-off directory", async () => {
	let modeReads = 0;
	const off = { reviewMode: async () => { modeReads++; return { status: { effective: "off" } }; } } as unknown as NativeReviewCli;
	for (const variable of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE"]) {
		for (const command of [
			`export ${variable}=/other; git push`, `export ${variable}=/other && gh pr merge 42`,
			`export ${variable}=/other; bash -c 'git push'`, `export ${variable}=/other; echo "$(git push)"`,
			`eval 'export ${variable}=/other'; git push`,
			`export ${variable}=/other && git push &`, `echo \`export ${variable}=/other; git push\``,
		]) {
			const result = await checkReviewDeliveryPreflight(process.cwd(), "bash", command, off, () => undefined, () => false);
			assert.equal(result?.block, true, command);
			assert.match(result!.reason, /repository cannot be resolved/, command);
		}
	}
	assert.equal(modeReads, 0, "the session's off mode cannot authorize a redirected target");
	for (const command of [
		"export PATH=/bin; git push", 'echo "export GIT_DIR=/other; git push &"', "echo '$(git push)'",
		'echo "$(git push)"; export GIT_DIR=/other', "(export GIT_DIR=/other); git push",
		"bash -c 'export GIT_DIR=/other'; git push", "eval '(export GIT_DIR=/other)'; git push",
		"export GIT_DIR=/other & git push", "echo `true; export GIT_DIR=/other; true`; git push",
		"eval 'export GIT_DIR=/other &' ; git push",
	]) {
		assert.equal(await checkReviewDeliveryPreflight(process.cwd(), "bash", command, off, () => undefined, () => false), undefined, command);
	}
});

test("#3138: output redirections and trailing filters preserve a literal delivery directory", async () => {
	const root = process.cwd();
	const commands = [
		`cd "${root}" && git push 2>&1`, `cd "${root}" && git push 2>&1 | tail -1`,
		`cd "${root}" && git push 2>& 1 | tail -1`, `cd "${root}" && git push <& 0`,
		`cd "${root}" && git push >out.log`, `cd "${root}" && git push>/dev/null`,
		`cd "${root}" && git push &>/dev/null`, `cd "${root}" && git push >|out.log`,
		`cd "${root}" && git push || echo failed`, `cd "${root}" && gh pr create --title x 2>&1 | tail -5`,
		`cd "${root}" && gh pr create --body-file - <<'EOF'\nbody text\nEOF`,
	];
	for (const command of commands) {
		assert.deepEqual(recognizeReviewDeliveryActions(command), [{ kind: "delivery", directories: [root] }], command);
		const seen: string[] = [];
		const cli = { reviewMode: async ({ cwd }: { cwd: string }) => { seen.push(cwd); return { status: { effective: "off" } }; } } as unknown as NativeReviewCli;
		assert.equal(await checkReviewDeliveryPreflight(root, "bash", command, cli, () => undefined, () => false), undefined, command);
		assert.deepEqual(seen, [root], "RDD off is read from the actual selected repository");
		const on = { reviewMode: async () => ({ status: { effective: "on" } }) } as unknown as NativeReviewCli;
		assert.match((await checkReviewDeliveryPreflight(root, "bash", command, on, () => undefined, () => false))!.reason, /committed range/, "output formatting never bypasses the RDD-on range gate");
	}
});

test("#3138: output syntax never hides a repository redirect or an uncertain cd outcome", () => {
	for (const command of [
		"cd /other | git push", "false || cd /other && git push", "cd /other && false || git push",
		"cd /other && git push || gh pr create", "cd /other && git push; gh pr create",
		"> /dev/null | cd /other && git push", ">out || cd /other && git push",
		"cd /other && GIT_DIR=/elsewhere git push 2>&1 | tail -1",
		"cd /other && env -C /elsewhere git push 2>&1", "cd /other && git --work-tree=/elsewhere push >out",
	]) assert.ok(recognizeReviewDeliveryActions(command).some(action => action.kind === "delivery" && action.unresolvedDirectory), command);
	assert.deepEqual(recognizeReviewDeliveryActions('echo "2>&1 | git push"'), []);
	for (const target of ["1--dry-run", "1-n", "1--delete", "1--work-tree=/elsewhere", "1push", "-n"]) {
		assert.deepEqual(recognizeReviewDeliveryActions(`cd /selected && git push >&${target}`), [{ kind: "delivery", directories: ["/selected"] }], target);
	}
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

test("#3169: an untracked file beside a committed range is excluded with the native inventory instead of failing the preflight", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-untracked-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	writeFileSync(join(root, "app.ts"), "changed\n"); git("commit", "-qam", "change");
	writeFileSync(join(root, "body.md"), "PR body written for gh pr create --body-file\n");
	let inventory: string | undefined = "sha256:inventory";
	let statusFails = false;
	const statusCalls: unknown[] = [], assessCalls: Array<Record<string, unknown>> = [];
	const cli = {
		reviewMode: async () => ({ status: { effective: "on" } }),
		targetStatus: async (request: unknown) => {
			statusCalls.push(request);
			if (statusFails) throw new Error("status unavailable");
			return { applicability: "unrelated", ...(inventory === undefined ? {} : { eligibleUntrackedInventory: inventory }) };
		},
		assess: async (request: Record<string, unknown>) => {
			assessCalls.push(request);
			// Mirrors native: an undeclared untracked inventory fails a committed-only assessment.
			if (inventory !== undefined && request.expectedUntrackedInventory !== inventory) throw new Error("untracked files require an explicit declaration");
			return { candidate: { kind: "base-diff", baseRef, consumed: false }, reviewDue: false };
		},
	} as unknown as NativeReviewCli;
	const command = `cd "${root}" && gh pr create --base main --head feat/x --title "t" --body-file body.md`;
	assert.equal(await checkReviewDeliveryPreflight(root, "bash", command, cli, () => baseRef, () => false), undefined, "gh pr create passes like the push of the same range");
	assert.deepEqual(statusCalls.map(request => { const { signal: _signal, ...rest } = request as Record<string, unknown>; return rest; }), [{ cwd: root, baseRef, committedOnly: true, agent: "pi" }]);
	assert.equal(assessCalls[0].untrackedScope, "exclude");
	assert.equal(assessCalls[0].expectedUntrackedInventory, "sha256:inventory");
	assert.equal(assessCalls[0].baseRef, baseRef);
	assert.equal(assessCalls[0].committedOnly, true);

	inventory = undefined; assessCalls.length = 0;
	assert.equal(await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false), undefined);
	assert.ok(!("untrackedScope" in assessCalls[0]) && !("expectedUntrackedInventory" in assessCalls[0]), "no inventory, no declaration");

	statusFails = true; inventory = "sha256:inventory"; assessCalls.length = 0;
	assert.equal((await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false))?.block, true, "without a native inventory the undeclared assessment still fails closed");
	assert.ok(!("untrackedScope" in assessCalls[0]), "a failed status read never invents a declaration");
});

test("#3169: the real native client sends the exclusion flags with the status inventory, and a session change during the status read blocks", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-untracked-native-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const digest = `sha256:${"a".repeat(64)}`;
	const assessArgs: string[][] = [];
	const client = new NativeReviewCliV216(async request => {
		if (request.arguments[1] === "assess") {
			assessArgs.push([...request.arguments]);
			return { stdout: JSON.stringify({ schema: "gentle-ai.review-assessment/v1", risk: "medium", reasons: [], changed_paths: 1, changed_lines: 1,
				candidate: { kind: "base-diff", base_ref: baseRef, consumed: false }, review_due: false, review_due_reason: "under_budget" }), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		}
		throw new Error("status is decoded by its own suite");
	}, join(root, "native-fixture.exe"));
	let active = true;
	const cli = { reviewMode: async () => ({ status: { effective: "on" } }), assess: client.assess.bind(client),
		targetStatus: async () => { if (!active) throw new Error("unreachable"); return { eligibleUntrackedInventory: digest }; } } as unknown as NativeReviewCli;
	assert.equal(await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false, undefined, () => active), undefined);
	assert.ok(assessArgs[0].includes("--untracked-scope=exclude"));
	assert.ok(assessArgs[0].includes(`--expected-untracked-inventory=${digest}`));
	assert.ok(!assessArgs[0].some(arg => arg.startsWith("--intended-untracked")), "exclude names no paths");

	assessArgs.length = 0;
	const changing = { ...cli, targetStatus: async () => { active = false; return { eligibleUntrackedInventory: digest }; } } as unknown as NativeReviewCli;
	const result = await checkReviewDeliveryPreflight(root, "bash", "git push", changing, () => baseRef, () => false, undefined, () => active);
	assert.equal(result?.block, true);
	assert.match(result!.reason, /Session changed during preflight/);
	assert.equal(assessArgs.length, 0, "no assessment runs after the session changed");
});

test("#3200: GENTLE_RDD_PREFLIGHT_TIMEOUT_MS governs the assessment budget instead of a fixed ten seconds", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-budget-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const previous = process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS;
	t.after(() => { if (previous === undefined) delete process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS; else process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = previous; });
	const assessment = (ms: number) => ({
		reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async () => { await new Promise(done => setTimeout(done, ms)); return { candidate: { kind: "base-diff", baseRef }, reviewDue: false }; },
	}) as unknown as NativeReviewCli;

	process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = "120";
	const expired = await checkReviewDeliveryPreflight(root, "bash", "git push", assessment(400), () => baseRef, () => false);
	assert.equal(expired?.block, true, "an assessment past its budget denies delivery");
	assert.match(expired!.reason, /native assessment did not answer within 120 ms/, "the denial names the assessment budget");
	assert.match(expired!.reason, /GENTLE_RDD_PREFLIGHT_TIMEOUT_MS/, "the denial names the override");

	process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = "2000";
	assert.equal(await checkReviewDeliveryPreflight(root, "bash", "git push", assessment(300), () => baseRef, () => false), undefined, "an assessment inside its budget is not a timeout");
});

test("#3200: an assessment slower than the old ten second bound does not deny the delivery", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-slow-assess-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const previous = process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS;
	process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = "20000";
	t.after(() => { if (previous === undefined) delete process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS; else process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = previous; });
	const cli = {
		reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async () => { await new Promise(done => setTimeout(done, 10_500)); return { candidate: { kind: "base-diff", baseRef }, reviewDue: false }; },
	} as unknown as NativeReviewCli;
	assert.equal(await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false), undefined,
		"a 10.5 s assessment is inside the assessment budget, and the reads that follow it must not be charged for it");
});

test("#3200: the default assessment budget is longer than the read budget it replaced", async () => {
	const { preflightTimeouts } = await import("../lib/review-delivery-preflight.ts");
	const { readMs, assessMs } = preflightTimeouts({});
	assert.equal(readMs, 10_000, "the status and rev-parse reads keep their own ten second budget");
	assert.equal(assessMs, 120_000, "the native assessment is no longer capped at ten seconds");
	assert.ok(assessMs > readMs, "the assessment budget is the longer of the two");
});

test("#3200: an unusable GENTLE_RDD_PREFLIGHT_TIMEOUT_MS keeps the default assessment budget", async () => {
	const { preflightTimeouts } = await import("../lib/review-delivery-preflight.ts");
	for (const value of ["", "0", "-5", "abc", "12.5"]) assert.equal(preflightTimeouts({ GENTLE_RDD_PREFLIGHT_TIMEOUT_MS: value }).assessMs, 120_000, JSON.stringify(value));
	assert.equal(preflightTimeouts({ GENTLE_RDD_PREFLIGHT_TIMEOUT_MS: "45000" }).assessMs, 45_000);
	assert.equal(preflightTimeouts({ GENTLE_RDD_PREFLIGHT_TIMEOUT_MS: " 45000 " }).assessMs, 45_000, "surrounding whitespace is tolerated");
});

test("#3066: an MSYS absolute delivery directory resolves to the native root instead of a missing directory", async () => {
	const { deliveryTarget } = await import("../lib/review-delivery-preflight.ts");
	assert.equal(deliveryTarget("C:\\Users\\ana", "/c/Users/ana/repo", "win32"), "C:\\Users\\ana\\repo", "a Git Bash drive path reaches the real repository");
	assert.equal(deliveryTarget("D:\\work", "/c/Users/ana/repo", "win32"), "C:\\Users\\ana\\repo", "an absolute drive path ignores the base");
	assert.equal(deliveryTarget("C:\\Users\\ana", "repo", "win32"), "C:\\Users\\ana\\repo", "a relative directory still resolves against the base");
});

test("#3066: POSIX delivery directories keep their existing resolution order", async () => {
	const { deliveryTarget } = await import("../lib/review-delivery-preflight.ts");
	assert.equal(deliveryTarget("/home/ana/repo", "sub", "linux"), "/home/ana/repo/sub", "a relative directory resolves against the base");
	assert.equal(deliveryTarget("/home/ana/repo", "/other", "linux"), "/other", "an absolute directory still wins over the base");
});

test("#3066: deliveryTarget keeps MSYS, drive-absolute and UNC forms distinct", async () => {
	const { deliveryTarget } = await import("../lib/review-delivery-preflight.ts");
	assert.equal(deliveryTarget("C:\\Users\\ana", "/C/Users/ana/repo", "win32"), "C:\\Users\\ana\\repo", "an uppercase drive form is normalized too");
	assert.equal(deliveryTarget("C:\\Users\\ana", "C:/Users/ana/repo", "win32"), "C:\\Users\\ana\\repo", "a native drive path stays absolute");
	assert.equal(deliveryTarget("C:\\Users\\ana", "\\\\srv\\share\\r", "win32"), "\\\\srv\\share\\r", "a UNC path ignores the base");
	for (const directory of ["", ".", "sub", "/other"]) assert.equal(deliveryTarget("/home/ana/repo", directory, "linux"), resolve("/home/ana/repo", directory), `POSIX parity for ${JSON.stringify(directory)}`);
});

test("#3200: a due review denies with the optional targetStatus member absent instead of throwing", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-no-target-status-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const result = await checkReviewDeliveryPreflight(root, "bash", "git push", {
		reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async () => ({ candidate: { kind: "base-diff", baseRef }, reviewDue: true }),
	} as unknown as NativeReviewCli, () => baseRef, () => false);
	assert.equal(result?.block, true, "a due review denies even without targetStatus");
	assert.match(result!.reason, /reports a due review/, "the due-review denial, not an unavailable preflight");
});

test("#3200: an assessment that outlives its budget cannot flip the denial it already earned", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-late-assess-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	const previous = process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS;
	t.after(() => { if (previous === undefined) delete process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS; else process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = previous; });
	process.env.GENTLE_RDD_PREFLIGHT_TIMEOUT_MS = "120";
	let lateResolved = false, lateRejected = false;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const cli = { reviewMode: async () => ({ status: { effective: "on" } }),
		assess: async () => { await new Promise(done => setTimeout(done, 400)); lateResolved = true; return { candidate: { kind: "base-diff", baseRef }, reviewDue: true }; } } as unknown as NativeReviewCli;
	assert.match((await checkReviewDeliveryPreflight(root, "bash", "git push", cli, () => baseRef, () => false))!.reason, /native assessment did not answer within 120 ms/);
	const rejecting = { ...cli, assess: async () => { await new Promise(done => setTimeout(done, 400)); lateRejected = true; throw new Error("late"); } } as unknown as NativeReviewCli;
	assert.match((await checkReviewDeliveryPreflight(root, "bash", "git push", rejecting, () => baseRef, () => false))!.reason, /native assessment did not answer within 120 ms/);
	await new Promise(done => setTimeout(done, 600));
	assert.deepEqual({ lateResolved, lateRejected }, { lateResolved: true, lateRejected: true }, "the losing branch is not cancelled, but it must not change the verdict");
	assert.deepEqual(unhandled, [], "a losing branch's late rejection is never unhandled");
});

test("#3200: an env budget past the timer range cannot collapse to an instant timeout", async () => {
	const { preflightTimeouts } = await import("../lib/review-delivery-preflight.ts");
	assert.ok(preflightTimeouts({ GENTLE_RDD_PREFLIGHT_TIMEOUT_MS: "2147483648" }).assessMs <= 2 ** 31 - 1,
		"a budget beyond AbortSignal.timeout range falls back or is clamped, never becomes 1 ms");
});

test("#3200: the read phase names itself when it expires", { timeout: 15_000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-read-timeout-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	const result = await checkReviewDeliveryPreflight(root, "bash", "git push", { reviewMode: () => new Promise(() => {}) } as unknown as NativeReviewCli, () => "HEAD", () => false);
	assert.match(result!.reason, /native review read did not answer within 10000 ms/);
	assert.doesNotMatch(result!.reason, /bounded preflight was cancelled or timed out/);
});
