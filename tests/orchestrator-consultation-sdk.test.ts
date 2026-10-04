import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MetadataReceipt } from "../lib/orchestrator-consultation.ts";

// node --test runs this file in its own process. No SDK value import precedes
// profile binding: production modules also import the SDK's global agent paths.
test("public SDK publishes, consults, pages, withdraws and replaces isolated owners", {
	timeout: 30_000, skip: process.platform === "win32" ? "Production POSIX socket transport; no Windows runtime proof" : false,
}, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-sdk-")));
	chmodSync(root, 0o700);
	const profile = join(root, "profile");
	mkdirSync(profile, { mode: 0o700 });
	// Second authorized output selector: exactly production's profile-derived
	// socket leaf. Never enumerate/delete the UID parent or historical profiles.
	const uidParent = join(realpathSync("/tmp"), `gentle-pi-${process.getuid!()}`);
	const hash = createHash("sha256").update(resolve(profile)).digest("hex").slice(0, 32);
	assert.match(hash, /^[a-f0-9]{32}$/);
	const socketLeaf = join(uidParent, hash);
	const absent = (path: string) => {
		try { lstatSync(path); return false; } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	};
	const validateLeaf = () => {
		const stat = lstatSync(socketLeaf);
		assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
		assert.equal(stat.uid, process.getuid!()); assert.equal(stat.mode & 0o777, 0o700);
		assert.equal(realpathSync(uidParent), uidParent);
		assert.equal(realpathSync(socketLeaf), socketLeaf);
	};
	let mayOwnLeaf = false;
	const bindings = {
		PI_CODING_AGENT_DIR: profile, PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		GENTLE_PI_AGENT_HOME: profile, GENTLE_PI_CONFIG_HOME: join(root, "config"),
	};
	const previous = Object.fromEntries(Object.keys(bindings).map(key => [key, process.env[key]]));
	Object.assign(process.env, bindings);
	const live: Array<{ session: AgentSession; close: () => Promise<void> }> = [];
	try {
		assert.ok(absent(socketLeaf), "Preexisting socket leaf: stop without mutating or cleaning it");
		mayOwnLeaf = true;
		const sdk = await import("@earendil-works/pi-coding-agent");
		const ai = await import("@earendil-works/pi-ai");
		const { default: gentleAgents } = await import("../extensions/gentle-agents.ts");
		const { default: gentleShell } = await import("../extensions/gentle-shell.ts");
		const { resolveSessionWorktreeWithGit } = await import("../lib/session-worktree-registry.ts");
		const { ORCHESTRATOR_STATE_ENTRY } = await import("../lib/orchestrator-state.ts");
		assert.equal(sdk.getAgentDir(), profile);
		const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") };
		writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
		const git = (cwd: string, ...args: string[]) => {
			assert.ok(!relative(root, cwd).startsWith(".."));
			return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
		};
		const seed = join(root, "seed");
		mkdirSync(seed);
		git(seed, "init", "--initial-branch=fixture");
		git(seed, "-c", "user.name=SDK Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
		const clone = join(root, "clone");
		git(root, "clone", "--no-hardlinks", seed, clone);
		git(clone, "remote", "remove", "origin");
		const roots = Array.from({ length: 10 }, (_, i) => join(root, `wt${i}`));
		for (const cwd of roots) git(clone, "worktree", "add", "--detach", cwd, "HEAD");
		let gitProbes = 0;
		const runGit = new Proxy(execFileSync, { apply(target, _this, [command, args, options]) {
			assert.equal(command, "git");
			assert.ok(String(args[args.indexOf("-C") + 1]).startsWith(root + "/"));
			gitProbes++;
			return Reflect.apply(target, undefined, [command, args, { ...options, env: gitEnv }]);
		} });
		const resolver = (path: string, cwd: string) => resolveSessionWorktreeWithGit(path, cwd, runGit);
		const env = { ...bindings, GENTLE_PI_AGENTS: "1", GENTLE_PI_SHELL: "1" };
		async function host(cwd: string, humanName?: string) {
			const manager = sdk.SessionManager.create(cwd, join(root, `sessions-${live.length}`));
			if (humanName) manager.appendSessionInfo(humanName);
			const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", packages: [] });
			const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null,
				modelsStorePath: join(root, `models-${live.length}.json`), refreshOnCreate: false, allowModelNetwork: false });
			let calls = 0;
			let request: { name: string; arguments: ToolCall["arguments"] } | undefined;
			let ctx: ExtensionContext | undefined;
			const shutdown: Array<() => Promise<void>> = [];
			const errors: string[] = [];
			const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: profile, settingsManager: settings,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				systemPrompt: "Local acceptance fixture. Only execute the requested metadata tools.", appendSystemPrompt: [],
				extensionFactories: [pi => {
					// Capture ONLY public shutdown registrations for cleanup. Business
					// tools/events receive actual SDK contexts, never fabricated contexts.
					const captured = new Proxy(pi, { get(target, key) {
						if (key !== "on") return Reflect.get(target, key);
						const on: ExtensionAPI["on"] = (event, handler) => {
							if (event === "session_shutdown") shutdown.push(async () => { assert.ok(ctx); await handler({ type: "session_shutdown" }, ctx); });
							return target.on(event, handler);
						};
						return on;
					} });
					pi.on("session_start", (_event, context) => { ctx = context; });
					gentleAgents(captured, env, { home: root, agentHome: profile, resolveWorktree: resolver,
						spawn: () => { throw new Error("OS child agent forbidden"); } });
					gentleShell(captured, env, { resolveWorktree: resolver, activeProfile: () => undefined });
					pi.registerProvider("fixture-local", { api: "fixture-local", apiKey: "fixture-only", baseUrl: "http://invalid.local",
						models: [{ id: "metadata", name: "Local metadata driver", reasoning: false, input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024 }],
						streamSimple(model, _context, options) {
							calls++;
							assert.equal(model.provider, "fixture-local");
							const stream = ai.createAssistantMessageEventStream();
							const next = request;
							request = undefined; // one tool turn, then one terminal turn
							const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
								content: [], stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0,
									cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
							queueMicrotask(() => {
								if (options?.signal?.aborted) {
									message.stopReason = "aborted"; message.errorMessage = "aborted";
									stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); return;
								}
								stream.push({ type: "start", partial: message });
								if (next) {
									const toolCall: ToolCall = { type: "toolCall", id: `call-${calls}`, ...next };
									message.content.push(toolCall);
									stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
									stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(next.arguments), partial: message });
									stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
								}
								message.stopReason = next ? "toolUse" : "stop";
								stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
							});
							return stream;
						},
					});
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const { session } = await sdk.createAgentSession({ cwd, agentDir: profile, modelRuntime: runtime,
				model: { id: "metadata", name: "Local metadata driver", provider: "fixture-local", api: "fixture-local",
					baseUrl: "http://invalid.local", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 1024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, thinkingLevel: "off", resourceLoader: loader,
				tools: ["orchestrator_session_id", "orchestrator_consult", "orchestrator_list", "session_worktree_register"],
				sessionManager: manager, settingsManager: settings });
			let closed = false;
			const close = async () => {
				if (closed) return;
				closed = true;
				await session.abort();
				// SDK dispose does not dispatch session_shutdown. Invoke captured
				// production cleanup callbacks with its real still-valid SDK ctx.
				for (const handler of shutdown) await handler();
				session.dispose();
			};
			live.push({ session, close });
			await session.bindExtensions({ mode: "json", onError: error => { errors.push(error.error); } });
			async function tool(name: string, args: ToolCall["arguments"] = {}) {
				request = { name, arguments: args };
				let result: { content: Array<{ type: string; text?: string }>; details?: any } | undefined;
				const before = calls;
				let failed = false;
				let toolProbes = 0;
				const unsubscribe = session.subscribe(event => {
					if (event.type === "tool_execution_start" && event.toolName === name) toolProbes = gitProbes;
					if (event.type === "tool_execution_end" && event.toolName === name) {
						result = event.result; failed = event.isError;
						if (name === "orchestrator_consult") assert.equal(gitProbes, toolProbes, "metadata tool adds no Git probes");
					}
				});
				try { await session.prompt(`Execute ${name} once, then stop.`); } finally { unsubscribe(); }
				assert.equal(calls - before, 2, `normal driver tool/final turns only; ${JSON.stringify(session.messages.slice(-2))}`);
				assert.deepEqual(errors, []);
				assert.ok(result, `${name} ran through SDK`);
				assert.equal(failed, false, JSON.stringify(result));
				return result;
			}
			// Logical identity is not transport liveness. This only checks metadata
			// readiness; actual asynchronous socket publication is awaited below.
			for (let i = 0; i < 100; i++) {
				const result = await tool("orchestrator_session_id");
				if (result.details?.gentleAgents?.senderSessionId) break;
				assert.ok(i < 99, "session metadata ready within bounded poll");
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			const transportPresence = join(profile, "gentle-agents", "transport", "presence");
			const deadline = Date.now() + 5000;
			for (;;) {
				const names = absent(transportPresence) ? [] : readdirSync(transportPresence).filter(name => name.endsWith(".json"));
				const published = names.map(name => JSON.parse(readFileSync(join(transportPresence, name), "utf8")))
					.find(record => record.sessionId === manager.getSessionId());
				if (published) {
					validateLeaf();
					assert.equal(dirname(published.endpoint), socketLeaf);
					assert.equal(dirname(realpathSync(published.endpoint)), socketLeaf);
					assert.ok(lstatSync(published.endpoint).isSocket());
					break;
				}
				assert.ok(Date.now() < deadline, "own transport presence/socket published within deadline");
				await new Promise(resolve => setTimeout(resolve, 10));
			}
			return { session, manager, tool, close, calls: () => calls };
		}
		const owner = await host(roots[0], "Human owner");
		const caller = await host(roots[1]);
		validateLeaf();
		const transportPresence = join(profile, "gentle-agents", "transport", "presence");
		const records = readdirSync(transportPresence).filter(name => name.endsWith(".json")).map(name => {
			const path = join(transportPresence, name), stat = lstatSync(path);
			assert.ok(stat.isFile() && !stat.isSymbolicLink());
			assert.equal(stat.uid, process.getuid!()); assert.equal(stat.mode & 0o777, 0o600);
			return JSON.parse(readFileSync(path, "utf8"));
		});
		assert.equal(records.length, 2);
		assert.deepEqual(records.map(record => record.sessionId).sort(), [owner.manager.getSessionId(), caller.manager.getSessionId()].sort());
		for (const record of records) {
			assert.deepEqual(Object.keys(record).sort(), ["createdAt", "endpoint", "sessionId", "version"]);
			assert.equal(record.version, 1); assert.ok(Number.isSafeInteger(record.createdAt) && record.createdAt >= 0);
			assert.equal(dirname(record.endpoint), socketLeaf);
			assert.equal(dirname(realpathSync(record.endpoint)), socketLeaf);
			assert.ok(lstatSync(record.endpoint).isSocket());
		}
		assert.notEqual(owner.manager, caller.manager);
		assert.notEqual(owner.manager.getSessionId(), caller.manager.getSessionId());
		const state = { objective: "Verify metadata", progress: "Published milestone", decisions: "No authority", blockers: "None recorded" };
		await owner.tool("orchestrator_session_id", { subject: "Do not replace human name", state });
		assert.equal(owner.manager.getSessionName(), "Human owner");
		const note = owner.manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ORCHESTRATOR_STATE_ENTRY);
		assert.ok(note?.type === "custom");
		assert.deepEqual((note.data as any).state, state);
		owner.manager.appendMessage({ role: "user", content: "PRIVATE_OWNER_HISTORY_SENTINEL", timestamp: Date.now() });
		assert.ok(owner.manager.getEntries().some(entry => entry.type === "message" && JSON.stringify(entry.message).includes("PRIVATE_OWNER_HISTORY_SENTINEL")));
		for (const path of roots.slice(0, 9)) await owner.tool("session_worktree_register", { path });
		const sid = owner.manager.getSessionId();
		const consult = async (cursor?: string, recipient = sid): Promise<MetadataReceipt> => {
			const ownerCalls = owner.calls();
			const result = await caller.tool("orchestrator_consult", { recipient_session_id: recipient, ...(cursor ? { cursor } : {}) });
			assert.equal(owner.calls(), ownerCalls, "no receiver model call/wakeup");
			const receipt: MetadataReceipt = result.details.gentleAgents.receipt;
			assert.ok(Object.isFrozen(receipt));
			assert.equal(receipt.schema, "gentle-agents.consultation/v1");
			assert.equal(receipt.kind, "metadata"); assert.equal(receipt.targetSessionId, recipient);
			if (receipt.status === "available") assert.ok(receipt.unknowns.includes("owner-decision"));
			assert.equal(receipt.source, "published_snapshot");
			assert.equal(receipt.ownerReply, false); assert.equal(receipt.authority, "none");
			assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_OWNER_HISTORY_SENTINEL|endpoint|consent|activation/);
			return receipt;
		};
		const first = await consult();
		assert.equal(first.status, "available");
		assert.deepEqual(first.snapshot?.state?.state, state);
		assert.equal(first.snapshot?.state?.recordedAt, (note.data as any).recordedAt);
		assert.ok(first.digest); assert.ok(first.observedAt >= first.snapshot!.state!.recordedAt);
		assert.deepEqual(first.snapshot?.catalog?.registered, roots.slice(0, 8));
		assert.equal(first.snapshot?.state?.source, "owner-curated");
		assert.ok(Object.isFrozen(first.snapshot?.state?.state));
		assert.throws(() => { first.snapshot!.state!.state!.progress = "Changed"; }, TypeError);
		const cursor = first.snapshot!.catalog!.cursor;
		assert.ok(cursor);
		const next = await consult(cursor);
		assert.deepEqual(next.snapshot?.catalog?.registered, [roots[8]]);
		assert.equal(next.snapshot?.scope?.registered.length, 8, "Git identity remains bounded prefix, not inferred from next page");
		assert.ok(next.omissions.includes("git-facts-beyond-published-prefix"));
		owner.manager.appendMessage({ role: "user", content: "PRIVATE_PROGRESS_TOKENS_ONLY", timestamp: Date.now() });
		await owner.tool("orchestrator_session_id"); // omission preserves public notes
		assert.equal((await consult(cursor)).status, "available");
		assert.equal((await consult()).digest, first.digest);
		await owner.tool("session_worktree_register", { path: roots[9] });
		assert.equal((await consult(cursor)).status, "unavailable");
		const changed = await consult();
		assert.equal((await consult(changed.snapshot!.catalog!.cursor)).snapshot?.catalog?.registered.length, 2);
		await owner.tool("orchestrator_session_id", { state: { progress: "New public milestone" } });
		assert.notEqual((await consult()).digest, changed.digest);
		await owner.tool("orchestrator_session_id", { state: null });
		assert.equal((await consult()).snapshot?.state?.state, null);
		const withdrawn = owner.manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ORCHESTRATOR_STATE_ENTRY);
		assert.ok(withdrawn?.type === "custom"); assert.equal((withdrawn.data as any).state, null);
		const file = owner.manager.getSessionFile();
		assert.ok(file);
		const restored = sdk.SessionManager.open(file, join(root, "restore-sessions"));
		assert.equal((restored.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ORCHESTRATOR_STATE_ENTRY) as any).data.state, null);
		await owner.close();
		assert.equal((await consult()).status, "unavailable");
		const replacement = await host(roots[0]); // public replacement lifecycle, new manager/runtime
		assert.notEqual(replacement.manager.getSessionId(), sid);
		assert.equal((await consult()).status, "unavailable");
		const fresh = await consult(undefined, replacement.manager.getSessionId());
		assert.equal(fresh.status, "available"); assert.equal(fresh.snapshot?.state, null);
		assert.ok(fresh.unknowns.includes("curated-state")); assert.notEqual(fresh.digest, first.digest);
		assert.deepEqual(first.snapshot?.state?.state, state, "earlier capture remains detached");
		for (const item of live) await item.close();
		const presence = join(profile, "gentle-agents", "presence");
		assert.deepEqual(existsSync(presence) ? readdirSync(presence) : [], [], "publishers withdraw all presence files");
	} finally {
		try {
			for (const item of live) await item.close();
			if (mayOwnLeaf && !absent(socketLeaf)) {
				const presenceDirs = [join(profile, "gentle-agents", "presence"), join(profile, "gentle-agents", "transport", "presence")];
				for (let i = 0; i < 100; i++) {
					validateLeaf();
					if (readdirSync(socketLeaf).length === 0 && presenceDirs.every(path => absent(path) || readdirSync(path).length === 0)) break;
					assert.ok(i < 99, "shutdown timeout: leave nonempty/unsafe socket leaf untouched");
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				validateLeaf(); assert.deepEqual(readdirSync(socketLeaf), []);
				rmdirSync(socketLeaf); // exact empty leaf only; never recursive or UID parent
				assert.ok(absent(socketLeaf));
			}
			rmSync(root, { recursive: true, force: true });
			await new Promise(resolve => setTimeout(resolve, 100));
			assert.ok(absent(root), "no post-cleanup profile recreation");
			if (mayOwnLeaf) assert.ok(absent(socketLeaf), "no post-cleanup socket recreation");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
	}
});
