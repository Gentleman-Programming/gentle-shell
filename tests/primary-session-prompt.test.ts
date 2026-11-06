import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// gentle-ai R3 (odd/tasks/pi-routing-from-bundle.md): the harness ODD step
// lines 1-7, the phase-reporting line, and the resume line come from the
// mirrored provider contract bundle's routing/pi.md instead of a hand-copied
// literal, and the rendered primary-session prompt stays byte-identical.
//
// The golden was captured from the base commit (main 4372ff2d, after R1) before the steps moved into the
// bundle, with the inputs below and the package assets root normalized. When a
// prompt change is intended, regenerate it with
// UPDATE_PRIMARY_SESSION_PROMPT_GOLDEN=1 and review the golden diff.

const REPO_ROOT = join(import.meta.dirname, "..");
const GOLDEN_PATH = join(REPO_ROOT, "tests", "fixtures", "primary-session-prompt", "gentleman.golden.md");
const ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent_run"] as const;
const MIRROR_ROOT = join(REPO_ROOT, "contracts", "review-provider-contract-mirror");

let scratch: string;
const previousEnvironment = new Map<string, string | undefined>();
before(() => {
	scratch = mkdtempSync(join(tmpdir(), "gentle-pi-primary-prompt-"));
	for (const key of ["GENTLE_PI_CONFIG_HOME", "GENTLE_PI_BACKGROUND_SUBAGENTS"]) previousEnvironment.set(key, process.env[key]);
	process.env.GENTLE_PI_CONFIG_HOME = join(scratch, "config");
	delete process.env.GENTLE_PI_BACKGROUND_SUBAGENTS;
});
after(() => {
	for (const [key, value] of previousEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(scratch, { recursive: true, force: true });
});

function renderPrimaryPrompt(): string {
	const prompt = __testing.buildGentlePrompt("gentleman", join(scratch, "project"), ACTIVE_TOOLS);
	return prompt.replaceAll(join(REPO_ROOT, "assets"), "{{GENTLE_PI_ASSETS_ROOT}}");
}

function mirroredRoutingText(): string {
	const lock = JSON.parse(readFileSync(join(MIRROR_ROOT, "provider-contract.lock.json"), "utf8")) as { contract_semver: string };
	return readFileSync(join(MIRROR_ROOT, `v${lock.contract_semver}`, "bundle", "routing", "pi.md"), "utf8");
}

// Writes a one-file mirror whose lock records `entrySha256` for routing/pi.md.
function tempRoutingMirror(text: string, entrySha256 = createHash("sha256").update(text, "utf8").digest("hex")): string {
	const root = mkdtempSync(join(scratch, "mirror-"));
	const routingDir = join(root, "v9.9.9", "bundle", "routing");
	mkdirSync(routingDir, { recursive: true });
	writeFileSync(join(routingDir, "pi.md"), text, "utf8");
	writeFileSync(join(root, "provider-contract.lock.json"), JSON.stringify({ contract_semver: "9.9.9", entries: { "routing/pi.md": entrySha256 } }), "utf8");
	return root;
}

test("the rendered primary-session prompt is byte-identical to the golden captured from the base", () => {
	const rendered = renderPrimaryPrompt();
	if (process.env.UPDATE_PRIMARY_SESSION_PROMPT_GOLDEN === "1") writeFileSync(GOLDEN_PATH, rendered, "utf8");
	assert.equal(rendered, readFileSync(GOLDEN_PATH, "utf8"));
});

test("the ODD steps, phase reporting, and resume lines come from the mirrored routing/pi.md without its blank lines", () => {
	const routing = mirroredRoutingText();
	const section = routing.slice(routing.indexOf("### ODD protocol"), routing.indexOf("\n### Task Size"));
	const expected = section.split("\n").slice(1).filter((line) => line !== "");
	assert.equal(expected.length, 9);
	assert.equal(__testing.readMirroredOddProtocolSteps(), expected.join("\n"));
	assert.ok(renderPrimaryPrompt().includes(`Run these steps in this order on every request:\n${expected.join("\n")}\n\nHarness principles:`));
	assert.ok(routing.includes(`${expected[6]}\n\n${expected[7]}\n\n${expected[8]}`), "the bundle separates step 7, phase reporting, and resume with blank lines");
});

test("extensions/gentle-ai.ts no longer carries the ODD step lines as string literals", () => {
	const source = readFileSync(join(REPO_ROOT, "extensions", "gentle-ai.ts"), "utf8");
	for (const literal of ["1. **Authorize.**", "5. **Track before the first write.**", "7. **Close.**", "Phase reporting: the Gentle Shell prompt label", "Resume an interrupted feature with"]) {
		assert.ok(!source.includes(literal), `extensions/gentle-ai.ts still hard-codes ${JSON.stringify(literal)}`);
	}
});

test("a changed mirrored routing block changes the rendered steps", () => {
	const routing = mirroredRoutingText().replace("1. **Authorize.** ", "1. **Authorize.** Changed upstream. ");
	const mirror = tempRoutingMirror(routing);
	assert.match(__testing.readMirroredOddProtocolSteps(mirror), /^1\. \*\*Authorize\.\*\* Changed upstream\. /);
});

test("a tampered or missing mirrored routing/pi.md fails closed with an explicit error", () => {
	const unavailable = /Gentle Shell cannot render its ODD steps: the mirrored provider bundle's routing\/pi\.md is missing, unreadable, or fails digest verification/;
	assert.throws(() => __testing.readMirroredOddProtocolSteps(tempRoutingMirror(mirroredRoutingText(), "0".repeat(64))), unavailable);
	assert.throws(() => __testing.readMirroredOddProtocolSteps(join(scratch, "absent-mirror")), unavailable);
});

test("a routing block whose ODD protocol section changed shape fails closed", () => {
	const unexpectedShape = /routing\/pi\.md ODD protocol section has an unexpected shape/;
	const withoutResume = mirroredRoutingText().replace(/\nResume an interrupted feature[^\n]*\n/, "\n");
	assert.throws(() => __testing.readMirroredOddProtocolSteps(tempRoutingMirror(withoutResume)), unexpectedShape);
	const withoutSection = mirroredRoutingText().replace("### ODD protocol (MANDATORY, in this order, on every request)", "### ODD protocol");
	assert.throws(() => __testing.readMirroredOddProtocolSteps(tempRoutingMirror(withoutSection)), unexpectedShape);
});
