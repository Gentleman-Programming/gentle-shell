import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import test from "node:test";

const helper = fileURLToPath(new URL("../scripts/prepare-verifier.mjs", import.meta.url));
const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const objectId = (kind: string, bytes: Buffer, algorithm = "sha1") => createHash(algorithm).update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");

function fixture(t: any, format = "sha1") {
	const root = mkdtempSync(join(tmpdir(), "gentle-selective-")), source = join(root, "source");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(source);
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: source, env, encoding: "utf8" }).trim();
	git("init", "-q", `--object-format=${format}`);
	git("config", "user.name", "Synthetic selective fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "core.autocrlf", "false");
	git("config", "commit.gpgsign", "false");
	const put = (path: string, bytes: string | Buffer) => { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), bytes); };
	put("docs/selected [x].md", "baseline document\n");
	put("unrelated-tracked.txt", "synthetic tracked sentinel\n");
	put("unrelated-staged.txt", "synthetic staged baseline\n");
	put(".gitignore", "ignored/\n");
	git("add", "."); git("commit", "-qm", "synthetic baseline");
	const baseline = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
	put("docs/selected [x].md", "modified worktree document\n");
	put("odd/tasks/selected-task.md", "untracked progress bookkeeping\n");
	put("unrelated-staged.txt", "synthetic staged sentinel\n"); git("add", "unrelated-staged.txt");
	put("unrelated-untracked.txt", "synthetic untracked sentinel\n");
	put("ignored/sentinel.txt", "synthetic ignored sentinel\n");
	const selected = ["docs/selected [x].md", "odd/tasks/selected-task.md"];
	const checks = [`node -e "require('node:fs').writeFileSync('probe-ran','unexpected')"`, "exact second check"];
	// Test-only source readback, outside the audited helper process. It includes
	// every file and Git byte; no status command can refresh the source index.
	const snapshot = () => {
		const entries: Record<string, string> = {};
		function visit(path: string, prefix: string) {
			for (const entry of readdirSync(path, { withFileTypes: true })) {
				const key = prefix + entry.name, absolute = join(path, entry.name);
				if (entry.isDirectory()) visit(absolute, key + "/");
				else if (entry.isFile()) entries[key] = sha256(readFileSync(absolute));
			}
		}
		visit(source, ""); return entries;
	};
	const allowedObjects = new Set<string>([baseline, tree, git("rev-parse", "HEAD:docs"), git("rev-parse", "HEAD:docs/selected [x].md")]);
	const audit = join(root, "audit.cjs"), log = join(root, "audit.jsonl");
	// Public CLI instrumentation observes actual fs calls and child-process
	// launches, not just output omissions. syncBuiltinESMExports also patches
	// named ESM imports used by the helper. It is confined to this child.
	writeFileSync(audit, `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const original = {...fs}, zlib = require('node:zlib'), rawInflate = zlib.inflateSync;
const source = ${JSON.stringify(source)}, log = ${JSON.stringify(log)};
const selected = JSON.parse(process.env.AUDIT_SELECTED), allowed = new Set(JSON.parse(process.env.AUDIT_OBJECTS));
const objectPaths = [...allowed].map(oid => '.git/objects/'+oid.slice(0,2)+'/'+oid.slice(2));
let triggered = false;
const record = event => original.appendFileSync(log, JSON.stringify(event)+'\\n');
const forbidden = reason => {record({forbidden:reason}); throw new Error('AUDIT prohibited '+reason);};
const check = value => {
 if(typeof value !== 'string') return;
 const rel = path.relative(source, path.resolve(value)).split(path.sep).join('/');
 if(path.resolve(value) === ${JSON.stringify(join(root, "outside.txt"))}) forbidden('outside target');
 if(rel && !rel.startsWith('../') && !path.isAbsolute(rel) && !selected.includes(rel) && !objectPaths.includes(rel)) forbidden('content read '+rel);
 if(objectPaths.includes(rel)) {
  record({object:rel});
  if(!triggered && process.env.AUDIT_MUTATE) {
   triggered = true;
   const target = path.join(source,selected[0]);
   if(process.env.AUDIT_MUTATE === 'link') {original.unlinkSync(target); original.symlinkSync(${JSON.stringify(join(root, "outside.txt"))}, target);}
   else original.writeFileSync(target,'external mutation during preparation\\n');
  }
 }
 record({read:rel});
};
for(const name of ['readFileSync','openSync','copyFileSync','cpSync','createReadStream']) {
 fs[name] = function(file,...args) {check(file); return original[name].call(this,file,...args);};
}
for(const name of ['readdirSync','opendirSync']) fs[name] = function(file,...args) {
 const rel = path.relative(source, path.resolve(String(file))).split(path.sep).join('/');
 if(!rel || (rel !== '.git/objects/pack' && !rel.startsWith('../') && !path.isAbsolute(rel))) forbidden('enumeration '+rel);
 record({enumeration:rel});
 if(name === 'opendirSync' && rel === '.git/objects/pack' && process.env.AUDIT_RESOURCE === 'metadata') return {
  readSync:()=>({name:'synthetic.pack',isFile:()=>true}),
  closeSync:()=>record({closed:'synthetic-pack-directory'})
 };
 return original[name].call(this,file,...args);
};
cp.execFileSync = function(command,args) {record({command,args}); forbidden('subprocess '+command);};
zlib.inflateSync = function(...args) {
 let result = rawInflate(...args);
 const kind = result.subarray(0,result.indexOf(32)).toString();
 if(process.env.AUDIT_TAMPER === '1' || process.env.AUDIT_TAMPER === kind) {result = Buffer.from(result); const start = result.indexOf(0)+1; if(result.length > start) result[start] ^= 1;}
 return result;
};
for(const name of ['spawnSync','execSync','exec','execFile','spawn','fork']) cp[name] = function() {forbidden(name);};
if(process.env.AUDIT_RESOURCE === 'capacity') fs.statfsSync = () => ({bavail:0,bsize:4096,ffree:0});
if(process.env.AUDIT_RESOURCE === 'deadline') {let ticks=0; Object.defineProperty(performance,'now',{value:()=>ticks++ ? 60001 : 0});}
require('node:module').syncBuiltinESMExports();
`);
	const prepare = (overrides: Record<string, any> = {}, options: { audit?: boolean; mutate?: string; tamper?: string; scratch?: string; resource?: string; allowCandidates?: string[] } = {}) => {
		const scratch = options.scratch ?? mkdtempSync(join(root, "scratch-"));
		const plan = { mode: "selective", include: selected, baseline, checks, ...overrides };
		const childEnv = { ...env, NODE_OPTIONS: "", AUDIT_SELECTED: JSON.stringify(options.allowCandidates ?? plan.include), AUDIT_OBJECTS: JSON.stringify([...allowedObjects]), AUDIT_MUTATE: options.mutate ?? "", AUDIT_TAMPER: options.tamper ?? "", AUDIT_RESOURCE: options.resource ?? "" };
		const result = spawnSync(process.execPath, [...(options.audit ? ["--require", audit] : []), helper, source, scratch, JSON.stringify(plan)], { env: childEnv, encoding: "utf8", timeout: 70_000, maxBuffer: 4 * 1024 * 1024 });
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.stderr, "");
		const receipt = JSON.parse(result.stdout);
		assert.equal(result.stdout, JSON.stringify(receipt) + "\n", "stdout is exactly one JSON receipt");
		assert.equal(receipt.probesRun, 0);
		assert.equal(existsSync(join(source, "probe-ran")), false);
		assert.equal(existsSync(join(scratch, "work", "probe-ran")), false);
		return { ...result, receipt, scratch, plan };
	};
	const rejected = (result: ReturnType<typeof prepare>, reason: RegExp) => {
		assert.equal(result.status, 1);
		assert.equal(result.receipt.status, "setup-failed");
		assert.match(result.receipt.reason, reason);
		assert.deepEqual(result.receipt.unrunChecks, checks);
		assert.equal(result.receipt.work, undefined, "no ready partial workspace");
		assert.ok(result.receipt.durationMs >= 0);
	};
	return { root, source, put, git, baseline, tree, selected, checks, snapshot, allowedObjects, log, prepare, rejected };
}

function verifyEvidence(f: ReturnType<typeof fixture>, result: ReturnType<ReturnType<typeof fixture>["prepare"]>, algorithm = "sha1") {
	const r = result.receipt;
	assert.equal(result.status, 0, r.reason);
	assert.equal(r.status, "ready");
	assert.equal(r.mode, "selective");
	assert.equal(r.provenance, "source-worktree-snapshot");
	assert.equal(r.gitSemantics, "none");
	assert.equal(r.head, undefined);
	assert.equal(r.index, undefined);
	assert.equal(r.unrunChecks, undefined);
	assert.equal(r.work, join(result.scratch, "work"));
	assert.equal(r.baselineWork, join(result.scratch, "baseline"));
	assert.equal(r.baseline.commit, f.baseline);
	assert.equal(r.baseline.objectFormat, algorithm);
	assert.equal(r.baseline.tree, f.tree);
	const objects = new Map<string, { type: string; bytes: Buffer }>();
	for (const object of r.baseline.objects) {
		const bytes = readFileSync(join(result.scratch, object.file));
		assert.equal(objectId(object.type, bytes, algorithm), object.oid);
		assert.equal(object.bytes, bytes.length);
		objects.set(object.oid, { type: object.type, bytes });
	}
	const commit = objects.get(f.baseline)!;
	assert.equal(commit.type, "commit");
	assert.ok(commit.bytes.toString("utf8").startsWith(`tree ${f.tree}\n`));
	for (const entry of r.selected) {
		const candidate = readFileSync(join(r.work, entry.path));
		assert.deepEqual(candidate, readFileSync(join(f.source, entry.path)));
		assert.deepEqual(entry.candidate, { provenance: "source-worktree-snapshot", sha256: sha256(candidate), bytes: candidate.length });
		let oid = f.tree;
		const parts = entry.path.split("/");
		for (let i = 0; i < entry.baseline.proof.length; i++) {
			assert.equal(entry.baseline.proof[i], oid);
			const tree = objects.get(oid)!;
			assert.equal(tree.type, "tree");
			let pos = 0, match: { mode: string; oid: string } | undefined;
			while (pos < tree.bytes.length) {
				const space = tree.bytes.indexOf(32, pos), nul = tree.bytes.indexOf(0, space);
				const mode = tree.bytes.subarray(pos, space).toString(), name = tree.bytes.subarray(space + 1, nul).toString();
				const next = nul + 1 + (algorithm === "sha1" ? 20 : 32);
				if (name === parts[i]) match = { mode, oid: tree.bytes.subarray(nul + 1, next).toString("hex") };
				pos = next;
			}
			if (!match) { assert.equal(entry.baseline.status, "absent"); break; }
			oid = match.oid;
			if (i === parts.length - 1) {
				assert.equal(entry.baseline.status, "present");
				assert.equal(entry.baseline.blob, oid);
				assert.equal(entry.baseline.mode, match.mode);
				const bytes = readFileSync(join(r.baselineWork, entry.path));
				assert.equal(objectId("blob", bytes, algorithm), oid);
				assert.equal(entry.baseline.sha256, sha256(bytes));
				assert.equal(entry.baseline.bytes, bytes.length);
			}
		}
		if (entry.baseline.status === "absent") {
			assert.equal(existsSync(join(r.baselineWork, entry.path)), false);
			assert.equal(entry.baseline.blob, undefined);
		}
	}
	assert.deepEqual(r.selected.map((e: any) => e.path), result.plan.include);
	const candidateBytes = r.selected.reduce((n: number, e: any) => n + e.candidate.bytes, 0);
	const baselineBytes = r.selected.reduce((n: number, e: any) => n + (e.baseline.bytes ?? 0), 0);
	assert.equal(r.fileCount, r.selected.length + r.selected.filter((e: any) => e.baseline.status === "present").length);
	assert.equal(r.payloadBytes, candidateBytes + baselineBytes);
	assert.equal(r.metadataBytes, r.baseline.objects.reduce((n: number, e: any) => n + e.bytes, 0));
	assert.equal(r.repositoryMetadataBytes, 0, "config/ref bodies are never read");
	assert.ok(r.durationMs >= 0 && r.durationMs < 60_000);
	assert.equal(existsSync(join(r.work, ".git")), false);
	assert.equal(existsSync(join(r.baselineWork, ".git")), false);
}

test("S3-S6/S9: selective modified and untracked snapshots have independently verifiable baseline evidence without unrelated access", t => {
	const f = fixture(t), before = f.snapshot();
	const result = f.prepare({}, { audit: true });
	verifyEvidence(f, result);
	assert.equal(result.receipt.selected[0].baseline.status, "present");
	assert.equal(result.receipt.selected[1].baseline.status, "absent");
	assert.notEqual(result.receipt.selected[0].baseline.sha256, result.receipt.selected[0].candidate.sha256);
	assert.deepEqual(f.snapshot(), before);
	const events = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.ok(events.some(e => e.read === f.selected[0]), "instrumentation observes actual content access");
	assert.ok(events.some(e => e.object), "instrumentation observes exact loose-object reads");
	assert.equal(events.some(e => e.command), false, "selective preparation launches no subprocesses");
	assert.equal(events.some(e => e.forbidden), false, JSON.stringify(events));
	for (const path of ["unrelated-tracked.txt", "unrelated-staged.txt", "unrelated-untracked.txt", "ignored/sentinel.txt"]) {
		assert.equal(existsSync(join(result.receipt.work, path)), false);
		assert.equal(existsSync(join(result.receipt.baselineWork, path)), false);
	}
	writeFileSync(join(result.receipt.work, f.selected[0]), "isolated edit\n");
	assert.deepEqual(f.snapshot(), before);
});

test("S3/S5: tracker is never implicitly included and empty/duplicate selections are rejected", t => {
	const f = fixture(t), before = f.snapshot();
	const result = f.prepare({ include: [f.selected[0]] }, { audit: true });
	verifyEvidence(f, result);
	assert.equal(existsSync(join(result.receipt.work, f.selected[1])), false);
	for (const include of [[], [f.selected[0], f.selected[0]]]) f.rejected(f.prepare({ include }), /selective include must be a nonempty unique list/);
	assert.deepEqual(f.snapshot(), before);
});

test("S4: missing, malformed, abbreviated and noncommit baselines fail closed", t => {
	const f = fixture(t), before = f.snapshot();
	for (const baseline of [undefined, "HEAD", f.baseline.slice(0, 8), "f".repeat(40), "a".repeat(41), f.tree]) {
		f.rejected(f.prepare({ baseline }), /baseline must be a full commit object ID|baseline object unavailable|expected commit object/);
	}
	assert.deepEqual(f.snapshot(), before);
});

test("S4: tampered object bytes cannot fabricate authentic provenance", t => {
	const f = fixture(t), before = f.snapshot();
	for (const tamper of ["commit", "tree", "blob"]) f.rejected(f.prepare({}, { audit: true, tamper }), /Git object identity mismatch/);
	assert.deepEqual(f.snapshot(), before);
});

test("S4/S8: SHA1 and SHA256 loose identities retain genuine selected evidence", t => {
	for (const format of ["sha1", "sha256"]) {
		const f = fixture(t, format), before = f.snapshot();
		verifyEvidence(f, f.prepare({}, { audit: true }), format);
		assert.deepEqual(f.snapshot(), before);
	}
});

test("S3/S4: opaque config and packed-ref sentinels stay unopened for SHA1 and SHA256 snapshots", t => {
	for (const format of ["sha1", "sha256"]) {
		const f = fixture(t, format);
		// Deliberately opaque synthetic bytes, not real credentials. A pinned
		// object proof needs neither valid Git configuration nor reference text.
		f.put(".git/config", "synthetic private configuration sentinel: never open or parse\n");
		f.put(".git/packed-refs", "synthetic unrelated ref sentinel: never open or parse\n");
		const before = f.snapshot(), result = f.prepare({}, { audit: true });
		assert.deepEqual(f.snapshot(), before);
		verifyEvidence(f, result, format);
		const events = readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line));
		assert.equal(events.some(e => e.read === ".git/config" || e.read === ".git/packed-refs" || e.command || e.forbidden), false, JSON.stringify(events));
	}
});

test("S4: a forged OID algorithm never authenticates evidence from another object format", t => {
	for (const format of ["sha1", "sha256"]) {
		for (const forgedHash of [false, true]) {
			const f = fixture(t, format), algorithm = format === "sha1" ? "sha256" : "sha1";
			const compressed = readFileSync(join(f.source, ".git/objects", f.baseline.slice(0, 2), f.baseline.slice(2)));
			const oid = forgedHash ? createHash(algorithm).update(inflateSync(compressed)).digest("hex") : (format === "sha1" ? f.baseline.padEnd(64, "0") : f.baseline.slice(0, 40));
			// Even rehashing the raw commit with the other algorithm cannot forge
			// its tree linkage: the embedded tree ID has the wrong width.
			f.put(`.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, compressed);
			f.allowedObjects.add(oid);
			const before = f.snapshot();
			f.rejected(f.prepare({ baseline: oid }, { audit: true }), forgedHash ? /invalid baseline commit tree evidence/ : /Git object identity mismatch/);
			assert.deepEqual(f.snapshot(), before);
		}
	}
});

test("S3/S4/S8: packed-only baseline fails closed rather than reconstructing unselected delta bases", t => {
	const f = fixture(t);
	f.git("repack", "-ad"); f.git("prune-packed");
	const before = f.snapshot();
	f.rejected(f.prepare({}, { audit: true }), /baseline object unavailable.*packed-only evidence unsupported/);
	assert.deepEqual(f.snapshot(), before);
});

test("S6: mutation during preparation is drift, not an intentional baseline difference", t => {
	const f = fixture(t), before = f.snapshot();
	f.rejected(f.prepare({}, { audit: true, mutate: "bytes" }), /source input changed during preparation/);
	assert.equal(readFileSync(join(f.source, f.selected[0]), "utf8"), "external mutation during preparation\n");
	const after = f.snapshot();
	delete before[f.selected[0]]; delete after[f.selected[0]];
	assert.deepEqual(after, before, "only the controlled external mutation occurred");
});

test("S7: traversal, absolute, Git-internal, directory and missing paths fail before content reads", t => {
	const f = fixture(t), before = f.snapshot();
	for (const path of ["../outside.txt", join(f.root, "outside.txt"), ".git/config", ".GIT/config", "C:relative.txt", "docs/../unrelated-tracked.txt", "docs//selected [x].md", "docs/./selected [x].md", "docs\\selected [x].md", "docs", "missing.txt", "docs/selected [x].md/child", "", "nul\u0000byte", ...(process.platform === "win32" ? ["file:stream", "trailing. ", "NUL"] : [])]) {
		f.rejected(f.prepare({ include: [path] }, { audit: true }), /unsupported input path|regular file required|required input missing/);
	}
	assert.deepEqual(f.snapshot(), before);
	if (existsSync(f.log)) assert.doesNotMatch(readFileSync(f.log, "utf8"), /"read":"(?:docs|missing|\.\.\/)/);
});

test("S7: safe special names are literal, never Git pathspecs or globs", t => {
	const f = fixture(t);
	const paths = ["-dash [x]!.md", ...(process.platform === "win32" ? [] : [":(glob)literal*.md"])];
	for (const path of paths) f.put(path, `baseline ${path}\n`);
	f.git("--literal-pathspecs", "add", "--", ...paths); f.git("commit", "-qm", "literal baseline");
	f.baseline = f.git("rev-parse", "HEAD"); f.tree = f.git("rev-parse", "HEAD^{tree}");
	for (const path of paths) f.put(path, `candidate ${path}\n`);
	const before = f.snapshot();
	verifyEvidence(f, f.prepare({ include: paths, baseline: f.baseline }));
	assert.deepEqual(f.snapshot(), before);
});

test("S7: linked ancestors, final links and a changed-to-link candidate never read forbidden targets", { skip: process.platform === "win32" }, t => {
	const f = fixture(t);
	writeFileSync(join(f.root, "outside.txt"), "synthetic outside sentinel\n");
	symlinkSync(f.root, join(f.source, "alias"), "dir");
	symlinkSync(join(f.root, "outside.txt"), join(f.source, "linked.txt"));
	const before = f.snapshot();
	for (const path of ["alias/outside.txt", "linked.txt"]) f.rejected(f.prepare({ include: [path] }, { audit: true }), /unsupported linked input/);
	assert.deepEqual(f.snapshot(), before);
	f.rejected(f.prepare({}, { audit: true, mutate: "link" }), /unsupported linked input|source input changed during preparation/);
	assert.equal(readFileSync(join(f.root, "outside.txt"), "utf8"), "synthetic outside sentinel\n");
});

test("S7/S9: selected nonregular socket is rejected without opening or probing", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t), server = createServer(), socket = join(f.source, "daemon.sock");
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const before = f.snapshot();
	f.rejected(f.prepare({ include: ["daemon.sock"] }, { audit: true }), /regular file required/);
	assert.deepEqual(f.snapshot(), before);
});

test("S8: selective oversized payload fails before content reads", t => {
	const f = fixture(t);
	f.put("too-large.bin", ""); truncateSync(join(f.source, "too-large.bin"), 256 * 1024 * 1024 + 1);
	const index = readFileSync(join(f.source, ".git/index"));
	f.rejected(f.prepare({ include: ["too-large.bin"] }, { audit: true }), /payload exceeds preparation limit/);
	assert.deepEqual(readFileSync(join(f.source, ".git/index")), index);
});

test("S8: selective file-count limit rejects requests before content reads", { skip: process.platform === "win32" }, t => {
	const f = fixture(t), before = f.snapshot();
	// Below POSIX's single-argument byte limit; Windows' smaller command-line
	// ceiling prevents expressing this many exact paths through this CLI.
	const include = Array.from({ length: 20_001 }, (_, i) => String.fromCodePoint(0x1000 + i));
	f.rejected(f.prepare({ include }), /payload exceeds preparation limit/);
	assert.deepEqual(f.snapshot(), before);
});

test("S8: metadata output and aggregate processing are bounded", t => {
	const f = fixture(t), bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
	// A large valid commit, not an unrelated file blob. Bounded inflation must
	// reject it rather than retain oversized metadata in the prepared evidence.
	const commit = Buffer.concat([Buffer.from(`tree ${f.tree}\nauthor F <f@example.invalid> 0 +0000\ncommitter F <f@example.invalid> 0 +0000\n\n`), bytes]);
	const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: f.source, env, input: commit, encoding: "utf8" }).trim();
	const before = f.snapshot();
	f.rejected(f.prepare({ baseline: oid }), /metadata exceeds preparation limit/);
	assert.deepEqual(f.snapshot(), before);
});

test("S8: unsupported repository metadata fails without fallback or source changes", t => {
	for (const kind of ["shallow", "alternates", "grafts", "replacement", "sparse", "partial", "shared", "linked-objects"]) {
		const f = fixture(t);
		if (kind === "shallow") writeFileSync(join(f.source, ".git/shallow"), f.baseline + "\n");
		if (kind === "alternates") { mkdirSync(join(f.source, ".git/objects/info"), { recursive: true }); writeFileSync(join(f.source, ".git/objects/info/alternates"), join(f.root, "unavailable") + "\n"); }
		if (kind === "grafts") { mkdirSync(join(f.source, ".git/info"), { recursive: true }); writeFileSync(join(f.source, ".git/info/grafts"), f.baseline + "\n"); }
		if (kind === "replacement") f.git("update-ref", `refs/replace/${f.baseline}`, f.baseline);
		if (kind === "sparse") { f.git("config", "core.sparseCheckout", "true"); f.put(".git/info/sparse-checkout", "synthetic sparse marker: do not read\n"); }
		if (kind === "partial") { f.git("config", "extensions.partialClone", "origin"); f.put(".git/objects/pack/synthetic.promisor", "synthetic partial marker: do not read\n"); }
		if (kind === "shared") f.put(".git/commondir", "synthetic shared marker: do not read\n");
		if (kind === "linked-objects") {
			if (process.platform === "win32") continue;
			const prefix = f.baseline.slice(0, 2), directory = join(f.source, ".git/objects", prefix);
			// Move only synthetic object bytes, never a real repository object.
			for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
			rmSync(directory, { recursive: true });
			symlinkSync(f.root, directory, "dir");
		}
		const before = f.snapshot();
		f.rejected(f.prepare({}, { audit: true }), /unsupported/);
		assert.deepEqual(f.snapshot(), before);
	}
});

test("S8: scratch isolation, occupied scratch and unknown plan fields retain fail-closed behavior", t => {
	const f = fixture(t), before = f.snapshot(), occupied = mkdtempSync(join(f.root, "occupied-"));
	writeFileSync(join(occupied, "keep"), "keep\n");
	f.rejected(f.prepare({}, { scratch: occupied }), /scratch must be an empty real directory/);
	assert.equal(readFileSync(join(occupied, "keep"), "utf8"), "keep\n");
	const nested = join(f.source, "scratch"); mkdirSync(nested);
	f.rejected(f.prepare({}, { scratch: nested }), /scratch must be an empty real directory/);
	for (const overrides of [{ runtimeArtifacts: [] }, { unexpected: true }, { mode: "unknown" }]) {
		f.rejected(f.prepare(overrides), /expected source|unsupported selective plan/);
	}
	assert.deepEqual(f.snapshot(), before);
});

test("S7: junction/directory-link ancestors are rejected without target reads on this platform", t => {
	const f = fixture(t);
	writeFileSync(join(f.root, "outside.txt"), "synthetic outside sentinel\n");
	symlinkSync(f.root, join(f.source, "alias"), process.platform === "win32" ? "junction" : "dir");
	const before = f.snapshot();
	f.rejected(f.prepare({ include: ["alias/outside.txt"] }, { audit: true }), /unsupported linked input/);
	assert.deepEqual(f.snapshot(), before);
	if (existsSync(f.log)) assert.doesNotMatch(readFileSync(f.log, "utf8"), /"read":/, "path rejection precedes all source content reads");
});

test("S3/S4: absence beneath a baseline nontree uses metadata, never that unselected blob body", t => {
	const f = fixture(t);
	unlinkSync(join(f.source, "unrelated-tracked.txt"));
	f.put("unrelated-tracked.txt/child.md", "new child beneath former baseline file\n");
	const before = f.snapshot(), result = f.prepare({ include: ["unrelated-tracked.txt/child.md"] }, { audit: true });
	verifyEvidence(f, result);
	assert.deepEqual(result.receipt.selected[0].baseline, { status: "absent", proof: [f.tree] });
	assert.deepEqual(f.snapshot(), before);
});

test("S3: nonaccess instrumentation detects an actual disallowed content open, not just an omitted copy", t => {
	const f = fixture(t), before = f.snapshot();
	f.rejected(f.prepare({}, { audit: true, allowCandidates: [] }), /AUDIT prohibited content read docs/);
	assert.match(readFileSync(f.log, "utf8"), /"forbidden":"content read docs/);
	assert.deepEqual(f.snapshot(), before);
});

test("S8/S9: controlled capacity, deadline and metadata-scan failures leave zero probes and exact unrun checks", t => {
	for (const [resource, reason] of [
		["capacity", /insufficient scratch capacity/],
		["deadline", /preparation deadline exceeded \(60000ms\)/],
		["metadata", /metadata exceeds preparation limit \(20000 pack-directory entries\)/],
	] as const) {
		const f = fixture(t), before = f.snapshot();
		f.rejected(f.prepare({}, { audit: true, resource }), reason);
		assert.deepEqual(f.snapshot(), before);
		if (resource === "metadata") assert.match(readFileSync(f.log, "utf8"), /"closed":"synthetic-pack-directory"/);
	}
});

test("S4/S7: selected baseline links, directories and submodules are unsupported without reading their bodies", t => {
	for (const kind of ["link", "directory", "submodule"]) {
		const f = fixture(t);
		let include = [f.selected[0]];
		if (kind === "link") {
			const blob = f.git("rev-parse", "HEAD:docs/selected [x].md");
			f.git("update-index", "--cacheinfo", `120000,${blob},${f.selected[0]}`);
		} else if (kind === "submodule") {
			f.git("update-index", "--add", "--cacheinfo", `160000,${f.baseline},module`);
			f.put("module/child.md", "synthetic independent candidate\n"); include = ["module/child.md"];
		} else {
			include = ["docs"]; // Candidate replaces the committed directory.
			unlinkSync(join(f.source, f.selected[0])); rmSync(join(f.source, "docs"), { recursive: true });
			f.put("docs", "regular candidate replacing baseline directory\n");
		}
		f.git("commit", "-qm", "synthetic unsupported baseline");
		const baseline = f.git("rev-parse", "HEAD"), tree = f.git("rev-parse", "HEAD^{tree}");
		f.allowedObjects.add(baseline); f.allowedObjects.add(tree);
		if (kind !== "directory" && kind !== "submodule") f.allowedObjects.add(f.git("rev-parse", "HEAD:docs"));
		const before = f.snapshot();
		f.rejected(f.prepare({ include, baseline }, { audit: true }), /unsupported selected baseline input: regular file required/);
		assert.deepEqual(f.snapshot(), before);
	}
});

test("S10: both documented selective CLI plans produce the described snapshot receipt", t => {
	const f = fixture(t), before = f.snapshot();
	for (const path of ["../assets/agents/gentle-ai-verify.md", "../docs/delegated-verification.md"]) {
		const text = readFileSync(new URL(path, import.meta.url), "utf8");
		const example = text.match(/'(\{"mode":"selective"[^']+\})'/)?.[1];
		assert.ok(example, `missing selective CLI plan in ${path}`);
		const plan = JSON.parse(example.replace("full-commit-object-id", f.baseline));
		verifyEvidence(f, f.prepare(plan, { audit: true }));
		assert.deepEqual(f.snapshot(), before);
	}
});

test("S8: source configured hooks/fsmonitor and ambient Git variables never execute or redirect", t => {
	const f = fixture(t), marker = join(f.root, "configured-command-ran"), monitor = join(f.root, "monitor.cjs");
	writeFileSync(monitor, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`);
	f.git("config", "core.fsmonitor", `node "${monitor.replaceAll("\\", "/")}"`);
	f.git("config", "core.hooksPath", f.root);
	const before = f.snapshot();
	const previous = process.env.GIT_INDEX_FILE;
	process.env.GIT_INDEX_FILE = join(f.root, "must-not-create-index");
	try { verifyEvidence(f, f.prepare({}, { audit: true })); }
	finally { if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous; }
	assert.equal(existsSync(marker), false);
	assert.equal(existsSync(join(f.root, "must-not-create-index")), false);
	assert.deepEqual(f.snapshot(), before);
});
