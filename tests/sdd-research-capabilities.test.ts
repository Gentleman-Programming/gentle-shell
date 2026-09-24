import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { childArguments } from "../lib/agents-runner.ts";
import { resolveResearchCapabilities, researchAgent, renderResearchCapabilities } from "../lib/sdd-research-capabilities.ts";
import type { AgentDefinition } from "../lib/agents-config.ts";

const inventory = (names: string[]) => ({ getActiveTools: () => names, getAllTools: () => names.map(name => ({ name, sourceInfo: { source: "extension", path: "/installed/web.ts" } })) });
const grant = (tools: string[]) => ({ tools, extensions: Object.fromEntries(tools.map(name => [name, "/installed/web.ts"])) });
const documentation = { documentation: grant(["fetch_content"]) };
const both = { ...documentation, "open-web": grant(["web_search", "source_check", "fetch_content", "get_search_content"]) };
const agent: AgentDefinition = { name: "sdd-research", description: "Research", filePath: "/agents/sdd-research.md", scope: "global", tools: ["read", "write", "fetch_content", "web_search", "source_check", "get_search_content"], instructions: "Research", model: undefined, thinking: undefined, mode: undefined };

test("approved active external tools reach the actual child CLI allowlist", () => {
 const pi = inventory(["read", "write", "fetch_content", "web_search", "source_check", "get_search_content", "bash", "mcp"]);
 const result = researchAgent(agent, pi, both);
 const args = childArguments({ agent: result.agent, sessionDir: "sessions" } as never);
 assert.equal(args[args.indexOf("--tools") + 1], "fetch_content,web_search,source_check,get_search_content,subagent_parent_message");
 assert.equal(result.capabilities.documentation.status, "available");
 assert.equal(result.capabilities["open-web"].status, "available");
});
test("class-specific grants remain exact when both classes are explicitly selected", () => {
 const names = ["web_search", "source_check", "fetch_content", "get_search_content"];
 const caps = resolveResearchCapabilities(inventory([...names, "unknown"]));
 assert.deepEqual(caps.documentation.tools, ["fetch_content"]);
 assert.deepEqual(caps["open-web"].tools, names);
 assert.match(renderResearchCapabilities(caps), /documentation: available; tools=\["fetch_content"\]/);
 assert.deepEqual(resolveResearchCapabilities(inventory(["web_search"])).documentation.tools, []);
 assert.deepEqual(resolveResearchCapabilities(inventory(["web_search"]))["open-web"].tools, ["web_search"]);
 assert.deepEqual(researchAgent(agent, inventory(names), both).agent.tools, agent.tools.filter(name => !["read", "write"].includes(name)));
 const instructions = readFileSync(new URL("../assets/agents/sdd-research.md", import.meta.url), "utf8");
 assert.match(instructions, /Report grants per source class exactly as observed/);
 assert.match(instructions, /never copy the child tool union into each class/);
 assert.match(instructions, /research_selection/);
 assert.match(instructions, /sourceInfo\.path/);
 assert.match(instructions, /--extension/);
 assert.match(instructions, /output-only/);
 assert.doesNotMatch(instructions, /revision_count/);
 assert.match(instructions, /parent owns.*persistence/);

});
test("open-web exposes available authorized tools without a completeness gate", () => {
 const required = ["web_search", "source_check", "fetch_content", "get_search_content"];
 for (const missing of required) {
  const remaining = required.filter(name => name !== missing);
  for (const caps of [
   resolveResearchCapabilities(inventory(remaining)),
   resolveResearchCapabilities({ ...inventory(required), getActiveTools: () => remaining }),
   resolveResearchCapabilities(inventory(required), remaining),
   researchAgent(agent, inventory(remaining), both).capabilities,
  ]) {
   assert.equal(caps["open-web"].status, "available", `${missing} must not deny other tools`);
   assert.match(caps["open-web"].reason, new RegExp(missing));
   assert.equal(caps.documentation.status, missing === "fetch_content" ? "blocked" : "available");
  }
 }
});
test("restrictions, inactive tools and unknown tools never become grants", () => {
 const pi = inventory(["fetch_content", "web_search", "mcp", "mcp__context7", "bash"]);
 const caps = resolveResearchCapabilities(pi, ["web_search"]);
 assert.equal(caps.documentation.status, "blocked");
 assert.equal(caps["open-web"].status, "available");
 assert.deepEqual(researchAgent({ ...agent, tools: ["read", "write"] } as never, pi).agent.tools, []);
 assert.equal(resolveResearchCapabilities(inventory(["mcp", "mcp__context7"])).documentation.status, "blocked");
 const inactive = { ...pi, getActiveTools: () => [] };
 assert.equal(resolveResearchCapabilities(inactive).documentation.status, "blocked");
});
test("documentation can run independently of unavailable open-web search", () => {
 const caps = researchAgent(agent, inventory(["fetch_content"]), documentation).capabilities;
 assert.equal(caps.documentation.status, "available");
 assert.equal(caps["open-web"].status, "blocked");
 assert.match(renderResearchCapabilities(caps), /official/);
 assert.match(renderResearchCapabilities(caps), /not evidence/);
});
test("SDK-only tools and unavailable inventory fail closed", () => {
 const pi = { getActiveTools: () => ["fetch_content"], getAllTools: () => [{ name: "fetch_content", sourceInfo: { source: "sdk" } }] };
 assert.equal(resolveResearchCapabilities(pi).documentation.status, "blocked");
 assert.equal(resolveResearchCapabilities({}).documentation.status, "blocked");
});

test("selected documentation never inherits available open-web routes or arbitrary extensions", () => {
 const result = researchAgent(agent, inventory(agent.tools), documentation);
 assert.deepEqual(result.agent.tools, ["fetch_content"]);
 assert.deepEqual(result.extensionPaths, ["/installed/web.ts"]);
 assert.equal(result.capabilities["open-web"].status, "blocked");
 for (const selection of [undefined, {}, { documentation: grant(["fetch_content", "web_search"]) }, { documentation: { tools: ["fetch_content"], extensions: { fetch_content: "/other.ts" } } }]) {
  assert.deepEqual(researchAgent(agent, inventory(agent.tools), selection).agent.tools, []);
 }
});

test("selected grants refuse missing, inactive, SDK, restricted and unknown routes while research remains output-only", () => {
 const local = ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"];
 const definition = { ...agent, tools: [...local, ...both["open-web"].tools, "bash", "mcp"] };
 for (const missing of both["open-web"].tools) {
  const full = inventory(definition.tools);
  for (const [pi, tools] of [
   [inventory(definition.tools.filter(name => name !== missing)), definition.tools],
   [{ ...full, getActiveTools: () => definition.tools.filter(name => name !== missing) }, definition.tools],
   [{ ...full, getAllTools: () => full.getAllTools().map(tool => tool.name === missing ? { ...tool, sourceInfo: { ...tool.sourceInfo, source: "sdk" } } : tool) }, definition.tools],
   [full, definition.tools.filter(name => name !== missing)],
  ] as const) {
   const result = researchAgent({ ...definition, tools: [...tools] }, pi, { "open-web": both["open-web"] });
   assert.deepEqual(result.agent.tools, both["open-web"].tools.filter(name => name !== missing), missing);
   assert.equal(result.capabilities["open-web"].status, "available");
   assert.deepEqual(result.capabilities["open-web"].tools, both["open-web"].tools.filter(name => name !== missing));
  }
 }
 for (const selection of [{ unknown: grant(["fetch_content"]), ...documentation }, { toString: {}, ...documentation }, { documentation: grant(["mcp"]) }]) {
  assert.deepEqual(researchAgent(definition, inventory(definition.tools), selection).agent.tools, []);
 }
 const allowed = researchAgent(definition, inventory(definition.tools), { "open-web": both["open-web"] });
 assert.deepEqual(allowed.agent.tools, both["open-web"].tools);
 assert.deepEqual(allowed.capabilities.documentation.tools, []);
});
