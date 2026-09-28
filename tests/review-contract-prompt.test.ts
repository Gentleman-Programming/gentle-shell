import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";

// gentle-pi#560 / gentle-ai#4056, #4057: since 2026-08-01 Gentle AI stopped
// writing a runtime-specific review execution contract into Pi's generated
// APPEND_SYSTEM composition. This package now injects the mirrored provider
// contract bundle's own `orchestration/pi.md` text at session start instead.
// These tests exercise the real committed mirror (contracts/review-provider-contract-mirror/)
// rather than a fake one: the mirror IS the package under test.

type BeforeAgentStartResult = undefined;
type BeforeAgentStartHandler = (event: unknown, ctx: ExtensionContext) => Promise<BeforeAgentStartResult>;
type MutableEvent = { agentName?: string; systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } };

const REPO_ROOT = join(import.meta.dirname, "..");
const MIRROR_LOCK_PATH = join(REPO_ROOT, "contracts", "review-provider-contract-mirror", "provider-contract.lock.json");

function mirroredPiOrchestrationText(): string {
	const lock = JSON.parse(readFileSync(MIRROR_LOCK_PATH, "utf8")) as { contract_semver: string };
	return readFileSync(
		join(REPO_ROOT, "contracts", "review-provider-contract-mirror", `v${lock.contract_semver}`, "bundle", "orchestration", "pi.md"),
		"utf8",
	).trim();
}

function harness(nativeReviewCli: NativeReviewCli | null): { beforeAgentStart: BeforeAgentStartHandler } {
	const handlers = new Map<string, BeforeAgentStartHandler>();
	const pi = {
		on(name: string, handler: BeforeAgentStartHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli })(pi);
	const beforeAgentStart = handlers.get("before_agent_start");
	assert.equal(typeof beforeAgentStart, "function");
	return { beforeAgentStart: beforeAgentStart as BeforeAgentStartHandler };
}

function ctx(overrides: Record<string, unknown> = {}): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "review-contract-prompt-session" },
		...overrides,
	} as unknown as ExtensionContext;
}

function primaryEvent(overrides: Partial<MutableEvent> = {}): MutableEvent {
	return { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" }, ...overrides };
}

test("before_agent_start injects the mirrored review execution contract for the primary session through appendSystemPrompt, never a returned systemPrompt", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent();
	const result = await beforeAgentStart(event, ctx());
	assert.equal(result, undefined, "the handler must not return a replacement systemPrompt");
	const appended = event.systemPromptOptions.appendSystemPrompt;
	const expected = mirroredPiOrchestrationText();
	assert.match(appended, /Substantial authorized work: use ODD/);
	assert.match(appended, /For behavior changes with applicable runnable deterministic tests and a clear expected outcome, use test-first by default: observe RED, GREEN, then refactor with focused checks/);
	assert.match(appended, /Test presence alone does not establish applicability; no chat or TUI toggle activates it/);
	assert.match(appended, /no meaningful RED, explain why and run proportionate ordinary functional or structural verification/);
	assert.match(appended, /Never invent lifecycle evidence or skip checks/);
	assert.doesNotMatch(appended, /If tests exist, use strict TDD/);
	assert.match(appended, /ODD \(Default Workflow, harness section above\) is mandatory on every request/);
	assert.doesNotMatch(appended, /Prefer SDD\/OpenSpec artifacts/);
	assert.match(appended, /## Gentle AI review execution contract \(mirrored provider bundle 1\.2\.0\)/);
	assert.ok(appended.includes(expected), "the mirrored orchestration/pi.md text must appear verbatim");
	assert.match(appended, /call `gentle_review` with {"operation":"inspect"}/);
	assert.match(appended, /call `gentle_review` with operation `status`, the exact retained `lineageId`, and `workspaceRoot`/);
	assert.match(appended, /Use `gentle_review_capture` for one current returned slot or `gentle_review_capture_group` for the complete current reviewer group/);
	assert.match(appended, /An eligible interactive Pi host may resolve `gentle-ai\.review-integration\.consent\/v3` before the envelope reaches the model/);
	assert.match(appended, /If `gentle_review` returns the envelope unresolved, it is still the original provider-owned two-choice contract/);
	assert.match(appended, /Never add the host action to a decoded or relayed provider envelope/);
	assert.match(appended, /An approved capture awaits acknowledgement; it is not burned\. On `approved`, use bound facade STATUS to obtain or replay the exact provider-issued `acknowledge-approved` continuation, then execute it unchanged\. Only its successful returned envelope burns authority; do not issue STATUS after that burn\./);
	let previousLifecycleIndex = appended.indexOf("## Gentle AI review execution contract");
	for (const marker of [
		'call `gentle_review` with {"operation":"inspect"}',
		"2. **Freeze once.**",
		"call `gentle_review` with operation `status`",
		"Use `gentle_review_capture` for one current returned slot",
		"5. **Acknowledge exactly.**",
	]) {
		const markerIndex = appended.indexOf(marker, previousLifecycleIndex + 1);
		assert.ok(markerIndex > previousLifecycleIndex, `${marker} must follow the previous lifecycle step`);
		previousLifecycleIndex = markerIndex;
	}
	assert.doesNotMatch(appended, /authority is already burned/);
	assert.doesNotMatch(appended, /gentle-ai review status\b.*--agent pi/);
});

test("before_agent_start does not inject the review execution contract for a named agent session", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent({ agentName: "review-readability" });
	await beforeAgentStart(event, ctx());
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Gentle AI review execution contract/);
});

test("before_agent_start does not inject the review execution contract for gentle-ai-worker", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent({ agentName: "gentle-ai-worker" });
	await beforeAgentStart(event, ctx());
	assert.equal(event.systemPromptOptions.appendSystemPrompt, "", "a named agent gets nothing appended");
});

test("before_agent_start does not inject the review execution contract for jd-fix-agent", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent({ agentName: "jd-fix-agent" });
	await beforeAgentStart(event, ctx());
	assert.equal(event.systemPromptOptions.appendSystemPrompt, "", "a named agent gets nothing appended");
});

test("before_agent_start does not let legacy prompt text bypass primary ODD and review injection", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent({ systemPrompt: "SDD apply executor body" });
	await beforeAgentStart(event, ctx());
	const appended = event.systemPromptOptions.appendSystemPrompt;
	assert.match(appended, /Substantial authorized work: use ODD/);
	assert.match(appended, /Gentle AI review execution contract/);
	assert.doesNotMatch(appended, /### 3\. SDD \(optional\)/);
});

test("before_agent_start injects nothing when nativeReviewCli is null", async () => {
	const { beforeAgentStart } = harness(null);
	const event = primaryEvent();
	await beforeAgentStart(event, ctx());
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /Gentle AI review execution contract/);
});

test("before_agent_start is idempotent: running twice on the same systemPromptOptions never duplicates the harness", async () => {
	const { beforeAgentStart } = harness({} as NativeReviewCli);
	const event = primaryEvent();
	await beforeAgentStart(event, ctx());
	const firstLength = event.systemPromptOptions.appendSystemPrompt.length;
	await beforeAgentStart(event, ctx());
	assert.equal(event.systemPromptOptions.appendSystemPrompt.length, firstLength, "a second run on the same options object must not append again");
	const occurrences = event.systemPromptOptions.appendSystemPrompt.split("Gentle AI review execution contract").length - 1;
	assert.equal(occurrences, 1);
});

// gentle-ai R1/R3: a tampered mirrored orchestration/pi.md must never be spliced into the system prompt.
function tempMirror(text: string, entrySha256: string): string {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-mirror-"));
	const bundleDir = join(root, "v9.9.9", "bundle", "orchestration");
	mkdirSync(bundleDir, { recursive: true });
	writeFileSync(join(bundleDir, "pi.md"), text, "utf8");
	const lock = JSON.stringify({ contract_semver: "9.9.9", entries: { "orchestration/pi.md": entrySha256 } });
	writeFileSync(join(root, "provider-contract.lock.json"), lock, "utf8");
	return root;
}

test("rejects a tampered mirror, accepts a matching one, and warns once", async () => {
	const tampered = tempMirror("tampered contract text", "0".repeat(64));
	const matchingText = "matching contract text";
	const matching = tempMirror(matchingText, createHash("sha256").update(Buffer.from(matchingText, "utf8")).digest("hex"));
	try {
		// Cache-bust: isolate this module's fragment cache from the real-mirror tests above.
		const cacheBustedUrl = `${pathToFileURL(join(import.meta.dirname, "..", "extensions", "gentle-ai.ts")).href}?tamper=${Math.random()}`;
		type Testing = {
			readMirroredReviewContractFragment: (mirrorRoot?: string) => string | null;
			loadReviewContractPromptFragment: (ctx: ExtensionContext, mirrorRoot?: string) => string | null;
		};
		const fresh = (await import(cacheBustedUrl)) as { __testing: Testing };
		assert.equal(fresh.__testing.readMirroredReviewContractFragment(tampered), null);
		assert.ok(fresh.__testing.readMirroredReviewContractFragment(matching)?.includes(matchingText));
		let notifyCount = 0;
		const spyCtx = { hasUI: true, ui: { notify: () => { notifyCount += 1; } } } as unknown as ExtensionContext;
		fresh.__testing.loadReviewContractPromptFragment(spyCtx, tampered);
		fresh.__testing.loadReviewContractPromptFragment(spyCtx, tampered);
		assert.equal(notifyCount, 1);
	} finally {
		rmSync(tampered, { recursive: true, force: true });
		rmSync(matching, { recursive: true, force: true });
	}
});
