import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentBody } from "../lib/agent-assets.ts";
import { parseAgentDefinition } from "../lib/agents-config.ts";

// #3082 S1-S4: instruction delivery and managed-body packaging only.
// These tests do not prove runtime freezing, model compliance, or incident closure.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const path = "assets/agents/gentle-ai-verify.md";
const source = read(path);
const agent = parseAgentDefinition(source, path, "global");
assert.ok(!("error" in agent));
const verify = agent.instructions;
const parent = read("assets/orchestrator-verification.md");
const docs = read("docs/delegated-verification.md");

function clauses(text: string, required: readonly string[], label: string): void {
	for (const clause of required) assert.ok(text.includes(clause), `${label} is missing: ${clause}`);
}

const delivered = [["verifier", verify], ["docs", docs]] as const;

test("S1: frozen full specification has an identity independent of committed code", () => {
	assert.ok(parent.includes("`gentle-ai-verify` holds the checklist; read it first"));
	assert.ok(parent.includes("the runtime removes each subagent's own TMPDIR, which holds that copy"));
	for (const [label, text] of delivered) clauses(text, [
		"frozen full specification",
		"content digest",
		"exact content or a snapshot",
		"including the whole feature document and `## Log`",
		"need not share the code commit",
		"uncommitted task document is a non-code input",
		"named non-code payload inputs",
		"isolated source and specification match the supplied identities before probes",
	], label);
	clauses(verify, ["Bind verification inputs to the commits the parent named (baseline and candidate)"], "commit binding");
});

test("S1: mutable bookkeeping is separate but real requirement drift is reconciled", () => {
	for (const [label, text] of delivered) clauses(text, [
		"mutable progress and receipts",
		"Do not require whole live task-document equality",
		"Progress-only updates do not change the frozen inputs",
		"source or requirement changes need an explicit reconciled handoff",
		"do not silently discard requirements or adopt them mid-run",
		"expected and observed identities",
		"safe repository-relative labels",
	], label);
});

test("S2: reports separate preparation, inspection, execution, and missing proof", () => {
	for (const [label, text] of delivered) clauses(text, [
		"preparation failure", "security denial", "structural inspection",
		"functional verdict", "missing dependency proof",
		"Task completion is not a verification PASS",
		"commands actually run, exit codes, test counts, and exact checks left unrun",
		"zero tests run",
		"successful process exit alone",
	], label);
});

test("S2: denial diagnostics are safe evidence, never approval or replay authority", () => {
	for (const [label, text] of delivered) clauses(text, [
		"safe task/call identifiers when available",
		"denial category and affected unrun criterion",
		"no raw arguments, transcripts, private paths, or credentials",
		"mark that probe unverified",
		"Optionally include the rule and blocked path, sanitized of secret contents",
		"only when the rule is public and the blocked path is an actually safe repository-relative label",
		"Never require or reconstruct a private blocked path",
		"A safer-plan request is not a consent grant",
		"Do not replay the denied operation or invent an approval continuation",
	], label);
	assert.ok(!verify.includes("with the guard's response -- rule and blocked path"),
		"denial reporting must not unconditionally demand a guard response or blocked path");
});

test("S3: justify auxiliary gates to the verifier before adding them to setup", () => {
	for (const [label, text] of delivered) clauses(text, [
		"Before adding an auxiliary preparation gate",
		"parent must deliver its in-scope acceptance criterion, concrete threat, or authoritative contract",
		"why existing approved checks are insufficient",
		"A verifier-authored helper is not mandatory merely because it exists",
		"Do not insert unjustified optional helpers into required setup",
	], label);
	assert.ok(verify.indexOf("Before adding an auxiliary preparation gate") < verify.indexOf("Make one isolated preparation attempt"));
});

test("S3: complete approved payloads prefer real checks, not a parallel import analyzer", () => {
	for (const [label, text] of delivered) clauses(text, [
		"With an explicit complete approved payload",
		"named artifact, dependency, version, identity, and capacity checks",
		"parent-approved actual module-load commands (including native in-memory loads) and tests",
		"no parallel lexical-import or full transitive-closure analyzer gate without that justification",
		"SQL, templates, or prose are not imports",
		"Required source inspection and static analysis remain valid",
		"actual missing inputs with evidence, not a parser failure",
	], label);
});

test("S3: proportionality preserves bounded correction and explicit recovery, not retroactive waivers", () => {
	for (const [label, text] of delivered) clauses(text, [
		"optional analysis failure alone does not prove missing runtime capability or an application defect",
		"does not waive real missing artifacts, mandated checks, or security denials",
		"one self-caused deterministic setup correction",
		"explicit human-requested bounded resumption",
		"no unlimited retries, budget resets, denial bypass, outcome rewriting, or executor swaps",
		"does not retroactively revive stopped trials",
	], label);
	clauses(verify, [
		"make exactly one corrected attempt without asking anyone and report both attempts",
		"At a second failure, or at any missing or unavailable prerequisite",
		"No further setup retries and no repair-helper loops",
	], "upstream correction rule");
	assert.ok(!verify.includes("Do not retry setup"));
	clauses(parent, [
		"human may explicitly request one new bounded verification attempt",
		"status: partial", "never PASS",
	], "parent recovery");
});

test("S4: scope is instruction delivery, not a runtime or backend guarantee", () => {
	clauses(docs, [
		"instruction delivery, not runtime enforcement or model compliance",
		"not a runtime-enforced freeze, snapshot API, or security approval",
		"does not establish incident closure or that all P05/backend work is unblocked",
	], "honest scope");
});

test("packaging: retain locally loaded verifier bodies and record the current body", () => {
	const history = JSON.parse(read("assets/migrations/agent-body-history.json"));
	const hashes: string[] = history.bodies["agents/gentle-ai-verify.md"];
	for (const hash of [
		"127e15d4539818f95e0e01906e0ff99b15f126786c51511c819d043d415abb15",
		"dea85c98ce0965e0584f44320e7e4fb78b54372834aa58f4585bb2dc0809fdfe",
		createHash("sha256").update(agentBody(source)).digest("hex"),
	]) assert.ok(hashes.includes(hash), `missing shipped/current verifier body: ${hash}`);
});

test("upstream safeguards: tools, continuation reuse, evidence routing, isolation, and compactness remain", () => {
	assert.deepEqual(agent.tools, ["read", "grep", "find", "bash", "mcp__codegraph__codegraph_explore"]);
	clauses(verify, [
		"When resumed in the same child session, do not re-read skill files or spec sections",
		"Do not re-run the suite the writer reported",
		"all source, test/build files, baseline material, and dependencies needed for every authorized probe",
		"scratch capacity, including space and inodes when relevant",
		"For checks requiring Git publication/index semantics or a Git baseline, use the packaged helper",
		"worktrees, links, submodules, unsupported history or external dependencies are setup blockers",
		"start every probe from a clean environment",
		"never import or execute an entry point just to inspect it",
		"No network, no installs, no writes outside the scratch directory",
		"RDD review remains independent and parent-owned",
		"Return a compact evidence handoff of at most ~2k tokens",
	], "preserved upstream obligations");
	assert.ok(Buffer.byteLength(parent) <= 8_900, "parent routing module retains its upstream budget");
});

// S4: retain the independent verifier's public-delivery regression probes.
test("public delivery survives line endings, scope, and routing edits", () => {
	for (const scope of ["global", "project"] as const) {
		for (const text of [source, source.replaceAll("\n", "\r\n"), source + " \n"]) {
			const parsed = parseAgentDefinition(text, path, scope);
			assert.ok(!("error" in parsed));
			assert.equal(parsed.instructions.replaceAll("\r\n", "\n"), verify);
			assert.deepEqual(parsed.tools, agent.tools);
			assert.equal(parsed.scope, scope);
		}
	}
	const routed = source.replace("description:", "model: offline/example\ndescription:");
	assert.equal(agentBody(routed), agentBody(source));
	const parsed = parseAgentDefinition(routed, path, "global");
	assert.ok(!("error" in parsed));
	assert.equal(parsed.instructions, verify);
});

test("empty instruction delivery fails without manufacturing instructions", () => {
	const frontmatter = source.slice(0, source.indexOf("\n---", 4) + 4);
	assert.deepEqual(parseAgentDefinition(frontmatter + "\n \n", path, "global"), {
		filePath: path, error: "no instructions after the frontmatter",
	});
});
