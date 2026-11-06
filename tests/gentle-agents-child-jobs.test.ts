import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import installGentleAgents from "../extensions/gentle-agents.ts";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { TASK_STATUS, TaskStore } from "../lib/agents-protocol.ts";
import { AgentRunner, CHILD_JOBS_ENV, type RunnerDeps, type TaskRequest } from "../lib/agents-runner.ts";
import { fakeChild } from "./agents-fake-child.ts";
import { isolatedConfigEnv, removeIsolatedConfigHomes } from "./isolated-config-home.ts";

// Child background jobs (#2266): admission end to end. The runner only sets the
// job marker for a child that declares bash_background and is admitted by the
// background-subagents policy, and the child extension only registers its
// private job tools for that marker plus an owned IPC channel.

const gentleAgents: typeof installGentleAgents = (pi, env, overrides) => installGentleAgents(pi, isolatedConfigEnv(env), overrides);
after(removeIsolatedConfigHomes);

const explore: AgentDefinition = { name: "explore", description: "m", filePath: "/a/e.md", scope: "global", instructions: "x", model: undefined, thinking: undefined, mode: undefined, tools: ["read", "bash_background"] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- Runner admission (P-D) ------------------------------------------------

function build() {
	const spawned: Array<{ env: NodeJS.ProcessEnv }> = [];
	const deps: RunnerDeps = {
		spawn: (_command, _args, options) => { spawned.push({ env: options.env }); return fakeChild({ exitOnKill: false, exitOnStdinEnd: false }).child; },
		now: () => Date.now(),
		schedule: () => () => undefined,
		pi: { command: "pi", args: [] },
	};
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 2, stallTimeoutMs: 600_000 }, deps, { askUser: async () => ({ cancelled: true }) });
	return { store, runner, spawned };
}

function request(root: string, env: NodeJS.ProcessEnv, mode = AGENT_MODE.TASK): TaskRequest {
	return { agent: explore, prompt: "p", label: undefined, context: undefined, mode, cwd: root, parentSessionId: "s1", model: { provider: "p", id: "m" }, thinking: "high", sessionDir: "/s", resumeSessionPath: undefined, env: { GENTLE_PI_CONFIG_HOME: join(root, "config"), ...env } };
}

test("P-D policy off fails before spawn and never forwards the job capability", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "probe-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const h = build();
	const task = h.runner.run(request(root, {}));
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.FAILED);
	assert.equal(h.store.get(task.id)?.error, `could not start pi: explicit tool bash_background requires background-subagents policy on. Set ${join(root, ".pi", "gentle-ai", "background-subagents.json")} to {"schema":"gentle-pi.background-subagents/v1","policy":"on"}; inspect or change policy with /gentle:background-subagents enable|disable|status.`);
	assert.equal(h.spawned.length, 0, "nothing spawned, so no child env exists");
});

test("P-D policy on forwards exactly one job marker, and a malformed policy still refuses", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "probe-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "config"), { recursive: true });
	const file = join(root, "config", "background-subagents.json");
	writeFileSync(file, JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy: "on" }));
	const on = build();
	const task = on.runner.run(request(root, { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" }));
	await tick();
	assert.equal(on.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(on.spawned.length, 1);
	assert.equal(on.spawned[0]!.env[CHILD_JOBS_ENV], "1");
	on.runner.cancel(task.id);
	await tick();

	writeFileSync(file, "{broken");
	const raw = readFileSync(file, "utf8");
	const broken = build();
	const failed = broken.runner.run(request(root, {}));
	await tick();
	assert.equal(broken.store.get(failed.id)?.status, TASK_STATUS.FAILED);
	assert.equal(broken.spawned.length, 0);
	assert.equal(readFileSync(file, "utf8"), raw, "the policy file is never rewritten");
});

test("P-D an agent without bash_background never gets the job capability", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "probe-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "config"), { recursive: true });
	writeFileSync(join(root, "config", "background-subagents.json"), JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy: "on" }));
	const h = build();
	const task = h.runner.run({ ...request(root, {}), agent: { ...explore, tools: ["read", "grep"] } });
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.spawned[0]!.env[CHILD_JOBS_ENV], undefined);
	h.runner.cancel(task.id);
	await tick();
});

test("P-D a job marker inherited through request.env never reaches a child without bash_background", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "probe-admission-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "config"), { recursive: true });
	writeFileSync(join(root, "config", "background-subagents.json"), JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy: "on" }));
	const h = build();
	const task = h.runner.run({ ...request(root, { [CHILD_JOBS_ENV]: "1" }), agent: { ...explore, tools: ["read", "grep"] } });
	await tick();
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.spawned.length, 1);
	assert.equal(h.spawned[0]!.env[CHILD_JOBS_ENV], undefined, "a stale inherited marker is stripped, like the requested-tools marker");
	h.runner.cancel(task.id);
	await tick();
});

// --- Child extension registration (P-C) ------------------------------------

type Fake = ReturnType<typeof fakePi>;

function fakePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(ctx?: any) => unknown>>();
	const sent: Array<{ message: any; options: any }> = [];
	const base: any = {
		registerTool: (tool: any) => { tools.set(tool.name, tool); },
		registerMessageRenderer: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerMarkdownTransformer: () => undefined,
		appendEntry: () => undefined,
		sendMessage: (message: any, options: any) => { sent.push({ message, options }); return true; },
		events: { emit: () => undefined, on: () => () => undefined },
		on: (event: string, handler: (ctx?: any) => unknown) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => undefined; },
	};
	const api: any = new Proxy(base, { get: (target, prop) => (prop in target ? target[prop] : () => undefined) });
	const fire = async (event: string, ctx?: any) => { for (const handler of handlers.get(event) ?? []) await handler(ctx); };
	return { api, tools, handlers, sent, fire };
}

function fakeJobShell() {
	const runs: Array<{ command: string; exit(code: number | null): void }> = [];
	const dir = mkdtempSync(join(tmpdir(), "probe-child-jobs-"));
	const shell = () => ({
		operations: {
			exec: (command: string, _cwd: string, options: { onData(data: Buffer): void; signal?: AbortSignal }) => new Promise<{ exitCode: number | null }>((done, fail) => {
				options.signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
				runs.push({ command, exit: (code) => done({ exitCode: code }) });
			}),
		},
	});
	return { runs, shell, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function childEnv(extra: NodeJS.ProcessEnv = {}) {
	return { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: "probe-token", ...extra } as NodeJS.ProcessEnv;
}

function ownedIpc() {
	const frames: Array<Record<string, unknown>> = [];
	return { frames, ipc: { send: (frame: Record<string, unknown>) => { frames.push(frame); return true; }, on: () => undefined } };
}

const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "child-session" } } as any;
const toolNames = (pi: Fake) => [...pi.tools.keys()].sort();

for (const { label, env, ipc, expected } of [
	{ label: "child + owned IPC + jobs=1", env: childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "1" }), ipc: true, expected: ["bash_background", "job_list", "job_stop", "subagent_parent_message"] },
	{ label: "child + owned IPC, no capability", env: childEnv(), ipc: true, expected: ["subagent_parent_message"] },
	{ label: "child + jobs=1, no owned IPC", env: childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "1" }), ipc: false, expected: [] },
	{ label: 'child + owned IPC + jobs="true"', env: childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "true" }), ipc: true, expected: ["subagent_parent_message"] },
	{ label: 'child + owned IPC + jobs="0"', env: childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "0" }), ipc: true, expected: ["subagent_parent_message"] },
	{ label: 'child + owned IPC + jobs=""', env: childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "" }), ipc: true, expected: ["subagent_parent_message"] },
]) {
	test(`P-C registration gating: ${label}`, () => {
		const pi = fakePi();
		const jobs = fakeJobShell();
		const wire = ownedIpc();
		try {
			gentleAgents(pi.api, env, { childIpc: ipc ? wire.ipc : undefined, jobShell: jobs.shell, jobOutputDir: () => jobs.dir });
			assert.deepEqual(toolNames(pi), expected);
			assert.equal(pi.tools.has("monitor"), false, "the monitor is never a child tool");
		} finally { jobs.cleanup(); }
	});
}

test("P-C child job reports go over the owned IPC and the notice stays in the child session", async () => {
	const pi = fakePi();
	const jobs = fakeJobShell();
	const wire = ownedIpc();
	try {
		gentleAgents(pi.api, childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "1" }), { childIpc: wire.ipc, jobShell: jobs.shell, jobOutputDir: () => jobs.dir, now: () => 1_000 });
		await pi.tools.get("bash_background").execute("b1", { command: "gh run watch 7 --exit-status", label: "CI" }, undefined, undefined, ctx);
		assert.deepEqual(wire.frames.at(-1), { id: "j1", kind: "job", message: '{"running":1,"pending":true}' });
		await pi.fire("agent_settled", ctx);
		assert.deepEqual(wire.frames.at(-1), { id: "j2", kind: "job", message: '{"running":1,"pending":true}' });
		jobs.runs[0]!.exit(0);
		await new Promise((done) => setTimeout(done, 60));
		assert.deepEqual(wire.frames.at(-1), { id: "j3", kind: "job", message: '{"running":0,"pending":false}' });
		const notice = pi.sent.at(-1)!;
		assert.equal(notice.message.customType, "gentle-jobs.notice");
		assert.deepEqual(notice.options, { deliverAs: "steer", triggerTurn: true });
		// Nothing was routed to the parent model: the IPC frames carry state only.
		assert.equal(wire.frames.every((frame) => frame.kind === "job"), true);
		assert.equal(JSON.stringify(wire.frames).includes("gentle-jobs.notice"), false);
	} finally { jobs.cleanup(); }
});

test("P-C a child job_list only sees its own session's jobs", async () => {
	const pi = fakePi();
	const jobs = fakeJobShell();
	const wire = ownedIpc();
	try {
		gentleAgents(pi.api, childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "1" }), { childIpc: wire.ipc, jobShell: jobs.shell, jobOutputDir: () => jobs.dir, now: () => 1_000 });
		const other = { cwd: "/repo", sessionManager: { getSessionId: () => "other-session" } } as any;
		await pi.tools.get("bash_background").execute("b1", { command: "sleep 1" }, undefined, undefined, ctx);
		const listed = await pi.tools.get("job_list").execute("l1", {}, undefined, undefined, other);
		assert.match(listed.content[0].text, /No background jobs in this session/);
		const own = await pi.tools.get("job_list").execute("l2", {}, undefined, undefined, ctx);
		assert.match(own.content[0].text, /job-1/);
		await assert.rejects(() => pi.tools.get("job_stop").execute("s1", { job_id: "job-1" }, undefined, undefined, other), /No background job job-1 in this session/);
	} finally { jobs.cleanup(); }
});

test("P-C the child's own job output directory is removed at session shutdown", async () => {
	const pi = fakePi();
	const jobs = fakeJobShell();
	const wire = ownedIpc();
	const root = mkdtempSync(join(tmpdir(), "probe-child-jobs-root-"));
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = root;
	try {
		gentleAgents(pi.api, childEnv({ GENTLE_PI_AGENTS_CHILD_JOBS: "1" }), { childIpc: wire.ipc, jobShell: jobs.shell });
		const result = await pi.tools.get("bash_background").execute("b1", { command: "echo hi" }, undefined, undefined, ctx);
		const outputPath = String(result.content[0].text).match(/Output: (.+)/)![1]!.trim();
		assert.match(outputPath, /gentle-jobs-/);
		assert.equal(existsSync(dirname(outputPath)), true, "the private log directory exists while the child runs");
		await pi.fire("session_shutdown", ctx);
		assert.equal(existsSync(dirname(outputPath)), false, "the private log directory is removed at shutdown");
	} finally {
		if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
		rmSync(root, { recursive: true, force: true });
		jobs.cleanup();
	}
});
