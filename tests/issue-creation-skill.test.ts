import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");
const skill = readFileSync(join(repoRoot, "skills", "issue-creation", "SKILL.md"), "utf8");

test("preserves the prefixed skill identity and complete Issue Form metadata", () => {
	assert.match(skill, /^name: gentle-ai-issue-creation$/m);
	assert.match(skill, /^description: ".+"$/m);
	assert.match(skill, /^  version: "1\.3"$/m);
});

test("makes YAML Issue Forms the deterministic automated format authority", () => {
	assert.match(skill, /YAML Issue Forms are the format authority/i);
	assert.match(skill, /`input`, `textarea`, `dropdown`, and `checkboxes`/);
	assert.match(skill, /declared order/i);
	assert.match(skill, /visible labels and options/i);
	assert.match(skill, /multi-select.*declared options order/i);
	assert.match(skill, /optional dropdown[\s\S]{0,180}_No response_/i);
	assert.match(skill, /Markdown controls are non-answer guidance/i);
	assert.match(skill, /visible instructions[\s\S]{0,180}adjacent answers/i);
	assert.match(skill, /do not render them as response sections/i);
	assert.match(skill, /individually required checkbox/i);
	assert.match(skill, /explicit first-person affirmation/i);
	assert.match(skill, /textarea\.attributes\.render/);
	assert.match(skill, /fence the answer with the declared language/i);
});

test("fails closed before publication for invalid required Issue Form data", () => {
	assert.match(skill, /Fail closed before mutation/i);
	assert.match(skill, /malformed, unsupported, missing, or ambiguous required structure or answers/i);
	assert.match(skill, /malformed schema[\s\S]{0,200}do not open a browser/i);
	assert.match(skill, /Never invent answers, selections, confirmations, or labels/i);
});

function assertCheckboxAttestationContract(candidate: string) {
	assert.match(candidate, /agent must complete.*duplicate search.*retain evidence/i);
	assert.match(candidate, /agent must complete.*privacy scan\/redaction.*exact body.*retain evidence/i);
	assert.match(candidate, /may explicitly attest.*own evidence-backed work.*must not attribute.*user/i);
	assert.match(candidate, /personal facts, consent, legal declarations.*explicit user affirmation/i);
	assert.match(candidate, /Do not blanket.*check(?:box|boxes)/i);
	assert.match(candidate, /request to publish.*does not.*affirm/i);
}

test("attests only agent-verifiable checkbox work and preserves human declarations", () => {
	assertCheckboxAttestationContract(skill);

	const missingEvidence = skill.replace(/retain evidence/gi, "skip evidence");
	assert.throws(() => assertCheckboxAttestationContract(missingEvidence));

	const userOnlyDeclaration = skill.replace(
		/personal facts, consent, legal declarations.*explicit user affirmation/i,
		"personal facts, consent, legal declarations may be inferred from a request to publish",
	);
	assert.throws(() => assertCheckboxAttestationContract(userOnlyDeclaration));
});

test("publishes reviewed Issue Form bodies through a private body file", () => {
	assert.match(skill, /private `BODY_FILE`/);
	assert.match(skill, /gh issue create --repo "\$TARGET" --title "\$TITLE" --body-file "\$BODY_FILE"/);
	assert.match(skill, /target verification/i);
	assert.match(skill, /duplicate search/i);
	assert.match(skill, /Before commenting on a confirmed duplicate[\s\S]{0,250}privacy scan\/redaction[\s\S]{0,250}exact comment body/i);
	assert.match(skill, /privacy scan/i);
	assert.match(skill, /permitted labels/i);
	assert.match(skill, /one mutation attempt/i);
	assert.match(skill, /target-host read-back/i);
});

function assertBrowserContract(candidate: string) {
	assert.match(candidate, /gh issue create --repo "\$TARGET" --title "\$TITLE" --body-file "\$BODY_FILE"/);
	assert.match(
		candidate,
		/user explicitly requests browser completion[\s\S]{0,350}syntactically valid selected form cannot safely\/faithfully be represented by the automated path/i,
	);
	assert.match(candidate, /malformed schema[\s\S]{0,200}do not open a browser/i);
	assert.match(candidate, /missing or ambiguous required[\s\S]{0,200}fail closed[\s\S]{0,200}do not open a browser/i);
	assert.match(candidate, /browser handoff[\s\S]{0,160}never proof of publication/i);
	assert.doesNotMatch(candidate, /Do not parse or render[\s\S]{0,300}stop for human completion/i);
	assert.doesNotMatch(candidate, /(?:always|must|only)\s+(?:open|use|route to)\s+(?:the )?browser(?:\s+for)?\s+(?:Issue Forms?|YAML)/i);
	assert.doesNotMatch(candidate, /YAML Issue Forms require human completion in the web issue chooser\./i);
	assert.doesNotMatch(candidate, /Always route Issue Forms to the browser\./i);
	assert.doesNotMatch(
		candidate,
		/\bfor\s+(?:YAML\s+)?Issue\s+Forms?\b[\s\S]{0,160}\b(?:open|use|route to|go to)\b[\s\S]{0,100}\b(?:browser|web issue chooser|web)\b/i,
	);
}

test("keeps automated and conditional browser Issue Form paths distinct", () => {
	assertBrowserContract(skill);

	const unsafeMutations = [
		"For YAML Issue Forms, open the web issue chooser and stop for human completion.",
		"YAML Issue Forms require human completion in the web issue chooser.",
		"Always route Issue Forms to the browser.",
	];
	for (const mutation of unsafeMutations) {
		assert.throws(() => assertBrowserContract(`${skill}\n\n${mutation}`), mutation);
	}
});

test("discovers support routing and keeps all issue files private until cleanup", () => {
	assert.match(skill, /README\.md/);
	assert.match(skill, /\.github\/ISSUE_TEMPLATE\/config\.yml/);
	assert.match(skill, /Discussions\/contact routing/i);
	assert.match(skill, /questions\/support[\s\S]{0,250}(?:Discussions|contact)[\s\S]{0,250}otherwise ask or stop/i);
	assert.doesNotMatch(skill, /TMP_DIR="\$\(mktemp -d\)"/);
	assert.match(skill, /TMPDIR=\/tmp mktemp -d/);
	assert.match(skill, /REPO_ROOT="\$\(git rev-parse --show-toplevel\)"/);
	assert.match(skill, /REPO_ROOT="\$\(cd "\$REPO_ROOT" && pwd -P\)"/);
	assert.match(skill, /if \[ "\$REPO_ROOT" = "\/" \]/);
	assert.match(skill, /trap 'rm -rf -- "\$TMP_DIR"' EXIT/);
	assert.match(skill, /TMP_DIR_REAL="\$\(cd "\$TMP_DIR" && pwd -P\)"/);
	assert.match(skill, /case "\$TMP_DIR_REAL\/" in[\s\S]{0,200}"\$REPO_ROOT\/"\*/);
	assert.match(skill, /if \[ "\$REPO_ROOT" = "\/" \][\s\S]{0,200}Temporary directory is inside the repository/);
	assert.match(skill, /REPO_ROOT="\$\(cd "\$REPO_ROOT" && pwd -P\)"[\s\S]{0,200}TMPDIR=\/tmp mktemp -d/);
	assert.match(skill, /TMPDIR=\/tmp mktemp -d[\s\S]{0,200}trap 'rm -rf -- "\$TMP_DIR"' EXIT/);
	assert.match(skill, /chmod 700 "\$TMP_DIR_REAL"/);
	assert.match(skill, /umask 077/);
	assert.match(skill, /BODY_FILE="\$TMP_DIR_REAL\//);
	assert.match(skill, /READBACK_FILE="\$TMP_DIR_REAL\//);
	assert.doesNotMatch(skill, /TMP_DIR="\$\(cd "\$TMP_DIR" && pwd -P\)"/);
});
