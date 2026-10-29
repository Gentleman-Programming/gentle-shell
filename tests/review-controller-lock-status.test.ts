import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli, NativeReviewStatusResult } from "../lib/native-review-cli.ts";

// Issue #184: gentle-ai 2.1.8 leaves review-transactions/v2/LOCK behind after
// ORDINARY successful operations and inventories it as {"status":"released"}.
// Only live lock claims — owned or ambiguous — may block the controller;
// released residue is dead-owner metadata already surfaced through the
// envelope's `evidence.authority_inventory` and must never dead-end
// INSPECT/STATUS mapping or the START precondition.
//
// The harness helpers below intentionally mirror (not import) the local
// fixtures of tests/review-controller-native-routing.test.ts, which does not
// export them and is concurrently edited on another branch.

interface RegisteredTool {
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ details?: unknown }>;
}

function runtime(nativeReviewCli: NativeReviewCli): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	const dependencies = { nativeReviewCli, candidateViews: null } as unknown as Parameters<typeof createGentleAiExtension>[0];
	createGentleAiExtension(dependencies)({
		on() {},
		registerTool(definition: RegisteredTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	return controller;
}

function context(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext;
}

function repository(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-lock-status-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Lock Test", "-c", "user.email=lock@example.invalid", "commit", "-m", "initial"], { cwd });
	return cwd;
}

// Exact shape gentle-ai 2.1.8 emits for the residual entry (no owner, no
// problem), reproduced empirically against the system binary.
const RELEASED_LOCK = { version: "compact-v2", path: "/repo/.git/gentle-ai/review-transactions/v2/LOCK", status: "released" } as const;
const OWNED_LOCK = { version: "compact-v2", path: "/repo/.git/gentle-ai/review-transactions/v2/LOCK", status: "owned", owner: { schema: "gentle-ai.review-store-lock/v1", ownerId: "owner", pid: 1, host: "host", acquiredAt: "2026-07-14T00:00:00Z" } } as const;
const AMBIGUOUS_LOCK = { version: "compact-v2", path: "/repo/.git/gentle-ai/review-transactions/v2/LOCK", status: "ambiguous", problem: "unreadable owner metadata" } as const;

function nativeStatus(cwd: string, status: string, locks: readonly unknown[]): NativeReviewStatusResult {
	return {
		repository: cwd,
		complete: true,
		authoritative: true,
		status,
		entries: [],
		locks,
		diagnostics: [],
		raw: { schema: "gentle-ai.review-authority-status/v1", operation: "review/status", repository: cwd, complete: true, authoritative: true, status, entries: [], locks, diagnostics: [] },
	} as NativeReviewStatusResult;
}

function fakeNative(status: NativeReviewStatusResult, onStart?: (request: Parameters<NativeReviewCli["start"]>[0]) => void): NativeReviewCli {
	const blocking = status.locks.some((lock) => (lock as { status?: string }).status !== "released");
	const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: status.repository, encoding: "utf8" }).trim();
	const targetIdentity = `sha256:${"a".repeat(64)}`;
	const projection = {
		schema: "gentle-ai.review-integration.projection/v1",
		kind: "current-changes",
		projection: "workspace",
		baseTree: tree,
		initialReviewTree: tree,
		currentCandidateTree: tree,
		pathsDigest: targetIdentity,
		paths: [],
		intendedUntracked: [],
		intendedUntrackedProof: targetIdentity,
		initialSnapshotIdentity: targetIdentity,
		currentSnapshotIdentity: targetIdentity,
	};
	return {
		start: async (request) => {
			onStart?.(request);
			return { lineageId: "native-lineage", state: "reviewing", riskLevel: "medium", selectedLenses: ["review-reliability"], changedFiles: 1, changedLines: 2, correctionBudget: 1, action: "created", lensesRequired: true };
		},
		finalize: async () => { throw new Error("finalize must not run"); },
		validate: async () => { throw new Error("validate must not run"); },
		bindSdd: async () => { throw new Error("bindSdd must not run"); },
		reviewStatus: async () => { throw new Error("inventory status must not run"); },
		targetStatus: async () => ({
			applicability: blocking ? "corrupted" : "unrelated",
			action: blocking ? "repair_authority" : "start",
			targetIdentity,
			projection,
			raw: { action: blocking ? "repair_authority" : "start", locks: status.locks, target_identity: targetIdentity, projection: { projection: "workspace" } },
		}),
	} as unknown as NativeReviewCli;
}

test("INSPECT treats released lock residue as non-blocking and still blocks on live lock claims", async (t) => {
	const cwd = repository(t);

	const released = await runtime(fakeNative(nativeStatus(cwd, "clean", [RELEASED_LOCK])))
		.execute("inspect-released", { operation: "inspect" }, undefined, undefined, context(cwd));
	const releasedDetails = released.details as Record<string, unknown>;
	assert.equal(releasedDetails.status, "ready");
	assert.equal((releasedDetails.result as Record<string, unknown>).action, "start");
	assert.deepEqual((releasedDetails.result as Record<string, unknown>).locks, [RELEASED_LOCK]);

	for (const scenario of [
		{ name: "owned", locks: [OWNED_LOCK] },
		{ name: "ambiguous", locks: [AMBIGUOUS_LOCK] },
		{ name: "released-plus-owned", locks: [RELEASED_LOCK, OWNED_LOCK] },
	]) {
		const blocked = await runtime(fakeNative(nativeStatus(cwd, "clean", scenario.locks)))
			.execute(`inspect-${scenario.name}`, { operation: "inspect" }, undefined, undefined, context(cwd));
		const details = blocked.details as Record<string, unknown>;
		assert.equal(details.status, "blocked", scenario.name);
		assert.equal((details.result as Record<string, unknown>).action, "repair_authority", scenario.name);
	}
});

test("START precondition ignores released lock residue and still blocks on live lock claims", async (t) => {
	const cwd = repository(t);

	const startRequests: Parameters<NativeReviewCli["start"]>[0][] = [];
	const proceeded = await runtime(fakeNative(nativeStatus(cwd, "clean", [RELEASED_LOCK]), (request) => { startRequests.push(request); }))
		.execute("start-released", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context(cwd));
	const proceededDetails = proceeded.details as Record<string, unknown>;
	assert.deepEqual(startRequests, [{ cwd, targetIdentity: `sha256:${"a".repeat(64)}`, projection: "workspace" }]);
	assert.equal((proceededDetails.result as Record<string, unknown>).lineage_id, "native-lineage");
	assert.notEqual(proceededDetails.outcome, "native-authority-lock-present");

	for (const scenario of [
		{ name: "owned", locks: [OWNED_LOCK] },
		{ name: "ambiguous", locks: [AMBIGUOUS_LOCK] },
		{ name: "released-plus-ambiguous", locks: [RELEASED_LOCK, AMBIGUOUS_LOCK] },
	]) {
		let mutations = 0;
		const blocked = await runtime(fakeNative(nativeStatus(cwd, "clean", scenario.locks), () => { mutations += 1; }))
			.execute(`start-${scenario.name}`, { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, context(cwd));
		const details = blocked.details as Record<string, unknown>;
		assert.equal(mutations, 0, scenario.name);
		assert.equal(details.status, "blocked", scenario.name);
		assert.equal((details.result as Record<string, unknown>).action, "repair_authority", scenario.name);
	}
});
