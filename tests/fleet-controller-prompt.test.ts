import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension, FLEET_MEMBER_PROMPT } from "../extensions/gentle-ai.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";

// odd/tasks/fleet-orchestrator.md T1: the fleet controller gets the lean fleet
// prompt instead of the ODD orchestrator prompt; members and ordinary sessions
// keep the ODD orchestrator prompt.

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<undefined>;
type MutableEvent = { systemPrompt: string; systemPromptOptions: { appendSystemPrompt: string } };

const REPO_ROOT = join(import.meta.dirname, "..");
const FLEET_PROMPT = readFileSync(join(REPO_ROOT, "assets", "fleet-orchestrator.md"), "utf8").trim();
const ODD_MARKER = /Organic Driven Development \(ODD\) is the predefined workflow of this orchestrator/;

// Scratch stays outside the worktree; it is reported, not removed.
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-prompt-")));
const fixtureCwd = join(fixtureRoot, "project");
// A project whose persona config selects the neutral persona.
const neutralCwd = join(fixtureRoot, "neutral-project");
const home = join(fixtureRoot, "home");
const fixtureEnvironment: NodeJS.ProcessEnv = {
	HOME: home, USERPROFILE: home,
	GENTLE_PI_CONFIG_HOME: join(home, "config"),
	GENTLE_PI_AGENT_HOME: join(home, "agents"),
	PI_CODING_AGENT_DIR: join(home, "pi"),
	XDG_CONFIG_HOME: join(home, "xdg"),
};
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	mkdirSync(fixtureCwd, { recursive: true });
	mkdirSync(join(neutralCwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(join(neutralCwd, ".pi", "gentle-ai", "persona.json"), JSON.stringify({ mode: "neutral" }));
	mkdirSync(home, { recursive: true });
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
});

async function appendedPrompt(role: string | undefined, cwd = fixtureCwd): Promise<string> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: { ...fixtureEnvironment, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0", ...(role ? { [FLEET_ROLE_ENV]: role } : {}) },
		resolveTelemetryTriggerBinary: () => join(fixtureCwd, "never-executed"),
		telemetryTriggerSpawn: () => assert.fail("prompt fixtures must not spawn telemetry"),
	})(pi);
	const event: MutableEvent = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "" } };
	const ctx = { cwd, hasUI: true, ui: { notify() {} }, sessionManager: { getSessionId: () => `fleet-prompt-${role ?? "none"}` } } as unknown as ExtensionContext;
	await handlers.get("before_agent_start")!(event, ctx);
	return event.systemPromptOptions.appendSystemPrompt;
}

test("the fleet prompt asset stays lean and states the fleet rules", () => {
	assert.ok(Buffer.byteLength(FLEET_PROMPT, "utf8") <= 2800, `fleet prompt is ${Buffer.byteLength(FLEET_PROMPT, "utf8")} bytes`);
	for (const rule of [/do not write or review code/i, /124k/, /steer/i, /digest/i, /human/i, /fleet_spawn/, /merge/i, /language/i, /fleet_objective/, /fleet_inspect/]) assert.match(FLEET_PROMPT, rule);
});

// T3 (S2, L17): the fleet answers members itself and escalates only the
// accepted classes; its job is orchestration, never code or delegation.
test("the fleet prompt states the accepted authority boundary and the fleet's own job", () => {
	for (const rule of [/fleet_answer/, /provider consent/i, /credentials/i, /destructive/i, /publishing/i, /grant/i, /fleet_grant/, /relayed (to the human )?by code/i, /ask_user_question|ask_user_choice/, /you do not write or review code yourself/i]) assert.match(FLEET_PROMPT, rule);
	assert.doesNotMatch(FLEET_PROMPT, /Relay every member question/i, "the F0 relay-everything rule is superseded");
	assert.doesNotMatch(FLEET_PROMPT, /subagent|delegat/i, "the fleet orchestrator knows nothing about delegation");
});

// T2b (L29): the fleet knows how its members work so it can work with them,
// never how they are implemented.
test("the fleet prompt states how members work and how to work with them", () => {
	const section = FLEET_PROMPT.slice(FLEET_PROMPT.indexOf("How your members work"));
	assert.ok(FLEET_PROMPT.includes("How your members work"), "the section exists");
	for (const rule of [/full Gentle Shell sessions?/i, /\bODD\b/, /explore/i, /small tasks?/i, /odd\/tasks\/<feature>\.md/, /source of truth/i, /fleet_inspect/, /todo/i, /work units?/i, /feature branch/i, /chained PRs/i, /400/, /stacked-to-main/, /feature-branch-chain/, /product decision/i, /push/i, /merge/i, /scope/i, /acceptance criteria/i, /non-goals/i, /slices/i]) assert.match(section, rule);
	assert.doesNotMatch(FLEET_PROMPT, /subagent|delegat/i);
});

// T2b (L32): the fleet's own memory lives in the gentle-fleet project; a
// member's memory is read only through that member's own project.
test("the fleet prompt routes the fleet's memory to gentle-fleet and members' memory by their cwd", () => {
	const memory = FLEET_PROMPT.split("\n").find(line => line.startsWith("- Memory"));
	assert.ok(memory, "a Memory rule line exists");
	for (const rule of [/project: "gentle-fleet"/, /fleet\/<slug>\//, /mem_current_project/, /cwd/, /fleet_inspect/, /never all projects/i]) assert.match(memory, rule);
});

// T2b (L28): the controller keeps the human's persona and language rules
// without the coding identity, ODD, continuity or delegation text.
test("the fleet controller keeps the selected persona without identity, ODD or delegation text", async () => {
	for (const [persona, cwd, voice, other] of [
		["gentleman", fixtureCwd, /natural Rioplatense Spanish with voseo/, /Do NOT use voseo/],
		["neutral", neutralCwd, /Do NOT use voseo/, /natural Rioplatense Spanish with voseo/],
	] as const) {
		const appended = await appendedPrompt("controller", cwd);
		assert.ok(appended.includes(FLEET_PROMPT), persona);
		assert.match(appended, new RegExp(`^Current persona mode: ${persona}$`, "m"));
		assert.match(appended, /^Persona:$/m);
		assert.match(appended, /Act as a senior architect and teacher/);
		assert.match(appended, /Always respond in the same language the user writes in/);
		assert.match(appended, /^Language: /m);
		assert.match(appended, voice);
		assert.doesNotMatch(appended, other);
		assert.doesNotMatch(appended, /el Gentleman Identity|Identity contract|Authorized work continuity/);
		assert.doesNotMatch(appended, ODD_MARKER);
		assert.doesNotMatch(appended, /subagent|delegat/i, persona);
	}
});

// T8 (L54): a member did not know it was a fleet member and told the human
// to open another session. A member gets the normal prompt plus one short
// member block; ordinary sessions are unchanged.
test("a member gets exactly the ordinary prompt plus the member block, for both personas", async () => {
	for (const cwd of [fixtureCwd, neutralCwd]) {
		const member = await appendedPrompt("member", cwd);
		const normal = await appendedPrompt(undefined, cwd);
		assert.equal(member, `${normal}\n\n${FLEET_MEMBER_PROMPT}`);
		assert.equal(normal.includes(FLEET_MEMBER_PROMPT), false);
		assert.equal(await appendedPrompt("other", cwd), normal, "an unknown role is an ordinary session");
		assert.match(member, /## el Gentleman Identity and Harness/);
		assert.match(member, /Translate relayed subagent findings/);
	}
});

test("the member block says the fleet relays its questions, never to open another session, and stays short", () => {
	assert.ok(Buffer.byteLength(FLEET_MEMBER_PROMPT, "utf8") <= 600, `member block is ${Buffer.byteLength(FLEET_MEMBER_PROMPT, "utf8")} bytes`);
	for (const rule of [/member of a Gentle Shell fleet/, /fleet orchestrator/, /ask_user_question/, /ask_user_choice/, /permission/i, /relays? them to the human/, /blocked/i, /never tell the human to open another session or terminal/i, /cwd/]) assert.match(FLEET_MEMBER_PROMPT, rule);
});

test("the controller never gets the member block", async () => {
	assert.equal((await appendedPrompt("controller")).includes(FLEET_MEMBER_PROMPT), false);
});

test("the fleet prompt tells the fleet to pass each member's project directory as cwd", () => {
	assert.match(FLEET_PROMPT, /Always pass each member's project directory as `cwd`; for a new project use `create: true`/);
});

test("the fleet controller gets the fleet prompt instead of the ODD orchestrator prompt", async () => {
	const appended = await appendedPrompt("controller");
	assert.ok(appended.includes(FLEET_PROMPT), "the fleet prompt is injected");
	assert.doesNotMatch(appended, ODD_MARKER);
});

test("a fleet member keeps the ODD orchestrator prompt and never sees the fleet prompt", async () => {
	const appended = await appendedPrompt("member");
	assert.match(appended, ODD_MARKER);
	assert.equal(appended.includes(FLEET_PROMPT), false);
});

test("an ordinary session keeps the ODD orchestrator prompt", async () => {
	const appended = await appendedPrompt(undefined);
	assert.match(appended, ODD_MARKER);
	assert.equal(appended.includes(FLEET_PROMPT), false);
});

// L35: the live controller described itself as a technical assistant that reviews code.
test("the fleet prompt opens with its identity: the Gentle Shell fleet orchestrator leading members toward the objective", () => {
	const intro = FLEET_PROMPT.split("\n").find(line => line.startsWith("You are"));
	assert.match(String(intro), /^You are the Gentle Shell fleet orchestrator: you lead members toward the human's objective\. You do not write or review code yourself/);
	assert.match(FLEET_PROMPT, /fleet_answer` with `escalate: true`/, "member questions outside its authority go to the deck");
});
