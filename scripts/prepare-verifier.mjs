#!/usr/bin/env node
// Offline, single-root Git preparation. Never runs probes or removes failed scratch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
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

// Selective mode deliberately has no source Git commands, index, clone, or
// synthetic Git identity. Loose objects let us authenticate exactly the named
// objects without packed-delta reconstruction reading an unselected blob base.
function prepareSelective(sourceArg, scratchArg, extra) {
	const MAX_METADATA = 16 * 1024 * 1024;
	if (extra.length || Object.keys(plan).some(key => !["mode", "include", "checks", "baseline"].includes(key)) ||
		!Array.isArray(plan.checks) || !plan.checks.length || !plan.checks.every(check => typeof check === "string" && check.trim())) fail("unsupported selective plan: expected {mode: 'selective', include, checks, baseline}");
	if (!Array.isArray(plan.include) || !plan.include.length || new Set(plan.include).size !== plan.include.length) fail("selective include must be a nonempty unique list");
	if (plan.include.length > MAX_FILES) fail("payload exceeds preparation limit (20000 files / 256MiB)");
	if (typeof plan.baseline !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(plan.baseline)) fail("baseline must be a full commit object ID");
	const source = realpathSync(sourceArg);
	scratch = realpathSync(scratchArg);
	const finalScratch = lstatSync(scratchArg.replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, ""));
	if (finalScratch.isSymbolicLink() || !finalScratch.isDirectory() || !inside(realpathSync(tmpdir()), scratch) ||
		inside(source, scratch) || inside(scratch, source) || source === scratch || readdirSync(scratch).length) fail("scratch must be an empty real directory under system temp, outside source");

	const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	function safeStat(path, required = true) {
		// Walk top down: lstat of a descendant must never follow an unchecked
		// junction/ancestor. Repeated before opens and again before receipt.
		let current = source, stat;
		for (const part of relative(source, path).split(sep)) {
			current = join(current, part);
			try { stat = lstatSync(current); }
			catch (error) { if (error.code === "ENOENT" && !required) return undefined; if (error.code === "ENOENT") fail(`required input missing: ${relative(source, path)}`); throw error; }
			if (stat.isSymbolicLink() || !samePath(realpathSync(current), current)) fail("unsupported linked input");
			if (current !== path && !stat.isDirectory()) fail("regular file required; non-directory ancestor");
		}
		return stat;
	}
	const identity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
	function readBounded(path, maximum, limitReason, expected) {
		remaining();
		const stat = safeStat(path);
		if (!stat.isFile()) fail("regular file required");
		if (stat.size > maximum) fail(limitReason);
		if (expected && identity(stat) !== expected) fail("source input changed during preparation");
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || identity(opened) !== identity(stat)) fail("source input changed during preparation");
			safeStat(path); // Recheck ancestry after opening, before reading bytes.
			const bytes = Buffer.alloc(stat.size + 1);
			let count = 0, size;
			while (count < bytes.length && (size = readSync(fd, bytes, count, bytes.length - count, null))) { count += size; remaining(); }
			if (count !== stat.size || identity(fstatSync(fd)) !== identity(stat) || identity(safeStat(path)) !== identity(stat)) fail("source input changed during preparation");
			return { bytes: bytes.subarray(0, count), identity: identity(stat), mode: stat.mode };
		} finally { closeSync(fd); }
	}
	function inputPath(path) {
		if (typeof path !== "string" || !path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path) || isAbsolute(path) || /^[a-z]:/i.test(path) ||
			path.split("/").some(part => !part || part === "." || part === ".." || /^\.git(?:[ .]|$)/i.test(part) ||
				(process.platform === "win32" && (/[<>:"|?*]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) fail("unsupported input path: use exact repository-relative regular-file paths outside .git");
		const absolute = join(source, path);
		if (!inside(source, absolute)) fail("unsupported input path outside repository");
		return absolute;
	}
	const paths = plan.include.map(inputPath);
	if (process.platform === "win32" && new Set(paths.map(path => path.toLowerCase())).size !== paths.length) fail("selective include must be a nonempty unique list");
	// Validate ALL selections before the first candidate content read.
	let fileCount = 0;
	const initialIdentities = [];
	for (const path of paths) {
		remaining();
		const stat = safeStat(path);
		initialIdentities.push(identity(stat));
		if (!stat.isFile()) fail("regular file required");
		payloadBytes += stat.size;
		fileCount++;
		if (payloadBytes > MAX_BYTES) fail("payload exceeds preparation limit (20000 files / 256MiB)");
	}
	const files = paths.map((absolute, index) => ({ absolute, ...readBounded(absolute, MAX_BYTES, "payload exceeds preparation limit (20000 files / 256MiB)", initialIdentities[index]) }));
	for (const file of files) file.digest = hash(file.bytes);

	const gitDir = join(source, ".git"), objectsDir = join(gitDir, "objects");
	if (!safeStat(gitDir).isDirectory() || !safeStat(objectsDir).isDirectory()) fail("unsupported repository: ordinary single-root Git directory required");
	function repositoryGuards() {
		// Only presence/type/path metadata, never marker contents or config/refs.
		for (const path of ["shallow", "commondir", "info/grafts", "objects/info/alternates", "objects/info/http-alternates", "refs/replace", "info/sparse-checkout"]) {
			if (safeStat(join(gitDir, path), false)) fail("unsupported shallow, shared, sparse, grafted or replaced Git layout");
		}
		const packPath = join(objectsDir, "pack"), pack = safeStat(packPath, false);
		if (!pack) return;
		if (!pack.isDirectory()) fail("unsupported Git pack directory layout");
		// A bounded, nonrecursive filename scan detects promisor markers without
		// opening pack/index/marker bodies or enumerating loose object history.
		const directory = opendirSync(packPath);
		try {
			let entry, count = 0;
			while ((entry = directory.readSync())) {
				remaining();
				if (++count > MAX_FILES) fail("metadata exceeds preparation limit (20000 pack-directory entries)");
				if (entry.name.endsWith(".promisor") || !entry.isFile()) fail("unsupported partial or nonregular Git pack layout");
			}
		} finally { directory.closeSync(); }
	}
	repositoryGuards();
	// The pinned OID selects the algorithm, not private repository config.
	// Object hashes, canonical headers and tree OID widths authenticate that
	// choice; no Git process, ref resolution or alternate algorithm is tried.
	const objectFormat = plan.baseline.length === 40 ? "sha1" : "sha256";
	let metadataBytes = 0;
	const evidence = new Map();
	function object(oid, type) {
		remaining(); repositoryGuards();
		if (evidence.has(oid)) {
			const found = evidence.get(oid);
			if (found.type !== type) fail(`expected ${type} object`);
			return found.bytes;
		}
		const path = join(objectsDir, oid.slice(0, 2), oid.slice(2));
		if (!safeStat(path, false)) fail("baseline object unavailable as independent loose object; packed-only evidence unsupported (no fetch or fallback)");
		const available = type === "blob" ? MAX_BYTES - payloadBytes : MAX_METADATA - metadataBytes;
		const limitReason = type === "blob" ? "payload exceeds preparation limit (20000 files / 256MiB)" : "metadata exceeds preparation limit (16MiB)";
		// Compressed input and decompressed output are both bounded. Reading packs
		// or asking Git to reconstruct an unselected delta base is not permitted.
		const compressed = readBounded(path, available + 1024 * 1024, limitReason).bytes;
		let raw;
		try { raw = inflateSync(compressed, { maxOutputLength: available + 128 }); }
		catch (error) { if (error.code === "ERR_BUFFER_TOO_LARGE") fail(limitReason); fail("invalid loose Git object"); }
		remaining();
		const nul = raw.indexOf(0), header = raw.subarray(0, nul).toString("utf8"), match = /^(commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
		if (createHash(objectFormat).update(raw).digest("hex") !== oid) fail("Git object identity mismatch");
		if (nul < 0 || !match || match[1] !== type) fail(`expected ${type} object`);
		const bytes = raw.subarray(nul + 1);
		if (!Number.isSafeInteger(Number(match[2])) || bytes.length !== Number(match[2])) fail("invalid Git object length");
		if (bytes.length > available) fail(limitReason);
		if (type !== "blob") { metadataBytes += bytes.length; evidence.set(oid, { type, bytes }); }
		return bytes;
	}
	const commit = object(plan.baseline, "commit");
	const root = new RegExp(`^tree ([a-f0-9]{${plan.baseline.length}})\\n`).exec(commit.toString("utf8"));
	if (!root || !commit.includes(Buffer.from("\n\n"))) fail("invalid baseline commit tree evidence");
	const tree = root[1], trees = new Map();
	function treeEntries(oid) {
		if (trees.has(oid)) return trees.get(oid);
		const bytes = object(oid, "tree"), entries = new Map();
		let offset = 0;
		while (offset < bytes.length) {
			remaining();
			const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1), end = nul + 1 + plan.baseline.length / 2;
			if (space < offset || nul < space || end > bytes.length) fail("invalid baseline tree evidence");
			const mode = bytes.subarray(offset, space).toString("utf8"), name = bytes.subarray(space + 1, nul);
			if (!/^(40000|100644|100755|120000|160000)$/.test(mode) || !name.length || name.includes(47)) fail("invalid baseline tree entry");
			const key = name.toString("hex");
			if (entries.has(key)) fail("invalid duplicate baseline tree entry");
			entries.set(key, { mode, oid: bytes.subarray(nul + 1, end).toString("hex") }); offset = end;
		}
		trees.set(oid, entries); return entries;
	}
	const selected = [];
	for (let index = 0; index < plan.include.length; index++) {
		remaining();
		const path = plan.include[index], parts = path.split("/"), proof = [];
		let oid = tree, baseline = { status: "absent", proof }, baselineBytes;
		for (let part = 0; part < parts.length; part++) {
			proof.push(oid);
			const entry = treeEntries(oid).get(Buffer.from(parts[part]).toString("hex"));
			if (!entry) break;
			if (part < parts.length - 1) {
				if (["120000", "160000"].includes(entry.mode)) fail("unsupported selected baseline input: regular file required");
				if (entry.mode !== "40000") break; // Proven absence below a regular-file nontree.
				oid = entry.oid; continue;
			}
			if (!["100644", "100755"].includes(entry.mode)) fail("unsupported selected baseline input: regular file required");
			if (++fileCount > MAX_FILES) fail("payload exceeds preparation limit (20000 files / 256MiB)");
			baselineBytes = object(entry.oid, "blob"); payloadBytes += baselineBytes.length;
			baseline = { status: "present", proof, blob: entry.oid, mode: entry.mode, sha256: hash(baselineBytes), bytes: baselineBytes.length };
		}
		selected.push({ path, candidate: { provenance: "source-worktree-snapshot", sha256: files[index].digest, bytes: files[index].bytes.length }, baseline, baselineBytes });
	}
	const capacity = statfsSync(scratch);
	if (Number(capacity.bavail) * Number(capacity.bsize) < payloadBytes + metadataBytes || (Number(capacity.ffree) > 0 && Number(capacity.ffree) < fileCount + evidence.size)) fail("insufficient scratch capacity for selected payload and evidence");
	const work = join(scratch, "work"), baselineWork = join(scratch, "baseline");
	mkdirSync(work); mkdirSync(baselineWork); mkdirSync(join(scratch, "evidence"));
	for (let index = 0; index < selected.length; index++) {
		remaining();
		const entry = selected[index], file = files[index];
		const current = readBounded(file.absolute, MAX_BYTES, "payload exceeds preparation limit", file.identity);
		if (hash(current.bytes) !== file.digest) fail("source input changed during preparation");
		mkdirSync(dirname(join(work, entry.path)), { recursive: true });
		writeFileSync(join(work, entry.path), file.bytes, { mode: file.mode });
		if (entry.baselineBytes) {
			mkdirSync(dirname(join(baselineWork, entry.path)), { recursive: true });
			writeFileSync(join(baselineWork, entry.path), entry.baselineBytes, { mode: entry.baseline.mode === "100755" ? 0o755 : 0o644 });
		}
		delete entry.baselineBytes;
	}
	const objects = [];
	for (const [oid, entry] of evidence) {
		const file = `evidence/${oid}`;
		writeFileSync(join(scratch, file), entry.bytes);
		objects.push({ oid, type: entry.type, bytes: entry.bytes.length, file });
	}
	for (const file of files) {
		const current = readBounded(file.absolute, MAX_BYTES, "payload exceeds preparation limit", file.identity);
		if (hash(current.bytes) !== file.digest) fail("source input changed during preparation");
	}
	repositoryGuards(); remaining();
	console.log(JSON.stringify({ status: "ready", mode: "selective", provenance: "source-worktree-snapshot", gitSemantics: "none", work, baselineWork,
		baseline: { commit: plan.baseline, tree, objectFormat, objects }, selected, fileCount, payloadBytes, metadataBytes, repositoryMetadataBytes: 0,
		durationMs: performance.now() - started, probesRun: 0 }));
}

try {
	const [sourceArg, scratchArg, planArg, ...extra] = process.argv.slice(2);
	plan = JSON.parse(planArg);
	if (plan?.mode === "selective") prepareSelective(sourceArg, scratchArg, extra);
	else {
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
	}
} catch (error) {
	console.log(JSON.stringify({ status: "setup-failed", scratch, reason: error instanceof Error ? error.message : String(error),
		probesRun: 0, unrunChecks: Array.isArray(plan?.checks) ? plan.checks : [], payloadBytes, durationMs: performance.now() - started }));
	process.exitCode = 1;
}
