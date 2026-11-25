import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// These contracts check the instructions delivered to the model, not model adherence.
const heading = "## Authorized work continuity\n\n";
const modes = ["organic", "full-delegation"] as const;
let scratch: string;
before(() => { scratch = mkdtempSync(join(tmpdir(), "gentle-turn-end-")); });
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function render(mode: (typeof modes)[number] = "organic") {
	const prompt = __testing.buildGentlePrompt("gentleman", scratch, ["read"], undefined, "tui", mode);
	const start = prompt.indexOf(heading);
	const end = prompt.indexOf("Default workflow: Organic Driven Development", start);
	assert.ok(start >= 0 && end > start, "continuity is delivered before ODD");
	const section = prompt.slice(start, end);
	const body = section.slice(heading.length);
	return { prompt, section, body, opening: body.split("\n\n", 1)[0] };
}

function clauses(text: string, ...expected: string[]): void {
	for (const clause of expected) assert.ok(text.includes(clause), `missing delivered clause: ${clause}`);
}

function paragraph(body: string, label: string): string {
	const match = body.split("\n\n").find((entry) => entry.startsWith(label));
	assert.ok(match, `missing scoped paragraph: ${label}`);
	return match;
}

test("S1: the positive end-of-turn rule opens the section and requires observed delivery checks", (t) => {
	const prompts = modes.map((mode) => ({ mode, ...render(mode) }));
	for (const { mode, prompt, section } of prompts) {
		t.diagnostic(`${mode} harness ${Buffer.byteLength(prompt)} B; continuity section ${Buffer.byteLength(section)} B (including heading and trailing separator)`);
	}
	for (const { opening } of prompts) {
		assert.match(opening, /^End the turn only when observed checks confirm the requested outcome is delivered;/);
	}
});

test("S1: a first failed, timed-out or empty attempt continues when a permitted route remains", () => {
	const { opening, body } = render();
	clauses(opening, "or failure leaves no permitted route.");
	clauses(paragraph(body, "An obstacle is an ordinary failure:"),
		"a failed, timed-out or empty command, test or tool, or a locked file",
		"Name the cause from output.",
		"Change approach and continue if a permitted route remains.");
});

test("S1: a genuine dead end ends only that work as incomplete, with tried and missing evidence", () => {
	const { opening, body } = render();
	clauses(opening, "or failure leaves no permitted route. Continue independent authorized work.");
	clauses(paragraph(body, "An obstacle is an ordinary failure:"),
		"Change approach and continue if a permitted route remains. Otherwise report only that work incomplete, with attempts and gaps, not delivery or invented retries.");
});

test("S1: an authorized step that can run now is run, not announced as later work", () => {
	for (const mode of modes) clauses(render(mode).body, "Run the authorized next step now.");
});

test("S1: an action permits a wait only when it will wake the turn and no independent work remains", () => {
	const { opening, body } = render();
	clauses(opening, "work that will wake you is running (a wait) and no independent authorized work remains");
	clauses(paragraph(body, "Background work:"),
		"Launch the bounded action and keep its identity.",
		"A wait is launched work whose completion event resumes the turn and authorized work without the human.",
		"Do not poll or ask the human to continue.",
		"Promise a report only if work that will wake you is already running.");
});

test("S1: missing human-only input and an explicit human stop affect only their work", () => {
	const { opening, body } = render();
	clauses(opening, "only the human can give a needed decision, consent or permission", "Continue independent authorized work.");
	clauses(body, "An explicit user stop applies only to the work it names. Treat it as an exhausted limit.");
});

test("S1: exhaustion ends only the action under the explicit limit; independent work continues", () => {
	const { opening, body } = render();
	clauses(opening, "an explicit limit is exhausted;", "Continue independent authorized work.");
	clauses(body, "binds only the work it names", "Honor one-run, no-retry and diagnostic-only limits.", "Do not add retry allowances.");
});

test("S2: an obstacle is an ordinary failure, not a denial or an end by itself", () => {
	const { body } = render();
	const obstacle = paragraph(body, "An obstacle is an ordinary failure:");
	clauses(obstacle, "Change approach and continue if a permitted route remains.");
	assert.doesNotMatch(obstacle, /\b(?:stop|blocked|denial)\b/);
});

test("S2: a limit is explicit, scoped, and neither reset, widened nor dodged", () => {
	clauses(render().body,
		"A limit is explicit, set by the human, a tool or native review, and binds only the work it names.",
		"Never reset, widen or dodge a limit, even in a new session.");
});

test("S2: a wait is launched work that wakes the turn without the human", () => {
	clauses(render().body, "A wait is launched work whose completion event resumes the turn and authorized work without the human.");
});

test("S3: explicit limits bound check correction without weakening checks or overriding outcomes", () => {
	clauses(paragraph(render().body, "Explicit limits:"),
		"Honor one-run, no-retry and diagnostic-only limits.",
		"Correct checks within their correction limit. Never weaken checks or override final outcomes.");
});

test("S3/S11: a worker-local repeated-cause stop hands back to the parent under native authority in both modes", () => {
	for (const mode of modes) {
		const worker = paragraph(render(mode).body, "Worker exhaustion:");
		clauses(worker,
			"A worker-local cause recurring after a real fix without a new hypothesis ends the worker's cycle, not the unit.",
			"The parent owns the next step, unasked, within native authority.",
			"Partial worker execution is not exhausted proof or a terminal native review outcome.",
			"On any partial, diagnose from evidence; confirm no child is active or uncertain. Within user-authorized scope:",
			mode === "organic"
				? "fix inline if small and understood, or relaunch with changed scope, hypothesis or handoff plus new evidence."
				: "never edit: launch a new bounded writer with the diagnosis, new evidence and changed scope or hypothesis.",
			"Never repeat an attempt or swap executors to dodge limits.",
			"No permitted route: report only that work incomplete; continue independent work.",
			"Close ends the automatic cycle; later explicit requests stay subject to native authority.",
			"Quota recovery: `orchestrator-quota-recovery.md`.");
		if (mode === "full-delegation") assert.doesNotMatch(worker, /\binline\b/);
	}
});

test("S3: contextual approval grants neither provider consent nor distinct permissions", () => {
	clauses(render().body,
		"Contextual approval never substitutes for provider-owned consent, exact-token authorization, or separate publishing and destructive-action permission.",
		"Do not infer permission for publishing, destructive actions, unrelated scope or native consent.");
});

test("S3: worker-prohibited maintenance and rollback retain their exact parent-only safeguards", () => {
	const { body } = render();
	assert.equal(paragraph(body, "Worker-prohibited maintenance or rollback:"),
		"Worker-prohibited maintenance or rollback: Only the parent may act; load `orchestrator-maintenance.md` and verify its prerequisites first.");
	assert.ok(!body.includes("validated backup"), "maintenance details are loaded only when needed");
	const maintenance = readFileSync(new URL("../assets/orchestrator-maintenance.md", import.meta.url), "utf8");
	clauses(maintenance,
		"Parent only: load before considering worker-prohibited maintenance or rollback. Worker prohibitions remain unchanged.",
		"Only the parent may act, with explicit human authorization for the operation itself, established exact scope, ownership and preservation, and available permitted tools.",
		"Fresh runtime/native consent and guards remain binding.",
		"Broad feature authorization is not destructive authority.",
		"Never bypass a denial via another worker or tool.",
		"Upgrade: require a validated backup, artifact and migration validation where applicable, and a recovery path.",
		"Rollback: preserve unrelated edits even in the same file, remove only proven task-created helpers, and never blanket restore, reset or clean.",
		"Do not proceed with ambiguous ownership, a denial or any missing prerequisite.",
		"This route is guidance, not authorization.");
});

test("S5: deliberate access and safety boundaries stay intact while a permitted route is sought", () => {
	clauses(render().body, "Respect protected files, withheld access and guardrails; report the boundary. Change approach and continue if a permitted route remains.");
});
