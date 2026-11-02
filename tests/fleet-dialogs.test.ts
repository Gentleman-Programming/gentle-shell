import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENTS_GLYPH } from "../lib/agents-widget.ts";
import { classifyDialog, dialogResponse } from "../lib/fleet-dialogs.ts";
import { ForeignTargetGrants } from "../lib/foreign-target-grants.ts";
import type { ReviewConsentV3 } from "../lib/review-integration-v2.ts";
import { formatReviewConsentUi } from "../lib/review-consent-ui.ts";
import { SessionMessagingGrants } from "../lib/session-messaging-grants.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";

// odd/tasks/fleet-orchestrator.md T3 (S2): protected dialog classes are found
// by exact markers of the real producers in this repository, so the fleet
// model can never answer consent, permission or destructive prompts.

const REPO_ROOT = join(import.meta.dirname, "..");
const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

type Captured = { method: string; title: string; message?: string; options?: string[] };

function capturingUi(captured: Captured[]) {
	return {
		select: async (title: string, options: string[]) => { captured.push({ method: "select", title, options }); return undefined; },
		confirm: async (title: string, message: string) => { captured.push({ method: "confirm", title, message }); return false; },
		notify() {}, setStatus() {}, setWidget() {},
	};
}

test("the review consent envelope offered through RPC is protected provider consent", () => {
	const consent = {
		schema: "gentle-ai.review-integration.consent/v3", agent: "pi",
		headline: "Review this change?", reason: "risky", value: "catch bugs", riskLevel: "high", changedFiles: 2, changedLines: 40,
		targetIdentity: "repo@abc", projection: "p", riskEvidence: ["auth code"], offPath: { note: "n", command: "c" },
		choices: [{ label: "Run review", effect: "runs it" }, { label: "Skip review", effect: "skips it" }],
	} as unknown as ReviewConsentV3;
	const model = formatReviewConsentUi(consent);
	assert.deepEqual(classifyDialog({ method: "select", title: model.title, options: [...model.options] }), { class: "provider-consent", marker: "review consent" });
});

test("cross-orchestrator messaging and foreign clone grants are protected security permissions", async () => {
	const captured: Captured[] = [];
	const ctx = { hasUI: true, ui: capturingUi(captured), sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;
	await assert.rejects(new SessionMessagingGrants().authorize(ctx, "peer-1", { message: "hello", reason: "coordinate the release" }));
	await assert.rejects(new ForeignTargetGrants().authorize(ctx, { root: "/clone", commonDir: "/clone/.git" } as never));
	assert.equal(captured.length, 2);
	assert.deepEqual(classifyDialog(captured[0]), { class: "security-permission", marker: "cross-orchestrator messaging grant" });
	assert.deepEqual(classifyDialog(captured[1]), { class: "security-permission", marker: "foreign clone grant" });
});

test("the YOLO standing-permission menu is a protected security permission", async () => {
	const captured: Captured[] = [];
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const pi = { registerCommand: (name: string, command: never) => commands.set(name, command), events: { on: () => () => {} } } as unknown as ExtensionAPI;
	registerYoloSessionPolicy(pi, { GENTLE_PI_CONFIG_HOME: join(REPO_ROOT, "does-not-exist") }, { resolveIdentity: async () => undefined });
	const ctx = { cwd: REPO_ROOT, mode: "tui", hasUI: true, ui: capturingUi(captured), sessionManager: { getSessionId: () => "s1" } } as unknown as ExtensionContext;
	await commands.get("gentle:yolo")!.handler("", ctx);
	assert.equal(captured.length, 1);
	assert.deepEqual(classifyDialog(captured[0]), { class: "security-permission", marker: "YOLO standing permission" });
});

test("guarded command, data-loss, review authority, model-cost, scratch removal and profile deletion titles are pinned to their producers and protected", () => {
	const gentleAi = source("extensions/gentle-ai.ts");
	for (const literal of ["\"Allow guarded command?\"", "`Allow guarded ${GUARDED_COMMAND_LABELS[key]}?`", "`Allow guarded actions: ", "\"Allow recognized data-loss command?\"", "`Authorize review authority ${", "`Authorize destructive review authority ${", "\"Authorize review authority ABANDON?\"", "\"Authorize destructive review authority RECOVER?\"", "\"Delete profile?\""]) {
		assert.ok(gentleAi.includes(literal), `extensions/gentle-ai.ts still produces ${literal}`);
	}
	assert.ok(source("lib/orchestrator-helper-consent.ts").includes("`Model-cost permission only: one direct model run via"));
	assert.ok(source("extensions/session-scratch.ts").includes("`Remove ${removable.length} recorded clone${"));
	const cases: Array<[Captured, string, string]> = [
		[{ method: "confirm", title: "Allow guarded git push?", message: "git push origin main" }, "destructive", "guarded command"],
		[{ method: "confirm", title: "Allow guarded actions: git push; git rebase?" }, "destructive", "guarded command"],
		[{ method: "confirm", title: "Allow recognized data-loss command?", message: "rm -rf build" }, "destructive", "data-loss command"],
		[{ method: "confirm", title: "Authorize destructive review authority RECOVER?" }, "destructive", "review authority"],
		[{ method: "confirm", title: "Authorize review authority ABANDON?" }, "destructive", "review authority"],
		[{ method: "select", title: "Model-cost permission only: one direct model run via openai/gpt", options: ["Allow once", "Decline"] }, "provider-consent", "model-cost permission"],
		[{ method: "confirm", title: "Remove 2 recorded clones/worktrees?" }, "destructive", "scratch removal"],
		[{ method: "confirm", title: "Delete profile?" }, "destructive", "profile deletion"],
	];
	for (const [dialog, kind, marker] of cases) assert.deepEqual(classifyDialog(dialog), { class: kind, marker }, dialog.title);
});

test("a subagent's protected dialog relayed by its member keeps its class behind the agents glyph", () => {
	assert.deepEqual(classifyDialog({ method: "confirm", title: `${AGENTS_GLYPH} Allow recognized data-loss command?` }), { class: "destructive", marker: "data-loss command" });
});

test("unknown dialogs stay model-answerable", () => {
	for (const dialog of [
		{ method: "select", title: "Pick a database", options: ["postgres", "sqlite"] },
		{ method: "confirm", title: "Delete the old table?", message: "irreversible" },
		{ method: "input", title: "Release name" },
	]) assert.equal(classifyDialog(dialog), undefined, dialog.title);
});

test("dialogResponse builds the RPC response shape for each dialog method", () => {
	const select = { method: "select", options: ["postgres", "sqlite"] };
	assert.deepEqual(dialogResponse(select, { answer: "sqlite" }), { ok: true, response: { value: "sqlite" } });
	assert.deepEqual(dialogResponse(select, { answer: "1" }), { ok: true, response: { value: "postgres" } }, "1-based index");
	assert.deepEqual(dialogResponse({ method: "select", options: ["1", "2"] }, { answer: "2" }), { ok: true, response: { value: "2" } }, "an exact option wins over an index");
	assert.deepEqual(dialogResponse({ method: "confirm" }, { answer: "yes" }), { ok: true, response: { confirmed: true } });
	assert.deepEqual(dialogResponse({ method: "confirm" }, { answer: "False" }), { ok: true, response: { confirmed: false } });
	assert.deepEqual(dialogResponse({ method: "input" }, { answer: "v1.2" }), { ok: true, response: { value: "v1.2" } });
	assert.deepEqual(dialogResponse({ method: "editor" }, { answer: "line 1\nline 2" }), { ok: true, response: { value: "line 1\nline 2" } });
	for (const method of ["select", "confirm", "input", "editor"]) assert.deepEqual(dialogResponse({ method, options: ["a"] }, { cancel: true }), { ok: true, response: { cancelled: true } });
});

test("dialogResponse refuses answers that do not fit the dialog", () => {
	const select = { method: "select", options: ["postgres", "sqlite"] };
	for (const answer of ["mysql", "0", "3", "Postgres", ""]) {
		const result = dialogResponse(select, { answer });
		assert.equal(result.ok, false, answer);
		if (!result.ok) assert.match(result.error, /not one of the offered options: 1\. postgres \| 2\. sqlite/);
	}
	const confirm = dialogResponse({ method: "confirm" }, { answer: "maybe" });
	assert.equal(confirm.ok, false);
	if (!confirm.ok) assert.match(confirm.error, /yes or no/);
	assert.equal(dialogResponse({ method: "notify" }, { answer: "x" }).ok, false);
});
