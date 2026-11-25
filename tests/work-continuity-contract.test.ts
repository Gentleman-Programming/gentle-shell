import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// These assertions cover delivered instructions, not an agent's execution of them.
let root: string;
let cwd: string;
let env: NodeJS.ProcessEnv;
const previous = new Map<string, string | undefined>();
before(async () => {
	root = await mkdtemp(join(tmpdir(), "gentle-work-continuity-"));
	cwd = join(root, "project");
	const home = join(root, "home");
	await mkdir(cwd);
	await mkdir(home);
	env = { HOME: home, USERPROFILE: home, GENTLE_PI_CONFIG_HOME: join(home, "config"), GENTLE_PI_AGENT_HOME: join(home, "agents"), PI_CODING_AGENT_DIR: join(home, "pi"), XDG_CONFIG_HOME: join(home, "xdg") };
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(async () => {
	for (const [key, value] of previous) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (root) await rm(root, { recursive: true, force: true });
});

async function delivered(): Promise<string> {
	const prompt = await deliveredPrompt();
	const start = prompt.indexOf("## Authorized work continuity");
	const end = prompt.indexOf("Default workflow: Organic Driven Development", start);
	assert.ok(start >= 0 && end > start, "always-on parent continuity block is delivered before the core");
	return prompt.slice(start, end);
}

// cost-speed-painpoints S15 P4: the verifier-setup rules load with the Verification rule (lazy module), and the
// unavailable-verifier rule stays always-on in the mirrored Close step (step 7).
const VERIFIER_SETUP_FAILURE = "A failed verifier setup is a preparation failure";
function verifierPreparation(): string {
	const module = readFileSync(new URL("../assets/orchestrator-verification.md", import.meta.url), "utf8");
	const heading = "## Verifier preparation failure\n\n";
	const start = module.indexOf(heading);
	assert.ok(start >= 0, "verification module keeps its preparation-failure section");
	const body = module.slice(start + heading.length);
	const end = body.indexOf("\n## ");
	return end < 0 ? body : body.slice(0, end);
}
async function closeStep(): Promise<string> {
	const close = (await deliveredPrompt()).split("\n").find((line) => line.startsWith("7. **Close.**"));
	assert.ok(close, "the always-on prompt delivers the Close step");
	return close;
}
const UNAVAILABLE_VERIFIER = "an unavailable verifier or subagent is reported as unavailable, never retried or escalated into extra ceremony";

async function deliveredPrompt(): Promise<string> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { ...env, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" }, resolveTelemetryTriggerBinary: () => join(cwd, "never-executed"), telemetryTriggerSpawn: () => assert.fail("fixture must not spawn telemetry") })(pi);
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const ctx = { cwd, hasUI: true, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionId: () => "continuity-test", getBranch: () => [] } } as unknown as ExtensionContext;
	await handlers.get("before_agent_start")!(event, ctx);
	return event.systemPromptOptions.appendSystemPrompt;
}

function includesAll(text: string, clauses: string[]): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `missing delivered clause: ${clause}`);
}

test("S3: authorized work continues within existing limits while proof gaps never become completion", async () => {
	const continuity = await delivered();
	includesAll(continuity, [
		"Do in-scope implementation, docs and verification without asking at each step.",
		"Run the authorized next step now.",
		"A progress update is not a request for permission.",
		"An explicit user stop applies only to the work it names.",
		"Do not infer permission for publishing, destructive actions, unrelated scope or native consent",
		"Honor one-run, no-retry and diagnostic-only limits.",
		"Correct checks within their correction limit.",
		"Never reset, widen or dodge a limit, even in a new session.",
		"Do not add retry allowances.",
		"Never weaken checks or override final outcomes.",
	]);
	// The general turn-end rule complements, but does not duplicate, the
	// canonical Close's tracked-work and proof clauses.
	const close = await closeStep();
	includesAll(close, [
		"A pending child is a wait: completion resumes the turn without asking.",
		"Missing, partial, unavailable, or declined proof bars claiming completion of affected work, not independent authorized work or required authorized checks in budget.",
	]);
	for (const duplicated of [
		"Needs your decision",
		"never more verification",
		"Before a terminal bounded-stop outcome",
		"A pending child is a wait: completion resumes the turn without asking.",
		"Missing, partial, unavailable, or declined proof",
	]) assert.ok(!continuity.includes(duplicated), `continuity must not duplicate or license: ${duplicated}`);
	includesAll(close, [UNAVAILABLE_VERIFIER]);
});

test("S2: setup failure preserves unrun proof without calling the verifier unavailable", async () => {
	assert.ok(!(await deliveredPrompt()).includes(VERIFIER_SETUP_FAILURE), "the setup paragraph left the always-on prompt");
	includesAll(verifierPreparation(), [
		"A failed verifier setup is a preparation failure, not an unavailable verifier capability.",
		"If setup fails before probes, preserve the failed attempt and report zero tests run; the checks remain unverified.",
	]);
	includesAll(await closeStep(), [UNAVAILABLE_VERIFIER]);
});

test("S3: a repaired setup needs one explicit request and keeps every existing limit", async () => {
	includesAll(verifierPreparation(), [
		"After a setup prerequisite is repaired, the human may explicitly request one new bounded verification attempt.",
		"This is a new request, not an automatic retry; it does not reset the prior attempt or unrelated budgets.",
		"Before proceeding, confirm no child is active or has an uncertain status.",
		"Never bypass consent, a denial, explicit one-run or no-retry limits, terminal native outcomes, or exhausted native budgets",
	]);
});

test("#3049: explicit quota recovery permits only the missing proof without reopening authority", async () => {
	const parent = await delivered();
	assert.ok(parent.includes("Quota recovery: `orchestrator-quota-recovery.md`."));
	assert.ok(!parent.includes("A temporary verifier quota failure"), "recovery details load only on demand");
	const recovery = readFileSync(new URL("../assets/orchestrator-quota-recovery.md", import.meta.url), "utf8");
	includesAll(recovery, [
		"A temporary verifier quota failure with no verdict still ends the automatic cycle.",
		"After the human reports restored availability and explicitly requests the missing verification, allow one new bounded attempt for the same candidate.",
		"Preserve the failed attempt and still-valid passed checks; do not replay passed suites.",
		"Confirm no child is active or uncertain.",
		"This is not an automatic retry, provider/model fallback, or reset of verifier recheck or native correction limits.",
		"Consent, denials, explicit one-run/no-retry limits and terminal native outcomes remain binding; failure never counts as approval.",
	]);
	includesAll(await closeStep(), [UNAVAILABLE_VERIFIER]);
	const docs = readFileSync(new URL("../docs/work-continuity.md", import.meta.url), "utf8");
	assert.ok(docs.includes("This guidance changes no runtime quota detection, provider selection, or native review authority."));
});

test("S3: a true human decision and denial stop only the work they apply to", async () => {
	includesAll(await closeStep(), [
		"Only a real human decision, explicit user stop, denial, missing consent, exhausted limit, or failure without a permitted route stops only affected work.",
		"Continue independent authorized work; never abandon runnable work or present an unverified outcome as final.",
		"Never turn a report into a blind self-reprompt loop.",
	]);
});

test("S3 F1/F2: a partial stop or exhausted limit affects only that work while unrelated runnable work continues", async () => {
	const close = await closeStep();
	includesAll(close, [
		"A tracked task ends the turn pending only for launched work still running, a real human decision, denial, missing consent, explicit stop, or exhausted limit.",
		"Report failures without a permitted route as incomplete. Continue independent authorized work; never abandon runnable work or present an unverified outcome as final.",
	]);
	// Denied destructive migration, exhausted verifier/correction limit, missing
	// consent, and a partial user stop each stop their affected work; a waiting
	// child resumes automatically; unrelated runnable work is never abandoned.
	const tracking = readFileSync(new URL("../assets/orchestrator-tracking.md", import.meta.url), "utf8");
	const gateStart = tracking.indexOf("Close gate:");
	assert.ok(gateStart >= 0, "the tracking module keeps its Close gate");
	const gate = tracking.slice(gateStart);
	for (const clause of [
		"unless it waits on a launched child",
		"an already-decided denial, missing consent, or exhausted limit applies to that affected work",
		"the user stopped only that work",
		"or a genuine human decision is open",
		"Unrelated runnable authorized work continues",
	]) assert.ok(gate.includes(clause), `tracking Close gate is missing: ${clause}`);
	assert.ok(!gate.includes("tracked or untracked work alike"), "the unscoped stop exception must go");
	assert.ok(close.includes("Missing, partial, unavailable, or declined proof bars claiming completion of affected work"), "no fake complete");
});

// #2919 and turn-end-coherence S11: the parent takes over with evidence and never repeats an attempt.
test("a repeated-cause worker stop hands the next step to the parent without ending independent work", async () => {
	const prompt = await delivered();
	includesAll(prompt, [
		"A worker-local cause recurring after a real fix without a new hypothesis ends the worker's cycle, not the unit.",
		"The parent owns the next step, unasked, within native authority.",
		"On any partial, diagnose from evidence; confirm no child is active or uncertain.",
		"Within user-authorized scope: fix inline if small and understood, or relaunch with changed scope, hypothesis or handoff plus new evidence.",
		"Never repeat an attempt or swap executors to dodge limits.",
		"No permitted route: report only that work incomplete; continue independent work.",
		"Never reset, widen or dodge a limit, even in a new session.",
		"Honor one-run, no-retry and diagnostic-only limits.",
	]);
	for (const removed of ["human-controlled bounded continuation", "let the human stop"]) {
		assert.ok(!prompt.includes(removed), `worker exhaustion must not route to the human: ${removed}`);
	}
});

test("worker-prohibited maintenance has a bounded parent-only route, not a permission bypass", async () => {
	includesAll(await delivered(), [
		"Worker-prohibited maintenance or rollback: Only the parent may act; load `orchestrator-maintenance.md` and verify its prerequisites first.",
	]);
	const maintenance = readFileSync(new URL("../assets/orchestrator-maintenance.md", import.meta.url), "utf8");
	includesAll(maintenance, [
		"Worker prohibitions remain unchanged.",
		"Only the parent may act",
		"explicit human authorization for the operation itself",
		"established exact scope, ownership and preservation",
		"available permitted tools",
		"Fresh runtime/native consent and guards remain binding.",
		"Broad feature authorization is not destructive authority.",
		"Never bypass a denial via another worker or tool.",
		"validated backup",
		"artifact and migration validation where applicable",
		"recovery path",
		"preserve unrelated edits even in the same file",
		"remove only proven task-created helpers",
		"never blanket restore, reset or clean",
		"Do not proceed with ambiguous ownership, a denial or any missing prerequisite.",
		"This route is guidance, not authorization.",
	]);
});
