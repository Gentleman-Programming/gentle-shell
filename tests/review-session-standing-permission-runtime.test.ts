import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import {
	captureReviewSessionIdentity,
	grantReviewSessionPermission,
	hasReviewSessionPermission,
} from "../lib/review-session-standing-permission.ts";

const LIFECYCLE_SYMBOL = Symbol.for("gentle-pi.test.review-session-permission-lifecycle");

interface LifecycleEvent {
	instance: number;
	type: "start" | "shutdown";
	reason: string;
	manager: object;
}

interface LifecycleState {
	nextInstance: number;
	events: LifecycleEvent[];
}

function scratch(t: test.TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-permission-runtime-")));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", root], { stdio: "ignore" }); } catch { /* best effort */ }
		rmSync(root, { recursive: true, force: true });
	});
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.invalid", "commit", "-m", "base"], { cwd, stdio: "ignore" });
	return { root, cwd: realpathSync(cwd), agentDir, sessionDir };
}

function testUi(statuses: Array<{ key: string; text?: string }>): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		notify() {},
		onTerminalInput: () => () => {},
		setStatus(key, text) { statuses.push({ key, text }); },
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom: async () => undefined,
		pasteToEditor() {},
		setEditorText() {},
		getEditorText: () => "",
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent: () => undefined,
		get theme() { return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never; },
		getAllThemes: () => [{ name: "runtime-test", path: undefined } as never],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not used" }),
		getToolsExpanded: () => false,
		setToolsExpanded() {},
	} as ExtensionUIContext;
}

async function identity(cwd: string, manager: SessionManager) {
	const captured = await captureReviewSessionIdentity({ cwd, mode: "tui", hasUI: true, sessionManager: manager }, {});
	assert.ok(captured);
	return captured;
}

test("actual Pi SDK loader preserves permission only across reload and disposes it on replacement lifecycles", async (t) => {
	const { cwd, agentDir, sessionDir } = scratch(t);
	const state: LifecycleState = { nextInstance: 0, events: [] };
	const globalState = globalThis as Record<symbol, unknown>;
	const previousLifecycle = globalState[LIFECYCLE_SYMBOL];
	globalState[LIFECYCLE_SYMBOL] = state;
	t.after(() => {
		if (previousLifecycle === undefined) delete globalState[LIFECYCLE_SYMBOL];
		else globalState[LIFECYCLE_SYMBOL] = previousLifecycle;
	});

	const extensionSource = pathToFileURL(join(import.meta.dirname, "..", "extensions", "gentle-ai.ts")).href;
	const extensionPath = join(agentDir, "extensions", "runtime-permission.ts");
	writeFileSync(extensionPath, `
import { createGentleAiExtension } from ${JSON.stringify(extensionSource)};
const lifecycle = globalThis[Symbol.for("gentle-pi.test.review-session-permission-lifecycle")];
const instance = ++lifecycle.nextInstance;
export default function (pi) {
  pi.on("session_start", (event, ctx) => lifecycle.events.push({ instance, type: "start", reason: event.reason, manager: ctx.sessionManager }));
  pi.on("session_shutdown", (event, ctx) => lifecycle.events.push({ instance, type: "shutdown", reason: event.reason, manager: ctx.sessionManager }));
  createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: {} })(pi);
}
`, "utf8");

	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentDir;
	t.after(() => {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	});
	const statuses: Array<{ key: string; text?: string }> = [];
	const uiContext = testUi(statuses);
	const bindings = { uiContext, mode: "tui" as const };
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			resourceLoaderOptions: {
				additionalExtensionPaths: [extensionPath],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const initialManager = SessionManager.create(cwd, sessionDir);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: initialManager });
	runtime.setRebindSession(async (session) => session.bindExtensions(bindings));
	await runtime.session.bindExtensions(bindings);
	const originalSessionFile = runtime.session.sessionFile;
	assert.ok(originalSessionFile);
	const initialIdentity = await identity(cwd, initialManager);
	assert.equal(grantReviewSessionPermission(initialIdentity), true);

	await runtime.session.reload();
	assert.equal(runtime.session.sessionManager, initialManager, "Pi reload must preserve the exact live SessionManager object");
	assert.equal(hasReviewSessionPermission(initialIdentity), true, "the global Symbol registry reconnects the new extension closure");
	assert.deepEqual(state.events.slice(0, 3).map(({ instance, type, reason }) => ({ instance, type, reason })), [
		{ instance: 1, type: "start", reason: "startup" },
		{ instance: 1, type: "shutdown", reason: "reload" },
		{ instance: 2, type: "start", reason: "reload" },
	]);
	assert.ok(statuses.some(({ text }) => text === "reviews allowed for this session"), "reload startup restores the visible nonblocking status");

	const firstEntry = initialManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
	initialManager.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
	await runtime.session.navigateTree(firstEntry, { summarize: false });
	assert.equal(runtime.session.sessionManager, initialManager);
	assert.equal(hasReviewSessionPermission(initialIdentity), true, "/tree stays inside the same session and retains permission");

	await runtime.newSession();
	assert.equal(hasReviewSessionPermission(initialIdentity), false);
	const newManager = runtime.session.sessionManager;
	const newIdentity = await identity(cwd, newManager);
	assert.equal(hasReviewSessionPermission(newIdentity), false);
	assert.equal(state.events.some(({ type, reason }) => type === "shutdown" && reason === "new"), true);
	assert.equal(state.events.some(({ type, reason }) => type === "start" && reason === "new"), true);

	grantReviewSessionPermission(newIdentity);
	await runtime.switchSession(originalSessionFile);
	assert.equal(hasReviewSessionPermission(newIdentity), false);
	const resumedIdentity = await identity(cwd, runtime.session.sessionManager);
	assert.equal(hasReviewSessionPermission(resumedIdentity), false);
	assert.equal(state.events.some(({ type, reason }) => type === "shutdown" && reason === "resume"), true);
	assert.equal(state.events.some(({ type, reason }) => type === "start" && reason === "resume"), true);

	runtime.session.sessionManager.resetLeaf();
	const resumedEntry = runtime.session.sessionManager.appendMessage({ role: "user", content: "fork point", timestamp: Date.now() });
	grantReviewSessionPermission(resumedIdentity);
	await runtime.fork(resumedEntry);
	assert.equal(hasReviewSessionPermission(resumedIdentity), false);
	const forkedIdentity = await identity(cwd, runtime.session.sessionManager);
	assert.equal(hasReviewSessionPermission(forkedIdentity), false);
	assert.equal(state.events.some(({ type, reason }) => type === "shutdown" && reason === "fork"), true);
	assert.equal(state.events.some(({ type, reason }) => type === "start" && reason === "fork"), true);

	grantReviewSessionPermission(forkedIdentity);
	await runtime.dispose();
	assert.equal(hasReviewSessionPermission(forkedIdentity), false);
	assert.equal(state.events.some(({ type, reason }) => type === "shutdown" && reason === "quit"), true);
});

test("a fresh Node process has no standing permission registry authority", async (t) => {
	const { cwd } = scratch(t);
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "review-session-standing-permission.ts")).href;
	const script = `
import { hasReviewSessionPermission } from ${JSON.stringify(moduleUrl)};
const manager = {};
process.stdout.write(String(hasReviewSessionPermission({ sessionManager: manager, sessionId: "restart", worktreeRoot: ${JSON.stringify(cwd)} })));
`;
	const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd, encoding: "utf8" });
	assert.equal(output, "false");
});
