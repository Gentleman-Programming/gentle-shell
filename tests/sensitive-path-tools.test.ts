import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// gentle-shell#2349: the sensitive-path deny list must not depend on which
// path-taking tool the model picks. grep, find, and ls take the same `path`
// input as read, so a sensitive `path` is denied for them too.

type Handler = (event: { toolName: string; input: unknown; toolCallId: string }, ctx: ExtensionContext) => unknown;

function toolCall() {
	const handlers: Handler[] = [];
	const pi = {
		on: (name: string, handler: Handler) => { if (name === "tool_call") handlers.push(handler); },
		events: { on() {}, emit() {} },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	// An isolated config home keeps the permission mode at its default, so every
	// later tool_call check admits an ordinary path and the whole chain returns
	// undefined. A block from any check is then observable, not just this guard's.
	const home = mkdtempSync(join(tmpdir(), "gentle-shell-2349-"));
	createGentleAiExtension({ processEnv: { GENTLE_PI_AGENTS_CHILD: "0", GENTLE_PI_CONFIG_HOME: home }, nativeReviewCli: null })(pi);
	const sessionManager = { getSessionId: () => "session-2349", getBranch: () => [], getEntries: () => [] };
	const ctx = { cwd: process.cwd(), hasUI: false, sessionManager, ui: { confirm: async () => false } } as unknown as ExtensionContext;
	return async (toolName: string, input: unknown) => {
		for (const handler of handlers) {
			const result = await handler({ toolName, input, toolCallId: "probe" }, ctx);
			if (result !== undefined) return result as { block?: boolean; reason?: string };
		}
		return undefined;
	};
}

const reason = (path: string) => `Gentle AI safety policy blocked access to sensitive path: ${path}. Ask the user for an explicit safer plan.`;

test("grep, find, and ls deny a sensitive path exactly like read (gentle-shell#2349)", async () => {
	const call = toolCall();
	for (const [toolName, input, path] of [
		["grep", { pattern: "API_KEY", path: ".env" }, ".env"],
		["grep", { pattern: "x", path: "/app/.env.production" }, "/app/.env.production"],
		["find", { pattern: "*", path: "~/.ssh" }, "~/.ssh"],
		["ls", { path: "secrets" }, "secrets"],
		["ls", { path: "/home/u/.aws/credentials" }, "/home/u/.aws/credentials"],
		["grep", { pattern: "x", paths: ["src", ".env"] }, ".env"],
	] as const) {
		assert.deepEqual(await call(toolName, input), { block: true, reason: reason(path) }, `${toolName} ${path}`);
	}
});

test("grep, find, and ls admit ordinary paths and their default scope (gentle-shell#2349)", async () => {
	const call = toolCall();
	for (const [toolName, input] of [
		["grep", { pattern: "TODO", path: "src" }],
		["grep", { pattern: "TODO" }],
		["find", { pattern: "*.ts", path: "lib" }],
		["find", { pattern: "*.ts" }],
		["ls", { path: "docs" }],
		["ls", {}],
		["grep", { pattern: "TODO", paths: ["src", "lib"] }],
	] as const) {
		assert.equal(await call(toolName, input), undefined, `${toolName} ${JSON.stringify(input)}`);
	}
});

test("read, write, and edit keep denying sensitive paths (gentle-shell#2349)", async () => {
	const call = toolCall();
	assert.deepEqual(await call("read", { path: ".env.local" }), { block: true, reason: reason(".env.local") });
	assert.deepEqual(await call("write", { path: "secrets/token.txt", content: "x" }), { block: true, reason: reason("secrets/token.txt") });
	assert.deepEqual(await call("edit", { path: "id_rsa.pem", edits: [] }), { block: true, reason: reason("id_rsa.pem") });
});
