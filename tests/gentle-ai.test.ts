import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { __testing, applyModelConfig, applyModelConfigAsync, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { PROFILES_KIND, PROFILES_VERSION, bootstrapProfilesFile, readProfilesFileResult, type AgentProfilesFile } from "../lib/agent-profiles.ts";
import { bindSessionProfile, readSessionProfileBinding, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import type { AgentModelConfig, AgentRoutingEntry, ThinkingLevel } from "../lib/model-routing-authority.ts";
type LiveSession = Pick<ExtensionAPI, "setModel" | "setThinkingLevel" | "getThinkingLevel">;
import { PROFILE_PIN_KIND, PROFILE_PIN_VERSION, setProfilePinWorktreeResolverForTesting, writeProfilePinSync } from "../lib/agent-profile-pin.ts";
import { NATIVE_REVIEW_ERROR_CODE, NativeReviewCliError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewError, type CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { installPackageAssets } from "../lib/agent-assets.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { cardBody, cardTitle, cardTone } from "./gentle-card-text.ts";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

initTheme("dark");

// Observe the actual UI boundary, not a guessed number of identity-read microtasks.
function confirmationObserver() {
	let count = 0;
	const listeners = new Set<() => void>();
	return {
		observe() { count++; for (const listener of listeners) listener(); },
		waitFor(expected: number): Promise<void> {
			if (count >= expected) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const deadline = setTimeout(() => {
					listeners.delete(check);
					reject(new Error(`Confirmation deadline: expected ${expected}, observed ${count}`));
				}, 1000);
				const check = () => {
					if (count < expected) return;
					clearTimeout(deadline);
					listeners.delete(check);
					resolve();
				};
				listeners.add(check);
			});
		},
	};
}

function writeMarkdown(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const lifecycleTheme = {
	bold(value: string): string {
		return value;
	},
	fg(color: string, value: string): string {
		return `<${color}>${value}</${color}>`;
	},
};

function renderComponent(component: { render(width: number): string[] }): string {
	return component.render(120).map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function registeredGentleTools(): Map<string, any> {
	const tools = new Map<string, any>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	return tools;
}

function lifecycleContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		executionStarted: false,
		isPartial: true,
		isError: false,
		lastComponent: undefined,
		...overrides,
	};
}

// gentle-pi#874: the provider's fresh_target_ready offer. The argument order
// mirrors the live selectorless STATUS a clean, fully committed worktree
// receives: it names the merge-base it wants so a plain START can adopt it.
function offeredCommittedRangeStatus(baseRef: string, baseTree: string, candidateTree: string, paths: readonly string[] = ["app.ts"]): ReviewStatusV3 {
	const targetIdentity = `sha256:${"a".repeat(64)}`;
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "unrelated",
		action: "start",
		replayability: "not_replayable",
		targetIdentity,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "base-diff",
			projection: "workspace",
			baseTree,
			initialReviewTree: candidateTree,
			currentCandidateTree: candidateTree,
			pathsDigest: `sha256:${"b".repeat(64)}`,
			paths: [...paths],
			intendedUntracked: [],
			intendedUntrackedProof: `sha256:${"c".repeat(64)}`,
			initialSnapshotIdentity: `sha256:${"d".repeat(64)}`,
			currentSnapshotIdentity: `sha256:${"d".repeat(64)}`,
		},
		candidates: [],
		nextTransition: {
			kind: "execute",
			reasonCode: "fresh_target_ready",
			execute: {
				operation: "review.start",
				arguments: [
					{ name: "target", value: targetIdentity, token: `--target=${targetIdentity}` },
					{ name: "target-evidence", value: `v1:base-diff:workspace:${baseTree}:${candidateTree}:sha256:${"e".repeat(64)}`, token: `--target-evidence=v1:base-diff:workspace:${baseTree}:${candidateTree}:sha256:${"e".repeat(64)}` },
					{ name: "projection", value: "workspace", token: "--projection=workspace" },
					{ name: "base-ref", value: baseRef, token: `--base-ref=${baseRef}` },
					{ name: "committed-only", value: "true", token: "--committed-only=true" },
					{ name: "lineage", value: "review-offered", token: "--lineage=review-offered" },
					{ name: "agent", value: "pi", token: "--agent=pi" },
					{ name: "consent", value: "relay", token: "--consent=relay" },
				],
				preconditions: [],
				binding: { targetIdentity },
			},
		},
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
}

// The clean, fully committed worktree STATUS with no committed-range offer:
// the current-changes candidate view a plain START builds today.
function cleanWorkspaceStatus(headTree: string, nextTransition?: ReviewStatusV3["nextTransition"]): ReviewStatusV3 {
	const targetIdentity = `sha256:${"a".repeat(64)}`;
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "unrelated",
		action: "start",
		replayability: "not_replayable",
		targetIdentity,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: headTree,
			initialReviewTree: headTree,
			currentCandidateTree: headTree,
			pathsDigest: `sha256:${"b".repeat(64)}`,
			paths: [],
			intendedUntracked: [],
			intendedUntrackedProof: `sha256:${"c".repeat(64)}`,
			initialSnapshotIdentity: `sha256:${"d".repeat(64)}`,
			currentSnapshotIdentity: `sha256:${"d".repeat(64)}`,
		},
		candidates: [],
		...(nextTransition === undefined ? {} : { nextTransition }),
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
}

function startedReviewResult(): Record<string, unknown> {
	return { lineageId: "adopted-range", state: "reviewing", riskLevel: "low", selectedLenses: [], changedFiles: 1, changedLines: 1, correctionBudget: 1, action: "created", lensesRequired: false, riskReasons: [], raw: {} };
}

interface ReviewStartRepository {
	cwd: string;
	baseCommit: string;
	baseTree: string;
	headTree: string;
}

// A hermetic two-commit repository whose candidate range is a real committed
// change, so both the adopted and explicit base-ref paths resolve through the
// real candidate-view guard.
function reviewRepository(t: test.TestContext): ReviewStartRepository {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-review-start-")));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", cwd], { stdio: "ignore" }); } catch { /* best effort */ }
		rmSync(cwd, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit", "-m", "base"], { cwd, stdio: "ignore" });
	const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	execFileSync("git", ["add", "app.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid", "commit", "-m", "candidate"], { cwd, stdio: "ignore" });
	return {
		cwd,
		baseCommit,
		baseTree: execFileSync("git", ["rev-parse", `${baseCommit}^{tree}`], { cwd, encoding: "utf8" }).trim(),
		headTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim(),
	};
}

test("missing package-local binaries give a direct recovery without attributing the cause to lifecycle scripts", async () => {
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "inspect" },
		process.cwd(),
		{
			targetStatus: async () => {
				throw new NativeReviewCliError(
					NATIVE_REVIEW_ERROR_CODE.PACKAGE_BINARY_MISSING,
					"review/status",
					false,
					false,
					"package binary missing",
				);
			},
		} as unknown as NativeReviewCli,
	);

	assert.equal(result.outcome, "native-status-package-binary-missing");
	assert.equal(result.recovery_command, "node scripts/install-gentle-ai.mjs");
	assert.match(String(result.next_action), /installed gentle-pi package directory/);
	assert.match(String(result.next_action), /GENTLE_PI_SKIP_GENTLE_AI_INSTALL/);
	assert.match(String(result.next_action), /remove or unset it before/);
	assert.match(String(result.reason), /does not prove install lifecycle scripts were disabled/);
});

test("registered Gentle Review tools render reusable rose lifecycle call rows", () => {
	const tools = registeredGentleTools();
	const cases = [
		["gentle_review", { operation: "status" }, "status"],
		["gentle_review", { operation: "future-operation", secret: "/private" }, ""],
		["gentle_review_scope", {}, "scope"],
		["gentle_review_capture_group", {}, "capture group"],
		[
			"gentle_review_capture",
			{
				lineageId: "lineage-id",
				collectBinding: "binding-id",
				sha256: "sha256:hash-value",
				secret: "secret-value",
				arbitrary: "arbitrary-value",
			},
			"capture",
		],
	] as const;

	// This exhaustiveness check is scoped to the gentle_review* lifecycle
	// family this test names, not every gentle_-prefixed tool: gentle_odd_phase
	// is a plain status-report tool with no pending/running/failed rose
	// lifecycle card of its own (see extensions/gentle-ai.ts).
	assert.deepEqual(
		[...new Set(cases.map(([name]) => name))].sort(),
		[...tools.keys()].filter((name) => name.startsWith("gentle_review")).sort(),
	);

	for (const [name, args, operation] of cases) {
		const tool = tools.get(name);
		const title = (status: string) => ["🌹 rdd", [status, operation].filter(Boolean).join(" · ")].filter(Boolean).join(" ");
		assert.ok(tool, `missing ${name}`);
		const initial = tool.renderCall(args, lifecycleTheme, lifecycleContext());
		const initialText = renderComponent(initial);
		const running = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, lastComponent: initial }),
		);
		const runningText = renderComponent(running);
		const completed = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, isPartial: false, lastComponent: running }),
		);
		const completedText = renderComponent(completed);
		const failed = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, isPartial: false, isError: true, lastComponent: completed }),
		);
		const failedText = renderComponent(failed);

		assert.strictEqual(initial, running);
		assert.strictEqual(running, completed);
		assert.strictEqual(completed, failed);
		assert.equal(cardTitle(initialText), title("running")); assert.equal(cardTone(initialText), "warning");
		assert.equal(cardTitle(runningText), title("running")); assert.equal(cardTone(runningText), "warning");
		assert.equal(cardTitle(completedText), title("")); assert.equal(cardTone(completedText), "success");
		assert.doesNotMatch(cardTitle(completedText), /completed/);
		assert.match(completedText, /to expand/);
		assert.equal((initialText.match(/╰/g) ?? []).length, 1, "running call owns the closing frame");
		assert.equal((completedText.match(/╰/g) ?? []).length, 0, "final result owns the closing frame");
		assert.equal(cardTitle(failedText), title("failed")); assert.equal(cardTone(failedText), "error");
		assert.doesNotMatch(renderComponent(failed), /future-operation|secret|private/);
		for (const forbiddenValue of ["lineage-id", "binding-id", "sha256:hash-value", "secret-value", "arbitrary-value"]) {
			assert.doesNotMatch(failedText, new RegExp(forbiddenValue));
		}
	}
});

test("registered Gentle Review tools preserve result envelopes and preview useful collapsed results", async () => {
	const tools = registeredGentleTools();
	const scope = tools.get("gentle_review_scope");
	const manifest = { version: 1, scopeByMode: { "100644": ["src/file.ts"] }, gitlinks: {} };
	const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
	const encoded = gzipSync(bytes).toString("base64url");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	const result = await scope.execute(
		"scope-call",
		{ manifest: encoded, sha256, cursor: 0 },
		undefined,
		undefined,
		{ cwd: process.cwd() } as unknown as ExtensionContext,
	);
	const visibleEnvelope = JSON.parse(result.content[0].text);
	assert.deepEqual(visibleEnvelope, {
		version: 1,
		sha256,
		cursor: 0,
		totalPaths: 1,
		entries: [{ path: "src/file.ts", mode: "100644" }],
	});
	assert.deepEqual(result.details, visibleEnvelope);

	const resultText = "safe result\x1b[31m\nlineage=secret body=private\nthird useful detail\nfourth expanded detail";
	for (const name of ["gentle_review", "gentle_review_scope", "gentle_review_capture"]) {
		const tool = tools.get(name);
		assert.equal(typeof tool?.renderResult, "function", `${name} must define result rendering`);
		for (const options of [
			{ expanded: false, isPartial: true, isError: false },
			{ expanded: false, isPartial: false, isError: false },
			{ expanded: false, isPartial: false, isError: true },
		]) {
			const collapsed = renderComponent(tool.renderResult({ content: [{ type: "text", text: resultText }] }, options, lifecycleTheme, {}));
			const collapsedBody = cardBody(collapsed);
			assert.match(collapsedBody, /safe result[\s\S]*lineage=secret body=private[\s\S]*third useful detail/, `${name} previews actual result content, not redaction`);
			assert.doesNotMatch(collapsedBody, /\d+ lines?\b|fourth expanded detail|to expand|\x1b\[/);
			assert.equal(collapsedBody.split("\n").length, 3, `${name} has three useful collapsed rows`);
			assert.match(collapsed, new RegExp(`<${options.isError ? "error" : options.isPartial ? "warning" : "success"}>│`), "host outcome preserves the semantic frame tone");
			assert.equal((collapsed.match(/╰/g) ?? []).length, options.isPartial ? 0 : 1, "only final results close the frame");
		}
		const expanded = renderComponent(tool.renderResult({ content: [{ type: "text", text: resultText }] }, { expanded: true, isPartial: false, isError: true }, lifecycleTheme, {}));
		assert.equal(cardBody(expanded).split("\n")[0], "<error>safe result</error>");
		assert.match(expanded, /safe result/);
		assert.match(expanded, /lineage=secret body=private[\s\S]*third useful detail[\s\S]*fourth expanded detail/);
		assert.equal((expanded.match(/╰/g) ?? []).length, 1, "expanded final result closes exactly one frame");
		assert.doesNotMatch(expanded, /to expand/);
		assert.doesNotMatch(cardBody(expanded), /\x1b\[/);
		const nonText = renderComponent(tool.renderResult({ content: [{ type: "image", data: "opaque", mimeType: "image/png" }] }, { expanded: true, isPartial: false }, lifecycleTheme, {}));
		assert.equal(cardBody(nonText), "");
		const empty = renderComponent(tool.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, lifecycleTheme, {}));
		assert.equal(cardBody(empty), "");
	}
});

interface RoutingConsumerPanel {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse?(event: {
		type: "move" | "click" | "press" | "wheel";
		x: number;
		y: number;
		button?: string;
		wheelDelta?: number;
		screenX?: number;
		screenY?: number;
		width?: number;
		height?: number;
	}): { handled?: boolean; render?: boolean } | undefined;
}

function routingConsumerFixture(t: test.TestContext, agents = ["worker"]) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-routing-consumers-"));
	const configHome = join(root, "global");
	const agentHome = join(root, "agent-home");
	const projectPath = join(root, ".pi", "gentle-ai", "models.json");
	const globalPath = join(configHome, "models.json");
	const exportPath = join(configHome, "models.export.json");
	for (const dir of [dirname(projectPath), join(root, "agents"), join(agentHome, "agents"), join(agentHome, "subagents")]) {
		mkdirSync(dir, { recursive: true });
	}
	for (const name of agents) {
		writeMarkdown(join(root, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: Worker\n---\nbody\n`);
	}
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const isolatedHome = join(root, "home");
	mkdirSync(isolatedHome, { recursive: true });
	// Isolate homedir-based discovery on POSIX and Windows.
	// Package-sibling legacy agents remain subject to discovery assertions.
	process.env.HOME = isolatedHome;
	process.env.USERPROFILE = isolatedHome;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	// The live session seam a profile apply drives: Pi's own setModel and
	// setThinkingLevel on the ExtensionAPI move the session the user is in.
	const liveSwitches: Array<{ kind: "model"; provider: string; id: string } | { kind: "thinking"; level: string }> = [];
	let setModelResult = true;
	let thinkingRejects = false;
	let liveThinking = "medium";
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool() {},
		registerCommand(name, command) { commands.set(name, command); },
		setModel: async (model: { provider: string; id: string }) => { liveSwitches.push({ kind: "model", provider: model.provider, id: model.id }); return setModelResult; },
		getThinkingLevel: () => liveThinking,
		setThinkingLevel: (level: string) => {
			if (thinkingRejects) throw new Error(`thinking level ${level} is not supported by this model`);
			liveSwitches.push({ kind: "thinking", level });
		},
	} as unknown as ExtensionAPI);
	const notifications: Array<{ message: string; severity: string }> = [];
	// The profiles panel reads the terminal rows to size its full-screen frame, so
	// the fake UI hands every factory a TUI-shaped stand-in with a mutable height.
	const fixtureTui = { terminal: { rows: 24 }, requestRender() {} };
	let panelVisits = 0;
	const panels: string[] = [];
	let onPanel = () => ({ type: "cancel", config: {} });
	let onInput: ((panel: RoutingConsumerPanel) => void) | undefined;
	// Scripted answers for ctx.ui.input, consumed in order. The Pi host ignores the
	// placeholder and starts the field empty, so an empty answer is what Enter on an
	// untouched field returns, and undefined is Esc.
	const inputAnswers: Array<string | undefined> = [];
	const inputPrompts: Array<{ title: string; placeholder: string | undefined }> = [];
	// The models screen binds the session profile through the parent session id; a
	// test can point it at another session (or none) without rebuilding the context.
	let sessionId: string | undefined = "session-panel";
	// The orchestrator model is looked up in the registry before switching.
	const registryModels = [
		{ provider: "openai", id: "alpha" },
		{ provider: "openai", id: "beta" },
		{ provider: "nan", id: "glm5.3" },
	];
	let onConfirm: (title: string, message: string) => Promise<boolean> = async () => true;
	const confirmCalls: Array<[string, string]> = [];
	const ctx = {
		cwd: root,
		hasUI: true,
		// A real Pi session always has an id; the profiles panel resolves the
		// session binding through it, so the fixture models one stable session.
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			getAvailable: async () => registryModels.filter((model) => model.provider === "openai"),
			find: (provider: string, id: string) => registryModels.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			confirm: async (title: string, message: string) => {
				confirmCalls.push([title, message]);
				return onConfirm(title, message);
			},
			notify(message: string, severity: string) { notifications.push({ message, severity }); },
			input: async (title: string, placeholder?: string) => {
				inputPrompts.push({ title, placeholder });
				assert.ok(inputAnswers.length > 0, `unexpected input prompt: ${title}`);
				return inputAnswers.shift();
			},
			custom: async (factory: (tui: unknown, theme: Theme, keybindings: unknown, done: (result: unknown) => void) => RoutingConsumerPanel) => {
				let result: unknown;
				const panel = factory(fixtureTui, { fg: (_color: string, text: string) => text } as unknown as Theme, undefined, (value) => { result = value; });
				panels.push(stripAnsi(renderComponent(panel)));
				panelVisits += 1;
				if (onInput) {
					onInput(panel);
					assert.notEqual(result, undefined, "panel input must finish the interaction");
					return result;
				}
				return onPanel();
			},
		},
	} as unknown as Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];
	return {
		root, agentHome, configHome, projectPath, globalPath, exportPath, notifications, panels,
		tui: fixtureTui as { terminal: { rows: number } },
		panelVisits: () => panelVisits,
		liveSwitches,
		setLiveModel(provider: string, id: string, thinking: string) {
			(ctx as { model?: { provider: string; id: string } }).model = { provider, id };
			liveThinking = thinking;
		},
		refuseSetModel() { setModelResult = false; },
		rejectThinkingLevel() { thinkingRejects = true; },
		confirmCalls,
		onConfirm(handler: (title: string, message: string) => Promise<boolean>) { onConfirm = handler; },
		onPanel(action: typeof onPanel) { onPanel = action; },
		onInput(action: (panel: RoutingConsumerPanel) => void) { onInput = action; },
		answerInputs(...answers: Array<string | undefined>) { inputAnswers.push(...answers); },
		inputPrompts,
		setSessionId(next: string | undefined) { sessionId = next; },
		run: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
	};
}

const RIGHT_KEY = "\x1b[C";

function typeInto(panel: { handleInput(data: string): void }, text: string): void {
	for (const character of text) panel.handleInput(character);
}

test("models screen saves and clears provider review roles into the profile store without local artifacts", async (t) => {
	const fixture = routingConsumerFixture(t, []);
	const roles = ["review-refuter", "review-validator"];
	assert.deepEqual(
		__testing.listDiscoverableAgents(fixture.root).map((agent) => agent.name),
		[],
		"requires zero discovered agents; check package-sibling legacy agent directories",
	);

	const storePath = join(fixture.configHome, "profiles.json");
	const assertNoLocalArtifacts = () => {
		for (const base of [join(fixture.root, ".pi"), fixture.agentHome]) {
			assert.equal(existsSync(join(base, "subagents.json")), false);
			for (const dir of ["agents", "subagents"]) {
				for (const role of roles) {
					assert.equal(existsSync(join(base, dir, `${role}.md`)), false);
				}
			}
		}
		assert.equal(existsSync(fixture.globalPath), false, "routing edits stay in the profile store until an explicit apply");
	};

	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			// Rows: orchestrator, set-every-agent header, then the two roles.
			panel.handleInput("j");
			panel.handleInput("j");
			for (const [index, model] of ["alpha", "beta"].entries()) {
				if (index > 0) panel.handleInput("j");
				panel.handleInput("\r"); // model card for the role
				assert.match(renderComponent(panel), /Pi persisted default model/);
				assert.doesNotMatch(renderComponent(panel), /Inherit active\/default model/);
				typeInto(panel, model);
				panel.handleInput("\r");
				panel.handleInput("e"); // effort strip for the same role
				assert.match(renderComponent(panel), /Pi persisted default effort/);
				for (let step = 0; step <= index; step++) panel.handleInput(RIGHT_KEY);
				panel.handleInput("\r");
			}
			panel.handleInput("\x13"); // save the draft into the profile
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(visits, 2);
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.current, {
		"review-refuter": { model: "openai/alpha", thinking: "off" },
		"review-validator": { model: "openai/beta", thinking: "minimal" },
	});
	assertNoLocalArtifacts();

	// Clearing entries stays in the store, too.
	visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			panel.handleInput("j");
			panel.handleInput("j");
			for (const role of roles) {
				if (role !== "review-refuter") panel.handleInput("j");
				panel.handleInput("\r"); // model card; the cursor starts on the current value
				for (let step = 0; step < 10; step++) panel.handleInput("\x1b[A"); // up to the inherit label, first in the list
				assert.match(renderComponent(panel), /▸ Pi persisted default model/);
				panel.handleInput("\r");
				panel.handleInput("e");
				for (let step = 0; step < 10; step++) panel.handleInput("\x1b[D"); // back to inherit, first in the row
				panel.handleInput("\r");
			}
			panel.handleInput("\x13");
		} else panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.current, {
		"review-refuter": {},
		"review-validator": {},
	});
	assertNoLocalArtifacts();
});

test("provider review roles skip migration and both projection paths even when discoverable", async (t) => {
	const roles = ["review-refuter", "review-validator"];
	const fixture = routingConsumerFixture(t, [...roles, "worker"]);
	assert.deepEqual(
		__testing.listDiscoverableAgents(fixture.root).map((agent) => agent.name).sort(),
		[...roles, "worker"].sort(),
		"requires only seeded agents; check package-sibling legacy agent directories",
	);

	const rolePaths = roles.map((role) => join(fixture.root, ".pi", "agents", `${role}.md`));
	const originals = rolePaths.map((path) => readFileSync(path, "utf8"));
	const profilePaths = [
		join(fixture.root, ".pi", "subagents.json"),
		join(fixture.agentHome, "subagents.json"),
	];
	const profile = `${JSON.stringify({ model_profiles: {
		"review-refuter": "existing-refuter",
		"review-validator": "existing-validator",
	} }, null, 2)}\n`;
	for (const path of profilePaths) writeMarkdown(path, profile);
	const assignments = {
		"review-refuter": { model: "openai/alpha", thinking: "off" as const },
		"review-validator": { model: "openai/beta", thinking: "minimal" as const },
	};
	writeMarkdown(join(fixture.root, ".pi", "settings.json"), JSON.stringify({
		subagents: { agentOverrides: assignments },
	}));
	const assertReservedUnchanged = () => {
		rolePaths.forEach((path, index) => assert.equal(readFileSync(path, "utf8"), originals[index]));
		for (const path of profilePaths) assert.equal(readFileSync(path, "utf8"), profile);
	};
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			// Rows: orchestrator, set-every-agent header, then the roles and worker.
			const table = renderComponent(panel);
			for (const role of roles) assert.equal(table.split(role).length - 1, 1);
			assert.match(table, /worker\s+inherit/, "a discoverable agent with no profile entry reads as inherit");
			panel.handleInput("\x1b");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(visits, 1);
	assertReservedUnchanged();
	for (const apply of [applyModelConfig, applyModelConfigAsync]) {
		await apply(fixture.root, assignments);
		assertReservedUnchanged();
		await apply(fixture.root, { "review-refuter": {}, "review-validator": {} });
		assertReservedUnchanged();
	}
	await applyModelConfigAsync(fixture.root, { worker: { model: "openai/alpha" } });
	assert.match(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), /model: openai\/alpha/);
	assert.ok(JSON.parse(readFileSync(profilePaths[0], "utf8")).model_profiles.worker);
});

test("an invalid saved routing file does not block the models screen", async (t) => {
	const fixture = routingConsumerFixture(t);
	writeFileSync(fixture.projectPath, "[]");
	fixture.onInput((panel) => panel.handleInput("\x1b"));
	await fixture.run("gentle:profiles");
	assert.equal(fixture.panelVisits(), 1, "Make default discloses the unreadable routing instead");
});

test("models export re-reads saved routing and rejects invalid project before creating its destination parent", async (t) => {
	const fixture = routingConsumerFixture(t);
	writeFileSync(fixture.projectPath, "[]");
	await fixture.run("gentle:profiles", "export-routing");
	assert.equal(fixture.panelVisits(), 0, "export is a subcommand: no screen opens");
	const exportWarning = fixture.notifications.find((entry) => entry.severity === "warning");
	assert.equal(exportWarning?.severity, "warning");
	assert.ok(exportWarning?.message.includes(`Invalid model config: ${fixture.projectPath}`));
	assert.equal(existsSync(fixture.exportPath), false);
});

test("status reports invalid saved routing path instead of default agent routing", async (t) => {
	const fixture = routingConsumerFixture(t);
	writeFileSync(fixture.projectPath, "[]");
	await fixture.run("gentle:status");
	const report = fixture.notifications.at(-1)!;
	assert.match(report.message, /Saved model routing: invalid/);
	assert.ok(report.message.includes(fixture.projectPath));
	assert.equal(report.severity, "warning");
	assert.doesNotMatch(report.message, /worker: model=/);
});

test("models exports missing, normalized project, and global-precedence saved routing", async (t) => {
	for (const source of ["missing", "project", "global"] as const) {
		await t.test(source, async (t) => {
			const fixture = routingConsumerFixture(t);
			if (source !== "missing") writeFileSync(fixture.projectPath, '{"worker":" openai/gpt-5 ","ignored":null}');
			if (source === "global") writeMarkdown(fixture.globalPath, '{"worker":{"model":" anthropic/opus ","thinking":"high"}}');
			await fixture.run("gentle:profiles", "export-routing");
			const agents = source === "missing" ? {} : source === "project"
				? { worker: { model: "openai/gpt-5" } }
				: { worker: { model: "anthropic/opus", thinking: "high" } };
			assert.deepEqual(JSON.parse(readFileSync(fixture.exportPath, "utf8")).agents, agents);
			const exported = fixture.notifications.find((entry) => /exported/.test(entry.message));
			assert.equal(exported?.severity, "info");
			assert.equal(fixture.panelVisits(), 0);
			await fixture.run("gentle:status");
			const report = fixture.notifications.at(-1)!.message;
			assert.ok(report.includes(`Saved model routing: ${source === "missing" ? "missing" : "valid"}`));
			assert.ok(report.includes(`Global model config: ${source === "global" ? "present" : "missing"}`));
			const expectedRouting = source === "missing" ? "inherit, effort=inherit"
				: source === "project" ? "openai/gpt-5, effort=inherit" : "anthropic/opus, effort=high";
			assert.ok(report.includes(`worker: model=${expectedRouting}`), report);
		});
	}
});

test("invalid global routing overrides valid project in models, status, and export re-read", async (t) => {
	for (const atExport of [false, true]) {
		await t.test(atExport ? "export" : "screen", async (t) => {
			const fixture = routingConsumerFixture(t);
			writeFileSync(fixture.projectPath, '{"worker":"openai/gpt-5"}');
			writeMarkdown(fixture.globalPath, "[]");
			fixture.onInput((panel) => panel.handleInput("\x1b"));
			await fixture.run("gentle:profiles", atExport ? "export-routing" : "");
			if (atExport) {
				const routingWarning = fixture.notifications.find((entry) => entry.severity === "warning");
				assert.equal(routingWarning?.severity, "warning");
				assert.ok(routingWarning?.message.includes(fixture.globalPath));
				assert.match(routingWarning!.message, /export failed/);
			}
			assert.equal(fixture.panelVisits(), atExport ? 0 : 1, "export opens no screen; the screen opens and Make default discloses the unreadable routing");
			assert.equal(existsSync(fixture.exportPath), false);
			await fixture.run("gentle:status");
			const report = fixture.notifications.at(-1)!;
			assert.match(report.message, /Global model config: present\nSaved model routing: invalid/);
			assert.ok(report.message.includes(fixture.globalPath));
			assert.doesNotMatch(report.message, /worker: model=/);
			assert.equal(report.severity, "warning");
		});
	}
});

test("session startup reports invalid project routing without mutating the profile", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-startup-"));
	const configHome = join(root, "global");
	const projectConfigDir = join(root, ".pi", "gentle-ai");
	const projectAgentsDir = join(root, ".pi", "agents");
	const projectProfileDir = join(root, ".pi");
	const rootAgentsDir = join(root, "agents");
	const agentHome = join(root, "agent-home");
	const agentHomeAgentsDir = join(agentHome, "agents");
	const agentHomeSubagentsDir = join(agentHome, "subagents");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });
	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(projectProfileDir, { recursive: true });
	mkdirSync(rootAgentsDir, { recursive: true });
	mkdirSync(agentHomeAgentsDir, { recursive: true });
	mkdirSync(agentHomeSubagentsDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	});

	writeFileSync(join(projectConfigDir, "models.json"), "[]");
	writeMarkdown(join(projectAgentsDir, "worker.md"), "---\nname: worker\ndescription: Worker\n---\nbody\n");
	const profilePath = join(projectProfileDir, "subagents.json");
	const profileBytes = `${JSON.stringify({ unrelated: { keep: true } }, null, 2)}\n`;
	writeFileSync(profilePath, profileBytes);
	const before = readFileSync(profilePath, "utf8");

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_PI_AGENTS_CHILD: "0" } })(pi);
	const sessionStart = handlers.get("session_start");
	assert.equal(typeof sessionStart, "function");
	const notifications: Array<{ message: string; severity: string }> = [];
	await sessionStart!({}, {
		cwd: root,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext);

	const warning = notifications.find((entry) => entry.message.includes(join(projectConfigDir, "models.json")));
	assert.ok(warning, JSON.stringify(notifications));
	assert.equal(warning!.severity, "warning");
	assert.match(warning!.message, /skipped model config/);
	assert.equal(readFileSync(profilePath, "utf8"), before);

	writeFileSync(join(projectConfigDir, "models.json"), '{"worker":"openai/gpt-5"}');
	const globalPath = join(configHome, "models.json");
	writeFileSync(globalPath, "[]");
	notifications.length = 0;
	await sessionStart!({}, {
		cwd: root,
		hasUI: true,
		ui: { notify(message: string, severity: string) { notifications.push({ message, severity }); } },
	} as unknown as ExtensionContext);
	const globalWarning = notifications.find((entry) => entry.message.includes(globalPath));
	assert.ok(globalWarning, JSON.stringify(notifications));
	assert.equal(globalWarning.severity, "warning");
	assert.match(globalWarning.message, /skipped model config/);
	assert.equal(readFileSync(profilePath, "utf8"), before);
});

test("agent discovery skips skills directories", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-agents-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dotAgents = join(root, ".agents");
	writeMarkdown(join(dotAgents, "review-risk.md"), "name: review-risk\n");
	writeMarkdown(join(dotAgents, "team", "worker.md"), "name: worker\n");
	writeMarkdown(join(dotAgents, "skills", "ai-sdk", "SKILL.md"), "name: ai-sdk\n");
	writeMarkdown(
		join(dotAgents, "skills", "ai-sdk", "references", "evaluation.md"),
		"name: Prompt Evaluation\n",
	);

	const syncAgents = __testing.listAgentsFromDir(dotAgents, "user");
	const asyncAgents = await __testing.listAgentsFromDirAsync(dotAgents, "user");

	assert.deepEqual(
		syncAgents.map((agent) => agent.name),
		["review-risk", "worker"],
	);
	assert.deepEqual(
		asyncAgents.map((agent) => agent.name),
		["review-risk", "worker"],
	);
});

test("managed routing timeout leaves its profile, agent, and manifest unchanged", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-managed-routing-timeout-"));
	const agentHome = join(root, "agent-home");
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	t.after(() => {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(root, { recursive: true, force: true });
	});

	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	installPackageAssets(root, false, ["delegation"]);
	const agentPath = join(agentHome, "agents", "gentle-ai-worker.md");
	const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
	const profilePath = join(agentHome, "subagents.json");
	const profileBefore = "{\n  \"unrelated\": true\n}\n";
	writeFileSync(profilePath, profileBefore);
	const agentBefore = readFileSync(agentPath, "utf8");
	const manifestBefore = readFileSync(manifestPath, "utf8");
	writeFileSync(
		join(agentHome, "gentle-ai", "managed-assets.lock"),
		JSON.stringify({ schemaVersion: 1, token: "foreign", pid: process.pid, createdAtMs: Date.now() }),
	);

	assert.throws(
		() => applyModelConfig(root, { "gentle-ai-worker": { model: "test/managed", thinking: "high" } }),
		/Timed out acquiring managed-assets lock file/i,
	);
	assert.equal(readFileSync(profilePath, "utf8"), profileBefore);
	assert.equal(readFileSync(agentPath, "utf8"), agentBefore);
	assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("a later alias keeps managed-root precedence and manifest ownership", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-agent-root-alias-"));
	const agentHome = join(root, "agent-home");
	const home = join(root, "home");
	const cwd = join(root, "project");
	const managed = join(agentHome, "agents");
	const intervening = join(agentHome, "subagents");
	const alias = join(home, ".agents");
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	t.after(() => {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		rmSync(root, { recursive: true, force: true });
	});

	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	installPackageAssets(cwd, false, ["delegation"]);
	writeMarkdown(join(intervening, "gentle-ai-worker.md"), "---\nname: gentle-ai-worker\n---\nintervening override\n");
	mkdirSync(home, { recursive: true });
	try {
		symlinkSync(managed, alias, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		t.skip(`directory aliases unavailable: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	const selected = __testing.listDiscoverableAgents(cwd).find((agent) => agent.name === "gentle-ai-worker");
	assert.equal(selected?.filePath, join(managed, "gentle-ai-worker.md"));
	applyModelConfig(cwd, { "gentle-ai-worker": { model: "test/managed", thinking: "high" } });
	const manifest = JSON.parse(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8")) as { assets: Record<string, string> };
	const routed = readFileSync(join(managed, "gentle-ai-worker.md"), "utf8");
	assert.match(routed, /^model: test\/managed$/m);
	assert.equal(manifest.assets["agents/gentle-ai-worker.md"], createHash("sha256").update(routed).digest("hex"));
});

test("runtime guidance keeps review policy out of the static orchestrator and technical reference", () => {
	const staticReferences = ["docs/readme-reference.md", "skills/gentle-ai/SKILL.md"];
	assert.match(readFileSync("README.md", "utf8"), /\]\(docs\/readme-reference\.md(?:#[^)]+)?\)/);
	const forbiddenGenericRoutes = [
		/fresh-context `reviewer`/,
		/fresh reviewer audits/,
		/reviewer fresh audits/,
		/run a fresh-context `reviewer`/,
	];

	for (const file of staticReferences) {
		const content = readFileSync(file, "utf8");
		assert.match(content, /Review Lens Selection|review lens/);
		assert.match(content, /review-risk/);
		assert.match(content, /review-reliability/);
		assert.match(content, /review-resilience/);
		assert.match(content, /review-readability/);
		for (const forbidden of forbiddenGenericRoutes) {
			assert.doesNotMatch(content, forbidden, `${file} must not route to generic reviewer`);
		}
	}

	const orchestrator = readFileSync("assets/orchestrator.md", "utf8")
		+ readDelegationDetail();
	assert.match(orchestrator, /injects the mirrored provider-bundle review execution contract/);
	assert.match(orchestrator, /this package invents no lifecycle instructions/);
	for (const lifecycleMarker of ["review-risk", "review-reliability", "review-resilience", "review-readability", "Authority-First Terminal Procedure", "reconcile-terminal-mirrors"]) {
		assert.doesNotMatch(orchestrator, new RegExp(lifecycleMarker), `static orchestrator must not mirror ${lifecycleMarker}`);
	}
});

test("ordinary native capture exposes a registered schema and STATUS binding copied unchanged to one slot", async (t) => {
	const tools = new Map<string, { name: string; parameters: { required?: readonly string[] } }>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string; parameters: { required?: readonly string[] } }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);

	assert.ok(tools.has("gentle_review_capture"));
	assert.deepEqual(tools.get("gentle_review_capture")?.parameters.required, ["lineageId", "collectBinding"]);

	const sha = `sha256:${"a".repeat(64)}`;
	const lineageId = "ordinary-capture";
	const collectInput: ReviewCollectInputV3 = {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: sha, token: `--target=${sha}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		submission: {
			operationToken: "capture-result",
			argumentTokens: ["--lineage=ordinary-capture", `--target=${sha}`, "--agent=pi", "--materialize=true", "--input={{value}}"],
			values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 4 }],
		},
	};
	const currentStatus = {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: sha },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: sha,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: "b".repeat(40),
			initialReviewTree: "b".repeat(40),
			currentCandidateTree: "b".repeat(40),
			pathsDigest: sha,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: sha,
			initialSnapshotIdentity: sha,
			currentSnapshotIdentity: sha,
		},
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "capture_required", collect: { inputs: [collectInput] } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
	const native = { targetStatus: async () => currentStatus } as unknown as NativeReviewCli;

	const publicStatus = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	const bindings = publicStatus.collectBindings as readonly { collectBinding: unknown }[];
	assert.equal(bindings.length, 1);
	assert.equal(typeof bindings[0]?.collectBinding, "string");

	let launches = 0;
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		launches += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});
	const captured = await __testing.executeReviewCaptureOperation({
		lineageId,
		collectBinding: bindings[0]!.collectBinding,
		reviewerRunAcknowledged: true,
	}, process.cwd(), native);
	assert.equal(captured.status, "captured");
	assert.equal(launches, 1);
});

test("ordinary START adopts the committed-range selectors the provider just offered", async (t) => {
	const { cwd, baseCommit, baseTree, headTree: candidateTree } = reviewRepository(t);
	const starts: Array<Record<string, unknown>> = [];
	const native = {
		targetStatus: async () => offeredCommittedRangeStatus(baseCommit, baseTree, candidateTree),
		start: async (request: Record<string, unknown>) => { starts.push(request); return startedReviewResult(); },
	} as unknown as NativeReviewCli;
	const parameters = validateToolArguments(registeredGentleTools().get("gentle_review"), {
		type: "toolCall", id: "object-start", name: "gentle_review", arguments: { operation: "start", input: { mode: "ordinary" } },
	});
	const result = await __testing.executeReviewControllerOperation(parameters, cwd, native);
	assert.equal(result.operation, "start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.baseRef, baseCommit);
	assert.equal(starts[0]?.committedOnly, true);
});

test("ordinary START keeps an explicit caller baseRef and ignores the offered selector", async (t) => {
	const { cwd, baseCommit, baseTree, headTree: candidateTree } = reviewRepository(t);
	const starts: Array<Record<string, unknown>> = [];
	const native = {
		// A shape-valid but never-invoked offer: the explicit caller value must win
		// before this is ever considered.
		targetStatus: async () => offeredCommittedRangeStatus("f".repeat(40), baseTree, candidateTree),
		start: async (request: Record<string, unknown>) => { starts.push(request); return startedReviewResult(); },
	} as unknown as NativeReviewCli;
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary", baseRef: baseCommit, committedOnly: true }) }, cwd, native);
	assert.equal(result.operation, "start");
	assert.equal(starts.length, 1);
	assert.equal(starts[0]?.baseRef, baseCommit);
	assert.equal(starts[0]?.committedOnly, true);
});

test("ordinary START keeps today's invocation when STATUS offers no committed-range selector", async (t) => {
	const { cwd, headTree } = reviewRepository(t);
	const offeredWithoutBaseRef = cleanWorkspaceStatus(headTree, {
		kind: "execute",
		reasonCode: "fresh_target_ready",
		execute: { operation: "review.start", arguments: [{ name: "projection", value: "workspace", token: "--projection=workspace" }], preconditions: [], binding: { targetIdentity: `sha256:${"a".repeat(64)}` } },
	});
	for (const [label, target] of [["no execute transition", cleanWorkspaceStatus(headTree)], ["no base-ref", offeredWithoutBaseRef]] as const) {
		const starts: Array<Record<string, unknown>> = [];
		const native = {
			targetStatus: async () => target,
			start: async (request: Record<string, unknown>) => { starts.push(request); return startedReviewResult(); },
		} as unknown as NativeReviewCli;
		const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
		assert.equal(result.operation, "start", label);
		assert.equal(starts.length, 1, label);
		assert.equal(starts[0]?.baseRef, undefined, label);
		assert.equal("committedOnly" in starts[0]!, false, label);
	}
});

test("ordinary START reports candidate-owner preparation failure as pre-native no mutation", async () => {
	let nativeStarts = 0;
	const target = {
		contract: "gentle-ai.review-integration/v2",
		applicability: "unrelated",
		action: "start",
		replayability: "not_replayable",
		targetIdentity: "a".repeat(64),
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: "b".repeat(40),
			initialReviewTree: "b".repeat(40),
			currentCandidateTree: "b".repeat(40),
			pathsDigest: "a".repeat(64),
			paths: [],
			intendedUntracked: [],
			intendedUntrackedProof: "a".repeat(64),
			initialSnapshotIdentity: "a".repeat(64),
			currentSnapshotIdentity: "a".repeat(64),
		},
		candidates: [],
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
	const native = {
		targetStatus: async () => target,
		start: async () => { nativeStarts += 1; throw new Error("native START must not run"); },
	} as unknown as NativeReviewCli;
	const candidateViews = {
		createOrReuse: () => { throw new CandidateViewError("candidate view owner preparation failed", "candidate-owner-preparation-failed"); },
	} as unknown as CandidateViewRegistry;
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		process.cwd(),
		native,
		undefined,
		candidateViews,
	);
	assert.equal(nativeStarts, 0);
	assert.equal(result.outcome, "native-operation-failed");
	assert.equal(result.mutation_outcome, "none");
	assert.deepEqual(result.diagnostics, {
		code: "candidate-owner-preparation-failed",
		message: "candidate view rejected before native START",
	});

	let materializationStatusCalls = 0;
	const rawMaterializationFailure = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		process.cwd(),
		{
			targetStatus: async () => { materializationStatusCalls += 1; return target; },
			start: async () => { nativeStarts += 1; throw new Error("native START must not run"); },
		} as unknown as NativeReviewCli,
		undefined,
		{ createOrReuse: () => { throw new Error("candidate materialization failed"); } } as unknown as CandidateViewRegistry,
	);
	assert.equal(nativeStarts, 0);
	assert.equal(materializationStatusCalls, 1, "a pre-START materialization failure never triggers reconciliation STATUS");
	assert.equal(rawMaterializationFailure.outcome, "native-operation-failed");
	assert.equal(rawMaterializationFailure.mutation_outcome, "none");
	assert.equal(rawMaterializationFailure.next_action, "resolve-native-operation-failure");

	let statusCalls = 0;
	const afterNative = await __testing.executeReviewControllerOperation(
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }) },
		process.cwd(),
		{
			targetStatus: async () => { statusCalls += 1; return target; },
			start: async () => {
				nativeStarts += 1;
				throw new CandidateViewError("post-native candidate verification failed", "candidate-view-timeout", {
					phase: "candidate-view",
					category: "timeout",
					git_subcommand: "worktree",
					timeout_ms: 10_000,
					max_buffer_bytes: 64 * 1024 * 1024,
					message: "candidate-view Git command worktree timed out after 10000ms; inspect the candidate state before any new START",
				});
			},
		} as unknown as NativeReviewCli,
		undefined,
		null,
	);
	assert.equal(nativeStarts, 1);
	assert.equal(statusCalls, 2, "a post-native diagnostic must reconcile STATUS");
	assert.equal(afterNative.mutation_outcome, "unknown");
	assert.deepEqual(afterNative.diagnostics, {
		code: "candidate-view-timeout",
		message: "post-native candidate verification failed",
	});
});

test("retired SDD startup flag is not registered or imported", () => {
	const flags: string[] = [];
	const pi = {
		on() {},
		registerCommand() {},
		registerTool() {},
		registerFlag(name: string) { flags.push(name); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	assert.ok(!flags.includes("gentle-sdd-change"));
	const source = readFileSync(new URL("../extensions/gentle-ai.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /from ["']\.\.\/lib\/sdd-preflight\.ts["']/);
});

test("agent model discovery prioritizes Judgment Day agents", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-agents-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeMarkdown(join(root, "zeta.md"), "name: zeta\n");
	writeMarkdown(join(root, "jd-fix-agent.md"), "name: jd-fix-agent\n");
	writeMarkdown(join(root, "sdd-apply.md"), "name: sdd-apply\n");
	writeMarkdown(join(root, "alpha.md"), "name: alpha\n");
	writeMarkdown(join(root, "jd-judge-b.md"), "name: jd-judge-b\n");
	writeMarkdown(join(root, "sdd-init.md"), "name: sdd-init\n");
	writeMarkdown(join(root, "jd-judge-a.md"), "name: jd-judge-a\n");

	const discovered = __testing.listAgentsFromDir(root, "user");
	const ordered = __testing.orderDiscoverableAgents(discovered);

	assert.deepEqual(
		ordered.map((agent) => agent.name),
		[
			"jd-judge-a",
			"jd-judge-b",
			"jd-fix-agent",
			"alpha",
			"sdd-apply",
			"sdd-init",
			"zeta",
		],
	);
});

test("discoverable model agents include installed Judgment Day agents", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-installed-agents-"));
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = root;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	});
	writeMarkdown(join(root, "agents", "jd-judge-a.md"), "name: jd-judge-a\n");
	writeMarkdown(join(root, "agents", "jd-judge-b.md"), "name: jd-judge-b\n");
	writeMarkdown(join(root, "agents", "jd-fix-agent.md"), "name: jd-fix-agent\n");

	const discovered = __testing.listDiscoverableAgents(root).map((agent) => agent.name);

	assert.deepEqual(
		discovered.filter((name) => name.startsWith("jd-")),
		["jd-judge-a", "jd-judge-b", "jd-fix-agent"],
	);
});

test("per-JD-agent model assignment keeps judge-a and judge-b profiles divergent", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-jd-diversity-"));
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = root;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	});
	writeMarkdown(
		join(root, "agents", "jd-judge-a.md"),
		"---\nname: jd-judge-a\ndescription: Judgment Day judge A\n---\n\nYou are Judgment Day judge A.\n",
	);
	writeMarkdown(
		join(root, "agents", "jd-judge-b.md"),
		"---\nname: jd-judge-b\ndescription: Judgment Day judge B\n---\n\nYou are Judgment Day judge B.\n",
	);
	writeMarkdown(join(root, "agents", "jd-fix-agent.md"), "name: jd-fix-agent\n");

	applyModelConfig(root, {
		"jd-judge-a": { model: "anthropic/claude-3-7-sonnet", thinking: "high" },
		"jd-judge-b": { model: "openai/gpt-4o", thinking: "low" },
	});

	const judgeA = readFileSync(join(root, "agents", "jd-judge-a.md"), "utf8");
	assert.match(judgeA, /^model: anthropic\/claude-3-7-sonnet$/m);
	assert.match(judgeA, /^thinking: high$/m);

	const judgeB = readFileSync(join(root, "agents", "jd-judge-b.md"), "utf8");
	assert.match(judgeB, /^model: openai\/gpt-4o$/m);
	assert.match(judgeB, /^thinking: low$/m);

	const profiles = JSON.parse(
		readFileSync(join(root, "subagents.json"), "utf8"),
	);
	assert.equal(
		profiles.model_profiles["jd-judge-a"].model,
		"anthropic/claude-3-7-sonnet",
	);
	assert.equal(profiles.model_profiles["jd-judge-a"].effort, "high");
	assert.equal(
		profiles.model_profiles["jd-judge-b"].model,
		"openai/gpt-4o",
	);
	assert.equal(profiles.model_profiles["jd-judge-b"].effort, "low");
	assert.notEqual(
		profiles.model_profiles["jd-judge-a"].model,
		profiles.model_profiles["jd-judge-b"].model,
		"judge-a and judge-b must be able to run with different models in one JD run",
	);
});

// ---------------------------------------------------------------------------
// Models screen (/gentle:profiles): one table, profiles as tabs.
// ---------------------------------------------------------------------------

const SCREEN_AGENTS = ["gentle-ai-explore", "gentle-ai-verify", "gentle-ai-worker"];
const SCREEN_MODELS = ["nan/deepseek-v4-flash", "nan/glm5.3", "openai/gpt-5.5"];

function screenConfig(): AgentModelConfig {
	const config: AgentModelConfig = { orchestrator: { model: "openai-codex/gpt-6.1-sol", thinking: "max" } };
	for (const agent of SCREEN_AGENTS) config[agent] = { model: "nan/deepseek-v4-flash", thinking: "high" };
	return config;
}

function screenFile(): AgentProfilesFile {
	const file = bootstrapProfilesFile(screenConfig());
	return { ...file, profiles: { ...file.profiles, nan: { orchestrator: { model: "nan/glm5.3", thinking: "high" } } }, active: "current" };
}

type ScreenEvent = { type: "move" | "click" | "wheel"; x: number; y: number; wheelDelta?: number };

function renderScreen(
	inputs: string[] = [],
	mouse: ScreenEvent[] = [],
	results: unknown[] = [],
	options: { width?: number; rows?: number; theme?: Theme; thinkingSupport?: Record<string, ThinkingLevel[]>; notices?: string[] } = {},
): string[] {
	return __testing.routingTablePanel(
		screenConfig(),
		SCREEN_MODELS,
		SCREEN_AGENTS,
		options.width ?? 100,
		options.theme,
		options.rows ?? 24,
		inputs,
		mouse,
		results as never[],
		{ file: screenFile(), sessionBoundName: "current", thinkingSupport: options.thinkingSupport, notices: options.notices },
	);
}

/** Where a piece of text is on a rendered screen, as pointer coordinates. */
function screenAt(lines: string[], needle: string): { x: number; y: number } {
	const plain = lines.map(stripAnsi);
	const y = plain.findIndex((line) => line.includes(needle));
	assert.ok(y >= 0, `not on screen: ${needle}`);
	return { x: plain[y].indexOf(needle) + 1, y };
}

test("models screen render does not auto-apply the Gentle theme and sanitizes agent labels", () => {
	const lines = __testing.routingTablePanel({}, ["openai/gpt-5.5"], ["safe-agent\x1b[31m"], 72);
	const rendered = lines.join("\n");
	const plain = stripAnsi(rendered);
	assert.doesNotMatch(cardBody(rendered), /\x1b\[38;2;71;85;105m/);
	assert.doesNotMatch(cardBody(rendered), /\x1b\[38;2;125;211;252m/);
	assert.match(plain, /current/);
	assert.match(plain, /safe-agent\s+inherit\s+inherit/);
	assert.doesNotMatch(plain, /\[31m/);
});

test("models screen fills the terminal height and keeps every line inside the frame", () => {
	const lines = renderScreen([], [], [], { width: 72, rows: 40 });
	assert.equal(lines.length, 40);
	const plain = lines.map(stripAnsi);
	assert.match(plain[0] ?? "", /^╭─+╮$/);
	assert.match(plain[39] ?? "", /^╰─+╯$/);
	for (const line of plain) assert.equal(visibleWidth(line), 72);
});

test("models screen shows profiles as tabs with their scope, the orchestrator first, and three buttons", () => {
	const plain = renderScreen().map(stripAnsi);
	assert.match(plain[1] ?? "", /current ◉★ ▾\s+nan\s+\+ New/, "tabs carry ◉ session and ★ default; ▾ opens the profile menu");
	assert.match(plain[3] ?? "", /current\s+Used in this session\. Default for new sessions\./);
	assert.match(plain[5] ?? "", /▸ Orchestrator\s+openai-codex\/gpt-6\.1-sol\s+max/);
	assert.match(plain.join("\n"), /Agent\s+Model ▾\s+Effort ▾\s+set every agent/);
	assert.match(plain.join("\n"), /\[ Use in this session \]  \[ Make default \]  \[ Save \]\s+Saved/);
	assert.match(plain.join("\n"), /←→ profile {2}↑↓ agent {2}enter model {2}e effort {2}s save {2}u use {2}d default {2}n new {2}m menu {2}esc close/);
	assert.doesNotMatch(plain.join("\n"), /⋯/, "no ellipsis-like glyph: it reads as cut text");
});

test("models screen agent rows grow with the terminal height", () => {
	const agents = Array.from({ length: 40 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
	const models = Array.from({ length: 60 }, (_, i) => `provider/model-${String(i).padStart(2, "0")}`);
	const table = __testing.routingTablePanel({}, models, agents, 100, undefined, 40).map(stripAnsi);
	assert.equal(table.length, 40);
	// 40 rows minus the frame, 12 fixed body rows, and two scroll indicators.
	assert.equal(table.filter((line) => /agent-\d\d\s/.test(line)).length, 24);
	assert.ok(table.some((line) => /↓ \d+ more/.test(line)));
	const card = __testing.routingTablePanel({}, models, agents, 100, undefined, 40, ["\r"]).map(stripAnsi);
	// The model card windows its options to the terminal height minus its chrome.
	assert.equal(card.filter((line) => /provider\/model-\d\d/.test(line)).length, 28);
});

test("models screen uses the Pi-provided theme when supplied", () => {
	const theme = { fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[39m`, bg: (_color: string, text: string) => text } as unknown as Theme;
	assert.match(renderScreen([], [], [], { theme }).join("\n"), /\x1b\[35m/);
});

test("models screen pointer: hover uses selectedBg, and one click runs exactly one action", () => {
	const base = renderScreen();
	const hoverTheme = { fg: (_color: string, text: string) => text, bg: (color: string, text: string) => `<${color}>${text}</${color}>` } as unknown as Theme;
	const worker = screenAt(base, "gentle-ai-worker");
	const hovered = renderScreen([], [{ type: "move", ...worker }], [], { theme: hoverTheme }).join("\n");
	assert.match(hovered, /<selectedBg>\s*gentle-ai-worker/, "row hover fills with the selection background");
	assert.doesNotMatch(hovered, /toolPendingBg/, "the pending background is a shade off the terminal background");

	const model = screenAt(base, "nan/deepseek-v4-flash");
	const card = renderScreen([], [{ type: "click", x: model.x, y: worker.y }]).map(stripAnsi);
	assert.ok(card.some((line) => line.includes("Model for gentle-ai-worker")), "a click on a model opens that agent's card");
	assert.match(card[1] ?? "", /current ◉★ ▾\s+nan/, "the screen stays behind the card");
	const option = screenAt(card, "openai/gpt-5.5");
	const picked = renderScreen([], [{ type: "click", x: model.x, y: worker.y }, { type: "click", ...option }]).map(stripAnsi);
	assert.ok(picked.some((line) => /gentle-ai-worker\s+openai\/gpt-5\.5/.test(line)));
	assert.ok(picked.some((line) => /gentle-ai-explore\s+nan\/deepseek-v4-flash/.test(line)), "other agents are untouched");
	assert.ok(picked.some((line) => line.includes("● 1 unsaved")), "press and click of one click change one value once");

	const effort = screenAt(base, "high");
	const strip = renderScreen([], [{ type: "click", x: effort.x, y: worker.y }]);
	const chip = screenAt(strip, " low ");
	const efforted = renderScreen([], [{ type: "click", x: effort.x, y: worker.y }, { type: "click", ...chip }]).map(stripAnsi);
	assert.ok(efforted.some((line) => /gentle-ai-worker\s+nan\/deepseek-v4-flash\s+low/.test(line)));

	const header = screenAt(base, "Model ▾");
	const all = renderScreen([], [{ type: "click", ...header }]);
	const glm = screenAt(all, "nan/glm5.3");
	const allSet = renderScreen([], [{ type: "click", ...header }, { type: "click", ...glm }]).map(stripAnsi);
	assert.equal(allSet.filter((line) => /gentle-ai-\w+\s+nan\/glm5\.3\s/.test(line)).length, 3, "Model ▾ sets every agent");
	assert.ok(allSet.some((line) => /Orchestrator\s+openai-codex/.test(line)), "and never the orchestrator");

	const outside = renderScreen([], [{ type: "click", x: model.x, y: worker.y }, { type: "click", x: 3, y: 21 }]).map(stripAnsi);
	assert.ok(!outside.some((line) => line.includes("Model for")), "a click outside a card closes it");

	const results: Array<{ type: string; name?: string; saveFirst?: AgentModelConfig }> = [];
	renderScreen([], [{ type: "click", ...screenAt(base, "[ Use in this session ]") }], results);
	renderScreen([], [{ type: "click", ...screenAt(base, "[ Make default ]") }], results);
	renderScreen([], [{ type: "click", ...screenAt(base, " nan ") }], results);
	assert.deepEqual(results.map((result) => result.type), ["use-session", "apply-global", "load"]);

	const menu = renderScreen([], [{ type: "click", ...screenAt(base, "▾") }]);
	const renamed: Array<{ type: string }> = [];
	renderScreen([], [{ type: "click", ...screenAt(base, "▾") }, { type: "click", ...screenAt(menu, "Rename") }], renamed);
	assert.equal(renamed[0]?.type, "rename");

	const newMenu = renderScreen([], [{ type: "click", ...screenAt(base, "+ New") }]);
	const created: Array<{ type: string }> = [];
	renderScreen([], [{ type: "click", ...screenAt(base, "+ New") }, { type: "click", ...screenAt(newMenu, "From what's running now") }], created);
	assert.deepEqual(created.map((result) => result.type), ["create-live"]);
});

test("models screen asks before leaving a profile with unsaved changes", () => {
	const base = renderScreen();
	const worker = screenAt(base, "gentle-ai-worker");
	const model = screenAt(base, "nan/deepseek-v4-flash");
	const card = renderScreen([], [{ type: "click", x: model.x, y: worker.y }]);
	const option = screenAt(card, "openai/gpt-5.5");
	const edit = [{ type: "click" as const, x: model.x, y: worker.y }, { type: "click" as const, ...option }];
	const confirm = renderScreen([], [...edit, { type: "click", ...screenAt(base, " nan ") }]);
	assert.ok(confirm.map(stripAnsi).some((line) => line.includes("current has 1 unsaved change.")));
	for (const [button, expected] of [
		["[ Save and switch ]", { type: "load", name: "nan", saved: "openai/gpt-5.5" }],
		["[ Discard ]", { type: "load", name: "nan", saved: undefined }],
		["[ Stay ]", undefined],
	] as const) {
		const results: Array<{ type: string; name?: string; saveFirst?: AgentModelConfig }> = [];
		renderScreen([], [...edit, { type: "click", ...screenAt(base, " nan ") }, { type: "click", ...screenAt(confirm, button) }], results);
		if (expected === undefined) {
			assert.deepEqual(results, [], "Stay keeps the screen and the edits");
			continue;
		}
		assert.equal(results[0]?.type, expected.type);
		assert.equal(results[0]?.name, expected.name);
		assert.equal(results[0]?.saveFirst?.["gentle-ai-worker"]?.model, expected.saved);
	}
});

test("models screen keys: esc twice discards unsaved edits, and each key means one thing", () => {
	const armed: unknown[] = [];
	const lines = renderScreen(["j", "j", "j", "\r", "g", "l", "m", "\r", "\x1b"], [], armed).map(stripAnsi);
	assert.deepEqual(armed, [], "the first esc with unsaved edits only warns");
	assert.match(profilesPanelFooter(lines.join("\n")), /Unsaved changes\. Press esc again to close without saving\./);
	const closed: Array<{ type: string }> = [];
	renderScreen(["j", "j", "j", "\r", "g", "l", "m", "\r", "\x1b", "\x1b"], [], closed);
	assert.deepEqual(closed.map((result) => result.type), ["close"]);

	const saved: Array<{ type: string }> = [];
	renderScreen(["s"], [], saved);
	assert.deepEqual(saved, [], "s with nothing to save is a no-op");
	assert.match(profilesPanelFooter(renderScreen(["s"]).map(stripAnsi).join("\n")), /Nothing to save\./);
	const keyed: Array<{ type: string }> = [];
	for (const key of ["u", "d", "\x1b[C"]) renderScreen([key], [], keyed);
	assert.deepEqual(keyed.map((result) => result.type), ["use-session", "apply-global", "load"]);

	// Terminals using the kitty keyboard protocol send letters as escape
	// sequences: "e" arrives as \x1b[101u and must still open the effort row.
	assert.ok(renderScreen(["\x1b[101u"]).map(stripAnsi).some((line) => line.includes("Effort for the orchestrator")));
	const kittyKeyed: Array<{ type: string }> = [];
	renderScreen(["\x1b[117u"], [], kittyKeyed); // u
	assert.deepEqual(kittyKeyed.map((result) => result.type), ["use-session"]);
});

test("models screen fits narrow terminals without cutting text", () => {
	for (const width of [60, 70, 80, 90]) {
		for (const keys of [[], ["e"], ["\r"], ["m"], ["n"]]) {
			const plain = renderScreen(keys, [], [], { width, rows: 24 }).map(stripAnsi);
			assert.equal(plain.filter((line) => visibleWidth(line) !== width).length, 0, `${width} ${keys}`);
			const cut = plain.filter((line) => line.replace("Custom model id…", "").includes("…") && !/openai-codex|deepseek|glm/.test(line));
			assert.deepEqual(cut, [], `${width} ${keys}`);
		}
	}
	const narrow = renderScreen([], [], [], { width: 60 }).map(stripAnsi).join("\n");
	assert.match(narrow, /\[ Use here \]  \[ Default \]  \[ Save \]/, "short labels when the full ones do not fit");
});

test("models screen offers only the effort levels each model supports and shows where Pi lands the rest", async () => {
	const thinkingSupport = {
		"nan/deepseek-v4-flash": ["off", "minimal", "low", "medium", "high"],
		"openai-codex/gpt-6.1-sol": ["off", "minimal", "low", "medium", "high", "xhigh"],
	} satisfies Record<string, ThinkingLevel[]>;
	const table = renderScreen([], [], [], { thinkingSupport }).map(stripAnsi);
	assert.ok(table.some((line) => /Orchestrator\s+openai-codex\/gpt-6\.1-sol\s+max → xhigh/.test(line)));
	const card = renderScreen(["j", "j", "e"], [], [], { thinkingSupport }).map(stripAnsi);
	assert.ok(card.some((line) => line.includes("Levels nan/deepseek-v4-flash supports.")));
	const chips = card.find((line) => line.includes("inherit") && line.includes("off")) ?? "";
	assert.match(chips, /\[high\]/);
	assert.doesNotMatch(chips, /xhigh|max/);

	const ctx = { modelRegistry: { getAvailable: async () => [
		{ provider: "openai", id: "alpha" },
		{ provider: "nan", id: "chat", reasoning: false },
		{ provider: "nan", id: "think", reasoning: true },
		{ provider: "openai", id: "deep", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } },
	] } } as unknown as ExtensionContext;
	const support = await __testing.piThinkingSupport(ctx);
	assert.equal(support["openai/alpha"], undefined, "no reasoning flag: unknown, every level offered");
	assert.deepEqual(support["nan/chat"], ["off"]);
	assert.deepEqual(support["nan/think"], ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(support["openai/deep"], ["off", "minimal", "low", "medium", "high", "xhigh"]);
});

test("models screen lists configuration problems under the profile name without cutting them", () => {
	const notices = [
		"The local pin file /home/user/project/.git/gentle-ai/profile-pin.json is not a valid pin and is ignored. Fix or remove it.",
		'Profile key "sdd-design" matches no agent configured in gentle-shell, so it is ignored at launch.',
	];
	const plain = renderScreen([], [], [], { width: 80, notices }).map(stripAnsi);
	assert.ok(plain.some((line) => line.includes('⚠ Profile key "sdd-design"')));
	assert.ok(!plain.some((line) => line.includes("…")));
});

test("delivery commands bypass RDD under every mode outcome while command safety remains independent", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	const commands = [
		"git commit -m relay",
		"git push origin feature/relay",
		"gh pr create --base main --head feature/relay",
		"gh release create v1.2.3",
		"git status && git commit -m relay",
		"env SAFE=1 git push origin feature/relay",
		"sh -c 'gh pr create --base main --head feature/relay'",
		"sh -c 'gh release create v1.2.3'",
	] as const;
	const modes = [
		{ label: "no native CLI", nativeReviewCli: null },
		{ label: "RDD off", nativeReviewCli: { reviewMode: async () => ({ status: { effective: "off" } }) } },
		{ label: "RDD on", nativeReviewCli: { reviewMode: async () => ({ status: { effective: "on" } }) } },
		{ label: "mode failure", nativeReviewCli: { reviewMode: async () => { throw new Error("mode unavailable"); } } },
	] as const;

	for (const mode of modes) {
		const handlers = new Map<string, ToolCallHandler>();
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: { emit() {} },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: mode.nativeReviewCli as never })(pi);
		const toolCall = handlers.get("tool_call");
		assert.equal(typeof toolCall, "function", mode.label);
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { confirm: async () => true },
		} as unknown as ExtensionContext;

		for (const command of commands) {
			const result = await toolCall!({ toolName: "bash", input: { command } }, ctx);
			assert.equal(result, undefined, `${mode.label}: ${command}`);
		}
	}
});

test("guarded command confirmation emits a generic correlated permission lifecycle", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type PermissionEvent = {
		channel: string;
		data: {
			requestId: string;
			state: "waiting" | "approved" | "denied";
			source: "tool_call";
			message: string;
			toolName: "bash";
		};
	};
	type HerdrBlockedEvent = {
		channel: "herdr:blocked";
		data: { active: boolean; label?: string };
	};
	type EmittedEvent = PermissionEvent | HerdrBlockedEvent;
	const handlers = new Map<string, ToolCallHandler>();
	const emitted: EmittedEvent[] = [];
	const sequence: string[] = [];
	const confirmation = confirmationObserver();
	let confirm!: () => Promise<boolean>;
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: {
			emit(channel: string, data: EmittedEvent["data"]) {
				sequence.push(
					channel === "herdr:blocked"
						? `herdr:${"active" in data && data.active ? "active" : "inactive"}`
						: `event:${"state" in data ? data.state : "unknown"}`,
				);
				emitted.push({ channel, data } as EmittedEvent);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0" }, nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-request-"));
	try {
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => {
					sequence.push("confirm");
					confirmation.observe();
					return confirm();
				},
			},
		} as unknown as ExtensionContext;
		let resolveConfirmation!: (approved: boolean) => void;
		confirm = () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
		const denied = toolCall!({
			toolName: "bash",
			input: { command: "git rebase main --secret-command-content" },
		}, ctx);

		await confirmation.waitFor(1);
		assert.equal(emitted[0].channel, "pi-permission-system:permission-request");
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm"]);
		const deniedRequestId = emitted[0].data.requestId;
		assert.match(deniedRequestId, /^[0-9a-f-]{36}$/);
		assert.deepEqual(emitted[0].data, {
			requestId: deniedRequestId,
			state: "waiting",
			source: "tool_call",
			message: "Gentle AI safety policy requires confirmation for this tool call.",
			toolName: "bash",
		});
		assert.equal(Object.keys(emitted[0].data).includes("command"), false);
		assert.equal(Object.keys(emitted[0].data).includes("preview"), false);
		assert.doesNotMatch(JSON.stringify(emitted), /secret-command-content|git rebase/);

		resolveConfirmation(false);
		assert.deepEqual(await denied, {
			block: true,
			reason: "Gentle AI safety policy blocked the command because it was not confirmed.",
		});
		assert.deepEqual(emitted[2], {
			channel: "pi-permission-system:permission-request",
			data: {
				requestId: deniedRequestId,
				state: "denied",
				source: "tool_call",
				message: "Gentle AI safety policy requires confirmation for this tool call.",
				toolName: "bash",
			},
		});
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:denied", "herdr:inactive"]);

		emitted.length = 0;
		sequence.length = 0;
		confirm = async () => true;
		assert.equal(await toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, ctx), undefined);
		assert.equal(emitted.length, 4);
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.equal(emitted[2].data.state, "approved");
		assert.equal(emitted[0].data.requestId, emitted[2].data.requestId);
		assert.notEqual(emitted[0].data.requestId, deniedRequestId);
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:approved", "herdr:inactive"]);

		emitted.length = 0;
		sequence.length = 0;
		const confirmationError = new Error("confirmation unavailable");
		confirm = async () => { throw confirmationError; };
		await assert.rejects(
			toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, ctx),
			(error) => error === confirmationError,
		);
		assert.equal(emitted.length, 4);
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.equal(emitted[2].data.state, "denied");
		assert.equal(emitted[0].data.requestId, emitted[2].data.requestId);
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:denied", "herdr:inactive"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("concurrent guarded confirmations coalesce the Herdr lifecycle per extension instance", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type EmittedEvent = {
		channel: string;
		data: {
			requestId?: string;
			state?: "waiting" | "approved" | "denied";
			active?: boolean;
			label?: string;
		};
	};
	const createHarness = () => {
		const handlers = new Map<string, ToolCallHandler>();
		const emitted: EmittedEvent[] = [];
		const confirmation = confirmationObserver();
		const confirmations: Array<(approved: boolean) => void> = [];
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: { emit(channel: string, data: EmittedEvent["data"]) { emitted.push({ channel, data }); } },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0" }, nativeReviewCli: null })(pi);
		return { handlers, emitted, confirmations, confirmation };
	};
	const first = createHarness();
	const second = createHarness();
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-concurrent-"));
	try {
		const context = (confirmations: Array<(approved: boolean) => void>) => ({
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => {
					confirmations.push(resolve);
					(confirmations === first.confirmations ? first : second).confirmation.observe();
				}),
			},
		} as unknown as ExtensionContext);
		const firstRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main" } }, context(first.confirmations));
		const secondRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main --another-command" } }, context(first.confirmations));
		await first.confirmation.waitFor(2);
		assert.deepEqual(first.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
		]);
		assert.equal(first.confirmations.length, 2);
		const waitingEvents = first.emitted.filter(({ channel, data }) => channel === "pi-permission-system:permission-request" && data.state === "waiting");
		assert.notEqual(waitingEvents[0]?.data.requestId, waitingEvents[1]?.data.requestId);

		first.confirmations[0]!(false);
		assert.deepEqual(await firstRequest, {
			block: true,
			reason: "Gentle AI safety policy blocked the command because it was not confirmed.",
		});
		assert.deepEqual(first.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "pi-permission-system:permission-request", state: "denied", active: undefined },
		]);

		const independentRequest = second.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main --independent-command" } }, context(second.confirmations));
		await second.confirmation.waitFor(1);
		assert.equal(second.emitted.filter(({ channel }) => channel === "herdr:blocked").length, 1);
		assert.equal(second.emitted.find(({ channel }) => channel === "herdr:blocked")?.data.active, true);
		assert.equal(second.confirmations.length, 1);

		first.confirmations[1]!(true);
		assert.equal(await secondRequest, undefined);
		assert.equal(first.emitted.filter(({ channel, data }) => channel === "herdr:blocked" && data.active === false).length, 1);
		second.confirmations[0]!(true);
		assert.equal(await independentRequest, undefined);
		assert.deepEqual(second.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "approved", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: false },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});


for (const channel of ["rpiv:ask-user:blocked", "gentle-pi:ask-user-question:blocked"]) {
test(`${channel} emits only a private, balanced Herdr projection`, () => {
	type HerdrBlockedEvent = { active: boolean; label?: string };
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const published: Array<{ channel: string; data: unknown }> = [];
	const herdrEvents: HerdrBlockedEvent[] = [];
	const pi = {
		on() {},
		events: {
			emit(channel: string, data: unknown) {
				published.push({ channel, data });
				if (channel === "herdr:blocked") herdrEvents.push(data as HerdrBlockedEvent);
				const handler = eventHandlers.get(channel);
				if (handler) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, handler);
				return () => eventHandlers.delete(channel);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const privateHostDiscovery = "gentle:yolo:host-ui";
	assert.equal(eventHandlers.has(privateHostDiscovery), true);
	assert.deepEqual([...eventHandlers.keys()].filter(name => name !== privateHostDiscovery).sort(), [
		"gentle-pi:ask-user-choice:blocked", "gentle-pi:ask-user-question:blocked", "rpiv:ask-user:blocked",
	], "only the original three blocked channels remain besides the known private host adapter");
	assert.deepEqual(published, [], "registering host discovery emits no public event or private payload");
	assert.equal(eventHandlers.has("gentle-pi:ask-user-choice:blocked"), true);
	assert.equal(eventHandlers.has("rpiv:ask-user:blocked"), true);
	assert.equal(eventHandlers.has("gentle-pi:ask-user-question:blocked"), true);

	const source = {
		active: true,
		question: "private questionnaire text",
		answer: "private questionnaire answer",
		path: "/private/questionnaire-path",
		command: "private questionnaire command",
		arbitrary: { nested: "private questionnaire field" },
	};
	eventHandlers.get(privateHostDiscovery)!(source);
	assert.deepEqual(published, [], "private discovery ignores questionnaire data instead of relaying it");
	assert.deepEqual(herdrEvents, []);
	pi.events.emit(channel, source);
	assert.strictEqual(published[0]?.data, source, "the questionnaire event remains the source event");
	assert.deepEqual(herdrEvents, [{ active: true, label: "Questionnaire awaiting input" }]);
	assert.doesNotMatch(JSON.stringify(herdrEvents), /private questionnaire|questionnaire-path/i);
	assert.deepEqual(published.filter(event => event.channel !== channel), [
		{ channel: "herdr:blocked", data: { active: true, label: "Questionnaire awaiting input" } },
	], "host discovery adds no new public projection or sensitive-content leakage");

	pi.events.emit(channel, { active: true, duplicate: true });
	pi.events.emit(channel, { active: "true" });
	pi.events.emit(channel, { active: null });
	pi.events.emit(channel, []);
	pi.events.emit(channel, null);
	pi.events.emit("rpiv:ask-user:other", { active: false });
	assert.deepEqual(herdrEvents, [{ active: true, label: "Questionnaire awaiting input" }]);

	pi.events.emit(channel, { active: false });
	pi.events.emit(channel, { active: false, duplicate: true });
	pi.events.emit(channel, { active: true });
	pi.events.emit(channel, { active: false });
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
	]);
});

}

test("Herdr preserves the initial label and balanced edges across overlapping sources", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type HerdrBlockedEvent = { active: boolean; label?: string };
	const createHarness = () => {
		const handlers = new Map<string, ToolCallHandler>();
		const eventHandlers = new Map<string, (data: unknown) => void>();
		const herdrEvents: HerdrBlockedEvent[] = [];
		const confirmation = confirmationObserver();
		const confirmations: Array<(approved: boolean) => void> = [];
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: {
				emit(channel: string, data: unknown) {
					if (channel === "herdr:blocked") herdrEvents.push(data as HerdrBlockedEvent);
					const handler = eventHandlers.get(channel);
					if (handler) handler(data);
				},
				on(channel: string, handler: (data: unknown) => void) {
					eventHandlers.set(channel, handler);
					return () => eventHandlers.delete(channel);
				},
			},
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0" }, nativeReviewCli: null })(pi);
		const context = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); confirmation.observe(); }),
			},
		} as unknown as ExtensionContext;
		return { confirmations, confirmation, context, herdrEvents, pi, toolCall: handlers.get("tool_call")! };
	};

	const guardedFirst = createHarness();
	const guardedRequest = guardedFirst.toolCall(
		{ toolName: "bash", input: { command: "git rebase main" } },
		guardedFirst.context,
	);
	await guardedFirst.confirmation.waitFor(1);
	guardedFirst.pi.events.emit("rpiv:ask-user:blocked", { active: true });
	guardedFirst.confirmations[0]!(true);
	assert.equal(await guardedRequest, undefined);
	assert.deepEqual(guardedFirst.herdrEvents, [
		{ active: true, label: "Guarded command confirmation" },
	]);
	guardedFirst.pi.events.emit("rpiv:ask-user:blocked", { active: false });
	assert.deepEqual(guardedFirst.herdrEvents, [
		{ active: true, label: "Guarded command confirmation" },
		{ active: false },
	]);

	// Each event channel is independent, even when native and legacy producers overlap.
	const channels = ["gentle-pi:ask-user-question:blocked", "rpiv:ask-user:blocked", "gentle-pi:ask-user-choice:blocked"];
	for (const lastChannel of channels) {
		const overlap = createHarness();
		for (const channel of channels) overlap.pi.events.emit(channel, { active: true });
		const request = overlap.toolCall(
			{ toolName: "bash", input: { command: "git rebase main" } }, overlap.context,
		);
		await overlap.confirmation.waitFor(1);
		for (const channel of channels.filter((channel) => channel !== lastChannel)) {
			overlap.pi.events.emit(channel, { active: false });
			overlap.pi.events.emit(channel, { active: false });
		}
		overlap.confirmations[0]!(false);
		await request;
		assert.deepEqual(overlap.herdrEvents, [{ active: true, label: "Questionnaire awaiting input" }]);
		overlap.pi.events.emit(lastChannel, { active: false });
		assert.deepEqual(overlap.herdrEvents, [
			{ active: true, label: "Questionnaire awaiting input" }, { active: false },
		]);
	}

	const questionnaireFirst = createHarness();
	questionnaireFirst.pi.events.emit("rpiv:ask-user:blocked", { active: true });
	const questionnaireRequest = questionnaireFirst.toolCall(
		{ toolName: "bash", input: { command: "git rebase main" } },
		questionnaireFirst.context,
	);
	await questionnaireFirst.confirmation.waitFor(1);
	questionnaireFirst.pi.events.emit("rpiv:ask-user:blocked", { active: false });
	questionnaireFirst.confirmations[0]!(false);
	await questionnaireRequest;
	assert.deepEqual(questionnaireFirst.herdrEvents, [
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
	]);
});

test("closed choice blockers retain the visible choice label through guarded-confirmation overlap", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type HerdrBlockedEvent = { active: boolean; label?: string };
	const handlers = new Map<string, ToolCallHandler>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const herdrEvents: HerdrBlockedEvent[] = [];
	const choiceEvents: Array<{ active: boolean }> = [];
	const confirmation = confirmationObserver();
	const confirmations: Array<(approved: boolean) => void> = [];
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "herdr:blocked") herdrEvents.push(data as HerdrBlockedEvent);
				if (channel === "gentle-pi:ask-user-choice:blocked") choiceEvents.push(data as { active: boolean });
				eventHandlers.get(channel)?.(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, handler);
				return () => eventHandlers.delete(channel);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0" }, nativeReviewCli: null })(pi);
	assert.equal(eventHandlers.has("gentle-pi:ask-user-choice:blocked"), true);

	for (const malformed of [null, [], {}, { active: "true" }]) {
		pi.events.emit("gentle-pi:ask-user-choice:blocked", malformed);
	}
	assert.deepEqual(herdrEvents, []);
	choiceEvents.length = 0;
	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: true });
	assert.deepEqual(choiceEvents, [{ active: true }]);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	const guardedRequest = handlers.get("tool_call")!(
		{ toolName: "bash", input: { command: "git rebase main" } },
		{
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); confirmation.observe(); }),
			},
		} as unknown as ExtensionContext,
	);
	await confirmation.waitFor(1);
	assert.equal(confirmations.length, 1);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: false });
	assert.deepEqual(choiceEvents, [{ active: true }, { active: false }]);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
	]);
	assert.equal(herdrEvents.some((event) => event.active === false), false);

	confirmations[0]!(true);
	assert.equal(await guardedRequest, undefined);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
		{ active: false },
	]);
});

test("permission lifecycle is inactive for unguarded and headless commands", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	const handlers = new Map<string, ToolCallHandler>();
	const emitted: unknown[] = [];
	let confirmations = 0;
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: { emit(_channel: string, data: unknown) { emitted.push(data); } },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0" }, nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-headless-"));
	try {
		const confirm = async () => {
			confirmations += 1;
			return true;
		};
		assert.equal(await toolCall!({ toolName: "bash", input: { command: "echo safe --secret-command-content" } }, {
			cwd,
			hasUI: false,
			ui: { confirm },
		} as unknown as ExtensionContext), undefined);
		assert.deepEqual(await toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, {
			cwd,
			hasUI: false,
			ui: { confirm },
		} as unknown as ExtensionContext), {
			block: true,
			reason: "Gentle AI safety policy requires interactive confirmation before this command.",
		});
		assert.equal(confirmations, 0);
		assert.deepEqual(emitted, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
test("registered Gentle Review capture tools name the lens they run", () => {
	const tools = registeredGentleTools();
	const binding = (lens: string) => JSON.stringify({ name: "reviewer_result", captureOperation: "review.capture-result", arguments: [], artifactSubject: { lens } });
	const single = tools.get("gentle_review_capture")!.renderCall({ lineageId: "l", collectBinding: binding("review-risk") }, lifecycleTheme, lifecycleContext({ executionStarted: true }));
	assert.equal(cardTitle(renderComponent(single)), "🌹 rdd running · capture · risk");
	const bare = tools.get("gentle_review_capture")!.renderCall({ lineageId: "l", collectBinding: "{not json" }, lifecycleTheme, lifecycleContext({ executionStarted: true }));
	assert.equal(cardTitle(renderComponent(bare)), "🌹 rdd running · capture");
	const group = tools.get("gentle_review_capture_group")!.renderCall(
		{ lineageId: "l", collectBindings: [binding("review-risk"), binding("review-resilience"), binding("review-readability"), binding("review-reliability")] },
		lifecycleTheme,
		lifecycleContext({ executionStarted: true }),
	);
	assert.equal(cardTitle(renderComponent(group)), "🌹 rdd running · capture group · risk · resilience · readability · reliability");
});

test("bash tool_call confirms a late guarded npm publish and denies on non-approval", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;

	const confirmArgs: Array<[string, string]> = [];
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
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");

	const configHome = mkdtempSync(join(tmpdir(), "gentle-pi-guard-confirm-"));
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			confirm: async (title: string, message: string) => {
				confirmArgs.push([title, message]);
				return false;
			},
		},
	} as unknown as ExtensionContext;

	const prefix = "noise ".repeat(80);
	const command = `${prefix}npm publish --tag beta`;
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	try {
		const result = await toolCall!({ toolName: "bash", input: { command } }, ctx);
		assert.deepEqual(result, {
			block: true,
			reason:
				"Gentle AI safety policy blocked the command because it was not confirmed.",
		});
	} finally {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		rmSync(configHome, { recursive: true, force: true });
	}

	assert.equal(confirmArgs.length, 1, "guard asks exactly one confirmation before denying");
	const [title, preview] = confirmArgs[0];
	assert.equal(title, "Allow guarded npm publish?");
	assert.match(preview, /npm publish --tag beta/);
	assert.ok(preview.startsWith("…"), "preview elides leading context near a late match");
});

test("bash tool_call confirms every compound action and centers a long git -C push", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	const confirmArgs: Array<[string, string]> = [];
	const handlers = new Map<string, ToolCallHandler>();
	const pi = {
		on(name: string, handler: ToolCallHandler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");

	const configHome = mkdtempSync(join(tmpdir(), "gentle-pi-guard-compound-"));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	try {
		const command = `git -C /${"very-long-path/".repeat(30)} push origin main && npm publish --tag beta`;
		const result = await toolCall!({ toolName: "bash", input: { command } }, {
			cwd: process.cwd(),
			hasUI: true,
			ui: { confirm: async (title: string, message: string) => (confirmArgs.push([title, message]), false) },
		} as unknown as ExtensionContext);
		assert.deepEqual(result, {
			block: true,
			reason: "Gentle AI safety policy blocked the command because it was not confirmed.",
		});
	} finally {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		rmSync(configHome, { recursive: true, force: true });
	}

	assert.equal(confirmArgs.length, 1);
	const [title, preview] = confirmArgs[0];
	assert.equal(title, "Allow guarded actions: git push; npm publish?");
	assert.match(preview, /push origin main && npm publish --tag beta/);
	assert.ok(preview.startsWith("…"));
});
// /gentle:profiles reopens its panel after actions that finish the interaction,
// so a test that applies once must confirm on the first visit and close on the
// next, or the panel and the action loop feed each other forever.
type ScreenPanel = { handleInput(data: string): void; render(width: number): string[] };

/** The profile the models screen shows, read from the line under the tabs. */
function shownProfile(panel: ScreenPanel): string {
	const line = stripAnsi(renderComponent(panel)).split("\n")[3] ?? "";
	return line.replace(/^│\s*/, "").split(/\s{3}|\s*│/)[0]?.trim() ?? "";
}

/** The profile names on the tab line, in order. */
function tabNames(panel: ScreenPanel): string[] {
	const line = stripAnsi(renderComponent(panel)).split("\n")[1] ?? "";
	return line
		.replace(/^│/, "")
		.replace(/│\s*$/, "")
		.split(/\s{2,}/)
		.map((token) => token.trim())
		.filter((token) => token !== "" && token !== "+ New" && token !== "‹" && token !== "›")
		.map((token) => token.split(" ")[0] ?? "");
}

/**
 * Drives the models screen to a profile (a clean tab switch redraws the open
 * screen in place), presses `key` on it, and closes the screen on every later
 * visit. Without a name it acts on the first tab, the profile the old list
 * opened on.
 */
function actOnProfile(
	fixture: { onInput(action: (panel: ScreenPanel) => void): void },
	key: string | readonly string[],
	name?: string,
): void {
	let acted = false;
	fixture.onInput((panel) => {
		if (acted) {
			panel.handleInput("\x1b");
			return;
		}
		const tabs = tabNames(panel);
		const target = name ?? tabs[0];
		for (let step = 0; step < tabs.length && shownProfile(panel) !== target; step++) {
			panel.handleInput(tabs.indexOf(target) < tabs.indexOf(shownProfile(panel)) ? "\x1b[D" : "\x1b[C");
		}
		assert.equal(shownProfile(panel), target);
		acted = true;
		for (const data of typeof key === "string" ? [key] : key) panel.handleInput(data);
	});
}

/** The guarded global apply: Make default (`d`) on a profile, then close. */
function applyOnce(fixture: { onInput(action: (panel: ScreenPanel) => void): void }, name?: string): void {
	actOnProfile(fixture, "d", name);
}

function profilesStoreFixture(t: test.TestContext) {
	const fixture = routingConsumerFixture(t, ["worker"]);
	const storePath = join(fixture.configHome, "profiles.json");
	const settingsPath = join(fixture.agentHome, "settings.json");
	// The panel resolves the per-repository profile pin through a Git seam, so
	// point it at a sandbox identity: a pin test can then write the two layers the
	// production resolver reads without depending on where the test runner's
	// directory happens to sit.
	const pinRoot = join(fixture.root, "worktree");
	const pinCommonDir = join(fixture.root, "git-common");
	for (const dir of [pinRoot, pinCommonDir]) mkdirSync(dir, { recursive: true });
	setProfilePinWorktreeResolverForTesting(() => ({ root: pinRoot, commonDir: pinCommonDir }));
	t.after(() => setProfilePinWorktreeResolverForTesting());
	const writePin = (path: string, profile: string) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile }, null, 2)}\n`);
	};
	const writeStore = (profiles: Record<string, unknown>, active?: string) => {
		mkdirSync(fixture.configHome, { recursive: true });
		const store: Record<string, unknown> = { kind: PROFILES_KIND, version: PROFILES_VERSION, profiles };
		if (active !== undefined) store.active = active;
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
	};
	const writeSettings = (extra: Record<string, unknown> = {}) => {
		const settings = {
			packages: ["npm:pi-mcp-adapter"],
			theme: "Gentleman-Cute",
			defaultProvider: "nan",
			defaultModel: "deepseek-v4-flash",
			defaultThinkingLevel: "high",
			...extra,
		};
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
		return settings;
	};
	return {
		fixture,
		storePath,
		settingsPath,
		writeStore,
		writeSettings,
		localPinPath: join(pinCommonDir, "gentle-ai", "profile-pin.json"),
		repoPinPath: join(pinRoot, ".pi", "gentle-ai", "profile.json"),
		writePin,
	};
}

test("applying a profile persists its orchestrator and never leaks the key into agent routing", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	const before = writeSettings();
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/alpha" },
		},
	});
	// Every global apply now confirms, so this populated apply approves the
	// dialog explicitly before running.
	fixture.onConfirm(async () => true);
	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	const after = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(after.defaultProvider, "nan");
	assert.equal(after.defaultModel, "glm5.3");
	assert.equal(after.defaultThinkingLevel, "max");
	assert.deepEqual(after.packages, before.packages, "unrelated settings keys survive");
	assert.equal(after.theme, before.theme, "unrelated settings keys survive");

	// The reserved key is routing, not an agent: it must never reach the
	// subagent profile store or the agent frontmatter.
	const projectProfiles = JSON.parse(readFileSync(join(fixture.root, ".pi", "subagents.json"), "utf8"));
	assert.equal("orchestrator" in projectProfiles.model_profiles, false);
	assert.equal(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"));
	assert.match(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), /model: openai\/alpha/);
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /Orchestrator set to nan\/glm5\.3 · max/);
	// Persisting the default is not enough: the session the user is sitting in
	// must switch too, or the profile looks applied while the orchestrator keeps
	// answering with the old model.
	assert.deepEqual(fixture.liveSwitches, [
		{ kind: "model", provider: "nan", id: "glm5.3" },
		{ kind: "thinking", level: "max" },
	], "the live session switches to the profile's orchestrator");
	assert.equal(fixture.confirmCalls.length, 1, "every global apply asks for confirmation");
	assert.match(fixture.confirmCalls[0]?.[0] ?? "", /Apply profile/);
});

test("applying a profile whose orchestrator model is unknown to the registry persists the default and says the session did not switch", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { orchestrator: { model: "nan/not-in-catalog", thinking: "high" }, worker: { model: "openai/alpha" } } });
	applyOnce(fixture);
	await fixture.run("gentle:profiles");
	const after = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(after.defaultModel, "not-in-catalog", "the default for new sessions is still recorded");
	assert.deepEqual(fixture.liveSwitches, [], "nothing is switched live without a registry model");
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /nan\/not-in-catalog is not in the model catalog; this session keeps its current model/);
});

test("a thinking level the switched model rejects keeps the model switch and reports the level", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { orchestrator: { model: "nan/glm5.3", thinking: "max" }, worker: { model: "openai/alpha" } } });
	fixture.rejectThinkingLevel();
	applyOnce(fixture);
	await fixture.run("gentle:profiles");
	assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultThinkingLevel, "max", "the persisted default is untouched by the live refusal");
	assert.deepEqual(fixture.liveSwitches, [{ kind: "model", provider: "nan", id: "glm5.3" }], "the model switch stands");
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /This session now runs on nan\/glm5\.3, but its thinking level could not be set to max: thinking level max is not supported by this model/);
});

test("applying a profile whose orchestrator provider has no auth persists the default and reports the refused switch", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { orchestrator: { model: "nan/glm5.3" }, worker: { model: "openai/alpha" } } });
	fixture.refuseSetModel();
	applyOnce(fixture);
	await fixture.run("gentle:profiles");
	assert.deepEqual(fixture.liveSwitches, [{ kind: "model", provider: "nan", id: "glm5.3" }], "the switch was attempted, no thinking level without one in the profile");
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /no authentication is configured for nan; this session keeps its current model/);
});

test("applying a profile without an orchestrator entry leaves settings.json untouched", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { worker: { model: "openai/alpha" } } });
	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	const after = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(after.defaultProvider, "nan");
	assert.equal(after.defaultModel, "deepseek-v4-flash");
	assert.equal(after.defaultThinkingLevel, "high");
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.doesNotMatch(applied, /Orchestrator set to/);
});

test("a profile store entry with only the orchestrator key counts zero roles", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { orchestrator: { model: "nan/glm5.3", thinking: "high" } } }, "team");
	applyOnce(fixture);
	await fixture.run("gentle:profiles");
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /0 agents updated/);
	assert.match(applied, /Orchestrator set to nan\/glm5\.3 · high/);
});

test("applying an empty profile asks for confirmation and aborts when declined", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	writeStore({
		empty: {},
		team: { worker: { model: "openai/alpha" } },
	}, "team");
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "confirm dialog must be displayed when applying an empty profile");
	const [title, message] = fixture.confirmCalls[0];
	assert.equal(title, "Apply empty profile?");
	assert.match(message, /has no routing entries/);
	assert.match(message, /replace global routing/);
	assert.match(message, /empty configuration/);

	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models, "declined apply must preserve models.json byte-identically");
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents, "declined apply must preserve subagents.json byte-identically");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "declined apply must preserve the profiles store byte-identically");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "declined apply must preserve settings.json byte-identically");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
	const models = JSON.parse(before.models);
	assert.deepEqual(models, { worker: { model: "openai/alpha" } }, "global routing must NOT be wiped when declined");

	const store = JSON.parse(before.store);
	assert.equal(store.active, "team", "active profile must not change when declined");
});

test("applying an empty profile with explicit confirmation replaces global routing with empty config", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	writeStore({
		empty: {},
		team: { worker: { model: "openai/alpha" } },
	}, "team");

	fixture.onConfirm(async () => true);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "confirm dialog must be displayed when applying an empty profile");
	const models = JSON.parse(readFileSync(fixture.globalPath, "utf8"));
	assert.deepEqual(models, {}, "global routing must be replaced with empty config when confirmed");

	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.active, "empty", "active profile must be set to empty when confirmed");

	const subagents = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.deepEqual(subagents, {}, "confirmed empty apply clears the seeded omitted worker route (shared clearing semantics drop the empty key)");
});

test("applying an orchestrator-only profile asks for confirmation and aborts when declined", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	writeStore({
		orchOnly: { orchestrator: { model: "nan/glm5.3", thinking: "high" } },
		team: { worker: { model: "openai/alpha" } },
	}, "team");
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "confirm dialog must be displayed when applying an orchestrator-only profile");
	const [title, message] = fixture.confirmCalls[0];
	assert.equal(title, "Apply orchestrator-only profile?");
	assert.match(message, /has an orchestrator entry but no agent routing entries/);
	assert.match(message, /clear every materialized agent route/);
	assert.match(message, /inherit/);
	assert.match(message, /orchestrator entry/);
	assert.match(message, /settings\.json/);
	assert.match(message, /attempt to switch this session/, "the dialog must not promise an unconditional live switch; registry/auth refusal can keep the session model");
	assert.doesNotMatch(message, /empty configuration/, "orchestrator-only must not promise an entirely empty config");

	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models, "declined apply must preserve models.json byte-identically");
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents, "declined apply must preserve subagents.json byte-identically");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "declined apply must preserve the profiles store byte-identically");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "declined apply must preserve settings.json byte-identically");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");

	const store = JSON.parse(before.store);
	assert.equal(store.active, "team", "active profile must not change when declined");
});

test("applying an orchestrator-only profile with explicit confirmation updates orchestrator and active profile", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	writeStore({
		orchOnly: { orchestrator: { model: "nan/glm5.3", thinking: "high" } },
		team: { worker: { model: "openai/alpha" } },
	}, "team");

	fixture.onConfirm(async () => true);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "confirm dialog must be displayed when applying an orchestrator-only profile");
	const models = JSON.parse(readFileSync(fixture.globalPath, "utf8"));
	assert.deepEqual(models, { orchestrator: { model: "nan/glm5.3", thinking: "high" } }, "global routing must hold only orchestrator");

	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.active, "orchOnly", "active profile must be set to orchOnly when confirmed");

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(settings.defaultProvider, "nan");
	assert.equal(settings.defaultModel, "glm5.3");
	assert.equal(settings.defaultThinkingLevel, "high");

	const subagents = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.deepEqual(subagents, {}, "confirmed orchestrator-only apply clears the seeded omitted worker route (shared clearing semantics drop the empty key)");
	assert.equal("orchestrator" in subagents, false, "the orchestrator key never materializes as an agent route");
	assert.deepEqual(fixture.liveSwitches, [
		{ kind: "model", provider: "nan", id: "glm5.3" },
		{ kind: "thinking", level: "high" },
	], "the live session switches to the profile's orchestrator");
});

test("applying a populated profile asks for confirmation naming the diff and aborts when declined", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// Current global routing: "worker" will be replaced, "helper" will be
	// cleared back to inherit, and "tracer" only exists in the profile.
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha", thinking: "high" }, helper: { model: "openai/beta" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/alpha", effort: "high" }, helper: { model: "openai/beta" } } }, null, 2)}\n`);
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/beta", thinking: "max" },
			tracer: { model: "openai/alpha" },
		},
	});
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [title, message] = fixture.confirmCalls[0];
	assert.equal(title, 'Apply profile "team"?');
	assert.match(message, /replace global routing/, "the dialog must name the file whose routing is replaced");
	assert.match(message, /models\.json/);
	assert.match(message, /worker: openai\/alpha · high → openai\/beta · max/, "the replaced route must name both the old and the new route");
	assert.match(message, /helper: openai\/beta → inherit/, "the cleared agent must be named with its return to inherit");
	assert.match(message, /tracer: openai\/alpha \(added\)/, "the added agent must be named");

	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models, "declined apply must preserve models.json byte-identically");
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents, "declined apply must preserve subagents.json byte-identically");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "declined apply must preserve the profiles store byte-identically");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "declined apply must preserve settings.json byte-identically");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
});

test("applying a populated profile whose routes already match skips the confirmation and applies", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// The profile's agent routes are identical to the effective current routing
	// and the profile carries no orchestrator entry, so applying changes nothing:
	// the dialog is pure friction and the apply must proceed without it.
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { worker: { model: "openai/alpha" } } });
	const settingsBefore = readFileSync(settingsPath, "utf8");

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 0, "a no-op populated apply must not ask for confirmation");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /already matches the current global routing/.test(entry.message)),
		`the no-op apply is disclosed with an informational notice: ${JSON.stringify(fixture.notifications)}`,
	);
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.active, "team", "the apply still claims the profile as active");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } }, "the routing is unchanged");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json is untouched");
});

test("applying a populated profile whose routes match and whose orchestrator is already set skips the confirmation", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	// writeSettings defaults to nan/deepseek-v4-flash · high; the profile's
	// orchestrator entry says the same, and the live session still runs on it,
	// so nothing changes anywhere.
	writeSettings();
	fixture.setLiveModel("nan", "deepseek-v4-flash", "high");
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" }, worker: { model: "openai/alpha" } } });

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 0, "an already-active profile must not ask for confirmation");
	assert.deepEqual(fixture.liveSwitches, [], "the no-op apply performs no live switch: the orchestrator is already there");
	assert.equal(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
});

test("applying a populated profile keeps the confirmation when the live session runs a different model", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	// settings.json and the profile agree on openai/alpha · high, but the live
	// session was switched to openai/beta mid-session: applying would move the
	// live session, so the no-op skip must not fire and the dialog must stay.
	writeSettings({ defaultProvider: "openai", defaultModel: "alpha", defaultThinkingLevel: "high" });
	fixture.setLiveModel("openai", "beta", "high");
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { model: "openai/alpha", thinking: "high" }, worker: { model: "openai/alpha" } } });

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a live-session orchestrator move is a real change and must confirm");
	assert.deepEqual(fixture.liveSwitches, [], "declining must not switch the live session");
	assert.notEqual(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
});

test("applying a populated profile keeps the confirmation when settings.json holds an invalid thinking level", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	// The stored defaultThinkingLevel is not a valid level: readOrchestratorSettings
	// drops it from the entry, but applyOrchestratorSettings would delete the key
	// and rewrite the file, so "unchanged" cannot be proven and the dialog stays.
	writeSettings({ defaultThinkingLevel: "banana" });
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { model: "nan/deepseek-v4-flash" }, worker: { model: "openai/alpha" } } });
	const settingsBefore = readFileSync(settingsPath, "utf8");

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "an invalid stored thinking level cannot prove a no-op");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "declining preserves the invalid key byte-identically");
	assert.notEqual(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
});

test("applying a populated profile keeps the confirmation when settings.json is unreadable and the profile has an orchestrator", async (t) => {
	const { fixture, storePath, writeStore, settingsPath } = profilesStoreFixture(t);
	writeFileSync(settingsPath, "{ not json\n");
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { model: "nan/glm5.3" }, worker: { model: "openai/alpha" } } });

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "an unreadable settings.json cannot prove an orchestrator no-op");
	assert.notEqual(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
});

test("applying a populated profile with a thinking-only orchestrator entry skips the confirmation", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// An orchestrator entry without a model is a no-op for the orchestrator:
	// applyOrchestratorSettings treats a missing model as "leave settings.json
	// alone", so the apply moves nothing and must not confirm (issue #1683).
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { thinking: "max" }, worker: { model: "openai/alpha" } } });
	const settingsBefore = readFileSync(settingsPath, "utf8");

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 0, "a thinking-only orchestrator entry changes nothing and must not confirm");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /already matches the current global routing/.test(entry.message)),
		`the no-op apply is disclosed with an informational notice: ${JSON.stringify(fixture.notifications)}`,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json is untouched");
	assert.deepEqual(fixture.liveSwitches, [], "a thinking-only orchestrator entry never switches the live session");
	assert.equal(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
});

test("applying a populated profile with matching routes but a different orchestrator still confirms", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({ team: { orchestrator: { model: "nan/glm5.3", thinking: "max" }, worker: { model: "openai/alpha" } } });

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "an orchestrator change is a real change and must confirm");
	assert.match(fixture.confirmCalls[0]?.[0] ?? "", /Apply profile/);
	assert.notEqual(JSON.parse(readFileSync(storePath, "utf8")).active, "team", "declining leaves the store untouched");
});

test("profile replacement with 23 routes changes files only after confirmation", async (t) => {
	for (const approved of [false, true]) {
		await t.test(approved ? "confirmed replacement" : "declined replacement", async (t) => {
			const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
			writeSettings();
			writeStore({ team: { worker: { model: "openai/alpha" } } });
			const names = ["worker", "review-refuter", ...Array.from({ length: 21 }, (_, i) => `helper-${i + 1}`)];
			const profiles = Object.fromEntries(names.map((name) => [name, { model: "openai/beta", effort: "high" }]));
			const subagentsPath = join(fixture.root, ".pi", "subagents.json");
			writeFileSync(subagentsPath, `${JSON.stringify({ max_concurrency: 3, user_setting: { keep: true }, model_profiles: profiles })}\n`);
			writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/beta", thinking: "high" } })}\n`);
			const markdown = names.map((name) => join(fixture.root, ".pi", "agents", `${name}.md`));
			for (const [i, path] of markdown.entries()) writeMarkdown(path, `---\nname: ${names[i]}\ndescription: User agent\nmodel: openai/beta\nthinking: high\n---\nUser instruction for ${names[i]}.\n`);
			const files = [fixture.globalPath, subagentsPath, storePath, settingsPath, ...markdown];
			const before = files.map((path) => readFileSync(path, "utf8"));
			fixture.onConfirm(async () => approved);
			applyOnce(fixture);
			await fixture.run("gentle:profiles");
			assert.equal(fixture.confirmCalls.length, 1);
			assert.equal(fixture.confirmCalls[0][0], 'Apply profile "team"?');
			for (const name of names.slice(2)) assert.ok(fixture.confirmCalls[0][1].includes(`${name}: openai/beta · high → inherit`), `confirmation names ${name}`);
			assert.deepEqual(fixture.liveSwitches, [], "no orchestrator changes were requested");
			assert.equal(readFileSync(settingsPath, "utf8"), before[3]);
			if (!approved) {
				assert.deepEqual(files.map((path) => readFileSync(path, "utf8")), before, "declining preserves all 23 routes and Markdown, stores and settings byte-identically");
				return;
			}
			assert.deepEqual(JSON.parse(readFileSync(subagentsPath, "utf8")), { max_concurrency: 3, user_setting: { keep: true }, model_profiles: { worker: { model: "openai/alpha" }, "review-refuter": profiles["review-refuter"] } });
			assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } });
			assert.equal(JSON.parse(readFileSync(storePath, "utf8")).active, "team");
			for (const [i, path] of markdown.entries()) {
				const stored = readFileSync(path, "utf8");
				assert.ok(stored.endsWith(`User instruction for ${names[i]}.\n`));
				if (i === 0) { assert.match(stored, /^model: openai\/alpha$/m); assert.doesNotMatch(stored, /^thinking:/m); }
				else if (i === 1) assert.equal(stored, before[4 + i], "provider review role is not cleared");
				else { assert.doesNotMatch(stored, /^model:/m); assert.doesNotMatch(stored, /^thinking:/m); }
			}
		});
	}
});

test("applying a populated profile names materialized-only routes it would clear before asking", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// The saved global routing matches the profile exactly: "helper" is routed
	// only where the runtime actually resolves it (agent frontmatter and
	// subagents.json model profiles), and the apply clears it because the profile
	// omits it. models.json alone never speaks for "helper".
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { helper: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	writeStore({
		team: { worker: { model: "openai/alpha" } },
	});
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [title, message] = fixture.confirmCalls[0];
	assert.equal(title, 'Apply profile "team"?');
	assert.match(message, /helper: openai\/beta · high → inherit/, "the materialized-only route the apply clears must be named");
	assert.doesNotMatch(message, /already match/, "routes matching the saved routing must not hide a cleared materialized-only route");

	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models, "declined apply must preserve models.json byte-identically");
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents, "declined apply must preserve subagents.json byte-identically");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "declined apply must preserve the profiles store byte-identically");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "declined apply must preserve settings.json byte-identically");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
});

test("applying a populated profile clears the materialized-only route it named when confirmed", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { helper: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	writeStore({
		team: { worker: { model: "openai/alpha" } },
	});

	fixture.onConfirm(async () => true);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [, message] = fixture.confirmCalls[0];
	assert.match(message, /helper: openai\/beta · high → inherit/, "the dialog must name the materialized-only route before it is cleared");
	const subagents = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.equal("helper" in subagents.model_profiles, false, "confirming the apply clears the materialized-only route the dialog named");
	assert.doesNotMatch(readFileSync(helperPath, "utf8"), /^model:/m, "the materialized-only frontmatter route is dropped");
});

test("applying a populated profile with an orchestrator entry discloses the settings and live-session effects", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/beta" },
		},
	});

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [, message] = fixture.confirmCalls[0];
	assert.match(message, /replace global routing/, "the readable variant must keep naming the routing diff");
	assert.match(message, /settings\.json/, "the dialog must disclose that the orchestrator entry is set in settings.json");
	assert.match(message, /attempt to switch this session/, "the dialog must disclose the attempted live-session switch");
	assert.doesNotMatch(message, /will switch this session/, "the dialog must not promise an unconditional live switch");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
});

test("applying a populated profile with an orchestrator entry discloses the effects when the routing is unreadable", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// Malformed models.json keeps the unreadable-authority disclosure branch in
	// charge: the orchestrator effects must be added there, not swap it out.
	writeFileSync(fixture.globalPath, "{ not json\n");
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/alpha" },
		},
	});

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [, message] = fixture.confirmCalls[0];
	assert.match(message, /could not be read/, "the unreadable-authority disclosure must stay authoritative");
	assert.match(message, /settings\.json/, "the dialog must disclose that the orchestrator entry is set in settings.json");
	assert.match(message, /attempt to switch this session/, "the dialog must disclose the attempted live-session switch");
	assert.doesNotMatch(message, /will switch this session/, "the dialog must not promise an unconditional live switch");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
});

test("applying a populated profile with an unreadable routing authority discloses the replace effect instead of added labels", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, settingsPath } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	// Malformed JSON makes readModelRoutingAuthorityAsync report the global
	// models.json as invalid: real routes exist on disk but cannot be diffed.
	writeFileSync(fixture.globalPath, "{ not json\n");
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/alpha", effort: "high" } } }, null, 2)}\n`);
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/alpha" },
		},
	});
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};

	fixture.onConfirm(async () => false);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [title, message] = fixture.confirmCalls[0];
	assert.equal(title, 'Apply profile "team"?');
	assert.match(message, /could not be read/, "the dialog must disclose that the current global routing is unreadable");
	assert.match(message, /replace global routing/, "the dialog must name the global replacement");
	assert.match(message, /inherit/, "the dialog must disclose the clear-back-to-inherit effect");
	assert.doesNotMatch(message, /\(added\)/, "unread current routes must not be presented as merely added");

	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models, "declined apply must preserve models.json byte-identically");
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents, "declined apply must preserve subagents.json byte-identically");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "declined apply must preserve the profiles store byte-identically");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "declined apply must preserve settings.json byte-identically");
	assert.deepEqual(fixture.liveSwitches, [], "declined apply must not switch the live session");
});

test("applying a populated profile with an unreadable routing authority still applies when confirmed", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, "{ not json\n");
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/alpha" },
		},
	});

	fixture.onConfirm(async () => true);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const [, message] = fixture.confirmCalls[0];
	assert.match(message, /could not be read/, "the dialog must disclose that the current global routing is unreadable");
	const models = JSON.parse(readFileSync(fixture.globalPath, "utf8"));
	assert.deepEqual(models, {
		orchestrator: { model: "nan/glm5.3", thinking: "max" },
		worker: { model: "openai/alpha" },
	}, "confirmed apply proceeds as before despite the unreadable authority");
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.active, "team", "active profile must be set to team when confirmed");
});

test("applying a populated profile with explicit confirmation applies the routing diff", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha", thinking: "high" }, helper: { model: "openai/beta" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/alpha", effort: "high" }, helper: { model: "openai/beta" } } }, null, 2)}\n`);
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	const tracerPath = join(fixture.root, ".pi", "agents", "tracer.md");
	writeMarkdown(tracerPath, "---\nname: tracer\ndescription: Tracer\n---\nbody\n");
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "max" },
			worker: { model: "openai/beta", thinking: "max" },
			tracer: { model: "openai/alpha" },
		},
	});

	fixture.onConfirm(async () => true);

	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(fixture.confirmCalls.length, 1, "a populated global apply must ask for confirmation");
	const models = JSON.parse(readFileSync(fixture.globalPath, "utf8"));
	assert.deepEqual(models, {
		orchestrator: { model: "nan/glm5.3", thinking: "max" },
		worker: { model: "openai/beta", thinking: "max" },
		tracer: { model: "openai/alpha" },
	}, "confirmed apply replaces global routing with the profile");
	const subagents = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.equal("helper" in subagents.model_profiles, false, "the cleared agent loses its materialized route");
	assert.equal(subagents.model_profiles.worker?.model, "openai/beta", "the replaced route is materialized");
	assert.equal(subagents.model_profiles.tracer?.model, "openai/alpha", "the added agent is materialized");
	assert.doesNotMatch(readFileSync(helperPath, "utf8"), /^model:/m, "the cleared agent's frontmatter route is dropped");
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.active, "team", "active profile must be set to team when confirmed");
	assert.deepEqual(fixture.liveSwitches, [
		{ kind: "model", provider: "nan", id: "glm5.3" },
		{ kind: "thinking", level: "max" },
	], "the live session switches to the profile's orchestrator");
});

test("applying a profile replaces materialized routing for agents the profile omits", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	// Routing materialized earlier (a previous profile, the models screen, or a
	// migration) for an agent the new profile does not mention.
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\nthinking: high\n---\nbody\n");
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { helper: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	writeStore({ team: { worker: { model: "openai/alpha" } } });
	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	const profiles = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.deepEqual(profiles.model_profiles, { worker: { model: "openai/alpha" } }, "omitted agents lose their materialized route");
	const helper = readFileSync(helperPath, "utf8");
	assert.doesNotMatch(helper, /^model:/m);
	assert.doesNotMatch(helper, /^thinking:/m);
	assert.match(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), /model: openai\/alpha/);
	// models.json stays the profile itself, not a padded copy.
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } });
	const applied = fixture.notifications.at(-1)?.message ?? "";
	assert.match(applied, /applied profile "team"/);
});

test("a failed apply restores the previous profile's routing with the same replacement semantics", async (t) => {
	const { fixture, settingsPath, writeStore } = profilesStoreFixture(t);
	// An unreadable settings.json makes the orchestrator write fail after the
	// routing was already materialized, which triggers the rollback path.
	writeFileSync(settingsPath, "{ not json\n");
	const helperPath = join(fixture.root, ".pi", "agents", "helper.md");
	writeMarkdown(helperPath, "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { helper: { model: "openai/beta" } } }, null, 2)}\n`);
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ helper: { model: "openai/beta" } }, null, 2)}\n`);
	// "team" is listed first, so Enter applies it while "old" stays the active one.
	writeStore({
		team: { orchestrator: { model: "nan/glm5.3" }, worker: { model: "openai/alpha" } },
		old: { helper: { model: "openai/beta" } },
	}, "old");
	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	const warning = fixture.notifications.find((entry) => /could not apply profile "team"/.test(entry.message));
	assert.ok(warning, "the failed apply is reported");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { helper: { model: "openai/beta" } });
	const profiles = JSON.parse(readFileSync(subagentsPath, "utf8"));
	assert.deepEqual(profiles.model_profiles, { helper: { model: "openai/beta" } }, "the previous routing is materialized again and the failed profile's routes are cleared");
	assert.match(readFileSync(helperPath, "utf8"), /model: openai\/beta/);
	assert.doesNotMatch(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), /^model:/m);
	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.equal(store.active, "old");
});

test("From what's running now creates a profile from the routing in effect without applying it", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha", thinking: "minimal" } }, null, 2)}\n`);
	const subagentsPath = join(fixture.root, ".pi", "subagents.json");
	writeFileSync(subagentsPath, `${JSON.stringify({ model_profiles: { worker: { model: "openai/beta", effort: "high" } } }, null, 2)}\n`);
	const workerPath = join(fixture.root, ".pi", "agents", "worker.md");
	const before = {
		models: readFileSync(fixture.globalPath, "utf8"),
		subagents: readFileSync(subagentsPath, "utf8"),
		worker: readFileSync(workerPath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};
	writeStore({ "a-target": {}, "z-active": { worker: { model: "openai/beta" } } }, "z-active");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.newFromLive, "captured");

	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.deepEqual(store.profiles.captured, {
		worker: { model: "openai/alpha", thinking: "minimal" },
		orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
	});
	assert.deepEqual(store.profiles["a-target"], {}, "no existing profile is overwritten");
	assert.deepEqual(store.profiles["z-active"], { worker: { model: "openai/beta" } });
	assert.equal(store.active, "z-active");
	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models);
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents);
	assert.equal(readFileSync(workerPath, "utf8"), before.worker);
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings);
	assert.equal(selectedProfileTitle(reopened), "captured", "the screen shows the new profile");
	assert.match(profilesPanelFooter(reopened), /Created "captured" from what's running now\./);
});

test("From what's running now captures the live session's orchestrator over the settings defaults", async (t) => {
	const { fixture, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ "z-active": { worker: { model: "openai/beta" } } }, "z-active");
	// The session runs live on openai/omega at low effort while settings.json still
	// defaults to nan/deepseek-v4-flash at high: the capture must be the session the
	// user is actually in, not the default new sessions would get.
	fixture.setLiveModel("openai", "omega", "low");
	const settingsBefore = readFileSync(settingsPath, "utf8");
	await runProfilesNameAction(fixture, SCREEN_KEYS.newFromLive, "captured");
	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.deepEqual(store.profiles.captured.orchestrator, { model: "openai/omega", thinking: "low" });
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings are untouched");
});

/** Moves the cursor to the orchestrator row, the first row of the table. */
function chooseOrchestrator(panel: RoutingConsumerPanel): void {
	for (let step = 0; step < 4; step++) panel.handleInput("\x1b[A");
	assert.match(renderComponent(panel), /▸ Orchestrator/);
}

/** Opens the model card on the cursor row, types a search, and picks the first match. */
function chooseModel(panel: RoutingConsumerPanel, query: string): void {
	panel.handleInput("\r");
	for (const character of query) panel.handleInput(character);
	panel.handleInput("\r");
}

/** Opens the effort row on the cursor row and picks a level by moving the bracket to it. */
function chooseEffort(panel: RoutingConsumerPanel, effort: string): void {
	panel.handleInput("e");
	for (let step = 0; step < 10; step++) panel.handleInput("\x1b[D");
	for (let step = 0; step < 10 && !renderComponent(panel).includes(`[${effort}]`); step++) panel.handleInput("\x1b[C");
	assert.ok(renderComponent(panel).includes(`[${effort}]`), `effort ${effort} is offered`);
	panel.handleInput("\r");
}

/** Moves the cursor to an agent row by name. */
function chooseAgent(panel: RoutingConsumerPanel, agent: string): void {
	for (let step = 0; step < 20 && !new RegExp(`▸ ${agent}\\s`).test(renderComponent(panel)); step++) panel.handleInput("j");
	assert.match(renderComponent(panel), new RegExp(`▸ ${agent}\\s`));
}

test("models screen saves the explicit orchestrator choice into the profile", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	// Use in this session binds the fixture session in a process-wide store.
	t.after(() => resetSessionProfileBindingsForTesting());
	writeSettings();
	const settingsBefore = readFileSync(settingsPath, "utf8");
	fixture.setLiveModel("openai", "alpha", "high");
	writeStore({ team: { orchestrator: { model: "nan/glm5.3", thinking: "max" } } }, "team");
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			assert.match(renderComponent(panel), /Orchestrator\s+nan\/glm5\.3\s+max/);
			chooseOrchestrator(panel);
			chooseModel(panel, "beta");
			chooseEffort(panel, "low");
			chooseAgent(panel, "worker");
			chooseModel(panel, "alpha");
			chooseEffort(panel, "high");
			assert.match(renderComponent(panel), /Orchestrator\s+openai\/beta\s+low/);
			panel.handleInput("\x13");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const snapshot = JSON.parse(readFileSync(storePath, "utf8")).profiles.team;
	assert.deepEqual(snapshot.orchestrator, { model: "openai/beta", thinking: "low" });
	assert.deepEqual(snapshot.worker, { model: "openai/alpha", thinking: "high" });
	assert.equal(existsSync(fixture.globalPath), false, "Save never writes global routing");
	assert.equal(existsSync(join(fixture.root, ".pi", "subagents.json")), false, "Save never materializes agent routing");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
	assert.deepEqual(fixture.liveSwitches, [], "saving never switches the live model or effort");
	assert.equal(fixture.notifications.some((entry) => entry.severity === "warning"), false);

	// Use in this session still drives the live session.
	actOnProfile(fixture, "u");
	await fixture.run("gentle:profiles");
	assert.deepEqual(fixture.liveSwitches, [
		{ kind: "model", provider: "openai", id: "beta" },
		{ kind: "thinking", level: "low" },
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
});

test("models screen leave untouched removes a stale profile orchestrator and keeps the live model on use", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	t.after(() => resetSessionProfileBindingsForTesting());
	writeSettings();
	const settingsBefore = readFileSync(settingsPath, "utf8");
	fixture.setLiveModel("openai", "alpha", "low");
	writeStore({ team: { orchestrator: { model: "openai/beta", thinking: "high" } } }, "team");
	writeFileSync(fixture.globalPath, JSON.stringify({ orchestrator: { model: "openai/beta", thinking: "high" }, worker: { model: "openai/alpha" } }));
	const globalBefore = readFileSync(fixture.globalPath, "utf8");
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			chooseOrchestrator(panel);
			chooseModel(panel, "leave untouched");
			assert.match(renderComponent(panel), /Orchestrator\s+leave untouched/);
			panel.handleInput("\x13");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(Object.hasOwn(JSON.parse(readFileSync(storePath, "utf8")).profiles.team, "orchestrator"), false);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), globalBefore, "Save never writes global routing");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
	assert.deepEqual(fixture.liveSwitches, []);
	actOnProfile(fixture, "u");
	await fixture.run("gentle:profiles");
	assert.deepEqual(fixture.liveSwitches, [], "a profile without an orchestrator keeps the live model and effort");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
});

for (const [name, keys] of [["ctrl+s", ["\x13"]], ["esc twice", ["\x1b", "\x1b"]]] as const) {
	test(`models screen ${name} ${name === "ctrl+s" ? "persists the profile without touching global state" : "persists nothing"}`, async (t) => {
		const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
		writeSettings();
		fixture.setLiveModel("openai", "alpha", "high");
		writeStore({ team: { orchestrator: { model: "openai/alpha", thinking: "high" } } }, "team");
		const storeBefore = readFileSync(storePath, "utf8");
		const settingsBefore = readFileSync(settingsPath, "utf8");
		let visits = 0;
		fixture.onInput((panel) => {
			visits += 1;
			if (visits === 1) {
				chooseOrchestrator(panel);
				chooseModel(panel, "beta");
				chooseEffort(panel, "low");
				for (const key of keys) panel.handleInput(key);
				return;
			}
			panel.handleInput("\x1b");
		});
		await fixture.run("gentle:profiles");
		assert.deepEqual(fixture.liveSwitches, []);
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
		if (name === "ctrl+s") {
			assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.team.orchestrator, { model: "openai/beta", thinking: "low" });
			assert.equal(existsSync(fixture.globalPath), false);
		} else {
			assert.equal(readFileSync(storePath, "utf8"), storeBefore);
			assert.equal(visits, 1, "the second esc closes the screen");
		}
	});
}

test("models screen Model ▾ and Effort ▾ set every agent to inherit and leave the orchestrator alone", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { orchestrator: { model: "openai/alpha", thinking: "high" }, worker: { model: "openai/beta", thinking: "low" } } }, "team");
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			chooseOrchestrator(panel);
			panel.handleInput("j"); // the header row: every agent
			assert.match(renderComponent(panel), /▸ Agent\s+Model ▾/);
			chooseModel(panel, "inherit");
			panel.handleInput("e");
			for (let step = 0; step < 10; step++) panel.handleInput("\x1b[D");
			panel.handleInput("\r");
			panel.handleInput("\x13");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const profile = JSON.parse(readFileSync(storePath, "utf8")).profiles.team;
	assert.deepEqual(profile.worker, {});
	assert.deepEqual(profile.orchestrator, { model: "openai/alpha", thinking: "high" });
});

test("models screen custom model id: a valid id lands in the draft, an invalid one changes nothing", async (t) => {
	for (const [answer, expected] of [["openai/custom-1", "openai/custom-1"], ["bad\nmodel: injected", "openai/beta"]] as const) {
		await t.test(answer.includes("\n") ? "invalid" : "valid", async (t) => {
			const { fixture, storePath, writeStore } = profilesStoreFixture(t);
			writeStore({ team: { worker: { model: "openai/beta" } } }, "team");
			fixture.answerInputs(answer);
			let visits = 0;
			fixture.onInput((panel) => {
				visits += 1;
				if (visits === 1) {
					chooseAgent(panel, "worker");
					panel.handleInput("\r");
					for (const character of "zzz") panel.handleInput(character); // no catalog match: only Custom model id… is left
					assert.match(renderComponent(panel), /▸ Custom model id…/);
					panel.handleInput("\r");
					return;
				}
				if (visits === 2) {
					assert.match(renderComponent(panel), new RegExp(`worker\\s+${expected.replace("/", "\\/")}`));
					// A rejected id leaves nothing to save, so the screen just closes.
					panel.handleInput(expected === "openai/beta" ? "\x1b" : "\x13");
					return;
				}
				panel.handleInput("\x1b");
			});
			await fixture.run("gentle:profiles");
			assert.match(fixture.inputPrompts[0]?.title ?? "", /Custom model id for worker/);
			assert.equal(JSON.parse(readFileSync(storePath, "utf8")).profiles.team.worker.model, expected);
			if (expected === "openai/beta") assert.match(fixture.panels[1] ?? "", /Custom model id must be one provider\/model line/);
		});
	}
});

test("models screen Save preserves an absent orchestrator and sibling profiles", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	const settingsBefore = readFileSync(settingsPath, "utf8");
	fixture.setLiveModel("openai", "alpha", "low");
	writeStore({
		team: { worker: { model: "openai/beta" } },
		other: { worker: { model: "openai/beta", thinking: "high" } },
	}, "team");
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			assert.match(renderComponent(panel), /Orchestrator\s+leave untouched/);
			chooseAgent(panel, "worker");
			chooseModel(panel, "alpha");
			panel.handleInput("\x13");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(fixture.globalPath), false, "Save never writes global routing");
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(store.profiles.team, { worker: { model: "openai/alpha" } });
	assert.deepEqual(fixture.liveSwitches, []);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "global defaults remain unchanged");
	assert.deepEqual(store.profiles.other, { worker: { model: "openai/beta", thinking: "high" } });
	assert.equal(store.active, "team");
	assert.equal(visits, 2);
});

test("gentle:profiles opens on the pinned profile and Save preserves its stored orchestrator", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings, writePin, localPinPath } = profilesStoreFixture(t);
	writeSettings();
	const settingsBefore = readFileSync(settingsPath, "utf8");
	fixture.setLiveModel("openai", "alpha", "low");
	writeStore({
		team: { worker: { model: "openai/beta" } },
		other: { worker: { model: "openai/beta", thinking: "high" }, orchestrator: { model: "openai/beta", thinking: "high" } },
	}, "team");
	writePin(localPinPath, "other");
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			assert.equal(shownProfile(panel), "other", "the pin preselects its profile");
			assert.match(renderComponent(panel), /Orchestrator\s+openai\/beta\s+high/);
			chooseAgent(panel, "worker");
			chooseModel(panel, "alpha");
			panel.handleInput("\x13");
			return;
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(store.profiles.other, {
		worker: { model: "openai/alpha", thinking: "high" },
		orchestrator: { model: "openai/beta", thinking: "high" },
	});
	assert.deepEqual(fixture.liveSwitches, []);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
	assert.deepEqual(store.profiles.team, { worker: { model: "openai/beta" } });
	assert.equal(store.active, "team");
	assert.equal(visits, 2);
});

test("gentle:profiles seeds the profiles store when it is missing", async (t) => {
	const { fixture, storePath, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	assert.equal(existsSync(storePath), false);
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits === 1) {
			assert.equal(shownProfile(panel), "current");
			assert.match(renderComponent(panel), /Orchestrator\s+leave untouched/, "the seed captures agent routing only");
		}
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.kind, PROFILES_KIND);
	assert.deepEqual(store.profiles.current, {});
	assert.equal(store.active, undefined);
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /seeded the "current" profile/.test(entry.message)),
		`seeding is reported: ${JSON.stringify(fixture.notifications)}`,
	);
	assert.equal(visits, 1);
});

test("the profiles command seeds and shows the routing the runtime uses when models.json is sparse", async (t) => {
	const { fixture } = profilesStoreFixture(t);
	// No models.json at all, but routing is materialized where the runtime
	// reads it: subagents.json for worker, frontmatter only for helper.
	writeMarkdown(join(fixture.root, ".pi", "agents", "helper.md"), "---\nname: helper\ndescription: Helper\nmodel: openai/beta\n---\nbody\n");
	writeFileSync(join(fixture.root, ".pi", "subagents.json"), `${JSON.stringify({ model_profiles: { worker: { model: "openai/alpha", effort: "high" } } }, null, 2)}\n`);
	let rendered: string | undefined;
	fixture.onInput((panel) => {
		rendered = stripAnsi(renderComponent(panel));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");

	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.equal(store.active, "current", "materialized routing counts as existing routing");
	assert.deepEqual(store.profiles.current, {
		worker: { model: "openai/alpha", thinking: "high" },
		helper: { model: "openai/beta" },
	});
	assert.ok(rendered);
	assert.match(rendered, /worker\s+openai\/alpha\s+high/, "the seeded profile shows the routing in effect");
	assert.match(rendered, /helper\s+openai\/beta/);
});

for (const reader of ["readEffectiveModelConfig", "readEffectiveModelConfigAsync"] as const) {
	test(`${reader} retains frontmatter model with a profile-only effort override`, async (t) => {
		const fixture = routingConsumerFixture(t, ["worker"]);
		writeMarkdown(join(fixture.root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: Worker\nmodel: openai-codex/gpt-5.6-terra\nthinking: high\n---\nbody\n");
		writeFileSync(join(fixture.root, ".pi", "subagents.json"), `${JSON.stringify({
			model_profiles: { worker: { effort: "low" } },
		})}\n`);

		const effective = await __testing[reader](fixture.root);
		assert.deepEqual(JSON.parse(JSON.stringify(effective.worker)), {
			model: "openai-codex/gpt-5.6-terra",
			thinking: "low",
		});
	});
}

test("effective routing prefers models.json over the materialized stores", (t) => {
	const fixture = routingConsumerFixture(t, ["worker", "helper"]);
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/alpha" } }, null, 2)}\n`);
	writeFileSync(join(fixture.root, ".pi", "subagents.json"), `${JSON.stringify({
		model_profiles: { worker: { model: "openai/beta", effort: "high" }, helper: { model: "openai/beta" } },
	}, null, 2)}\n`);
	const effective = JSON.parse(JSON.stringify(__testing.readEffectiveModelConfig(fixture.root)));
	assert.deepEqual(effective, {
		worker: { model: "openai/alpha" },
		helper: { model: "openai/beta" },
	});
	assert.equal(existsSync(join(fixture.root, ".pi", "gentle-ai", "models.json")), false, "reading never writes");
});

// Issue #2196: a profile key that names no discovered agent was silently
// ignored at launch. gentle-pi#2271: provider review roles are routed by key
// and never have an agent file, so they are never flagged.
test("the models screen flags profile keys no agent matches and never flags provider review roles", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "high" },
			worker: { model: "openai/alpha", thinking: "high" },
			"sdd-design": { model: "nan/glm5.3", thinking: "high" },
			"review-refuter": { model: "nan/glm5.3", thinking: "high" },
		},
	}, "team");
	let rendered = "";
	fixture.onInput((visited) => {
		rendered = stripAnsi(renderComponent(visited));
		visited.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const flat = (rendered: string) => rendered.replace(/\s*│\s*/g, " ").replace(/\s+/g, " ");
	assert.equal(rendered.split("\n").length, 24, "the frame spans the terminal height");
	assert.match(flat(rendered), /⚠ Profile key "sdd-design" matches no agent configured in gentle-shell, so it is ignored at launch\./);
	assert.doesNotMatch(flat(rendered), /review-refuter"/, "provider review roles are never flagged");
	assert.match(rendered, /Orchestrator\s+nan\/glm5\.3\s+high/);
	assert.match(rendered, /worker\s+openai\/alpha\s+high/);
	assert.match(rendered, /review-refuter\s+nan\/glm5\.3\s+high/);
});

test("at 60 columns the unmatched-key notice wraps instead of being cut", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({
		team: {
			worker: { model: "openai/alpha", thinking: "high" },
			"sdd-design": { model: "nan/glm5.3", thinking: "high" },
		},
	}, "team");
	let panel: { render(width: number): string[] } | undefined;
	fixture.onInput((visited) => {
		panel = visited;
		visited.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.ok(panel);
	const narrow = stripAnsi(panel.render(60).join("\n"));
	const flat = (rendered: string) => rendered.replace(/\s*│\s*/g, " ").replace(/\s+/g, " ");
	assert.match(flat(narrow), /⚠ Profile key "sdd-design" matches no agent configured in gentle-shell, so it is ignored at launch\./);
	assert.ok(!narrow.split("\n").some((line) => line.includes("…")), "nothing is cut");
});

// Issue #2400: a subagents.json model_profiles key that matches no discovered
// agent and suggests none is ignored at launch; the screen names it. A key with
// a suggestion is left to the launch warning.
test("the models screen names subagents.json keys that match no agent and suggest none", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha", thinking: "high" } } }, "team");
	writeFileSync(join(fixture.root, ".pi", "subagents.json"), `${JSON.stringify({
		model_profiles: {
			worker: { model: "openai/alpha" },
			explor: { model: "openai/beta" },
			"sdd-orchestratr-x": { model: "openai/beta" },
			"gentle-ai-worker": { model: "openai/beta" },
		},
	}, null, 2)}\n`);
	let panel: { render(width: number): string[] } | undefined;
	fixture.onInput((visited) => {
		panel = visited;
		visited.handleInput("\x1b");
	});
	fixture.tui.terminal.rows = 40;
	await fixture.run("gentle:profiles");
	assert.ok(panel);
	const flat = (rendered: string) => rendered.replace(/\s*│\s*/g, " ").replace(/\s+/g, " ");
	for (const width of [120, 60]) {
		const text = stripAnsi(panel.render(width).join("\n"));
		assert.match(flat(text), /⚠ subagents\.json routes "explor", "sdd-orchestratr-x", which no agent matches, so they are ignored\./);
		assert.doesNotMatch(text, /gentle-ai-worker/, "a key with a suggestion is not listed");
		assert.ok(!text.split("\n").some((line) => line.includes("…")), `nothing is cut at ${width}`);
	}
});

// Issue #2400: when a pin wins, launches route from the pinned snapshot, so the
// subagents.json keys are not the routing in effect and are not listed.
test("the subagents.json notice stays off the screen while a pin wins", async (t) => {
	const { fixture, writeStore, writePin, localPinPath } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha", thinking: "high" } } }, "team");
	writePin(localPinPath, "team");
	writeFileSync(join(fixture.root, ".pi", "subagents.json"), `${JSON.stringify({ model_profiles: { explor: { model: "openai/beta" } } }, null, 2)}\n`);
	let text = "";
	fixture.onInput((visited) => {
		text = stripAnsi(renderComponent(visited));
		visited.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.match(text, /Used in this repo\./);
	assert.doesNotMatch(text, /subagents\.json routes/);
});

// The name prompt behind c, d, and r: the Pi host starts the field empty and
// ignores the placeholder, and every outcome must show in the reopened panel,
// because the fullscreen overlay hides notifications until it closes.
/** The keys that reach each profile action on the models screen. */
const SCREEN_KEYS = {
	rename: ["m", "\r"],
	duplicate: ["m", "j", "\r"],
	useInRepo: ["m", "j", "j", "\r"],
	delete: ["m", "j", "j", "j", "\r"],
	newCopy: ["n", "\r"],
	newFromLive: ["n", "j", "\r"],
	newEmpty: ["n", "j", "j", "\r"],
} as const;

/**
 * Runs one screen action on a profile (the shown one by default) with scripted
 * name-prompt answers, then returns the screen the loop reopened with.
 */
async function runProfilesNameAction(
	fixture: ReturnType<typeof routingConsumerFixture>,
	keys: readonly string[],
	...answers: Array<string | undefined>
): Promise<string> {
	return runProfilesNameActionOn(fixture, undefined, keys, ...answers);
}

async function runProfilesNameActionOn(
	fixture: ReturnType<typeof routingConsumerFixture>,
	name: string | undefined,
	keys: readonly string[],
	...answers: Array<string | undefined>
): Promise<string> {
	fixture.answerInputs(...answers);
	let acted = false;
	fixture.onInput((panel) => {
		if (acted) return panel.handleInput("\x1b");
		const tabs = tabNames(panel);
		for (let step = 0; name !== undefined && step < tabs.length && shownProfile(panel) !== name; step++) {
			panel.handleInput(tabs.indexOf(name) < tabs.indexOf(shownProfile(panel)) ? "\x1b[D" : "\x1b[C");
		}
		if (name !== undefined) assert.equal(shownProfile(panel), name);
		acted = true;
		for (const key of keys) panel.handleInput(key);
	});
	await fixture.run("gentle:profiles");
	return fixture.panels.at(-1) ?? "";
}

/** The profile a rendered screen shows. */
function selectedProfileTitle(rendered: string): string {
	return (rendered.split("\n")[3] ?? "").replace(/^│\s*/, "").split(/\s{3}|\s*│/)[0]?.trim() ?? "";
}

/** The feedback lines under the key hints of a rendered screen. */
function profilesPanelFooter(rendered: string): string {
	const lines = rendered.split("\n");
	const hints = lines.findIndex((line) => line.includes("enter model"));
	return lines.slice(hints + 1, hints + 3).map((line) => line.replace(/^│\s*/, "").replace(/\s*│$/, "")).join(" ").trim();
}

test("c creates the named profile, selects it, and reports it in the reopened panel", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.newEmpty, " deep-work ");

	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(Object.keys(store.profiles), ["team", "deep-work"]);
	assert.equal(selectedProfileTitle(reopened), "deep-work");
	assert.match(profilesPanelFooter(reopened), /Profile "deep-work" created\./);
});

test("c with an empty name creates nothing and says so in the reopened panel", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const before = readFileSync(storePath, "utf8");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.newEmpty, "  ");

	assert.equal(readFileSync(storePath, "utf8"), before, "nothing is written");
	assert.equal(selectedProfileTitle(reopened), "team");
	assert.match(profilesPanelFooter(reopened), /No profile created: no name entered\./);
});

test("d with an empty name duplicates to the suggested <name>-copy and selects it", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.duplicate, "");

	// The host never shows the placeholder, so the suggestion lives in the title.
	assert.match(fixture.inputPrompts[0]?.title ?? "", /Duplicate profile "team" as \(empty = team-copy\)/);
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(store.profiles["team-copy"], { worker: { model: "openai/alpha" } });
	assert.equal(selectedProfileTitle(reopened), "team-copy");
	assert.match(profilesPanelFooter(reopened), /Profile "team" duplicated as "team-copy"\./);
});

test("d onto an existing name writes nothing and shows the conflict in the reopened panel", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } }, other: {} }, "team");
	const before = readFileSync(storePath, "utf8");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.duplicate, "other");

	assert.equal(readFileSync(storePath, "utf8"), before, "nothing is written");
	assert.equal(selectedProfileTitle(reopened), "team");
	assert.match(profilesPanelFooter(reopened), /Profile not duplicated: Profile already exists: other\./);
});

test("r with an empty name leaves the profile unchanged and says so in the reopened panel", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const before = readFileSync(storePath, "utf8");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.rename, "");

	assert.match(fixture.inputPrompts[0]?.title ?? "", /Rename profile "team" to \(empty = keep team\)/);
	assert.equal(readFileSync(storePath, "utf8"), before, "nothing is written");
	assert.equal(selectedProfileTitle(reopened), "team");
	assert.match(profilesPanelFooter(reopened), /Profile "team" unchanged: no new name entered\./);
});

test("r renames the profile, keeps it selected under the new name, and reports it", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } }, other: {} }, "team");
	// Rename the second tab, so the reopened screen cannot land on it by default.
	const reopened = await runProfilesNameActionOn(fixture, "other", SCREEN_KEYS.rename, "focus");

	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(Object.keys(store.profiles), ["team", "focus"]);
	assert.equal(store.active, "team");
	assert.equal(selectedProfileTitle(reopened), "focus");
	assert.match(profilesPanelFooter(reopened), /Profile "other" renamed to "focus"\./);
});

test("escape on the name prompt cancels without writing and says so in the reopened panel", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const before = readFileSync(storePath, "utf8");
	const reopened = await runProfilesNameAction(fixture, SCREEN_KEYS.duplicate, undefined);

	assert.equal(readFileSync(storePath, "utf8"), before, "nothing is written");
	assert.match(profilesPanelFooter(reopened), /Duplicate cancelled\./);
});

// The pin is the per-repository layer of the profiles command: Use in this repo
// (profile menu) writes the clone-scoped pin inside the Git common directory,
// `/gentle:profiles publish <name>` writes the committable per-worktree
// declaration. Neither writes routing.
test("Use in this repo pins the shown profile for the clone without touching the global routing", async (t) => {
	const { fixture, storePath, localPinPath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const storeBefore = readFileSync(storePath, "utf8");
	let firstPanel: RoutingConsumerPanel | undefined;
	let reopenedPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			for (const key of SCREEN_KEYS.useInRepo) panel.handleInput(key);
		} else {
			reopenedPanel = panel;
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");

	assert.equal(
		readFileSync(localPinPath, "utf8"),
		`${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "team" }, null, 2)}\n`,
	);
	assert.equal(existsSync(repoPinPath), false, "Use in this repo writes the clone-scoped layer only");
	assert.equal(readFileSync(storePath, "utf8"), storeBefore, "a pin stores a name, never routing");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /pinned profile "team" for this clone in /);
	assert.ok(firstPanel);
	// The reopened screen marks the profile used in this repo (⌂) and says so.
	assert.ok(reopenedPanel);
	assert.match(stripAnsi(renderComponent(reopenedPanel)), /team ★⌂/);
	assert.match(stripAnsi(renderComponent(reopenedPanel)), /Used in this repo\./);
	// Rendering an existing screen must not resolve Git or read the pin again.
	setProfilePinWorktreeResolverForTesting(() => { throw new Error("unexpected pin read during render"); });
	assert.doesNotMatch(stripAnsi(renderComponent(firstPanel!)), /Used in this repo\./);
	assert.match(stripAnsi(renderComponent(reopenedPanel)), /Used in this repo\./);
});

test("the profile pin scope note sanitizes its worktree-derived path", (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const commonDir = join(fixture.root, "git-\x1b]52;c;payload\x07-common");
	const localPath = join(commonDir, "gentle-ai", "profile-pin.json");
	writeProfilePinSync(localPath, "team");
	setProfilePinWorktreeResolverForTesting(() => ({ root: fixture.root, commonDir }));

	const note = __testing.profilePinScopeNote(fixture.root);
	assert.ok(note);
	assert.doesNotMatch(note, /[\x00-\x1f\x7f-\x9f]/);
	assert.doesNotMatch(note, /payload/);
	assert.match(note, /profile-pin\.json/);
});

test("publish declares the profile in the worktree so the routing can be committed", async (t) => {
	const { fixture, localPinPath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	await fixture.run("gentle:profiles", "publish team");
	assert.equal(fixture.panelVisits(), 0, "publish is a subcommand: no screen opens");

	assert.equal(
		readFileSync(repoPinPath, "utf8"),
		`${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "team" }, null, 2)}\n`,
	);
	assert.equal(existsSync(localPinPath), false, "publish writes the worktree declaration only");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /declared profile "team" for this worktree in /);
});

test("a stale pin is named as missing instead of silently changing nothing", async (t) => {
	const { fixture, localPinPath, writeStore, writePin } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	writePin(localPinPath, "deleted-profile");
	let rendered: string | undefined;
	fixture.onInput((panel) => {
		if (rendered === undefined) rendered = stripAnsi(renderComponent(panel));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.match(rendered ?? "", /⚠ The local pin names "deleted-profile", which no profile defines, so it is\s+(│\s+)?ignored/);
});

test("pinning outside a Git worktree warns and writes nothing", async (t) => {
	const { fixture, localPinPath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	// The fixture installs a sandbox identity; this session has no worktree at all.
	setProfilePinWorktreeResolverForTesting(() => undefined);
	let visits = 0;
	fixture.onInput((panel) => {
		assert.ok(++visits <= 2, "outside-worktree fixture repeatedly reopens and pins the panel");
		// A completed panel ignores Escape; close the next visit instead.
		if (visits === 1) for (const key of SCREEN_KEYS.useInRepo) panel.handleInput(key);
		else panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(localPinPath), false);
	assert.equal(existsSync(repoPinPath), false);
	assert.match(fixture.notifications.at(-1)?.message ?? "", /not inside a Git worktree/);
	assert.match(profilesPanelFooter(fixture.panels.at(-1) ?? ""), /not inside a Git worktree, so nothing was pinned/);
});

test("Stop using in this repo removes the clone pin", async (t) => {
	const { fixture, localPinPath, writeStore, writePin } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	writePin(localPinPath, "team");
	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("m");
			assert.match(stripAnsi(renderComponent(panel)), /Stop using in this repo/, "the menu names the toggle by its effect");
			for (const key of SCREEN_KEYS.useInRepo.slice(1)) panel.handleInput(key);
		} else {
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(localPinPath), false, "using it again removes the layer instead of rewriting it");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /removed the local pin for this clone/);
});

test("the tab of the pinned profile carries ⌂ and the screen opens on it", async (t) => {
	const { fixture, localPinPath, writeStore, writePin } = profilesStoreFixture(t);
	writeStore({
		team: { worker: { model: "openai/alpha" } },
		other: { worker: { model: "openai/beta" } },
	}, "team");
	writePin(localPinPath, "other");
	let rendered: string | undefined;
	fixture.onInput((panel) => {
		if (rendered === undefined) rendered = stripAnsi(renderComponent(panel));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const tabLine = (rendered ?? "").split("\n")[1] ?? "";
	assert.match(tabLine, /other ⌂/);
	assert.doesNotMatch(tabLine, /team ★⌂/);
	assert.equal(selectedProfileTitle(rendered ?? ""), "other", "a winning pin is the profile the screen opens on");
});

test("an invalid pin file is surfaced by the panel instead of reading as no pin", async (t) => {
	const { fixture, localPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	mkdirSync(dirname(localPinPath), { recursive: true });
	writeFileSync(localPinPath, "{ not json\n");
	let rendered: string | undefined;
	fixture.onInput((panel) => {
		if (rendered === undefined) rendered = stripAnsi(renderComponent(panel));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	// The notice wraps between words; the frame's border columns sit between the lines.
	assert.match((rendered ?? "").replace(/\s*│\s*/g, " ").replace(/\s+/g, " "), /⚠ The local pin file .* is not a valid pin and is ignored\./);
	assert.doesNotMatch(rendered ?? "", /which no profile defines/);
	assert.equal(readFileSync(localPinPath, "utf8"), "{ not json\n", "reading never rewrites a broken pin");
});

test("applying a profile in a pinned repository re-pins the clone and writes no global routing", async (t) => {
	const { fixture, settingsPath, localPinPath, repoPinPath, writeStore, writeSettings, writePin } = profilesStoreFixture(t);
	writeSettings();
	const settingsBefore = readFileSync(settingsPath, "utf8");
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, `${JSON.stringify({ worker: { model: "openai/sentinel" } }, null, 2)}\n`);
	const modelsBefore = readFileSync(fixture.globalPath, "utf8");
	// "team" is listed first and is selected, so Enter applies it while "pinned" is the
	// profile this repository currently resolves.
	writeStore({
		team: { worker: { model: "openai/alpha" } },
		pinned: { worker: { model: "openai/beta" } },
	}, "pinned");
	writePin(localPinPath, "pinned");
	applyOnce(fixture);
	await fixture.run("gentle:profiles");

	assert.equal(
		readFileSync(localPinPath, "utf8"),
		`${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "team" }, null, 2)}\n`,
		"the clone is re-pinned to the applied profile",
	);
	assert.equal(existsSync(repoPinPath), false, "a committed declaration is never written by an apply");
	assert.equal(readFileSync(fixture.globalPath, "utf8"), modelsBefore, "no global routing was written");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "no orchestrator was written");
	assert.equal(existsSync(join(fixture.root, ".pi", "subagents.json")), false, "no materialized routing was written");
	assert.equal(fixture.confirmCalls.length, 0, "a repo-pinned apply never asks for confirmation");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /repo-scoped/);
});

test("deleting a profile is refused when a non-winning pin layer names it", async (t) => {
	const { fixture, localPinPath, repoPinPath, writeStore, writePin } = profilesStoreFixture(t);
	writeStore({
		team: { worker: { model: "openai/alpha" } },
		other: { worker: { model: "openai/beta" } },
	}, "team");
	// The local pin wins with "other"; the declaration names "team", a lower layer that
	// does not win but still names a live profile for this repository.
	writePin(localPinPath, "other");
	writePin(repoPinPath, "team");
	// The screen opens on "other" (the winning pin); go to "team" and delete it.
	actOnProfile(fixture, SCREEN_KEYS.delete, "team");
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(repoPinPath), true, "the declaration survives the refused delete");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /is pinned for this repository/);
	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.ok(store.profiles.team, "the profile is not deleted");
	assert.ok(store.profiles.other, "the other profile is untouched");
});

test("a rename follows the clone pin and leaves the committed declaration naming the old profile", () => {
	const base = mkdtempSync(join(tmpdir(), "gentle-pi-pin-rename-"));
	try {
		const renameRoot = join(base, "worktree");
		const commonDir = join(base, "git-common");
		mkdirSync(renameRoot, { recursive: true });
		setProfilePinWorktreeResolverForTesting(() => ({ root: renameRoot, commonDir }));
		const localPath = join(commonDir, "gentle-ai", "profile-pin.json");
		const repoPath = join(renameRoot, ".pi", "gentle-ai", "profile.json");
		writeProfilePinSync(localPath, "old");
		writeProfilePinSync(repoPath, "old");
		const follow = __testing.followRenamedPin(renameRoot, "old", "new");
		assert.deepEqual(follow.followed, [localPath]);
		assert.deepEqual(follow.stillDeclared, [repoPath]);
		assert.equal(JSON.parse(readFileSync(localPath, "utf8")).profile, "new");
		assert.equal(JSON.parse(readFileSync(repoPath, "utf8")).profile, "old", "the tracked declaration is never rewritten");
	} finally {
		setProfilePinWorktreeResolverForTesting();
		rmSync(base, { recursive: true, force: true });
	}
});

// getPiModelOptions guard branches (gentle-pi regression coverage)

function makeContext(registry?: ExtensionContext["modelRegistry"]): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		modelRegistry: registry,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

test("getPiModelOptions returns MODEL_CONTROL_OPTIONS when modelRegistry is absent", async () => {
	const options = await __testing.getPiModelOptions(makeContext());
	assert.deepEqual(options, ["Keep current", "Inherit active/default model", "Custom model id"]);
});

test("getPiModelOptions returns MODEL_CONTROL_OPTIONS when getAvailable throws", async () => {
	const registry = {
		getAvailable: async () => { throw new Error("registry unavailable"); },
	} as unknown as ExtensionContext["modelRegistry"];
	const options = await __testing.getPiModelOptions(makeContext(registry));
	assert.deepEqual(options, ["Keep current", "Inherit active/default model", "Custom model id"]);
});

test("getPiModelOptions returns MODEL_CONTROL_OPTIONS when getAvailable returns non-array", async () => {
	const registry = {
		getAvailable: async () => ({ provider: "openai", id: "gpt-5" }),
	} as unknown as ExtensionContext["modelRegistry"];
	const options = await __testing.getPiModelOptions(makeContext(registry));
	assert.deepEqual(options, ["Keep current", "Inherit active/default model", "Custom model id"]);
});

test("getPiModelOptions merges MODEL_CONTROL_OPTIONS with normalized sorted model list", async () => {
	const registry = {
		getAvailable: async () => [
			{ provider: "openai", id: "gpt-5.5" },
			{ provider: "anthropic", id: "opus-4" },
			{ provider: "openai", id: "gpt-5" },
		],
	} as unknown as ExtensionContext["modelRegistry"];
	const options = await __testing.getPiModelOptions(makeContext(registry));

	assert.equal(options[0], "Keep current");
	assert.equal(options[1], "Inherit active/default model");
	assert.equal(options[2], "Custom model id");

	const modelPart = options.slice(3);
	assert.deepEqual(
		modelPart,
		[
			"anthropic/opus-4",
			"openai/gpt-5",
			"openai/gpt-5.5",
		],
	);
});

test("getPiModelOptions drops models that normalize to undefined", async () => {
	const registry = {
		getAvailable: async () => [
			{ provider: "openai", id: "gpt-5" },
			{ provider: "anthropic", id: "claude 4" }, // space fails SAFE_MODEL_ID_PATTERN
			{ provider: "o|penai", id: "gpt-5" },       // pipe fails SAFE_MODEL_ID_PATTERN
		],
	} as unknown as ExtensionContext["modelRegistry"];
	const options = await __testing.getPiModelOptions(makeContext(registry));

	const modelPart = options.slice(3);
	assert.deepEqual(
		modelPart,
		[
			"openai/gpt-5",
		],
	);
});

// switchLiveOrchestrator regression coverage (gentle-pi)

test("switchLiveOrchestrator returns fallback note when modelRegistry is absent", async () => {
	const live = {
		setModel: async () => true,
		setThinkingLevel: () => {},
	} as unknown as LiveSession;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const entry: AgentRoutingEntry = {
		model: "openai/gpt-5",
	};
	const result = await __testing.switchLiveOrchestrator(ctx, live, entry);
	assert.equal(
		result,
		"\nModel registry unavailable; this session keeps its current model.",
	);
});

test("switchLiveOrchestrator returns fallback note when model not found in catalog", async () => {
	const registry = {
		find: () => undefined,
	} as unknown as ExtensionContext["modelRegistry"];
	const live = {
		setModel: async () => true,
		setThinkingLevel: () => {},
	} as unknown as LiveSession;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		modelRegistry: registry,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const entry: AgentRoutingEntry = {
		model: "openai/gpt-99",
	};
	const result = await __testing.switchLiveOrchestrator(ctx, live, entry);
	assert.equal(
		result,
		"\nopenai/gpt-99 is not in the model catalog; this session keeps its current model.",
	);
});

test("switchLiveOrchestrator returns note when setModel fails", async () => {
	const registry = {
		find: () => ({ provider: "openai", id: "gpt-5" }),
	} as unknown as ExtensionContext["modelRegistry"];
	const live = {
		setModel: async () => false,
		setThinkingLevel: () => {},
	} as unknown as LiveSession;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		modelRegistry: registry,
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const entry: AgentRoutingEntry = {
		model: "openai/gpt-5",
	};
	const result = await __testing.switchLiveOrchestrator(ctx, live, entry);
	assert.equal(result, "\nno authentication is configured for openai; this session keeps its current model.");
});

/** Reads the fixture's profiles store or fails the test: every panel-action fixture writes a valid store before acting. */
function readValidProfilesStore(path: string) {
	const result = readProfilesFileResult(path);
	if (result.status !== "valid") throw new Error(`profiles store at ${path} is ${result.status}, expected valid`);
	return result.file;
}

test("Enter switches the live orchestrator, binds the profile, and writes nothing", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { orchestrator: { model: "openai/beta", thinking: "high" }, worker: { model: "openai/alpha" } }, old: {} }, "old");
	const before = {
		store: readFileSync(storePath, "utf8"),
		settings: readFileSync(settingsPath, "utf8"),
	};
	resetSessionProfileBindingsForTesting();
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = {
		cwd: fixture.root,
		hasUI: true,
		ui: { notify(message: string, severity: string) { notifications.push({ message, severity }); } },
		sessionManager: { getSessionId: () => "session-panel" },
		modelRegistry: { find: () => ({ provider: "openai", id: "beta" }) },
	} as unknown as ExtensionContext;
	const models: unknown[] = [];
	const thinking: ThinkingLevel[] = [];
	const live = {
		setModel: async (model: unknown) => { models.push(model); return true; },
		setThinkingLevel(level: ThinkingLevel) { thinking.push(level); },
		getThinkingLevel(): ThinkingLevel { return "medium"; },
	};
	const file = readValidProfilesStore(storePath);
	await __testing.runProfilesPanelAction(ctx, live, storePath, file, { type: "use-session", name: "team" }, {});
	assert.deepEqual(models, [{ provider: "openai", id: "beta" }]);
	assert.deepEqual(thinking, ["high"]);
	const binding = readSessionProfileBinding("session-panel");
	assert.equal(binding?.name, "team");
	assert.equal(binding?.modelProfiles.worker?.model, "openai/alpha");
	assert.equal(readFileSync(storePath, "utf8"), before.store, "the profiles store is untouched");
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings, "Pi settings are untouched");
	assert.equal(existsSync(fixture.globalPath), false, "no global models.json is written");
	assert.equal(existsSync(join(fixture.root, ".pi", "subagents.json")), false, "no materialized store is written");
	const applied = notifications.at(-1)?.message ?? "";
	assert.match(applied, /bound profile "team" to this session/);
	assert.match(applied, /its tab shows ◉/);
	assert.match(applied, /This session now runs on openai\/beta · high/);
	assert.match(applied, /Subagents and reviewers use this session's routing snapshot/);
	assert.match(applied, /global routing, pins, and materialized stores are untouched/);
	assert.doesNotMatch(applied, /launch routing is unchanged/);
	resetSessionProfileBindingsForTesting();
});

test("Enter switches only the selecting session's orchestrator and leaves shared defaults untouched", async (t) => {
	const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { orchestrator: { model: "openai/alpha", thinking: "high" }, worker: { model: "openai/beta" } }, old: {} }, "old");
	const beforeStore = readFileSync(storePath, "utf8");
	const beforeSettings = readFileSync(settingsPath, "utf8");
	resetSessionProfileBindingsForTesting();
	t.after(() => resetSessionProfileBindingsForTesting());
	bindSessionProfile("other-session", "old", { worker: { model: "openai/old" } });
	const switches: string[] = [];
	const thinking: ThinkingLevel[] = [];
	const ctx = {
		cwd: fixture.root, hasUI: true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "selecting-session" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
	} as unknown as ExtensionContext;
	const live = {
		setModel: async (model: { provider: string; id: string }) => { switches.push(`${model.provider}/${model.id}`); return true; },
		setThinkingLevel: (level: ThinkingLevel) => { thinking.push(level); },
		getThinkingLevel: (): ThinkingLevel => "medium",
	} as unknown as LiveSession;
	await __testing.runProfilesPanelAction(ctx, live, storePath, readValidProfilesStore(storePath), { type: "use-session", name: "team" });
	assert.deepEqual(switches, ["openai/alpha"]);
	assert.deepEqual(thinking, ["high"]);
	assert.equal(readSessionProfileBinding("selecting-session")?.name, "team");
	assert.equal(readSessionProfileBinding("other-session")?.modelProfiles.worker?.model, "openai/old");
	assert.equal(readSessionProfileBinding("unbound-session"), undefined);
	assert.equal(readFileSync(storePath, "utf8"), beforeStore);
	assert.equal(readFileSync(settingsPath, "utf8"), beforeSettings);
	assert.equal(existsSync(fixture.globalPath), false);
	assert.equal(existsSync(join(fixture.root, ".pi", "subagents.json")), false);
});

test("reviewer routing uses the selecting session snapshot without leaking to other sessions", (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({ team: {} }, "team");
	mkdirSync(fixture.configHome, { recursive: true });
	writeFileSync(fixture.globalPath, JSON.stringify({ "review-risk": { model: "openai/global" }, "review-reliability": { model: "openai/global" } }));
	resetSessionProfileBindingsForTesting();
	t.after(() => resetSessionProfileBindingsForTesting());
	bindSessionProfile("selecting-session", "team", { "review-risk": { model: "openai/session", thinking: "high" } });
	const selected = __testing.readReviewerModelConfig(fixture.root, "selecting-session");
	assert.equal(selected["review-risk"]?.model, "openai/session");
	assert.equal(selected["review-reliability"], undefined, "a complete session snapshot never falls back per role");
	assert.equal(__testing.readReviewerModelConfig(fixture.root, "other-session")["review-risk"]?.model, "openai/global");
	assert.equal(__testing.readReviewerModelConfig(fixture.root, undefined)["review-risk"]?.model, "openai/global");
});

test("Enter preserves session-only routing when the orchestrator is absent or cannot switch", async (t) => {
	for (const rejected of [false, true]) {
		const { fixture, storePath, settingsPath, writeStore, writeSettings } = profilesStoreFixture(t);
		writeSettings();
		writeStore({ team: {
			worker: { model: "openai/alpha" },
			...(rejected ? { orchestrator: { model: "openai/beta", thinking: "high" as const } } : {}),
		} }, undefined);
		const storeBefore = readFileSync(storePath, "utf8");
		const settingsBefore = readFileSync(settingsPath, "utf8");
		resetSessionProfileBindingsForTesting();
		t.after(() => resetSessionProfileBindingsForTesting());
		const notifications: string[] = [];
		let modelCalls = 0;
		let thinkingCalls = 0;
		const ctx = {
			cwd: fixture.root,
			hasUI: true,
			ui: { notify(message: string) { notifications.push(message); } },
			sessionManager: { getSessionId: () => "session-panel" },
			modelRegistry: { find: () => ({ provider: "openai", id: "beta" }) },
		} as unknown as ExtensionContext;
		const live = {
			setModel: async () => { modelCalls++; return false; },
			setThinkingLevel() { thinkingCalls++; },
			getThinkingLevel(): ThinkingLevel { return "medium"; },
		};
		await __testing.runProfilesPanelAction(ctx, live, storePath, readValidProfilesStore(storePath), { type: "use-session", name: "team" }, {});
		assert.equal(modelCalls, rejected ? 1 : 0);
		assert.equal(thinkingCalls, 0);
		assert.equal(readSessionProfileBinding("session-panel")?.modelProfiles.worker?.model, "openai/alpha");
		assert.equal(readFileSync(storePath, "utf8"), storeBefore);
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore);
		assert.equal(existsSync(fixture.globalPath), false);
		assert.equal(existsSync(join(fixture.root, ".pi", "subagents.json")), false);
		if (rejected) assert.match(notifications.at(-1) ?? "", /no authentication is configured for openai; this session keeps its current model/);
		else assert.doesNotMatch(notifications.at(-1) ?? "", /This session now runs/);
	}
});

test("a keeps the legacy global apply semantics", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } }, old: {} }, "old");
	const ctx = {
		cwd: fixture.root,
		hasUI: true,
		ui: { notify() {}, confirm: async () => true },
		sessionManager: { getSessionId: () => "session-panel" },
	} as unknown as ExtensionContext;
	const live = { setModel: async () => true, setThinkingLevel() {}, getThinkingLevel(): ThinkingLevel { return "medium"; } };
	const file = readValidProfilesStore(storePath);
	await __testing.runProfilesPanelAction(ctx, live, storePath, file, { type: "apply-global", name: "team", config: file.profiles["team"] }, {});
	assert.equal(JSON.parse(readFileSync(storePath, "utf8")).active, "team", "the global store claims the profile");
	assert.ok(existsSync(fixture.globalPath), "the global routing is materialized");
	resetSessionProfileBindingsForTesting();
});

test("Enter with a winning pin binds the session and never touches the pin layers", async (t) => {
	const { fixture, storePath, writeStore, writePin, localPinPath } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } }, old: {} }, undefined);
	writePin(localPinPath, "old");
	const pinBefore = readFileSync(localPinPath, "utf8");
	const storeBefore = readFileSync(storePath, "utf8");
	resetSessionProfileBindingsForTesting();
	const ctx = {
		cwd: fixture.root,
		hasUI: true,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "session-panel" },
	} as unknown as ExtensionContext;
	const live = { setModel: async () => true, setThinkingLevel() {}, getThinkingLevel(): ThinkingLevel { return "medium"; } };
	const file = readValidProfilesStore(storePath);
	await __testing.runProfilesPanelAction(ctx, live, storePath, file, { type: "use-session", name: "team" }, {});
	assert.equal(readSessionProfileBinding("session-panel")?.name, "team");
	assert.equal(readFileSync(localPinPath, "utf8"), pinBefore, "the clone pin is untouched");
	assert.equal(readFileSync(storePath, "utf8"), storeBefore, "the store is untouched");
	assert.equal(existsSync(fixture.globalPath), false);
	resetSessionProfileBindingsForTesting();
});

test("a session-bound profile carries ◉ and says it is used in this session", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/beta" } }, other: {} }, "team");
	t.after(() => resetSessionProfileBindingsForTesting());
	bindSessionProfile("session-panel", "team", { worker: { model: "openai/gamma" } });
	let rendered = "";
	fixture.onInput((panel) => {
		rendered = stripAnsi(renderComponent(panel));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	const tabLine = rendered.split("\n")[1] ?? "";
	assert.match(tabLine, /team ◉★/);
	assert.doesNotMatch(tabLine, /other ◉/);
	assert.match(rendered, /Used in this session\. Default for new sessions\./);
	assert.doesNotMatch(rendered, /launch routing is unchanged/, "no stale slice-1 claim survives on the screen");
});

test("Enter without a parent session id fails loud and writes nothing", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, undefined);
	const before = readFileSync(storePath, "utf8");
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = {
		cwd: fixture.root,
		hasUI: true,
		ui: { notify(message: string, severity: string) { notifications.push({ message, severity }); } },
	} as unknown as ExtensionContext;
	const live = { setModel: async () => true, setThinkingLevel() {}, getThinkingLevel(): ThinkingLevel { return "medium"; } };
	const file = readValidProfilesStore(storePath);
	await __testing.runProfilesPanelAction(ctx, live, storePath, file, { type: "use-session", name: "team" }, {});
	assert.equal(readSessionProfileBinding(undefined), undefined);
	assert.equal(readFileSync(storePath, "utf8"), before);
	assert.equal(existsSync(fixture.globalPath), false);
	assert.equal(notifications.at(-1)?.severity, "warning");
	resetSessionProfileBindingsForTesting();
});

test("file operations are subcommands: profiles restore-routing, export and import, and usage for anything else", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha", thinking: "high" } } }, "team");

	// /gentle:profiles restore-routing: confirm, then write models.json and materialize it.
	writeMarkdown(fixture.exportPath, `${JSON.stringify({ kind: "gentle-pi.agent_model_routing", version: 1, agents: { worker: { model: "openai/beta", thinking: "low" } } }, null, 2)}\n`);
	fixture.onConfirm(async () => false);
	await fixture.run("gentle:profiles", "restore-routing");
	assert.equal(existsSync(fixture.globalPath), false, "a declined restore writes nothing");
	fixture.onConfirm(async () => true);
	await fixture.run("gentle:profiles", "restore-routing");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")).worker, { model: "openai/beta", thinking: "low" });
	assert.match(fixture.notifications.at(-1)?.message ?? "", /restored global model config/);
	assert.match(readFileSync(join(fixture.root, ".pi", "agents", "worker.md"), "utf8"), /model: openai\/beta/);

	// /gentle:profiles export-routing writes the saved routing, not a profile.
	await fixture.run("gentle:profiles", "export-routing");
	assert.deepEqual(JSON.parse(readFileSync(fixture.exportPath, "utf8")).agents, { worker: { model: "openai/beta", thinking: "low" } });
	assert.match(fixture.notifications.at(-1)?.message ?? "", /exported 1 saved model routing entry/);

	// /gentle:profiles export <name> then import it back over a changed store.
	await fixture.run("gentle:profiles", "export team");
	const exportFile = join(fixture.configHome, "profiles.export.json");
	assert.ok(existsSync(exportFile));
	assert.match(fixture.notifications.at(-1)?.message ?? "", /exported profile "team"/);
	writeStore({ team: { worker: { model: "openai/gamma" } } }, "team");
	await fixture.run("gentle:profiles", "import");
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.team, { worker: { model: "openai/alpha", thinking: "high" } }, "import replaces after confirmation");

	for (const args of ["export", "export ghost", "publish", "frobnicate", "restore", "export-routing extra"]) {
		await fixture.run("gentle:profiles", args);
		assert.match(fixture.notifications.at(-1)?.message ?? "", /Usage: \/gentle:profiles \[export <name> \| import \| publish <name> \| export-routing \| restore-routing\]/, args);
	}
	assert.equal(fixture.panelVisits(), 0, "no subcommand opens the screen");
});

test("gentle:models is gone: gentle:profiles is the only models and profiles command", () => {
	const commands = new Map<string, { description?: string }>();
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool() {},
		registerCommand(name: string, command: { description?: string }) { commands.set(name, command); },
	} as unknown as ExtensionAPI);
	assert.equal(commands.has("gentle:models"), false);
	assert.match(commands.get("gentle:profiles")?.description ?? "", /export-routing, restore-routing/);
	for (const [name, command] of commands) {
		assert.doesNotMatch(command.description ?? "", /gentle:models/, name);
	}
});

test("gentle:profiles still opens the screen and keeps export <name>, import, and publish <name>", async (t) => {
	const { fixture, storePath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	fixture.onInput((panel) => {
		assert.equal(shownProfile(panel), "team");
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(fixture.panelVisits(), 1);
	await fixture.run("gentle:profiles", "export team");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /exported profile "team"/);
	writeStore({ team: { worker: { model: "openai/gamma" } } }, "team");
	await fixture.run("gentle:profiles", "import");
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.team, { worker: { model: "openai/alpha" } });
	await fixture.run("gentle:profiles", "publish team");
	assert.equal(JSON.parse(readFileSync(repoPinPath, "utf8")).profile, "team");
	assert.equal(fixture.panelVisits(), 1, "subcommands open no screen");
});

test("switching profile tabs redraws in place: the overlay never closes and reopens", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	writeStore({
		team: { worker: { model: "openai/alpha" } },
		other: { worker: { model: "openai/beta", thinking: "high" } },
	}, "team");
	const frames: string[] = [];
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		if (visits > 1) {
			panel.handleInput("\x1b");
			return;
		}
		frames.push(stripAnsi(renderComponent(panel)));
		panel.handleInput(RIGHT_KEY); // clean switch to "other"
		frames.push(stripAnsi(renderComponent(panel)));
		chooseAgent(panel, "worker");
		chooseModel(panel, "alpha");
		panel.handleInput("\x1b[D"); // back to "team" with an unsaved edit: asks first
		frames.push(stripAnsi(renderComponent(panel)));
		panel.handleInput("s"); // Save and switch
		frames.push(stripAnsi(renderComponent(panel)));
		panel.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(fixture.panelVisits(), 1, "a tab switch keeps the one overlay on screen");
	const [first, switched, asking, saved] = frames;
	assert.match(first ?? "", /worker\s+openai\/alpha/);
	assert.match(switched ?? "", /worker\s+openai\/beta\s+high/, "the switched frame is already the new profile");
	assert.match(profilesPanelFooter(switched ?? ""), /Showing "other"\./);
	assert.match(asking ?? "", /other has 1 unsaved change\./);
	assert.match(saved ?? "", /worker\s+openai\/alpha/);
	assert.match(profilesPanelFooter(saved ?? ""), /Saved "other"\. Showing "team"\./);
	assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).profiles.other, { worker: { model: "openai/alpha", thinking: "high" } });
});
