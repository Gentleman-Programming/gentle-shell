import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

test("RDD off plans retain checks and reject invalid input before native calls", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "independent-rdd-regression-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], {
		cwd: root,
		env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	const state = join(root, "state.json");
	writeFileSync(state, '{"authority":"unchanged"}\n');
	const hash = () => createHash("sha256").update(readFileSync(state)).digest("hex");
	const before = hash();
	const tools = new Map<string, any>();
	const calls = { mode: 0, assess: 0, target: 0, append: 0 };
	createGentleAiExtension({ candidateViews: null, nativeReviewCli: {
		reviewMode: async () => { calls.mode++; return { status: { effective: "off", source: "global" } }; },
		assess: async () => { calls.assess++; throw Error("must not assess"); },
		targetStatus: async () => { calls.target++; throw Error("must not query target"); },
	} as any })({
		on() {}, registerCommand() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
		appendEntry() { calls.append++; },
	} as any);
	const registry = [...tools.keys()];
	const invoke = (input?: unknown, signal?: AbortSignal) => tools.get("gentle_review").execute(
		"probe", { operation: "assess", ...(input === undefined ? {} : { input }) }, signal, undefined, { cwd: root },
	);
	for (const [input, message] of [
		[{ baseRef: "HEAD" }, "Review assess baseRef requires committedOnly: true"],
		[{ committedOnly: true }, "Review assess committedOnly requires an explicit baseRef"],
		[{ escalate: { item: 0, reason: "Changes authority" } }, "escalate item must be an integer from 1 to 6 naming a high-risk item"],
		[{ escalate: { item: 7, reason: "Changes authority" } }, "escalate item must be an integer from 1 to 6 naming a high-risk item"],
	] as const) {
		await assert.rejects(() => invoke(input), { message });
		assert.equal(hash(), before);
		assert.deepEqual([...tools.keys()], registry);
		assert.deepEqual(calls, { mode: 0, assess: 0, target: 0, append: 0 });
	}
	await assert.rejects(() => invoke(undefined, AbortSignal.abort()), { message: "Review controller operation was cancelled" });
	assert.deepEqual(calls, { mode: 0, assess: 0, target: 0, append: 0 });
	for (const escalate of [undefined, { item: 6, reason: "Changes the shared state owner" }]) {
		const result = await invoke({ baseRef: "HEAD", committedOnly: true, nativeReviewOutcome: "closed", ...(escalate ? { escalate } : {}) });
		const details = result.details;
		assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(details) }]);
		assert.equal(details.rddLine, "off");
		assert.equal(details.nativeRisk, "unassessable");
		assert.equal(details.risk, escalate ? "high" : "medium");
		assert.equal(details.candidate, null);
		assert.equal(details.nativeReviewOutcome, "unknown");
		assert.equal(details.changedPaths, 0);
		assert.equal(details.changedLines, 0);
		assert.match(details.reasons[0].detail, /counts were not measured/);
		for (const key of ["reviewDue", "reviewDueReason", "nextTransition"]) assert.equal(Object.hasOwn(details, key), false);
		assert.equal(details.plan.writerSelfVerification, true);
		assert.equal(details.plan.structuralReadbackOnly, false);
		assert.equal(details.plan.independentVerifier, Boolean(escalate));
		assert.equal(hash(), before);
		assert.deepEqual([...tools.keys()], registry);
	}
	assert.deepEqual(calls, { mode: 2, assess: 0, target: 0, append: 0 });
});
