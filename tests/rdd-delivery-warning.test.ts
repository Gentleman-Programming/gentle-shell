import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

const NOTICE = "RDD: this repository has an unreviewed candidate; review it before delivery.";
const unreviewed = { applicability: "current_target", targetIdentity: "t", nextTransition: { kind: "execute", execute: { operation: "review.start" } } };

async function run(effective: "on" | "off", command: string, targetStatus: () => Promise<unknown>, cwd = process.cwd()) {
	type Handler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler), events: { emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	let statusCalls = 0;
	let modeCalls = 0;
	const cli = { reviewMode: async () => { modeCalls++; return { status: { effective } }; }, targetStatus: async () => { statusCalls++; return targetStatus(); } };
	createGentleAiExtension({ nativeReviewCli: cli as never })(pi);
	const notices: Array<[string, string | undefined]> = [];
	const ctx = { cwd, hasUI: true, ui: { confirm: async () => true, notify: (message: string, level?: string) => notices.push([message, level]) } } as unknown as ExtensionContext;
	const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command } }, ctx);
	return { result, notices, statusCalls, modeCalls };
}

test("S3: a delivery command with RDD on and an unreviewed candidate runs and shows exactly one notice", async () => {
	for (const command of ["git push origin main", "gh pr create --fill", "gh pr merge 1"]) {
		const { result, notices, statusCalls } = await run("on", command, async () => unreviewed);
		assert.equal(result, undefined, command);
		assert.deepEqual(notices, [[NOTICE, "warning"]], command);
		assert.equal(statusCalls, 1, command);
	}
});

test("S1: the former gate shapes all run under RDD on", async () => {
	for (const command of ["cd /c/x && git push", "git -C \"$VAR\" push", "git push origin feature &", "git switch x && git push"]) {
		const { result } = await run("on", command, async () => unreviewed);
		assert.equal(result, undefined, command);
	}
});

test("S3: a delivery command outside a Git worktree never reads review state, so it never initializes Git there", async t => {
	const dir = mkdtempSync(join(tmpdir(), "rdd-nogit-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const { result, notices, statusCalls, modeCalls } = await run("on", "gh pr create --fill", async () => unreviewed, dir);
	assert.equal(result, undefined);
	assert.deepEqual(notices, []);
	assert.equal(statusCalls, 0);
	assert.equal(modeCalls, 0);
	assert.equal(existsSync(join(dir, ".git")), false);
});

test("S3: a STATUS failure or a reviewed candidate shows no notice and never denies", async () => {
	const failed = await run("on", "git push", async () => { throw new Error("status unavailable"); });
	assert.equal(failed.result, undefined);
	assert.deepEqual(failed.notices, []);
	const reviewed = await run("on", "git push", async () => ({ ...unreviewed, nextTransition: undefined }));
	assert.equal(reviewed.result, undefined);
	assert.deepEqual(reviewed.notices, []);
});

test("S3: RDD off never reads STATUS, and a non-delivery command never reads it either", async () => {
	const off = await run("off", "git push", async () => unreviewed);
	assert.equal(off.result, undefined);
	assert.deepEqual(off.notices, []);
	assert.equal(off.statusCalls, 0);
	const other = await run("on", "git status && echo done", async () => unreviewed);
	assert.equal(other.result, undefined);
	assert.deepEqual(other.notices, []);
	assert.equal(other.statusCalls, 0);
});
