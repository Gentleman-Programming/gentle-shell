import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderShellSidebarBar, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { createReviewSidebarPublisher, reviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { decodeReviewStatusV3 } from "../lib/review-integration-v2.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Display contract only: lifecycle evidence must be normalized by the producer,
// never inferred from a successful tool execution by the renderer.
const theme: ShellBarTheme = { fg: (_color, text) => text, bold: (text) => text };
type ReviewDisplay = { state: "reviewing" | "in_review" | "approved" | "closed" | "unavailable"; scope: string };
function model(review?: ReviewDisplay): ShellBarModel & { review?: ReviewDisplay } {
	return {
		cwd: "/repo",
		branch: "main",
		dirty: undefined,
		sessionName: undefined,
		modelId: "test-model",
		effort: undefined,
		contextPercent: null,
		contextWindow: 0,
		costTotal: 0,
		subscription: false,
		usage: undefined,
		statuses: [],
		review,
	};
}

test("RDD maps explicit native evidence conservatively without parsing opaque bindings", () => {
	const nativeStatus = (state: string, paths: unknown = ["src/app.ts", "test/app.test.ts", "README.md"]) => ({
		result: {
			schema: "gentle-ai.review-integration.status/v9",
			authority: { state }, projection: { paths }, next_transition: { kind: "collect" },
		},
	});
	assert.deepEqual(reviewSidebarSnapshot("status", nativeStatus("reviewing")), { state: "in_review", scope: "app.ts +2" });
	for (const [state, expected] of [["approved", "approved"], ["correction_required", "correction"], ["invalidated", "invalidated"], ["validating", "in_review"]] as const) {
		assert.equal(reviewSidebarSnapshot("status", nativeStatus(state)).state, expected);
	}
	const closure = { status: "closed", outcome: "native-last-event-closure", closure: { schema: "gentle-ai.review-last-event-closure/v1", state: "approved" } };
	assert.equal(reviewSidebarSnapshot("gentle_review_capture", closure).state, "approved");
	assert.equal(reviewSidebarSnapshot("gentle_review_capture_group", closure).state, "approved");
	assert.equal(reviewSidebarSnapshot("gentle_review_capture_group", { status: "blocked", outcome: "reviewer-model-run-forecast" }).state, "forecast");
	const burned = { operation: "acknowledge-approved", status: "closed", outcome: "native-approved-acknowledgement-completed", authority: "burned" };
	assert.equal(reviewSidebarSnapshot("acknowledge-approved", burned).state, "closed");
	for (const missing of ["operation", "status", "outcome", "authority"]) {
		const incomplete: Record<string, unknown> = { ...burned };
		delete incomplete[missing];
		assert.notEqual(reviewSidebarSnapshot("acknowledge-approved", incomplete).state, "closed");
	}
	assert.notEqual(reviewSidebarSnapshot("gentle_review_capture", burned).state, "closed");
	assert.equal(reviewSidebarSnapshot("answer-consent", { outcome: "consent-declined-this-candidate" }).state, "declined");
	assert.equal(reviewSidebarSnapshot("start", { outcome: "native-review-consent-required" }).state, "consent");
	assert.deepEqual(reviewSidebarSnapshot("inspect", {
		operation: "answer-consent", result: { action: "created", state: "reviewing" },
		actor_binding: { candidate_paths: ["lib/app.ts"] },
	}), { state: "in_review", scope: "app.ts" });
	assert.equal(reviewSidebarSnapshot("status", nativeStatus("reviewing", ["src\\app.ts"])).scope, "app.ts");
	assert.equal(reviewSidebarSnapshot("status", { ...nativeStatus("approved"), native_failure: {} }).state, "unavailable");
	assert.equal(reviewSidebarSnapshot("status", { result: { ...nativeStatus("approved").result, next_transition: { kind: "stop" } } }).state, "unavailable");
	for (const paths of [null, [], [null], ["/"]]) {
		assert.equal(reviewSidebarSnapshot("status", nativeStatus("reviewing", paths)).scope, "Candidate scope unavailable");
	}
	assert.deepEqual(reviewSidebarSnapshot("status", { status: "closed", collectBinding: "opaque", title: "Invented title" }), { state: "unknown", scope: "Candidate scope unavailable" });
});


for (const action of ["created", "resumed", "replayed"]) {
	test(`RDD treats ${action} START results as pending review, not active execution`, () => {
		for (const operation of ["start", "answer-consent", "select-intended-untracked"]) {
			for (const state of ["reviewing", "validating"]) {
				assert.deepEqual(reviewSidebarSnapshot(operation, {
					operation, result: { action, state },
					actor_binding: { candidate_paths: ["lib/app.ts"] },
				}), { state: "in_review", scope: "app.ts" });
			}
		}
	});
}

test("RDD completed STATUS evidence does not imply capture execution", () => {
	for (const state of ["reviewing", "validating"]) {
		for (const kind of ["collect", "execute"]) {
			const snapshot = reviewSidebarSnapshot("status", {
				result: {
					schema: "gentle-ai.review-integration.status/v9",
					authority: { state }, projection: { paths: ["lib/app.ts"] },
					next_transition: { kind },
				},
			});
			assert.deepEqual(snapshot, { state: "in_review", scope: "app.ts" });
			const pending = renderShellSidebarBar({ ...model(), review: snapshot }, theme, 46).join("\n");
			assert.match(pending, /In review/);
			assert.doesNotMatch(pending, /Reviewing/);
		}
	}
	// The future publisher owns execution evidence; this slice only renders its
	// explicit display state, never inferring it from a completed native result.
	const active = renderShellSidebarBar(model({ state: "reviewing", scope: "app.ts" }), theme, 46).join("\n");
	assert.match(active, /Reviewing/);
	assert.doesNotMatch(active, /In review/);
});

test("publisher retains scope only for issued capture bindings and matching closure", async () => {
	const events: Array<{ snapshot: { state: string; scope: string } }> = [];
	const publisher = createReviewSidebarPublisher({ events: { emit: (_name: string, event: typeof events[number]) => events.push(event) } } as unknown as ExtensionAPI);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	publisher.reset(ctx);
	const run = (name: string, params: Record<string, unknown>, details: unknown) => publisher.tool({
		name, label: "Test", description: "Test", parameters: { type: "object" } as never,
		async execute() { return { content: [], details }; },
	}).execute("call", params as never, undefined, undefined, ctx);
	const status = { result: { schema: "gentle-ai.review-integration.status/v9", authority: { state: "reviewing", lineage_id: "lineage" }, target_identity: "target", applicability: "current_target", projection: { paths: ["src/app.ts"] }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: "issued" }] };
	await run("gentle_review", { operation: "status", lineageId: "lineage" }, status);
	assert.deepEqual(events.at(-1)?.snapshot, { state: "in_review", scope: "app.ts" });
	await run("gentle_review_capture", { lineageId: "lineage", collectBinding: "issued" }, { outcome: "reviewer-model-run-forecast" });
	assert.deepEqual(events.at(-1)?.snapshot, { state: "forecast", scope: "app.ts" });
	await run("gentle_review_capture", { lineageId: "lineage", collectBinding: "wrong" }, { outcome: "reviewer-model-run-forecast" });
	assert.equal(events.at(-1)?.snapshot.scope, "Candidate scope unavailable");
});

test("real facade STATUS binding retains sidebar scope through capture forecast", async () => {
	const raw = JSON.parse(readFileSync(new URL("./fixtures/devbinary/status-v5-capture-result-submission.captured.json", import.meta.url), "utf8"));
	raw.action = "stop";
	const status = decodeReviewStatusV3(raw);
	const lineageId = status.authority!.lineageId;
	const native = { targetStatus: async () => status } as unknown as NativeReviewCli;
	const listed = await __testing.executeReviewControllerOperation({ operation: "status", lineageId }, process.cwd(), native, undefined, null);
	const binding = (listed.collectBindings as Array<{ collectBinding: string }>)[0].collectBinding;
	const h = publisherFixture();
	await h.run("gentle_review", { operation: "status", lineageId }, listed);
	assert.deepEqual(h.snapshot(), { state: "in_review", scope: "add.js" });
	const params = { lineageId, collectBinding: binding };
	const forecast = await __testing.executeReviewCaptureOperation(params, process.cwd(), native, undefined, null);
	assert.equal(forecast.outcome, "reviewer-model-run-forecast");
	await h.run("gentle_review_capture", params, forecast);
	assert.deepEqual(h.snapshot(), { state: "forecast", scope: "add.js" });
});

test("publisher ignores late completions after reset without changing results", async () => {
	const events: unknown[] = [];
	const publisher = createReviewSidebarPublisher({ events: { emit: (_name: string, event: unknown) => events.push(event) } } as unknown as ExtensionAPI);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionContext;
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => { finish = resolve; });
	const result = { content: [], details: { status: "blocked" } };
	const tool = publisher.tool({ name: "gentle_review", label: "Test", description: "Test", parameters: { type: "object" } as never, async execute() { await pending; return result; } });
	publisher.reset(ctx);
	const call = tool.execute("call", { operation: "status" } as never, undefined, undefined, ctx);
	publisher.reset(ctx);
	finish();
	assert.equal(await call, result);
	assert.equal(events.length, 1);
});

function publisherFixture() {
	const events: Array<{ sessionId: string; snapshot: { state: string; scope: string } }> = [];
	const publisher = createReviewSidebarPublisher({ events: { emit: (_name: string, event: typeof events[number]) => events.push(event) } } as unknown as ExtensionAPI);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "own" } } as unknown as ExtensionContext;
	publisher.reset(ctx);
	const run = (name: string, params: Record<string, unknown>, details: unknown | Promise<unknown>, context = ctx) => publisher.tool({
		name, label: "Test", description: "Test", parameters: { type: "object" } as never,
		async execute() { return { content: [], details: await details }; },
	}).execute("call", params as never, undefined, undefined, context);
	const status = { result: { schema: "gentle-ai.review-integration.status/v9", authority: { state: "reviewing", lineage_id: "lineage" }, target_identity: "target", applicability: "current_target", projection: { paths: ["src/app.ts"] }, next_transition: { kind: "collect" } }, collectBindings: [{ collectBinding: "first" }, { collectBinding: "second" }] };
	const seed = () => run("gentle_review", { operation: "status", lineageId: "lineage" }, status);
	const snapshot = () => events.at(-1)!.snapshot;
	const closure = { tool: "gentle_review_capture", status: "closed", outcome: "native-last-event-closure", lineage_id: "lineage", closure: { schema: "gentle-ai.review-last-event-closure/v1", lineage_id: "lineage", target_identity: "target", state: "approved" } };
	const acknowledged = { operation: "acknowledge-approved", status: "closed", outcome: "native-approved-acknowledgement-completed", lineage_id: "lineage", target_identity: "target", authority: "burned" };
	const captured = { tool: "gentle_review_capture", status: "captured", outcome: "native-reviewer-result-captured", lineage_id: "lineage", host_relay: { transport: "pi_host_relay", lens: "review-risk", order: "0", subject_hash: "sha256:fixture", prompt_bytes: 10, result_bytes: 20, submission: '{"state":"approved","authority":"burned"}' } };
	return { run, seed, snapshot, publisher, ctx, events, closure, acknowledged, captured };
}

for (const name of ["gentle_review_capture", "gentle_review_capture_group"]) {
	test(`${name} retains issued scope through forecast, active capture, closure and matching acknowledgement`, async () => {
		const h = publisherFixture();
		await h.seed();
		assert.deepEqual(h.snapshot(), { state: "in_review", scope: "app.ts" });
		const params = { lineageId: "lineage", ...(name.endsWith("group") ? { collectBindings: ["first", "second"] } : { collectBinding: "first" }) };
		await h.run(name, params, { outcome: "reviewer-model-run-forecast" });
		assert.deepEqual(h.snapshot(), { state: "forecast", scope: "app.ts" });
		let finish!: (value: unknown) => void;
		const pending = h.run(name, { ...params, reviewerRunAcknowledged: true }, new Promise((resolve) => { finish = resolve; }));
		try {
			assert.deepEqual(h.snapshot(), { state: "reviewing", scope: "app.ts" });
		} finally {
			finish({ ...h.closure, tool: name });
			await pending;
		}
		assert.deepEqual(h.snapshot(), { state: "approved", scope: "app.ts" });
		await h.run("gentle_review", { operation: "acknowledge-approved", lineageId: "lineage" }, h.acknowledged);
		assert.deepEqual(h.snapshot(), { state: "closed", scope: "app.ts" });
	});
}

test("separate issued captures retain only remaining binding until terminal closure", async () => {
	const h = publisherFixture();
	await h.seed();
	for (const binding of ["first", "second"]) {
		await h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: binding }, h.captured);
		assert.deepEqual(h.snapshot(), { state: "in_review", scope: "app.ts" });
	}
	await h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: "first" }, h.captured);
	assert.deepEqual(h.snapshot(), { state: "unknown", scope: "Candidate scope unavailable" });
	await h.seed();
	await h.run("gentle_review_capture_group", { lineageId: "lineage", collectBindings: ["first", "second"] }, { ...h.closure, tool: "gentle_review_capture_group" });
	await h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: "second" }, h.captured);
	assert.deepEqual(h.snapshot(), { state: "unknown", scope: "Candidate scope unavailable" });
});

test("terminal closure requires its own matching identity despite matching wrapper", async () => {
	const h = publisherFixture();
	const params = { lineageId: "lineage", collectBinding: "first" };
	for (const closure of [
		{ ...h.closure.closure, lineage_id: "other" },
		{ ...h.closure.closure, target_identity: "other" },
		{ ...h.closure.closure, lineage_id: undefined },
		{ ...h.closure.closure, target_identity: undefined },
	]) {
		await h.seed();
		await h.run("gentle_review_capture", params, { ...h.closure, closure });
		assert.deepEqual(h.snapshot(), { state: "approved", scope: "Candidate scope unavailable" });
	}
});

test("nonterminal capture requires exact issued input and well-formed matching output", async () => {
	const h = publisherFixture();
	const bound = { lineageId: "lineage", collectBinding: "first", reviewerRunAcknowledged: true };
	for (const params of [
		{ lineageId: "lineage" }, { ...bound, collectBinding: "unissued" },
		{ ...bound, lineageId: "other" }, { ...bound, workspaceRoot: "/other" },
	]) {
		await h.seed();
		await h.run("gentle_review_capture", params, h.captured);
		assert.deepEqual(h.snapshot(), { state: "unknown", scope: "Candidate scope unavailable" });
	}
	for (const details of [
		{ ...h.captured, lineage_id: "other" }, { ...h.captured, target_identity: "other" },
		{ ...h.captured, target_identity: null }, { ...h.captured, lineage_id: undefined },
		{ ...h.captured, status: "closed" }, { ...h.captured, outcome: "unspecified" },
		{ ...h.captured, tool: "unrelated" }, { ...h.captured, host_relay: null },
		{ ...h.captured, host_relay: { ...h.captured.host_relay, transport: "other" } },
		{ ...h.captured, host_relay: { ...h.captured.host_relay, prompt_bytes: "10" } },
		{ ...h.captured, host_relay: { ...h.captured.host_relay, result_bytes: -1 } },
		{ ...h.captured, host_relay: { ...h.captured.host_relay, submission: {} } },
		{ ...h.captured, failure: { reason: "failed" } }, { status: "captured" },
	]) {
		await h.seed();
		await h.run("gentle_review_capture", bound, details);
		assert.equal(h.snapshot().scope, "Candidate scope unavailable");
		assert.ok(["unknown", "unavailable"].includes(h.snapshot().state));
	}
	await h.seed();
	await h.run("gentle_review_capture", bound, h.captured);
	assert.deepEqual(h.snapshot(), { state: "in_review", scope: "app.ts" }, "opaque submission must not imply closure");
	await h.run("gentle_review_capture", bound, h.captured);
	assert.deepEqual(h.snapshot(), { state: "unknown", scope: "Candidate scope unavailable" }, "completed capture consumes display binding");
});

test("unbound operations, mismatched acknowledgements, failures and resets discard stale identity", async () => {
	const h = publisherFixture();
	for (const params of [
		{ lineageId: "lineage" }, { lineageId: "lineage", collectBinding: "{}" },
		{ lineageId: "other", collectBinding: "first" },
		{ lineageId: "lineage", collectBinding: "first", workspaceRoot: "/other" },
		{ lineageId: "lineage", collectBindings: ["second", "first"] },
	]) {
		await h.seed();
		const name = "collectBindings" in params ? "gentle_review_capture_group" : "gentle_review_capture";
		const pending = h.run(name, params, { status: "blocked", outcome: "capture-binding-rejected" });
		assert.equal(h.snapshot().scope, "Candidate scope unavailable");
		await pending;
		assert.equal(h.snapshot().scope, "Candidate scope unavailable");
	}
	for (const operation of ["inspect", "start", "status"]) {
		await h.seed();
		const pending = h.run("gentle_review", { operation, lineageId: "lineage" }, { status: "blocked" });
		assert.deepEqual(h.snapshot(), { state: "checking", scope: "Candidate scope unavailable" });
		await pending;
	}
	for (const mismatch of [{ ...h.acknowledged, lineage_id: "other" }, { ...h.acknowledged, target_identity: "other" }]) {
		await h.seed();
		await h.run("gentle_review", { operation: "acknowledge-approved", lineageId: "lineage" }, mismatch);
		assert.deepEqual(h.snapshot(), { state: "closed", scope: "Candidate scope unavailable" });
	}
	await h.seed();
	await assert.rejects(h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: "first" }, Promise.reject(new Error("capture failed"))), /capture failed/);
	assert.deepEqual(h.snapshot(), { state: "unavailable", scope: "Candidate scope unavailable" });
	await h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: "first" }, h.closure);
	assert.equal(h.snapshot().scope, "Candidate scope unavailable");
	await h.seed();
	h.publisher.reset(h.ctx);
	await h.run("gentle_review_capture", { lineageId: "lineage", collectBinding: "first" }, h.closure);
	assert.equal(h.snapshot().scope, "Candidate scope unavailable");
});

test("foreign sessions, disabled publisher and event failures never change tool outcomes", async () => {
	const h = publisherFixture();
	await h.seed();
	const before = h.events.length;
	const foreign = { cwd: "/repo", sessionManager: { getSessionId: () => "foreign" } } as unknown as ExtensionContext;
	const result = await h.run("gentle_review", { operation: "status" }, { status: "blocked" }, foreign);
	assert.deepEqual(result.details, { status: "blocked" });
	assert.equal(h.events.length, before);
	h.publisher.reset();
	await h.run("gentle_review", { operation: "status" }, { status: "blocked" });
	assert.equal(h.events.length, before);
	const throwing = createReviewSidebarPublisher({ events: { emit: () => { throw Error("display failed"); } } } as unknown as ExtensionAPI);
	throwing.reset(h.ctx);
	const tool = throwing.tool({ name: "gentle_review", label: "Test", description: "Test", parameters: { type: "object" } as never, async execute() { return result; } });
	assert.equal(await tool.execute("call", { operation: "status" } as never, undefined, undefined, h.ctx), result);
});

test("RDD stays hidden without current-session evidence and occupies one group between Changes and Integrations", () => {
	assert.doesNotMatch(renderShellSidebarBar(model(), theme, 46).join("\n"), /RDD/);
	const text = renderShellSidebarBar(model({ state: "reviewing", scope: "app.ts +2" }), theme, 46).join("\n");
	assert.equal((text.match(/RDD/g) ?? []).length, 1);
	assert.ok(text.indexOf("Changes") < text.indexOf("RDD"));
	assert.ok(text.indexOf("RDD") < text.indexOf("Integrations"));
	assert.match(text, /Reviewing/);
	assert.match(text, /app\.ts \+2/);
});

test("RDD distinguishes approval awaiting acknowledgement from confirmed closure and wraps narrow scopes", () => {
	const approved = renderShellSidebarBar(model({ state: "approved", scope: "Candidate scope unavailable" }), theme, 60).join("\n");
	assert.match(approved, /Approved.*awaiting acknowledgement/);
	assert.doesNotMatch(approved, /Closed/);
	const closed = renderShellSidebarBar(model({ state: "closed", scope: "app.ts" }), theme, 46).join("\n");
	assert.match(closed, /Closed/);
	for (const width of [20, 32, 46]) {
		const lines = renderShellSidebarBar(model({ state: "reviewing", scope: "長い候補ファイル-name-with-many-characters.ts +2" }), theme, width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `RDD must fit ${width} columns`);
	}
});
