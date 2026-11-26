import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// controlled-engineering S2/S3/S6: the approved section reaches the system
// prompt verbatim, once, only for sessions that write or verify code: the
// primary session in organic mode when its profile enables the option, and the
// child sessions the launcher marked (gentle-ai-worker, jd-fix-agent and
// gentle-ai-verify).
// ---------------------------------------------------------------------------

// The S2 texts, copied verbatim from the three blocks of odd/tasks/controlled-engineering.md.
const COMMON = `## Controlled Engineering

Do what the request and the evidence need, complete and correct.
Nothing enters without a reason you can point to.

Work the way the project already works:
- Before you build, test or run anything, find how the project does it
  (AGENTS.md, README, scripts, CI config) and use that command, environment
  and data setup as documented.
- Run a documented project command as written (for example its make
  target). Do not expand it into the commands behind it or change its
  flags.
- Do not create a new environment, container, database, test harness or
  tool path when the project has one. If the documented one fails, report
  the failure with its output; do not build a replacement.`;
const WRITER_BLOCK = `Before writing:
- Name the evidence for each thing you will build: the user's words, a
  failing test, an observed failure, or a caller that exists today. A case
  nobody reported and no real producer reaches gets no code.
- Name the smallest change that resolves it (often one line, a message, or
  a deletion). Start there.
- Smallest at the root, not at the symptom: find the callers of what you
  touch and fix the shared cause once.

Each of these needs a requirement that names it; otherwise leave it out:
- a new state, flag, option, config key, command or mode
- a retry, timeout, lock, watchdog, cache or fallback
- an interface, layer, wrapper or generic parameter with a single use
- a second copy or recomputation of something another place already owns
- a schema, contract version or compatibility path for data nothing ships
- variants, extra artifacts or checks the request did not name

Verify in proportion:
- The project's existing tests for what you changed, plus the test of each
  rule you changed, are complete verification unless the user asked for more.
- Anything beyond that (a scratch copy, an isolated environment, an extra
  script, a second pass) needs a reason from the request or a named risk.
  Say what you are about to do and why, in one line, before doing it.
- Where this section and broader verification guidance differ, this section
  decides how you verify, at every risk level. How much you verify, what a
  high-risk change requires, and review consent stay as that guidance says.

Always keep: validation at trust boundaries, handling that prevents data
loss, security checks, everything the user asked for, and the test of each
rule you changed. Size is not the goal: do not compress or split code to
look small.

Before finishing, read your diff and list what it adds beyond the smallest
change. Remove what has no reason. Close with \`Additions: none\` or one line
per addition with its reason.`;
const VERIFIER_BLOCK = `Verify in proportion:
- Run the project's documented commands for what changed, in your copy of
  the repository, plus the checks your task names. That is complete
  verification unless your task asks for more.
- Never create a container, database, toolchain or environment of your own.
  If a documented command cannot run from your copy, report that check as
  not verified, with the reason and the output; do not build a replacement.
- Anything else needs a reason from your task or a named risk. Say what you
  are about to do and why, in one line, before doing it.
- Where this section and broader verification guidance differ, this section
  decides how you verify, at every risk level. How much you verify, what a
  high-risk change requires, and review consent stay as that guidance says.`;
const WRITER = `${COMMON}\n\n${WRITER_BLOCK}`;
const VERIFIER = `${COMMON}\n\n${VERIFIER_BLOCK}`;

const CHILD_FLAG = "GENTLE_PI_CONTROLLED_ENGINEERING";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

let root: string;
let configHome: string;
const fixtureEnvironment: NodeJS.ProcessEnv = {};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	root = mkdtempSync(join(tmpdir(), "controlled-engineering-prompt-"));
	configHome = join(root, "config");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(join(root, "project"), { recursive: true });
	Object.assign(fixtureEnvironment, {
		HOME: join(root, "home"), USERPROFILE: join(root, "home"),
		GENTLE_PI_CONFIG_HOME: configHome,
		GENTLE_PI_AGENT_HOME: join(root, "agents"),
		PI_CODING_AGENT_DIR: join(root, "pi"),
		XDG_CONFIG_HOME: join(root, "xdg"),
	});
	for (const [key, value] of Object.entries(fixtureEnvironment)) {
		previousEnvironment.set(key, process.env[key]);
		process.env[key] = value;
	}
});
after(() => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

/** The active profile "team", with an optional workflow entry. */
function writeProfiles(workflow?: Record<string, unknown>): void {
	writeFileSync(join(configHome, "profiles.json"), JSON.stringify({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		active: "team",
		profiles: { team: { "gentle-ai-worker": { model: "openai/gpt-4o" } } },
		...(workflow === undefined ? {} : { workflow: { team: workflow } }),
	}));
}

function beforeAgentStart(processEnv: NodeJS.ProcessEnv = {}): Handler {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", ...processEnv, GENTLE_AI_TELEMETRY: "0" },
		resolveTelemetryTriggerBinary: () => join(root, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("prompt fixtures must not spawn telemetry"),
	})(pi);
	return handlers.get("before_agent_start")!;
}

function ctx(sessionId: string): ExtensionContext {
	return {
		cwd: join(root, "project"),
		hasUI: true,
		ui: { notify() {}, setWidget() {} },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	} as unknown as ExtensionContext;
}

/** Runs one prompt build and returns the appended system prompt. */
async function build(options: { appendSystemPrompt: string }, sessionId: string, processEnv: NodeJS.ProcessEnv = {}): Promise<string> {
	await beforeAgentStart(processEnv)({ systemPrompt: "base", systemPromptOptions: options }, ctx(sessionId));
	return options.appendSystemPrompt;
}

function occurrences(text: string, section: string): number {
	return text.split(section).length - 1;
}

test("S2/S6: an organic primary with the option on gets the writer section verbatim, once, naming no tool outside the base install", async () => {
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	const options = { appendSystemPrompt: "" };
	const prompt = await build(options, "ce-primary-on");
	assert.equal(occurrences(prompt, WRITER), 1);
	assert.equal(occurrences(prompt, VERIFIER), 0);
	// A bridge may hand the same options back on the next turn: still once.
	assert.equal(occurrences(await build(options, "ce-primary-on"), WRITER), 1);
	const section = prompt.slice(prompt.indexOf("## Controlled Engineering"));
	assert.ok(section.startsWith(WRITER));
	assert.doesNotMatch(WRITER, /codegraph/i);
	assert.doesNotMatch(VERIFIER, /codegraph/i);
});

test("S1/S2: turning the option off removes either section and leaves the prompt of a profile that never had it", async () => {
	writeProfiles();
	const today = await build({ appendSystemPrompt: "" }, "ce-primary-toggle");
	assert.equal(occurrences(today, WRITER), 0);
	assert.equal(occurrences(today, VERIFIER), 0);
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	const options = { appendSystemPrompt: "" };
	assert.equal(occurrences(await build(options, "ce-primary-toggle"), WRITER), 1);
	// Read live on the next build: no restart between the two.
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: false });
	const off = await build(options, "ce-primary-toggle");
	assert.equal(occurrences(off, WRITER), 0);
	assert.equal(occurrences(off, VERIFIER), 0);
	assert.equal(off, today);
	// The same on reused options for a verify child: on, then off.
	const childEnv = { GENTLE_PI_AGENTS_CHILD: "1" };
	const base = await build({ appendSystemPrompt: "" }, "ce-child-toggle", childEnv);
	const reused = { appendSystemPrompt: "" };
	assert.equal(occurrences(await build(reused, "ce-child-toggle", { ...childEnv, [CHILD_FLAG]: "verify" }), VERIFIER), 1);
	assert.equal(await build(reused, "ce-child-toggle", childEnv), base);
});

test("S3: a full-delegation primary never gets a section, even with the option on", async () => {
	writeProfiles({ orchestratorMode: "full-delegation", controlledEngineering: true });
	const prompt = await build({ appendSystemPrompt: "" }, "ce-primary-full");
	assert.match(prompt, /COORDINATOR in full delegation mode/);
	assert.equal(occurrences(prompt, WRITER), 0);
	assert.equal(occurrences(prompt, VERIFIER), 0);
});

test("S3: the primary gate follows the effective mode, so the GENTLE_PI_ORCHESTRATOR_MODE override decides it", async () => {
	// The option comes from the profile; the mode is the session's effective one.
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	const overriddenFull = await build({ appendSystemPrompt: "" }, "ce-primary-env-full", { GENTLE_PI_ORCHESTRATOR_MODE: "full-delegation" });
	assert.match(overriddenFull, /COORDINATOR in full delegation mode/);
	assert.equal(occurrences(overriddenFull, WRITER), 0);
	assert.equal(occurrences(overriddenFull, VERIFIER), 0);
	writeProfiles({ orchestratorMode: "full-delegation", controlledEngineering: true });
	const overriddenOrganic = await build({ appendSystemPrompt: "" }, "ce-primary-env-organic", { GENTLE_PI_ORCHESTRATOR_MODE: "organic" });
	assert.doesNotMatch(overriddenOrganic, /COORDINATOR in full delegation mode/);
	assert.equal(occurrences(overriddenOrganic, WRITER), 1);
	assert.equal(occurrences(overriddenOrganic, VERIFIER), 0);
});

test("S2/S3: a writer child gets the writer section; a verify child gets the verifier section without the writer-only parts", async () => {
	// The child's own profile is irrelevant: only the launcher's mark decides.
	writeProfiles();
	const child = { GENTLE_PI_AGENTS_CHILD: "1" };
	const writer = await build({ appendSystemPrompt: "" }, "ce-child-writer", { ...child, [CHILD_FLAG]: "writer" });
	assert.equal(occurrences(writer, WRITER), 1);
	assert.equal(occurrences(writer, VERIFIER), 0);
	const verify = await build({ appendSystemPrompt: "" }, "ce-child-verify", { ...child, [CHILD_FLAG]: "verify" });
	assert.equal(occurrences(verify, VERIFIER), 1);
	assert.equal(occurrences(verify, WRITER), 0);
	assert.doesNotMatch(verify, /Before writing:/);
	assert.doesNotMatch(verify, /Additions:/);
	assert.match(verify, /Verify in proportion:/);
});

test("S3: a child with any other mark value, the old 1 included, or no mark gets nothing", async () => {
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	for (const value of [undefined, "1", "true", "both", ""]) {
		const prompt = await build({ appendSystemPrompt: "" }, "ce-child-other", { GENTLE_PI_AGENTS_CHILD: "1", ...(value === undefined ? {} : { [CHILD_FLAG]: value }) });
		assert.equal(occurrences(prompt, WRITER), 0, `value=${String(value)}`);
		assert.equal(occurrences(prompt, VERIFIER), 0, `value=${String(value)}`);
		assert.doesNotMatch(prompt, /## Controlled Engineering/, `value=${String(value)}`);
	}
});
