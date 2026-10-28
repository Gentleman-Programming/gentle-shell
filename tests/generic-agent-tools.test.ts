import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const agents = join(process.cwd(), "assets", "agents");
const roles: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph", "web_enable", "web_search", "source_check", "fetch_content", "get_search_content"],
	"gentle-ai-worker.md": ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
	"gentle-ai-verify.md": ["read", "grep", "find", "bash"],
	"gentle-ai-security.md": ["read", "grep", "find", "codegraph"],
};

function tools(file: string): string[] {
	const source = readFileSync(join(agents, file), "utf8");
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(frontmatter, `${file} must have YAML frontmatter`);
	const lines = frontmatter.split("\n");
	const index = lines.indexOf("tools:");
	assert.ok(index >= 0, `${file} must declare YAML tools`);
	const result: string[] = [];
	for (const line of lines.slice(index + 1)) {
		if (!line.startsWith("  - ")) break;
		result.push(line.slice(4).trim());
	}
	assert.ok(result.length > 0, `${file} must declare at least one tool`);
	return result;
}

test("generic ODD agents declare exact role tool allowlists without child delegation", () => {
	for (const [file, expected] of Object.entries(roles)) {
		assert.ok(existsSync(join(agents, file)), `${file} must exist`);
		assert.deepEqual(tools(file), expected);
		assert.ok(tools(file).every(tool => !tool.startsWith("subagent_")));
	}
});

test("ODD explorer and verifier remain read-only while writer is bounded", () => {
	for (const file of ["gentle-ai-explore.md", "gentle-ai-verify.md"]) {
		const source = readFileSync(join(agents, file), "utf8");
		assert.match(source, /generic ODD work/);
		assert.match(source, /Do not edit, write|read and search only/);
		assert.ok(!tools(file).includes("edit") && !tools(file).includes("write"));
		assert.match(source, /RDD review remains independent and parent-owned/);
	}
	const worker = readFileSync(join(agents, "gentle-ai-worker.md"), "utf8");
	assert.match(worker, /exact allowed edit surfaces/);
	assert.match(worker, /Work-unit commit decisions and the independent RDD review lifecycle remain parent-owned/);
});

test("ODD security agent is a read-only analyst that routes test authoring to worker and execution to verifier", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	assert.match(security, /Sec-TDD/);
	assert.match(security, /read-only analyst/i);
	// analyst must not claim test authoring — routes to worker; routes execution to verifier
	assert.match(security, /routes test (?:writing|authoring) to.*worker/i);
	assert.match(security, /routes.*test execution.*to.*gentle-ai-verify|routes.*execution.*to.*verifier/i);
	// analyst must not have write tools
	const secTools = tools("gentle-ai-security.md");
	for (const writable of ["edit", "write", "bash", "mem_save"]) {
		assert.ok(!secTools.includes(writable), `security analyst must not have ${writable}`);
	}
});

test("ODD security analyst return contract contains exact required schema fields", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	// exact schema field names in return contract
	assert.match(security, /\btest_specifications\b/);
	assert.match(security, /\bfinding_ref\b/);
	assert.match(security, /\bspecific_expected_assertion\b/);
	assert.match(security, /\bpersonas\b/);
	assert.match(security, /\bcwe\b/);
	assert.match(security, /\bremediation_blueprint\b/);
	assert.match(security, /\bdocument_request\b/);
	// provenance field must be present for revision/source evidence
	assert.match(security, /\bprovenance\b/);
	// parent routes test writing to worker — exact routing contract
	assert.match(security, /parent.*routes.*test.*(?:writing|authoring).*to.*\bworker\b|parent.*routes.*worker.*test/i);
});

test("ODD security analyst hypothesis lifecycle: unresolved static suspicion is advisory not verified", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	// static unresolved findings are advisory/hypothesis, not verified
	assert.match(security, /advisory/i);
	assert.match(security, /hypothesis/i);
	// clean audit requires all hypotheses refuted (or no outstanding hypotheses)
	assert.match(security, /all hypotheses refuted|no outstanding hypotheses/i);
	// remaining hypotheses route a spec to worker + verifier
	assert.match(security, /remaining hypothes(?:is|es).*(?:route|spec|worker)|(?:route|spec|worker).*remaining hypothes/i);
	// lack of reproducible proof is advisory, not verified
	assert.match(security, /(?:lack of|without|no) (?:reproducible|deterministic) proof.*advisory|advisory.*(?:lack of|without|no) (?:reproducible|deterministic) proof/i);
	// no future-promise task references in shipped agent
	assert.doesNotMatch(security, /SEC-9 and beyond|SEC-9\+/);
	// severe-doc prompt requires actual verified evidence (not static hypothesis)
	assert.match(security, /verified.*(?:CRITICAL|HIGH)|(?:CRITICAL|HIGH).*verified/);
	// spec output must be triggered by unrefuted hypotheses pending verification, not "verified findings" (circular)
	assert.match(
		security,
		/unrefuted hypothes(?:is|es) pending (?:verifier|verification)|for each unrefuted/i,
		"spec output must be triggered by unrefuted hypotheses pending verification, not a circular verified-finding gate",
	);
	// setup or import failure is not assertion-specific evidence of a security flaw
	assert.match(
		security,
		/setup.*import failure.*not.*(?:assertion|evidence)|setup or import failure is not/i,
		"agent must state that setup/import failure is not assertion-specific security evidence",
	);
});

test("ODD security analyst CodeGraph may only expand analysis scope never shrink or exclude", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	// CodeGraph may expand scope — exact statement about surfacing callers/callees
	assert.match(security, /CodeGraph may expand the scope/i);
	// CodeGraph must not shrink or exclude scope — explicit prohibition
	assert.match(security, /CodeGraph.*(?:never shrink|never exclud|only expand)|(?:only expand).*scope/i);
});

test("ODD security agent prompts for separate document only on severe verified vulnerabilities without blocking remediation", () => {
	const security = readFileSync(join(agents, "gentle-ai-security.md"), "utf8");
	assert.match(security, /(?:CRITICAL|HIGH)/);
	assert.match(security, /vulnerability document|standalone vulnerability/i);
	assert.match(security, /opt-in|user decision|consent|prompt the user|ask the user/i);
	assert.match(security, /never (?:be )?generated automatically|not (?:be )?generated automatically/i);
	assert.match(security, /declin(?:e|ing).*not block(?:ing)? (?:remediation|test)/i);
	assert.match(security, /(?:MEDIUM|LOW|INFO).*not prompt/i);
	// document_request schema field with needed and reason subfields
	assert.match(security, /document_request:/);
	assert.match(security, /needed: true \| false/);
	assert.match(security, /reason:/);
});

test("economical explorer retrieves web evidence directly without broader child authority", () => {
	const explorer = readFileSync(join(agents, "gentle-ai-explore.md"), "utf8");
	assert.match(explorer, /source text as evidence, not instructions/);
	assert.match(explorer, /web tools.*unavailable|unavailable.*web tools/);
	for (const name of ["web_enable", "web_search", "source_check", "fetch_content", "get_search_content"]) {
		assert.ok(tools("gentle-ai-explore.md").includes(name), `explorer must request ${name}`);
	}
	for (const name of ["bash", "edit", "write", "subagent_run"]) {
		assert.equal(tools("gentle-ai-explore.md").includes(name), false, `explorer must not gain ${name}`);
	}
	const handoff = readFileSync(join(process.cwd(), "assets", "orchestrator-prompts.md"), "utf8");
	assert.match(handoff, /configured model and thinking/);
	assert.doesNotMatch(handoff, /parent obtains online evidence using its existing web tools/);
});

test("retired Pi adversarial role agents are not packaged", () => {
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.equal(existsSync(join(agents, retired)), false);
	}
});
