// Diagnostic comparison, not a speed gate. Run each source in a fresh process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function percentile(values, fraction) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const position = (sorted.length - 1) * fraction;
	const low = Math.floor(position);
	return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}
export function summarize(values) {
	return { count: values.length, median: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null };
}
export function compare(before, after) {
	assert.deepEqual(after.metadata, before.metadata, "host and scheduler must match");
	assert.equal(before.cases.length, after.cases.length);
	return before.cases.map((original, index) => {
		const candidate = after.cases[index];
		assert.deepEqual(candidate.spec, original.spec);
		assert.equal(candidate.coldScreen, original.coldScreen, "cold visible output differs");
		assert.deepEqual(candidate.screens, original.screens, `visible output differs: ${JSON.stringify(original.spec)}`);
		return { spec: original.spec, before: summarize(original.wallMs), after: summarize(candidate.wallMs),
			speedup: percentile(original.wallMs, 0.5) / percentile(candidate.wallMs, 0.5) };
	});
}
function hashFiles(root, paths) {
	const hash = createHash("sha256");
	for (const path of paths.sort()) hash.update(path + "\0").update(readFileSync(resolve(root, path))).update("\0");
	return hash.digest("hex");
}
function fingerprint(root) {
	const paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
	return { root, head: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceSha256: hashFiles(root, paths) };
}
function hostFingerprint(root) {
	const packages = [root, ...["pi-tui", "pi-ai", "pi-agent-core", "jiti"].map((name) => resolve(root, "node_modules", name === "jiti" ? name : `@earendil-works/${name}`))];
	return packages.map((path) => {
		const packageRoot = realpathSync(path);
		const files = readdirSync(packageRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(packageRoot, resolve(entry.parentPath, entry.name)));
		return { root: packageRoot, package: JSON.parse(readFileSync(resolve(path, "package.json"), "utf8")).version, sha256: hashFiles(packageRoot, files) };
	});
}
export function outputDescriptor(output, protectedRoots) {
	const canonical = resolve(realpathSync(dirname(resolve(output))), basename(output));
	for (const root of protectedRoots) {
		const path = relative(realpathSync(root), canonical);
		assert.ok(path && (isAbsolute(path) || path === ".." || path.startsWith(".." + sep)), "output must be outside source, harness and host roots");
	}
	return openSync(canonical, "wx", 0o600);
}
async function main() {
	const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
		assert.match(arg, /^--[a-z-]+=.+$/, "use --name=value arguments");
		const split = arg.indexOf("="); return [arg.slice(2, split), arg.slice(split + 1)];
	}));
	for (const key of ["baseline-root", "candidate-root", "pi-root", "output"]) assert.ok(options[key], `--${key} is required`);
	const roots = { before: resolve(options["baseline-root"]), after: resolve(options["candidate-root"]) };
	const initial = Object.fromEntries(Object.entries(roots).map(([key, root]) => [key, fingerprint(root)]));
	assert.equal(initial.before.head, initial.after.head, "compare worktrees based on the same commit");
	const numeric = (name, fallback, min) => { const value = Number(options[name] ?? fallback); assert.ok(Number.isInteger(value) && value >= min, `invalid --${name}`); return value; };
	const list = (name, fallback) => (options[name] ?? fallback).split(",").map(Number);
	const config = { piRoot: resolve(options["pi-root"]), counts: list("counts", "100,1000,5000"), widths: list("widths", "100,160"),
		styles: (options.styles ?? "float,neon").split(","), samples: numeric("samples", 50, 2), warmup: 5, liveMs: numeric("live-ms", 6000, 0) };
	assert.ok([...config.counts, ...config.widths].every((value) => Number.isInteger(value) && value > 0));
	assert.ok(config.styles.length <= 2 && config.styles.every((style) => ["float", "neon"].includes(style)));
	assert.ok(config.widths.every((width) => width > 40), "resize scenarios need widths above 40");
	const repetitions = numeric("repetitions", 4, 1);
	assert.ok(repetitions <= 20 && config.samples <= 2000 && config.liveMs <= 60000);
	assert.ok(config.counts.length <= 4 && config.widths.length <= 4 && Math.max(...config.counts) <= 20000 && Math.max(...config.widths) <= 300);
	const report = { schema: "gentle-shell.render-performance/v1", started: new Date().toISOString(), node: process.version,
		cpu: cpus()[0]?.model, loadAtStart: loadavg(), sources: initial, config, runs: [], comparisons: [] };
	const worker = fileURLToPath(new URL("render-cache-performance-worker.mjs", import.meta.url));
	const instrumentationHash = () => createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).update(readFileSync(worker)).digest("hex");
	report.instrumentationSha256 = instrumentationHash();
	report.host = hostFingerprint(config.piRoot);
	const fd = outputDescriptor(options.output, [...Object.values(roots), config.piRoot, ...report.host.map((entry) => entry.root), resolve(dirname(fileURLToPath(import.meta.url)), "..")]);
	const persist = () => {
		const data = Buffer.from(JSON.stringify(report, null, 2) + "\n");
		ftruncateSync(fd, 0);
		let offset = 0;
		while (offset < data.length) {
			const written = writeSync(fd, data, offset, data.length - offset, offset);
			assert.ok(written > 0); offset += written;
		}
	};
	try {
		for (let repetition = 0; repetition < repetitions; repetition++) {
			const pair = {};
			for (const variant of repetition % 2 ? ["after", "before"] : ["before", "after"]) {
				console.log(`replica ${repetition + 1}/${repetitions}: ${variant}`);
				const output = execFileSync(process.execPath, ["--expose-gc", "--experimental-strip-types", worker,
					JSON.stringify({ ...config, root: roots[variant], repetition })], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 1_200_000 });
				pair[variant] = JSON.parse(output);
				report.runs.push({ repetition, variant, ...pair[variant] });
				persist();
			}
			report.comparisons.push({ repetition, cases: compare(pair.before, pair.after) });
			persist();
		}
		for (const [key, root] of Object.entries(roots)) assert.deepEqual(fingerprint(root), initial[key], "source changed during measurement");
		assert.equal(instrumentationHash(), report.instrumentationSha256, "instrumentation changed during measurement");
		assert.deepEqual(hostFingerprint(config.piRoot), report.host, "host runtime changed during measurement");
		report.finished = new Date().toISOString();
		report.loadAtEnd = loadavg();
		persist();
	} finally { closeSync(fd); }
	console.log(`PASS: ${report.comparisons[0].cases.length} equivalent cases × ${repetitions} paired replicas; raw report: ${resolve(options.output)}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
