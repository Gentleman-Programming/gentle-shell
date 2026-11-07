import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { ReviewDeliveryPreflight } from "../lib/review-delivery-preflight.ts";
import { recognizeDeliveryCommands } from "../lib/destructive-command-guard.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

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
	let duringConfirmation = () => {};
	const cli = {
		reviewMode: async () => ({ status: { effective: "on", global: "on", cloneLocal: "", source: "global" } }),
		assess: async (request: { baseRef?: string }) => ({ schema: "gentle-ai.review-assessment/v1", risk: nativeDue ? "high" : "medium", reasons: [], changedPaths: 1, changedLines: 2,
			candidate: { kind: "base-diff", baseRef: request.baseRef, consumed: false }, reviewDue: nativeDue, reviewDueReason: nativeDue ? "high_risk" : "under_budget" }),
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
	const assessed = await tools.get("gentle_review")!.execute("assess-committed", { operation: "assess", input: { baseRef, committedOnly: true } }, undefined, undefined, ctx);
	assert.equal(assessed.details.reviewDue, false);
	const admitted = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "push-after-assess", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(admitted?.block, undefined, "the real controller remembers the explicit range for fresh delivery checks");
	let confirmationObserved = false;
	duringConfirmation = () => {
		confirmationObserved = true;
		duringConfirmation = () => {};
		writeFileSync(join(root, "app.ts"), "export const value = 3;\n"); git("commit", "-qam", "changed during consent");
	};
	const changed = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "changed-while-confirming", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(confirmationObserved, true);
	assert.equal(changed?.block, true, "command authorization cannot leave an earlier range check stale");
	nativeDue = true;
	await tools.get("gentle_review")!.execute("claimed-decline", { operation: "assess", input: { baseRef, committedOnly: true, nativeReviewOutcome: "declined" } }, undefined, undefined, ctx);
	const refused = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "untrusted-decline", input: { command: "git push origin HEAD" } }, ctx);
	assert.equal(refused?.block, true, "a model-declared decline cannot bypass a due native review");
});

test("delivery recognition distinguishes executable commands from text and covers grouped shell forms", () => {
	for (const command of ["git push origin HEAD", "git -C './repo with space' push origin HEAD", "git commit -am fix && git push", "gh pr create", "gh pr merge 42 --auto", "gh -R owner/repo pr create", "until true; do gh pr merge 42; done", "sh -c 'git push'", "echo $(git push)"]) {
		assert.ok(recognizeDeliveryCommands(command).length, command);
	}
	for (const command of ["git status", "git push --dry-run origin HEAD", "git push --delete origin old", "gh pr checks 42 --watch", "echo 'git push'", "echo '$(git push)'", "printf '%s' 'gh pr merge'", "cat <<'TEXT'\ngit push\nTEXT"]) {
		assert.equal(recognizeDeliveryCommands(command).length, 0, command);
	}
});

test("preflight rechecks the actual assessed range, preserves native non-due/decline and rejects drift", async t => {
	const root = mkdtempSync(join(tmpdir(), "review-delivery-scope-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q"); writeFileSync(join(root, "app.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base");
	const baseRef = git("rev-parse", "HEAD");
	writeFileSync(join(root, "app.ts"), "changed\n"); git("commit", "-qam", "change");
	const preflight = new ReviewDeliveryPreflight();
	let mode = "on", due = false, consumed = false, seenBase: string | undefined;
	let duringAssessment = () => {};
	const native = {
		reviewMode: async () => ({ status: { effective: mode } }),
		assess: async (request: { baseRef?: string }) => { seenBase = request.baseRef; duringAssessment(); return { candidate: { kind: "base-diff", baseRef, consumed }, reviewDue: due }; },
		targetStatus: async () => ({ applicability: "current_target", targetIdentity: "exact-target", projection: { kind: "base-diff" } }),
	} as unknown as NativeReviewCli;
	const check = (declined = false, key = "session") => preflight.check(key, root, "bash", "git push origin HEAD", native, (_root, target) => declined && target === "exact-target");
	assert.equal((await check())?.block, true, "an empty dirty tree is no substitute for a committed range");
	const captured = await preflight.capture("session", root, baseRef);
	assert.ok(captured, "Git must identify the actual committed range");
	await preflight.remember(captured);
	assert.equal(await check(), undefined, "native under-budget/passive outcomes do not force review");
	assert.equal(seenBase, baseRef);
	due = true;
	assert.equal((await check())?.block, true, "a due unacknowledged review pauses delivery");
	assert.equal(await check(true), undefined, "the exact host-recorded human decline preserves ordinary policy");
	const replaced = await preflight.capture("session", root, baseRef);
	const latest = await preflight.capture("session", root, baseRef);
	await preflight.remember(replaced);
	assert.equal((await check())?.block, true, "an older completion cannot bless a newer unconfirmed scope");
	await preflight.remember(latest);
	assert.equal((await check(false, "other-session"))?.block, true);
	consumed = true; due = false;
	assert.equal(await check(), undefined, "fresh native acknowledged evidence can proceed to ordinary delivery checks");
	duringAssessment = () => preflight.clear();
	assert.equal((await check())?.block, true, "session invalidation during native await cannot allow delivery");
	duringAssessment = () => {};
	await preflight.remember(await preflight.capture("session", root, baseRef));
	writeFileSync(join(root, "app.ts"), "new change\n"); git("commit", "-qam", "new change");
	assert.equal((await check())?.block, true, "a new HEAD requires reassessment");
	mode = "off";
	assert.equal(await check(), undefined, "RDD off preserves ordinary delivery policy");
	mode = "on";
	const other = join(root, "other"); mkdirSync(other); git("-C", other, "init", "-q");
	const mixedModes = { ...native, reviewMode: async (request: { cwd: string }) => ({ status: { effective: request.cwd === root ? "off" : "on" } }) } as NativeReviewCli;
	assert.equal((await preflight.check("session", root, "bash", `cd "${other}" && git push origin HEAD`, mixedModes, () => false))?.block, true, "cd selects its target's RDD mode rather than the session mode");
	assert.equal((await preflight.check("session", root, "bash", `git push origin HEAD; git -C "${other}" push origin HEAD`, mixedModes, () => false))?.block, true, "a first off repository cannot bypass a second on repository");
	const abort = new AbortController();
	const uncooperative = { reviewMode: () => new Promise(() => {}), assess: () => assert.fail("No assessment after cancellation") } as unknown as NativeReviewCli;
	const pending = preflight.check("session", root, "bash", "git push origin HEAD", uncooperative, () => false, abort.signal);
	abort.abort();
	assert.equal((await pending)?.block, true, "an uncooperative native reader cannot retain admission after abort");
});
