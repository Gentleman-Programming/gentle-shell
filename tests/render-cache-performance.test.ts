import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, outputDescriptor, percentile, summarize } from "../scripts/render-cache-performance.mjs";

test("summaries preserve raw samples and interpolate percentiles", () => {
	const samples = [4, 1, 3, 2];
	assert.equal(percentile(samples, 0.5), 2.5);
	assert.ok(Math.abs(percentile(samples, 0.95)! - 3.85) < 1e-10);
	assert.deepEqual(samples, [4, 1, 3, 2]);
	assert.deepEqual(summarize([]), { count: 0, median: null, p95: null, max: null });
});

const run = () => ({ metadata: { piVersion: "1.1.0", editorIdentityVerified: true }, cases: [{
	spec: { tools: 100, scenario: "scroll" }, coldScreen: "cold", screens: ["screen"], wallMs: [2, 2],
}] });

test("comparison requires identical cold and warm outputs and host identity", () => {
	const before = run();
	const after = run();
	after.cases[0]!.wallMs = [1, 1];
	assert.equal(compare(before, after)[0]!.speedup, 2);
	after.cases[0]!.screens = ["changed"];
	assert.throws(() => compare(before, after));
	after.cases[0]!.screens = ["screen"];
	after.cases[0]!.coldScreen = "changed";
	assert.throws(() => compare(before, after), "cold output must also agree");
	after.cases[0]!.coldScreen = "cold";
	after.metadata.piVersion = "other-host";
	assert.throws(() => compare(before, after), "cannot compare different Pi versions");
});

test("report outputs cannot overwrite files or enter protected roots via symlinks", () => {
	const home = mkdtempSync(join(tmpdir(), "render-cache-output-"));
	try {
		const source = join(home, "source"); mkdirSync(source);
		symlinkSync(source, join(home, "alias"), "dir");
		assert.throws(() => outputDescriptor(join(home, "alias", "report.json"), [source]));
		const existing = join(home, "existing.json"); writeFileSync(existing, "keep");
		assert.throws(() => outputDescriptor(existing, [source]));
		symlinkSync(existing, join(home, "link.json"));
		assert.throws(() => outputDescriptor(join(home, "link.json"), [source]));
		assert.equal(readFileSync(existing, "utf8"), "keep");
		closeSync(outputDescriptor(join(home, "new.json"), [source]));
	} finally { rmSync(home, { recursive: true, force: true }); }
});
