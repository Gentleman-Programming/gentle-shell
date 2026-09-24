import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { parseAgentClass } from "../lib/runtime-metrics.ts";
import { parseAgentDefinition, type AgentDefinition } from "../lib/agents-config.ts";
import { normalizeRpcEvent, TASK_EVENT } from "../lib/agents-protocol.ts";
import { ChildComposition, childEvent, classifyBuiltinAgent, launchSelection } from "../lib/runtime-metrics-children.ts";
import { encodeNativeRuntimeEvent } from "../lib/runtime-metrics-native.ts";

const asset = new URL("../assets/agents/gentle-ai-worker.md", import.meta.url);
const definition = parseAgentDefinition(readFileSync(asset, "utf8"), asset.pathname, "global");
assert.ok("instructions" in definition);
const workerDefinition = definition as AgentDefinition;
const response = (model = "gpt-4o", native = "low") => {
	const events = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", provider: "openai",
		model, responseModel: model, providerThinkingLevel: native, stopReason: "stop", usage: { input: 3, output: 2, reasoning: 1 } } }, { observeResponses: true });
	const event = events.find(event => event.type === TASK_EVENT.RESPONSE_OBSERVATION);
	assert.ok(event?.type === TASK_EVENT.RESPONSE_OBSERVATION);
	return event.observation;
};
const launch = () => launchSelection(workerDefinition, { provider: "openai", id: "gpt-4o" }, "high");
const event = (taskId = "local-task") => childEvent("local-session", taskId, launch(), "completed", {
	coverage: "final_assistant_messages_only", agentSettled: true, responses: [response(), response("gpt-4o-mini", "high")], droppedResponses: 2,
});

test("installed package definitions retain classification after the actual routing transform", () => {
	// installSddAssets/copyDirectoryFiles copies assets verbatim on first install.
	// Isolate the real pure routing writer; do not run an installer or read user agents.
	const source = readFileSync(new URL("../extensions/gentle-ai.ts", import.meta.url), "utf8");
	const transform = source.match(/function updateFrontmatterRouting\([\s\S]*?\n\}/)?.[0];
	assert.ok(transform);
	const route = runInNewContext(`(${stripTypeScriptTypes(transform)})`);
	for (const entry of readdirSync(new URL("../assets/agents/", import.meta.url)).filter(file => file.endsWith(".md"))) {
		const file = entry.slice(0, -3);
		const className = file === "sdd-proposal" ? "sdd-propose"
			: file.startsWith("gentle-ai-") ? file.slice("gentle-ai-".length) : file;
		const kind = parseAgentClass(className);
		if (file === "sdd-remediate") {
			assert.equal(kind, undefined, "remediation stays dark in the existing telemetry taxonomy");
			const definition = parseAgentDefinition(readFileSync(new URL(`../assets/agents/${file}.md`, import.meta.url), "utf8"), file, "global");
			assert.ok("instructions" in definition);
			assert.equal(classifyBuiltinAgent(definition), "unknown");
			continue;
		}
		assert.ok(kind, `${file}: telemetry class`);
		const asset = new URL(`../assets/agents/${file}.md`, import.meta.url);
		const content = readFileSync(asset, "utf8");
		const copied = parseAgentDefinition(content, asset.pathname, "global");
		assert.ok("instructions" in copied);
		assert.equal(classifyBuiltinAgent(copied), kind, "verbatim first install");
		for (const entry of [undefined, { model: "openai/gpt-4o", thinking: "high" }]) {
			const parsed = parseAgentDefinition(route(content, entry), asset.pathname, "global");
			assert.ok("instructions" in parsed);
			assert.equal(classifyBuiltinAgent(parsed), kind, `${kind}: installed routing`);
			const customizedClass = parsed.name === "sdd-proposal" ? "sdd-propose" : parseAgentClass(parsed.name) ?? "unknown";
			assert.equal(classifyBuiltinAgent({ ...parsed, instructions: `${parsed.instructions}\nOverride` }), customizedClass);
			assert.equal(classifyBuiltinAgent({ ...parsed, tools: ["different-tool"] }), customizedClass);
			assert.equal(classifyBuiltinAgent({ ...parsed, description: "different description" }), customizedClass);
			assert.equal(classifyBuiltinAgent({ ...parsed, mode: parsed.mode === "task" ? "background" : "task" }), customizedClass);
		}
	}
});

test("packaged sdd-proposal is encoded only as canonical sdd-propose", () => {
	const path = new URL("../assets/agents/sdd-proposal.md", import.meta.url);
	const packaged = parseAgentDefinition(readFileSync(path, "utf8"), path.pathname, "global");
	assert.ok("instructions" in packaged);
	const selection = launchSelection(packaged, { provider: "openai", id: "gpt-4o" }, "high");
	assert.equal(selection.agentClass, "sdd-propose");
	const completed = childEvent("local-session", "sdd-propose-task", selection, "completed", {
		coverage: "final_assistant_messages_only", agentSettled: true, responses: [response()], droppedResponses: 0,
	});
	assert.ok(completed);
	const composition = new ChildComposition();
	assert.equal(composition.reserve(completed, "local-session"), true);
	composition.record(completed);
	const snapshot = composition.snapshot();
	const payload = encodeNativeRuntimeEvent(snapshot.responses, snapshot.launches);
	assert.ok(payload);
	assert.equal(JSON.parse(payload).rows[0].agent_class, "sdd-propose");
	assert.ok(!payload.includes("sdd-proposal"));
});

test("schema-approved packaged names survive customization without exposing private names", () => {
	const path = new URL("../assets/agents/sdd-apply.md", import.meta.url);
	const packaged = parseAgentDefinition(readFileSync(path, "utf8"), path.pathname, "global");
	assert.ok("instructions" in packaged);
	assert.equal(classifyBuiltinAgent({ ...packaged, instructions: "customized instructions" }), "sdd-apply");

	assert.equal(classifyBuiltinAgent(workerDefinition), "worker");
	// This is a packaged frontmatter name, but it is absent from the telemetry
	// enum. Its exact fingerprint retains the compatibility mapping only.
	assert.equal(classifyBuiltinAgent({ ...workerDefinition, instructions: "private override" }), "unknown");
	assert.equal(classifyBuiltinAgent({ ...workerDefinition, tools: ["private tool"] }), "unknown");
	assert.equal(classifyBuiltinAgent({ ...workerDefinition, name: "private-agent" }), "unknown");
});

test("launch distribution and each observed combination remain independent and privacy-filtered", () => {
	const composition = new ChildComposition();
	const value = event();
	assert.ok(value);
	assert.equal(composition.reserve(value, "local-session"), true);
	composition.record(value);
	const view = composition.snapshot();
	assert.equal(view.launches[0].launches, 1);
	assert.equal(view.launches[0].selectedEffort, "high");
	assert.equal(view.launches[0].agentClass, "worker");
	assert.equal(view.responses.length, 2);
	assert.deepEqual(view.responses.map(row => row.observedModelId), ["gpt-4o", "gpt-4o-mini"]);
	assert.ok(view.responses.every(row => row.effort === "high" && row.selectedProvider === "openai"
		&& row.selectedModelId === "gpt-4o"));
	assert.equal(view.responses[0].providerThinkingLevel, "low");
	assert.equal(view.responses[0].tokens.reasoning.sum, 1);
	const encoded = encodeNativeRuntimeEvent(view.responses, view.launches);
	assert.ok(encoded);
	assert.ok(JSON.parse(encoded).rows.filter((row: { responses: number | null }) => row.responses !== null)
		.every((row: { model_evidence: string; selected_effort: string }) => row.model_evidence === "response" && row.selected_effort === "high"));
	assert.equal(view.droppedResponses, 2);
	assert.equal(view.settled, 1);
	assert.equal(view.statuses.completed, 1);
	assert.ok(!JSON.stringify(view).includes("local-"));
	// "Private Vendor Co" fails the schema provider pattern (space, uppercase),
	// unlike a genuine lowercase slug such as "private" that would now legitimately
	// pass through as an open-weight provider name.
	const privateLaunch = launchSelection({ ...workerDefinition, instructions: "private" }, { provider: "Private Vendor Co", id: "private-model" }, "private-effort");
	const filtered = childEvent("local-session", "other", privateLaunch, "failed", {
		coverage: "final_assistant_messages_only", agentSettled: false, responses: [response("private-model", "private-native")], droppedResponses: 0,
	});
	assert.ok(!JSON.stringify(filtered).includes("private"));
});

test("registered child launch identity survives catalog state and missing response evidence inherits selection", () => {
	const path = new URL("../assets/agents/sdd-explore.md", import.meta.url);
	const agent = parseAgentDefinition(readFileSync(path, "utf8"), path.pathname, "global");
	assert.ok("instructions" in agent);
	const selection = launchSelection(agent, { provider: "openai-codex", id: "gpt-5.6-terra" }, "high");
	const [observation] = normalizeRpcEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop",
		usage: { input: 3, output: 2 } } }, { observeResponses: true })
		.filter(event => event.type === TASK_EVENT.RESPONSE_OBSERVATION);
	assert.ok(observation?.type === TASK_EVENT.RESPONSE_OBSERVATION);
	const completed = childEvent("local-session", "sdd-explore-task", selection, "completed", {
		coverage: "final_assistant_messages_only", agentSettled: true,
		responses: Array(5).fill(observation.observation), droppedResponses: 0,
	});
	assert.ok(completed);
	const composition = new ChildComposition();
	assert.equal(composition.reserve(completed, "local-session"), true);
	composition.record(completed);
	const snapshot = composition.snapshot();
	const payload = encodeNativeRuntimeEvent(snapshot.responses, snapshot.launches);
	assert.ok(payload);
	const rows = JSON.parse(payload).rows;
	const launchRow = rows.find((row: { launches: number | null }) => row.launches === 1);
	const responseRow = rows.find((row: { responses: number | null }) => row.responses === 5);
	assert.deepEqual(launchRow.model, { provider: "openai-codex", id: "gpt-5.6-terra" });
	assert.equal(launchRow.model_evidence, "selected");
	assert.equal(launchRow.selected_effort, "high");
	assert.deepEqual(responseRow.model, { provider: "openai-codex", id: "gpt-5.6-terra" });
	assert.equal(responseRow.model_evidence, "selected");
	assert.equal(responseRow.selected_effort, "high");
	assert.equal(responseRow.responses, 5);
});

test("dedupe reserves before async policy, rejects old sessions, and survives aggregate clearing", () => {
	const c = new ChildComposition();
	const e = event()!;
	assert.equal(c.reserve(e, "other-session"), false);
	assert.equal(c.reserve(e, "local-session"), true);
	assert.equal(c.reserve(structuredClone(e), "local-session"), false);
	c.record(e);
	c.clear();
	assert.equal(c.reserve(e, "local-session"), false);
	assert.deepEqual(c.snapshot().responses, []);
	for (let i = 0; i < 255; i++) assert.equal(c.reserve(event(String(i))!, "local-session"), true);
	assert.equal(c.reserve(event("overflow")!, "local-session"), false);
	assert.equal(c.snapshot().saturated, true);
});

test("response capacity retains launch ranking and reports excluded responses without eviction", () => {
	const c = new ChildComposition();
	for (let i = 0; i < 9; i++) {
		const e = childEvent("local-session", String(i), launch(), "completed", {
			coverage: "final_assistant_messages_only", agentSettled: true, responses: Array(128).fill(response()), droppedResponses: 0,
		})!;
		assert.equal(c.reserve(e, "local-session"), true);
		c.record(e);
		c.record(e);
	}
	const view = c.snapshot();
	assert.equal(view.responses[0].responses, 1024);
	assert.equal(view.launches[0].launches, 9);
	assert.equal(view.droppedResponses, 128);
	assert.equal(view.saturated, true);
	assert.equal(view.statuses.completed, 9);
});

test("malformed and oversized events are rejected without reserving IDs", () => {
	const c = new ChildComposition();
	const e = event()!;
	for (const patch of [{ schema: "old" }, { responses: Array(129).fill(e.responses[0]) }, { taskId: "x".repeat(129) },
		{ droppedResponses: -1 }, { status: "native_success" }, { launch: { ...e.launch, agentClass: "private" } }]) {
		assert.equal(c.reserve({ ...e, ...patch }, "local-session"), false);
	}
	assert.equal(c.reserve(e, "local-session"), true);
});
