import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { __testing, applyModelConfig, applyModelConfigAsync, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { PROFILES_KIND, PROFILES_VERSION } from "../lib/agent-profiles.ts";
import type { AgentRoutingEntry } from "../lib/model-routing-authority.ts";
type LiveSession = Pick<ExtensionAPI, "setModel" | "setThinkingLevel">;
import { PROFILE_PIN_KIND, PROFILE_PIN_VERSION, setProfilePinWorktreeResolverForTesting, writeProfilePinSync } from "../lib/agent-profile-pin.ts";
import { NATIVE_REVIEW_ERROR_CODE, NativeReviewCliError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewError, type CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { installPackageAssets } from "../lib/agent-assets.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { cardBody, cardTitle, cardTone } from "./gentle-card-text.ts";

initTheme("dark");

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
		["gentle_review", { operation: "status" }, "review status"],
		["gentle_review", { operation: "future-operation", secret: "/private" }, "review"],
		["gentle_review_scope", {}, "review scope"],
		["gentle_review_capture_group", {}, "review capture group"],
		[
			"gentle_review_capture",
			{
				lineageId: "lineage-id",
				collectBinding: "binding-id",
				sha256: "sha256:hash-value",
				secret: "secret-value",
				arbitrary: "arbitrary-value",
			},
			"review capture",
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

	for (const [name, args, operationPath] of cases) {
		const tool = tools.get(name);
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
		assert.equal(cardTitle(initialText), `🌹︎ Gentle AI · running · ${operationPath}`); assert.equal(cardTone(initialText), "warning");
		assert.equal(cardTitle(runningText), `🌹︎ Gentle AI · running · ${operationPath}`); assert.equal(cardTone(runningText), "warning");
		assert.equal(cardTitle(completedText), `🌹︎ Gentle AI · completed · ${operationPath}`); assert.equal(cardTone(completedText), "success");
		assert.equal(cardTitle(failedText), `🌹︎ Gentle AI · failed · ${operationPath}`); assert.equal(cardTone(failedText), "error");
		assert.doesNotMatch(renderComponent(failed), /future-operation|secret|private/);
		for (const forbiddenValue of ["lineage-id", "binding-id", "sha256:hash-value", "secret-value", "arbitrary-value"]) {
			assert.doesNotMatch(failedText, new RegExp(forbiddenValue));
		}
	}
});

test("registered Gentle Review tools preserve result envelopes and redact collapsed result rendering", async () => {
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
		{ cwd: process.cwd() } as ExtensionContext,
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

	const resultText = "safe result\x1b[31m\nlineage=secret body=private";
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
			assert.equal((collapsedBody.match(/\d+ lines?\b/g) ?? []).length, 1, `${name} collapsed output must contain one expand hint`);
			assert.match(collapsedBody, /^<dim>\d+ lines?\b<\/dim>/, `${name} collapsed output must start with the hint`);
			assert.doesNotMatch(collapsed, /safe result|lineage=secret|private/);
		}
		const expanded = renderComponent(tool.renderResult({ content: [{ type: "text", text: resultText }] }, { expanded: true, isPartial: false, isError: true }, lifecycleTheme, {}));
		assert.equal(cardBody(expanded).split("\n")[0], "safe result");
		assert.match(expanded, /safe result/);
		assert.match(expanded, /lineage=secret body=private/);
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
	createGentleAiExtension({ nativeReviewCli: null })({
		on() {},
		registerTool() {},
		registerCommand(name, command) { commands.set(name, command); },
		setModel: async (model: { provider: string; id: string }) => { liveSwitches.push({ kind: "model", provider: model.provider, id: model.id }); return setModelResult; },
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
	// The orchestrator model is looked up in the registry before switching.
	const registryModels = [
		{ provider: "openai", id: "alpha" },
		{ provider: "openai", id: "beta" },
		{ provider: "nan", id: "glm5.3" },
	];
	const ctx = {
		cwd: root,
		hasUI: true,
		modelRegistry: {
			getAvailable: async () => registryModels.filter((model) => model.provider === "openai"),
			find: (provider: string, id: string) => registryModels.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			notify(message: string, severity: string) { notifications.push({ message, severity }); },
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
		refuseSetModel() { setModelResult = false; },
		rejectThinkingLevel() { thinkingRejects = true; },
		onPanel(action: typeof onPanel) { onPanel = action; },
		onInput(action: (panel: RoutingConsumerPanel) => void) { onInput = action; },
		run: (name: string) => commands.get(name)!.handler("", ctx),
	};
}

test("models saves and clears independent provider review roles without local artifacts", async (t) => {
	const fixture = routingConsumerFixture(t, []);
	const roles = ["review-refuter", "review-validator"];
	assert.deepEqual(
		__testing.listDiscoverableAgents(fixture.root).map((agent) => agent.name),
		[],
		"requires zero discovered agents; check package-sibling legacy agent directories",
	);

	const assertNoLocalArtifacts = () => {
		for (const base of [join(fixture.root, ".pi"), fixture.agentHome]) {
			assert.equal(existsSync(join(base, "subagents.json")), false);
			for (const dir of ["agents", "subagents"]) {
				for (const role of roles) {
					assert.equal(existsSync(join(base, dir, `${role}.md`)), false);
				}
			}
		}
	};
	fixture.onInput((panel) => {
		const initial = renderComponent(panel);
		for (const role of roles) {
			assert.equal(initial.split(role).length - 1, 1);
		}
		assert.match(initial, /Pi persisted default model/);
		assert.match(initial, /Pi persisted default effort/);
		for (const [index, model] of ["alpha", "beta"].entries()) {
			panel.handleInput("j");
			panel.handleInput("\r");
			assert.match(renderComponent(panel), /Pi persisted default model/);
			assert.doesNotMatch(renderComponent(panel), /Inherit active\/default model/);
			for (const character of model) panel.handleInput(character);
			panel.handleInput("\r");
			panel.handleInput("e");
			assert.match(renderComponent(panel), /Pi persisted default effort/);
			assert.doesNotMatch(renderComponent(panel), /Inherit effort/);
			for (let step = 0; step <= index; step++) panel.handleInput("j");
			panel.handleInput("\r");
		}
		panel.handleInput("\x13");
	});
	await fixture.run("gentle:models");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), {
		"review-refuter": { model: "openai/alpha", thinking: "off" },
		"review-validator": { model: "openai/beta", thinking: "minimal" },
	});
	assertNoLocalArtifacts();

	fixture.onInput((panel) => {
		panel.handleInput("j");
		panel.handleInput("i");
		panel.handleInput("\x13");
	});
	await fixture.run("gentle:models");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), {
		"review-refuter": {},
		"review-validator": { model: "openai/beta", thinking: "minimal" },
	});
	assertNoLocalArtifacts();

	fixture.onInput((panel) => {
		panel.handleInput("j");
		panel.handleInput("j");
		panel.handleInput("i");
		panel.handleInput("\x13");
	});
	await fixture.run("gentle:models");
	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), {
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
	await fixture.run("gentle:models");
	assertReservedUnchanged();
	for (const role of roles) assert.equal(fixture.panels[0].split(role).length - 1, 1);
	assert.match(fixture.panels[0], /worker\s+model=inherit, effort=inherit/);
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

test("models rejects invalid project routing with its selected source path", async (t) => {
	const fixture = routingConsumerFixture(t);
	writeFileSync(fixture.projectPath, "[]");
	await fixture.run("gentle:models");
	assert.equal(fixture.notifications[0]?.severity, "warning");
	assert.ok(fixture.notifications[0]?.message.includes(fixture.projectPath));
	assert.equal(fixture.panelVisits(), 0);
});

test("export re-reads saved routing and rejects invalid project before creating its destination parent", async (t) => {
	const fixture = routingConsumerFixture(t);
	writeFileSync(fixture.projectPath, '{"worker":"openai/gpt-5"}');
	fixture.onPanel(() => {
		if (fixture.panelVisits() > 1) return { type: "cancel", config: {} };
		writeFileSync(fixture.projectPath, "[]");
		return { type: "export", config: {} };
	});
	await fixture.run("gentle:models");
	assert.equal(fixture.notifications[0]?.severity, "warning");
	assert.ok(fixture.notifications[0]?.message.includes(`Invalid model config: ${fixture.projectPath}`));
	assert.equal(existsSync(fixture.exportPath), false);
	assert.equal(existsSync(fixture.configHome), false);
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
			fixture.onPanel(() => ({ type: fixture.panelVisits() === 1 ? "export" : "cancel", config: {} }));
			await fixture.run("gentle:models");
			const agents = source === "missing" ? {} : source === "project"
				? { worker: { model: "openai/gpt-5" } }
				: { worker: { model: "anthropic/opus", thinking: "high" } };
			assert.deepEqual(JSON.parse(readFileSync(fixture.exportPath, "utf8")).agents, agents);
			assert.equal(fixture.notifications[0]?.severity, "info");
			assert.match(fixture.notifications[0]!.message, /exported/);
			assert.equal(fixture.panelVisits(), 2);
			await fixture.run("gentle:status");
			const report = fixture.notifications.at(-1)!.message;
			assert.ok(report.includes(`Saved model routing: ${source === "missing" ? "missing" : "valid"}`));
			assert.ok(report.includes(`Global model config: ${source === "global" ? "present" : "missing"}`));
			const expectedRouting = source === "missing" ? "inherit, effort=inherit"
				: source === "project" ? "openai/gpt-5, effort=inherit" : "anthropic/opus, effort=high";
			assert.ok(report.includes(`worker: model=${expectedRouting}`), report);
			assert.ok(fixture.panels[0].includes(`model=${expectedRouting}`), fixture.panels[0]);
		});
	}
});

test("invalid global routing overrides valid project in models, status, and export re-read", async (t) => {
	for (const atExport of [false, true]) {
		await t.test(atExport ? "invalidated during panel" : "invalid before panel", async (t) => {
			const fixture = routingConsumerFixture(t);
			writeFileSync(fixture.projectPath, '{"worker":"openai/gpt-5"}');
			if (!atExport) writeMarkdown(fixture.globalPath, "[]");
			fixture.onPanel(() => {
				if (fixture.panelVisits() > 1) return { type: "cancel", config: {} };
				writeMarkdown(fixture.globalPath, "[]");
				return { type: "export", config: {} };
			});
			await fixture.run("gentle:models");
			assert.equal(fixture.notifications[0]?.severity, "warning");
			assert.ok(fixture.notifications[0]?.message.includes(fixture.globalPath));
			assert.match(fixture.notifications[0]!.message, atExport ? /export failed/ : /cannot open model config/);
			assert.equal(fixture.panelVisits(), atExport ? 2 : 0);
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
	createGentleAiExtension({ nativeReviewCli: null })(pi);
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
		+ readFileSync("assets/orchestrator-delegation.md", "utf8");
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
	const result = await __testing.executeReviewControllerOperation({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, cwd, native);
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

test("model panel render does not auto-apply the Gentle theme and sanitizes agent labels", () => {
	const lines = __testing.renderSddModelPanel(
		{},
		["openai/gpt-5.5"],
		["safe-agent\x1b[31m"],
		72,
	);
	const rendered = lines.join("\n");
	const plain = stripAnsi(rendered);

	assert.doesNotMatch(cardBody(rendered), /\x1b\[38;2;71;85;105m/);
	assert.doesNotMatch(cardBody(rendered), /\x1b\[38;2;125;211;252m/);
	assert.match(plain, /Assign Models and Effort to Agents/);
	assert.match(plain, /safe-agent\s+model=inherit, effort=inherit/);
	assert.doesNotMatch(plain, /\[31m/);
});

test("model panel fills the terminal height like the profiles panel", () => {
	const lines = __testing.renderSddModelPanel({}, ["openai/gpt-5.5"], ["safe-agent"], 72, undefined, 40);
	assert.equal(lines.length, 40);
	const plain = lines.map(stripAnsi);
	assert.match(plain[0] ?? "", /^╭─+╮$/);
	assert.match(plain[39] ?? "", /^╰─+╯$/);
	for (const line of plain) assert.equal(line.length, 72);
});

test("model panel lists grow with the terminal height instead of a fixed window", () => {
	const agents = Array.from({ length: 40 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
	const models = Array.from({ length: 60 }, (_, i) => `provider/model-${String(i).padStart(2, "0")}`);
	const agentLines = __testing
		.renderSddModelPanel({}, models, agents, 100, undefined, 40)
		.map(stripAnsi);
	assert.equal(agentLines.length, 40);
	// 40 rows minus 15 rows of chrome: every remaining row lists an agent or "Set all".
	assert.equal(agentLines.filter((line) => /(agent-\d\d|Set all agents)\s+model=/.test(line)).length, 25);
	assert.ok(agentLines.some((line) => /x export/.test(line)));

	const pickerLines = __testing
		.renderSddModelPanel({}, models, agents, 100, undefined, 40, ["\r"])
		.map(stripAnsi);
	assert.equal(pickerLines.length, 40);
	// 40 rows minus 8 rows of chrome.
	assert.equal(pickerLines.filter((line) => /provider\/model-\d\d/.test(line)).length, 32);
});

test("model panel render uses the Pi-provided current theme when supplied", () => {
	const currentTheme = {
		fg(_color: string, text: string): string {
			return `\x1b[35m${text}\x1b[39m`;
		},
	} as unknown as Theme;

	const rendered = __testing
		.renderSddModelPanel({}, ["openai/gpt-5.5"], ["safe-agent"], 72, currentTheme)
		.join("\n");

	assert.match(rendered, /\x1b\[35m/);
	assert.match(stripAnsi(rendered), /Assign Models and Effort to Agents/);
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
		} as ExtensionContext;

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
						: `event:${data.state}`,
				);
				emitted.push({ channel, data } as EmittedEvent);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
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
					return confirm();
				},
			},
		} as ExtensionContext;
		let resolveConfirmation!: (approved: boolean) => void;
		confirm = () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
		const denied = toolCall!({
			toolName: "bash",
			input: { command: "git rebase main --secret-command-content" },
		}, ctx);

		await Promise.resolve();
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
		const confirmations: Array<(approved: boolean) => void> = [];
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: { emit(channel: string, data: EmittedEvent["data"]) { emitted.push({ channel, data }); } },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		return { handlers, emitted, confirmations };
	};
	const first = createHarness();
	const second = createHarness();
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-concurrent-"));
	try {
		const context = (confirmations: Array<(approved: boolean) => void>) => ({
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
			},
		} as ExtensionContext);
		const firstRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main" } }, context(first.confirmations));
		const secondRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main --another-command" } }, context(first.confirmations));
		await Promise.resolve();
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
		await Promise.resolve();
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


test("RPIV questionnaire blockers emit only a private, balanced Herdr projection", () => {
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
	assert.equal(eventHandlers.size, 2);
	assert.equal(eventHandlers.has("gentle-pi:ask-user-choice:blocked"), true);
	assert.equal(eventHandlers.has("rpiv:ask-user:blocked"), true);

	const source = {
		active: true,
		question: "private questionnaire text",
		answer: "private questionnaire answer",
		path: "/private/questionnaire-path",
		command: "private questionnaire command",
		arbitrary: { nested: "private questionnaire field" },
	};
	pi.events.emit("rpiv:ask-user:blocked", source);
	assert.strictEqual(published[0]?.data, source, "the RPIV event remains the source event");
	assert.deepEqual(herdrEvents, [{ active: true, label: "Questionnaire awaiting input" }]);
	assert.doesNotMatch(JSON.stringify(herdrEvents), /private questionnaire|questionnaire-path/i);

	pi.events.emit("rpiv:ask-user:blocked", { active: true, duplicate: true });
	pi.events.emit("rpiv:ask-user:blocked", { active: "true" });
	pi.events.emit("rpiv:ask-user:blocked", { active: null });
	pi.events.emit("rpiv:ask-user:blocked", []);
	pi.events.emit("rpiv:ask-user:blocked", null);
	pi.events.emit("rpiv:ask-user:other", { active: false });
	assert.deepEqual(herdrEvents, [{ active: true, label: "Questionnaire awaiting input" }]);

	pi.events.emit("rpiv:ask-user:blocked", { active: false });
	pi.events.emit("rpiv:ask-user:blocked", { active: false, duplicate: true });
	pi.events.emit("rpiv:ask-user:blocked", { active: true });
	pi.events.emit("rpiv:ask-user:blocked", { active: false });
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
	]);
});

test("Herdr coordinates guarded confirmations and RPIV labels without inactive relabel pulses", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type HerdrBlockedEvent = { active: boolean; label?: string };
	const createHarness = () => {
		const handlers = new Map<string, ToolCallHandler>();
		const eventHandlers = new Map<string, (data: unknown) => void>();
		const herdrEvents: HerdrBlockedEvent[] = [];
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
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const context = {
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
			},
		} as ExtensionContext;
		return { confirmations, context, herdrEvents, pi, toolCall: handlers.get("tool_call")! };
	};

	const guardedFirst = createHarness();
	const guardedRequest = guardedFirst.toolCall(
		{ toolName: "bash", input: { command: "git rebase main" } },
		guardedFirst.context,
	);
	await Promise.resolve();
	guardedFirst.pi.events.emit("rpiv:ask-user:blocked", { active: true });
	guardedFirst.confirmations[0]!(true);
	assert.equal(await guardedRequest, undefined);
	assert.deepEqual(guardedFirst.herdrEvents, [
		{ active: true, label: "Guarded command confirmation" },
		{ active: true, label: "Questionnaire awaiting input" },
	]);
	guardedFirst.pi.events.emit("rpiv:ask-user:blocked", { active: false });
	assert.deepEqual(guardedFirst.herdrEvents, [
		{ active: true, label: "Guarded command confirmation" },
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: false },
	]);

	const questionnaireFirst = createHarness();
	questionnaireFirst.pi.events.emit("rpiv:ask-user:blocked", { active: true });
	const questionnaireRequest = questionnaireFirst.toolCall(
		{ toolName: "bash", input: { command: "git rebase main" } },
		questionnaireFirst.context,
	);
	await Promise.resolve();
	questionnaireFirst.pi.events.emit("rpiv:ask-user:blocked", { active: false });
	questionnaireFirst.confirmations[0]!(false);
	await questionnaireRequest;
	assert.deepEqual(questionnaireFirst.herdrEvents, [
		{ active: true, label: "Questionnaire awaiting input" },
		{ active: true, label: "Guarded command confirmation" },
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
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	assert.equal(eventHandlers.has("gentle-pi:ask-user-choice:blocked"), true);

	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: true });
	assert.deepEqual(choiceEvents, [{ active: true }]);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	const guardedRequest = handlers.get("tool_call")!(
		{ toolName: "bash", input: { command: "git rebase main" } },
		{
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
			},
		} as ExtensionContext,
	);
	await Promise.resolve();
	assert.equal(confirmations.length, 1);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: false });
	assert.deepEqual(choiceEvents, [{ active: true }, { active: false }]);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
		{ active: true, label: "Guarded command confirmation" },
	]);
	assert.equal(herdrEvents.some((event) => event.active === false), false);

	confirmations[0]!(true);
	assert.equal(await guardedRequest, undefined);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
		{ active: true, label: "Guarded command confirmation" },
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
	createGentleAiExtension({ nativeReviewCli: null })(pi);
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
		} as ExtensionContext), undefined);
		assert.deepEqual(await toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, {
			cwd,
			hasUI: false,
			ui: { confirm },
		} as ExtensionContext), {
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
	assert.equal(cardTitle(renderComponent(single)), "🌹︎ Gentle AI · running · review capture · risk");
	const bare = tools.get("gentle_review_capture")!.renderCall({ lineageId: "l", collectBinding: "{not json" }, lifecycleTheme, lifecycleContext({ executionStarted: true }));
	assert.equal(cardTitle(renderComponent(bare)), "🌹︎ Gentle AI · running · review capture");
	const group = tools.get("gentle_review_capture_group")!.renderCall(
		{ lineageId: "l", collectBindings: [binding("review-risk"), binding("review-resilience"), binding("review-readability"), binding("review-reliability")] },
		lifecycleTheme,
		lifecycleContext({ executionStarted: true }),
	);
	assert.equal(cardTitle(renderComponent(group)), "🌹︎ Gentle AI · running · review capture group · risk · resilience · readability · reliability");
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
	} as ExtensionContext;

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
		} as ExtensionContext);
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
function applyOnce(
	fixture: { onInput(action: (panel: { handleInput(data: string): void }) => void): void },
): void {
	let visits = 0;
	fixture.onInput((panel) => {
		visits += 1;
		panel.handleInput(visits === 1 ? "\r" : "\x1b");
	});
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

test("applying a profile replaces materialized routing for agents the profile omits", async (t) => {
	const { fixture, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	// Routing materialized earlier (a previous profile, /gentle:models, or a
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

test("s snapshots current routing in place without applying or reopening the profiles panel", async (t) => {
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
	writeStore({
		"a-target": {},
		"z-active": { worker: { model: "openai/beta" } },
	}, "z-active");

	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("s");
			panel.handleInput("\x1b");
		} else {
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");

	const store = JSON.parse(readFileSync(join(fixture.configHome, "profiles.json"), "utf8"));
	assert.deepEqual(store.profiles["a-target"], {
		worker: { model: "openai/alpha", thinking: "minimal" },
		orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
	});
	assert.deepEqual(store.profiles["z-active"], { worker: { model: "openai/beta" } });
	assert.equal(store.active, "z-active");
	assert.match(fixture.panels[0] ?? "", /enter apply · c create · s snapshot/);
	assert.equal(readFileSync(fixture.globalPath, "utf8"), before.models);
	assert.equal(readFileSync(subagentsPath, "utf8"), before.subagents);
	assert.equal(readFileSync(workerPath, "utf8"), before.worker);
	assert.equal(readFileSync(settingsPath, "utf8"), before.settings);
	assert.equal(fixture.panelVisits(), 1, "snapshot keeps the same panel open");
	assert.ok(firstPanel);
	const targetRow = renderComponent(firstPanel!).split("\n");
	const targetIndex = targetRow.findIndex((line) => line.includes("a-target"));
	assert.ok(targetIndex >= 0, "selected profile remains in the list");
	assert.match(targetRow[targetIndex + 1] ?? "", /1 role/);
	assert.match(renderComponent(firstPanel!), /Snapshot saved; live routing unchanged\. Profile "a-target" saved from current routing\./);
});

// /gentle:models can finish with `u`: the global save `ctrl+s` performs, followed
// by the snapshot `/gentle:profiles` performs with `s` on the current profile.
function pickWorkerModelThenUpdateProfile(panel: RoutingConsumerPanel): void {
	// Rows: "Set all agents", the two provider review roles, then "worker".
	for (let step = 0; step < 3; step += 1) panel.handleInput("j");
	assert.match(renderComponent(panel), /▸ worker/);
	panel.handleInput("\r");
	for (const character of "alpha") panel.handleInput(character);
	panel.handleInput("\r");
	panel.handleInput("u");
}

test("u saves global routing from /gentle:models and updates the active profile", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({
		team: { worker: { model: "openai/beta" } },
		other: { worker: { model: "openai/beta", thinking: "high" } },
	}, "team");
	fixture.onInput((panel) => {
		assert.match(renderComponent(panel), /Current profile: team/);
		assert.match(renderComponent(panel), /u update profile/);
		pickWorkerModelThenUpdateProfile(panel);
	});
	await fixture.run("gentle:models");

	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } });
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(store.profiles.team, {
		worker: { model: "openai/alpha" },
		orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
	});
	assert.deepEqual(store.profiles.other, { worker: { model: "openai/beta", thinking: "high" } });
	assert.equal(store.active, "team");
	assert.equal(fixture.panelVisits(), 1, "u finishes the interaction");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /global model config saved/.test(entry.message)),
		"the global save is still reported",
	);
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /Profile "team" updated from the routing just saved/.test(entry.message)),
		`profile update is reported: ${JSON.stringify(fixture.notifications)}`,
	);
});

test("u updates the pinned profile instead of the active one inside a pinned repository", async (t) => {
	const { fixture, storePath, writeStore, writeSettings, writePin, localPinPath } = profilesStoreFixture(t);
	writeSettings();
	writeStore({
		team: { worker: { model: "openai/beta" } },
		other: { worker: { model: "openai/beta", thinking: "high" } },
	}, "team");
	writePin(localPinPath, "other");
	fixture.onInput((panel) => {
		assert.match(renderComponent(panel), /Current profile: other \(pinned\)/);
		pickWorkerModelThenUpdateProfile(panel);
	});
	await fixture.run("gentle:models");

	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } });
	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.deepEqual(store.profiles.other, {
		worker: { model: "openai/alpha" },
		orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
	});
	assert.deepEqual(store.profiles.team, { worker: { model: "openai/beta" } });
	assert.equal(store.active, "team");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /Profile "other" updated from the routing just saved/.test(entry.message)),
		`pinned profile update is reported: ${JSON.stringify(fixture.notifications)}`,
	);
});

test("u keeps the global save and reports when no profile is current", async (t) => {
	const { fixture, storePath, writeStore, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	writeStore({ team: { worker: { model: "openai/beta" } } });
	const before = readFileSync(storePath, "utf8");
	fixture.onInput((panel) => {
		assert.match(renderComponent(panel), /Current profile: none/);
		pickWorkerModelThenUpdateProfile(panel);
	});
	await fixture.run("gentle:models");

	assert.deepEqual(JSON.parse(readFileSync(fixture.globalPath, "utf8")), { worker: { model: "openai/alpha" } });
	assert.equal(readFileSync(storePath, "utf8"), before, "the store is untouched");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "warning" && /no profile is current/.test(entry.message) && /\/gentle:profiles/.test(entry.message)),
		`missing current profile is reported: ${JSON.stringify(fixture.notifications)}`,
	);
});

test("u seeds the profiles store the way /gentle:profiles does when it is missing", async (t) => {
	const { fixture, storePath, writeSettings } = profilesStoreFixture(t);
	writeSettings();
	assert.equal(existsSync(storePath), false);
	fixture.onInput((panel) => {
		assert.match(renderComponent(panel), /Current profile: none/);
		pickWorkerModelThenUpdateProfile(panel);
	});
	await fixture.run("gentle:models");

	const store = JSON.parse(readFileSync(storePath, "utf8"));
	assert.equal(store.kind, PROFILES_KIND);
	assert.deepEqual(store.profiles.current, {
		worker: { model: "openai/alpha" },
		orchestrator: { model: "nan/deepseek-v4-flash", thinking: "high" },
	});
	assert.equal(store.active, "current");
	assert.ok(
		fixture.notifications.some((entry) => entry.severity === "info" && /seeded the "current" profile/.test(entry.message)),
		`seeding is reported: ${JSON.stringify(fixture.notifications)}`,
	);
});

test("snapshot feedback keeps both outcomes visible for long profile names at narrow widths", async (t) => {
	const { fixture, storePath, writeStore } = profilesStoreFixture(t);
	const longName = `a${"x".repeat(63)}`;
	writeStore({ [longName]: {} });
	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("s");
			const success = stripAnsi(panel.render(60).join("\n"));
			assert.match(success, /Snapshot saved; live routing unchanged\./);
			rmSync(storePath);
			mkdirSync(storePath);
			panel.handleInput("s");
			panel.handleInput("\x1b");
		} else {
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");
	assert.ok(firstPanel);
	const constrained = stripAnsi(firstPanel!.render(60).join("\n"));
	assert.match(constrained, /Snapshot failed; live routing unchanged\./);
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
	assert.match(rendered, /Current routing \(effective\)/);
	assert.match(rendered, /worker\s+openai\/alpha\s+high/);
	assert.match(rendered, /helper\s+openai\/beta/);
	assert.doesNotMatch(rendered, /No routing entries/);
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

test("the profiles panel fills the terminal, lists routing per agent, and scrolls", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	writeStore({
		team: {
			orchestrator: { model: "nan/glm5.3", thinking: "high" },
			worker: { model: "openai/alpha", thinking: "high" },
			"sdd-design": { model: "nan/glm5.3", thinking: "high" },
		},
	}, "team");
	let rendered: string | undefined;
	let panel: { render(width: number): string[] } | undefined;
	fixture.onInput((visited) => {
		panel = visited;
		rendered = renderComponent(visited);
		visited.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");

	assert.ok(rendered);
	const lines = rendered.split("\n");
	// The frame spans the terminal height the fake TUI reports.
	assert.equal(lines.length, 24, `expected 24 rows, got ${lines.length}`);
	assert.match(lines[0], /^╭/);
	assert.match(lines.at(-1)!, /^╰/);
	const text = rendered;
	// Routing is listed one agent per line, aligned in columns, never collapsed
	// into "N agents → model: a, b, …" summaries.
	assert.match(text, /Profile routing/);
	assert.match(text, /Current routing \(effective\)/);
	assert.match(text, /orchestrator\s+nan\/glm5\.3 · high/);
	assert.match(text, /worker\s+openai\/alpha\s+high/);
	assert.match(text, /sdd-design\s+nan\/glm5\.3\s+high/);
	assert.doesNotMatch(text, /agents? → /);

	// A taller terminal renders a taller frame with the same content.
	fixture.tui.terminal.rows = 40;
	const taller = renderComponent(panel);
	assert.equal(taller.split("\n").length, 40);

	// A short terminal clamps instead of crashing, and keeps both borders.
	fixture.tui.terminal.rows = 9;
	const short = stripAnsi(panel.render(120).map((line) => line.replace(/[ \t]+$/g, "")).join("\n"));
	const shortLines = short.split("\n");
	assert.equal(shortLines.length, 9);
	assert.match(shortLines[0], /^╭/);
	assert.match(shortLines.at(-1)!, /^╰/);
});

test("j and k scroll the detail pane one line at a time, like the agents view", async (t) => {
	const { fixture, writeStore } = profilesStoreFixture(t);
	const routing: Record<string, { model: string; thinking: string }> = {};
	for (let index = 1; index <= 25; index += 1) {
		routing[`agent-${String(index).padStart(2, "0")}`] = { model: "openai/alpha", thinking: "high" };
	}
	writeStore({ team: routing }, "team");
	let panel: { handleInput(data: string): void; render(width: number): string[] } | undefined;
	fixture.onInput((visited) => {
		panel = visited;
		visited.handleInput("\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.ok(panel, "the panel must open");
	const body = () => panel!.render(120).slice(1, -2).map((line) => line.replace(/[ \t]+$/, "")).join("\n");
	const firstAgentRow = (text: string) => text.split("\n").findIndex((line) => line.includes("agent-01"));
	const before = body();
	assert.ok(firstAgentRow(before) >= 0, "the first routing row must be visible before scrolling");
	panel!.handleInput("j");
	const afterJ = body();
	assert.notEqual(firstAgentRow(afterJ), firstAgentRow(before), "j must scroll the detail down by one line");
	panel!.handleInput("k");
	assert.equal(firstAgentRow(body()), firstAgentRow(before), "k must scroll the detail back up");
});

// The pin is the per-repository layer of the profiles command: `p` writes the
// clone-scoped pin inside the Git common directory, `P` writes the committable
// per-worktree declaration. Neither writes routing.
test("p pins the selected profile for the clone without touching the global routing", async (t) => {
	const { fixture, storePath, localPinPath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	const storeBefore = readFileSync(storePath, "utf8");
	let firstPanel: RoutingConsumerPanel | undefined;
	let reopenedPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("p");
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
	assert.equal(existsSync(repoPinPath), false, "p writes the clone-scoped layer only");
	assert.equal(readFileSync(storePath, "utf8"), storeBefore, "a pin stores a name, never routing");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /pinned profile "team" for this clone in /);
	assert.ok(firstPanel);
	// The panel reports the layer that would win, next to the orchestrator lines it
	// deliberately does not move.
	assert.ok(reopenedPanel);
	assert.match(stripAnsi(renderComponent(reopenedPanel)), /pin\s+local: team/);
	// Rendering an existing panel must not resolve Git or read the pin again.
	setProfilePinWorktreeResolverForTesting(() => { throw new Error("unexpected pin read during render"); });
	assert.doesNotMatch(stripAnsi(renderComponent(firstPanel!)), /pin\s+local: team/);
	assert.match(stripAnsi(renderComponent(reopenedPanel)), /pin\s+local: team/);
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

test("P declares the profile in the worktree so the routing can be committed", async (t) => {
	const { fixture, localPinPath, repoPinPath, writeStore } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("P");
			panel.handleInput("\x1b");
		} else {
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");

	assert.equal(
		readFileSync(repoPinPath, "utf8"),
		`${JSON.stringify({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "team" }, null, 2)}\n`,
	);
	assert.equal(existsSync(localPinPath), false, "P writes the worktree declaration only");
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
	assert.match(rendered ?? "", /pin\s+local: deleted-profile \(missing from this store\)/);
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
		panel.handleInput(visits === 1 ? "p" : "\x1b");
	});
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(localPinPath), false);
	assert.equal(existsSync(repoPinPath), false);
	assert.match(fixture.notifications.at(-1)?.message ?? "", /not inside a Git worktree/);
});

test("pressing p again on the pinned profile removes the clone pin", async (t) => {
	const { fixture, localPinPath, writeStore, writePin } = profilesStoreFixture(t);
	writeStore({ team: { worker: { model: "openai/alpha" } } }, "team");
	writePin(localPinPath, "team");
	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("p");
			panel.handleInput("\x1b");
		} else {
			panel.handleInput("\x1b");
		}
	});
	await fixture.run("gentle:profiles");
	assert.equal(existsSync(localPinPath), false, "a second p removes the layer instead of rewriting it");
	assert.match(fixture.notifications.at(-1)?.message ?? "", /removed the local pin for this clone/);
});

test("the profile list marks the layer that wins with (pinned)", async (t) => {
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
	assert.match(rendered ?? "", /other \(pinned\)/);
	assert.doesNotMatch(rendered ?? "", /team \(pinned\)/);
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
	assert.match(rendered ?? "", /invalid pin file/);
	assert.doesNotMatch(rendered ?? "", /\(missing from this store\)/);
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
	let firstPanel: RoutingConsumerPanel | undefined;
	fixture.onInput((panel) => {
		if (firstPanel === undefined) {
			firstPanel = panel;
			panel.handleInput("x");
			panel.handleInput("\x1b");
		} else {
			panel.handleInput("\x1b");
		}
	});
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
