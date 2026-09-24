import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gentleAgents from "../extensions/gentle-agents.ts";

interface HookEvent {
	systemPrompt?: string;
	toolName?: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
	content?: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}
interface HookResult { block?: boolean; reason?: string; isError?: boolean; systemPrompt?: string }
type Hook = (event: HookEvent, ctx: { cwd: string }) => HookResult | undefined;

function child(cwd: string, artifact?: unknown, selection?: unknown) {
	const hooks = new Map<string, Hook>();
	let active = ["read", "grep", "find", "write", "edit", "mem_save", "mem_search", "mem_get_observation", "web_search", "subagent_parent_message"];
	let source = "/installed/search.ts";
	const pi = { on: (name: string, hook: Hook) => hooks.set(name, hook),
		getActiveTools: () => active,
		getAllTools: () => active.map(name => ({ name, sourceInfo: { source: "extension", path: source } })),
		appendEntry: () => assert.fail("research must not create a second persistence checkpoint"),
	};
	gentleAgents(pi as unknown as ExtensionAPI, { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_RESEARCH_TOOLS: JSON.stringify(active),
		GENTLE_PI_RESEARCH_SELECTION: JSON.stringify(selection ?? null), GENTLE_PI_RESEARCH_ARTIFACT: JSON.stringify(artifact ?? null) });
	// No physical session file or pre-existing artifact is necessary.
	const ctx = { cwd };
	hooks.get("before_agent_start")!({ systemPrompt: "Research a question" }, ctx);
	return {
		call: (toolName: string, input: Record<string, unknown> = {}) => hooks.get("tool_call")!({ toolName, input, toolCallId: "call" }, ctx),
		result: (toolName: string, input: Record<string, unknown>, content: string, isError = false) => {
			const event = { toolName, input, toolCallId: "call", content: [{ type: "text" as const, text: content }], isError };
			return { ...event, ...hooks.get("tool_result")?.(event, ctx) };
		},
		deactivate: (name: string) => { active = active.filter(tool => tool !== name); },
		replaceSource: () => { source = "/different/search.ts"; },
	};
}

function workspace(t: test.TestContext) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-optional-research-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

test("optional research is output-only even with historical artifact identity", t => {
 const cwd = workspace(t);
 const path = join(cwd, "openspec/changes/demo/research.md"), content = '{"revision":1,"outcome":"partial"}';
 mkdirSync(join(cwd, "openspec/changes/demo"), { recursive: true });
 writeFileSync(path, content);
 const h = child(cwd, { store: "openspec", worktree: cwd, changeName: "demo", retainedIntent: "Research question", locators: [{ artifact: "research", path, revision: 1, digest: createHash("sha256").update(content).digest("hex") }] });
 for (const tool of ["read", "grep", "find", "write", "edit", "mem_save", "mem_search", "mem_get_observation", "bash"]) {
  assert.equal(h.call(tool, { path, content: "overwrite", id: 1 })?.block, true, tool);
 }
 assert.equal(readFileSync(path, "utf8"), content);
 assert.equal(h.call("subagent_parent_message", { message: "Partial findings; external sources unavailable." }), undefined);
 assert.equal(h.result("web_search", {}, "Partial search results").isError, false);
 assert.equal(h.result("web_search", {}, "Permission denied", true).isError, true);
});

test("optional research uses individually authorized external tools but never invents grants", t => {
	const cwd = workspace(t);
	const selection = { "open-web": { tools: ["web_search"], extensions: { web_search: "/installed/search.ts" } } };
	const h = child(cwd, undefined, selection);
	assert.equal(h.call("web_search", { query: "official reference" }), undefined);
	assert.equal(h.call("fetch_content", { url: "https://example.com" })?.block, true);
	assert.equal(h.call("mcp", {})?.block, true);
	h.replaceSource();
	assert.equal(h.call("web_search", {})?.block, true, "changed extension provenance revokes the route");
	const inactive = child(cwd, undefined, selection); inactive.deactivate("web_search");
	assert.equal(inactive.call("web_search", {})?.block, true);
	assert.equal(child(cwd).call("web_search", {})?.block, true, "availability alone is not authorization");
});

if (process.env.SDD_TEST_ENGRAM) test("research parent can persist first partial artifact through actual isolated Engram", t => {
	const cwd = workspace(t), project = "research-fixture", binary = process.env.SDD_TEST_ENGRAM!;
	const env = { ...process.env, ENGRAM_DATA_DIR: join(cwd, "memory"), ENGRAM_PROJECT: project };
	// Establish a known test project, not a research artifact or session checkpoint.
	execFileSync(binary, ["save", "Fixture context", "Isolated project context", "--project", project], { cwd, env, stdio: "pipe" });
	const invoke = (name: string, args: Record<string, unknown>) => {
		const messages = [
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "research-integration", version: "1" } } },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
		];
		const raw = execFileSync(binary, ["mcp", "--project", project], { cwd, env, encoding: "utf8", input: messages.map(value => JSON.stringify(value)).join("\n") + "\n", timeout: 15_000 });
		const response = raw.trim().split("\n").map(line => JSON.parse(line)).find(value => value.id === 2);
		assert.ok(response?.result && !response.error);
		assert.notEqual(response.result.isError, true);
		return response.result.content.map((part: { text: string }) => part.text).join("");
	};
	const engram = { project, topic_key: "sdd/demo/research" };
	// The parent owns persistence; research child hooks never perform or approve it.
	const input = { ...engram, title: "Partial documentation research", content: "External sources unavailable; product question remains unanswered.", capture_prompt: false };
	const saved = invoke("mem_save", input);
	const id = JSON.parse(saved).id; assert.ok(Number.isSafeInteger(id));
	const readback = invoke("mem_get_observation", { id });
	assert.ok(JSON.parse(readback).result.includes(input.content));

});


test("optional research handoff keeps first file persistence and readback parent-owned", t => {
 const cwd = workspace(t), path = join(cwd, "openspec/changes/demo/research.md");
 const findings = "# Research\nPartial findings; external sources unavailable.\n";
 assert.equal(child(cwd).call("write", { path, content: findings })?.block, true);
 // This models the parent using its existing file tools, not a child persistence adapter.
 mkdirSync(join(cwd, "openspec/changes/demo"), { recursive: true });
 writeFileSync(path, findings);
 assert.equal(readFileSync(path, "utf8"), findings);
 const workflow = readFileSync(new URL("../assets/sdd-orchestrator-workflow.md", import.meta.url), "utf8");
 const gate = workflow.slice(workflow.indexOf("## Automatic Mode Gatekeeper"));
 assert.ok(gate.indexOf("Optional research takes precedence") < gate.indexOf("**Contract conformance:**"));
 assert.match(gate, /accept honest partial, unavailable, or inline findings without requiring an artifact or retry/);
 assert.match(workflow, /parent owns local reads, product choices, and any authorized persistence\/readback/);
 assert.match(workflow, /First artifacts and in-memory sessions require no prior identity or checkpoint/);
});
