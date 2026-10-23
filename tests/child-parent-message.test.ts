import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IpcEndpoint } from "../lib/agents-messaging.ts";
import { createChildParentMessageExtension } from "../extensions/child-parent-message.ts";

type RegisteredTool = {
	name: string;
	execute: (_id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

function fakePi(): { pi: ExtensionAPI; tools: Map<string, RegisteredTool> } {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function fakeIpc(frames: unknown[], listeners: Map<string, Array<(...args: unknown[]) => void>>): IpcEndpoint {
	return {
		send(frame, callback) {
			frames.push(frame);
			callback?.(null);
			return true;
		},
		on(event, listener) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		},
	};
}

test("fallback child registers the bounded parent handoff and admits its notification", async () => {
	const { pi, tools } = fakePi();
	const frames: unknown[] = [];
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const ipc = fakeIpc(frames, listeners);
	const register = createChildParentMessageExtension({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: "fixture" }, ipc);
	register(pi);
	register(pi);

	assert.deepEqual([...tools.keys()], ["subagent_parent_message"]);
	const pending = tools.get("subagent_parent_message")!.execute("message", { message: "Required step is blocked." });
	assert.deepEqual(frames, [{ id: "n1", kind: "notification", message: "Required step is blocked." }]);
	for (const listener of listeners.get("message") ?? []) listener({ id: "n1", kind: "ack", accepted: true });
	assert.equal((await pending).content[0]?.text, "Notification accepted by the parent.");
});

test("fallback parent messaging is inert outside an owned child IPC process", () => {
	const frames: unknown[] = [];
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const ipc = fakeIpc(frames, listeners);
	for (const env of [
		{ GENTLE_PI_AGENTS_OWNED_IPC: "fixture" },
		{ GENTLE_PI_AGENTS_CHILD: "0", GENTLE_PI_AGENTS_OWNED_IPC: "fixture" },
	]) {
		const { pi, tools } = fakePi();
		createChildParentMessageExtension(env, ipc)(pi);
		assert.deepEqual([...tools.keys()], []);
	}

	const { pi, tools } = fakePi();
	createChildParentMessageExtension(
		{ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: "fixture" },
		{ send: () => true } as unknown as IpcEndpoint,
	)(pi);
	assert.deepEqual([...tools.keys()], []);
});
