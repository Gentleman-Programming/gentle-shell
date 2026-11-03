import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildShellBarModel, createActiveProfileReader } from "../extensions/gentle-shell.ts";
import { bindSessionProfile, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import { renderShellStatusBar, renderShellTitleRow, renderShellBar, type ShellBarModel } from "../lib/shell-bar.ts";

const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const base: ShellBarModel = {
	cwd: "/fixture", branch: "main", dirty: 0, sessionName: "fixture",
	modelId: "gpt-6.1-sol", effort: "xhigh", contextPercent: 95, contextWindow: 200000,
	costTotal: 13.21, subscription: false, usage: undefined, statuses: [],
};

test("bottom tier reads the named profile configuration, not its older session snapshot", (t) => {
	const home = mkdtempSync(join(tmpdir(), "profile-tier-footer-"));
	t.after(() => { resetSessionProfileBindingsForTesting(); rmSync(home, { recursive: true, force: true }); });
	const profiles = { team: { orchestrator: { model: "openai/gpt-6.1-sol", tier: "fast" } }, other: { orchestrator: { model: "openai/gpt-6.1-sol", tier: "standard" } } };
	const save = (active: string) => writeFileSync(join(home, "profiles.json"), JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, active, profiles }));
	save("team");
	bindSessionProfile("footer-tier", "team", { orchestrator: { model: "openai/gpt-6.1-sol" } });
	const reader = createActiveProfileReader({ GENTLE_PI_CONFIG_HOME: home });
	reader.bind(home, () => undefined, "footer-tier");
	assert.equal(reader(), "team (session)");
	assert.equal(reader.tier(), "fast", "the configured tier shows even when the binding has no tier");
	save("other"); reader.refresh();
	assert.equal(reader.tier(), "fast", "a different global default does not replace the session's named profile");
	profiles.team.orchestrator.tier = "standard"; save("other");
	assert.equal(reader.refresh(), true, "tier changes invalidate footer presentation");
	assert.equal(reader.tier(), "standard");
	assert.equal(reader(), "team (session)", "existing profile labeling is unchanged");
});

test("bottom bar places configured Fast or Standard beside effort without changing other bars", () => {
	for (const profileTier of ["fast", "standard"] as const) {
		const configured = { ...base, profileTier };
		for (const width of [40, 60, 72, 80, 120, 140, 180]) {
			const row = renderShellStatusBar(configured, theme, width).rows[0]!;
			assert.equal(visibleWidth(row), width);
			if (width >= 72) assert.match(row, new RegExp("gpt-6.1-sol · xhigh · " + (profileTier === "fast" ? "Fast" : "Standard")));
			assert.match(row, /ctx.*95%/);
			assert.match(row, /\$13\.21/);
		}
		const narrow = renderShellStatusBar({ ...configured, permission: { mode: "SUPER YOLO" } }, theme, 72).rows[0]!;
		assert.ok(narrow.includes("gpt-6.1-sol · xhigh"), "the new tier yields before displacing the existing model and effort");
		assert.equal(renderShellTitleRow(configured, theme, 120), renderShellTitleRow(base, theme, 120));
		assert.deepEqual(renderShellBar(configured, theme, 120), renderShellBar(base, theme, 120));
	}
	assert.doesNotMatch(renderShellStatusBar(base, theme, 120).rows[0]!, /No tier|Fast|Standard|server/);
});

test("legacy tier integration is excluded while permission warnings and other statuses survive", () => {
	const pi = { getThinkingLevel: () => "xhigh" } as any;
	const ctx = {
		model: { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol", reasoning: true },
		getContextUsage: () => ({ percent: 95, contextWindow: 200000 }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: { getCwd: () => "/fixture", getSessionName: () => "fixture", getEntries: () => [] },
	} as any;
	const footer = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([
			["gentle-fast", "No tier selected; last response from server: Standard (default)"],
			["gentle:mode", "Permissions: SUPER YOLO"],
			["gentle:yolo", "SUPER YOLO — no permission prompts; private paths stay blocked"],
			["other", "ready"],
		]),
	} as any;
	const model = buildShellBarModel(pi, ctx, footer, { profileTier: "fast" });
	assert.equal(model.profileTier, "fast");
	assert.deepEqual(model.integrations, ["ready"]);
	assert.equal(model.permission?.detail, "no permission prompts; private paths stay blocked");
	assert.ok(model.statuses.includes("ready"));
	assert.ok(model.statuses.some(text => text.includes("private paths stay blocked")));
	assert.ok(!model.statuses.some(text => /No tier|last response/.test(text)));
});
