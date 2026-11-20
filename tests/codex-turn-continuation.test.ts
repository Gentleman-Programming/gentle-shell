import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import codexTurnContinuation from "../extensions/codex-turn-continuation.ts";

const continuation = "gentle-pi.codex-turn-continuation";
const codexApi = "openai-codex-responses";
const update = () => ({ ...fauxAssistantMessage("I’ll check the file."), endTurn: false });
const finished = () => ({ ...fauxAssistantMessage("Done."), endTurn: true });

async function host(t: TestContext, api = codexApi, extra: ExtensionFactory[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "codex-turn-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const faux = fauxProvider({ api });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models.json"),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "fixture");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [...extra, codexTurnContinuation],
	});
	await resourceLoader.reload();
	const manager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager: manager, tools: ["read"],
	});
	t.after(() => session.dispose());
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
	return {
		cwd, manager,
		async prompt(responses: AssistantMessage[]) {
			faux.setResponses(responses);
			const before = faux.state.callCount;
			await session.prompt("Check the file.");
			assert.deepEqual(errors, []);
			return faux.state.callCount - before;
		},
		wakes: () => manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === continuation),
	};
}

test("Codex can resume into a real tool call, then request another continuation after the tool returns", async (t) => {
	const h = await host(t);
	writeFileSync(join(h.cwd, "fixture.txt"), "evidence");
	const read = { ...fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }), endTurn: false };
	assert.equal(await h.prompt([update(), read, update(), finished()]), 4);
	assert.equal(h.wakes().length, 2);
	const result = h.manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "toolResult");
	assert.ok(result?.type === "message" && result.message.role === "toolResult" && !result.message.isError);
});

test("consecutive tool-free signals get one recovery and a new prompt gets its own", async (t) => {
	const h = await host(t);
	assert.equal(await h.prompt([update(), update()]), 2);
	assert.equal(await h.prompt([update(), finished()]), 2);
	assert.equal(h.wakes().length, 2);
});

test("a subagent wake runs first and leaves recovery available for the next tool-free response", async (t) => {
	const h = await host(t, codexApi, [pi => {
		pi.on("turn_end", event => {
			if (event.turnIndex === 0 && event.message.role === "assistant" && event.message.endTurn === false) pi.sendMessage({ customType: "fixture.child", content: "Result ready.", display: false }, { triggerTurn: true, deliverAs: "steer" });
		});
	}]);
	assert.equal(await h.prompt([update(), update(), finished()]), 3);
	assert.equal(h.wakes().length, 1);
});

test("passive context can carry the recovery without another wake or a tool-free loop", async (t) => {
	const h = await host(t, codexApi, [pi => {
		pi.on("turn_end", () => {
			pi.sendMessage({ customType: "fixture.state", content: "Snapshot.", display: false }, { triggerTurn: false });
		});
	}]);
	assert.equal(await h.prompt([update(), update()]), 2);
	assert.equal(h.wakes().length, 0);
});

test("a user abort after the provider response cancels the pending continuation", async (t) => {
	const h = await host(t, codexApi, [pi => {
		pi.on("turn_end", (_event, ctx) => ctx.abort());
	}]);
	assert.equal(await h.prompt([update()]), 1);
	assert.equal(h.wakes().length, 0);
});

test("true, absent and unsuccessful Codex endings leave the session settled", async (t) => {
	const h = await host(t);
	const replies: AssistantMessage[] = [finished(), fauxAssistantMessage("I’ll check the file.")];
	for (const stopReason of ["length", "error", "aborted"] as const) {
		replies.push({ ...fauxAssistantMessage("Interrupted", { stopReason }), endTurn: false });
	}
	for (const reply of replies) {
		assert.equal(await h.prompt([reply]), 1, `${reply.endTurn} / ${reply.stopReason}`);
	}
	assert.equal(h.wakes().length, 0);
});

test("another API reporting the same metadata follows its own lifecycle", async (t) => {
	const h = await host(t, "fixture-api");
	assert.equal(await h.prompt([update()]), 1);
	assert.equal(h.wakes().length, 0);
});
