import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import gentleAgents from "../../extensions/gentle-agents.ts";
import gentleShell from "../../extensions/gentle-shell.ts";
import { createGentleAiExtension } from "../../extensions/gentle-ai.ts";
import { createNodeExecFileAdapter, NativeReviewCliV216 } from "../../lib/native-review-cli.ts";
import { SESSION_WORKTREE_ENTRY } from "../../lib/session-worktree-registry.ts";
import { requireDevBinary } from "../support/native-binary-gate.ts";

const binary = process.env.GENTLE_AI_DEV_BINARY;
const gate = requireDevBinary({ devBinaryPath: binary, exists: !!binary && binary.startsWith("/") && existsSync(binary), env: process.env });
if ("reason" in gate) console.log(`non-git-subagent-bootstrap: ${gate.reason}`);

// This is a fixture-only provider, not a replacement RPC child. The installed
// Pi CLI still loads the provider, accepts RPC, runs its agent loop and settles.
// No HTTP transport, credentials, or paid model are involved.
function offlineProvider(aiModule: string): string {
	return `import { createAssistantMessageEventStream } from ${JSON.stringify(aiModule)};
export default function (pi) {
  globalThis.fetch = async () => { throw new Error("Network forbidden in bootstrap fixture"); };
  pi.registerProvider("bootstrap-fixture", {
    baseUrl: "http://invalid.invalid", apiKey: "fixture-only", api: "bootstrap-fixture",
    models: [{ id: "deterministic", name: "Offline bootstrap fixture", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = { role: "assistant", api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (options?.signal?.aborted) {
          message.stopReason = "aborted"; message.errorMessage = "Fixture aborted";
          stream.push({ type: "error", reason: "aborted", error: message }); stream.end(message); return;
        }
        const text = "OFFLINE_BOOTSTRAP_CHILD " + JSON.stringify({ pid: process.pid, cwd: process.cwd() });
        stream.push({ type: "start", partial: message });
        message.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0].text = text;
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      });
      return stream;
    }
  });
}
`;
}

for (const explicit of [false, true]) {
test(`dev-binary: pre-bootstrap SDK session first ${explicit ? "explicit worker" : "implicit gentle-ai-worker"} dispatch completes a real Pi child`, { skip: !gate.run, timeout: 90000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-subagent-bootstrap-")));
	const home = join(root, "home");
	const agentDir = join(home, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(join(cwd, "candidate.txt"), "unchanged candidate bytes\n");
	const role = explicit ? "worker" : "gentle-ai-worker";
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", `${role}.md`), "---\ndescription: Offline bootstrap proof\nmodel: bootstrap-fixture/deterministic\ntools: [read]\n---\nReturn the offline fixture answer.\n");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, packages: [] }));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH, HOME: home, USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
		GENTLE_PI_AGENT_HOME: agentDir, PI_CODING_AGENT_DIR: agentDir,
		GENTLE_PI_CONFIG_HOME: join(home, "pi-config"), PI_OFFLINE: "1",
		GENTLE_PI_SHELL: "1", GENTLE_PI_SHELL_CHANGES_WATCH_MS: "off",
		GENTLE_PI_RUNTIME_METRICS: "off",
	};
	const previous = new Map<string, string | undefined>();
	for (const key of new Set([...Object.keys(env), ...Object.keys(process.env).filter(key => key.startsWith("GIT_"))])) {
		previous.set(key, process.env[key]);
		if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
	}
	const children: ChildProcess[] = [];
	t.after(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
				child.kill("SIGTERM");
				await exited;
			}
		}
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const sdkPackage = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..", "package.json");
	const installed = JSON.parse(readFileSync(sdkPackage, "utf8"));
	const cli = realpathSync(join(dirname(sdkPackage), installed.bin.pi));
	const provider = join(root, "offline-provider.mjs");
	writeFileSync(provider, offlineProvider(import.meta.resolve("@earendil-works/pi-ai")));
	t.diagnostic(`installed Pi SDK/CLI=${installed.version}; cli=${cli}; native=${binary}`);
	const modeRoot = join(root, "mode-root");
	mkdirSync(modeRoot);
	execFileSync("git", ["init", "--quiet", modeRoot], { env, stdio: "pipe" });
	const enabled = JSON.parse(execFileSync(binary!, ["review", "mode", "enable", "--scope", "global", "--cwd", modeRoot, "--json"], { env, encoding: "utf8" }));
	assert.equal(enabled.status.effective, "on");
	const nativeCalls: Array<{ cwd: string; args: string[] }> = [];
	let preparationCompleted = false;
	const adapter = createNodeExecFileAdapter();
	const native = new NativeReviewCliV216(async request => {
		nativeCalls.push({ cwd: request.cwd, args: [...request.arguments] });
		const result = await adapter(request);
		if (request.arguments[0] === "review" && request.arguments[1] === "status") preparationCompleted = existsSync(join(cwd, ".git"));
		return result;
	}, binary!);
	const frames: Array<Array<Record<string, unknown>>> = [];
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "empty-auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false });
	const manager = SessionManager.inMemory(cwd);
	const id = manager.getSessionId();
	const loader = new DefaultResourceLoader({
		cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			(await import(pathToFileURL(provider).href)).default,
			pi => gentleAgents(pi, env, {
				home, agentHome: agentDir, env,
				pi: { command: process.execPath, args: [cli, "--offline", "--no-extensions", "--extension", provider, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"] },
				// Observe real OS spawn and production RPC traffic without replacing it.
				spawn(command, args, options) {
					assert.equal(preparationCompleted, true, "native preparation completed BEFORE OS spawn");
					const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: options.stdio ?? ["pipe", "pipe", "pipe"], windowsHide: true, detached: options.detached });
					children.push(child);
					const records: Array<Record<string, unknown>> = [];
					frames.push(records);
					let buffer = "";
					child.stdout!.on("data", chunk => {
						buffer += chunk.toString();
						const lines = buffer.split("\n"); buffer = lines.pop()!;
						for (const line of lines) { try { records.push(JSON.parse(line)); } catch { /* production parser also ignores non-JSON lines */ } }
					});
					return child as never;
				},
			}),
			pi => gentleShell(pi, env),
			createGentleAiExtension({ nativeReviewCli: native, candidateViews: null, processEnv: {} }),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(existsSync(join(cwd, ".git")), false, "extensions load before bootstrap");
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime, sessionManager: manager, noTools: "builtin", settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }) });
	try {
		await session.bindExtensions({ mode: "print" });
		assert.equal(existsSync(join(cwd, ".git")), false, "registries are bound while the project is still non-Git");
		assert.equal(nativeCalls.some(call => call.args[0] === "review" && call.args[1] === "status"), false, "binding never prepares");
		session.setActiveToolsByName(["session_worktree_register", "subagent_run", "subagent_status"]);
		const tool = (name: string) => {
			const selected = session.agent.state.tools.find(tool => tool.name === name);
			assert.ok(selected, `SDK tool registered: ${name}`);
			return selected;
		};
		const registrations = () => manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === SESSION_WORKTREE_ENTRY);
		assert.equal(registrations().length, 0);
		{
			const result = await tool("subagent_run").execute(explicit ? "explicit" : "implicit", { agent: role, task: "Return offline bootstrap evidence\n## Allowed edit surfaces\nsrc/app.ts\n## Return\nReport", mode: "task", ...(explicit ? { workspace_root: cwd } : {}) });
			const index = 0;
			const child = children[index]!;
			assert.ok(child.pid && child.pid !== process.pid, "real installed Pi child PID");
			const details = (result.details as { gentleAgents: { status: string; cwd: string; taskId: string } }).gentleAgents;
			assert.equal(details.status, "completed", JSON.stringify(result));
			assert.equal(details.cwd, cwd);
			const answer = result.content.find(part => part.type === "text") as { text: string };
			assert.equal(answer.text, `OFFLINE_BOOTSTRAP_CHILD ${JSON.stringify({ pid: child.pid, cwd })}`);
			assert.ok(frames[index]!.some(frame => frame.type === "response" && frame.command === "get_state" && frame.success), "production RPC readiness handshake");
			assert.ok(frames[index]!.some(frame => frame.type === "agent_settled"), "actual CLI task settled");
			assert.equal(manager.getSessionId(), id);
			assert.equal(session.sessionManager, manager, "no manager replacement or Pi reload");
			assert.equal(registrations().length, 1, "spawn registration dedupes durable entry");
			t.diagnostic(`${explicit ? "explicit" : "implicit"} child pid=${child.pid}; RPC ready; task=${details.taskId} completed; canonical cwd=${details.cwd}; same session=${id}`);
		}
		assert.equal(nativeCalls.filter(call => call.cwd === cwd && call.args[0] === "review" && call.args[1] === "status").length, 1);
		assert.equal(nativeCalls.some(call => call.args[0] === "review" && call.args[1] === "start"), false);
		assert.equal(readFileSync(join(cwd, "candidate.txt"), "utf8"), "unchanged candidate bytes\n");
		assert.equal(session.messages.length, 0, "parent never calls a model");
		assert.equal(manager.getEntries().some(entry => entry.type === "custom" && /session-change|review-reminder/.test(entry.customType)), false, "registration is not Changes evidence");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
}
