import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyOrchestratorSettings,
	parseOrchestratorModelRef,
	readOrchestratorSettings,
	restoreOrchestratorSettings,
} from "../lib/profiles-orchestrator.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-orchestrator-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, settingsPath: join(root, "settings.json") };
}

test("orchestrator model refs split only on a real provider boundary", () => {
	assert.deepEqual(parseOrchestratorModelRef("nan/glm5.3"), {
		provider: "nan",
		model: "glm5.3",
	});
	assert.deepEqual(parseOrchestratorModelRef("  openai-codex/gpt-6-astra  "), {
		provider: "openai-codex",
		model: "gpt-6-astra",
	});
	// A nested slash stays with the model half.
	assert.deepEqual(parseOrchestratorModelRef("nan/qwen3.8/flash"), {
		provider: "nan",
		model: "qwen3.8/flash",
	});
	for (const value of ["glm5.3", "/glm5.3", "nan/", "nan", "", "   ", 42, undefined, null]) {
		assert.equal(parseOrchestratorModelRef(value), undefined, `rejects ${JSON.stringify(value)}`);
	}
});

test("reading the orchestrator distinguishes missing, unreadable, unset and set", (t) => {
	const { settingsPath } = fixture(t);
	assert.deepEqual(readOrchestratorSettings(settingsPath), { status: "missing" });

	writeFileSync(settingsPath, "{ not json");
	assert.equal(readOrchestratorSettings(settingsPath).status, "invalid");

	writeFileSync(settingsPath, JSON.stringify(["not", "an", "object"]));
	assert.equal(readOrchestratorSettings(settingsPath).status, "invalid");

	writeFileSync(settingsPath, JSON.stringify({ theme: "Gentleman-Cute" }));
	const unset = readOrchestratorSettings(settingsPath);
	assert.equal(unset.status, "valid");
	assert.equal(unset.status === "valid" ? unset.entry : undefined, undefined);

	writeFileSync(
		settingsPath,
		JSON.stringify({
			defaultProvider: "nan",
			defaultModel: "glm5.3",
			defaultThinkingLevel: "high",
		}),
	);
	const set = readOrchestratorSettings(settingsPath);
	assert.deepEqual(set.status === "valid" ? set.entry : undefined, {
		model: "nan/glm5.3",
		thinking: "high",
	});

	// A half-written pair is "unset", never a fabricated provider or model.
	writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "nan" }));
	const half = readOrchestratorSettings(settingsPath);
	assert.equal(half.status, "valid");
	assert.equal(half.status === "valid" ? half.entry : undefined, undefined);
});

test("an orchestrator entry without a model never touches the settings file", (t) => {
	const { root, settingsPath } = fixture(t);
	const before = '{\n  "packages": [\n    "npm:pi-mcp-adapter"\n  ],\n  "theme": "Gentleman-Cute"\n}\n';
	writeFileSync(settingsPath, before);
	assert.deepEqual(applyOrchestratorSettings(settingsPath, { thinking: "high" }), {
		status: "unchanged",
	});
	assert.equal(readFileSync(settingsPath, "utf8"), before);

	// Also true when there is no file at all: nothing to write, nothing created.
	const absent = join(root, "absent-settings.json");
	assert.deepEqual(applyOrchestratorSettings(absent, {}), { status: "unchanged" });
	assert.equal(existsSync(absent), false);
});

test("applying the orchestrator preserves every unrelated settings key", (t) => {
	const { settingsPath } = fixture(t);
	const before =
		JSON.stringify(
			{
				packages: ["npm:pi-mcp-adapter", "some-package"],
				theme: "Gentleman-Cute",
				tuiMode: "fullscreen",
				telemetry: { enabled: true },
				defaultProvider: "nan",
				defaultModel: "deepseek-v4-flash",
				defaultThinkingLevel: "high",
				images: { autoResize: true },
			},
			null,
			2,
		) + "\n";
	writeFileSync(settingsPath, before);

	const result = applyOrchestratorSettings(settingsPath, {
		model: "nan/glm5.3",
		thinking: "max",
	});
	assert.equal(result.status, "written");
	assert.equal(result.status === "written" ? result.previous : undefined, before);

	const after = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(after.defaultProvider, "nan");
	assert.equal(after.defaultModel, "glm5.3");
	assert.equal(after.defaultThinkingLevel, "max");
	assert.deepEqual(after.packages, ["npm:pi-mcp-adapter", "some-package"]);
	assert.equal(after.theme, "Gentleman-Cute");
	assert.equal(after.tuiMode, "fullscreen");
	assert.deepEqual(after.telemetry, { enabled: true });
	assert.deepEqual(after.images, { autoResize: true });
	assert.equal(readFileSync(settingsPath, "utf8").endsWith("\n"), true);
});

test("a missing settings file is created with only the orchestrator keys", (t) => {
	const { settingsPath } = fixture(t);
	const result = applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" });
	assert.equal(result.status, "written");
	assert.equal(result.status === "written" ? result.previous : "sentinel", undefined);
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
		defaultProvider: "nan",
		defaultModel: "glm5.3",
	});
});

test("an orchestrator entry without thinking clears a stale thinking level", (t) => {
	const { settingsPath } = fixture(t);
	writeFileSync(
		settingsPath,
		JSON.stringify({
			defaultProvider: "nan",
			defaultModel: "glm5.3",
			defaultThinkingLevel: "high",
		}),
	);
	const result = applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3-flash" });
	assert.equal(result.status, "written");
	const after = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(after.defaultModel, "glm5.3-flash");
	assert.equal("defaultThinkingLevel" in after, false);
});

test("re-applying the same selection is a no-op", (t) => {
	const { settingsPath } = fixture(t);
	assert.equal(applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" }).status, "written");
	const bytes = readFileSync(settingsPath, "utf8");
	assert.deepEqual(applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" }), {
		status: "unchanged",
	});
	assert.equal(readFileSync(settingsPath, "utf8"), bytes);
});

test("an unusable target is refused instead of being overwritten", (t) => {
	const { settingsPath } = fixture(t);
	const before = "{ this is not json\n";
	writeFileSync(settingsPath, before);
	const broken = applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" });
	assert.equal(broken.status, "invalid");
	assert.equal(readFileSync(settingsPath, "utf8"), before);

	writeFileSync(settingsPath, "[]");
	const notObject = applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" });
	assert.equal(notObject.status, "invalid");
	assert.equal(readFileSync(settingsPath, "utf8"), "[]");

	// A model id that is not a provider/model pair is refused for the same reason:
	// there is no provider to write, and guessing one would corrupt the selection.
	writeFileSync(settingsPath, JSON.stringify({ theme: "Gentleman-Cute" }));
	const noProvider = applyOrchestratorSettings(settingsPath, { model: "glm5.3" });
	assert.equal(noProvider.status, "invalid");
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { theme: "Gentleman-Cute" });
});

test("restoring returns the previous bytes, or removes a file the write created", (t) => {
	const { root, settingsPath } = fixture(t);
	const before = '{\n  "theme": "Gentleman-Cute"\n}\n';
	writeFileSync(settingsPath, before);
	const written = applyOrchestratorSettings(settingsPath, { model: "nan/glm5.3" });
	assert.equal(written.status, "written");
	restoreOrchestratorSettings(
		settingsPath,
		written.status === "written" ? written.previous : undefined,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), before);

	// A file the write created restores by disappearing, not by holding an empty object.
	const createdPath = join(root, "created-settings.json");
	const created = applyOrchestratorSettings(createdPath, { model: "nan/glm5.3" });
	assert.equal(created.status, "written");
	assert.equal(existsSync(createdPath), true);
	restoreOrchestratorSettings(
		createdPath,
		created.status === "written" ? created.previous : undefined,
	);
	assert.equal(existsSync(createdPath), false);
});
