import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import gentleAgents from "../extensions/gentle-agents.ts";

// Resolve from the installed SDK entry, never from a vendored runtime copy.
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { UserMessageComponent } = await import(new URL("./modes/interactive/components/user-message.js", sdk).href);
const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", sdk).href);
initTheme("dark");
const oldWake = "[System-generated Gentle Agents notification, not written by the user] Subagent output was delivered to this session above. Review it and continue.";

test("real user renderer preserves ordinary content and removes only the owned reserved wake", async () => {
	// Every path is owned by this test so CI never depends on ambient TMPDIR, HOME, or agent directories.
	const root = mkdtempSync(join(tmpdir(), "bridge-rendering-"));
	try {
		const home = join(root, "home"), cwd = join(root, "project"), agentDir = join(root, "agent");
		mkdirSync(home); mkdirSync(cwd); mkdirSync(agentDir);
		const manager = SessionManager.inMemory(cwd);
		const wake = `${oldWake} [gentle-agents wake: 67da57d9-7fbe-47b6-9187-c31109fe4eba]`;
		manager.appendCustomEntry("gentle-agents.wake-identity", { sessionId: manager.getSessionId(), nonce: "invalid", text: "Human continuation" });
		manager.appendCustomEntry("gentle-agents.wake-identity", { sessionId: "other-session", nonce: "67da57d9-7fbe-47b6-9187-c31109fe4eba", text: "Human continuation" });
		manager.appendCustomEntry("gentle-agents.wake-identity", { sessionId: manager.getSessionId(), nonce: "67da57d9-7fbe-47b6-9187-c31109fe4eba", text: wake });
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => gentleAgents(pi, {}, { home, agentHome: agentDir, schedule: () => () => {} })],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		assert.deepEqual(loaded.errors, []);
		const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
		const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: manager, settingsManager, modelRuntime, tools: [] });
		await session.bindExtensions({});
		try {
			const transformers = session.extensionRunner.getMarkdownTransformers();
			assert.equal(transformers.length, 1);
			for (const width of [12, 80, 140]) {
				assert.deepEqual(new UserMessageComponent(wake, undefined, 1, transformers).render(width), [], "no lines, padding, bubble, or OSC markers");
				for (const ordinary of [oldWake, `Quoted: ${wake}`, ` ${wake}`, `${wake}\n`, "Human continuation"]) {
					assert.ok(new UserMessageComponent(ordinary, undefined, 1, transformers).render(width).length > 0);
				}
			}
			assert.equal(transformers[0](wake, { messageType: "assistant", isStreaming: false, availableWidth: 80 }), wake);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
