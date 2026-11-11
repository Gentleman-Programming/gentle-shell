#!/usr/bin/env node
// Offline, single-root Git preparation. Never runs probes or removes failed scratch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const started = performance.now(), MAX_BYTES = 256 * 1024 * 1024, MAX_FILES = 20_000, MAX_MS = 60_000;
let plan, scratch, payloadBytes = 0;
const fail = reason => { throw new Error(reason); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => { const rel = relative(root, path); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const remaining = () => { const ms = MAX_MS - (performance.now() - started); if (ms <= 0) fail("preparation deadline exceeded (60000ms)"); return Math.ceil(ms); };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
Object.assign(env, { GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" });
const git = (cwd, args, input, encoding = "utf8", maxBuffer = 16 * 1024 * 1024) => execFileSync("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", ...args], {
	cwd, env, input, encoding, timeout: remaining(), maxBuffer, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const names = text => text.split("\0").filter(Boolean);
const statAt = path => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };

try {
	const [sourceArg, scratchArg, planArg, ...extra] = process.argv.slice(2);
	plan = JSON.parse(planArg);
	if (extra.length || !plan || !Array.isArray(plan.include) || !Array.isArray(plan.checks) || !plan.checks.length ||
		!plan.checks.every(command => typeof command === "string" && command.trim()) ||
		(plan.runtimeArtifacts !== undefined && !Array.isArray(plan.runtimeArtifacts)) ||
		Object.keys(plan).some(key => !["include", "checks", "baseline", "runtimeArtifacts"].includes(key))) fail("expected source, fresh scratch, and {include, checks, baseline?, runtimeArtifacts?} plan");
	const source = realpathSync(sourceArg);
	scratch = realpathSync(scratchArg);
	const scratchPath = scratchArg.replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
	const scratchStat = lstatSync(scratchPath);
	if (scratchStat.isSymbolicLink() || !scratchStat.isDirectory() || !inside(realpathSync(tmpdir()), scratch) || inside(source, scratch) || inside(scratch, source) || source === scratch || readdirSync(scratch).length) fail("scratch must be an empty real directory under system temp, outside source");
	if (!lstatSync(join(source, ".git")).isDirectory() || lstatSync(join(source, ".git")).isSymbolicLink() ||
		realpathSync(git(source, ["rev-parse", "--show-toplevel"]).trim()) !== source ||
		resolve(source, git(source, ["rev-parse", "--git-common-dir"]).trim()) !== join(source, ".git")) fail("unsupported repository: ordinary single-root Git directory required");
	const head = git(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	const config = git(source, ["config", "--local", "--list"]);
	if (existsSync(join(source, ".git", "shallow")) || existsSync(join(source, ".git", "objects", "info", "alternates")) ||
		/^(core\.sparsecheckout=true|extensions\.partialclone=|remote\..*\.promisor=true)/mi.test(config) || git(source, ["for-each-ref", "--format=%(refname)", "refs/replace"]).trim()) fail("unsupported shallow, shared, sparse, partial or replaced Git history");
	if (plan.baseline !== undefined && (typeof plan.baseline !== "string" || !/^[a-f0-9]{40,64}$/.test(plan.baseline))) fail("baseline must be a full commit object ID");
	const indexPath = join(source, ".git", "index"), indexHash = hash(readFileSync(indexPath));
	const staged = git(source, ["ls-files", "--stage", "-z"]);
	if (names(staged).some(entry => !/^100(644|755) [a-f0-9]+ 0\t/.test(entry))) fail("unsupported index: links, submodules or conflicts");
	if (names(git(source, ["ls-files", "-v", "-z"])).some(entry => !entry.startsWith("H "))) fail("unsupported index flags: sparse or assume-unchanged entries");
	const tracked = names(git(source, ["ls-files", "-z"]));
	const files = new Map(), missing = [], excludedRuntimeArtifacts = [];
	function resolveInput(path) {
		remaining();
		if (typeof path !== "string" || !path || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || isAbsolute(path)) fail("unsupported input path: use literal repository-relative paths outside .git");
		const absolute = join(source, path);
		if (!inside(source, absolute)) fail("unsupported input outside repository");
		// Check each ancestor before following directories, including dependency junctions.
		for (let current = absolute; current !== source; current = dirname(current)) {
			if (statAt(current)?.isSymbolicLink()) fail("unsupported linked input; provide an independent regular-file dependency payload");
		}
		return absolute;
	}
	function collect(path, required) {
		const absolute = resolveInput(path), stat = statAt(absolute);
		if (!stat) { if (required) fail(`required input missing: ${path}`); missing.push(path); return; }
		if (stat.isDirectory()) {
			if (!required) fail("unsupported tracked file replaced by directory; no implicit untracked expansion");
			for (const entry of readdirSync(absolute)) collect(`${path}/${entry}`, true);
			return;
		}
		if (!stat.isFile()) fail(`unsupported required runtime artifact: ${path}`);
		if (files.has(path)) return;
		payloadBytes += stat.size;
		if (files.size >= MAX_FILES || payloadBytes > MAX_BYTES) fail("payload exceeds preparation limit (20000 files / 256MiB); narrow the complete required payload");
		files.set(path, { absolute, mode: stat.mode, digest: hash(readFileSync(absolute)) });
	}
	for (const path of tracked) collect(path, false);
	for (const path of plan.include) collect(path, true);
	for (const path of plan.runtimeArtifacts ?? []) {
		const stat = statAt(resolveInput(path));
		if (!stat || stat.isFile() || stat.isDirectory()) fail(`runtime artifact must name an existing non-regular input: ${path}`);
		excludedRuntimeArtifacts.push(path);
	}
	const capacity = statfsSync(scratch);
	if (Number(capacity.bavail) * Number(capacity.bsize) < payloadBytes || (Number(capacity.ffree) > 0 && Number(capacity.ffree) < files.size)) fail("insufficient scratch capacity for required regular-file payload");
	const work = join(scratch, "work");
	// --no-local transfers reachable Git objects instead of sharing objects or copying config/hooks.
	git(scratch, ["clone", "--no-local", "--no-checkout", "--template=", "--", source, work]);
	if (git(work, ["rev-parse", "HEAD"]).trim() !== head) fail("source HEAD changed during preparation");
	if (plan.baseline) git(work, ["cat-file", "-e", `${plan.baseline}^{commit}`]);
	git(work, ["read-tree", head]);
	const patch = git(source, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", head, "--"], undefined, null, 2 * MAX_BYTES);
	if (patch.length) git(work, ["apply", "--cached", "--binary", "-"], patch);
	for (const [path, file] of files) {
		remaining();
		const bytes = readFileSync(file.absolute);
		if (hash(bytes) !== file.digest) fail("source input changed during preparation");
		mkdirSync(dirname(join(work, path)), { recursive: true });
		writeFileSync(join(work, path), bytes, { mode: file.mode });
	}
	if (git(work, ["ls-files", "--stage", "-z"]) !== staged || hash(readFileSync(indexPath)) !== indexHash || git(source, ["rev-parse", "HEAD"]).trim() !== head ||
		[...files.values()].some(file => hash(readFileSync(file.absolute)) !== file.digest) || missing.some(path => statAt(join(source, path)))) fail("source/index changed or copied index differs; no probes permitted");
	remaining();
	console.log(JSON.stringify({ status: "ready", work, head, baseline: plan.baseline ?? head, fileCount: files.size, payloadBytes,
		durationMs: performance.now() - started, excludedRuntimeArtifacts, probesRun: 0 }));
} catch (error) {
	console.log(JSON.stringify({ status: "setup-failed", scratch, reason: error instanceof Error ? error.message : String(error),
		probesRun: 0, unrunChecks: Array.isArray(plan?.checks) ? plan.checks : [], payloadBytes, durationMs: performance.now() - started }));
	process.exitCode = 1;
}
