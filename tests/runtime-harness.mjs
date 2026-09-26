#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { domainHashV1 } from "../lib/review-canonical.ts";
import { canonicalHash } from "../lib/review-transaction.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { createGentleAiExtension } = await import(pathToFileURL(join(ROOT, "extensions/gentle-ai.ts")).href);
const EXTENSIONS = [
	"extensions/gentle-ai.ts",
	"extensions/quiet-tools.ts",
	"extensions/skill-registry.ts",
	"extensions/startup-banner.ts",
];

const EXPECTED_BANNER_COMMANDS = [
	"gentle:banner",
	"gentle:toggle-rose",
	"gentle:toggle-text-logo",
	"gentle:banner-color",
];

const EXPECTED_COMMANDS = [
	"gentle:install-delegation",
	"gentle:install-review",
	"gentle:models",
	"gentle:persona",
	"gentle:status",
	"gentle:doctor",
	"skill-registry:refresh",
	...EXPECTED_BANNER_COMMANDS,
];

const FORBIDDEN_COMPAT_COMMANDS = [
	"gentle:install-assets",
	"gentle-ai:models",
	"gentleman:models",
	"gentle-ai:persona",
	"gentleman:persona",
	"gentle-ai:status",
	"gentle-ai:doctor",
	"gentle-ai:banner",
	"gentle-ai:toggle-rose",
	"gentle-ai:toggle-text-logo",
	"gentle-ai:banner-color",
];

function createPi() {
	const hooks = new Map();
	const commands = new Map();
	const flags = new Map();
	const tools = new Map();
	const eventHandlers = new Map();
	const emittedEvents = [];
	const flagValues = new Map([["no-skill-registry", true]]);
	const events = {
		emit(channel, data) {
			emittedEvents.push({ channel, data });
			for (const handler of eventHandlers.get(channel) ?? []) handler(data);
		},
		on(channel, handler) {
			const handlers = eventHandlers.get(channel) ?? new Set();
			handlers.add(handler);
			eventHandlers.set(channel, handlers);
			return () => {
				handlers.delete(handler);
				if (handlers.size === 0) eventHandlers.delete(channel);
			};
		},
	};
	let activeTools = ["read", "bash", "edit", "write"];

	const pi = {
		events,
		on(name, handler) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerFlag(name, definition) {
			flags.set(name, definition);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
		getFlag(name) {
			return flagValues.get(name) ?? false;
		},
		setFlag(name, value) {
			flagValues.set(name, value);
		},
		getCommands() {
			return Array.from(commands, ([name, definition]) => ({ name, ...definition }));
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(value) {
			activeTools = value;
		},
		getAllTools() {
			return [
				{ name: "read" },
				{ name: "bash" },
				{ name: "edit" },
				{ name: "write" },
				{ name: "mem_save" },
			];
		},
	};

	return { pi, hooks, commands, flags, tools, emittedEvents };
}

function createUi() {
	const notifications = [];
	const selections = [];
	return {
		notifications,
		selections,
		notify(message, level = "info") {
			notifications.push({ message, level });
		},
		async confirm() {
			return false;
		},
		async select(label, options) {
			selections.push({ label, options });
			return options[0];
		},
		async input(_label, placeholder) {
			return placeholder;
		},
		custom() {
			return Promise.resolve({ type: "cancel" });
		},
	};
}

function createCtx(cwd, hasUI = false, sessionId = "session-1") {
	return {
		cwd,
		hasUI,
		ui: createUi(),
		sessionManager: {
			getSessionFile() {
				return join(cwd, `${sessionId}.jsonl`);
			},
			getSessionId() {
				return sessionId;
			},
		},
		modelRegistry: {
			async getAvailable() {
				return [];
			},
		},
	};
}

function readAgentDefinition(source) {
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, "agent must have frontmatter");
	const name = frontmatter.match(/^name:\s*(\S+)$/m)?.[1];
	assert.ok(name, "agent must declare its identity");
	const tools = [...frontmatter.matchAll(/^ {2}- ([\w-]+)$/gm)].map(
		(match) => match[1],
	);
	return { name, tools };
}

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function gitSync(cwd, ...arguments_) {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

async function tempWorkspace() {
	return mkdtemp(join(tmpdir(), "gentle-pi-runtime-"));
}

function restoreWorkspaceWritePermissions(cwd) {
	if (process.platform === "win32") return;
	try {
		execFileSync("chmod", ["-R", "u+w", cwd], { stdio: "ignore" });
	} catch {
		// A prior candidate-view cleanup may already have removed the workspace.
	}
}

async function loadExtensions(pi) {
	for (const [index, rel] of EXTENSIONS.entries()) {
		const mod = await import(`${pathToFileURL(join(ROOT, rel)).href}?runtime-harness=${index}`);
		assert.equal(typeof mod.default, "function", `${rel} must export a default function`);
		mod.default(pi);
	}
}

async function run() {
	const globalConfigHome = await tempWorkspace();
	const globalAgentHome = await tempWorkspace();
	const ambientTestAssetsDir = await tempWorkspace();
	process.env.GENTLE_PI_CONFIG_HOME = globalConfigHome;
	process.env.GENTLE_PI_AGENT_HOME = globalAgentHome;
	process.env.GENTLE_PI_TEST_ASSETS_DIR = ambientTestAssetsDir;
	const globalModelsPath = join(globalConfigHome, "models.json");
	const globalSubagentsPath = join(globalAgentHome, "subagents.json");
	const { pi, hooks, commands, flags, tools, emittedEvents } = createPi();
	await loadExtensions(pi);

	// gentle-pi#404: a collect binding that returns the native last-event
	// closure must terminate after one capture. It must not re-enter a public
	// lifecycle mutation or synthesize a follow-up transition.
	{
		const lineageId = "runtime-last-event";
		const sha = `sha256:${"a".repeat(64)}`;
		const tree = "b".repeat(40);
		const repositoryContext = `rctx1_${"c".repeat(64)}`;
		const calls = [];
		const arguments_ = [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "expected-revision", value: sha, token: `--expected-revision=${sha}` },
			{ name: "target", value: sha, token: `--target=${sha}` },
			{ name: "repository-context", value: repositoryContext, token: `--repository-context=${repositoryContext}` },
			{ name: "lens", value: "review-risk", token: "--lens=review-risk" },
			{ name: "order", value: "0", token: "--order=0" },
			{ name: "subject-hash", value: sha, token: `--subject-hash=${sha}` },
		];
		const input = {
			name: "correction_plan",
			schema: "gentle-ai.review-correction-plan/v1",
			captureOperation: "review.capture-correction-plan",
			arguments: arguments_,
			submission: {
				operationToken: "capture-correction-plan",
				argumentTokens: [...arguments_.map((argument) => argument.token), "--correction-lines={{value}}"],
				values: [{ slot: "correction_lines", domain: "positive_integer", substitutionLocation: 7, minimum: 1, maximum: 1 }],
			},
		};
		const status = {
			contract: "gentle-ai.review-integration/v2",
			applicability: "current_target",
			authority: { version: "compact-v2", lineageId, state: "correction_required", generation: 1, revision: sha },
			receipt: { status: "expected_missing" },
			action: "stop",
			replayability: "not_replayable",
			targetIdentity: sha,
			projection: {
				schema: "gentle-ai.review-candidate-projection/v1",
				kind: "current-changes",
				projection: "workspace",
				baseTree: tree,
				initialReviewTree: tree,
				currentCandidateTree: tree,
				pathsDigest: sha,
				paths: ["app.ts"],
				intendedUntracked: [],
				intendedUntrackedProof: sha,
				initialSnapshotIdentity: sha,
				currentSnapshotIdentity: sha,
			},
			repair: { schema: "gentle-ai.review-authority-repair-assessment/v1", status: "unsupported", counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 }, supportedOperations: ["review/complete-fix", "review/validate-fix"], authorizationSchema: "gentle-ai.review-repair-authorization/v1" },
			candidates: [],
			nextTransition: { kind: "collect", reasonCode: "correction_plan_required", collect: { inputs: [input] } },
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		};
		const nativeReviewCli = {
			async targetStatus(request) {
				calls.push({ operation: "status", request });
				return status;
			},
			async captureCorrectionPlan(request) {
				calls.push({ operation: "capture-correction-plan", request });
				return {
					schema: "gentle-ai.review-last-event-closure/v1",
					operation: "review.capture-correction-plan",
					lineageId,
					state: "correction_required",
					targetIdentity: sha,
					requestHash: sha,
					correctionLines: 1,
					storeRevision: sha,
				};
			},
		};
		const lastEventPi = createPi();
		createGentleAiExtension({ nativeReviewCli })(lastEventPi.pi);
		const controller = lastEventPi.tools.get("gentle_review");
		const capture = lastEventPi.tools.get("gentle_review_capture");
		assert.ok(controller, "runtime must register the public status controller");
		assert.ok(capture, "runtime must register the one-slot capture tool");
		assert.equal(lastEventPi.tools.get("gentle_review_capture_group")?.executionMode, "sequential", "runtime must register grouped capture with bounded foreground concurrency");
		assert.equal(controller.parameters.properties.operation.enum.includes("finalize"), false);
		assert.equal(controller.parameters.properties.operation.enum.includes("validate"), false);

		const publicStatus = await controller.execute(
			"runtime-status",
			{ operation: "status", lineageId },
			undefined,
			undefined,
			createCtx(ROOT, false, lineageId),
		);
		const collectBindings = publicStatus.details.collectBindings;
		assert.equal(publicStatus.details.status, "blocked");
		assert.equal(collectBindings.length, 1);

		const captured = await capture.execute(
			"runtime-capture",
			{ lineageId, collectBinding: collectBindings[0].collectBinding, correctionLines: 1 },
			undefined,
			undefined,
			createCtx(ROOT, false, lineageId),
		);
		assert.equal(captured.details.status, "closed");
		assert.equal(captured.details.outcome, "native-last-event-closure");
		assert.equal(captured.details.closure.operation, "review.capture-correction-plan");
		assert.deepEqual(
			calls.map(({ operation }) => operation),
			["status", "status", "capture-correction-plan"],
			"last-event closure must make no follow-up lifecycle mutation",
		);
	}

	for (const name of EXPECTED_COMMANDS) {
		assert.ok(commands.has(name), `missing command ${name}`);
	}
	for (const name of FORBIDDEN_COMPAT_COMMANDS) {
		assert.equal(commands.has(name), false, `compat command should not be registered: ${name}`);
	}
	// Retired SDD command entry points must not register, regardless of unrelated prompt text.
	for (const name of [
		"gentle:install-sdd", "gentle:sdd-preflight", "gentle-sdd-status",
		"gentle-sdd-continue", "gentle-sdd-init", "sdd-init", "sdd-continue",
		"sdd-status", "gentle-ai:install-sdd", "gentle-ai:sdd-preflight",
		"gentle-ai:sdd-status", "gentle-ai:sdd-continue",
	]) {
		assert.equal(commands.has(name), false, `retired SDD command registered: ${name}`);
	}
	assert.ok(flags.has("no-skill-registry"), "missing no-skill-registry flag");
	assert.ok(hooks.has("session_start"), "missing session_start hook");
	assert.ok(hooks.has("session_shutdown"), "missing session_shutdown hook");
	assert.equal(hooks.has("input"), false, "retired SDD slash input must not be intercepted");
	assert.ok(hooks.has("before_agent_start"), "missing before_agent_start hook");
	assert.ok(hooks.has("tool_call"), "missing tool_call hook");
	for (const toolName of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
		assert.ok(tools.has(toolName), `missing quiet built-in tool renderer ${toolName}`);
	}
	assert.ok(tools.has("gentle_review"), "missing registered bounded review controller tool");
	assert.ok(tools.has("gentle_review_scope"), "missing registered bounded review scope tool");
	assert.deepEqual(
		tools.get("gentle_review").parameters.properties.operation.enum.filter((operation) => operation.includes("supersession") || operation === "supersede" || operation === "reconcile-authority"),
		["reconcile-authority"],
		"runtime controller must expose only native authority reconciliation",
	);

	for (const entry of await readdir(join(ROOT, "assets", "agents"))) {
		if (!entry.endsWith(".md")) continue;
		const agentPrompt = await readFile(join(ROOT, "assets", "agents", entry), "utf8");
		assert.doesNotMatch(
			agentPrompt,
			/inheritProjectContext:\s*true/,
			`${entry} must not inherit parent project context by default`,
		);
	}

	const discovered = await discoverAndLoadExtensions(["./extensions"], ROOT);
	assert.deepEqual(
		discovered.errors,
		[],
		"declared extension directory must load without invalid helper modules",
	);

	// orchestrator-lazy-diet: Pi Subagent Model Routing detail (the "do not
	// pass the `model` parameter by default" / SDD-model-assignment-scoping
	// rules) moved verbatim to assets/orchestrator-delegation.md; the
	// always-on combined prompt now only carries a pointer to it. Union read
	// so these assertions are repointed, not weakened.
	const delegationDetail = await readFile(join(ROOT, "assets", "orchestrator-delegation.md"), "utf8");

	const promptCwd = await tempWorkspace();
	try {
		const promptHook = hooks.get("before_agent_start")[0];
		const promptResult = await promptHook({ systemPrompt: "base" }, createCtx(promptCwd));
		assert.match(promptResult.systemPrompt, /base/);
		assert.match(promptResult.systemPrompt, /el Gentleman/);
		assert.match(promptResult.systemPrompt, /Organic Driven Development/);
		assert.doesNotMatch(promptResult.systemPrompt, /## SDD Research Capabilities/);
		assert.match(promptResult.systemPrompt, /review execution contract/);
		assert.doesNotMatch(await readFile(join(ROOT, "extensions", "gentle-ai.ts"), "utf8"), /readCommandSddStatus/);
		assert.match(promptResult.systemPrompt + delegationDetail, /do not pass the `model` parameter by default/);
		assert.doesNotMatch(promptResult.systemPrompt, /Every Agent tool call MUST include `model`/);
		assert.ok(
			promptResult.systemPrompt.includes(
				`Package assets root: \`${join(ROOT, "assets")}\`. Lazy asset paths below are relative to this root.`,
			),
			"parent prompt must declare the one absolute root for relative lazy asset paths",
		);
		assert.doesNotMatch(
			promptResult.systemPrompt,
			new RegExp(ambientTestAssetsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			"normal runtime must ignore ambient GENTLE_PI_TEST_ASSETS_DIR",
		);
		delete process.env.GENTLE_PI_TEST_ASSETS_DIR;
		await rm(ambientTestAssetsDir, { recursive: true, force: true });
		await writeFile(
			join(globalConfigHome, "persona.json"),
			'{"mode":"neutral"}\n',
		);
		const neutralPromptResult = await promptHook({ systemPrompt: "base" }, createCtx(promptCwd));
		assert.match(neutralPromptResult.systemPrompt, /Do not use slang or regional expressions/);
		assert.doesNotMatch(
			neutralPromptResult.systemPrompt,
			/When the user writes Spanish, answer in natural Rioplatense Spanish with voseo/,
			"neutral persona prompt must not include unconditional voseo instructions after reload",
		);
		const subagentPromptResult = await promptHook(
			{ agentName: "worker", systemPrompt: "worker base" },
			createCtx(promptCwd),
		);
		assert.equal(subagentPromptResult.systemPrompt, "worker base");
		await mkdir(join(promptCwd, ".pi", "gentle-ai"), { recursive: true });
		await writeFile(
			join(promptCwd, ".pi", "gentle-ai", "persona.json"),
			'{"mode":"gentleman"}\n',
		);
		const localOverridePromptResult = await promptHook({ systemPrompt: "base" }, createCtx(promptCwd));
		assert.match(
			localOverridePromptResult.systemPrompt,
			/When the user writes Spanish, answer in natural Rioplatense Spanish with voseo/,
		);
		const personaCtx = createCtx(promptCwd, true);
		personaCtx.ui.select = async () => "neutral";
		await commands.get("gentle:persona").handler("", personaCtx);
		assert.equal(
			await readFile(join(globalConfigHome, "persona.json"), "utf8"),
			'{\n  "mode": "neutral"\n}\n',
		);
		assert.equal(
			await readFile(join(promptCwd, ".pi", "gentle-ai", "persona.json"), "utf8"),
			'{\n  "mode": "neutral"\n}\n',
		);
		assert.match(personaCtx.ui.notifications.at(-1).message, /Global config:/);
	} finally {
		await rm(promptCwd, { recursive: true, force: true });
	}

	const toolCwd = await tempWorkspace();
	try {
		execFileSync("git", ["init"], { cwd: toolCwd, stdio: "ignore" });
		const toolHook = hooks.get("tool_call")[0];
		const toolResultHook = hooks.get("tool_result")[0];
		const promptHook = hooks.get("before_agent_start")[0];
		const oddCtx = createCtx(toolCwd, false, "odd-runtime-gate");
		await promptHook({ systemPrompt: "primary" }, oddCtx);
		const firstOddPath = join(toolCwd, "first.ts");
		assert.equal(await toolHook({ toolName: "write", input: { path: firstOddPath } }, oddCtx), undefined);
		await toolResultHook({ toolName: "write", toolCallId: "odd-first", input: { path: firstOddPath }, isError: false }, oddCtx);
		const secondOdd = await toolHook({ toolName: "edit", input: { path: join(toolCwd, "second.ts") } }, oddCtx);
		assert.equal(secondOdd, undefined, "write history alone must not refuse a second direct file");
		const ghPrCwd = await tempWorkspace();
		try {
			execFileSync("git", ["init"], { cwd: ghPrCwd, stdio: "ignore" });
			const deliveryResult = await toolHook(
				{ toolName: "bash", input: { command: "gh pr create --draft" } },
				createCtx(ghPrCwd, true, "ordinary-delivery-session"),
			);
			assert.equal(deliveryResult, undefined, "ordinary delivery policy, not review authority, governs pull-request creation");
		} finally {
			await rm(ghPrCwd, { recursive: true, force: true });
		}
		assert.equal(await toolHook({ toolName: "bash", input: { command: "git status" } }, createCtx(toolCwd)), undefined);
		const denied = await toolHook({ toolName: "bash", input: { command: "rm -rf /" } }, createCtx(toolCwd));
		assert.equal(denied.block, true);
		assert.match(denied.reason, /destructive/);
		const reviewDispatch = { agent: "review-risk", task: "review", mode: "task" };
		const missingReviewView = await toolHook({ toolName: "subagent_run", input: reviewDispatch }, createCtx(toolCwd));
		assert.equal(missingReviewView.block, true);
		assert.match(missingReviewView.reason, /candidate view/i);
		assert.equal(reviewDispatch.task, "review", "blocked review dispatch must not mutate child input");

		for (const [agent, label, task] of [
			["gentle-ai-worker", "missing", "Implement the requested change."],
			["gentle-ai-worker", "absolute", "## Allowed edit surfaces\n/tmp/outside.ts"],
			["gentle-ai-worker", "Windows absolute", "## Allowed edit surfaces\nC:\\outside.ts"],
			["gentle-ai-worker", "prose instead of paths", "## Allowed edit surfaces\nThe parent will determine the paths."],
			["gentle-ai-worker", "repository root", "## Allowed edit surfaces\n."],
			["gentle-ai-worker", "bare repository root", "## Allowed edit surfaces\n./"],
			["gentle-ai-worker", "normalized bare repository root", "## Allowed edit surfaces\n.//"],
			["gentle-ai-worker", "equivalent normalized bare repository root", "## Allowed edit surfaces\n././/"],
			["worker", "generic writer missing", "Implement the requested change."],
		]) {
			const writerDispatch = { agent, task, mode: "task" };
			const writerResult = await toolHook(
				{ toolName: "subagent_run", input: writerDispatch },
				createCtx(toolCwd),
			);
			assert.equal(writerResult?.block, true, `${label} writer scope must be blocked before dispatch`);
			assert.match(writerResult?.reason ?? "", /derive|map/i);
			assert.match(writerResult?.reason ?? "", /relaunch/i);
			assert.match(writerResult?.reason ?? "", /do not ask.*human.*paths or globs/i);
			assert.equal(writerDispatch.task, task, "writer guard must not mutate child input");
		}

		const scopedWriterDispatch = {
			agent: "gentle-ai-worker",
			task: "Implement the requested change.\n\n## Allowed edit surfaces\nextensions/gentle-ai.ts\ntests/runtime-harness.mjs",
			mode: "task",
		};
		assert.equal(
			await toolHook({ toolName: "subagent_run", input: scopedWriterDispatch }, createCtx(toolCwd)),
			undefined,
			"a writer may dispatch with narrow task-scoped repository-relative paths",
		);
		assert.equal(
			await toolHook(
				{
					toolName: "subagent_run",
					input: {
						agent: "worker",
						task: "Implement the requested change.",
						context: "## Allowed edit surfaces\n- assets/orchestrator.md",
						mode: "task",
					},
				},
				createCtx(toolCwd),
			),
			undefined,
			"a writer may dispatch when context carries narrow task-scoped repository-relative paths",
		);

		const canonicalFrozenFindingRow = '{"id":"JD-A-001","lens":"judgment-day","location":"extensions/gentle-ai.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"The frozen finding has concrete user impact."}';
		const canonicalFrozenFindingRows = [JSON.parse(canonicalFrozenFindingRow)];
		const canonicalFrozenLedgerHash = canonicalHash(canonicalFrozenFindingRows);
		const canonicalJdFixTask = [
			"Apply the controller-authorized fix.",
			"",
			"## Judgment Day activation",
			"User explicitly requested Judgment Day.",
			"",
			"## Exact authorized severe IDs",
			"- `JD-A-001`",
			"",
			"## Judgment Day correction batch",
			"Round: 1 of 2.",
			`Frozen ledger SHA-256: \`${canonicalFrozenLedgerHash}\``,
			"",
			"## Exact frozen finding rows",
			canonicalFrozenFindingRow,
			"",
			"## Allowed edit surfaces",
			"extensions/gentle-ai.ts",
			"tests/runtime-harness.mjs",
		].join("\n");
		const orderedFrozenFindingRows = [
			...canonicalFrozenFindingRows,
			{ ...canonicalFrozenFindingRows[0], id: "JD-B-002", location: "tests/runtime-harness.mjs:1" },
		];
		const reversedFrozenFindingRows = [...orderedFrozenFindingRows].reverse();
		const rowOrderMismatchJdFixTask = canonicalJdFixTask
			.replace("- `JD-A-001`", "- `JD-A-001`\n- `JD-B-002`")
			.replace(canonicalFrozenLedgerHash, canonicalHash(reversedFrozenFindingRows))
			.replace(canonicalFrozenFindingRow, reversedFrozenFindingRows.map((row) => JSON.stringify(row)).join("\n"));
		const incorrectFrozenLedgerHash = `${canonicalFrozenLedgerHash.slice(0, -1)}${canonicalFrozenLedgerHash.endsWith("0") ? "1" : "0"}`;
		for (const [label, input] of [
			["missing activation", { agent: "jd-fix-agent", task: "## Allowed edit surfaces\nextensions/gentle-ai.ts", mode: "task" }],
			["duplicate activation", { agent: "jd-fix-agent", task: `${canonicalJdFixTask}\n\n## Judgment Day activation\nUser explicitly requested Judgment Day.`, mode: "task" }],
			["missing severe IDs", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("## Exact authorized severe IDs\n- `JD-A-001`\n", ""), mode: "task" }],
			["duplicate severe ID bindings", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("- `JD-A-001`", "- `JD-A-001`\n- `JD-A-001`"), mode: "task" }],
			["duplicate severe ID sections", { agent: "jd-fix-agent", task: canonicalJdFixTask, context: "## Exact authorized severe IDs\n- `JD-B-002`", mode: "task" }],
			["malformed activation", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("User explicitly requested Judgment Day.", "Judgment Day is explicitly activated for this dispatch."), mode: "task" }],
			["extra activation line", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("User explicitly requested Judgment Day.", "User explicitly requested Judgment Day.\nUnexpected activation detail."), mode: "task" }],
			["malformed severe ID", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("- `JD-A-001`", "JD-A-001"), mode: "task" }],
			["empty severe IDs", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("- `JD-A-001`", ""), mode: "task" }],
			["missing correction batch", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(`## Judgment Day correction batch\nRound: 1 of 2.\nFrozen ledger SHA-256: \`${canonicalFrozenLedgerHash}\`\n`, ""), mode: "task" }],
			["duplicate correction batch", { agent: "jd-fix-agent", task: `${canonicalJdFixTask}\n## Judgment Day correction batch\nRound: 2 of 2.\nFrozen ledger SHA-256: \`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\``, mode: "task" }],
			["out-of-order correction batch", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(`## Judgment Day correction batch\nRound: 1 of 2.\nFrozen ledger SHA-256: \`${canonicalFrozenLedgerHash}\`\n\n## Exact frozen finding rows\n${canonicalFrozenFindingRow}`, `## Exact frozen finding rows\n${canonicalFrozenFindingRow}\n\n## Judgment Day correction batch\nRound: 1 of 2.\nFrozen ledger SHA-256: \`${canonicalFrozenLedgerHash}\``), mode: "task" }],
			["invalid correction round", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("Round: 1 of 2.", "Round: 3 of 2."), mode: "task" }],
			["uppercase frozen ledger hash", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenLedgerHash, canonicalFrozenLedgerHash.toUpperCase()), mode: "task" }],
			["incorrect frozen ledger hash", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenLedgerHash, incorrectFrozenLedgerHash), mode: "task" }],
			["extra correction batch line", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("Round: 1 of 2.", "Round: 1 of 2.\nUnexpected line"), mode: "task" }],
			["missing frozen rows", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(`## Exact frozen finding rows\n${canonicalFrozenFindingRow}\n`, ""), mode: "task" }],
			["malformed frozen row", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenFindingRow, "{"), mode: "task" }],
			["duplicate frozen row", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenFindingRow, `${canonicalFrozenFindingRow}\n${canonicalFrozenFindingRow}`), mode: "task" }],
			["mismatched frozen row ID", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenFindingRow, canonicalFrozenFindingRow.replace("JD-A-001", "JD-B-002")), mode: "task" }],
			["frozen row order mismatch", { agent: "jd-fix-agent", task: rowOrderMismatchJdFixTask, mode: "task" }],
			["extra frozen row field", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace(canonicalFrozenFindingRow, canonicalFrozenFindingRow.replace("}", ",\"extra\":true}")), mode: "task" }],
			["non-Judgment-Day frozen row", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("\"lens\":\"judgment-day\"", "\"lens\":\"review-risk\""), mode: "task" }],
			["non-open frozen row", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("\"status_at_freeze\":\"open\"", "\"status_at_freeze\":\"closed\""), mode: "task" }],
			["non-severe frozen row", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("\"severity\":\"CRITICAL\"", "\"severity\":\"WARNING\""), mode: "task" }],
			["empty frozen evidence", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("\"evidence_claim\":\"The frozen finding has concrete user impact.\"", "\"evidence_claim\":\"\""), mode: "task" }],
			["missing edit surface", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("## Allowed edit surfaces\nextensions/gentle-ai.ts\ntests/runtime-harness.mjs", ""), mode: "task" }],
			["invalid edit surface", { agent: "jd-fix-agent", task: canonicalJdFixTask.replace("## Allowed edit surfaces\nextensions/gentle-ai.ts", "## Allowed edit surfaces\n."), mode: "task" }],
			["mixed", { agent: ["jd-fix-agent", "gentle-ai-worker"], task: canonicalJdFixTask, mode: "task" }],
			["agent array", { agent: ["jd-fix-agent"], task: canonicalJdFixTask, mode: "task" }],
			["agents array", { agents: ["jd-fix-agent"], task: canonicalJdFixTask, mode: "task" }],
			["duplicate agent binding", { agent: "jd-fix-agent", agents: "jd-fix-agent", task: canonicalJdFixTask, mode: "task" }],
		]) {
			const original = structuredClone(input);
			const result = await toolHook({ toolName: "subagent_run", input }, createCtx(toolCwd));
			assert.equal(result?.block, true, `${label} jd-fix-agent dispatch must be blocked`);
			assert.match(result?.reason ?? "", /Judgment Day fix dispatch/i);
			assert.deepEqual(input, original, `${label} jd-fix-agent rejection must not mutate input`);
		}
		assert.equal(
			await toolHook(
				{ toolName: "subagent_run", input: { agent: "jd-fix-agent", task: canonicalJdFixTask, mode: "task" } },
				createCtx(toolCwd),
			),
			undefined,
			"a canonical explicit Judgment Day fix dispatch with narrow edit surfaces may run",
		);
		for (const [label, input] of [
			[
				"valid scope followed by a repository-root scope",
				{
					agent: "gentle-ai-worker",
					task: "## Allowed edit surfaces\nextensions/gentle-ai.ts\n\n## Allowed edit surfaces\n.",
					mode: "task",
				},
			],
			[
				"valid task scope plus invalid context scope",
				{
					agent: "gentle-ai-worker",
					task: "## Allowed edit surfaces\nextensions/gentle-ai.ts",
					context: "## Allowed edit surfaces\n.",
					mode: "task",
				},
			],
			[
				"conflicting valid task and context scopes",
				{
					agent: "gentle-ai-worker",
					task: "## Allowed edit surfaces\nextensions/gentle-ai.ts",
					context: "## Allowed edit surfaces\ntests/runtime-harness.mjs",
					mode: "task",
				},
			],
		]) {
			const writerResult = await toolHook({ toolName: "subagent_run", input }, createCtx(toolCwd));
			assert.equal(writerResult?.block, true, `${label} must block writer dispatch`);
		}
		assert.equal(
			await toolHook(
				{
					toolName: "subagent_run",
					input: {
						agent: "gentle-ai-worker",
						task: "## Allowed edit surfaces\nextensions/gentle-ai.ts\ntests/runtime-harness.mjs\n\n## Allowed edit surfaces\n- `tests/runtime-harness.mjs`\n- `extensions/gentle-ai.ts`",
						mode: "task",
					},
				},
				createCtx(toolCwd),
			),
			undefined,
			"a writer may dispatch when multiple allowed edit surface sections are compatible",
		);
		assert.equal(
			await toolHook(
				{ toolName: "subagent_run", input: { agent: "scout", task: "Map the repository.", mode: "task" } },
				createCtx(toolCwd),
			),
			undefined,
			"non-writer subagents must remain unaffected",
		);
		const sensitiveRead = await toolHook({ toolName: "read", input: { path: join(toolCwd, ".env.local") } }, createCtx(toolCwd));
		assert.equal(sensitiveRead.block, true);
		assert.match(sensitiveRead.reason, /sensitive path/);
		const sensitiveWrite = await toolHook({ toolName: "write", input: { path: join(toolCwd, "secrets", "token.txt"), content: "x" } }, createCtx(toolCwd));
		assert.equal(sensitiveWrite.block, true);
		const sensitiveEdit = await toolHook({ toolName: "edit", input: { edits: [], path: join(toolCwd, "id_rsa.pem") } }, createCtx(toolCwd));
		assert.equal(sensitiveEdit.block, true);
		assert.equal(await toolHook({ toolName: "read", input: { path: join(toolCwd, "src", "index.ts") } }, createCtx(toolCwd)), undefined);
		const dangerousReviewCtx = createCtx(toolCwd, true, "dangerous-review-session");
		const needsConfirm = await toolHook(
			{ toolName: "bash", input: { command: "git push" } },
			dangerousReviewCtx,
		);
		assert.equal(needsConfirm.block, true);
		assert.match(needsConfirm.reason, /not confirmed/);
		assert.deepEqual(
			emittedEvents.map(({ channel, data }) => ({
				channel,
				state: data.state,
				active: data.active,
				label: data.label,
			})),
			[
				{
					channel: "pi-permission-system:permission-request",
					state: "waiting",
					active: undefined,
					label: undefined,
				},
				{
					channel: "herdr:blocked",
					state: undefined,
					active: true,
					label: "Guarded command confirmation",
				},
				{
					channel: "pi-permission-system:permission-request",
					state: "denied",
					active: undefined,
					label: undefined,
				},
				{
					channel: "herdr:blocked",
					state: undefined,
					active: false,
					label: undefined,
				},
			],
			"guarded confirmation emits both lifecycle channels in order",
		);
		assert.equal(emittedEvents[0].data.requestId, emittedEvents[2].data.requestId);
		emittedEvents.length = 0;
		pi.events.emit("rpiv:ask-user:blocked", {
			active: true,
			question: "private runtime questionnaire",
			answer: "private runtime answer",
			path: "/private/runtime-path",
			command: "private runtime command",
		});
		pi.events.emit("rpiv:ask-user:blocked", { active: true, duplicate: true });
		pi.events.emit("rpiv:ask-user:blocked", { active: "true" });
		pi.events.emit("rpiv:ask-user:other", { active: false });
		pi.events.emit("rpiv:ask-user:blocked", { active: false });
		const rpivHerdrEvents = emittedEvents.filter(({ channel }) => channel === "herdr:blocked");
		assert.deepEqual(rpivHerdrEvents, [
			{ channel: "herdr:blocked", data: { active: true, label: "Questionnaire awaiting input" } },
			{ channel: "herdr:blocked", data: { active: false } },
		]);
		assert.doesNotMatch(JSON.stringify(rpivHerdrEvents), /private runtime/i);
		emittedEvents.length = 0;
		assert.equal(
			dangerousReviewCtx.ui.notifications.length,
			0,
			"dangerous-command confirmation must not launch or announce review actors",
		);
		const commitCwd = await tempWorkspace();
		try {
			execFileSync("git", ["init"], { cwd: commitCwd, stdio: "ignore" });
			const deliveryResult = await toolHook(
				{ toolName: "bash", input: { command: "git commit -m bounded tracked.txt" } },
				createCtx(commitCwd),
			);
			assert.equal(deliveryResult, undefined, "ordinary delivery policy, not review authority, governs commits");
		} finally {
			await rm(commitCwd, { recursive: true, force: true });
		}
	} finally {
		await rm(toolCwd, { recursive: true, force: true });
	}

	// review-candidate-view Phase 3.6 settling test: a contributor edit landing
	// strictly between the controller-owned candidate binding and reviewer
	// dispatch must diverge the live candidate tree from the frozen one, and
	// dispatch must fail closed rather than expose a substituted view to the
	// lens sub-agent. This drives the real `createGentleAiExtension` tool_call
	// wiring (not the bare library function tested in
	// tests/review-candidate-view.test.ts) with an injected candidate-view
	// registry, so the actual production dispatch path is exercised.
	const candidateDriftCwd = await tempWorkspace();
	try {
		const { createGentleAiExtension } = await import(
			pathToFileURL(join(ROOT, "extensions/gentle-ai.ts")).href
		);
		const { CandidateViewRegistry } = await import(
			pathToFileURL(join(ROOT, "lib/review-candidate-view.ts")).href
		);

		gitSync(candidateDriftCwd, "init", "-b", "main");
		await writeFile(join(candidateDriftCwd, "tracked.txt"), "base\n");
		gitSync(candidateDriftCwd, "add", "tracked.txt");
		gitSync(
			candidateDriftCwd,
			"-c", "user.name=Runtime Harness",
			"-c", "user.email=runtime-harness@example.invalid",
			"commit", "-m", "base",
		);

		const registry = new CandidateViewRegistry();
		const view = registry.create({ contributorRoot: candidateDriftCwd });
		registry.bindCurrent({ token: view.token, lineageId: "harness-candidate-drift", selectedLenses: ["review-risk"] });

		const dispatchPi = createPi();
		createGentleAiExtension({ candidateViews: registry })(dispatchPi.pi);
		const dispatchToolHook = dispatchPi.hooks.get("tool_call")[0];

		// The contributor edits the tracked file strictly after the candidate
		// view was bound (START) and strictly before dispatch would run.
		await writeFile(join(candidateDriftCwd, "tracked.txt"), "drifted after bind, before dispatch\n");

		const dispatchInput = { agent: "review-risk", task: "review", mode: "task" };
		const dispatchResult = await dispatchToolHook(
			{ toolName: "subagent_run", input: dispatchInput },
			createCtx(candidateDriftCwd),
		);
		assert.equal(dispatchResult?.block, true, "dispatch must fail closed when the candidate tree diverges between bind and dispatch");
		assert.match(dispatchResult.reason, /live candidate|drift/i);
		assert.equal(
			dispatchInput.task,
			"review",
			"a failed-closed dispatch must never mutate the child dispatch input",
		);
		assert.doesNotMatch(
			dispatchInput.task,
			/Controller-owned review lineage/,
			"a failed-closed dispatch must never inject a substituted candidate view into the lens sub-agent's task",
		);
		await chmod(view.root, 0o700);
		registry.cleanup(view.token);
	} finally {
		restoreWorkspaceWritePermissions(candidateDriftCwd);
		await rm(candidateDriftCwd, { recursive: true, force: true });
	}

	const bannerCwd = await tempWorkspace();
	try {
		const ctx = createCtx(bannerCwd, true);
		await commands.get("gentle:toggle-rose").handler("", ctx);
		let bannerConfig = JSON.parse(await readFile(join(globalConfigHome, "banner.json"), "utf8"));
		assert.equal(bannerConfig.showRose, false);
		assert.equal(bannerConfig.showTextLogo, true);
		assert.equal(bannerConfig.color, "pink");
		await commands.get("gentle:toggle-text-logo").handler("", ctx);
		bannerConfig = JSON.parse(await readFile(join(globalConfigHome, "banner.json"), "utf8"));
		assert.equal(bannerConfig.showTextLogo, false);
		await commands.get("gentle:banner-color").handler("cyan", ctx);
		bannerConfig = JSON.parse(await readFile(join(globalConfigHome, "banner.json"), "utf8"));
		assert.equal(bannerConfig.color, "cyan");
		await commands.get("gentle:banner").handler("", ctx);
		bannerConfig = JSON.parse(await readFile(join(globalConfigHome, "banner.json"), "utf8"));
		assert.equal(bannerConfig.showRose, true);
	} finally {
		await rm(bannerCwd, { recursive: true, force: true });
		await rm(join(globalConfigHome, "banner.json"), { force: true });
	}

	// issue-301: cancelling the color picker must be a no-op — no write,
	// no notify, and the previously saved color must survive byte/semantically
	// unchanged. Covers both entry points: /gentle:banner-color picker
	// (cancelled), and /gentle:banner -> Color row -> nested picker (cancelled).
	// Also covers an invalid non-empty argument, which must still open the
	// picker and treat its cancellation as a no-op.
	const cancelPickerCwd = await tempWorkspace();
	try {
		const bannerConfigPath = join(globalConfigHome, "banner.json");
		const seeded = {
			showRose: false,
			showTextLogo: false,
			color: "green",
		};
		const seededJson = `${JSON.stringify(seeded, null, 2)}\n`;
		await writeFile(bannerConfigPath, seededJson, "utf8");

		const cancelCtx = createCtx(cancelPickerCwd, true);

		// (a) /gentle:banner-color picker cancelled: seeded color unchanged, no notify.
		cancelCtx.ui.notifications.length = 0;
		cancelCtx.ui.selections.length = 0;
		cancelCtx.ui.select = async (label, options) => {
			cancelCtx.ui.selections.push({ label, options });
			return undefined;
		};
		await commands.get("gentle:banner-color").handler("", cancelCtx);
		let afterCancel = await readFile(bannerConfigPath, "utf8");
		assert.equal(afterCancel, seededJson, "banner-color cancel must not rewrite banner.json");
		assert.equal(cancelCtx.ui.selections.length, 1, "banner-color cancel must open the picker once");
		assert.equal(cancelCtx.ui.notifications.length, 0, "banner-color cancel must not notify");

		// (d) invalid non-empty /gentle:banner-color input still opens picker;
		//     cancelling it is a no-op.
		cancelCtx.ui.notifications.length = 0;
		cancelCtx.ui.selections.length = 0;
		await commands.get("gentle:banner-color").handler("purple", cancelCtx);
		afterCancel = await readFile(bannerConfigPath, "utf8");
		assert.equal(afterCancel, seededJson, "banner-color invalid+cancel must not rewrite banner.json");
		assert.equal(cancelCtx.ui.selections.length, 1, "invalid banner-color arg must still open the picker");
		assert.equal(cancelCtx.ui.notifications.length, 0, "banner-color invalid+cancel must not notify");

		// (b) /gentle:banner selects the Color row, then the nested picker is
		//     cancelled: seeded color unchanged, no notify. The outer select
		//     returns the Color row; the nested select returns undefined.
		cancelCtx.ui.notifications.length = 0;
		cancelCtx.ui.selections.length = 0;
		let selectCall = 0;
		cancelCtx.ui.select = async (label, options) => {
			cancelCtx.ui.selections.push({ label, options });
			selectCall += 1;
			// First call: outer "Startup banner" menu -> pick the Color row.
			// Second call: nested color picker -> cancel (undefined).
			return selectCall === 1 ? options[options.length - 1] : undefined;
		};
		await commands.get("gentle:banner").handler("", cancelCtx);
		afterCancel = await readFile(bannerConfigPath, "utf8");
		assert.equal(afterCancel, seededJson, "banner Color-row cancel must not rewrite banner.json");
		assert.equal(cancelCtx.ui.selections.length, 2, "banner Color-row flow must open outer then nested picker");
		assert.equal(cancelCtx.ui.notifications.length, 0, "banner Color-row cancel must not notify");

		// Sanity: the seeded config round-trips through normalization unchanged,
		// proving the byte equality above is semantic, not a test artifact.
		const reparsed = JSON.parse(await readFile(bannerConfigPath, "utf8"));
		assert.deepEqual(reparsed, seeded, "seeded non-default color must round-trip semantically");
	} finally {
		await rm(cancelPickerCwd, { recursive: true, force: true });
		await rm(join(globalConfigHome, "banner.json"), { force: true });
	}

	const noUiCwd = await tempWorkspace();
	const startupAgentHome = join(noUiCwd, "agent-home");
	process.env.GENTLE_PI_AGENT_HOME = startupAgentHome;
	try {
		const globalAgentHome = startupAgentHome;
		for (const handler of hooks.get("session_start")) {
			await handler({ reason: "startup" }, createCtx(noUiCwd, false));
		}
		for (const diagnostic of ["gentle:status", "gentle:doctor"]) {
			const ctx = createCtx(noUiCwd, true);
			await commands.get(diagnostic).handler("", ctx);
		}
		// gentle-pi#311 P5: the Pi-authored adversarial role agents are retired;
		// installation must not (re)create them.
		const installedRefuterPath = join(globalAgentHome, "agents", "review-refuter.md");
		assert.equal(existsSync(installedRefuterPath), false, "the retired review-refuter agent must not be installed");
		assert.equal(
			existsSync(join(globalAgentHome, "agents", "review-validator.md")),
			false,
			"the retired review-validator agent must not be installed",
		);
		const installedExplorePath = join(globalAgentHome, "agents", "gentle-ai-explore.md");
		assert.equal(existsSync(installedExplorePath), true);
		assert.deepEqual(
			readAgentDefinition(await readFile(installedExplorePath, "utf8")),
			{ name: "gentle-ai-explore", tools: ["read", "grep", "find", "codegraph"] },
			"isolated package installation must activate only the explorer inspection tools",
		);
		const installedRiskSource = await readFile(
			join(globalAgentHome, "agents", "review-risk.md"),
			"utf8",
		);
		assert.match(installedRiskSource, /exactly once against the supplied `initial_review_tree`/);
		assert.match(installedRiskSource, /cannot authorize transitions, fixes, receipts, gates, or delivery/);
		const managedAssetsManifestPath = join(globalAgentHome, "gentle-ai", "managed-assets.json");
		const managedAssetsManifest = JSON.parse(
			await readFile(managedAssetsManifestPath, "utf8"),
		);
		const samePathUserRefuter = [
			"---",
			"name: review-refuter",
			"tools:",
			"  - read",
			"  - bash",
			"---",
			"user-owned runtime policy",
			"",
		].join("\n");
		await writeFile(installedRefuterPath, samePathUserRefuter);
		delete managedAssetsManifest.assets["agents/review-refuter.md"];
		// Retirement sweep: a hash-proven package-managed copy of a retired
		// asset is deleted on refresh; the user-authored same-path refuter
		// above must survive because its hash proves nothing.
		const retiredManagedValidatorPath = join(globalAgentHome, "agents", "review-validator.md");
		const retiredManagedValidator = "stale managed validator\n";
		await writeFile(retiredManagedValidatorPath, retiredManagedValidator);
		managedAssetsManifest.assets["agents/review-validator.md"] = sha256(retiredManagedValidator);
		await mkdir(join(globalAgentHome, "subagents"), { recursive: true });
		const userRefuterOverride = join(globalAgentHome, "subagents", "review-refuter.md");
		await writeFile(userRefuterOverride, "user refuter override must stay\n");
		await writeFile(
			managedAssetsManifestPath,
			JSON.stringify(managedAssetsManifest, null, 2),
		);
		const projectRefuterOverride = join(noUiCwd, ".pi", "agents", "review-refuter.md");
		await mkdir(dirname(projectRefuterOverride), { recursive: true });
		await writeFile(projectRefuterOverride, "project refuter override must stay\n");
		for (const handler of hooks.get("session_start")) {
			await handler({ reason: "startup" }, createCtx(noUiCwd, false));
		}
		assert.equal(existsSync(retiredManagedValidatorPath), false, "review retirement still runs at startup");
		const driftCtx = createCtx(noUiCwd, true);
		await commands.get("gentle:status").handler("", driftCtx);
		assert.doesNotMatch(driftCtx.ui.notifications.at(-1).message, /install-(delegation|review) --force/);
		assert.equal(
			await readFile(installedRefuterPath, "utf8"),
			samePathUserRefuter,
			"session refresh must preserve a same-path user-authored agent byte-for-byte",
		);
		assert.equal(
			await readFile(projectRefuterOverride, "utf8"),
			"project refuter override must stay\n",
			"package refresh must not rewrite or certify an explicit project refuter",
		);
		assert.equal(
			await readFile(userRefuterOverride, "utf8"),
			"user refuter override must stay\n",
			"package refresh must not rewrite or certify an explicit user refuter",
		);
		assert.equal(
			existsSync(retiredManagedValidatorPath),
			false,
			"session refresh must delete a hash-proven package-managed copy of a retired asset",
		);
		const refreshedManagedAssets = JSON.parse(
			await readFile(managedAssetsManifestPath, "utf8"),
		);
		assert.equal(
			refreshedManagedAssets.assets["agents/review-validator.md"],
			undefined,
			"a retired asset must lose package-managed ownership",
		);
		assert.equal(
			refreshedManagedAssets.assets["agents/review-refuter.md"],
			undefined,
			"a user-authored same-path retired asset must stay unowned",
		);
	} finally {
		process.env.GENTLE_PI_AGENT_HOME = globalAgentHome;
		await rm(noUiCwd, { recursive: true, force: true });
	}

	for (const owner of ["delegation", "review"]) {
		const fixture = await tempWorkspace();
		const agentHome = join(fixture, "agent-home");
		const representatives = {
			delegation: "gentle-ai-worker.md",
			review: "review-risk.md",
		};
		try {
			process.env.GENTLE_PI_AGENT_HOME = agentHome;
			process.env.GENTLE_PI_CONFIG_HOME = join(fixture, "config");
			await mkdir(process.env.GENTLE_PI_CONFIG_HOME);
			await writeFile(join(process.env.GENTLE_PI_CONFIG_HOME, "models.json"),
				JSON.stringify({ [representatives[owner].replace(/\.md$/, "")]: "test/installer-must-not-apply" }));
			const ctx = createCtx(fixture, true);
			const command = commands.get(`gentle:install-${owner}`);
			assert.ok(command, `missing owner installer: ${owner}`);
			await command.handler("", ctx);
			for (const [candidate, name] of Object.entries(representatives)) {
				assert.equal(existsSync(join(agentHome, "agents", name)), candidate === owner,
					`${owner} installation must not install ${candidate} assets`);
			}
			assert.equal(existsSync(join(fixture, ".pi", "agents")), false);
			assert.match(ctx.ui.notifications.at(-1).message, /assets installed: \d+ agent\(s\), \d+ chain\(s\), \d+ support file\(s\)/);
			const selectedPath = join(agentHome, "agents", representatives[owner]);
			const packaged = await readFile(selectedPath, "utf8");
			assert.doesNotMatch(packaged, /test\/installer-must-not-apply/);
			const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			for (const [candidate, name] of Object.entries(representatives)) {
				const stale = `stale managed ${candidate}\n`;
				await writeFile(join(agentHome, "agents", name), stale);
				manifest.assets[`agents/${name}`] = sha256(stale);
			}
			await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
			await command.handler("", ctx);
			assert.equal(await readFile(selectedPath, "utf8"), `stale managed ${owner}\n`,
				"repair without --force must preserve existing files");
			await command.handler("--force", ctx);
			assert.equal(await readFile(selectedPath, "utf8"), packaged);
			const refreshed = JSON.parse(await readFile(manifestPath, "utf8"));
			for (const [candidate, name] of Object.entries(representatives)) {
				if (candidate === owner) continue;
				assert.equal(await readFile(join(agentHome, "agents", name), "utf8"), `stale managed ${candidate}\n`);
				assert.equal(refreshed.assets[`agents/${name}`], manifest.assets[`agents/${name}`]);
			}
			const userEdit = `${packaged}\nUser-owned instructions must survive.\n`;
			await writeFile(selectedPath, userEdit);
			await command.handler("--force", ctx);
			assert.equal(await readFile(selectedPath, "utf8"), userEdit);
			assert.equal(existsSync(join(agentHome, "subagents.json")), false,
				"owner installers must not apply model routing");
			await commands.get("gentle:status").handler("", ctx);
			const label = owner;
			assert.ok(ctx.ui.notifications.at(-1).message.includes(`Global ${label} user overrides: 1 file(s)`));
		} finally {
			process.env.GENTLE_PI_CONFIG_HOME = globalConfigHome;
			process.env.GENTLE_PI_AGENT_HOME = globalAgentHome;
			await rm(fixture, { recursive: true, force: true });
		}
	}

	const repairFixture = await tempWorkspace();
	try {
		process.env.GENTLE_PI_AGENT_HOME = join(repairFixture, "agent-home");
		const ctx = createCtx(repairFixture, true);
		for (const diagnostic of ["gentle:status", "gentle:doctor"]) {
			await commands.get(diagnostic).handler("", ctx);
			const message = ctx.ui.notifications.at(-1).message;
			assert.match(message, /Global delegation assets stale: [1-9]\d* file\(s\).*\/gentle:install-delegation --force/,
				`${diagnostic} must provide a repair for missing delegation assets`);
			assert.match(message, /Global review assets stale: [1-9]\d* file\(s\).*\/gentle:install-review --force/,
				`${diagnostic} must provide a repair for missing review assets`);
			assert.doesNotMatch(message, /install-sdd --force/);
		}
		await commands.get("gentle:install-delegation").handler("", ctx);
		await commands.get("gentle:install-review").handler("", ctx);
		const manifest = JSON.parse(await readFile(join(process.env.GENTLE_PI_AGENT_HOME, "gentle-ai", "managed-assets.json"), "utf8"));
		for (const key of Object.keys(manifest.assets)) {
			await rm(join(process.env.GENTLE_PI_AGENT_HOME, key));
		}
		for (const diagnostic of ["gentle:status", "gentle:doctor"]) {
			await commands.get(diagnostic).handler("", ctx);
			const message = ctx.ui.notifications.at(-1).message;
			assert.match(message, /Global delegation assets stale: [1-9]\d* file\(s\).*\/gentle:install-delegation --force/);
			assert.match(message, /Global review assets stale: [1-9]\d* file\(s\).*\/gentle:install-review --force/);
			assert.doesNotMatch(message, /install-sdd --force|on demand/,
				"managed installation evidence must survive missing delegation and review files");
		}
	} finally {
		process.env.GENTLE_PI_AGENT_HOME = globalAgentHome;
		await rm(repairFixture, { recursive: true, force: true });
	}

	const staleAssetsCwd = await tempWorkspace();
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	try {
		process.env.GENTLE_PI_AGENT_HOME = join(staleAssetsCwd, "agent-home");
		process.env.HOME = staleAssetsCwd;
		process.env.USERPROFILE = staleAssetsCwd;
		const ctx = createCtx(staleAssetsCwd, true);
		await commands.get("gentle:doctor").handler("", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /el Gentleman doctor/);
		assert.match(ctx.ui.notifications.at(-1).message, /Sensitive-path guard active/);
		for (const diagnostic of ["gentle:status", "gentle:doctor"]) {
			await commands.get(diagnostic).handler("", ctx);
			const message = ctx.ui.notifications.at(-1).message;
			assert.match(message, /Organic Driven Development \(ODD\): active/);
			assert.doesNotMatch(message, /OpenSpec|openspec\/config\.yaml|SDD/);
		}
		pi.setActiveTools([{ name: "engram.mem_save" }]);
		await commands.get("gentle:doctor").handler("", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /Engram memory tools active/);
		pi.setActiveTools([{ name: "engram_mem_save" }]);
		await commands.get("gentle:doctor").handler("", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /Engram memory tools not active in this session/);
	} finally {
		pi.setActiveTools(["read", "bash", "edit", "write"]);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		await rm(staleAssetsCwd, { recursive: true, force: true });
	}

	const legacyModelsCwd = await tempWorkspace();
	try {
		await mkdir(join(legacyModelsCwd, ".pi", "agents"), { recursive: true });
		await mkdir(join(legacyModelsCwd, ".pi", "gentle-ai"), { recursive: true });
		await writeFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			`---\nname: sdd-apply\ndescription: Apply phase\n---\n\nbody\n`,
		);
		await writeFile(
			join(legacyModelsCwd, ".pi", "gentle-ai", "models.json"),
			JSON.stringify({ "sdd-apply": "legacy/provider-model" }, null, 2),
		);
		const legacyCtx = createCtx(legacyModelsCwd, true);
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const legacyAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(legacyAgent, /model: legacy\/provider-model/);
		await writeFile(
			globalModelsPath,
			JSON.stringify({ "sdd-apply": "global/provider-model" }, null, 2),
		);
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const globalWinsAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(globalWinsAgent, /model: global\/provider-model/);
		assert.doesNotMatch(globalWinsAgent, /model: legacy\/provider-model/);
		await writeFile(globalModelsPath, "{ invalid json");
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const invalidGlobalSkippedAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(invalidGlobalSkippedAgent, /model: global\/provider-model/);
		assert.doesNotMatch(invalidGlobalSkippedAgent, /model: legacy\/provider-model/);
		assert.equal(legacyCtx.ui.notifications.at(-1).level, "warning");
		assert.match(legacyCtx.ui.notifications.at(-1).message, /skipped model config/);
		let modelPanelOpened = false;
		legacyCtx.ui.custom = () => {
			modelPanelOpened = true;
			return Promise.resolve({ type: "save", config: {} });
		};
		await commands.get("gentle:models").handler("", legacyCtx);
		assert.equal(modelPanelOpened, false);
		assert.equal(await readFile(globalModelsPath, "utf8"), "{ invalid json");
		assert.equal(legacyCtx.ui.notifications.at(-1).level, "warning");
		assert.match(legacyCtx.ui.notifications.at(-1).message, /cannot open model config/);
		await writeFile(globalModelsPath, JSON.stringify({}, null, 2));
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const emptyGlobalPreservesAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(emptyGlobalPreservesAgent, /model: global\/provider-model/);
		const emptyGlobalPreservesProfiles = JSON.parse(
			await readFile(join(legacyModelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(
			emptyGlobalPreservesProfiles.model_profiles["sdd-apply"].model,
			"global/provider-model",
		);
		await writeFile(
			globalModelsPath,
			JSON.stringify({ "sdd-apply": { model: "bad\nmodel: injected" } }, null, 2),
		);
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const invalidEntryPreservesAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(invalidEntryPreservesAgent, /model: global\/provider-model/);
		const invalidEntryPreservesProfiles = JSON.parse(
			await readFile(join(legacyModelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(
			invalidEntryPreservesProfiles.model_profiles["sdd-apply"].model,
			"global/provider-model",
		);
		await writeFile(globalModelsPath, JSON.stringify({ "sdd-apply": {} }, null, 2));
		await hooks.get("session_start")[0]({ reason: "startup" }, legacyCtx);
		const explicitInheritClearsAgent = await readFile(
			join(legacyModelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.doesNotMatch(explicitInheritClearsAgent, /model:/);
		const explicitInheritClearsProfiles = JSON.parse(
			await readFile(join(legacyModelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(explicitInheritClearsProfiles.model_profiles, undefined);
	} finally {
		await rm(legacyModelsCwd, { recursive: true, force: true });
		await rm(globalModelsPath, { force: true });
	}

	const staleSettingsOnlyCwd = await tempWorkspace();
	try {
		await writeFile(
			globalSubagentsPath,
			JSON.stringify(
				{
					model_profiles: {
						worker: { model: "stale/model", effort: "high" },
					},
				},
				null,
				2,
			),
		);
		await writeFile(globalModelsPath, JSON.stringify({ worker: {} }, null, 2));
		await hooks.get("session_start")[0]({ reason: "startup" }, createCtx(staleSettingsOnlyCwd, true));
		const staleOnlyClearedProfiles = JSON.parse(
			await readFile(globalSubagentsPath, "utf8"),
		);
		assert.equal(staleOnlyClearedProfiles.model_profiles, undefined);
	} finally {
		await rm(staleSettingsOnlyCwd, { recursive: true, force: true });
		await rm(globalModelsPath, { force: true });
		await rm(globalSubagentsPath, { force: true });
	}

	const legacySettingsMigrationCwd = await tempWorkspace();
	try {
		await mkdir(join(legacySettingsMigrationCwd, ".pi", "subagents"), { recursive: true });
		await mkdir(join(globalAgentHome, "subagents"), { recursive: true });
		await writeFile(
			join(legacySettingsMigrationCwd, ".pi", "subagents", "local-worker.md"),
			`---\nname: local-worker\ndescription: Local worker\n---\n`,
		);
		await writeFile(
			join(legacySettingsMigrationCwd, ".pi", "subagents", "local-new.md"),
			`---\nname: local-new\ndescription: Local new worker\n---\n`,
		);
		await writeFile(
			join(globalAgentHome, "subagents", "global-worker.md"),
			`---\nname: global-worker\ndescription: Global worker\n---\n`,
		);
		await writeFile(
			join(globalAgentHome, "subagents", "global-new.md"),
			`---\nname: global-new\ndescription: Global new worker\n---\n`,
		);
		await writeFile(
			join(legacySettingsMigrationCwd, ".pi", "subagents.json"),
			JSON.stringify({ model_profiles: { "local-worker": { model: "existing/local", effort: "medium" } } }, null, 2),
		);
		await writeFile(
			globalSubagentsPath,
			JSON.stringify({ model_profiles: { "global-worker": { model: "existing/global", effort: "medium" } } }, null, 2),
		);
		await writeFile(
			join(legacySettingsMigrationCwd, ".pi", "settings.json"),
			JSON.stringify(
				{
					theme: "keep-me",
					subagents: {
						history: "keep-me-too",
						agentOverrides: {
							"local-worker": {},
							"local-new": { model: "local/new-model", thinking: "minimal" },
							"global-worker": {},
							"global-new": { model: "global/new-model", thinking: "xhigh" },
							"unknown-project": { model: "unknown/project-model", thinking: "low" },
						},
					},
				},
				null,
				2,
			),
		);
		await hooks.get("session_start")[0]({ reason: "startup" }, createCtx(legacySettingsMigrationCwd, true));
		const migratedProjectProfiles = JSON.parse(
			await readFile(join(legacySettingsMigrationCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(migratedProjectProfiles.model_profiles["local-worker"].model, "existing/local");
		assert.equal(migratedProjectProfiles.model_profiles["local-worker"].effort, "medium");
		assert.equal(migratedProjectProfiles.model_profiles["local-new"].model, "local/new-model");
		assert.equal(migratedProjectProfiles.model_profiles["local-new"].effort, "minimal");
		assert.equal(migratedProjectProfiles.model_profiles["unknown-project"].model, "unknown/project-model");
		assert.equal(migratedProjectProfiles.model_profiles["unknown-project"].effort, "low");
		const migratedGlobalProfiles = JSON.parse(await readFile(globalSubagentsPath, "utf8"));
		assert.equal(migratedGlobalProfiles.model_profiles["global-worker"].model, "existing/global");
		assert.equal(migratedGlobalProfiles.model_profiles["global-worker"].effort, "medium");
		assert.equal(migratedGlobalProfiles.model_profiles["global-new"].model, "global/new-model");
		assert.equal(migratedGlobalProfiles.model_profiles["global-new"].effort, "xhigh");
		const migratedSettings = JSON.parse(
			await readFile(join(legacySettingsMigrationCwd, ".pi", "settings.json"), "utf8"),
		);
		assert.equal(migratedSettings.theme, "keep-me");
		assert.equal(migratedSettings.subagents.history, "keep-me-too");
		assert.equal(migratedSettings.subagents.agentOverrides, undefined);
	} finally {
		await rm(legacySettingsMigrationCwd, { recursive: true, force: true });
		await rm(globalSubagentsPath, { force: true });
	}

	const invalidMigrationTargetCwd = await tempWorkspace();
	try {
		await mkdir(join(invalidMigrationTargetCwd, ".pi", "subagents"), { recursive: true });
		await writeFile(
			join(invalidMigrationTargetCwd, ".pi", "subagents", "local-bad.md"),
			`---\nname: local-bad\ndescription: Local bad target\n---\n`,
		);
		await mkdir(join(globalAgentHome, "subagents"), { recursive: true });
		await writeFile(
			join(globalAgentHome, "subagents", "global-bad.md"),
			`---\nname: global-bad\ndescription: Global bad target\n---\n`,
		);
		await writeFile(join(invalidMigrationTargetCwd, ".pi", "subagents.json"), "{ invalid json");
		await writeFile(globalSubagentsPath, "{ invalid global json");
		await writeFile(
			join(invalidMigrationTargetCwd, ".pi", "settings.json"),
			JSON.stringify({ subagents: { agentOverrides: { "local-bad": { model: "legacy/model", thinking: "low" }, "global-bad": { model: "legacy/global-model", thinking: "high" } } } }, null, 2),
		);
		await hooks.get("session_start")[0]({ reason: "startup" }, createCtx(invalidMigrationTargetCwd, true));
		assert.equal(await readFile(join(invalidMigrationTargetCwd, ".pi", "subagents.json"), "utf8"), "{ invalid json");
		assert.equal(await readFile(globalSubagentsPath, "utf8"), "{ invalid global json");
		const preservedLegacySettings = JSON.parse(
			await readFile(join(invalidMigrationTargetCwd, ".pi", "settings.json"), "utf8"),
		);
		assert.equal(preservedLegacySettings.subagents.agentOverrides["local-bad"].model, "legacy/model");
		assert.equal(preservedLegacySettings.subagents.agentOverrides["global-bad"].model, "legacy/global-model");
	} finally {
		await rm(invalidMigrationTargetCwd, { recursive: true, force: true });
		await rm(globalSubagentsPath, { force: true });
	}

	const modelsCwd = await tempWorkspace();
	try {
		await mkdir(join(modelsCwd, ".pi", "agents"), { recursive: true });
		await mkdir(join(modelsCwd, ".pi", "subagents"), { recursive: true });
		await mkdir(join(globalAgentHome, "subagents"), { recursive: true });
		await mkdir(
			join(modelsCwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"),
			{ recursive: true },
		);
		await mkdir(
			join(modelsCwd, ".pi", "npm", "node_modules", "pi-subagents", "agents"),
			{ recursive: true },
		);
		await writeFile(
			join(
				modelsCwd,
				".pi",
				"npm",
				"node_modules",
				"pi-subagents-j0k3r",
				"agents",
				"worker.md",
			),
			`---\nname: worker\ndescription: Builtin worker\n---\n`,
		);
		await writeFile(
			join(modelsCwd, ".pi", "agents", "worker.md"),
			`---\nname: worker\ndescription: Project worker\nmodel: existing/project-worker\nthinking: high\n---\n`,
		);
		await writeFile(
			join(modelsCwd, ".pi", "subagents", "worker.md"),
			`---\nname: worker\ndescription: Project subagents worker\nmodel: existing/project-subagent-worker\nthinking: medium\n---\n`,
		);
		await writeFile(
			join(
				modelsCwd,
				".pi",
				"npm",
				"node_modules",
				"pi-subagents",
				"agents",
				"researcher.md",
			),
			`---\nname: researcher\ndescription: Legacy builtin researcher\n---\n`,
		);
		await writeFile(
			join(modelsCwd, ".pi", "agents", "sdd-apply.md"),
			`---\nname: sdd-apply\ndescription: Apply phase\n---\n\nbody\n`,
		);
		await writeFile(
			join(modelsCwd, ".pi", "subagents", "project-special.md"),
			`---\nname: project-special\ndescription: Project subagent dir fixture\n---\n\nbody\n`,
		);
		await writeFile(
			join(globalAgentHome, "subagents", "global-special.md"),
			`---\nname: global-special\ndescription: Global subagent dir fixture\n---\n\nbody\n`,
		);
		for (let i = 0; i < 25; i++) {
			const name = `large-agent-${String(i).padStart(2, "0")}`;
			await writeFile(
				join(modelsCwd, ".pi", "agents", `${name}.md`),
				`---\nname: ${name}\ndescription: Scroll fixture\n---\n`,
			);
		}
		await writeFile(
			join(modelsCwd, ".pi", "agents", "escape-agent.md"),
			`---\nname: evil\u001b]52;c;Zm9v\u0007-agent\ndescription: Escape fixture\n---\n`,
		);
		await writeFile(
			join(modelsCwd, ".pi", "subagents.json"),
			JSON.stringify(
				{
					model_profiles: {
						worker: { model: "existing/model", effort: "high" },
					},
				},
				null,
				2,
			),
		);
		await writeFile(globalModelsPath, JSON.stringify({}, null, 2));
		await hooks.get("session_start")[0]({ reason: "startup" }, createCtx(modelsCwd, true));
		const preservedProfiles = JSON.parse(
			await readFile(join(modelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(
			preservedProfiles.model_profiles.worker.model,
			"existing/model",
		);
		assert.equal(preservedProfiles.model_profiles.worker.effort, "high");
		const preservedProjectWorker = await readFile(
			join(modelsCwd, ".pi", "agents", "worker.md"),
			"utf8",
		);
		assert.match(preservedProjectWorker, /model: existing\/project-worker/);
		assert.match(preservedProjectWorker, /thinking: high/);
		const preservedProjectSubagentWorker = await readFile(
			join(modelsCwd, ".pi", "subagents", "worker.md"),
			"utf8",
		);
		assert.match(preservedProjectSubagentWorker, /model: existing\/project-subagent-worker/);
		assert.match(preservedProjectSubagentWorker, /thinking: medium/);
		await writeFile(globalModelsPath, JSON.stringify({ worker: {} }, null, 2));
		await hooks.get("session_start")[0]({ reason: "startup" }, createCtx(modelsCwd, true));
		const clearedProfiles = JSON.parse(
			await readFile(join(modelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(clearedProfiles.model_profiles, undefined);
		const unchangedProjectWorker = await readFile(
			join(modelsCwd, ".pi", "agents", "worker.md"),
			"utf8",
		);
		assert.match(unchangedProjectWorker, /model: existing\/project-worker/);
		assert.match(unchangedProjectWorker, /thinking: high/);
		const clearedProjectSubagentWorker = await readFile(
			join(modelsCwd, ".pi", "subagents", "worker.md"),
			"utf8",
		);
		assert.doesNotMatch(clearedProjectSubagentWorker, /model:/);
		assert.doesNotMatch(clearedProjectSubagentWorker, /thinking:/);

		await writeFile(
			globalModelsPath,
			JSON.stringify({ "sdd-apply": "openai/gpt-5" }, null, 2),
		);

		const ctx = createCtx(modelsCwd, true);
		ctx.modelRegistry.getAvailable = async () => [
			{ provider: "safe", id: "model" },
			{ provider: "evil\u001b]52;c;Zm9v\u0007", id: "model" },
		];
		ctx.ui.custom = (factory) => {
			const panel = factory({ terminal: { rows: 24 } }, null, null, () => undefined);
			const initialLines = panel.render(120);
			const plainInitialLines = initialLines.map(stripAnsi);
			assert.ok(
				plainInitialLines[0].startsWith("╭") && plainInitialLines.at(-1).startsWith("╰"),
				"model panel should render inside a bordered card",
			);
			assert.ok(
				initialLines.length === 24,
				"model panel should fill the 24-row terminal like /gentle:profiles",
			);
			assert.ok(
				plainInitialLines.some((line) => /↓ \d+ more agent\(s\)/.test(line)),
				"long model agent list should render a down-scroll indicator",
			);
			assert.ok(
				plainInitialLines.some((line) => line.includes("Continue")),
				"long model agent list should keep Continue visible",
			);
			assert.doesNotMatch(
				initialLines.join("\n"),
				/\u001b\]|\u0007/,
				"model panel must strip unsafe terminal control sequences from agent labels",
			);
			assert.doesNotMatch(
				plainInitialLines.join("\n"),
				/\]52|\[31m/,
				"model panel must strip user-provided terminal escapes from labels",
			);
			for (let i = 0; i < 20; i++) panel.handleInput("j");
			const scrolledLines = panel.render(120);
			const plainScrolledLines = scrolledLines.map(stripAnsi);
			assert.ok(
				scrolledLines.length === 24,
				"scrolled model agent list should keep filling the terminal",
			);
			assert.ok(
				plainScrolledLines.some((line) => /↑ \d+ more agent\(s\)/.test(line)),
				"long model agent list should render an up-scroll indicator after navigation",
			);
			panel.handleInput("G");
			const bottomLines = panel.render(120);
			const plainBottomLines = bottomLines.map(stripAnsi);
			assert.ok(
				bottomLines.length === 24,
				"bottom model agent list should keep filling the terminal",
			);
			assert.ok(
				plainBottomLines.some((line) => line.includes("▸ ← Back")),
				"G should jump to the Back action",
			);
			return Promise.resolve({ type: "cancel" });
		};
		await commands.get("gentle:models").handler("", ctx);

		await hooks.get("session_start")[0]({ reason: "startup" }, ctx);
		const legacyAppliedAgent = await readFile(
			join(modelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(legacyAppliedAgent, /model: openai\/gpt-5/);
		assert.doesNotMatch(legacyAppliedAgent, /thinking:/);

		ctx.ui.custom = () =>
			Promise.resolve({
				type: "save",
				config: {
					"sdd-apply": { model: "openai/gpt-5", thinking: "high" },
					worker: { model: "openai/gpt-5-mini", thinking: "low" },
					researcher: { model: "openai/gpt-5-mini", thinking: "low" },
					"project-special": { model: "openai/gpt-5-mini", thinking: "low" },
					"global-special": { model: "openai/gpt-5-mini", thinking: "low" },
				},
			});
		await commands.get("gentle:models").handler("", ctx);
		assert.doesNotMatch(
			ctx.ui.notifications.at(-1).message,
			/[\u001b\u0007]/,
			"model save notification must strip terminal control sequences from discovered agent names",
		);

		const savedConfig = JSON.parse(
			await readFile(globalModelsPath, "utf8"),
		);
		assert.deepEqual(savedConfig["sdd-apply"], {
			model: "openai/gpt-5",
			thinking: "high",
		});
		assert.equal(
			existsSync(join(modelsCwd, ".pi", "gentle-ai", "models.json")),
			false,
			"/gentle:models must save model routing globally, not per project",
		);

		const applyAgent = await readFile(
			join(modelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(applyAgent, /model: openai\/gpt-5/);
		assert.match(applyAgent, /thinking: high/);

		const projectSubagents = JSON.parse(
			await readFile(join(modelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(
			projectSubagents.model_profiles["sdd-apply"].model,
			"openai/gpt-5",
		);
		assert.equal(projectSubagents.model_profiles["sdd-apply"].effort, "high");
		assert.equal(
			projectSubagents.model_profiles.worker.model,
			"openai/gpt-5-mini",
		);
		assert.equal(projectSubagents.model_profiles.worker.effort, "low");
		const routedProjectSubagentWorker = await readFile(
			join(modelsCwd, ".pi", "subagents", "worker.md"),
			"utf8",
		);
		assert.match(routedProjectSubagentWorker, /model: openai\/gpt-5-mini/);
		assert.match(routedProjectSubagentWorker, /thinking: low/);
		const shadowedProjectAgentWorker = await readFile(
			join(modelsCwd, ".pi", "agents", "worker.md"),
			"utf8",
		);
		assert.match(shadowedProjectAgentWorker, /model: existing\/project-worker/);
		assert.match(shadowedProjectAgentWorker, /thinking: high/);
		assert.equal(
			projectSubagents.model_profiles["project-special"].model,
			"openai/gpt-5-mini",
		);
		assert.equal(projectSubagents.model_profiles["project-special"].effort, "low");
		const globalSubagents = JSON.parse(await readFile(globalSubagentsPath, "utf8"));
		assert.equal(
			globalSubagents.model_profiles.researcher.model,
			"openai/gpt-5-mini",
		);
		assert.equal(globalSubagents.model_profiles.researcher.effort, "low");
		assert.equal(
			globalSubagents.model_profiles["global-special"].model,
			"openai/gpt-5-mini",
		);
		assert.equal(globalSubagents.model_profiles["global-special"].effort, "low");
		assert.equal(existsSync(join(modelsCwd, ".pi", "settings.json")), false);

		const kittyE = "\x1b[101u";
		assert.notEqual(kittyE, "e");
		assert.equal(matchesKey(kittyE, "e"), true);

		let customPanelCalls = 0;
		ctx.ui.input = async () => "custom/provider-model";
		ctx.ui.custom = (factory) =>
			new Promise((resolve) => {
				customPanelCalls += 1;
				const panel = factory(null, null, null, resolve);
				if (customPanelCalls === 1) {
					panel.handleInput(kittyE); // effort picker for all agents
					for (let i = 0; i < 4; i++) panel.handleInput("j"); // medium
					panel.handleInput("\r");
					panel.handleInput("c"); // custom model from the same unsaved draft
					return;
				}
				panel.handleInput("\u0013"); // ctrl+s saves the draft reopened after custom model input
			});
		await commands.get("gentle:models").handler("", ctx);

		const customSavedConfig = JSON.parse(
			await readFile(globalModelsPath, "utf8"),
		);
		assert.deepEqual(customSavedConfig["sdd-apply"], {
			model: "custom/provider-model",
			thinking: "medium",
		});

		let invalidCustomCalls = 0;
		ctx.ui.input = async () => "bad\nmodel: injected";
		ctx.ui.custom = (factory) =>
			new Promise((resolve) => {
				invalidCustomCalls += 1;
				const panel = factory(null, null, null, resolve);
				if (invalidCustomCalls === 1) {
					panel.handleInput("c");
					return;
				}
				panel.handleInput("\u001b");
			});
		await commands.get("gentle:models").handler("", ctx);
		assert.match(
			ctx.ui.notifications.at(-1).message,
			/Custom model id must be a single-line/,
		);
		const rejectedCustomConfig = JSON.parse(
			await readFile(globalModelsPath, "utf8"),
		);
		assert.deepEqual(rejectedCustomConfig["sdd-apply"], {
			model: "custom/provider-model",
			thinking: "medium",
		});

		let exportPanelCalls = 0;
		ctx.ui.custom = () => {
			exportPanelCalls += 1;
			return Promise.resolve(exportPanelCalls === 1 ? { type: "export", config: {} } : { type: "cancel" });
		};
		await commands.get("gentle:models").handler("", ctx);
		const exported = JSON.parse(await readFile(join(globalConfigHome, "models.export.json"), "utf8"));
		assert.equal(exported.kind, "gentle-pi.agent_model_routing");
		assert.equal(exported.version, 1);
		assert.deepEqual(exported.agents["sdd-apply"], {
			model: "custom/provider-model",
			thinking: "medium",
		});

		await writeFile(
			join(globalConfigHome, "models.export.json"),
			JSON.stringify({
				kind: "gentle-pi.agent_model_routing",
				version: 1,
				agents: { "sdd-apply": { model: "restore/provider", thinking: "high" } },
			}, null, 2),
		);
		let restorePanelCalls = 0;
		ctx.ui.confirm = async () => true;
		ctx.ui.custom = () => {
			restorePanelCalls += 1;
			return Promise.resolve(restorePanelCalls === 1 ? { type: "restore", config: {} } : { type: "cancel" });
		};
		await commands.get("gentle:models").handler("", ctx);
		const restoredConfig = JSON.parse(await readFile(globalModelsPath, "utf8"));
		assert.deepEqual(restoredConfig["sdd-apply"], {
			model: "restore/provider",
			thinking: "high",
		});
		const restoredAgent = await readFile(join(modelsCwd, ".pi", "agents", "sdd-apply.md"), "utf8");
		assert.match(restoredAgent, /model: restore\/provider/);
		assert.match(restoredAgent, /thinking: high/);

		// issue #286: `thinking: "max"` must survive save normalization and
		// reach both subagents.json (effort) and agent frontmatter (thinking).
		ctx.ui.custom = () =>
			Promise.resolve({
				type: "save",
				config: { "sdd-apply": { model: "openai/gpt-5", thinking: "max" } },
			});
		await commands.get("gentle:models").handler("", ctx);
		const maxSavedConfig = JSON.parse(await readFile(globalModelsPath, "utf8"));
		assert.equal(maxSavedConfig["sdd-apply"].thinking, "max");
		const maxSubagents = JSON.parse(
			await readFile(join(modelsCwd, ".pi", "subagents.json"), "utf8"),
		);
		assert.equal(maxSubagents.model_profiles["sdd-apply"].effort, "max");
		const maxApplyAgent = await readFile(
			join(modelsCwd, ".pi", "agents", "sdd-apply.md"),
			"utf8",
		);
		assert.match(maxApplyAgent, /thinking: max/);

		// issue #286: effort picker must offer `max` after `xhigh` and save it.
		let maxPickerCalls = 0;
		ctx.ui.custom = (factory) =>
			new Promise((resolve) => {
				maxPickerCalls += 1;
				const panel = factory(null, null, null, resolve);
				if (maxPickerCalls === 1) {
					panel.handleInput(kittyE); // open effort picker (set-all row)
					for (let i = 0; i < 7; i++) panel.handleInput("j"); // max
					panel.handleInput("\r");
					panel.handleInput("\u0013"); // ctrl+s saves the draft
					return;
				}
			});
		await commands.get("gentle:models").handler("", ctx);
		const pickerMaxConfig = JSON.parse(await readFile(globalModelsPath, "utf8"));
		assert.equal(pickerMaxConfig["sdd-apply"].thinking, "max");
	} finally {
		await rm(modelsCwd, { recursive: true, force: true });
		await rm(globalModelsPath, { force: true });
		await rm(globalSubagentsPath, { force: true });
	}

	const registryCwd = await tempWorkspace();
	try {
		const ctx = createCtx(registryCwd, true);
		await commands.get("skill-registry:refresh").handler("", ctx);
		assert.match(ctx.ui.notifications.at(-1).message, /Skill registry:/);
	} finally {
		await rm(registryCwd, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
