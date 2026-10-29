import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const dependencyEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const bundledEntry = new URL("./bundle/index.js", dependencyEntry);
// An explicit override must load successfully; never skip a missing/broken SDK.
const override = process.env.NAN_RUNTIME_SDK_ENTRY;
const sdkEntry = override ? pathToFileURL(override).href
	: existsSync(bundledEntry) ? bundledEntry.href : dependencyEntry;
const sdkLayout = sdkEntry.includes("/bundle/") ? "bundled" : "unbundled";
const extensionPath = fileURLToPath(new URL("../extensions/nan-provider.ts", import.meta.url));
const run = promisify(execFile);

// Fresh process per case: the real loader owns jiti and its pi-ai module mapping.
// No direct extension import, agent session, credential store, or provider network.
const probe = String.raw`
import assert from "node:assert/strict";
import { join } from "node:path";
const [sdkEntry, extensionPath, workspace, scenario] = process.argv.slice(1);
const originalFetch = globalThis.fetch;
let requests = 0;
let unexpectedRequests = 0;
globalThis.fetch = async () => {
	unexpectedRequests++;
	throw new Error("Automatic/global network is forbidden in this test");
};
try {
	const { DefaultResourceLoader, SettingsManager, VERSION } = await import(sdkEntry);
	const loader = new DefaultResourceLoader({
		cwd: workspace, agentDir: join(workspace, "agent"),
		settingsManager: SettingsManager.inMemory({ packages: [], retry: { enabled: false } }),
		noExtensions: true, additionalExtensionPaths: [extensionPath],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	const registrations = loaded.runtime.pendingNativeProviderRegistrations;
	assert.equal(registrations.length, 1);
	const { provider } = registrations[0];
	assert.equal(provider.id, "nan");
	const model = provider.getModels().find(m => m.id === "deepseek-v4-flash");
	assert.ok(model);
	const fakeFetch = async (input, init) => {
		requests++;
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		assert.equal(url, "https://api.nan.builders/v1/chat/completions");
		assert.equal(init.method, "POST");
		const body = JSON.parse(init.body);
		assert.equal(body.model, "deepseek-v4-flash");
		assert.equal(body.stream, true);
		if (scenario === "http-error") {
			return new Response(JSON.stringify({ error: { message: "synthetic unavailable" } }), {
				status: 503, headers: { "content-type": "application/json" },
			});
		}
		const delta = scenario === "tool" ? {
			role: "assistant", tool_calls: [{ index: 0, id: "call_synthetic", type: "function",
				function: { name: "lookup", arguments: '{"city":' } }],
		} : { role: "assistant", content: "NAN_" };
		if (scenario === "tool") {
			assert.equal(body.tools[0].function.name, "lookup");
			assert.equal(body.tools[0].function.parameters.properties.city.type, "string");
		}
		const nextDelta = scenario === "tool"
			? { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }
			: { content: "OK" };
		const chunk = (delta, finish_reason = null, usage) => ({
			id: "synthetic", object: "chat.completion.chunk", created: 1, model: body.model,
			choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
		});
		const chunks = [chunk(delta), chunk(nextDelta), chunk({}, scenario === "tool" ? "tool_calls" : "stop",
			{ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })];
		return new Response(chunks.map(c => "data: " + JSON.stringify(c) + "\n\n").join("")
			+ "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	const messages = [{ role: "user", content: [{ type: "text", text: "Synthetic request" }], timestamp: 1 }];
	if (scenario === "tool") messages.unshift({ role: "system", content: "Use lookup", timestamp: 1,
		toolsAdded: [{ name: "lookup", description: "Synthetic lookup", parameters: {
			type: "object", properties: { city: { type: "string" } }, required: ["city"],
		} }] });
	const stream = provider.streamSimple(model, { messages }, {
		apiKey: "synthetic-key", fetch: fakeFetch, maxRetries: 0, maxTokens: 16, timeoutMs: 5000,
	});
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	const types = events.map(event => event.type);
	assert.equal(requests, 1, "including HTTP failures: retries must remain disabled");
	assert.equal(unexpectedRequests, 0);
	assert.equal(types.filter(type => type === "done" || type === "error").length, 1);
	if (scenario === "http-error") {
		assert.equal(types.at(-1), "error");
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /synthetic unavailable/);
		assert.equal(events.at(-1).error, result);
	} else {
		assert.equal(types[0], "start", result.errorMessage);
		assert.equal(types.at(-1), "done");
		assert.equal(events.at(-1).message, result);
		assert.equal(result.usage.input, 3);
		assert.equal(result.usage.output, 2);
		assert.equal(result.usage.totalTokens, 5);
		if (scenario === "tool") {
			assert.equal(result.stopReason, "toolUse");
			for (const type of ["toolcall_start", "toolcall_delta", "toolcall_end"]) assert.ok(types.includes(type));
			const toolCall = result.content.find(block => block.type === "toolCall");
			assert.equal(toolCall.name, "lookup");
			assert.deepEqual(toolCall.arguments, { city: "Paris" });
			assert.deepEqual(events.find(event => event.type === "toolcall_end").toolCall.arguments, { city: "Paris" });
		} else {
			assert.equal(result.stopReason, "stop");
			assert.equal(result.content.filter(block => block.type === "text").map(block => block.text).join(""), "NAN_OK");
			assert.equal(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""), "NAN_OK");
			assert.equal(types.filter(type => type === "text_start").length, 1);
			assert.equal(types.filter(type => type === "text_end").length, 1);
		}
	}
	console.log(JSON.stringify({ sdkVersion: VERSION, requests, types, stopReason: result.stopReason }));
} finally {
	globalThis.fetch = originalFetch;
}
`;

for (const cache of ["default filesystem-cache env", "JITI_FS_CACHE=false"] as const) {
	for (const scenario of ["text", "http-error", "tool"] as const) {
		test(`NaN real loader → ${scenario} stream (${sdkLayout} SDK, cache ${cache})`, { timeout: 30_000 }, async (t) => {
			const workspace = await mkdtemp(join(tmpdir(), "nan-runtime-test-"));
			try {
				const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", probe,
					sdkEntry, extensionPath, workspace, scenario], {
					timeout: 25_000,
					// Do not inherit provider keys or the user's settings/resource locations.
					env: { HOME: workspace, PI_CODING_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1",
						// Confine os.tmpdir fallback only; SDK-local default cache may still be used.
						TMPDIR: workspace, TMP: workspace, TEMP: workspace,
						...(cache === "JITI_FS_CACHE=false" ? { JITI_FS_CACHE: "false" } : {}) },
				});
				const evidence = JSON.parse(stdout.trim());
				assert.equal(evidence.requests, 1);
				t.diagnostic(`SDK ${evidence.sdkVersion} ${sdkLayout}: ${sdkEntry}`);
			} finally {
				await rm(workspace, { recursive: true, force: true });
			}
		});
	}
}
