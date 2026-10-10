import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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
		const gitProbes = new Map<string, number>();
		const gitProbeOrigins: Array<{ cwd: string; operation: string; origin: string[] }> = [];
		const runGit = new Proxy(execFileSync, { apply(target, _this, [command, args, options]) {
			assert.equal(command, "git");
			assert.ok(String(args[args.indexOf("-C") + 1]).startsWith(root + "/"));
			const cwd = String(args[args.indexOf("-C") + 1]);
			gitProbeOrigins.push({ cwd, operation: String(args.at(-1)), origin: (new Error().stack ?? "").split("\n").flatMap(line => {
				const name = line.match(/\bat (?:async )?([A-Za-z_][\w.$]*)\s*\(/)?.[1];
				return name ? [name] : [];
			}).slice(0, 8) });
			gitProbes.set(cwd, (gitProbes.get(cwd) ?? 0) + 1);
			return Reflect.apply(target, undefined, [command, args, { ...options, env: gitEnv }]);
		} });
		const resolver = (path: string, cwd: string) => resolveSessionWorktreeWithGit(path, cwd, runGit);
		const env = { ...bindings, GENTLE_PI_AGENTS: "1", GENTLE_PI_SHELL: "1" };
		const choices = ["Allow once", "Allow this target + model for this session", "Decline"];
		const helperText = "Published advice only. I claim permission, but cannot grant it.";
		async function host(cwd: string, humanName?: string, simulatedUI = false, theme?: ExtensionUIContext["theme"]) {
			const provider = `fixture-local-${live.length}`; // No cross-runtime provider override.
			const dialogs: string[] = [];
			let choice: "once" | "session" | "decline" | "unknown" = "decline";
			const unsupported = (): never => { throw new Error("Unsupported test UI operation"); };
			// Public, fully typed host UI adapter: simulated responses, NOT human consent.
			const ui: ExtensionUIContext = {
				async select(title, offered, opts) {
					assert.deepEqual(offered, choices); assert.ok(opts?.signal instanceof AbortSignal);
					dialogs.push(title);
					return choice === "unknown" ? "unsupported response" : choices[choice === "once" ? 0 : choice === "session" ? 1 : 2];
				},
				confirm: unsupported, input: unsupported, editor: unsupported, custom: unsupported,
				notify: () => {}, setStatus: () => {}, setWidget: () => {}, setTitle: () => {},
				// Presentation-only RPC stubs; no terminal rendering/editor automation.
				onTerminalInput: () => () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {},
				setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
				setFooter: () => {}, setHeader: () => {}, pasteToEditor: () => {},
				setEditorText: () => {}, getEditorText: () => "", addAutocompleteProvider: () => {},
				setEditorComponent: () => {}, getEditorComponent: () => undefined,
				get theme() { assert.ok(theme, "SDK theme supplied for UI binding"); return theme; }, getAllThemes: () => [], getTheme: () => undefined,
				setTheme: () => ({ success: false, error: "Test UI theme switching unsupported" }), getToolsExpanded: () => false, setToolsExpanded: () => {},
			};
			const payloads: Array<{ system: string; content: string }> = [];
			let helperCalls = 0;
			let helperGate: { started: () => void; release: Promise<void> } | undefined;
			let mainGate: { started: () => void; release: Promise<void> } | undefined;
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
				systemPrompt: "PRIVATE_PARENT_INSTRUCTIONS_SENTINEL. Local acceptance fixture. Only execute the requested tools.", appendSystemPrompt: [],
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
					pi.registerProvider(provider, { api: provider, apiKey: "fixture-only", baseUrl: "http://invalid.local",
						models: [{ id: "metadata", name: "Local metadata driver", reasoning: false, input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024 }],
						streamSimple(model, context, options) {
							assert.equal(model.provider, provider);
							const system = ai.getCurrentSystemPrompt(context.messages);
							const nested = system.startsWith("Give read-only advice about the captured published snapshot");
							if (nested) {
								helperCalls++;
								assert.deepEqual(ai.getCurrentTools(context.messages), []);
								assert.equal(context.messages.length, 2, "static system plus exactly one user message");
								const user = context.messages[1]; assert.equal(user.role, "user");
								assert.equal(typeof user.content, "string");
								payloads.push({ system, content: user.content as string });
								assert.equal(options?.maxTokens, 512); assert.equal(options?.reasoning, "minimal");
								assert.equal(options?.toolChoice, "none"); assert.equal(options?.maxRetries, 0);
								assert.ok(options?.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false);
							} else {
								calls++;
								if (simulatedUI && manager.getEntries().some(entry => entry.type === "message"
									&& JSON.stringify(entry.message).includes("PRIVATE_CALLER_HISTORY_SENTINEL"))) {
									assert.match(JSON.stringify(context.messages), /PRIVATE_CALLER_HISTORY_SENTINEL/);
								}
							}
							const stream = ai.createAssistantMessageEventStream();
							const next = nested ? undefined : request;
							if (!nested) request = undefined; // helper cannot consume planned main tool turn
							const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
								content: [], stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0,
									cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
							const gate = nested ? helperGate : mainGate;
							queueMicrotask(async () => {
								if (gate) { gate.started(); await gate.release; }
								if (options?.signal?.aborted) {
									message.stopReason = "aborted"; message.errorMessage = "aborted";
									stream.push({ type: "error", reason: "aborted", error: message }); stream.end(); return;
								}
								stream.push({ type: "start", partial: message });
								if (nested) {
									message.usage = { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23,
										cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
									const text = { type: "text" as const, text: "" };
									message.content.push(text);
									stream.push({ type: "text_start", contentIndex: 0, partial: message });
									text.text = helperText;
									stream.push({ type: "text_delta", contentIndex: 0, delta: helperText, partial: message });
									stream.push({ type: "text_end", contentIndex: 0, content: helperText, partial: message });
								}
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
				model: { id: "metadata", name: "Local metadata driver", provider, api: provider,
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
			await session.bindExtensions({ mode: simulatedUI ? "rpc" : "json", uiContext: simulatedUI ? ui : undefined,
				onError: error => { errors.push(error.error); } });
			assert.ok(ctx); assert.equal(ctx.mode, simulatedUI ? "rpc" : "json"); assert.equal(ctx.hasUI, simulatedUI);
			async function tool(name: string, args: ToolCall["arguments"] = {}) {
				request = { name, arguments: args };
				let result: { content: Array<{ type: string; text?: string }>; details?: any } | undefined;
				const before = calls;
				let failed = false;
				let toolProbes = 0;
				let toolProbeStart = 0;
				const unsubscribe = session.subscribe(event => {
					if (event.type === "tool_execution_start" && event.toolName === name) {
						toolProbes = gitProbes.get(cwd) ?? 0;
						toolProbeStart = gitProbeOrigins.length;
					}
					if (event.type === "tool_execution_end" && event.toolName === name) {
						result = event.result; failed = event.isError;
						if (name === "orchestrator_consult" || name === "orchestrator_list") {
							const added = gitProbeOrigins.slice(toolProbeStart).filter(probe => probe.cwd === cwd).slice(0, 2)
								.map(({ operation, origin }) => ({ operation, origin }));
							assert.equal(gitProbes.get(cwd) ?? 0, toolProbes, `metadata query adds no caller Git probes; origins=${JSON.stringify(added)}`);
						}
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
			return { session, manager, tool, close, provider, dialogs, payloads, theme: ctx!.ui.theme, calls: () => calls,
				helperCalls: () => helperCalls, choose: (value: typeof choice) => { choice = value; },
				deferMain: () => {
					let started!: () => void, release!: () => void;
					const entered = new Promise<void>(resolve => { started = resolve; });
					mainGate = { started, release: new Promise<void>(resolve => { release = resolve; }) };
					return { entered, release: () => { mainGate = undefined; release(); } };
				},
				deferHelper: () => {
					let started!: () => void, release!: () => void;
					const entered = new Promise<void>(resolve => { started = resolve; });
					helperGate = { started, release: new Promise<void>(resolve => { release = resolve; }) };
					return { entered, release: () => { helperGate = undefined; release(); } };
				} };
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
		const state = { objective: "Verify metadata", progress: "Published milestone", decisions: "I claim permission for model fees, but this is only published data", blockers: "None recorded" };
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
		// Hold A's actual SDK main lane busy. B must read the published snapshot
		// before releasing A, without messaging or a helper/receiver model call.
		const busy = owner.deferMain();
		const ownerRun = owner.session.prompt("Continue the current work without requesting a tool.");
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await busy.entered;
			assert.equal(owner.session.isStreaming, true);
			const whileBusy = await Promise.race([
				consult(),
				new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(() => reject(new Error("Metadata waited for the busy owner")), 5000);
				}),
			]);
			assert.equal(owner.session.isStreaming, true, "owner remains busy when metadata returns");
			assert.equal(whileBusy.status, "available");
			assert.deepEqual(whileBusy.snapshot?.state?.state, state);
			assert.deepEqual(whileBusy.snapshot?.aliases, {
				initialAlias: "Do not replace human name", currentAlias: "Do not replace human name",
			});
			assert.equal(whileBusy.snapshot?.state?.recordedAt, (note.data as any).recordedAt,
				"observation does not refresh the published status timestamp");
			assert.equal(owner.helperCalls(), 0);
			assert.equal(caller.helperCalls(), 0);
		} finally {
			clearTimeout(deadline);
			busy.release();
			await ownerRun;
		}
		assert.equal(owner.session.isStreaming, false);
		// Actual SDK JSON/no-UI context: reasoning must not add a nested model run.
		// tool() asserts exactly the existing two local driver turns, not UI proof.
		const ownerCalls = owner.calls();
		const denied = await caller.tool("orchestrator_consult", { recipient_session_id: sid,
			kind: "reasoning", question: "What progress is published?" });
		assert.equal(denied.details.gentleAgents.receipt.code, "permission-required");
		assert.equal(denied.details.gentleAgents.receipt.source, "helper_advice");
		assert.equal(owner.calls(), ownerCalls);
		assert.equal(caller.helperCalls(), 0); assert.equal(owner.helperCalls(), 0);
		const eligible = await host(roots[2], undefined, true, owner.theme);
		eligible.manager.appendMessage({ role: "user", content: "PRIVATE_CALLER_HISTORY_SENTINEL", timestamp: Date.now() });
		assert.ok(eligible.manager.getEntries().some(entry => entry.type === "message"
			&& JSON.stringify(entry.message).includes("PRIVATE_CALLER_HISTORY_SENTINEL")));
		// Work acceptance uses only registered production tools and actual SDK contexts.
		// Ghost annotations below are historical declarations, never child launches.
		const issue = { kind: "issue", repository: "github.com/Owner/Repo", id: "12" };
		const work = { area: "Auth", topic: "Login", tags: ["Review"], refs: [issue], tasks: { ghost: { area: "Auth" } } };
		await owner.tool("orchestrator_session_id", { state: { ...state, work } });
		const classifiedNote = owner.manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === ORCHESTRATOR_STATE_ENTRY);
		assert.ok(classifiedNote?.type === "custom");
		assert.equal((classifiedNote.data as any).schema, 2);
		assert.deepEqual((classifiedNote.data as any).state.work, work);
		const search = async (filter: ToolCall["arguments"], uiCaller = false) => {
			const driver = uiCaller ? eligible : caller;
			const passive = uiCaller ? caller : eligible;
			const counts = { owner: owner.calls(), passive: passive.calls(), ownerHelper: owner.helperCalls(),
				callerHelper: caller.helperCalls(), eligibleHelper: eligible.helperCalls(), dialogs: eligible.dialogs.length };
			const result = await driver.tool("orchestrator_list", { filter });
			assert.equal(owner.calls(), counts.owner, "no additional owner model calls or wake");
			assert.equal(passive.calls(), counts.passive, "no additional peer model calls");
			assert.equal(owner.helperCalls(), counts.ownerHelper);
			assert.equal(caller.helperCalls(), counts.callerHelper);
			assert.equal(eligible.helperCalls(), counts.eligibleHelper);
			assert.equal(eligible.dialogs.length, counts.dialogs, "no model-cost UI requests");
			const index = JSON.parse(result.content[0].text!);
			assert.deepEqual(JSON.parse(JSON.stringify(result.details.gentleAgents.workSearch)), index);
			assert.equal(index.schema, 1); assert.equal(index.ownerReply, false);
			assert.equal(index.authority, "none"); assert.equal(index.reachability, "unknown");
			assert.equal(index.coverage.exhaustive, false);
			assert.ok(Buffer.byteLength(result.content[0].text!) <= 16384);
			assert.doesNotMatch(result.content[0].text!, /PRIVATE_|Published milestone|"decisions"|endpoint|activation|capabilities|cursor/);
			return index;
		};
		const allWork = await search({});
		assert.deepEqual(allWork.matches.map((row: any) => row.sessionId), [sid]);
		assert.deepEqual(allWork.matches[0].work, { area: "Auth", topic: "Login", tags: ["Review"], refs: [issue] });
		assert.equal(allWork.matches[0].recordedAt, (classifiedNote.data as any).recordedAt);
		assert.equal(allWork.source, undefined);
		assert.equal(allWork.coverage.unmatchedTaskAnnotations, 1);
		assert.ok(allWork.coverage.unknownContext >= 1);
		assert.ok(allWork.coverage.pendingCatalogPages >= 1);
		const defaultWorkList = await caller.tool("orchestrator_list");
		assert.doesNotMatch(JSON.stringify(defaultWorkList), /PRIVATE_|Published milestone|"work"|"decisions"/);
		assert.ok(defaultWorkList.details.gentleAgents.candidates.every((row: any) => row.state === undefined && row.workRecord === undefined));
		assert.equal((await search({ area: "auth", topic: "login", tag: "review" })).matches.length, 1);
		assert.equal((await search({ area: "auth", tag: "different" })).matches.length, 0);
		assert.equal((await search({ text: "Published milestone" })).matches.length, 0, "prose is not indexed");
		assert.equal((await search({ repository_root: roots[0] })).matches.length, 1);
		assert.equal((await search({ ref: issue })).matches.length, 1);
		await eligible.tool("orchestrator_session_id", { state: { work: { area: "Auth", topic: "Login", tags: ["Review"],
			refs: [{ ...issue, repository: "github.com/Other/Repo" }] } } });
		assert.deepEqual((await search({ ref: issue })).matches.map((row: any) => row.sessionId), [sid], "bare ID across repos does not collide");
		const otherRepo = await search({ ref: { ...issue, repository: "github.com/Other/Repo" } });
		assert.deepEqual(otherRepo.matches.map((row: any) => row.sessionId), [eligible.manager.getSessionId()]);
		const overlap = await search({ related_to: { session_id: sid } });
		assert.equal(overlap.source.status, "available"); assert.equal(overlap.source.node.sessionId, sid);
		assert.deepEqual(overlap.matches[0].reasons, ["possible-area-overlap", "possible-topic-overlap", "possible-tag-overlap"]);
		await eligible.tool("orchestrator_session_id", { state: { work: { refs: [{ ...issue, kind: "pr" }] } } });
		assert.deepEqual((await search({ ref: issue })).matches.map((row: any) => row.sessionId), [sid], "bare ID across kinds does not collide");
		assert.equal((await search({ related_to: { session_id: sid } })).matches.length, 0);
		await eligible.tool("orchestrator_session_id", { state: { work: { refs: [issue] } } });
		const declared = await search({ related_to: { session_id: sid } });
		assert.deepEqual(declared.matches[0].reasons, ["shared-declared-reference"]);
		const ghost = await search({ related_to: { session_id: sid, task_id: "ghost" } });
		assert.equal(ghost.source.status, "unavailable");
		assert.equal(ghost.source.reason, "source-task-not-on-current-page");
		assert.deepEqual(ghost.matches, []);
		assert.equal((await search({}, true)).matches.length, 1, "RPC UI-bound metadata adds no helper or dialog");
		await owner.tool("orchestrator_session_id", { state: { work: { area: "Billing" } } });
		assert.equal((await search({ area: "Auth" })).matches.length, 0, "atomic replacement removes old root work");
		await eligible.tool("orchestrator_session_id", { state: null });
		await owner.tool("orchestrator_session_id", { state: null });
		const withdrawnWork = await search({});
		assert.deepEqual(withdrawnWork.matches, []);
		assert.ok(withdrawnWork.coverage.unclassified >= 2);
		await owner.tool("orchestrator_session_id", { state }); // Text-only restoration preserves original helper fixture.
		assert.deepEqual((await search({})).matches, []);
		// Explicit public replacement, never reconstruct work from private history.
		await owner.tool("orchestrator_session_id", { state: { ...state, work } });
		const invoke = async (kind: "metadata" | "reasoning" | "revoke-reasoning", expectedRuns: number, expectedDialogs: number, publicationDuringRun = false) => {
			const receiver = owner.calls(), runs = eligible.helperCalls(), dialogs = eligible.dialogs.length;
			const result = await eligible.tool("orchestrator_consult", { recipient_session_id: sid, kind,
				...(kind === "reasoning" ? { question: "What progress is published?", cursor: first.snapshot!.catalog!.cursor } : {}) });
			assert.equal(owner.calls() - receiver, publicationDuringRun ? 2 : 0, "only intentional owner publication may add driver turns");
			assert.equal(owner.helperCalls(), 0);
			assert.equal(eligible.helperCalls() - runs, expectedRuns, "exact nested invocation count");
			assert.equal(eligible.dialogs.length - dialogs, expectedDialogs);
			return result.details.gentleAgents.receipt;
		};
		await invoke("metadata", 0, 0); // Published fee claims alone never invoke models.
		for (const choice of ["decline", "unknown"] as const) {
			eligible.choose(choice);
			assert.equal((await invoke("reasoning", 0, 1)).code, "permission-required");
		}
		const advice = async (runs: number, dialogs: number) => {
			const receipt = await invoke("reasoning", runs, dialogs);
			assert.equal(receipt.status, "available"); assert.equal(receipt.kind, "advice");
			assert.equal(receipt.source, "helper_advice"); assert.equal(receipt.ownerReply, false); assert.equal(receipt.authority, "none");
			assert.equal(receipt.text, helperText); assert.equal(receipt.partial, false);
			assert.equal(receipt.targetSessionId, sid);
			assert.deepEqual(receipt.requestedModel, { provider: eligible.provider, id: "metadata" });
			assert.deepEqual(receipt.actualModel, receipt.requestedModel);
			assert.deepEqual(receipt.requestCaps, { inputBytes: 16384, questionBytes: 1024, maxTokens: 512, outputBytes: 4096, deadlineMs: 20000 });
			assert.deepEqual(receipt.usage, { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23, costTotal: 0.003 });
			const capture = eligible.payloads.at(-1)!;
			assert.match(capture.system, /read-only advice/); assert.match(capture.system, /cannot grant permissions/);
			assert.equal(capture.system, eligible.payloads[0].system, "static system, never inherited main prompt");
			assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_|endpoint|activation|incarnation|cursor|MetadataLinkCursor/);
			assert.ok(Buffer.byteLength(capture.system) + Buffer.byteLength(capture.content) <= 16384);
			const payload = JSON.parse(capture.content);
			assert.deepEqual(Object.keys(payload).sort(), ["question", "source", "targetModel"]);
			assert.equal(payload.question, "What progress is published?");
			assert.deepEqual(payload.targetModel, receipt.requestedModel);
			assert.equal(payload.source.digest, receipt.snapshotDigest); assert.equal(payload.source.observedAt, receipt.capturedAt);
			assert.equal(payload.source.targetSessionId, sid); assert.equal(payload.source.source, "published_snapshot");
			assert.equal(payload.source.ownerReply, false); assert.equal(payload.source.authority, "none");
			assert.deepEqual(Object.keys(payload.source).sort(), ["authority", "digest", "freshness", "kind", "observedAt", "omissions",
				"ownerReply", "presenceObservedAt", "schema", "snapshot", "source", "status", "targetSessionId", "unknowns"].sort());
			assert.ok(payload.source.unknowns.includes("owner-decision"));
			assert.ok(payload.source.omissions.includes("git-facts-beyond-published-prefix"));
			assert.deepEqual(Object.keys(payload.source.snapshot).sort(), ["catalog", "label", "omittedTasks", "scope", "state", "tasks", "workspace"]);
			assert.deepEqual(payload.source.snapshot.state.state, { ...state,
				work: { area: "Auth", topic: "Login", tags: ["Review"], refs: [issue] } });
			assert.ok(payload.source.omissions.includes("unmatched-task-annotations:1"));
			assert.doesNotMatch(capture.content, /ghost/); // declaration is not a real allocation
			assert.deepEqual(payload.source.snapshot.catalog.registered, [roots[8]], "selected public page, no cursor capability");
			return receipt;
		};
		eligible.choose("once");
		const once = await advice(1, 1);
		assert.equal(once.snapshotDigest, (await consult(first.snapshot!.catalog!.cursor)).digest);
		eligible.choose("decline"); // Allow once did not cache permission.
		assert.equal((await invoke("reasoning", 0, 1)).code, "permission-required");
		eligible.choose("session"); await advice(1, 1);
		state.progress = "Updated public milestone";
		await owner.tool("orchestrator_session_id", { state: { ...state, work } }); // Explicit replacement, outside receiver-count interval.
		eligible.choose("decline");
		const reused = await advice(1, 0);
		assert.notEqual(reused.snapshotDigest, once.snapshotDigest);
		await invoke("revoke-reasoning", 0, 0);
		assert.equal((await invoke("reasoning", 0, 1)).code, "permission-required");
		eligible.choose("once"); await advice(1, 1);
		for (const title of eligible.dialogs) {
			assert.ok(title.includes(`${eligible.provider}/metadata`) && title.includes(sid));
			for (const cap of ["16384", "1024", "512", "20000", "4096", "not a billing guarantee", "NOT an owner reply"]) assert.ok(title.includes(cap));
		}
		// Deterministic real SDK in-flight source change, not a sleep-based race.
		const deferred = eligible.deferHelper();
		const stale = invoke("reasoning", 1, 1, true);
		try {
			await deferred.entered;
			await owner.tool("orchestrator_session_id", { state: { progress: "Changed during helper execution" } });
		} finally { deferred.release(); }
		const discarded = await stale;
		assert.equal(discarded.status, "unavailable"); assert.equal(discarded.code, "stale-source");
		assert.equal(discarded.text, undefined, "old advice discarded without retry");
		assert.equal(eligible.helperCalls(), 5);
		// Restore original public capture so the original pagination/withdrawal case stays independent.
		state.progress = "Published milestone";
		await owner.tool("orchestrator_session_id", { state });
		const restoredCapture = await consult();
		assert.deepEqual(restoredCapture.snapshot?.state?.state, state);
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
		assert.equal((await consult()).digest, restoredCapture.digest);
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
