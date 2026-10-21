import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionWorktreeRegistry } from "../lib/session-worktree-registry.ts";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import gentleAgents from "../extensions/gentle-agents.ts";
import { AgentRunner } from "../lib/agents-runner.ts";

const EXPECTED_INDEPENDENT_CLONE_GUIDANCE =
	"Select an existing worktree in the same Git clone as this session. To work in an independent Git repository, delegate with subagent_run with repository_root instead; it asks for your consent first.";

const scratchRoots: string[] = [];

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function gitFixture(t: test.TestContext) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-resilience-git-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const main = join(dir, "main");
	const linked = join(dir, "linked");
	const independent = join(dir, "independent");
	const empty = join(dir, "empty");
	mkdirSync(empty);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: join(empty, "config"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" });
	writeFileSync(join(empty, "config"), "");
	const git = (cwd: string, args: string[]) =>
		execFileSync("git", ["-C", cwd, "-c", `core.hooksPath=${empty}`, "-c", "commit.gpgsign=false", ...args], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

	git(dir, ["init", "--initial-branch=main", `--template=${empty}`, main]);
	git(main, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
	git(main, ["worktree", "add", "-b", "linked", linked]);
	git(dir, ["init", `--template=${empty}`, independent]);
	git(independent, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture independent"]);

	return { dir, main, linked, independent };
}

test("SessionWorktreeRegistry.validate throws actionable repository_root guidance for independent clones", (t) => {
	const f = gitFixture(t);
	const session = SessionManager.inMemory(f.main);
	const pi = {
		appendEntry: () => {},
		events: { emit: () => {} },
	};
	const registry = new SessionWorktreeRegistry(pi, session, f.main);
	registry.start();

	// Same clone worktrees succeed
	assert.equal(registry.validate(f.main), f.main);
	assert.equal(registry.validate(f.linked), f.linked);

	// Independent clone throws specific actionable guidance
	assert.throws(
		() => registry.validate(f.independent),
		(err: Error) => {
			assert.equal(err.message, EXPECTED_INDEPENDENT_CLONE_GUIDANCE);
			return true;
		},
	);
});

test("subagent_run preserves actionable repository_root guidance when workspace_root is an independent clone", async (t) => {
	const f = gitFixture(t);
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => Promise<unknown> | void>>();
	const pi = {
		registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown> }) {
			tools.set(tool.name, tool);
		},
		on(name: string, handler: (payload: unknown, ctx: unknown) => Promise<unknown> | void) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { on: () => () => {}, emit: () => {} },
		appendEntry: () => {},
		appendCustomEntry: () => {},
		sendMessage: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
	} as unknown as ExtensionAPI;

	mkdirSync(join(f.dir, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(
		join(f.dir, ".pi", "agent", "agents", "explore.md"),
		"---\ndescription: explore\ntools: [read]\n---\nYou explore.",
	);

	t.mock.method(AgentRunner.prototype, "run");
	gentleAgents(pi, {}, {
		home: f.dir,
		now: () => Date.now(),
		env: { PATH: "/bin" },
	});

	const session = SessionManager.inMemory(f.main);
	const ctx = {
		mode: "task",
		hasUI: false,
		cwd: f.main,
		sessionManager: session,
		ui: { notify: () => {}, confirm: async () => true },
	} as unknown as ExtensionContext;

	const startHandlers = handlers.get("session_start") ?? [];
	for (const h of startHandlers) await h({}, ctx);

	const subagentRun = tools.get("subagent_run");
	assert.ok(subagentRun, "subagent_run must be registered");

	await assert.rejects(
		subagentRun.execute(
			"test-call-id",
			{
				agent: "explore",
				task: "Explore independent clone",
				workspace_root: f.independent,
			},
			undefined,
			undefined,
			ctx,
		),
		(err: Error) => {
			assert.equal(err.message, EXPECTED_INDEPENDENT_CLONE_GUIDANCE);
			return true;
		},
	);
});

test("tryNormalizeInRepoAbsolutePath handles POSIX and Windows paths inside and outside target root", () => {
	const { tryNormalizeInRepoAbsolutePath } = __testing;

	// In-repository POSIX paths
	assert.equal(
		tryNormalizeInRepoAbsolutePath("/workspace/repo/lib/file.ts", "/workspace/repo"),
		"lib/file.ts",
	);
	assert.equal(
		tryNormalizeInRepoAbsolutePath("/workspace/repo/deep/nested/file.ts", "/workspace/repo"),
		"deep/nested/file.ts",
	);
	assert.equal(
		tryNormalizeInRepoAbsolutePath("/workspace/repo/lib/../lib/file.ts", "/workspace/repo"),
		"lib/file.ts",
	);

	// In-repository Windows drive paths
	assert.equal(
		tryNormalizeInRepoAbsolutePath("C:\\Project\\src\\index.ts", "C:\\Project"),
		"src/index.ts",
	);
	assert.equal(
		tryNormalizeInRepoAbsolutePath("c:/Project/src/index.ts", "C:/Project"),
		"src/index.ts",
	);
	assert.equal(
		tryNormalizeInRepoAbsolutePath("D:\\Work\\lib\\file.ts", "D:/Work"),
		"lib/file.ts",
	);

	// Root itself or root relative targeting "."
	assert.equal(tryNormalizeInRepoAbsolutePath("/workspace/repo", "/workspace/repo"), undefined);
	assert.equal(tryNormalizeInRepoAbsolutePath("/workspace/repo/", "/workspace/repo"), undefined);
	assert.equal(tryNormalizeInRepoAbsolutePath("/workspace/repo/.", "/workspace/repo"), undefined);

	// Outside repository
	assert.equal(tryNormalizeInRepoAbsolutePath("/etc/passwd", "/workspace/repo"), undefined);
	assert.equal(tryNormalizeInRepoAbsolutePath("/workspace/other/file.ts", "/workspace/repo"), undefined);
	assert.equal(tryNormalizeInRepoAbsolutePath("C:\\outside.ts", "C:\\Project"), undefined);
	assert.equal(tryNormalizeInRepoAbsolutePath("D:\\Project\\file.ts", "C:\\Project"), undefined);

	// Path traversal escape
	assert.equal(
		tryNormalizeInRepoAbsolutePath("/workspace/repo/../../outside.ts", "/workspace/repo"),
		undefined,
	);
	assert.equal(
		tryNormalizeInRepoAbsolutePath("/workspace/repo/lib/../../outside.ts", "/workspace/repo"),
		undefined,
	);

	// Non-absolute or relative paths are not handled by this helper
	assert.equal(tryNormalizeInRepoAbsolutePath("lib/file.ts", "/workspace/repo"), undefined);
});

test("writer dispatch rejects in-repository absolute paths across repository_root, workspace_root, and cwd with actionable suggestion without mutating task", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<{ block: true; reason: string } | undefined>;

	const handlers = new Map<string, ToolCallHandler>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call")!;

	const cwd = mkdtempSync(join(tmpdir(), "dispatch-resilience-worker-"));
	scratchRoots.push(cwd);

	// 1. Fallback to ctx.cwd
	const originalTaskCwd = [
		"## Allowed edit surfaces",
		`- \`${cwd}/lib/session.ts\``,
		`- ${cwd}/tests/session.test.ts`,
	].join("\n");
	const inputCwd: Record<string, unknown> = {
		agent: "gentle-ai-worker",
		mode: "task",
		task: originalTaskCwd,
	};
	const resCwd = await toolCall(
		{ toolName: "subagent_run", input: inputCwd },
		{ cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
	);
	assert.equal(resCwd?.block, true);
	assert.match(resCwd!.reason, /use "lib\/session\.ts" instead/);
	assert.equal(inputCwd.task, originalTaskCwd);

	// 2. Explicit workspace_root
	const wsRoot = "/foreign/workspace";
	const originalTaskWs = [
		"## Allowed edit surfaces",
		`- \`${wsRoot}/src/app.ts\``,
	].join("\n");
	const inputWs: Record<string, unknown> = {
		agent: "gentle-ai-worker",
		mode: "task",
		workspace_root: wsRoot,
		task: originalTaskWs,
	};
	const resWs = await toolCall(
		{ toolName: "subagent_run", input: inputWs },
		{ cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
	);
	assert.equal(resWs?.block, true);
	assert.match(resWs!.reason, /use "src\/app\.ts" instead/);
	assert.equal(inputWs.task, originalTaskWs);

	// 3. Explicit repository_root
	const repoRoot = "C:\\Repositories\\IndependentRepo";
	const originalTaskRepo = [
		"## Allowed edit surfaces",
		`- \`${repoRoot}\\modules\\auth.ts\``,
	].join("\n");
	const inputRepo: Record<string, unknown> = {
		agent: "gentle-ai-worker",
		mode: "task",
		repository_root: repoRoot,
		task: originalTaskRepo,
	};
	const resRepo = await toolCall(
		{ toolName: "subagent_run", input: inputRepo },
		{ cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
	);
	assert.equal(resRepo?.block, true);
	assert.match(resRepo!.reason, /use "modules\/auth\.ts" instead/);
	assert.equal(inputRepo.task, originalTaskRepo);
});
