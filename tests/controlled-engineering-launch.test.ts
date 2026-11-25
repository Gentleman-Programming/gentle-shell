import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { CHILD_TIER_ENV } from "../lib/openai-fast-tier.ts";
import { fakeChild } from "./agents-fake-child.ts";

// ---------------------------------------------------------------------------
// controlled-engineering S3: the launcher marks a child for the Controlled
// Engineering section only when the agent is gentle-ai-worker, jd-fix-agent or
// gentle-ai-verify and the launching session's profile enables the option, the
// same way it hands the Fast tier to a child.
// ---------------------------------------------------------------------------

const CHILD_FLAG = "GENTLE_PI_CONTROLLED_ENGINEERING";

const root = realpathSync(mkdtempSync(join(tmpdir(), "controlled-engineering-launch-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const configHome = join(root, "config");
const agentHome = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(configHome, { recursive: true });
mkdirSync(join(agentHome, "agents"), { recursive: true });
mkdirSync(cwd, { recursive: true });
for (const name of ["gentle-ai-worker", "jd-fix-agent", "gentle-ai-verify", "gentle-ai-explore"]) {
	writeFileSync(join(agentHome, "agents", `${name}.md`), readFileSync(new URL(`../assets/agents/${name}.md`, import.meta.url)));
}

/** The active profile "team" routes every launched role; `workflow` is its entry. */
function writeProfiles(workflow?: Record<string, unknown>): void {
	writeFileSync(join(configHome, "profiles.json"), JSON.stringify({
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		active: "team",
		profiles: {
			team: {
				"gentle-ai-worker": { model: "openai/gpt-4o" },
				"jd-fix-agent": { model: "openai/gpt-4o" },
				"gentle-ai-verify": { model: "openai/gpt-4o" },
				"gentle-ai-explore": { model: "openai/gpt-4o", tier: "fast" },
			},
		},
		...(workflow === undefined ? {} : { workflow: { team: workflow } }),
	}));
}

const inertSessionTransport: SessionTransportFactory = {
	createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
	createListener: (registry) => ({ registry, start: async () => {}, close: async () => {} }),
	createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("no messaging in fixture"); } }),
};

const tick = () => new Promise((done) => setImmediate(done));

/** Launches each agent once from a fresh parent session and returns each child's environment. */
async function launch(agents: string[], parentEnv: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv[]> {
	const spawned: NodeJS.ProcessEnv[] = [];
	const tools = new Map<string, { execute(id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const base: Record<string, unknown> = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: { emit: () => undefined, on: () => () => undefined },
		getAllTools: () => [],
	};
	const pi = new Proxy(base, { get: (target, prop: string) => (prop in target ? target[prop] : () => undefined) }) as unknown as ExtensionAPI;
	const env = { PATH: "/bin", GENTLE_PI_CONFIG_HOME: configHome, ...parentEnv };
	gentleAgents(pi, env, {
		env,
		home: join(root, "home"),
		agentHome,
		spawn: (_command, _args, options) => { spawned.push(options.env); return fakeChild().child; },
		now: () => Date.now(),
		schedule: () => () => {},
		pi: { command: "pi", args: [] },
		resolveWorktree: (path, base) => ({ root: resolve(base, path), commonDir: "/fixture/common" }),
		sessionTransport: inertSessionTransport,
		childExtensionPaths: [],
		runtimeMetricsPolicy: { resolve: () => { throw new Error("no metrics policy in fixture"); } },
	});
	const ctx = {
		cwd,
		hasUI: false,
		mode: "tui",
		model: { provider: "openai", id: "gpt-4o" },
		isIdle: () => true,
		ui: { notify() {}, setWidget() {}, setStatus() {} },
		sessionManager: { getSessionId: () => `ce-launch-${agents.join("-")}`, getCwd: () => cwd, getEntries: () => [], getBranch: () => [], getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const fire = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({ reason: "quit" }, ctx); };
	await fire("session_start");
	try {
		for (const agent of agents) {
			// Disjoint surfaces, so concurrent writers are admitted side by side.
			await tools.get("subagent_run")!.execute("run", { agent, task: `Fix it.\n\n## Allowed edit surfaces\nsrc/${agent}.ts\n\n## Return\nReport`, mode: "background" }, undefined, undefined, ctx);
			await tick();
		}
		assert.equal(spawned.length, agents.length, "every launch reached the spawn");
		return spawned;
	} finally {
		await fire("session_shutdown");
		await tick();
	}
}

test("S3: writer and verify children of a profile with the option on are marked; an explore child is not", async () => {
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	const [worker, fixer, verify, explore] = await launch(["gentle-ai-worker", "jd-fix-agent", "gentle-ai-verify", "gentle-ai-explore"]);
	assert.equal(worker![CHILD_FLAG], "writer");
	assert.equal(fixer![CHILD_FLAG], "writer");
	assert.equal(verify![CHILD_FLAG], "verify");
	assert.equal(explore![CHILD_FLAG], undefined);
});

test("S3: the mark follows the launching profile's option, not its orchestrator mode", async () => {
	writeProfiles({ orchestratorMode: "full-delegation", controlledEngineering: true });
	const [worker] = await launch(["gentle-ai-worker"]);
	assert.equal(worker![CHILD_FLAG], "writer");
});

test("S3: with the option off no child is marked, and an inherited mark is never passed on", async () => {
	writeProfiles();
	const [worker, fixer, verify] = await launch(["gentle-ai-worker", "jd-fix-agent", "gentle-ai-verify"], { [CHILD_FLAG]: "1" });
	assert.equal(worker![CHILD_FLAG], undefined);
	assert.equal(fixer![CHILD_FLAG], undefined);
	assert.equal(verify![CHILD_FLAG], undefined);
});

test("the Fast tier still reaches the child as before (preserved)", async () => {
	writeProfiles({ orchestratorMode: "organic", controlledEngineering: true });
	const [explore] = await launch(["gentle-ai-explore"]);
	assert.deepEqual(JSON.parse(explore![CHILD_TIER_ENV] ?? "null"), { tier: "fast", model: "openai/gpt-4o" });
});
