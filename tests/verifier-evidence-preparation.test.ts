import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../scripts/prepare-verifier.mjs", import.meta.url));
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const gitId = (type: string, bytes: Buffer, algorithm: string) => createHash(algorithm).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
const unavailable = "evidence object missing";

function fixture(t: any, algorithm = "sha1") {
	const root = mkdtempSync(join(tmpdir(), "gentle-evidence-")), source = join(root, "source"), evidenceRoot = join(root, "package");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const put = (base: string, path: string, bytes: string | Buffer) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), bytes); };
	const objects: { oid: string; type: string; bytes: number; sha256: string; file: string }[] = [];
	const raw = new Map<string, Buffer>();
	const object = (type: string, body: string | Buffer) => {
		const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body), oid = gitId(type, bytes, algorithm);
		objects.push({ oid, type, bytes: bytes.length, sha256: digest(bytes), file: `objects/${oid}` });
		put(evidenceRoot, `objects/${oid}`, bytes); raw.set(oid, bytes); return oid;
	};
	const entry = (mode: string, name: string, oid: string) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]);
	const original = Buffer.from("authentic original document\n"), blob = object("blob", original);
	const directoryTree = object("tree", entry("100644", "promptFrontend.md", blob));
	const excluded = gitId("blob", Buffer.from("excluded synthetic body\n"), algorithm);
	const rootTree = object("tree", Buffer.concat([entry("40000", "docs", directoryTree), entry("100644", "sibling.txt", excluded)]));
	const baseline = object("commit", `tree ${rootTree}\nauthor Fixture <f@example.invalid> 0 +0000\ncommitter Fixture <f@example.invalid> 0 +0000\n\nsynthetic baseline\n`);
	const selected = ["docs/promptFrontend.md", "odd/tasks/pagebuilder-view.md"], checks = ["exact authorized documentary comparison", "second unrun command"];
	const manifest: any = { purpose: "selected documentary baseline evidence", baselineCommit: baseline, path: selected[0], rootTree, directoryTree, blob, fileMode: "100644", contentSha256: digest(original), objects };
	const save = () => put(evidenceRoot, "manifest.json", JSON.stringify(manifest) + "\n");
	save();
	put(evidenceRoot, `objects/${excluded}`, "excluded synthetic body\n");
	put(evidenceRoot, "promptFrontend.original.md", "unauthenticated convenience copy: must never be opened\n");
	put(source, selected[0], "intentionally modified candidate document\n");
	put(source, selected[1], "untracked tracker snapshot\n");
	put(source, "unrelated.txt", "unrelated synthetic source sentinel\n");
	// These are synthetic sentinels, never credentials or a real Git database.
	put(source, ".git/config", "synthetic configuration: forbidden\n");
	put(source, ".git/index", "synthetic staging index: forbidden\n");
	const snapshot = () => {
		const result: Record<string, string> = {};
		const visit = (base: string, prefix: string) => {
			for (const ent of readdirSync(base, { withFileTypes: true })) {
				const absolute = join(base, ent.name), name = prefix + ent.name;
				if (ent.isDirectory()) visit(absolute, name + "/");
				else if (ent.isFile()) result[name] = digest(readFileSync(absolute));
				else result[name] = "nonregular";
			}
		};
		visit(source, "source/"); visit(evidenceRoot, "evidence/"); return result;
	};
	const audit = join(root, "audit.cjs"), log = join(root, "audit.jsonl");
	writeFileSync(audit, `
const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
const original={...fs}, source=${JSON.stringify(source)}, evidence=process.env.AUDIT_EVIDENCE_ROOT || ${JSON.stringify(evidenceRoot)}, log=${JSON.stringify(log)};
const candidates=new Set(JSON.parse(process.env.AUDIT_CANDIDATES));
const allowed=new Set(${JSON.stringify(["manifest.json", ...objects.map(o => o.file)])});
for(const file of JSON.parse(process.env.AUDIT_DENY_EVIDENCE || '[]')) allowed.delete(file);
const record=e=>original.appendFileSync(log,JSON.stringify(e)+'\\n');
const forbidden=reason=>{record({forbidden:reason}); throw new Error('AUDIT prohibited '+reason);};
let mutated=false;
const relative=(base,file)=>path.relative(base,path.resolve(String(file))).split(path.sep).join('/');
const internal=rel=>rel==='' || (!rel.startsWith('../') && !path.isAbsolute(rel));
const check=file=>{
 if(typeof file!=='string') return;
 const s=relative(source,file), e=relative(evidence,file);
 if(internal(s) && !candidates.has(s)) forbidden('source content '+s);
 if(internal(e) && !allowed.has(e)) forbidden('evidence content '+e);
 if(internal(s)||internal(e)) record({read:internal(s)?'source/'+s:'evidence/'+e});
 if(!mutated && e===${JSON.stringify(`objects/${baseline}`)} && process.env.AUDIT_MUTATE==='candidate') {
  mutated=true; original.writeFileSync(path.join(source,${JSON.stringify(selected[1])}),'controlled candidate drift\\n');
 }
 if(!mutated && e===${JSON.stringify(`objects/${blob}`)} && ['evidence','manifest'].includes(process.env.AUDIT_MUTATE)) {
  mutated=true;
  original.writeFileSync(path.join(evidence,process.env.AUDIT_MUTATE==='manifest'?'manifest.json':${JSON.stringify(`objects/${baseline}`)}),'controlled evidence drift\\n');
 }
};
for(const name of ['openSync','readFileSync','createReadStream','copyFileSync','cpSync']) fs[name]=function(file,...args){check(file); return original[name].call(this,file,...args);};
for(const name of ['lstatSync','realpathSync']) fs[name]=function(file,...args){
 const rel=relative(source,file);
 if(rel==='.git'||rel.startsWith('.git/')) forbidden('source Git metadata '+rel);
 const result=original[name].call(this,file,...args);
 if(name==='lstatSync' && rel===${JSON.stringify(selected[0])} && process.env.AUDIT_RESOURCE==='payload') result.size=256*1024*1024+1;
 if(name==='lstatSync' && relative(evidence,file)===${JSON.stringify(`objects/${baseline}`)} && process.env.AUDIT_RESOURCE==='metadata') result.size=16*1024*1024+1;
 return result;
};
for(const name of ['readdirSync','opendirSync']) fs[name]=function(file,...args){
 if(internal(relative(source,file))||internal(relative(evidence,file))) forbidden('enumeration');
 return original[name].call(this,file,...args);
};
for(const name of ['execFileSync','spawnSync','execSync','exec','execFile','spawn','fork']) cp[name]=function(){forbidden('subprocess '+name);};
if(process.env.AUDIT_RESOURCE==='capacity') fs.statfsSync=()=>({bavail:0,bsize:4096,ffree:0});
if(process.env.AUDIT_RESOURCE==='deadline'){let ticks=0; Object.defineProperty(performance,'now',{value:()=>ticks++?60001:0});}
require('node:module').syncBuiltinESMExports();
`);
	const run = (overrides: Record<string, any> = {}, options: { mutate?: string; resource?: string; allow?: string[]; denyEvidence?: string[]; scratch?: string; audit?: boolean; source?: string } = {}) => {
		const scratch = options.scratch ?? mkdtempSync(join(root, "scratch-"));
		const plan = { mode: "evidence", evidenceRoot, include: selected, baseline, checks, ...overrides };
		const before = snapshot();
		const result = spawnSync(process.execPath, [...(options.audit === false ? [] : ["--require", audit]), helper, options.source ?? source, scratch, JSON.stringify(plan)], {
			env: { ...process.env, NODE_OPTIONS: "", AUDIT_CANDIDATES: JSON.stringify(options.allow ?? selected), AUDIT_MUTATE: options.mutate ?? "", AUDIT_RESOURCE: options.resource ?? "", AUDIT_DENY_EVIDENCE: JSON.stringify(options.denyEvidence ?? []), AUDIT_EVIDENCE_ROOT: plan.evidenceRoot ?? evidenceRoot },
			encoding: "utf8", timeout: 70_000, maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.stderr, "");
		const receipt = JSON.parse(result.stdout);
		assert.equal(result.stdout, JSON.stringify(receipt) + "\n"); assert.equal(receipt.probesRun, 0);
		const after = snapshot();
		const mutated = options.mutate === "candidate" ? `source/${selected[1]}` : options.mutate === "evidence" ? `evidence/objects/${baseline}` : options.mutate === "manifest" ? "evidence/manifest.json" : undefined;
		if (mutated && before[mutated] !== after[mutated]) { delete before[mutated]; delete after[mutated]; }
		assert.deepEqual(after, before, "all source/evidence bytes unchanged except explicitly controlled external mutation");
		assert.equal(existsSync(join(source, "probe-ran")), false); assert.equal(existsSync(join(scratch, "probe-ran")), false);
		return { result, receipt, scratch, plan };
	};
	const reject = (r: ReturnType<typeof run>, reason: RegExp) => {
		assert.equal(r.result.status, 1); assert.equal(r.receipt.status, "setup-failed"); assert.match(r.receipt.reason, reason);
		assert.deepEqual(r.receipt.unrunChecks, checks); assert.equal(r.receipt.work, undefined); assert.equal(r.receipt.baselineWork, undefined);
	};
	const events = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
	return { root, source, evidenceRoot, selected, checks, baseline, rootTree, directoryTree, blob, excluded, original, objects, raw, manifest, save, put, object, entry, run, reject, events, snapshot };
}

function verify(f: ReturnType<typeof fixture>, r: ReturnType<ReturnType<typeof fixture>["run"]>, algorithm = "sha1") {
	assert.equal(r.result.status, 0, r.receipt.reason);
	const receipt = r.receipt;
	assert.equal(receipt.status, "ready"); assert.equal(receipt.mode, "evidence");
	assert.equal(receipt.provenance, "source-worktree-snapshot"); assert.equal(receipt.gitSemantics, "none");
	assert.equal(receipt.baseline.commit, f.baseline); assert.equal(receipt.baseline.tree, f.rootTree); assert.equal(receipt.baseline.objectFormat, algorithm);
	assert.equal(receipt.head, undefined); assert.equal(receipt.index, undefined); assert.equal(receipt.unrunChecks, undefined);
	assert.equal(receipt.evidence.provenance, "authenticated-external-object-bodies");
	assert.equal(receipt.evidence.exporterNonaccess, "not-established");
	assert.equal(receipt.evidence.manifestSha256, digest(readFileSync(join(f.evidenceRoot, "manifest.json"))));
	assert.equal(receipt.evidence.objectCount, 4);
	assert.equal(receipt.evidence.rawObjectBytes, f.objects.reduce((n, o) => n + o.bytes, 0));
	assert.equal(receipt.evidence.manifestBytes, readFileSync(join(f.evidenceRoot, "manifest.json")).length);
	assert.deepEqual(receipt.selected.map((e: any) => e.path), f.selected);
	for (const selected of receipt.selected) {
		const bytes = readFileSync(join(receipt.work, selected.path));
		assert.deepEqual(bytes, readFileSync(join(f.source, selected.path)));
		assert.deepEqual(selected.candidate, { provenance: "source-worktree-snapshot", sha256: digest(bytes), bytes: bytes.length });
	}
	const present = receipt.selected[0].baseline, absent = receipt.selected[1].baseline;
	assert.deepEqual(present, { status: "present", proof: [f.rootTree, f.directoryTree], blob: f.blob, mode: "100644", sha256: digest(f.original), bytes: f.original.length });
	assert.deepEqual(readFileSync(join(receipt.baselineWork, f.selected[0])), f.original);
	assert.deepEqual(absent, { status: "absent", proof: [f.rootTree] });
	assert.equal(existsSync(join(receipt.baselineWork, f.selected[1])), false);
	const proofs = new Map<string, Buffer>();
	for (const o of receipt.baseline.objects) {
		const body = readFileSync(join(r.scratch, o.file));
		assert.equal(gitId(o.type, body, algorithm), o.oid); assert.equal(o.bytes, body.length); proofs.set(o.oid, body);
	}
	assert.equal(proofs.size, 3);
	assert.ok(proofs.get(f.baseline)!.toString().startsWith(`tree ${f.rootTree}\n`));
	assert.deepEqual(proofs.get(f.rootTree), f.raw.get(f.rootTree)); assert.deepEqual(proofs.get(f.directoryTree), f.raw.get(f.directoryTree));
	assert.equal(gitId("blob", readFileSync(join(receipt.baselineWork, f.selected[0])), algorithm), f.blob);
	assert.equal(receipt.fileCount, 3);
	assert.equal(receipt.payloadBytes, f.original.length + f.selected.reduce((n, p) => n + readFileSync(join(f.source, p)).length, 0));
	assert.equal(receipt.metadataBytes, [...proofs.values()].reduce((n, b) => n + b.length, 0));
	assert.equal(receipt.repositoryMetadataBytes, 0);
	assert.ok(receipt.durationMs >= 0 && receipt.durationMs < 60_000);
	assert.equal(existsSync(join(receipt.work, ".git")), false); assert.equal(existsSync(join(receipt.baselineWork, ".git")), false);
	assert.deepEqual(readdirSync(r.scratch).sort(), ["baseline", "evidence", "work"]);
	assert.equal(f.events().some(e => e.forbidden), false);
}

test("S13: authentic raw SHA1/SHA256 packages bind modified document and absent untracked tracker without source Git access", t => {
	for (const algorithm of ["sha1", "sha256"]) { const f = fixture(t, algorithm); verify(f, f.run(), algorithm); }
});

test("S13: source Git object store may be absent; convenience baseline copy is never trusted", t => {
	const f = fixture(t); rmSync(join(f.source, ".git"), { recursive: true }); verify(f, f.run());
	assert.equal(existsSync(join(f.source, ".git")), false);
	assert.equal(f.events().some(e => /original\.md|sibling/.test(e.read ?? "")), false);
});

test("S13: audit negative control rejects an actual excluded candidate open before reading", t => {
	const f = fixture(t); f.reject(f.run({}, { allow: [] }), /AUDIT prohibited source content docs\/promptFrontend\.md/);
	assert.ok(f.events().some(e => e.forbidden));
});

test("S13: raw-object audit negative control rejects an actual object open before reading", t => {
	const f = fixture(t); f.reject(f.run({}, { denyEvidence: [`objects/${f.blob}`] }), /AUDIT prohibited evidence content objects\//);
	assert.ok(f.events().some(e => e.forbidden));
});

test("S13: absence beneath a baseline nontree never reads that sibling blob", t => {
	const f = fixture(t); f.selected[1] = "sibling.txt/child.md";
	f.put(f.source, f.selected[1], "new child beneath a baseline blob\n"); verify(f, f.run());
});

test("S13 PRESERVE: evidenceRoot is not silently accepted by default or loose-selective plans", t => {
	const f = fixture(t);
	f.reject(f.run({ mode: undefined }), /^expected source, fresh scratch, and \{include, checks, baseline\?, runtimeArtifacts\?\} plan$/);
	f.reject(f.run({ mode: "selective" }), /^unsupported selective plan: expected \{mode: 'selective', include, checks, baseline\}$/);
});

test("S13: missing, abbreviated and wrong pinned commits cannot authenticate the package", t => {
	const f = fixture(t);
	for (const baseline of [undefined, "HEAD", f.baseline.slice(0, 8), "f".repeat(40)]) f.reject(f.run({ baseline }), /baseline must be a full commit object ID|evidence baseline mismatch/);
});

test("S13: tampered raw commit, tree and selected blob fail canonical Git identity checks", t => {
	for (const kind of ["commit", "tree", "blob"]) {
		const f = fixture(t), descriptor = f.objects.find(o => o.type === kind)!;
		const bytes = Buffer.from(f.raw.get(descriptor.oid)!); bytes[bytes.length - 1] ^= 1;
		f.put(f.evidenceRoot, descriptor.file, bytes);
		// Recomputed manifest hashes cannot forge the pinned Git identity.
		descriptor.sha256 = digest(bytes); f.save(); f.reject(f.run(), /Git object identity mismatch/);
	}
});

test("S13: every manifest linkage claim is cross-checked, not used to authorize unrelated body reads", t => {
	for (const [field, value] of [["rootTree", "f".repeat(40)], ["directoryTree", "f".repeat(40)], ["blob", "f".repeat(40)], ["fileMode", "100755"], ["path", "unrelated.txt"], ["contentSha256", "f".repeat(64)], ["purpose", ""]]) {
		const f = fixture(t); f.manifest[field as string] = value; f.save(); f.reject(f.run(), /invalid evidence manifest|evidence .*mismatch/);
		assert.equal(f.events().some(e => e.forbidden), false);
	}
});

test("S13: duplicate, unneeded, unsafe and conflicting object descriptors reject without excluded reads", t => {
	for (const kind of ["duplicate", "extra", "traversal", "absolute", "type", "length", "hash", "field"]) {
		const f = fixture(t), o = f.manifest.objects[0];
		if (kind === "duplicate") f.manifest.objects.push({ ...o });
		if (kind === "extra") f.manifest.objects.push({ oid: f.excluded, type: "blob", bytes: 24, sha256: "f".repeat(64), file: `objects/${f.excluded}` });
		if (kind === "traversal") o.file = "../source/unrelated.txt";
		if (kind === "absolute") o.file = join(f.source, "unrelated.txt");
		if (kind === "type") f.manifest.objects.find((x: any) => x.oid === f.baseline).type = "blob";
		if (kind === "length") o.bytes++;
		if (kind === "hash") o.sha256 = "f".repeat(64);
		if (kind === "field") o.extra = true;
		f.save(); f.reject(f.run(), /duplicate evidence object|unneeded evidence object|invalid evidence object|evidence object (type|length|SHA256) mismatch/);
		assert.equal(f.events().some(e => e.forbidden), false);
	}
});

test("S13: missing descriptor/file is not confused with tree-proven tracker absence", t => {
	for (const kind of ["descriptor", "file"]) {
		const f = fixture(t);
		if (kind === "descriptor") f.manifest.objects = f.objects.filter(o => o.oid !== f.blob);
		else unlinkSync(join(f.evidenceRoot, `objects/${f.blob}`));
		f.save(); f.reject(f.run(), new RegExp(unavailable));
	}
});

test("S13: malformed, duplicate-key, oversized and excessive-count manifests fail closed", t => {
	for (const kind of ["invalid", "duplicate-key", "oversized", "count", "unknown"]) {
		const f = fixture(t);
		if (kind === "invalid") f.put(f.evidenceRoot, "manifest.json", "{");
		if (kind === "duplicate-key") f.put(f.evidenceRoot, "manifest.json", JSON.stringify(f.manifest).replace('{"purpose":', '{"purpose":"conflict","purpose":'));
		if (kind === "oversized") truncateSync(join(f.evidenceRoot, "manifest.json"), 1024 * 1024 + 1);
		if (kind === "count") { f.manifest.objects = Array.from({ length: 20_001 }, () => ({})); f.save(); }
		if (kind === "unknown") { f.manifest.unexpected = true; f.save(); }
		f.reject(f.run(), /invalid evidence manifest|duplicate evidence JSON key|evidence manifest exceeds|evidence object count exceeds/);
	}
});

test("S13: candidate allowlist and evidence root are explicit, exact, and nonoverlapping", t => {
	const f = fixture(t);
	for (const overrides of [{ include: [] }, { include: [f.selected[0], f.selected[0]] }, { include: ["../unrelated.txt"] }, { include: [".git/config"] }, { include: ["docs"] }, { include: ["missing.md"] }, { evidenceRoot: undefined }, { evidenceRoot: f.source }, { runtimeArtifacts: [] }]) {
		f.reject(f.run(overrides), /selective include|unsupported input path|regular file required|required input missing|evidence root|unsupported evidence plan|source and evidence/);
	}
});

test("S13: directory, junction and linked ancestor inputs fail without target reads", t => {
	for (const kind of ["candidate-directory", "candidate-junction", "evidence-junction", "objects-junction", "manifest-directory"]) {
		const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
		let overrides = {};
		if (kind === "candidate-directory") { unlinkSync(join(f.source, f.selected[0])); mkdirSync(join(f.source, f.selected[0])); }
		if (kind === "candidate-junction") {
			const alias = join(f.source, "alias"); symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir"); overrides = { include: ["alias/forbidden.md"] };
		}
		if (kind === "evidence-junction") { const alias = join(f.root, "package-alias"); symlinkSync(f.evidenceRoot, alias, process.platform === "win32" ? "junction" : "dir"); overrides = { evidenceRoot: alias }; }
		if (kind === "objects-junction") {
			// A separate empty package uses an object-directory junction; never
			// move or chmod any existing object or the historical failed fixture.
			const other = join(f.root, "linked-package"); mkdirSync(other); writeFileSync(join(other, "manifest.json"), JSON.stringify(f.manifest));
			symlinkSync(join(f.evidenceRoot, "objects"), join(other, "objects"), process.platform === "win32" ? "junction" : "dir"); overrides = { evidenceRoot: other };
		}
		if (kind === "manifest-directory") { unlinkSync(join(f.evidenceRoot, "manifest.json")); mkdirSync(join(f.evidenceRoot, "manifest.json")); }
		f.reject(f.run(overrides), /unsupported linked input|regular file required/);
	}
});

test("S13: a linked candidate source root is rejected before content access", t => {
	const f = fixture(t), alias = join(f.root, "source-alias");
	symlinkSync(f.source, alias, process.platform === "win32" ? "junction" : "dir");
	f.reject(f.run({}, { source: alias }), /unsupported linked input/);
});

test("S13: candidate, object and manifest changes during preparation fail rather than masquerade as intentional differences", t => {
	for (const mutate of ["candidate", "evidence", "manifest"]) {
		const f = fixture(t); f.reject(f.run({}, { mutate }), /input changed during preparation/);
	}
});

test("S13: aggregate payload, metadata, capacity and checked deadline remain bounded", t => {
	for (const resource of ["payload", "metadata", "capacity", "deadline"]) {
		const f = fixture(t); f.reject(f.run({}, { resource }), /payload exceeds preparation limit|metadata exceeds preparation limit|insufficient scratch capacity|preparation deadline exceeded/);
	}
	for (const type of ["commit", "blob"]) {
		const f = fixture(t); f.objects.find(o => o.type === type)!.bytes = (type === "commit" ? 16 : 256) * 1024 * 1024 + 1; f.save();
		f.reject(f.run(), /evidence object exceeds preparation limit/);
	}
});

test("S13: scratch must be empty, real, outside both source and evidence", t => {
	for (const where of ["source", "evidence", "occupied", "linked"]) {
		const f = fixture(t), base = where === "source" ? f.source : where === "evidence" ? f.evidenceRoot : f.root;
		let scratch = join(base, "invalid-scratch"); mkdirSync(scratch);
		if (where === "occupied") writeFileSync(join(scratch, "keep"), "keep\n");
		if (where === "linked") { const alias = join(f.root, "scratch-alias"); symlinkSync(scratch, alias, process.platform === "win32" ? "junction" : "dir"); scratch = alias; }
		f.reject(f.run({}, { scratch }), /scratch must be an empty real directory/);
		if (where === "occupied") assert.equal(readFileSync(join(scratch, "keep"), "utf8"), "keep\n");
	}
});

test("S13: both consumed evidence CLI examples use the authenticated route", t => {
	for (const path of ["../assets/agents/gentle-ai-verify.md", "../docs/delegated-verification.md"]) {
		const f = fixture(t), text = readFileSync(new URL(path, import.meta.url), "utf8");
		const example = text.match(/'(\{"mode":"evidence"[^']+\})'/)?.[1]; assert.ok(example, `missing evidence CLI plan in ${path}`);
		const plan = JSON.parse(example.replace("full-commit-object-id", f.baseline)); plan.evidenceRoot = f.evidenceRoot; plan.include = f.selected;
		verify(f, f.run(plan));
	}
});
