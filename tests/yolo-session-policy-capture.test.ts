import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Identity is re-captured for every tool admission: freshness is a security
// invariant, so cross-admission reuse is never allowed. Within one admission
// the redundant mode() lookups share at most ONE capture, keyed by that
// admission's tool call id; a different or absent id re-captures. Generation
// bumps and cwd changes still invalidate a shared slot.

const isolatedConfigHomes: string[] = [];
process.once("exit", () => { for (const home of isolatedConfigHomes) rmSync(home, { recursive: true, force: true }); });

function harness() {
	const home = mkdtempSync(join(tmpdir(), "yolo-capture-config-"));
	isolatedConfigHomes.push(home);
	let resolveCalls = 0, statusCalls = 0, widgetCalls = 0;
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		events: { on: () => () => {} },
	} as unknown as ExtensionAPI;
	const controller = registerYoloSessionPolicy(pi, { GENTLE_PI_CONFIG_HOME: home }, {
		// Test seam: observe identity resolution without spawning Git.
		resolveIdentity: async () => { resolveCalls += 1; return undefined; },
	});
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => "capture-test" },
		ui: {
			notify() {},
			setStatus: () => { statusCalls += 1; },
			setWidget: () => { widgetCalls += 1; },
		},
	} as unknown as ExtensionContext;
	return {
		controller, ctx, commands,
		resolveCalls: () => resolveCalls,
		uiCalls: () => ({ status: statusCalls, widget: widgetCalls }),
	};
}

test("lookups of one tool admission share one capture; a second admission re-captures", async () => {
	const h = harness();
	assert.equal(await h.controller.mode(h.ctx, { toolCallId: "call-1" }), "normal");
	assert.equal(h.resolveCalls(), 1, "the first admission captures");
	await h.controller.mode(h.ctx, { toolCallId: "call-1" });
	assert.equal(h.resolveCalls(), 1, "lookups of one tool call share one capture");
	await h.controller.mode(h.ctx, { toolCallId: "call-2" });
	assert.equal(h.resolveCalls(), 2, "a second admission re-captures even with unchanged generation and cwd");
	await h.controller.mode(h.ctx);
	assert.equal(h.resolveCalls(), 3, "an absent admission id keeps the uncached capture path");
});

// The tool admission key never outranks the generation: a bump mid-admission
// (a reselected mode, a revocation) must force a fresh capture, never replay.
test("a generation bump invalidates a shared admission slot", async () => {
	const h = harness();
	assert.equal(await h.controller.mode(h.ctx, { toolCallId: "call-1" }), "normal");
	assert.equal(await h.controller.setMode("yolo", h.ctx), true);
	const before = h.resolveCalls();
	assert.equal(await h.controller.mode(h.ctx, { toolCallId: "call-1" }), "yolo", "the same admission id never answers a mode captured before the bump");
	assert.equal(h.resolveCalls(), before + 1, "the bump forced a fresh capture");
});

test("after a mode change the next mode() re-captures and never answers the stale mode", async () => {
	const h = harness();
	assert.equal(await h.controller.mode(h.ctx), "normal");
	assert.equal(await h.controller.setMode("yolo", h.ctx), true);
	const resolveBefore = h.resolveCalls();
	assert.equal(await h.controller.mode(h.ctx), "yolo", "a generation bump re-reads the live mode");
	assert.equal(h.resolveCalls(), resolveBefore + 1, "the invalidated cache is re-captured, not reused");
});

test("publish writes UI only when the rendered strings change", async () => {
	const h = harness();
	await h.controller.mode(h.ctx);
	const first = h.uiCalls();
	assert.ok(first.status > 0 && first.widget > 0, "the first publication paints the status and widget");
	await h.controller.mode(h.ctx);
	assert.deepEqual(h.uiCalls(), first, "an unchanged mode() costs zero UI writes");
	await h.controller.setMode("yolo", h.ctx);
	const second = h.uiCalls();
	assert.ok(second.status > first.status && second.widget > first.widget, "an actual change still publishes");
	await h.controller.mode(h.ctx);
	assert.deepEqual(h.uiCalls(), second, "reading the settled mode does not repaint");
});

test("a cwd change re-captures and revokes instead of answering a stale workspace mode", async () => {
	const h = harness();
	assert.equal(await h.controller.setMode("yolo", h.ctx), true);
	const other = realpathSync(mkdtempSync(join(tmpdir(), "yolo-capture-cwd-")));
	try {
		Object.assign(h.ctx, { cwd: other });
		assert.equal(await h.controller.mode(h.ctx), "normal", "the new workspace never inherits the old binding");
		assert.equal(h.resolveCalls(), 2, "the cwd change forced a fresh capture");
		await h.controller.mode(h.ctx);
		assert.equal(h.resolveCalls(), 3, "a call without an admission id keeps the uncached capture path");
	} finally { rmSync(other, { recursive: true, force: true }); }
});
