import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, outputDescriptor, percentile, summarize } from "../scripts/render-cache-performance.mjs";
import { validatePiRoot } from "../scripts/render-cache-host.mjs";

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

const workerScript = fileURLToPath(new URL("../scripts/render-cache-performance-worker.mjs", import.meta.url));

function runWorker(piRoot: string) {
	return spawnSync(process.execPath, [workerScript, JSON.stringify({ piRoot })], { encoding: "utf8" });
}

/** Writes only the two manifests the worker validates first, so each test controls what is missing. */
function writeHost(options: { name?: string; version?: string; tuiName?: string; tuiVersion?: string } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "render-cache-host-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({
		name: options.name ?? "@earendil-works/pi-coding-agent",
		version: options.version ?? "1.2.0",
	}));
	const tui = join(root, "node_modules", "@earendil-works", "pi-tui");
	mkdirSync(tui, { recursive: true });
	writeFileSync(join(tui, "package.json"), JSON.stringify({
		name: options.tuiName ?? "@earendil-works/pi-tui",
		version: options.tuiVersion ?? "1.2.0",
	}));
	return root;
}

test("the worker names the host it refuses instead of reporting an unrelated version", () => {
	const root = writeHost({ version: "9.9.9", tuiVersion: "9.9.9" });
	try {
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a mismatched host must fail closed");
		assert.match(result.stderr, /is @earendil-works\/pi-coding-agent@9\.9\.9/, "the error must name the package that was found");
		assert.match(result.stderr, /audited only on 1\.2\.0/, "the error must name the audited version");
		assert.match(result.stderr, /Point --pi-root at a Pi 1\.2\.0 install/, "the error must say how to satisfy it");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a host whose manifests are not Pi's is refused before anything is imported", () => {
	const root = writeHost({ name: "some-other-package" });
	try {
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a foreign root must fail closed");
		assert.match(result.stderr, /is not a Pi install root/);
		assert.match(result.stderr, /expected @earendil-works\/pi-coding-agent/, "the error must name the expected package");
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/, "the layout must be reported, not a module resolution error");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a host without the required dist layout is reported as a layout problem", () => {
	const root = writeHost();
	try {
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a root without dist must fail closed");
		assert.match(result.stderr, /is not a Pi install root/);
		assert.match(result.stderr, /dist is not a directory/, "the error must name the missing layout");
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/, "the layout must be reported, not a module resolution error");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest that is not an object is refused as a layout problem", () => {
	const root = writeHost();
	try {
		writeFileSync(join(root, "package.json"), "null");
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a null manifest must fail closed");
		assert.match(result.stderr, /declares no package name and version/);
		assert.doesNotMatch(result.stderr, /TypeError/, "the root must be described, not dereferenced");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a host missing a required dependency is refused as a layout problem", () => {
	const root = writeHost();
	try {
		const entry = join(root, "dist", "core", "extensions", "jiti-loader.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "");
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "an incomplete layout must fail closed");
		assert.match(result.stderr, /pi-ai is missing/, "the error must name the dependency that is missing");
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/, "the layout must be reported, not a module resolution error");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a required dependency that is not a directory is refused as a layout problem", () => {
	const root = writeHost();
	try {
		const entry = join(root, "dist", "core", "extensions", "jiti-loader.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "");
		for (const name of ["pi-ai", "pi-agent-core"]) {
			mkdirSync(join(root, "node_modules", "@earendil-works", name), { recursive: true });
		}
		writeFileSync(join(root, "node_modules", "jiti"), "not a directory");
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a dependency that is not a directory must fail closed");
		assert.match(result.stderr, /jiti is missing or not a directory/, "the error must name the dependency that is not a directory");
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/, "the layout must be reported, not a module resolution error");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a mixed host names the audited version and the layout it needs", () => {
	const root = writeHost({ tuiVersion: "1.2.1" });
	try {
		const result = runWorker(root);
		assert.notEqual(result.status, 0, "a mixed host must fail closed");
		assert.match(result.stderr, /mixes @earendil-works\/pi-coding-agent@1\.2\.0 with @earendil-works\/pi-tui@1\.2\.1/);
		assert.match(result.stderr, /Point --pi-root at a Pi 1\.2\.0 install/, "the error must name the audited version");
		assert.match(result.stderr, /node_modules\/@earendil-works\/\{pi-tui,pi-ai,pi-agent-core\}/, "the error must name the required layout");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

const driverScript = fileURLToPath(new URL("../scripts/render-cache-performance.mjs", import.meta.url));

/** Writes every path the host contract requires, so the positive case cannot drift from it. */
function writeCompleteHost(): string {
	const root = writeHost();
	const entry = join(root, "dist", "core", "extensions", "jiti-loader.js");
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(entry, "");
	for (const name of ["pi-ai", "pi-agent-core"]) mkdirSync(join(root, "node_modules", "@earendil-works", name), { recursive: true });
	mkdirSync(join(root, "node_modules", "jiti"), { recursive: true });
	return root;
}

test("a complete Pi root passes validation instead of being refused", () => {
	const root = writeCompleteHost();
	try {
		const { host, hostTui } = validatePiRoot(root);
		assert.equal(host.name, "@earendil-works/pi-coding-agent");
		assert.equal(host.version, "1.2.0");
		assert.equal(hostTui.version, "1.2.0");
		const result = runWorker(root);
		assert.doesNotMatch(result.stderr, /is not a Pi install root/, "a complete root must reach the host import, not the layout guard");
		assert.ok(result.stderr.length > 0, "the worker must keep going until the host import fails");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the documented command refuses a bad --pi-root before it fingerprints anything", () => {
	const root = mkdtempSync(join(tmpdir(), "render-cache-empty-host-"));
	try {
		const result = spawnSync(process.execPath, [driverScript,
			`--baseline-root=${dirname(workerScript)}`, `--candidate-root=${dirname(workerScript)}`,
			`--pi-root=${root}`, `--output=${join(root, "report.json")}`], { encoding: "utf8" });
		assert.notEqual(result.status, 0, "a bad host must fail closed");
		assert.match(result.stderr, /is not a Pi install root/, "the driver must reuse the curated layout message");
		assert.doesNotMatch(result.stderr, /ENOENT|ENOTDIR/, "the driver must not surface a bare read error");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
