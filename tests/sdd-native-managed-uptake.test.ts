import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentRunner, type ChildLike, type TaskRequest } from "../lib/agents-runner.ts";
import { TaskStore } from "../lib/agents-protocol.ts";
import { parseAgentDefinition } from "../lib/agents-config.ts";
import { Type } from "typebox";
import { RESEARCH_CHILD_TOOLS_ENV } from "../lib/sdd-research-capabilities.ts";
import { admitManagedRemediation } from "../extensions/gentle-agents.ts";

import { NativeReviewCliV216, createNodeExecFileAdapter } from "../lib/native-review-cli.ts";

const self = fileURLToPath(import.meta.url);
const source = dirname(dirname(self));
const binary = process.env.SDD_TEST_PRODUCER;
const childRole = process.env.UPTAKE_CHILD === "1";
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

// The model is a finite local script, not a provider call or an actor verdict.
// SDK/extension hooks, tools, session persistence, RPC and AgentRunner are real.
export async function launch(): Promise<void> {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const ai = await import("@earendil-works/pi-ai");
	const args = process.argv.slice(1), value = (flag: string) => args[args.indexOf(flag) + 1];
	const paths = args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : []);
	const home = process.env.GENTLE_PI_AGENT_HOME!;
	const runtimeModels = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: join(home, "models.json"), modelsStorePath: join(home, "models-store.json"), allowModelNetwork: false });
	const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	let turn = 0;
	const script = json(process.env.UPTAKE_SCRIPT!);
	const runtime = await sdk.createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await sdk.createAgentSessionServices({ cwd, agentDir: home, modelRuntime: runtimeModels, settingsManager: settings, resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: paths, appendSystemPrompt: [value("--append-system-prompt")],
			extensionFactories: [pi => {
				pi.registerProvider("uptake-control", { baseUrl: "http://127.0.0.1:1", apiKey: "offline-control", api: "openai-completions", models: [{ id: "control", name: "control", reasoning: false, input: ["text"], cost, contextWindow: 200000, maxTokens: 1000 }],
					streamSimple: (model, context) => {
						writeFileSync(join(process.env.UPTAKE_RUN!, `input-${turn}.json`), JSON.stringify(context));
						const calls = script[turn++] ?? [];
						const stopReason = calls.length ? "toolUse" as const : "stop" as const;
						const message: AssistantMessage = { role: "assistant", content: calls.length ? calls.map(([name, arguments_], i) => ({ type: "toolCall", id: `${turn}-${i}`, name, arguments: arguments_ })) : [{ type: "text", text: "Controlled script exhausted; not acceptance." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost }, stopReason, timestamp: Date.now() };
						const stream = ai.createAssistantMessageEventStream();
						queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: stopReason, message }); stream.end(message); });
						return stream;
					},
				});
			}],
		} });
		assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
		if (args.includes("--gentle-sdd-change")) services.resourceLoader.getExtensions().runtime.flagValues.set("gentle-sdd-change", value("--gentle-sdd-change"));
		return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: runtimeModels.getModel("uptake-control", "control"), tools: value("--tools").split(",") })), services, diagnostics: services.diagnostics };
	}, { cwd: process.cwd(), agentDir: home, sessionManager: sdk.SessionManager.create(process.cwd(), value("--session-dir")) });
	await sdk.runRpcMode(runtime);
}

// A local documentation capability with real extension provenance and an observable effect.
export default function controlledDocumentation(pi) {
	pi.registerTool({ name: "fetch_content", label: "Controlled documentation", description: "Read the isolated documentation fixture only", parameters: Type.Object({}), execute: async () => {
		appendFileSync(join(process.env.UPTAKE_RUN!, "fetch-calls"), "called\n");
		return { content: [{ type: "text", text: "Independent controlled documentation bytes" }], details: {} };
	} });
	pi.on("session_start", (_event, ctx) => {
		writeFileSync(join(process.env.UPTAKE_RUN!, "inventory.json"), JSON.stringify(pi.getAllTools()));
		writeFileSync(join(process.env.UPTAKE_RUN!, "startup.json"), JSON.stringify({ cwd: ctx.cwd, flag: pi.getFlag("gentle-sdd-change"), grant: process.env.GENTLE_PI_SDD_REMEDIATION_PLAN }));
	});
}

if (!childRole) test("installed AI producer → fixed Pi extensions → managed child input and tools", { skip: !binary, timeout: 90000 }, async t => {
	assert.ok(binary && resolve(binary) === binary && existsSync(binary), "Explicit independently built AI binary required");
	const producerIdentity = json(`${binary}.identity.json`);
	assert.equal(producerIdentity.sourceRevision, "01e6fac15df169e8993e02549b9edcbd01abc0ee");
	assert.equal(producerIdentity.sha256, digest(readFileSync(binary)), "Producer bytes must match the independent build record");
	const root = mkdtempSync(join(tmpdir(), "pi-native-uptake-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace"), home = join(root, "profile"), pkg = join(root, "pi");
	const change = join(cwd, "openspec", "changes", "uptake");
	mkdirSync(join(change, "specs", "sample"), { recursive: true });
	mkdirSync(home); mkdirSync(pkg);
	execFileSync("git", ["init", "--quiet", cwd]);
	for (const name of ["assets", "extensions", "lib", "runtime", "contracts", "scripts", "package.json", "tests"]) cpSync(join(source, name), join(pkg, name), { recursive: true });
	symlinkSync(join(source, "node_modules"), join(pkg, "node_modules"), "dir");
	execFileSync(process.execPath, ["scripts/build-runtime-modules.mjs", "--write"], { cwd: pkg });
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = home;
	try {
		const { installPackageAssets } = await import(join(pkg, "lib", "sdd-preflight.ts"));
		installPackageAssets(cwd, false, ["sdd"]);
	} finally {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME; else process.env.GENTLE_PI_AGENT_HOME = previousHome;
	}
	const manifest = json(join(home, "gentle-ai", "managed-assets.json"));
	const actor = (phase: string) => {
		const path = join(home, "agents", `sdd-${phase}.md`);
		const bytes = readFileSync(path, "utf8");
		assert.equal(digest(bytes), manifest.assets[`agents/sdd-${phase}.md`]);
		assert.equal(bytes, readFileSync(join(pkg, "assets", "agents", `sdd-${phase}.md`), "utf8"));
		const definition = parseAgentDefinition(bytes, path, "global");
		if (!("instructions" in definition)) throw new Error(`Invalid fixture agent: ${phase}`);
		return definition;
	};
	for (const phase of ["apply", "research", "remediate"]) assert.equal(actor(phase).name, `sdd-${phase}`);
	writeFileSync(join(change, "proposal.md"), "Native uptake controlled fixture\n");
	writeFileSync(join(change, "design.md"), "Read-only controlled fixture\n");
	writeFileSync(join(change, "specs", "sample", "spec.md"), "### Requirement: Controlled boundary\n#### Scenario: Read\n");
	writeFileSync(join(change, "tasks.md"), "- [ ] Read controlled fixture\n");
	const native = new NativeReviewCliV216(createNodeExecFileAdapter(), binary);
	const status = await native.sddStatus({ changeName: "uptake", workspaceRoot: cwd });
	assert.equal(status.schemaName, "gentle-ai.sdd-status"); assert.equal(status.schemaVersion, 2);
	assert.equal(status.nextRecommended, "apply");
	await t.test("installed host suppresses continuation for read-only and excluded-marker answers", async () => {
		const { createGentleAiExtension } = await import(join(pkg, "extensions", "gentle-ai.ts"));
		for (const answer of [false, undefined]) {
			const verbs: string[] = [], confirmations: string[] = [], notices: string[] = [];
			const commands = new Map();
			const adapter = createNodeExecFileAdapter();
			const client = new NativeReviewCliV216(request => { verbs.push(request.arguments[0]); return adapter(request); }, binary);
			createGentleAiExtension({ nativeReviewCli: client, processEnv: {} })({ on() {}, events: { emit() {} }, registerTool() {}, registerCommand: (name, command) => commands.set(name, command.handler), sendUserMessage: () => assert.fail("Unexpected launch"), sendMessage: () => assert.fail("Unexpected launch") });
			const context = { cwd, hasUI: true, ui: { notify: text => notices.push(text), confirm: async (_title, text) => { confirmations.push(text); return answer; } } };
			await commands.get("gentle-sdd-status")("uptake --json", context);
			assert.deepEqual(JSON.parse(notices[0]), status);
			assert.equal(confirmations.length, 0);
			await commands.get("gentle-sdd-continue")("uptake --json", context);
			assert.deepEqual(verbs, ["sdd-status", "sdd-status"]);
			assert.equal(confirmations.length, 1);
			assert.ok(confirmations[0].includes(join(change, ".gentle-ai-instance")));
			assert.equal(existsSync(join(change, ".gentle-ai-instance")), false);
		}
	});
	const fixed = [join(pkg, "extensions", "gentle-ai.ts"), join(pkg, "extensions", "gentle-agents.ts")];
	const docExtension = join(pkg, "tests", "sdd-native-managed-uptake.test.ts");
	const selection = { documentation: { tools: ["fetch_content"], extensions: { fetch_content: docExtension } } };
	async function run(id: string, phase: "apply" | "research" | "remediate", script: unknown[], options: Record<string, any> = {}) {
		const directory = join(root, id); mkdirSync(directory);
		const scriptPath = join(directory, "script.json"); writeFileSync(scriptPath, JSON.stringify(script));
		const events: any[] = [], launches: any[] = [];
		const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 15000 }, {
			pi: { command: process.execPath, args: ["--experimental-strip-types", "--input-type=module", "--eval", `import(${JSON.stringify(docExtension)}).then(m=>m.launch())`, "--"] },
			now: Date.now, schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
			spawn: (command, args, spawnOptions): ChildLike => {
				launches.push({ args, cwd: spawnOptions.cwd });
				const child = spawn(command, args, { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
				let buffer = "";
				child.stdout.on("data", data => { buffer += data; const lines = buffer.split("\n"); buffer = lines.pop()!; for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* Diagnostics are not RPC evidence. */ } } });
				child.stderr.on("data", data => appendFileSync(join(directory, "stderr.log"), data));
				return child as unknown as ChildLike;
			},
		}, { askUser: async () => ({ cancelled: true }) });
		try {
			const task = runner.run({ agent: { ...actor(phase), ...(phase === "research" ? { tools: ["read", "write", "fetch_content"] } : {}) }, prompt: "Controlled boundary probe only; no implementation or acceptance.", label: undefined, context: phase === "research" ? JSON.stringify(status) : undefined, mode: "task", cwd, parentSessionId: "uptake", model: undefined, thinking: undefined, sessionDir: join(directory, "sessions"), resumeSessionPath: undefined, env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: home, GENTLE_PI_AGENT_HOME: home, PI_OFFLINE: "1", UPTAKE_CHILD: "1", UPTAKE_RUN: directory, UPTAKE_SCRIPT: scriptPath, GENTLE_PI_GENTLE_AI_DEV_BINARY: binary, ...(phase === "research" ? { [RESEARCH_CHILD_TOOLS_ENV]: JSON.stringify(["read", "write", "fetch_content"]) } : {}), ...options.env }, extensionPaths: [...fixed, ...(options.absentTool ? [] : [docExtension])], researchSelection: selection, sddRemediation: options.remediation, ...(phase === "research" ? {} : { sddChange: { phase, changeName: "uptake", workspaceRoot: cwd, ...options.selection } }) });
			const result = await runner.waitFor(task.id);
			assert.equal(launches.length, 1);
			assert.deepEqual(launches[0].args.flatMap((arg, i, args) => arg === "--extension" ? [args[i + 1]] : []), [...fixed, ...(options.absentTool ? [] : [docExtension])]);
			writeFileSync(join(directory, "events.json"), JSON.stringify(events));
			writeFileSync(join(directory, "launch.json"), JSON.stringify(launches));
			if (process.env.UPTAKE_EVIDENCE_DIR) cpSync(directory, join(process.env.UPTAKE_EVIDENCE_DIR, id), { recursive: true });
			return { result, events, directory, input: existsSync(join(directory, "input-0.json")) ? json(join(directory, "input-0.json")) : undefined };
		} finally { runner.cancelAll(); }
	}
	const ended = (run, name: string) => run.events.filter(event => event.type === "tool_execution_end" && event.toolName === name);
	await t.test("native apply context and installed actor reach actual model/tool input", async () => {
		const observed = await run("apply", "apply", [[["read", { path: join(change, "proposal.md") }]]]);
		assert.equal(observed.result.status, "completed", JSON.stringify(observed.result));
		assert.ok(observed.input.systemPrompt.includes(JSON.stringify(status, null, 2)));
		assert.ok(observed.input.systemPrompt.includes(actor("apply").instructions));
		assert.equal(ended(observed, "read").length, 1); assert.equal(ended(observed, "read")[0].isError, false);
		assert.match(JSON.stringify(ended(observed, "read")[0].result), /Native uptake controlled fixture/);
	});
	const path = join(change, "research.md");
	for (const absentTool of [true, false]) await t.test(`output-only research provisioning absent=${absentTool} preserves parent ownership`, async () => {
		const content = "# Partial research\nExternal questions remain open.\n";
		const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		const observed = await run(`research-${absentTool}`, "research", [[["fetch_content", {}]], [["read", { path }]], [["write", { path, content }]]], { absentTool });
		assert.equal(observed.result.status, "completed", JSON.stringify(observed.result));
		assert.equal(ended(observed, "fetch_content")[0].isError, absentTool);
		assert.equal(existsSync(join(observed.directory, "fetch-calls")), !absentTool);
		for (const tool of ["read", "write"]) assert.equal(ended(observed, tool)[0].isError, true);
		assert.equal(existsSync(path) ? readFileSync(path, "utf8") : undefined, before);
		// Scripted parent persistence/readback, not autonomous model proof.
		writeFileSync(path, content);
		assert.equal(readFileSync(path, "utf8"), content);
		if (!absentTool) assert.equal(json(join(observed.directory, "inventory.json")).find(tool => tool.name === "fetch_content").sourceInfo.path, docExtension);
	});

	await t.test("wrong native worktree refuses actual child tool work", async () => {
		const observed = await run("wrong-worktree", "apply", [[["read", { path: join(change, "proposal.md") }]]], { selection: { workspaceRoot: root } });
		assert.match(observed.input.systemPrompt, /SDD selection blocked/);
		assert.equal(ended(observed, "read").length, 1);
		assert.equal(ended(observed, "read")[0].isError, true);
	});
	await t.test("missing installed typed remediation asset refuses before native acquire", async () => {
		const definition = actor("remediate");
		const bytes = readFileSync(definition.filePath);
		rmSync(definition.filePath);
		let acquires = 0;
		try {
			await assert.rejects(admitManagedRemediation({ agent: definition, cwd, sddChange: { phase: "remediate", changeName: "uptake", workspaceRoot: cwd, failedEvidenceRevision: `sha256:${"a".repeat(64)}` } } as unknown as TaskRequest, {}, { ...native, sddAttemptAcquire: async () => { acquires++; throw new Error("Must not acquire"); } } as unknown as import("../lib/native-review-cli.ts").NativeReviewCli), /unsupported/i);
			assert.equal(acquires, 0);
		} finally { writeFileSync(definition.filePath, bytes); }
	});
	await t.test("native failed-evidence identity reaches the installed distinct remediation child; stale binding refuses", async () => {
		writeFileSync(join(change, "tasks.md"), "- [x] Controlled fixture complete\n");
		// A declared failing verification fixture, never a passing evidence claim.
		const failed = `sha256:${"a".repeat(64)}`;
		writeFileSync(join(change, "verify-report.md"), ["```yaml", "schema: gentle-ai.verify-result/v1", `evidence_revision: ${failed}`, "verdict: fail", "blockers: 1", "critical_findings: 0", "requirements: 1/1", "scenarios: 1/1", "test_command: false", "test_exit_code: 1", `test_output_hash: sha256:${digest("")}`, "build_command: true", "build_exit_code: 0", `build_output_hash: sha256:${digest("")}`, "```"].join("\n"));
		const remediationStatus = await native.sddStatus({ changeName: "uptake", workspaceRoot: cwd });
		assert.equal(remediationStatus.nextRecommended, "remediate");
		assert.equal(remediationStatus.remediationState.failedEvidenceRevision, failed);
		const plan = { cwd, editPaths: [join(change, "proposal.md")], commands: ["true"], runtimeHarness: { naReason: "No correction harness because this controlled boundary performs no source correction or acceptance." }, rollback: { boundary: "Remove the isolated controlled fixture only", command: "true" } };
		const remediation = { failedEvidenceRevision: failed, plan, scope: { cwd, commands: ["true", "true"], editPaths: [join(change, "proposal.md")], allowedEditRoots: [cwd] }, observations: [], pending: {}, invalid: false };
		const observed = await run("remediate", "remediate", [[["read", { path: join(change, "proposal.md") }]]], { selection: { failedEvidenceRevision: failed }, remediation });
		assert.ok(observed.input.systemPrompt.includes(JSON.stringify(remediationStatus, null, 2)), observed.input.systemPrompt.slice(-9000));
		assert.ok(observed.input.systemPrompt.includes(actor("remediate").instructions));
		assert.equal(ended(observed, "read")[0].isError, false, JSON.stringify({ ended: ended(observed, "read"), startup: json(join(observed.directory, "startup.json")) }));
		const stale = await run("stale-remediation", "remediate", [[["read", { path: join(change, "proposal.md") }]]], { selection: { failedEvidenceRevision: `sha256:${"b".repeat(64)}` }, remediation });
		assert.match(stale.input.systemPrompt, /Stale remediation selection/);
		assert.equal(ended(stale, "read")[0].isError, true);
	});

	const buildFiles: Record<string, string> = {};
	const inventory = (directory: string) => {
		for (const entry of readdirSync(join(pkg, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const name = join(directory, entry.name);
			if (entry.isDirectory()) inventory(name); else if (entry.isFile()) buildFiles[name] = digest(readFileSync(join(pkg, name)));
		}
	};
	for (const directory of ["assets", "extensions", "lib", "runtime", "contracts", "scripts"]) inventory(directory);
	buildFiles["package.json"] = digest(readFileSync(join(pkg, "package.json")));
	const tuple = { aiSource: producerIdentity.sourceRevision, aiBinary: producerIdentity.sha256, piHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), piBuild: digest(JSON.stringify(buildFiles)), buildFiles, manifest, contract: "gentle-ai.sdd-status/v2" };
	if (process.env.UPTAKE_EVIDENCE_DIR) {
		writeFileSync(join(process.env.UPTAKE_EVIDENCE_DIR, "tuple.json"), JSON.stringify(tuple, null, 2));
		cpSync(join(home, "agents"), join(process.env.UPTAKE_EVIDENCE_DIR, "installed-agents"), { recursive: true });
	}
	t.diagnostic(JSON.stringify({ aiSource: tuple.aiSource, aiBinary: tuple.aiBinary, piHead: tuple.piHead, piBuild: tuple.piBuild, contract: tuple.contract }));

});
