import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import skillRegistry from "../extensions/skill-registry.ts";
import type { PermissionMode } from "../lib/permission-mode-policy.ts";
import { SESSION_WORKTREE_ENTRY, SessionWorktreeRegistry, worktreeGitEnvironment } from "../lib/session-worktree-registry.ts";

const title = "Allow access outside the session worktree?";
const outside = join(parse(process.cwd()).root, "__gentle_path_consent_fixture__", "notes.md");
const declined = { block: true, reason: "Gentle AI safety policy blocked the path access because it was not confirmed." };
const headless = (path: string) => ({ block: true, reason: `Gentle AI safety policy requires interactive confirmation before accessing paths outside the session worktree: ${path}. Ask the user for an explicit safer plan.` });

function fixture(t: test.TestContext, options: { mode?: PermissionMode; hasUI?: boolean; approve?: boolean; skills?: boolean } = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "path-consent-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const repo = join(dir, "repo"), config = join(dir, "config");
	// The exemption test names an existing directory outside the fixture and
	// default temp roots as TMPDIR. The hook is probed without executing a write.
	const temp = options.skills ? join(process.cwd(), "assets") : join(dir, "scratch");
	for (const path of [repo, config]) mkdirSync(path);
	if (!options.skills) mkdirSync(temp);
	const gitConfig = join(dir, "git-config");
	writeFileSync(gitConfig, "");
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", `core.hooksPath=${config}`, "-c", "commit.gpgsign=false", ...args], {
		env: { ...worktreeGitEnvironment(), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "pipe",
	});
	git("init", "--quiet", `--template=${config}`);
	writeFileSync(join(config, "permission-mode.json"), JSON.stringify({ schema: "gentle-pi.permission-mode/v1", mode: options.mode ?? "normal" }));
	const manager = SessionManager.inMemory(repo);
	const prompts: string[][] = [], permissionEvents: unknown[] = [];
	const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => unknown)[]>();
	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		events: { on() {}, emit(name: string, data: unknown) { if (name === "pi-permission-system:permission-request") permissionEvents.push(data); } },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerFlag() {},
		getFlag: () => false, getActiveTools: () => [], getAllTools: () => [],
		appendEntry: (type: string, data: unknown) => { manager.appendCustomEntry(type, data); },
	};
	let classifications = 0;
	createGentleAiExtension({
		processEnv: { GENTLE_PI_AGENTS_CHILD: "0", GENTLE_PI_CONFIG_HOME: config, TMPDIR: temp },
		nativeReviewCli: null,
		resolveTelemetryTriggerBinary: () => { throw new Error("No native telemetry in fixture"); },
		autoPermissionClassifier: { run: async () => { classifications++; return { status: "available", decision: "deny", reason: "Fixture restriction" }; }, cancel() {} },
	})(pi as unknown as ExtensionAPI);
	if (options.skills) skillRegistry(pi as unknown as ExtensionAPI);
	const ctx = {
		cwd: repo, mode: "tui", hasUI: options.hasUI ?? true, sessionManager: manager,
		model: { id: "fixture", provider: "fixture" }, signal: new AbortController().signal,
		ui: { confirm: async (...args: string[]) => { prompts.push(args); return options.approve === true; }, setStatus() {}, setWidget() {} },
	} as unknown as ExtensionContext;
	async function emit(name: string, event: unknown) {
		for (const fn of handlers.get(name) ?? []) {
			const verdict = await fn(event, ctx);
			if (verdict !== undefined) return verdict;
		}
		return undefined;
	}
	let callId = 0;
	return { dir, repo, temp, git, manager, ctx, pi, prompts, permissionEvents, emit, classifications: () => classifications,
		call: (toolName: string, input: unknown) => emit("tool_call", { toolName, input, toolCallId: `path-${++callId}` }),
	};
}

const inputs = (path: string) => [
	["read", { path }], ["write", { path, content: "fixture" }], ["edit", { path, edits: [] }],
	["grep", { path, pattern: "fixture" }], ["find", { path, pattern: "*" }], ["ls", { path }],
] as const;

test("all six file tools ask for the exact outside target and a refusal blocks", async t => {
	const f = fixture(t);
	for (const [tool, input] of inputs(outside)) assert.deepEqual(await f.call(tool, input), declined, tool);
	assert.deepEqual(f.prompts, inputs(outside).map(() => [title, outside]));
	for (const [index, [toolName]] of inputs(outside).entries()) {
		const request = f.permissionEvents[2 * index] as { requestId: string };
		assert.ok(request.requestId);
		for (const [phase, state] of ["waiting", "denied"].entries()) {
			assert.deepEqual(f.permissionEvents[2 * index + phase], { requestId: request.requestId, state, source: "tool_call",
				message: "Gentle AI safety policy requires confirmation for this tool call.", toolName });
		}
	}
	assert.equal(f.permissionEvents.length, 12);
});

test("headless outside access is denied without showing an ask", async t => {
	const f = fixture(t, { hasUI: false, approve: true });
	assert.deepEqual(await f.call("write", { path: outside, content: "fixture" }), headless(outside));
	assert.deepEqual(f.prompts, []);
	assert.deepEqual(f.permissionEvents, []);
});

test("inside targets pass without rewriting the tool input", async t => {
	const f = fixture(t, { hasUI: false });
	for (const [tool, input] of inputs("./subdir/file.txt")) {
		const original = structuredClone(input);
		assert.equal(await f.call(tool, Object.freeze(input)), undefined, tool);
		assert.deepEqual(input, original);
	}
	assert.equal(await f.call("ls", {}), undefined);
	assert.deepEqual(f.prompts, []);
});

test("the existing session registry admits a linked worktree in the same clone", async t => {
	const f = fixture(t, { hasUI: false });
	f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Fixture");
	const linked = join(f.dir, "linked");
	f.git("worktree", "add", "--quiet", "--detach", linked);
	const registry = new SessionWorktreeRegistry(f.pi, f.manager, f.repo);
	assert.equal(registry.register(linked, "explicit"), linked);
	assert.equal(await f.call("read", { path: join(linked, "file.md") }), undefined);
	assert.deepEqual(f.prompts, []);
});

test("session TMPDIR and exact files from both session skill indexes need no consent", async t => {
	const f = fixture(t, { hasUI: false, skills: true });
	// Use real checked-in skill files beyond this fixture's worktree. An isolated
	// HOME prevents the loose registry scan from consulting the developer's home.
	for (const [key, value] of Object.entries({ HOME: f.dir, USERPROFILE: f.dir, CODEX_HOME: process.cwd(), GENTLE_PI_NO_SKILL_REGISTRY: "0" })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	const native = join(process.cwd(), "skills", "branch-pr", "SKILL.md");
	const loose = join(process.cwd(), "skills", "chained-pr", "SKILL.md");
	const options = { skills: [{ name: "branch-pr", description: "A fixture skill", filePath: native }], appendSystemPrompt: "" };
	await f.emit("before_agent_start", { prompt: "Load indexed skill files", systemPrompt: "", systemPromptOptions: options });
	assert.match(options.appendSystemPrompt, /Effective session skills/);
	assert.ok(options.appendSystemPrompt.includes(loose));
	assert.equal(await f.call("write", { path: join(f.temp, "scratch.txt"), content: "fixture" }), undefined);
	for (const path of [native, loose]) assert.equal(await f.call("read", { path }), undefined, path);
	assert.deepEqual(await f.call("write", { path: loose, content: "fixture" }), headless(realpathSync(loose)));
	const other = join(process.cwd(), "skills", "chained-pr", "not-indexed.md");
	assert.deepEqual(await f.call("read", { path: other }), headless(join(realpathSync(process.cwd()), "skills", "chained-pr", "not-indexed.md")));
	assert.deepEqual(f.prompts, []);
});

test("a grant covers only the approved canonical target and only in the current session", async t => {
	const f = fixture(t, { approve: true });
	assert.equal(await f.call("read", { path: outside }), undefined);
	assert.equal(await f.call("write", { path: outside, content: "fixture" }), undefined);
	const other = join(outside, "other.md");
	assert.equal(await f.call("read", { path: other }), undefined);
	f.ctx.sessionManager = SessionManager.inMemory(f.repo);
	assert.equal(await f.call("read", { path: outside }), undefined);
	assert.deepEqual(f.prompts, [[title, outside], [title, other], [title, outside]]);
});

test("a relative dangling symlink to an outside file requests consent (#1659)", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t);
	const dangling = join(parse(outside).root, "__gentle_path_consent_dangling_fixture__.md");
	symlinkSync(relative(f.repo, dangling), join(f.repo, "alias"), "file");
	assert.deepEqual(await f.call("write", { path: "alias", content: "fixture" }), declined);
	assert.deepEqual(f.prompts, [[title, dangling]]);
	assert.equal(existsSync(dangling), false);
});

test("an empty or malformed durable registration cannot widen the worktree boundary (#1660)", async t => {
	const f = fixture(t, { hasUI: false });
	for (const root of ["", ".", "../repo", parse(outside).root]) {
		f.manager.appendCustomEntry(SESSION_WORKTREE_ENTRY, { sessionId: f.manager.getSessionId(), root, evidence: "malformed fixture" });
	}
	assert.deepEqual(await f.call("read", { path: outside }), headless(outside));
	assert.deepEqual(new SessionWorktreeRegistry(f.pi, f.manager, f.repo).roots(), []);
	assert.deepEqual(f.prompts, []);
});

test("a sensitive outside path still denies first with its existing message", async t => {
	const f = fixture(t, { approve: true });
	const path = join(outside, ".env");
	assert.deepEqual(await f.call("read", { path }), { block: true, reason: `Gentle AI safety policy blocked access to sensitive path: ${path}. Ask the user for an explicit safer plan.` });
	assert.deepEqual(f.prompts, []);
	assert.deepEqual(f.permissionEvents, []);
});

test("Normal asks for outside access and does not invoke Auto", async t => {
	const f = fixture(t, { mode: "normal", approve: true });
	assert.equal(await f.call("read", { path: outside }), undefined);
	assert.deepEqual(f.prompts, [[title, outside]]);
	assert.equal(f.classifications(), 0);
});

test("Auto still classifies after outside consent, and its denial still wins", async t => {
	const f = fixture(t, { mode: "auto", approve: true });
	assert.deepEqual(await f.call("read", { path: outside }), { block: true, reason: "Auto denied this action: Fixture restriction. Find a materially safer alternative within the request, or ask the user; do not pursue the same effect through another tool." });
	assert.deepEqual(f.prompts, [[title, outside]]);
	assert.equal(f.classifications(), 1);
});

test("YOLO allows non-sensitive outside reads and listings but not outside mutations", async t => {
	const f = fixture(t, { mode: "yolo" });
	for (const [tool, input] of inputs(outside)) assert.deepEqual(await f.call(tool, input), tool === "write" || tool === "edit" ? declined : undefined, tool);
	assert.deepEqual(f.prompts, [[title, outside], [title, outside]]);
	assert.equal(f.classifications(), 0);
});

test("Super Yolo waives outside permission asks, but not sensitive-path denials", async t => {
	const f = fixture(t, { mode: "super-yolo" });
	assert.equal(await f.call("write", { path: outside, content: "fixture" }), undefined);
	const path = join(outside, ".env");
	assert.deepEqual(await f.call("read", { path }), { block: true, reason: `Gentle AI safety policy blocked access to sensitive path: ${path}. Ask the user for an explicit safer plan.` });
	assert.deepEqual(f.prompts, []);
	assert.equal(f.classifications(), 0);
});
