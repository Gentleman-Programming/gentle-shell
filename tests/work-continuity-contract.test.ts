import assert from "node:assert/strict";
import test, { after, before } from "node:test";
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
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = { on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); }, events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { ...env, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" }, resolveTelemetryTriggerBinary: () => join(cwd, "never-executed"), telemetryTriggerSpawn: () => assert.fail("fixture must not spawn telemetry") })(pi);
	const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const ctx = { cwd, hasUI: true, ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionId: () => "continuity-test", getBranch: () => [] } } as unknown as ExtensionContext;
	await handlers.get("before_agent_start")!(event, ctx);
	const prompt = event.systemPromptOptions.appendSystemPrompt;
	const start = prompt.indexOf("## Authorized work continuity");
	const end = prompt.indexOf("# el Gentleman Orchestrator", start);
	assert.ok(start >= 0 && end > start, "always-on parent continuity block is delivered before the core");
	return prompt.slice(start, end);
}

function includesAll(text: string, clauses: string[]): void {
	for (const clause of clauses) assert.ok(text.includes(clause), `missing delivered clause: ${clause}`);
}

test("recoverable failure is distinguished from terminal missing proof within existing bounds", async () => {
	includesAll(await delivered(), [
		"Before a terminal bounded-stop outcome",
		"recoverable technical or harness failure",
		"within the authorized scope and existing correction budget",
		"genuinely inaccessible required proof",
		"explicit one run, no retries, or diagnostic-only limits",
		"permission denial, required new consent, or exhausted budget",
		"never reset budgets, add retry allowances, weaken checks, or override final outcomes",
		"subject to every applicable limit",
		"Respect terminal review and verification outcomes and existing bounded-stop rules",
		"An unavailable verifier remains unavailable; do not retry or escalate it.",
	]);
});

test("S2: setup failure preserves unrun proof without calling the verifier unavailable", async () => {
	includesAll(await delivered(), [
		"A failed verifier setup is a preparation failure, not an unavailable verifier capability.",
		"If setup fails before probes, preserve the failed attempt and report zero tests run; the checks remain unverified.",
		"An unavailable verifier remains unavailable; do not retry or escalate it.",
	]);
});

test("S3: a repaired setup needs one explicit request and keeps every existing limit", async () => {
	includesAll(await delivered(), [
		"After a setup prerequisite is repaired, the human may explicitly request one new bounded verification attempt.",
		"This is a new request, not an automatic retry, and it does not reset the prior attempt or unrelated budgets.",
		"Before proceeding, confirm no child is active or has an uncertain status.",
		"Never bypass consent, a denial, explicit one-run or no-retry limits, terminal native outcomes, or exhausted native budgets.",
	]);
});

test("S4-S5: worker exhaustion exposes a bounded continuation without waiving proof", async () => {
	includesAll(await delivered(), [
		"An exhausted worker-local correction limit ends that automatic cycle, not necessarily the feature.",
		"Stop and report the remaining work, failed checks and missing proof, and offer an explicit human-controlled bounded continuation.",
		"Name its scope, executor, correction limit and checks, or let the human stop.",
		"Before any worker continuation, confirm no child is active or has an uncertain status.",
		"A new session does not reset any limit.",
		"When specifically authorized and not prohibited by actual native authority, continue ordinary in-scope compilation or implementation; unavailable proof still blocks completion and delivery.",
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
