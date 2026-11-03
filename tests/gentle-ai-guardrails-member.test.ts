import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";

// odd/tasks/fleet-orchestrator.md S10 R1: a fleet member never runs autonomous
// guardrails. `autonomousMode` in the guardrails file (global or project) is
// ignored for members, so a guarded command still asks (relayed to the fleet and
// the human); every other session keeps reading the file exactly as before.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Layer = "global" | "project";

function isolate(t: TestContext, layer: Layer, config: Record<string, unknown> = { autonomousMode: true }): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-guardrails-member-")));
	const cwd = join(root, "project");
	const configHome = join(root, "config");
	const agentHome = join(root, "agent-home");
	for (const path of [cwd, configHome, agentHome]) mkdirSync(path, { recursive: true });
	const dir = layer === "global" ? configHome : join(cwd, ".pi", "gentle-ai");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "runtime-guardrails.json"), `${JSON.stringify(config)}\n`);
	const previous = {
		agentHome: process.env.GENTLE_PI_AGENT_HOME,
		configHome: process.env.GENTLE_PI_CONFIG_HOME,
		autonomous: process.env.GENTLE_PI_AUTONOMOUS_MODE,
	};
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
	t.after(() => {
		for (const [key, value] of [
			["GENTLE_PI_AGENT_HOME", previous.agentHome],
			["GENTLE_PI_CONFIG_HOME", previous.configHome],
			["GENTLE_PI_AUTONOMOUS_MODE", previous.autonomous],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return cwd;
}

function harness(env: Record<string, string>, cwd: string) {
	const handlers = new Map<string, Handler>();
	const entries: unknown[] = [];
	const prompts: string[] = [];
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		events: { on() {}, emit() {} },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		getThinkingLevel: () => "medium",
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		processEnv: { GENTLE_AI_TELEMETRY: "0", ...env },
		childStandingReviewPermissionClient: { requestAuthorization: async () => false, close() {} },
	})(pi);
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: true,
		sessionManager: { getSessionId: () => "session-guardrails", getCwd: () => cwd, getEntries: () => entries, getBranch: () => entries },
		ui: {
			notify() {},
			setStatus() {},
			confirm: async (title: string) => { prompts.push(`confirm:${title}`); return false; },
			select: async (title: string) => { prompts.push(`select:${title}`); return undefined; },
		},
	} as unknown as ExtensionContext;
	const bash = (command: string) =>
		handlers.get("tool_call")!({ toolName: "bash", toolCallId: "call-1", input: { command } }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	return { bash, prompts };
}

for (const layer of ["global", "project"] as const) {
	test(`a fleet member's git push asks even when the ${layer} guardrails file sets autonomousMode (S10 R1)`, async (t) => {
		const cwd = isolate(t, layer);
		const member = harness({ [FLEET_ROLE_ENV]: "member" }, cwd);
		const result = await member.bash("git push origin main");
		assert.deepEqual(member.prompts, ["confirm:Allow guarded git push?"], "the guarded command asks");
		assert.equal(result?.block, true, "the declined confirmation blocks the push");
	});

	test(`a fleet member keeps the ${layer} autonomous npm publish block: blocked without a dialog (S10 R1, verifier B1)`, async (t) => {
		const cwd = isolate(t, layer);
		const member = harness({ [FLEET_ROLE_ENV]: "member" }, cwd);
		const result = await member.bash("npm publish");
		assert.equal(result?.block, true, "the autonomous default block still applies");
		assert.deepEqual(member.prompts, [], "a block never becomes a question the fleet could approve");
	});

	test(`a fleet member keeps an explicit ${layer} block under autonomousMode (S10 R1, verifier B1)`, async (t) => {
		const cwd = isolate(t, layer, { autonomousMode: true, guardedCommands: { gitPush: "block" } });
		const member = harness({ [FLEET_ROLE_ENV]: "member" }, cwd);
		assert.equal((await member.bash("git push origin main"))?.block, true);
		assert.deepEqual(member.prompts, []);
	});

	test(`a non-fleet session keeps the ${layer} autonomousMode push allowance (S10 R1 pin)`, async (t) => {
		const cwd = isolate(t, layer);
		const session = harness({}, cwd);
		assert.equal(await session.bash("git push origin main"), undefined, "autonomous mode allows the push");
		assert.deepEqual(session.prompts, [], "no dialog opens");
	});

	test(`a fleet controller keeps the ${layer} autonomousMode push allowance (S10 R1 pin)`, async (t) => {
		const cwd = isolate(t, layer);
		const controller = harness({ [FLEET_ROLE_ENV]: "controller" }, cwd);
		assert.equal(await controller.bash("git push origin main"), undefined, "autonomous mode allows the push");
		assert.deepEqual(controller.prompts, []);
	});
}

test("a fleet member's git push asks even under the autonomous env override (S10 R1)", async (t) => {
	const cwd = isolate(t, "global");
	process.env.GENTLE_PI_AUTONOMOUS_MODE = "1";
	const member = harness({ [FLEET_ROLE_ENV]: "member" }, cwd);
	assert.equal((await member.bash("git push origin main"))?.block, true);
	assert.deepEqual(member.prompts, ["confirm:Allow guarded git push?"]);
	assert.equal((await member.bash("npm publish"))?.block, true, "the autonomous default block still applies");
	assert.deepEqual(member.prompts, ["confirm:Allow guarded git push?"], "npm publish never asks");
});

test("a fleet member's unguarded commands still run without a dialog (S10 R1 pin)", async (t) => {
	const cwd = isolate(t, "global");
	const member = harness({ [FLEET_ROLE_ENV]: "member" }, cwd);
	assert.equal(await member.bash("git status"), undefined);
	assert.deepEqual(member.prompts, []);
});
