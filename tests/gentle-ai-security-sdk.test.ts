import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseAgentDefinition } from "../lib/agents-config.ts";

const assetPath = join(process.cwd(), "assets", "agents", "gentle-ai-security.md");
const parameters = { type: "object", properties: {}, additionalProperties: false } as never;

async function isolatedSdkFixture(t: test.TestContext, prefix: string) {
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "empty-auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), allowModelNetwork: false });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	return { cwd, agentDir, modelRuntime, resourceLoader };
}

function forbiddenTool(name: "edit" | "write" | "bash" | "mem_save") {
	return defineTool({
		name, label: `${name} must be denied`, description: "Must not be admitted.", parameters,
		async execute() { assert.fail(`${name} must not execute`); },
	});
}

test("offline SDK filters the packaged security analyst registry by allowed names", async (t) => {
	const { cwd, agentDir, modelRuntime, resourceLoader } = await isolatedSdkFixture(t, "gentle-security-sdk-");
	writeFileSync(join(cwd, "fixture.txt"), "offline fixture\n");
	const parsed = parseAgentDefinition(readFileSync(assetPath, "utf8"), assetPath, "global");
	assert.ok(!("error" in parsed), "the real packaged asset must parse");
	const relay = defineTool({
		name: "subagent_parent_message", label: "Parent relay", description: "Relays findings.", parameters,
		async execute() { return { content: [{ type: "text", text: "relay-executed" }] }; },
	});
	const graph = defineTool({
		name: "codegraph", label: "CodeGraph", description: "Maps code.", parameters,
		async execute() { return { content: [{ type: "text", text: "mapped" }] }; },
	});
	const denied = ["edit", "write", "bash", "mem_save"] as const;
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		session = (await createAgentSession({
			cwd, agentDir, modelRuntime, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			tools: [...parsed.tools, "subagent_parent_message"], customTools: [relay, graph, ...denied.map(forbiddenTool)],
		})).session;
		const names = session.getAllTools().map((tool) => tool.name);
		const stateNames = session.state.tools.map((tool) => tool.name);
		assert.deepEqual(session.getActiveToolNames(), ["read", "grep", "find", "codegraph", "subagent_parent_message"]);
		for (const name of denied) {
			assert.ok(!names.includes(name), `${name} must be absent from the SDK registry`);
			assert.equal(session.getToolDefinition(name), undefined, `${name} must have no executable handle`);
			assert.ok(!stateNames.includes(name), `${name} must be absent from agent state tools`);
		}
		session.setActiveToolsByName(["edit", "write", "bash", "mem_save", "read"]);
		assert.deepEqual(session.getActiveToolNames(), ["read"], "unregistered names cannot be reactivated");
		const read = session.getToolDefinition("read");
		assert.ok(read, "the SDK-built read tool must remain executable");
		assert.match(String((await read.execute("read-fixture", { path: "fixture.txt" }, undefined, undefined, {} as never)).content[0]?.text), /offline fixture/);
		const parentRelay = session.getToolDefinition("subagent_parent_message");
		assert.ok(parentRelay, "runner-appended parent relay must be executable");
		assert.match(String((await parentRelay.execute("relay", {}, undefined, undefined, {} as never)).content[0]?.text), /relay-executed/);
	} finally {
		session?.dispose();
	}
});

test("SDK custom tool registration can shadow built-in read for a trusted extension", async (t) => {
	const { cwd, agentDir, modelRuntime, resourceLoader } = await isolatedSdkFixture(t, "gentle-security-sdk-collision-");
	const marker = defineTool({
		name: "read", label: "Trusted read replacement", description: "Collision characterization.", parameters,
		async execute() { return { content: [{ type: "text", text: "custom-read-marker" }] }; },
	});
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		session = (await createAgentSession({
			cwd, agentDir, modelRuntime, resourceLoader, sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			tools: ["read"], customTools: [marker],
		})).session;
		const read = session.getToolDefinition("read");
		assert.ok(read);
		assert.match(String((await read.execute("collision", {}, undefined, undefined, {} as never)).content[0]?.text), /custom-read-marker/);
	} finally {
		session?.dispose();
	}
});
