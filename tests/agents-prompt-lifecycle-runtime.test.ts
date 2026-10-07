import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

// Real-host proof of the Gentle Agents -> parent delivery paths (#1528, #1631).
//
// A fake pi object can only prove what the fake models, and #1631 shipped
// without a real-host reproduction. This file drives the real Pi AgentSession
// with a scripted faux provider and asserts the one invariant prompt-capture
// integrations (the Claude bridge) depend on: every provider request carries
// what `before_agent_start` appended to the system prompt. A turn started
// through sendMessage(triggerTurn) on an idle host skips that event and so
// lacks it. Native providers may continue through a hidden custom-message turn
// by design, so the faux provider is registered as `claude-bridge`, the
// selection that requires the prompt lifecycle.

const MARKER = "PROMPT-LIFECYCLE-MARKER-7f3a";
const ORCHESTRATOR_TEXT = "orchestrator-says-ping-91c2";
const COMPLETION_TEXT = "child-completion-body-4b8e";
const BOUND_MS = 5000;

interface RecordedRequest {
	system: string;
	conversation: string;
	summarization: boolean;
}

interface Notification {
	id: string;
	senderSessionId: string;
	message: string;
}

const textOf = (content: unknown): string => typeof content === "string"
	? content
	: Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n") : "";

const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
};

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

interface Host {
	session: AgentSession;
	requests: RecordedRequest[];
	beforeAgentStarts: string[];
	children: FakeChild[];
	notify(message: string): Promise<void>;
	/** Hold the next non-summarization (summarization when `summary`) provider response until released. */
	hold(kind: "turn" | "summary"): { reached: Promise<void>; release(): void };
	/** Park the next user input inside a probe `input` handler, i.e. in the prompt's pre-run phase. */
	holdInput(): { reached: Promise<void>; release(): void };
	until(label: string, condition: () => boolean): Promise<void>;
	settleChild(index: number, text: string): Promise<void>;
	launchBackgroundChild(task: string): Promise<void>;
	errors: unknown[];
}

async function createHost(t: TestContext): Promise<Host> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-agents-lifecycle-")));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const agentDir = join(home, ".pi", "agent");
	for (const path of [cwd, join(agentDir, "agents")]) mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd });
	writeFileSync(join(agentDir, "agents", "explore.md"), "---\ndescription: maps things\ntools: [read, grep]\n---\nYou map things.");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const faux = fauxProvider({ provider: "claude-bridge" });
	const requests: RecordedRequest[] = [];
	const holds: Array<{ kind: "turn" | "summary"; reached: () => void; released: Promise<void> }> = [];
	const respond: FauxResponseFactory = async (context) => {
		const system = context.messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
		const conversation = context.messages.filter((message) => message.role !== "system").map((message) => textOf(message.content)).join("\n");
		const summarization = /summar/i.test(system) || /<conversation>/.test(conversation);
		requests.push({ system, conversation, summarization });
		// Requeue first: a request held below must not starve a concurrent one.
		faux.appendResponses([respond]);
		const held = holds.findIndex((entry) => entry.kind === (summarization ? "summary" : "turn"));
		if (held >= 0) {
			const [entry] = holds.splice(held, 1);
			entry!.reached();
			await entry!.released;
		}
		return fauxAssistantMessage(summarization ? "## Summary\nnothing important" : "acknowledged");
	};
	faux.setResponses([respond]);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "faux-key");
	const model = faux.getModel();

	const children: FakeChild[] = [];
	let listener: ((notification: Notification) => Promise<void>) | undefined;
	const sessionTransport: SessionTransportFactory = {
		createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
		createListener: (registry, _sessionId, received) => {
			listener = received;
			return { registry, start: async () => {}, close: async () => {} };
		},
		createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("the lifecycle host never sends notifications"); } }),
	};
	const beforeAgentStarts: string[] = [];
	const inputHolds: Array<{ reached: () => void; released: Promise<void> }> = [];
	const probe = (pi: ExtensionAPI) => {
		pi.on("before_agent_start", (event) => {
			beforeAgentStarts.push(event.prompt);
			return { systemPrompt: `${event.systemPrompt}\n${MARKER}` };
		});
	};
	let clock = 1000;
	const env = { PATH: process.env.PATH ?? "/bin" };
	// Input handlers run in extension order, so the gate sits after Gentle Agents:
	// its `input` handler has already run while the prompt stays parked.
	const inputGate = (pi: ExtensionAPI) => {
		pi.on("input", async () => {
			const entry = inputHolds.shift();
			if (entry) {
				entry.reached();
				await entry.released;
			}
			return { action: "continue" };
		});
	};
	const agents = (pi: ExtensionAPI) => gentleAgents(pi, env, {
		home,
		agentHome: agentDir,
		env,
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
		now: () => (clock += 500),
		// Real, unref'd timers: the compaction boundary flush runs on the host's
		// own clock instead of being driven by hand.
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			timer.unref();
			return () => clearTimeout(timer);
		},
		pi: { command: "pi", args: [] },
		resolveWorktree: () => undefined,
		sessionTransport,
		runtimeMetricsPolicy: { resolve: () => { throw new Error("Policy not configured in fixture"); } },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [probe, agents, inputGate],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, model, resourceLoader, noTools: "builtin",
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } }),
	});
	t.after(async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	await session.bindExtensions({ mode: "rpc" });

	const until = async (label: string, condition: () => boolean) => {
		const deadline = Date.now() + BOUND_MS;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	await until("the session transport listener", () => listener !== undefined);

	const errors: unknown[] = [];
	const tool = (name: string) => {
		const found = session.agent.state.tools.find((candidate) => candidate.name === name);
		assert.ok(found, `the real host exposes ${name}`);
		return found;
	};
	return {
		session, requests, beforeAgentStarts, children, errors, until,
		notify: async (message) => { await listener!({ id: "n1", senderSessionId: "peer-session", message }); },
		hold: (kind) => {
			const reached = deferred();
			const released = deferred();
			holds.push({ kind, reached: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: released.resolve };
		},
		holdInput: () => {
			const reached = deferred();
			const released = deferred();
			inputHolds.push({ reached: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: released.resolve };
		},
		launchBackgroundChild: async (task) => {
			await tool("subagent_run").execute("launch", { agent: "explore", task, mode: "background" });
			await until("the fake child spawn", () => children.length > 0);
		},
		settleChild: async (index, text) => {
			children[index]!.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
			children[index]!.emit({ type: "agent_settled" });
		},
	};
}

// The invariant itself: no provider request outside compaction's own
// summarization call may lack what before_agent_start added.
const mainRequests = (host: Host) => host.requests.filter((request) => !request.summarization);
const assertEveryTurnCarriesTheMarker = (host: Host) => {
	assert.ok(mainRequests(host).length > 0, "the parent made at least one provider request");
	for (const [index, request] of mainRequests(host).entries()) {
		assert.ok(request.system.includes(MARKER), `provider request ${index} must carry the before_agent_start system prompt marker`);
	}
};

test("a child completion delivered to an idle parent starts a marked turn that shows the completion once", async (t) => {
	const host = await createHost(t);
	await host.launchBackgroundChild("report back");
	await host.settleChild(0, COMPLETION_TEXT);
	await host.until("the woken turn", () => mainRequests(host).length === 1 && host.session.isIdle);
	assertEveryTurnCarriesTheMarker(host);
	const request = mainRequests(host)[0]!;
	assert.equal(occurrences(request.conversation, COMPLETION_TEXT), 1, "the completion reaches the model exactly once");
	assert.equal(host.beforeAgentStarts.length, 1, "the wake went through the prompt lifecycle");
});

test("an orchestrator session message to an idle parent starts a marked turn", async (t) => {
	const host = await createHost(t);
	await host.notify(ORCHESTRATOR_TEXT);
	await host.until("the message turn", () => mainRequests(host).length >= 1 && host.session.isIdle);
	assertEveryTurnCarriesTheMarker(host);
	assert.equal(occurrences(mainRequests(host).map((request) => request.conversation).join("\n"), ORCHESTRATOR_TEXT) > 0, true, "the model saw the orchestrator message");
	assert.equal(host.beforeAgentStarts.length >= 1, true, "the message went through the prompt lifecycle");
});

test("an orchestrator session message during an active run joins that run as a follow-up", async (t) => {
	const host = await createHost(t);
	const firstTurn = host.hold("turn");
	const prompt = host.session.prompt("start a long run");
	await firstTurn.reached;
	assert.equal(host.session.isStreaming, true, "the parent run is active");
	await host.notify(ORCHESTRATOR_TEXT);
	firstTurn.release();
	await prompt;
	await host.until("the follow-up turn", () => mainRequests(host).length >= 2 && host.session.isIdle);
	assertEveryTurnCarriesTheMarker(host);
	assert.equal(mainRequests(host).length, 2, "the message is one more turn of the same run");
	assert.equal(occurrences(mainRequests(host)[0]!.conversation, ORCHESTRATOR_TEXT), 0);
	assert.equal(occurrences(mainRequests(host)[1]!.conversation, ORCHESTRATOR_TEXT), 1);
	assert.equal(host.beforeAgentStarts.length, 1, "no second run started");
});

test("an orchestrator session message during compaction without a run waits for the boundary, then starts a marked turn", async (t) => {
	const host = await createHost(t);
	await host.session.prompt("seed the transcript");
	await host.session.prompt("seed it once more");
	const baseline = mainRequests(host).length;
	const summary = host.hold("summary");
	const compaction = host.session.compact();
	await summary.reached;
	assert.equal(host.session.isIdle, false, "the host reports compaction as busy");
	assert.equal(host.session.isStreaming, false, "there is no agent run while compacting");
	await host.notify(ORCHESTRATOR_TEXT);
	// Give a wrongly started direct turn every chance to reach the provider.
	for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(mainRequests(host).length, baseline, "no provider request is issued for the message while compaction runs");
	summary.release();
	await compaction;
	await host.until("the delivered message turn", () => mainRequests(host).length > baseline && host.session.isIdle);
	assertEveryTurnCarriesTheMarker(host);
	assert.equal(occurrences(mainRequests(host).slice(baseline).map((request) => request.conversation).join("\n"), ORCHESTRATOR_TEXT) > 0, true, "the model saw the message after compaction");
});

// `/tree` branch summarization makes the host busy without an agent run, like
// compaction, but it ends with `session_tree` (or with no event at all when it
// is cancelled). Held content must reach the parent without waiting for an
// unrelated user prompt.
const startBranchSummary = async (host: Host) => {
	await host.session.prompt("seed the transcript");
	await host.session.prompt("seed it once more");
	const baseline = mainRequests(host).length;
	const target = host.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(target, "the transcript has an earlier user entry to navigate to");
	const summary = host.hold("summary");
	const navigation = host.session.navigateTree(target.id, { summarize: true });
	await summary.reached;
	assert.equal(host.session.isIdle, false, "the host reports branch summarization as busy");
	assert.equal(host.session.isStreaming, false, "there is no agent run while summarizing a branch");
	return { baseline, summary, navigation };
};
const assertDeliveredThroughMarkedTurn = async (host: Host, baseline: number, text: string) => {
	await host.until("the delivered turn", () => mainRequests(host).length > baseline && host.session.isIdle);
	assertEveryTurnCarriesTheMarker(host);
	assert.equal(occurrences(mainRequests(host).slice(baseline).map((request) => request.conversation).join("\n"), text) > 0, true, "the model saw the held content");
};

test("content held during /tree branch summarization is delivered through a marked turn once it completes", async (t) => {
	const host = await createHost(t);
	await host.launchBackgroundChild("report back");
	const { baseline, summary, navigation } = await startBranchSummary(host);
	await host.notify(ORCHESTRATOR_TEXT);
	await host.settleChild(0, COMPLETION_TEXT);
	for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(mainRequests(host).length, baseline, "no provider request is issued while the branch is summarized");
	summary.release();
	assert.equal((await navigation).cancelled, false);
	await assertDeliveredThroughMarkedTurn(host, baseline, ORCHESTRATOR_TEXT);
	assert.equal(occurrences(mainRequests(host).slice(baseline).map((request) => request.conversation).join("\n"), COMPLETION_TEXT) > 0, true, "the child completion arrives too");
});

test("content held during a cancelled /tree branch summarization is delivered through a marked turn within a bounded time", async (t) => {
	const host = await createHost(t);
	const { baseline, summary, navigation } = await startBranchSummary(host);
	await host.notify(ORCHESTRATOR_TEXT);
	host.session.abortBranchSummary();
	summary.release();
	const outcome = await navigation;
	assert.equal(outcome.cancelled, true, "the summarization was cancelled, which emits no session_tree");
	await assertDeliveredThroughMarkedTurn(host, baseline, ORCHESTRATOR_TEXT);
});

// A user prompt is "starting" from `input` until `before_agent_start`, while
// the host still reports idle. Content arriving in that window must not race
// the user's prompt with a wake prompt: both would reach Agent.prompt().
const USER_PROMPT = "user-prompt-in-pre-run-phase-2d5f";

test("child content arriving while a user prompt is in its pre-run phase rides that prompt's run without a racing wake", async (t) => {
	const host = await createHost(t);
	await host.launchBackgroundChild("report back");
	const gate = host.holdInput();
	const prompt = host.session.prompt(USER_PROMPT).then(() => undefined, (error: unknown) => { host.errors.push(error); });
	await gate.reached;
	assert.equal(host.session.isIdle, true, "the host still reports idle in the pre-run phase");
	// Whichever prompt starts a run first is parked in its provider request, so
	// the other one meets a busy agent exactly as in the real race.
	const turn = host.hold("turn");
	await host.settleChild(0, COMPLETION_TEXT);
	for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
	gate.release();
	await turn.reached;
	for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
	turn.release();
	await prompt;
	await host.until("the run to settle", () => mainRequests(host).length >= 1 && host.session.isIdle);
	for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(host.errors, [], "no caller sees a concurrent-prompt error");
	assertEveryTurnCarriesTheMarker(host);
	assert.equal(host.beforeAgentStarts.length, 1, "exactly one run starts");
	assert.equal(host.beforeAgentStarts[0], USER_PROMPT, "the single run is the user's prompt");
	const conversation = mainRequests(host).map((request) => request.conversation).join("\n");
	assert.equal(occurrences(conversation, USER_PROMPT) > 0, true, "the user's prompt reaches the provider");
	assert.equal(occurrences(mainRequests(host)[0]!.conversation, COMPLETION_TEXT), 1, "the stored completion reaches the provider in the user's run");
});
