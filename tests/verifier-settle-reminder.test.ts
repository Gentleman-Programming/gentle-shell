import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { VERIFIER_RISK_REJECTION, declaredHighRiskItem, rejectUnriskedVerifierLaunch } from "../lib/verifier-admission.ts";
import {
	VERIFIER_SETTLE_REMINDER_TYPE,
	createVerifierSettleReminders,
	finalAssistantText,
	verifierSettleReminderText,
} from "../lib/verifier-settle-reminder.ts";

// odd/tasks/verifier-settle-reminder.md (#2652): a run that declares `Risk: item N` in its final message and never
// attempted a `gentle-ai-verify` launch gets one visible reminder and one continuation at settle.

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("S1: the settle check reuses the admission grammar and names the declared item", () => {
	assert.equal(declaredHighRiskItem("Done.\nRisk: item 3 (shared parser)"), 3);
	assert.equal(declaredHighRiskItem("Done. Risk: item 2, item 3 (auth)"), 2);
	for (const text of ["Done.\nRisk: none", "Do not write Risk: item 3 here.", "Risk: item 7", "Done."]) {
		assert.equal(declaredHighRiskItem(text), undefined, text);
	}
});

test("S1: the final assistant text is the last assistant message's text", () => {
	const messages = [user("Fix it."), assistant("Risk: item 1"), user("And?"), { role: "assistant", content: [{ type: "thinking", thinking: "Risk: item 4" }, { type: "text", text: "Done.\nRisk: item 2" }] }, { role: "toolResult", content: [] }];
	assert.equal(finalAssistantText(messages), "Done.\nRisk: item 2");
	assert.equal(finalAssistantText([user("Risk: item 3")]), undefined);
	assert.equal(finalAssistantText([{ role: "assistant", content: "Risk: item 5" }]), "Risk: item 5");
});

test("S2: the reminder names the item, the launch, the approval rule, and the Needs your decision close", () => {
	const text = verifierSettleReminderText(4);
	assert.match(text, /`Risk: item 4`/);
	assert.match(text, /launch `gentle-ai-verify` with the `Risk: item 4` line in its `task`/);
	assert.match(text, /a user's visual or manual approval does not replace technical verification/i);
	assert.match(text, /close with \*\*Needs your decision\*\* naming the missing proof/);
});

test("S1/S3: one reminder per user prompt, none for Risk: none or after a verifier attempt", () => {
	const reminders = createVerifierSettleReminders<string>();
	reminders.userPrompt("s");
	assert.equal(reminders.beforeSettle("s", "Done.\nRisk: none"), undefined, "Risk: none earns no reminder");
	assert.equal(reminders.beforeSettle("s", "Done."), undefined, "no declaration earns no reminder");
	assert.equal(reminders.beforeSettle("s", undefined), undefined, "no final text earns no reminder");
	assert.equal(reminders.beforeSettle("s", "Done.\nRisk: item 3"), verifierSettleReminderText(3), "the first declared settle reminds");
	assert.equal(reminders.beforeSettle("s", "Still done.\nRisk: item 3"), undefined, "the continuation of the same prompt is not reminded again");
	reminders.userPrompt("s");
	assert.equal(reminders.beforeSettle("s", "Risk: item 1"), verifierSettleReminderText(1), "a new user prompt resets the reminder");
	reminders.userPrompt("s");
	reminders.toolCall("s", "subagent_run", { agent: "gentle-ai-verify", task: "Verify it." });
	assert.equal(reminders.beforeSettle("s", "Risk: item 1"), undefined, "an attempted verifier launch, even one rejected, earns no reminder");
	reminders.userPrompt("s");
	reminders.toolCall("s", "subagent_run", { agent: "gentle-ai-worker", task: "Risk: item 1" });
	reminders.toolCall("s", "subagent_continue", { agent: "gentle-ai-verify", task_id: "t-1" });
	assert.equal(reminders.beforeSettle("s", "Risk: item 1"), verifierSettleReminderText(1), "other agents and continuations are not verifier attempts");
	assert.equal(reminders.beforeSettle("other", "Risk: item 2"), verifierSettleReminderText(2), "sessions are independent");
});

test("S4: the admission rejection says no supported declaration was recognized", (t) => {
	assert.doesNotMatch(VERIFIER_RISK_REJECTION, /This change declares none/);
	assert.match(VERIFIER_RISK_REJECTION, /No supported `Risk: item N` declaration was recognized in the launch `task` or `context`/);
	assert.match(VERIFIER_RISK_REJECTION, /run its focused test and suite inline yourself now/);
	assert.match(VERIFIER_RISK_REJECTION, /never add a Risk line or create a feature document only to get a verifier admitted/);
	const root = mkdtempSync(join(tmpdir(), "verifier-settle-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const denied = rejectUnriskedVerifierLaunch({ agent: "gentle-ai-verify", task: "Verify it." }, { root, contextUsage: { tokens: 0, contextWindow: 400_000 } });
	assert.equal(denied?.reason, VERIFIER_RISK_REJECTION);
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface SettleResult { entries?: Array<{ type: string; customType?: string; content?: unknown; display?: boolean }>; continue?: boolean }

function hookedExtension(processEnv: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[] = [];
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: { emit() {}, on() { return () => {}; } },
		registerCommand() {}, registerTool() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		sendMessage(message: unknown) { sent.push(message); },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv })(pi);
	const ctx = {
		cwd: tmpdir(), hasUI: false, ui: { confirm: async () => true, notify() {}, setStatus() {} },
		getContextUsage: () => ({ tokens: 0, contextWindow: 272_000, percent: 0 }),
		sessionManager: { getSessionId: () => "session-1", getCwd: () => tmpdir(), getEntries: () => [], getBranch: () => [] },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown) => {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = await handler(event, ctx);
		return last;
	};
	return {
		input: (text = "Do it.") => emit("input", { type: "input", text, source: "interactive" }),
		toolCall: (toolName: string, input: Record<string, unknown>) => emit("tool_call", { type: "tool_call", toolName, toolCallId: "c-1", input }),
		settle: async (finalText: string, entries: unknown[] = []) => (await emit("agent_before_settle", {
			type: "agent_before_settle", entries, continue: false, outcome: "completed",
			context: { contextEntries: [], contextMessages: [user("Do it."), assistant(finalText)], llmMessages: [], pendingMessages: [], canContinue: true },
		})) as SettleResult | undefined,
		agentEnd: () => emit("agent_end", { type: "agent_end", messages: [] }),
		sent,
	};
}

test("S1/S2: the settle hook appends one visible reminder and requests one continuation", async () => {
	const session = hookedExtension();
	await session.input();
	const prior = { type: "custom", customType: "other.extension" };
	const result = await session.settle("Implemented.\nRisk: item 3 (shared parser)", [prior]);
	assert.equal(result?.continue, true);
	assert.equal(result?.entries?.length, 2, "earlier proposed entries are kept");
	assert.deepEqual(result?.entries?.[0], prior);
	const reminder = result?.entries?.[1];
	assert.equal(reminder?.type, "custom_message");
	assert.equal(reminder?.customType, VERIFIER_SETTLE_REMINDER_TYPE);
	assert.equal(reminder?.display, true, "the reminder is visible");
	assert.equal(reminder?.content, verifierSettleReminderText(3));
	assert.equal(await session.settle("Ran the verifier? No.\nRisk: item 3"), undefined, "the continuation of the same prompt is not reminded again");
	await session.input("Next task.");
	assert.equal((await session.settle("Risk: item 2"))?.continue, true, "a new user prompt resets the reminder");
});

test("S3: no settle reminder for Risk: none, no item, or a rejected verifier attempt", async () => {
	const session = hookedExtension();
	await session.input();
	assert.equal(await session.settle("Done.\nRisk: none"), undefined);
	assert.equal(await session.settle("Done."), undefined);
	const rejected = await session.toolCall("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify the change." }) as { block?: boolean } | undefined;
	assert.equal(rejected?.block, true, "the admission still rejects the unrisked launch");
	assert.equal(await session.settle("Done.\nRisk: item 3"), undefined, "a rejected verifier attempt counts as attempted");
	await session.input("Again.");
	const admitted = await session.toolCall("subagent_run", { agent: "gentle-ai-verify", mode: "task", task: "Verify it.\nRisk: item 3" }) as { block?: boolean } | undefined;
	assert.equal(admitted?.block, undefined);
	assert.equal(await session.settle("Done.\nRisk: item 3"), undefined, "an admitted verifier attempt counts as attempted");
});

test("S1: a child session never gets the settle reminder", async () => {
	const child = hookedExtension({ GENTLE_PI_AGENTS_CHILD: "1" });
	await child.input();
	assert.equal(await child.settle("Done.\nRisk: item 3"), undefined);
});

test("S1: the existing agent_end review preflight stays inert without a native review CLI", async () => {
	const session = hookedExtension();
	await session.input();
	await session.agentEnd();
	assert.deepEqual(session.sent, [], "agent_end sends no preflight nudge and the settle reminder never uses sendMessage");
	await session.settle("Risk: item 1");
	assert.deepEqual(session.sent, []);
});

test("S5: the gentle_review input description documents the ASSESS escalate shape", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "extensions", "gentle-ai.ts"), "utf8");
	const description = source.split("\n").find(line => line.includes("ASSESS accepts an optional object with baseRef"));
	assert.ok(description, "the gentle_review input description exists");
	assert.match(description, /writerEffort, nativeReviewOutcome, and escalate/);
	assert.match(description, /escalate is \{\\"item\\":N,\\"reason\\":\\"\.\.\.\\"\} with item an integer from 1 to 6 and a non-empty reason of at most 500 characters; any other shape is rejected, and omitting it means no escalation/);
});

test("S6: the reference docs describe the settle reminder", () => {
	const docs = readFileSync(join(import.meta.dirname, "..", "docs", "readme-reference.md"), "utf8");
	const start = docs.indexOf("A third admission check keeps the independent verifier for high-risk changes");
	assert.ok(start >= 0);
	const paragraph = docs.slice(start, docs.indexOf("\n\n", docs.indexOf("\n\n", start) + 2));
	assert.match(paragraph, /no supported `Risk: item N` declaration was recognized/);
	assert.match(paragraph, /`agent_before_settle`[^]*one visible reminder[^]*one continuation/);
	assert.match(paragraph, /once per user prompt/);
});
