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
		"necessary in-scope implementation, documentation and verification steps",
		"Never end a turn merely announcing an immediately executable authorized next step; execute it instead",
		"A progress update is not a request for permission.",
		"An explicit user stop applies only to the work it names.",
		"Do not infer permission for publishing, destructive actions, unrelated scope or native consent",
		"Honor explicit one-run, no-retry, or diagnostic-only limits.",
		"Correct a failing check only within the existing correction budget",
		"never reset budgets, add retry allowances, weaken checks, or override final outcomes",
	]);
	// The canonical Close owns the authorized-work boundary; the Pi-owned block
	// keeps its unique guards and budget clauses instead of restating it.
	const prompt = await deliveredPrompt();
	includesAll(prompt, [
		"a pending child is a wait event whose completion resumes the turn without asking the human",
		"Missing, partial, unavailable, or declined proof forbids claiming completion of the affected work, never an independently authorized next step",
		"while a required authorized check the existing budget still allows keeps running",
	]);
	for (const duplicated of [
		"Needs your decision",
		"never more verification",
		"Before a terminal bounded-stop outcome",
		"a pending child is a wait event",
		"Missing, partial, unavailable, or declined proof",
	]) assert.ok(!continuity.includes(duplicated), `continuity must not duplicate or license: ${duplicated}`);
	includesAll(await closeStep(), [UNAVAILABLE_VERIFIER]);
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
		"This is not an automatic retry, provider/model fallback, or reset of correction/native budgets.",
		"Consent, denials, explicit one-run/no-retry limits and terminal native outcomes remain binding; failure never counts as approval.",
	]);
	includesAll(await closeStep(), [UNAVAILABLE_VERIFIER]);
	const docs = readFileSync(new URL("../docs/work-continuity.md", import.meta.url), "utf8");
	assert.ok(docs.includes("This guidance changes no runtime quota detection, provider selection, or native review authority."));
});

test("S3: a true human decision and denial stop only the work they apply to", async () => {
	includesAll(await deliveredPrompt(), [
		"only a real human decision, the user's explicit stop, a denial, missing consent, or an exhausted limit stops the work it applies to, never independent authorized work",
		"A tracked task ends the turn pending only while it waits on already-launched work, for the affected work a denial, missing consent, the user's explicit stop, or an exhausted limit applies to, or for a genuine human decision still outstanding",
		"Never turn a report into a blind self-reprompt loop.",
	]);
});

function trackedPendingBoundary(prompt: string): string {
	const start = prompt.indexOf("A tracked task ends the turn pending");
	assert.ok(start >= 0, "the delivered prompt carries the canonical tracked-task boundary");
	const end = prompt.indexOf("as final.", start);
	assert.ok(end > start, "the canonical tracked-task boundary ends with its finality clause");
	return prompt.slice(start, end + "as final.".length);
}

test("S3 F1/F2: a partial stop or exhausted limit affects only that work while unrelated runnable work continues", async () => {
	const prompt = await deliveredPrompt();
	const slice = trackedPendingBoundary(prompt);
	for (const clause of [
		"waits on already-launched work",
		"for the affected work a denial, missing consent, the user's explicit stop, or an exhausted limit applies to",
		"or for a genuine human decision still outstanding",
		"independent authorized work continues",
		"never abandons runnable work or presents an unverified outcome as final",
	]) assert.ok(slice.includes(clause), `tracked-task boundary is missing: ${clause}`);
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
	assert.ok(prompt.includes("Missing, partial, unavailable, or declined proof forbids claiming completion of the affected work"), "no fake complete");
});

test("S4-S5: worker exhaustion exposes a bounded continuation without waiving proof", async () => {
	includesAll(await delivered(), [
		"An exhausted worker-local correction limit ends that automatic cycle, not necessarily the feature.",
		"Stop and report the remaining work, failed checks and missing proof, and offer an explicit human-controlled bounded continuation.",
		"Name its scope, executor, correction limit and checks, or let the human stop.",
		"Before any worker continuation, confirm no child is active or has an uncertain status.",
		"A new session does not reset any limit.",
		"When specifically authorized and not prohibited by actual native authority, continue ordinary in-scope compilation or implementation.",
	]);
});

test("worker-prohibited maintenance has a bounded parent-only route, not a permission bypass", async () => {
	includesAll(await delivered(), [
		"worker prohibitions remain unchanged",
		"parent only",
		"human explicitly authorized the operation itself",
		"exact scope, ownership, and preservation",
		"available permitted tools",
		"fresh runtime/native consent and guards remain binding",
		"broad feature authorization is not destructive authority",
		"never substitute another worker or tool to bypass a denial",
		"validated backup",
		"artifact and migration validation where applicable",
		"recovery path",
		"preserve unrelated edits even in the same file",
		"remove only proven task-created helpers",
		"never blanket restore, reset, or clean",
		"ambiguous ownership or denial stops",
		"This route is guidance, not authorization.",
	]);
});
