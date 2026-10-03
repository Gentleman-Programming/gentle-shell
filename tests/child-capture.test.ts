import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildCaptureExtension } from "../extensions/child-capture.ts";

function harness(child: boolean) {
	const registered: string[] = [];
	const pi = {
		on: (name: string) => { registered.push(name); },
		events: { on() { return () => {}; }, emit() {} },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const env = { GENTLE_PI_AGENTS_CHILD: child ? "1" : "0" };
	createChildCaptureExtension(env)(pi);
	return { registered };
}

test("child-only capture is inert in primary auto-discovery (#1688)", () => {
	const { registered } = harness(false);
	assert.equal(registered.length, 0, "must register no hooks in parent");
});

test("children register session change capture lifecycle and tool hooks (#1688)", () => {
	const { registered } = harness(true);
	assert.ok(registered.includes("tool_call"), "child must register tool_call hook");
	assert.ok(registered.includes("tool_result"), "child must register tool_result hook");
	assert.ok(registered.includes("tool_execution_end"), "child must register tool_execution_end hook");
	assert.ok(registered.includes("session_start"), "child must register session_start hook");
	assert.ok(registered.includes("session_shutdown"), "child must register session_shutdown hook");
});
