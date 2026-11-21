import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { VERIFIER_SETTLE_REMINDER_TYPE } from "../lib/verifier-settle-reminder.ts";

const continuation = "gentle-pi.codex-turn-continuation";
const codexApi = "openai-codex-responses";
const update = (text = "I’ll check the file.") => ({ ...fauxAssistantMessage(text), endTurn: false });
const finished = () => ({ ...fauxAssistantMessage("Done."), endTurn: true });

async function host(t: TestContext, api = codexApi, extra: ExtensionFactory[] = []) {
	const cwd = mkdtempSync(join(tmpdir(), "codex-turn-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const env = { PI_CODING_AGENT_DIR: cwd, GENTLE_PI_AGENT_HOME: cwd, GENTLE_PI_CONFIG_HOME: cwd };
	for (const [key, value] of Object.entries(env)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	const gentle = createGentleAiExtension({
		nativeReviewCli: null, candidateViews: null, processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("offline fixture"); },
	});
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
		extensionFactories: [...extra, gentle],
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
		cwd, manager, session, faux,
		async prompt(responses: FauxResponseStep[]) {
			faux.setResponses(responses);
			const before = faux.state.callCount;
			await session.prompt("Check the file.", { source: "interactive" });
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
	let wakesBeforeChildResult: number | undefined;
	assert.equal(await h.prompt([update(), () => {
		wakesBeforeChildResult = h.wakes().length;
		return update();
	}, finished()]), 3);
	assert.equal(wakesBeforeChildResult, 0);
});

test("the verifier reminder runs first and leaves Codex one recovery for its next progress message", async (t) => {
	const h = await host(t);
	let remindersAtSecondCall: string[] = [];
	const declaredRisk = update("I’ll verify the fix.\nRisk: item 6 (no regression test)");
	assert.equal(await h.prompt([declaredRisk, () => {
		remindersAtSecondCall = h.manager.getEntries().flatMap(entry => entry.type === "custom_message" ? [entry.customType] : []);
		return update();
	}, finished()]), 3);
	assert.deepEqual(remindersAtSecondCall.filter(type => type === VERIFIER_SETTLE_REMINDER_TYPE || type === continuation), [VERIFIER_SETTLE_REMINDER_TYPE]);
});

for (const streamingBehavior of ["followUp", "steer"] as const) {
	test(`a delivered user ${streamingBehavior} can recover after the first request spent its recovery`, async (t) => {
		const h = await host(t);
		assert.equal(await h.prompt([update(), async () => {
			await h.session.prompt("Check the second file.", { source: "interactive", streamingBehavior });
			return finished();
		}, update("I’ll check the second file."), finished()]), 4);
	});
}

for (const disposition of ["handled", "cleared"]) {
	test(`a ${disposition} follow-up leaves a spent recovery spent`, async (t) => {
		const followUp = "Check the second file.";
		let handled = false;
		const h = await host(t, codexApi, [pi => {
			pi.on("input", event => {
				if (disposition === "handled" && event.text === followUp) {
					handled = true;
					return { action: "handled" };
				}
			});
		}]);
		let cleared: string[] = [];
		assert.equal(await h.prompt([update(), async () => {
			await h.session.prompt(followUp, { source: "interactive", streamingBehavior: "followUp" });
			if (disposition === "cleared") cleared = h.session.clearQueue().followUp;
			return update();
		}]), 2);
		if (disposition === "handled") assert.ok(handled);
		else assert.deepEqual(cleared, [followUp]);
	});
}

test("extension-only wakes can spend an unused recovery but cannot rearm it after settlement", async (t) => {
	const h = await host(t);
	assert.equal(await h.prompt([finished()]), 1);
	const wake = { customType: "fixture.child", content: "Result ready.", display: false };
	h.faux.setResponses([update(), finished()]);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	assert.equal(h.faux.state.callCount, 3);
	h.faux.setResponses([update()]);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	assert.equal(h.faux.state.callCount, 4);
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
