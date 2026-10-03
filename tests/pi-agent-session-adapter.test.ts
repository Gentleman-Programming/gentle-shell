import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { preparePiAgentSession } from "../lib/agent-runtime/pi-agent-session-adapter.ts";

const validSpecification = () => ({
	ownerCwd: "/synthetic/owner",
	systemPrompt: "SYNTHETIC_PROMPT",
	model: {},
	modelRegistry: {},
	thinkingLevel: "high",
	tools: ["read", "grep"],
});

type Calls = {
	factory: number;
	dispose: number;
	prompt: number;
	subscribe: number;
	options?: Record<string, unknown>;
};

function createSession(calls: Calls, changes: Record<string, unknown> = {}) {
	return Object.assign({
		dispose: () => calls.dispose++,
		prompt: () => calls.prompt++,
		getActiveToolNames: () => ["grep", "read"],
		agent: { subscribe: () => calls.subscribe++ },
		sessionFile: undefined,
	}, changes);
}

function createFactory(calls: Calls, value: unknown) {
	return async (options: Record<string, unknown>) => {
		calls.factory++;
		calls.options = options;
		return value;
	};
}

const DEFAULT_FACTORY_RESULT = Symbol("default-factory-result");

async function prepare(input: unknown = validSpecification(), ...factoryResults: unknown[]) {
	const calls: Calls = { factory: 0, dispose: 0, prompt: 0, subscribe: 0 };
	const session = createSession(calls);
	const value = factoryResults.length === 0 ? DEFAULT_FACTORY_RESULT : factoryResults[0];
	const result = await preparePiAgentSession(input, createFactory(calls, value === DEFAULT_FACTORY_RESULT ? { session } : value) as never);
	return { calls, result, session };
}

test("rejects exact plain specifications without reading accessors or calling Pi", async () => {
	const accessor = { ...validSpecification() };
	Object.defineProperty(accessor, "ownerCwd", { enumerable: true, get: () => { throw new Error("read"); } });
	const rejected: unknown[] = [
		null,
		[],
		Object.create(validSpecification()),
		{ ...validSpecification(), extra: "not-read" },
		{ ...validSpecification(), [Symbol("extra")]: true },
		accessor,
		{ ...validSpecification(), ownerCwd: "relative" },
		{ ...validSpecification(), ownerCwd: "/nul\0" },
		{ ...validSpecification(), systemPrompt: " " },
		{ ...validSpecification(), model: [] },
		{ ...validSpecification(), modelRegistry: [] },
		{ ...validSpecification(), thinkingLevel: "maximum" },
		{ ...validSpecification(), tools: ["read", "read"] },
		{ ...validSpecification(), tools: ["unknown"] },
	];
	for (const input of rejected) {
		const { calls, result } = await prepare(input);
		assert.deepEqual(result, { kind: "failed", code: "invalid-spec" });
		assert.equal(calls.factory, 0);
		assert.ok(Object.isFrozen(result));
	}
	const nullPrototype = Object.assign(Object.create(null), validSpecification());
	assert.equal((await prepare(nullPrototype)).result.kind, "ready");
	assert.equal((await prepare({ ...validSpecification(), ownerCwd: "C:\\owner" })).result.kind, "ready");
	assert.equal((await prepare({ ...validSpecification(), ownerCwd: "\\\\server\\owner" })).result.kind, "ready");
	assert.equal((await prepare(new Proxy(validSpecification(), { ownKeys: () => { throw new Error("hostile"); } }))).result.code, "invalid-spec");
	const revoked = Proxy.revocable(validSpecification(), {});
	revoked.revoke();
	assert.equal((await prepare(revoked.proxy)).result.code, "invalid-spec");
});

test("uses isolated local Pi 0.74 options and an empty resource loader", async () => {
	const input = validSpecification();
	const { calls, result } = await prepare(input);
	assert.equal(result.kind, "ready");
	assert.equal(calls.factory, 1);
	const options = calls.options!;
	assert.deepEqual(Object.keys(options).sort(), ["customTools", "cwd", "model", "modelRegistry", "resourceLoader", "sessionManager", "settingsManager", "thinkingLevel", "tools"]);
	assert.equal(options.cwd, input.ownerCwd);
	assert.equal(options.model, input.model);
	assert.equal(options.modelRegistry, input.modelRegistry);
	assert.deepEqual(options.tools, ["read", "grep"]);
	assert.notEqual(options.tools, input.tools);
	assert.deepEqual(options.customTools, []);
	assert.ok(Object.isFrozen(options));
	assert.ok(Object.isFrozen(options.tools));
	const loader = options.resourceLoader as Record<string, () => unknown>;
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
	assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
	assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
	assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
	assert.equal(loader.getSystemPrompt(), input.systemPrompt);
	assert.deepEqual(loader.getAppendSystemPrompt(), []);
	assert.equal(loader.extendResources(), undefined);
	await loader.reload();
	const empty = await prepare({ ...validSpecification(), tools: [] });
	assert.equal(empty.calls.options!.noTools, "all");
});

test("classifies factory and manager failures without cleanup or private output", async () => {
	const throwingSessionGetter = Object.defineProperty({}, "session", { get: () => { throw new Error("hostile"); } });
	for (const result of [null, undefined, 1, {}, { session: null }, { session: 1 }, throwingSessionGetter, new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("hostile"); } })]) {
		const { calls, result: prepared } = await prepare(validSpecification(), result);
		assert.deepEqual(prepared, { kind: "failed", code: "session-creation-failed" });
		assert.equal(calls.factory, 1);
		assert.equal(calls.dispose, 0);
	}
	const calls: Calls = { factory: 0, dispose: 0, prompt: 0, subscribe: 0 };
	const factory = async () => { calls.factory++; throw new Error("private detail"); };
	assert.equal((await preparePiAgentSession(validSpecification(), factory as never)).code, "session-creation-failed");
	assert.equal(calls.dispose, 0);
});

test("acquires each capability once, cleans invalid sessions, and preserves exact ready identity", async () => {
	for (const changes of [{ dispose: undefined }, { dispose: 1 }]) {
		const calls: Calls = { factory: 0, dispose: 0, prompt: 0, subscribe: 0 };
		const result = await preparePiAgentSession(validSpecification(), createFactory(calls, { session: createSession(calls, changes) }) as never);
		assert.equal(result.code, "cleanup-failed");
		assert.equal(calls.dispose, 0);
	}
	for (const changes of [{ prompt: undefined }, { getActiveToolNames: () => ["read"] }, { agent: null }, { sessionFile: "/persisted" }]) {
		const calls: Calls = { factory: 0, dispose: 0, prompt: 0, subscribe: 0 };
		const result = await preparePiAgentSession(validSpecification(), createFactory(calls, { session: createSession(calls, changes) }) as never);
		assert.equal(result.code, "session-contract-failed");
		assert.equal(calls.dispose, 1);
	}
	const calls: Calls = { factory: 0, dispose: 0, prompt: 0, subscribe: 0 };
	const reads = { dispose: 0, prompt: 0, active: 0, agent: 0, subscribe: 0, file: 0 };
	const session = {} as Record<string, unknown>;
	Object.defineProperties(session, {
		dispose: { get: () => { reads.dispose++; return () => calls.dispose++; } },
		prompt: { get: () => { reads.prompt++; return () => calls.prompt++; } },
		getActiveToolNames: { get: () => { reads.active++; return () => ["read", "grep"]; } },
		agent: { get: () => { reads.agent++; return { get subscribe() { reads.subscribe++; return () => calls.subscribe++; } }; } },
		sessionFile: { get: () => { reads.file++; return undefined; } },
	});
	const result = await preparePiAgentSession(validSpecification(), createFactory(calls, { session }) as never);
	assert.equal(result.kind, "ready");
	assert.equal(result.session, session);
	assert.ok(Object.isFrozen(result));
	assert.deepEqual(reads, { dispose: 1, prompt: 1, active: 1, agent: 1, subscribe: 1, file: 1 });
	assert.deepEqual(calls, { factory: 1, dispose: 0, prompt: 0, subscribe: 0, options: calls.options });
	const broken = createSession(calls, { getActiveToolNames: () => { throw new Error("private"); }, dispose: () => { calls.dispose++; throw new Error("private"); } });
	assert.equal((await preparePiAgentSession(validSpecification(), createFactory(calls, { session: broken }) as never)).code, "cleanup-failed");
});

test("uses only public Pi imports and never starts a ready lifecycle", () => {
	const source = readFileSync(fileURLToPath(new URL("../lib/agent-runtime/pi-agent-session-adapter.ts", import.meta.url)), "utf8");
	assert.match(source, /from "@earendil-works\/pi-coding-agent"/);
	assert.match(source, /let options: CreateAgentSessionOptions;\s+let result: unknown;\s+try \{\s+options = createOptions\(specification\);\s+result = await \(injectedCreateSession \?\? createAgentSession\)\(options\);/s);
	assert.doesNotMatch(source, /console\.|agent-runtime\.ts|subagent_run|\.prompt\(|\.subscribe\(/i);
});
