import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { canonicalHash } from "../lib/review-transaction.ts";

const GENERIC_PREFIX = "Judgment Day fix dispatch requires exactly one `agent: \"jd-fix-agent\"`,";
const row = (id: string) => ({ id, lens: "judgment-day", location: "src/target.ts:1", severity: "CRITICAL", status_at_freeze: "open",
	evidence_class: "deterministic", evidence_claim: "Controlled concrete impact at the frozen location." });

function task(o: { ids?: string[]; rows?: unknown[]; hash?: string; rowLines?: string[]; skip?: string } = {}) {
	const rows = o.rows ?? [row("JD-A-001")];
	const ids = o.ids ?? ["JD-A-001"];
	const sections = [
		["## Judgment Day activation", "User explicitly requested Judgment Day."],
		["## Exact authorized severe IDs", ...ids.map(id => `- \`${id}\``)],
		["## Judgment Day correction batch", "Round: 1 of 2.", `Frozen ledger SHA-256: \`${o.hash ?? canonicalHash(rows)}\``],
		["## Exact frozen finding rows", ...(o.rowLines ?? rows.map(r => JSON.stringify(r)))],
		["## Allowed edit surfaces", "src/target.ts"],
	].filter(section => section[0] !== o.skip);
	return { agent: "jd-fix-agent", task: sections.flat().join("\n") };
}

async function admit(t: test.TestContext, input: unknown) {
	const cwd = mkdtempSync(join(tmpdir(), "judgment-diagnostics-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	type Handler = (event: { toolName: string; input: unknown }, ctx: ExtensionContext) => Promise<{ block?: boolean; reason?: string } | undefined>;
	const handlers = new Map<string, Handler>();
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })({
		on: (name: string, handler: Handler) => handlers.set(name, handler), events: { emit() {} }, registerCommand() {}, registerTool() {},
	} as unknown as ExtensionAPI);
	return handlers.get("tool_call")!({ toolName: "subagent_run", input }, {
		cwd, hasUI: false, getContextUsage: () => ({ tokens: 1000, contextWindow: 272000, percent: 1 }),
	} as unknown as ExtensionContext);
}

test("#3361 S1: each failed clause gets its own line after the unchanged generic first line", async t => {
	const missing = await admit(t, task({ skip: "## Exact frozen finding rows" }));
	assert.equal(missing?.block, true);
	let lines = missing!.reason!.split("\n");
	assert.ok(lines[0]!.startsWith(GENERIC_PREFIX));
	assert.ok(lines.includes("Dispatch sections are missing, duplicated, malformed or out of order; required exact headings in order: `## Judgment Day activation`, `## Exact authorized severe IDs`, `## Judgment Day correction batch`, `## Exact frozen finding rows`, `## Allowed edit surfaces`."), missing!.reason);

	const bad = await admit(t, task({ rowLines: ["not json"] }));
	lines = bad!.reason!.split("\n");
	assert.ok(lines.includes("Frozen finding row 1 is not canonical: it must be one JSON object per line with exactly the fields id, lens, location, severity, status_at_freeze, evidence_class, evidence_claim, lens `judgment-day`, severity BLOCKER or CRITICAL, status_at_freeze `open`, and non-empty text fields."), bad!.reason);

	const mismatch = await admit(t, task({ ids: ["JD-A-001", "JD-A-002"] }));
	lines = mismatch!.reason!.split("\n");
	assert.ok(lines.includes("Authorized IDs (JD-A-001, JD-A-002) must equal the BLOCKER/CRITICAL open frozen row IDs (JD-A-001) in the same order, one row per ID, no duplicates."), mismatch!.reason);
	assert.equal(lines.filter(l => l.startsWith("Frozen ledger SHA-256 mismatch")).length, 0, "no hash line when rows are not usable");
});

test("#3361 S2: hash mismatch states the expected digest and the formula", async t => {
	const rejected = await admit(t, task({ hash: "0".repeat(64) }));
	assert.equal(rejected?.block, true);
	const expected = canonicalHash([row("JD-A-001")]);
	assert.ok(rejected!.reason!.split("\n").includes(`Frozen ledger SHA-256 mismatch: declared \`${"0".repeat(64)}\`, expected \`${expected}\`. The digest is the lowercase SHA-256 of the canonical JSON (compact, sorted keys) of the parsed frozen rows ARRAY of this dispatch, not of the row text and not of the full ledger.`), rejected!.reason);
});

test("#3361 S3: an ID outside the grammar is named with the grammar and an example", async t => {
	const rejected = await admit(t, task({ ids: ["JD-001"], rows: [row("JD-001")] }));
	assert.equal(rejected?.block, true);
	assert.ok(rejected!.reason!.split("\n").includes("Invalid authorized ID(s) `JD-001`: IDs must match `JD-[A-Z][A-Z0-9]*-\\d+` (the lens-letter segment is mandatory), for example `JD-A-001`."), rejected!.reason);
});

test("#3361 S4: skill docs state the hash preimage and the ID grammar", () => {
	for (const file of ["skills/judgment-day/SKILL.md", "skills/judgment-day/references/prompts-and-formats.md"]) {
		const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
		assert.ok(text.includes("`JD-[A-Z][A-Z0-9]*-\\d+`"), `${file} ID grammar`);
		assert.ok(text.includes("JSON array of the dispatched rows"), `${file} preimage`);
		assert.ok(text.includes("compact, sorted-keys"), `${file} canonical form`);
		assert.ok(text.includes("covers the dispatched rows only"), `${file} label scope`);
		assert.ok(text.includes("Frozen ledger SHA-256"), `${file} label unchanged`);
	}
});

test("#3361 S5: strictness unchanged: canonical dispatch admitted, non-canonical still rejected", async t => {
	assert.equal(await admit(t, task()), undefined);
	assert.equal(await admit(t, task({ rows: [row("JD-A-001"), row("JD-B-002")], ids: ["JD-A-001", "JD-B-002"] })), undefined);
	for (const bad of [task({ hash: "0".repeat(64) }), task({ ids: ["JD-001"], rows: [row("JD-001")] }), task({ rowLines: ["x"] }), task({ skip: "## Allowed edit surfaces" })]) {
		assert.equal((await admit(t, bad))?.block, true);
	}
});
