import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderShellSidebarBar, type ShellBarModel, type ShellBarTheme } from "../lib/shell-bar.ts";
import { reviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";

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
