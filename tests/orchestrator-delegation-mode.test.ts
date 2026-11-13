import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// ---------------------------------------------------------------------------
// full-delegation-mode S1/S3/S4/S7: one workflow block per turn, chosen by the
// profile, never both at once.
//
// The organic path is the compatibility surface: a profile that did not opt in
// must render the asset byte for byte, because every existing session and every
// budget measurement was taken against exactly those bytes.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL_ASSETS_DIR = join(REPO_ROOT, "assets");
const VARIANT_FILE = "orchestrator-full-delegation.md";
// cost-speed-painpoints S15 P5a (verdict C7): the anchor changes together with DELEGATION_MODE_REGION_START.
const ORGANIC_START = "You are a COORDINATOR who executes understood work inline.";
const ORGANIC_END = "{{GENTLE_PI_BACKGROUND_POLICY}}";

const { __testing } = await import("../extensions/gentle-ai.ts");

const scratch: string[] = [];
function assetsDirWith(transform: (files: Record<string, string>) => Record<string, string> = (files) => files): string {
	const dir = mkdtempSync(join(tmpdir(), "gp-delegation-mode-"));
	scratch.push(dir);
	const files: Record<string, string> = {
		"orchestrator.md": readFileSync(join(REAL_ASSETS_DIR, "orchestrator.md"), "utf8"),
		[VARIANT_FILE]: readFileSync(join(REAL_ASSETS_DIR, VARIANT_FILE), "utf8"),
	};
	for (const [name, content] of Object.entries(transform(files))) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const organic = (dir: string) => __testing.renderOrchestratorPrompt(dir);
const full = (dir: string) => __testing.renderOrchestratorPrompt(dir, undefined, undefined, "full-delegation");

test("a profile that did not opt in renders the organic workflow region byte for byte", () => {
	const dir = assetsDirWith();
	const raw = readFileSync(join(REAL_ASSETS_DIR, "orchestrator.md"), "utf8");
	const region = raw.slice(raw.indexOf(ORGANIC_START), raw.indexOf(ORGANIC_END));
	assert.ok(region.length > 1000, "the fixture must actually span the organic workflow rules");
	const rendered = organic(dir);
	assert.ok(rendered.includes(region), "the organic region must survive rendering unchanged");
	assert.equal(rendered, __testing.renderOrchestratorPrompt(dir, undefined, undefined, "organic"));
	assert.equal(rendered.includes("in full delegation mode: you never implement"), false);
});

test("full delegation mode replaces the organic rules instead of adding to them", () => {
	const dir = assetsDirWith();
	const rendered = full(dir);
	const variant = readFileSync(join(REAL_ASSETS_DIR, VARIANT_FILE), "utf8").trim();
	const [beforeRisk, afterRisk] = variant.split("{{GENTLE_PI_HIGH_RISK_ITEMS}}");
	assert.ok(rendered.includes(beforeRisk!.trim()) && rendered.includes(afterRisk!.trim()), "the variant block must be injected around its high-risk items");
	assert.equal(rendered.includes(ORGANIC_START), false, "the organic role text must be gone, not merely followed");
	// Task Size survives as tracking and risk only; its inline route does not.
	assert.match(rendered, /## Task Size\n\nTask size decides tracking and risk, never who writes\./);
	assert.equal(rendered.includes("Small path: inline"), false);
	assert.equal(rendered.split("in full delegation mode: you never implement").length - 1, 1, "exactly one mode block");
});

test("both modes keep the shared sections, the lazy pointers and the rendered tokens", () => {
	for (const rendered of [organic(assetsDirWith()), full(assetsDirWith())]) {
		for (const shared of ["## Memory Contract", "## Safety", "## Skill Registry Protocol"]) {
			assert.ok(rendered.includes(shared), `missing shared section: ${shared}`);
		}
		assert.ok(rendered.includes("orchestrator-prompts.md"), "the shared lazy pointers stay reachable");
		assert.equal(rendered.includes("{{"), false, "no unrendered token may leak into the prompt");
	}
	// Each mode names its own routing detail and never the other's.
	assert.ok(organic(assetsDirWith()).includes("orchestrator-delegation-reference.md"));
	assert.equal(full(assetsDirWith()).includes("orchestrator-delegation-reference.md"), false);
	assert.ok(full(assetsDirWith()).includes("orchestrator-full-delegation-card.md"));
});

test("the high-risk items keep one definition, taken from the organic core", () => {
	const dir = assetsDirWith();
	const highRisk = readFileSync(join(REAL_ASSETS_DIR, "orchestrator.md"), "utf8").split("\n").find((line) => line.startsWith("**High risk**:"));
	assert.ok(highRisk);
	assert.ok(full(dir).includes(highRisk), "the variant carries the organic paragraph itself, not a copy");
});

test("a missing high-risk paragraph falls back to the organic rules instead of a variant with no risk list", () => {
	const dir = assetsDirWith((files) => ({ ...files, "orchestrator.md": files["orchestrator.md"].replace("**High risk**:", "**Risk, reworded upstream**:") }));
	const rendered = full(dir);
	assert.ok(rendered.includes("Small path: inline"), "the organic rules stay whole when the variant cannot be completed");
	assert.equal(rendered.includes("in full delegation mode: you never implement"), false);
});

test("full delegation mode is not more expensive in context than the rules it replaces", () => {
	const dir = assetsDirWith();
	const organicBytes = Buffer.byteLength(organic(dir), "utf8");
	const fullBytes = Buffer.byteLength(full(dir), "utf8");
	assert.ok(
		fullBytes < organicBytes,
		`full delegation must cost less context than organic (${fullBytes} B vs ${organicBytes} B)`,
	);
});

test("a missing variant asset falls back to the organic rules instead of a broken splice", () => {
	const dir = assetsDirWith((files) => {
		const { [VARIANT_FILE]: _dropped, ...rest } = files;
		return rest;
	});
	const rendered = full(dir);
	assert.equal(rendered, organic(dir));
	assert.ok(rendered.includes("## Task Size"));
});

test("a drifted organic anchor falls back to the organic rules instead of a broken splice", () => {
	const dir = assetsDirWith((files) => ({
		...files,
		"orchestrator.md": files["orchestrator.md"].replace(ORGANIC_START, "You are a COORDINATOR, reworded upstream."),
	}));
	const rendered = full(dir);
	assert.ok(rendered.includes("## Task Size"), "the organic rules stay whole when the splice cannot be made");
	assert.equal(rendered.includes("in full delegation mode: you never implement"), false);
});

test("an empty variant asset falls back to the organic rules", () => {
	const dir = assetsDirWith((files) => ({ ...files, [VARIANT_FILE]: "   \n\n" }));
	assert.equal(full(dir), organic(dir));
});

test("the memoized core is keyed by the mode, so a switch cannot serve stale rules", () => {
	const cwd = REPO_ROOT;
	const organicPrompt = __testing.getOrchestratorPrompt(cwd);
	const fullPrompt = __testing.getOrchestratorPrompt(cwd, undefined, undefined, undefined, "full-delegation");
	assert.notEqual(organicPrompt, fullPrompt, "a stale cache entry would return the previous profile's rules");
	assert.ok(organicPrompt.includes("Small path: inline"));
	assert.equal(fullPrompt.includes("Small path: inline"), false);
	// Repeating each call still hits its own cache entry and never mixes them.
	assert.equal(__testing.getOrchestratorPrompt(cwd), organicPrompt);
	assert.equal(__testing.getOrchestratorPrompt(cwd, undefined, undefined, undefined, "full-delegation"), fullPrompt);
});

// gentle-shell#379: delegation stays inside the current runtime. The open
// "another available delegation mechanism" fallback is gone from the routing
// detail and the reference docs, and each names the stop rule instead.
test("delegation fallback never leaves the current runtime", () => {
	for (const path of [join(REAL_ASSETS_DIR, "orchestrator-delegation-reference.md"), join(REPO_ROOT, "docs", "readme-reference.md")]) {
		const text = readFileSync(path, "utf8");
		assert.equal(text.includes("another available delegation mechanism"), false, path);
		assert.match(text, /never fall back to an external pane, terminal, session, window, or remote worker/, path);
	}
});
