import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Windows without Developer Mode cannot create symlinks at all, so the protection below cannot be
 * exercised there. Probing keeps the test honest instead of failing on an environment limitation.
 */
function hostAllowsSymlinks(): boolean {
	const probe = mkdtempSync(join(tmpdir(), "render-cache-symlink-probe-"));
	try {
		mkdirSync(join(probe, "target"));
		symlinkSync(join(probe, "target"), join(probe, "link"), "dir");
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
}

test("report outputs cannot overwrite files or enter protected roots via symlinks", (t) => {
	if (!hostAllowsSymlinks()) {
		t.skip("host does not permit creating symlinks (Windows without Developer Mode); this protection is exercised on hosts that do");
		return;
	}
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

test("the worker names the host it refuses instead of reporting an unrelated version", () => {
	const root = mkdtempSync(join(tmpdir(), "render-cache-host-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "some-other-package", version: "9.9.9" }));
		const tui = join(root, "node_modules", "@earendil-works", "pi-tui");
		mkdirSync(tui, { recursive: true });
		writeFileSync(join(tui, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: "9.9.9" }));
		const worker = fileURLToPath(new URL("../scripts/render-cache-performance-worker.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [worker, JSON.stringify({ piRoot: root })], { encoding: "utf8" });
		assert.notEqual(result.status, 0, "a mismatched host must fail closed");
		assert.match(result.stderr, /is some-other-package@9\.9\.9/, "the error must name the package that was found");
		assert.match(result.stderr, /audited only on 1\.1\.0/, "the error must name the audited version");
		assert.match(result.stderr, /Point --pi-root at a Pi 1\.1\.0 install/, "the error must say how to satisfy it");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
