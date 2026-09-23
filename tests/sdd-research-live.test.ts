import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentRunner } from "../lib/agents-runner.ts";
import { TaskStore } from "../lib/agents-protocol.ts";
import { researchAgent, RESEARCH_CHILD_TOOLS_ENV } from "../lib/sdd-research-capabilities.ts";

// Runtime-owned authentication references the existing profile; no credentials
// are copied, extracted or symlinked. Only native OAuth refresh may persist there.
// All resource discovery, settings, model caches and sessions remain isolated.
const enabled = process.env.GENTLE_PI_LIVE_RESEARCH_TEST === "1";
const role = process.env.GENTLE_PI_LIVE_RESEARCH_ROLE;
const tools = ["web_search", "source_check", "fetch_content", "get_search_content"];
const candidate = fileURLToPath(new URL("../extensions/gentle-agents.ts", import.meta.url));
const self = fileURLToPath(import.meta.url);
const question = `Generic runtime capability probe, not an SDD workflow or proposal admission. Artifact store: none. Do not write files or launch agents. Use ALL FOUR tools web_search, source_check, fetch_content and get_search_content to answer: What does the Node.js fs module provide? Set web_search workflow to none. Search only public Node.js documentation (site:nodejs.org). Check and retrieve the original public documentation. Return ONLY JSON with source_url (an https://nodejs.org/ URL) and passage (a verbatim 40-300 character passage from retrieved documentation). Do not use remembered text as evidence. If any tool fails, report inability rather than inventing evidence.`;

function record(value: Record<string, unknown>): void {
	appendFileSync(process.env.GENTLE_PI_LIVE_RESEARCH_TRACE!, `${JSON.stringify({ role, ...value })}\n`, { mode: 0o600 });
}

// Only the eval entry invokes launchRpc; loading this file as an extension does
// not construct another SDK runtime or extension registry.
const launcher = { command: process.execPath, args: ["--experimental-strip-types", "--input-type=module", "--eval", `import(${JSON.stringify(import.meta.url)}).then(m => m.launchRpc())`, "--"] };

export async function launchRpc(): Promise<void> {
	let stage = "arguments";
	try {
		assert.ok(enabled && (role === "host" || role === "child"));
		const args = process.argv.slice(1), values = new Map<string, string>();
		for (let i = 0; i < args.length; i += 2) {
			assert.ok(["--mode", "--session-dir", "--tools", "--append-system-prompt"].includes(args[i]) && args[i + 1] !== undefined, "Unsupported runner argument");
			assert.ok(!values.has(args[i]), "Duplicate runner argument");
			values.set(args[i], args[i + 1]);
		}
		assert.equal(values.get("--mode"), "rpc");
		stage = "sdk_load";
		const { ModelRuntime, SettingsManager, SessionManager, createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, runRpcMode } = await import("@earendil-works/pi-coding-agent");
		const agentDir = process.env.PI_CODING_AGENT_DIR!, authPath = process.env.GENTLE_PI_LIVE_RESEARCH_AUTH_PATH!;
		assert.ok(isAbsolute(authPath) && existsSync(authPath), "Existing runtime auth storage required");
		stage = "native_auth_and_model_catalog";
		const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, signal: AbortSignal.timeout(30_000) });
		const model = modelRuntime.getModel(process.env.PI_PROVIDER!, process.env.PI_MODEL!);
		assert.ok(model, "Inherited model unavailable; no fallback permitted");
		stage = "single_extension_loader";
		const runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
			const settingsManager = SettingsManager.create(cwd, agentDir);
			settingsManager.applyOverrides({ retry: { enabled: false }, compaction: { enabled: false } });
			const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager, resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: [process.env.GENTLE_PI_LIVE_RESEARCH_WEB_EXTENSION!, candidate, self],
				appendSystemPrompt: values.has("--append-system-prompt") ? [values.get("--append-system-prompt")!] : [],
			} });
			assert.equal(services.resourceLoader.getExtensions().errors.length, 0, "Extension load failed");
			assert.ok(!services.diagnostics.some(item => item.type === "error"), "Runtime service diagnostics failed");
			return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model,
				thinkingLevel: settingsManager.getDefaultThinkingLevel(), tools: values.get("--tools")!.split(","),
			})), services, diagnostics: services.diagnostics };
		}, { cwd: process.cwd(), agentDir, sessionManager: SessionManager.create(process.cwd(), values.get("--session-dir")) });
		stage = "native_rpc";
		runtime.session.subscribe(event => {
			if (role === "child" && event.type === "agent_settled") record({ event: "child_settled" });
		});
		await runRpcMode(runtime);
	} catch (error) {
		// Never serialize provider exceptions: they may contain credentials or bodies.
		record({ event: "launcher_failed", stage, assertionFailed: error instanceof assert.AssertionError });
		process.exitCode = 1;
	}
}

// The launcher-owned ResourceLoader registers the real installed extensions once.
export default function liveProbe(pi: ExtensionAPI): void {
	if (!enabled || (role !== "host" && role !== "child")) return;
	const results: string[] = [];
	const completed = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		const loaded = pi.getAllTools().filter(tool => tools.includes(tool.name));
		record({ event: "loaded", candidate, candidateHash: createHash("sha256").update(readFileSync(candidate)).digest("hex"), tools: loaded.map(tool => ({ name: tool.name, source: tool.sourceInfo?.path })), active: pi.getActiveTools().filter(name => tools.includes(name)), modelMatches: ctx.model?.id === process.env.PI_MODEL && ctx.model?.provider === process.env.PI_PROVIDER });
	});
	if (role === "child") {
		pi.on("before_agent_start", event => {
			// One block comes from researchAgent; the second is injected by the
			// candidate extension's real child-local capability hook loaded first.
			record({ event: "candidate_hook", observed: (event.systemPrompt.match(/## SDD Research Capabilities/g) ?? []).length >= 2 });
		});
		pi.on("tool_call", event => {
			if (!tools.includes(event.toolName)) return { block: true, reason: "Public web probe permits only its four evidence tools." };
			if (event.toolName === "web_search" && event.input.workflow !== "none") return { block: true, reason: "Public probe requires web_search workflow none." };
			const urls = JSON.stringify(event.input).match(/https?:\/\/[^\s"<>\\]+/g) ?? [];
			if (urls.some(url => { try { const parsed = new URL(url); return parsed.protocol !== "https:" || parsed.hostname !== "nodejs.org"; } catch { return true; } })) {
				return { block: true, reason: "This probe retrieves only public nodejs.org URLs." };
			}
		});
		pi.on("tool_result", event => {
			record({ event: "tool_result", tool: event.toolName, success: !event.isError });
			if (!event.isError && tools.includes(event.toolName)) {
				completed.add(event.toolName);
				if (event.toolName === "fetch_content" || event.toolName === "get_search_content") {
					results.push(event.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
				}
			}
		});
		pi.on("agent_end", event => {
			const last = [...event.messages].reverse().find(message => message.role === "assistant");
			const text = last?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
			try {
				const parsed = JSON.parse(text);
				const url = new URL(parsed.source_url);
				const passage = parsed.passage;
				const valid = url.protocol === "https:" && url.hostname === "nodejs.org" && typeof passage === "string" && passage.length >= 40 && passage.length <= 300 && results.some(result => result.includes(passage) && result.includes(parsed.source_url)) && tools.every(name => completed.has(name));
				// Persist only a passage proven present alongside the public citation,
				// never raw provider errors, tool arguments or arbitrary model output.
				record({ event: "evidence", valid, ...(valid ? { source_url: parsed.source_url, passage } : {}) });
			} catch { record({ event: "evidence", valid: false }); }
		});
		return;
	}
	pi.registerCommand("gentle-live-research-probe", {
		description: "Run the opt-in generic public web capability integration probe.",
		handler: async (_args, ctx) => {
			if (ctx.model?.id !== process.env.PI_MODEL || ctx.model?.provider !== process.env.PI_PROVIDER) {
				record({ event: "prerequisite_failed", reason: "inherited model is unavailable in the isolated profile" });
				ctx.shutdown(); return;
			}
			const selection = { "open-web": { tools, extensions: Object.fromEntries(tools.map(name => [name, process.env.GENTLE_PI_LIVE_RESEARCH_WEB_EXTENSION!])) } };
			const mapped = researchAgent({ name: "runtime-research-probe", description: "Public-only generic capability probe", tools, instructions: question } as never, pi, selection);
			if (mapped.capabilities["open-web"].status !== "available") {
				record({ event: "prerequisite_failed", reason: "four active approved installed web tools required" });
				ctx.shutdown(); return;
			}
			record({ event: "grants", capabilities: mapped.capabilities, childTools: mapped.agent.tools });
			const runner = new AgentRunner(new TaskStore(), { maxConcurrency: 1, stallTimeoutMs: 120_000 }, {
				pi: launcher,
				now: Date.now,
				schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
				spawn: (command, args, options) => {
					const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
					record({ event: "spawn", pid: child.pid, candidate });
					child.on("exit", (code, signal) => record({ event: "child_exit", pid: child.pid, code, signal }));
					return child;
				},
			}, { askUser: async () => ({ cancelled: true }) });
			const timer = setTimeout(() => runner.cancelAll(), 145_000);
			try {
				const task = runner.run({ agent: mapped.agent, prompt: question, label: "Public Node.js docs probe", context: undefined, mode: "task", cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(), model: undefined, thinking: undefined, sessionDir: join(ctx.cwd, "sessions"), resumeSessionPath: undefined, env: { ...process.env, GENTLE_PI_LIVE_RESEARCH_ROLE: "child", [RESEARCH_CHILD_TOOLS_ENV]: JSON.stringify(mapped.agent.tools), GENTLE_PI_RESEARCH_SELECTION: JSON.stringify(selection) } });
				const outcome = await runner.waitFor(task.id);
				record({ event: "runner_result", status: outcome.status });
			} finally { clearTimeout(timer); runner.cancelAll(); ctx.shutdown(); }
		},
	});
}

if (role === undefined) test("LIVE installed web tools execute through the candidate research runner", { skip: !enabled && "opt in with GENTLE_PI_LIVE_RESEARCH_TEST=1; no live execution performed", timeout: 180_000 }, async t => {
	const web = process.env.GENTLE_PI_LIVE_RESEARCH_WEB_EXTENSION;
	assert.ok(web && isAbsolute(web) && existsSync(web), "Prerequisite: GENTLE_PI_LIVE_RESEARCH_WEB_EXTENSION must identify an already-installed web-tool extension.");
	assert.ok(process.env.PI_MODEL && process.env.PI_PROVIDER, "Prerequisites: inherit PI_MODEL and PI_PROVIDER from the selected installed runtime; do not choose an ad hoc model.");
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const authPath = join(getAgentDir(), "auth.json");
	assert.ok(existsSync(authPath), "Existing runtime-owned auth storage required; no login is performed.");
	const root = mkdtempSync(join(tmpdir(), "gentle-live-research-"));
	const profile = join(root, "profile"), trace = join(root, "logs", "trace.jsonl");
	mkdirSync(profile, { recursive: true }); mkdirSync(dirname(trace)); mkdirSync(join(root, "sessions"));
	writeFileSync(trace, "", { mode: 0o600 });
	writeFileSync(join(profile, "settings.json"), JSON.stringify({ defaultProvider: process.env.PI_PROVIDER, defaultModel: process.env.PI_MODEL, ...(process.env.PI_REASONING_LEVEL ? { defaultThinkingLevel: process.env.PI_REASONING_LEVEL } : {}), packages: [] }), { mode: 0o600 });
	const child = spawn(launcher.command, [...launcher.args, "--mode", "rpc", "--session-dir", join(root, "sessions"), "--tools", tools.join(",")], {
		cwd: root, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: join(root, "cache"), TMPDIR: root, PI_CODING_AGENT_DIR: profile, GENTLE_PI_AGENT_HOME: profile, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_PI_LIVE_RESEARCH_ROLE: "host", GENTLE_PI_LIVE_RESEARCH_TRACE: trace, GENTLE_PI_LIVE_RESEARCH_AUTH_PATH: authPath },
	});
	child.stderr.resume(); child.stdin.on("error", () => {});
	let hostCommandCompleted = false, rpcBuffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		rpcBuffer += chunk;
		let newline: number;
		while ((newline = rpcBuffer.indexOf("\n")) !== -1) {
			const line = rpcBuffer.slice(0, newline); rpcBuffer = rpcBuffer.slice(newline + 1);
			try {
				const response = JSON.parse(line);
				if (response.type !== "response" || response.id !== "probe" || response.command !== "prompt") continue;
				hostCommandCompleted = response.success === true;
				// AgentSession acknowledges extension prompts only after the handler returns.
				// ctx.shutdown merely sets a flag; RPC EOF invokes native disposal even
				// when this host never produces an agent_settled event. Errors still fail.
				child.stdin.end();
			} catch { /* Ignore non-JSON output without persisting potentially private text. */ }
		}
	});
	const rows = () => {
		const bytes = readFileSync(trace, "utf8");
		return bytes.slice(0, bytes.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
	};
	let diagnosed = false;
	const reportDiagnostics = () => {
		if (diagnosed) return;
		diagnosed = true;
		// Every retained trace event is authored by this harness. Evidence contains
		// public text only after passage/citation validation; provider output is excluded.
		t.diagnostic(JSON.stringify({ candidate, hostCommandCompleted, hostExit: child.exitCode, hostSignal: child.signalCode, trace: rows() }));
	};
	const kill = (pid: number) => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* Already exited. */ } };
	const stopLiveProcesses = () => {
		const observed = rows();
		for (const row of observed) if (row.event === "spawn" && row.pid && !observed.some(exit => exit.event === "child_exit" && exit.pid === row.pid)) kill(row.pid);
		if (child.pid && child.exitCode === null && child.signalCode === null) kill(child.pid);
	};
	const timer = setTimeout(stopLiveProcesses, 170_000);
	try {
		const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", () => reject(new Error("Installed Pi launcher could not start."))); });
		child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: "/gentle-live-research-probe" })}\n`);
		const exit = await exited;
		const observed = rows();
		reportDiagnostics();
		assert.ok(hostCommandCompleted, "Host extension command did not acknowledge successful completion.");
		assert.ok(!observed.some(row => row.event === "launcher_failed"), "SDK launcher failed; see sanitized stage diagnostics.");
		assert.equal(exit, 0, "Live host did not exit cleanly within the bound.");
		assert.ok(!observed.some(row => row.event === "prerequisite_failed"), "Live prerequisites failed: check installed web tools and existing runtime-owned model authentication; no evidence claimed.");
		assert.ok(observed.some(row => row.role === "child" && row.event === "loaded" && row.candidate === candidate && row.modelMatches && row.candidateHash === createHash("sha256").update(readFileSync(candidate)).digest("hex")), "Child did not load the expected candidate and inherited model.");
		assert.ok(observed.some(row => row.event === "candidate_hook" && row.observed), "Candidate child-local capability hook did not execute.");
		for (const name of tools) assert.ok(observed.some(row => row.role === "child" && row.event === "tool_result" && row.tool === name && row.success), `No successful real execution of ${name}.`);
		assert.ok(observed.some(row => row.event === "runner_result" && row.status === "completed"), "Candidate AgentRunner did not complete.");
		assert.ok(observed.some(row => row.event === "child_settled"), "Native child settlement was not observed.");
		// AgentRunner requestStop sends SIGTERM even for completed tasks; native
		// runRpcMode translates SIGTERM to exit 143. Neither code proves completion.
		assert.ok(observed.some(row => row.event === "child_exit" && (row.code === 0 || row.code === 143 || row.signal === "SIGTERM")), "Child did not exit through normal or runner terminal cleanup.");
		const evidence = observed.find(row => row.event === "evidence" && row.valid);
		assert.ok(evidence, "No source-backed public passage and citation were verified.");
		t.diagnostic(JSON.stringify({ candidate, executions: observed.filter(row => row.role === "child" && row.event === "tool_result").map(row => ({ tool: row.tool, success: row.success })), source_url: evidence.source_url, passage: evidence.passage, hostExit: exit, childExit: observed.find(row => row.event === "child_exit")?.code, childSignal: observed.find(row => row.event === "child_exit")?.signal }));
	} finally {
		clearTimeout(timer);
		reportDiagnostics();
		stopLiveProcesses();
		rmSync(root, { recursive: true, force: true });
	}
});
