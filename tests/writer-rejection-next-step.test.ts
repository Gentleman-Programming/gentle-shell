import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rejectUndocumentedWriterLaunch, WRITER_FEATURE_DOCUMENT_REJECTION } from "../lib/bounded-writer-admission.ts";

// odd/tasks/orchestrator-owns-correction-exhaustion.md S5/T6, narrowed by the maintainer to option B: admission is
// unchanged (no user-requested reason), but a rejected writer never ends the parent's turn blocked. Small understood
// work goes inline with a one-line reason; when the user explicitly required delegation, the parent asks with
// `ask_user_choice` (inline recommended, ODD task, full delegation, plus the typed answer) and continues independent work.

const surfaces = "\n\n## Allowed edit surfaces\nsrc/budget.ts\n";

function rejection(): string {
	const root = mkdtempSync(join(tmpdir(), "writer-rejection-next-step-"));
	try {
		const denied = rejectUndocumentedWriterLaunch({ agent: "gentle-ai-worker", task: `Fix the budget rounding. The user said: delegate this.${surfaces}` }, { root, contextUsage: { tokens: 20_000, contextWindow: 400_000 } });
		assert.equal(denied?.block, true, "admission still rejects a small organic writer");
		return denied!.reason;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("S5: the rejection of a small organic writer never ends the turn blocked", () => {
	const reason = rejection();
	assert.equal(reason, WRITER_FEATURE_DOCUMENT_REJECTION);
	assert.match(reason, /Never end the turn blocked on this rejection/);
	assert.match(reason, /continue independent work/);
});

test("S5: small understood work goes inline with a one-line reason about cost", () => {
	const reason = rejection();
	assert.match(reason, /say in one line that delegation was refused because a writer costs more tokens and time than this small unit/);
	assert.ok(reason.endsWith("write this unit inline yourself now; do not retry the launch, and never create a feature document only to launch writers."), "today's inline instruction still closes the message");
});

test("S5: a user who explicitly required delegation is asked with ask_user_choice, inline recommended, three options plus the typed answer", () => {
	const reason = rejection();
	assert.match(reason, /If the user explicitly required delegation, ask with `ask_user_choice` instead/);
	const inline = reason.indexOf("Do it inline (Recommended");
	const odd = reason.indexOf("Track it as an ODD task");
	const full = reason.indexOf("Switch to full delegation");
	assert.ok(inline !== -1 && odd > inline && full > odd, "the three options are named in order, inline first and recommended");
	assert.match(reason, /Do it inline \(Recommended for small work: a writer spends more tokens and time starting than the change takes\)/);
	assert.match(reason, /keep the typed answer/);
	assert.match(reason, /follow the answer/);
});

test("S5: the writer module tells the parent the same next step after a rejection", () => {
	const writer = readFileSync(new URL("../assets/orchestrator-writer.md", import.meta.url), "utf8");
	assert.ok(writer.includes("after an admission rejection, repair what it names once, never relaunch the same prompt unchanged, and never end the turn on one: take the next step it names."), "orchestrator-writer.md must state the next step");
	assert.ok(Buffer.byteLength(writer) <= 5_426, `orchestrator-writer.md stays within its cap (${Buffer.byteLength(writer)})`);
});
