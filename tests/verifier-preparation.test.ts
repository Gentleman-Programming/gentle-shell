import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = new URL("../scripts/prepare-verifier.mjs", import.meta.url);
const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "gentle-verifier-prep-")), source = join(root, "source");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(source);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env, encoding: "utf8" }).trim();
	git("init", "-q");
	git("config", "user.name", "Preparation fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "core.autocrlf", "false");
	writeFileSync(join(source, ".gitignore"), ".evidence/\nnode_modules/\n");
	writeFileSync(join(source, "app.cjs"), "module.exports = 1;\n");
	writeFileSync(join(source, "deleted.txt"), "base\n");
	writeFileSync(join(source, "probe.cjs"), "if(require('./app.cjs')!==3 || require('./selected [x].cjs')!==7 || require('local-dep')!==42) process.exit(1);\n");
	git("add", "."); git("commit", "-qm", "base");
	const baseline = git("rev-parse", "HEAD");
	writeFileSync(join(source, "app.cjs"), "module.exports = 2;\n");
	git("add", "app.cjs");
	writeFileSync(join(source, "app.cjs"), "module.exports = 3;\n");
	git("rm", "deleted.txt");
	writeFileSync(join(source, "staged.md"), "public\n"); git("add", "staged.md");
	writeFileSync(join(source, "selected [x].cjs"), "module.exports = 7;\n");
	mkdirSync(join(source, ".evidence"));
	writeFileSync(join(source, ".evidence", "private.md"), "unpublished /home/example/private\n");
	mkdirSync(join(source, "node_modules", "local-dep"), { recursive: true });
	writeFileSync(join(source, "node_modules", "local-dep", "index.js"), "module.exports = 42;\n");
	const snapshot = () => [git("status", "--porcelain=v1"), readFileSync(join(source, ".git", "index")).toString("hex"), readFileSync(join(source, "app.cjs"), "utf8")];
	const prepare = (include: string[], scratch = mkdtempSync(join(root, "copy-")), runtimeArtifacts: string[] = [], requestedBaseline = baseline, preload?: string) => {
		const result = spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), fileURLToPath(helper), source, scratch,
			JSON.stringify({ include, baseline: requestedBaseline, runtimeArtifacts, checks: ["node probe.cjs"] })], { env, encoding: "utf8" });
		return { ...result, scratch, work: join(scratch, "work"), receipt: result.stdout ? JSON.parse(result.stdout) : undefined };
	};
	return { root, source, git, baseline, snapshot, prepare };
}

// #3280: inspect link nodes and Git objects separately, never via dereferenced reads.
function assertPrepared(f: ReturnType<typeof fixture>, result: ReturnType<ReturnType<typeof fixture>["prepare"]>) {
	assert.equal(result.status, 0, result.receipt?.reason ?? result.stderr);
	assert.equal(result.stderr, "");
	assert.equal(result.receipt.status, "ready");
	assert.equal(result.receipt.probesRun, 0);
	for (const args of [["rev-parse", "HEAD"], ["ls-files", "--stage"], ["ls-tree", "-r", "HEAD"]]) {
		assert.equal(execFileSync("git", args, { cwd: result.work, env, encoding: "utf8" }).trim(), f.git(...args));
	}
}

function assertRejected(f: ReturnType<typeof fixture>, result: ReturnType<ReturnType<typeof fixture>["prepare"]>, before: string[]) {
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(result.receipt.status, "setup-failed");
	assert.match(result.receipt.reason, /unsupported|changed/);
	assert.equal(result.receipt.probesRun, 0);
	assert.deepEqual(result.receipt.unrunChecks, ["node probe.cjs"]);
	assert.deepEqual(f.snapshot(), before);
}

test("#3280: committed file and skill directory aliases preserve literal text and independent payload in either enumeration order", t => {
	for (const target of ["a-target", "z-target"]) {
		const f = fixture(t);
		mkdirSync(join(f.source, target));
		writeFileSync(join(f.source, target, "SKILL.md"), "committed skill\n");
		mkdirSync(join(f.source, ".agents"));
		symlinkSync(`./${target}/SKILL.md`, join(f.source, "file-alias"));
		symlinkSync(`../${target}`, join(f.source, ".agents", "skill"), "dir");
		f.git("add", target, "file-alias", ".agents/skill"); f.git("commit", "-qm", "aliases");
		writeFileSync(join(f.source, target, "SKILL.md"), "staged skill\n"); f.git("add", target);
		writeFileSync(join(f.source, target, "SKILL.md"), "working skill\n");
		writeFileSync(join(f.source, target, "excluded.txt"), "not selected\n");
		const before = f.snapshot(), result = f.prepare([".agents/skill"]);
		assertPrepared(f, result);
		for (const [path, text] of [["file-alias", `./${target}/SKILL.md`], [".agents/skill", `../${target}`]]) {
			assert.ok(lstatSync(join(result.work, path)).isSymbolicLink());
			assert.equal(readlinkSync(join(result.work, path)), text);
			assert.equal(readlinkSync(join(f.source, path)), text);
			assert.match(f.git("ls-files", "--stage", path), /^120000 /);
		}
		assert.equal(readFileSync(join(result.work, target, "SKILL.md"), "utf8"), "working skill\n");
		assert.equal(execFileSync("git", ["show", `:${target}/SKILL.md`], { cwd: result.work, env, encoding: "utf8" }), "staged skill\n");
		assert.equal(existsSync(join(result.work, target, "excluded.txt")), false);
		assert.equal(readFileSync(join(f.source, target, "SKILL.md"), "utf8"), "working skill\n");
		assert.equal(readFileSync(join(f.source, target, "excluded.txt"), "utf8"), "not selected\n");
		assert.deepEqual(f.snapshot(), before);
	}
});

test("#3280: staged and working retargets, deletions and file/link transitions retain index identity", t => {
	for (const change of ["retarget", "working-delete", "staged-delete", "link-to-file", "file-to-link", "staged-link-to-file", "staged-file-to-link"]) {
		const f = fixture(t), path = join(f.source, "alias"), initiallyFile = change.includes("file-to-link");
		if (initiallyFile) writeFileSync(path, "regular baseline\n"); else symlinkSync("app.cjs", path);
		f.git("add", "alias"); f.git("commit", "-qm", "alias baseline");
		unlinkSync(path);
		if (change === "retarget") {
			symlinkSync("probe.cjs", path); f.git("add", "alias"); unlinkSync(path); symlinkSync("./staged.md", path);
		} else if (change === "staged-delete") f.git("add", "alias");
		else if (change.includes("link-to-file")) {
			writeFileSync(path, "regular working\n");
			if (change.startsWith("staged")) f.git("add", "alias");
		} else if (initiallyFile) {
			symlinkSync("./app.cjs", path);
			if (change.startsWith("staged")) f.git("add", "alias");
		}
		const before = f.snapshot(), result = f.prepare([]);
		assertPrepared(f, result);
		if (change.endsWith("delete")) {
			assert.equal(existsSync(join(result.work, "alias")), false);
			assert.equal(existsSync(path), false);
		} else if (change.includes("link-to-file")) {
			assert.ok(lstatSync(join(result.work, "alias")).isFile());
			assert.equal(readFileSync(join(result.work, "alias"), "utf8"), "regular working\n");
			assert.equal(readFileSync(path, "utf8"), "regular working\n");
		} else {
			const expected = change === "retarget" ? "./staged.md" : "./app.cjs";
			assert.equal(readlinkSync(join(result.work, "alias")), expected);
			assert.equal(readlinkSync(path), expected);
		}
		assert.deepEqual(f.snapshot(), before);
	}
});

test("#3280: unsafe tracked links and linked ancestors fail closed without target expansion", t => {
	for (const kind of ["absolute", "escape", "git", "git-case", "dangling", "self", "pair", "ancestor-cycle", "chain", "linked-parent", "dotdot-link", "untracked-file", "untracked-dir", "deleted-target"]) {
		const f = fixture(t), alias = join(f.source, "alias");
		let target = "app.cjs";
		if (kind === "absolute") target = join(f.source, "app.cjs");
		if (kind === "escape") target = "../source/app.cjs";
		if (kind === "git") target = ".git/config";
		if (kind === "git-case") target = ".GiT/config";
		if (kind === "dangling") target = "missing";
		if (kind === "self") target = "alias";
		if (kind === "ancestor-cycle") target = ".";
		if (["pair", "chain", "linked-parent", "dotdot-link"].includes(kind)) {
			symlinkSync(kind === "pair" ? "alias" : kind === "chain" ? "app.cjs" : "node_modules/local-dep", join(f.source, "other"));
			f.git("add", "other");
			target = kind === "linked-parent" ? "other/index.js" : kind === "dotdot-link" ? "other/../app.cjs" : "other";
		}
		if (kind === "deleted-target") target = "staged.md";
		if (kind === "untracked-file") target = "selected [x].cjs";
		if (kind === "untracked-dir") target = "node_modules/local-dep";
		symlinkSync(target, alias); f.git("add", "alias");
		if (kind === "deleted-target") unlinkSync(join(f.source, "staged.md"));
		const before = f.snapshot(), result = f.prepare([]);
		assertRejected(f, result, before);
		assert.equal(existsSync(result.work), false);
		assert.equal(readlinkSync(alias), target);
	}
	const f = fixture(t);
	mkdirSync(join(f.source, "parent")); writeFileSync(join(f.source, "parent", "child"), "tracked\n");
	f.git("add", "parent/child"); unlinkSync(join(f.source, "parent", "child"));
	// Move no data through the linked ancestor, even if the destination file exists.
	rmSync(join(f.source, "parent"), { recursive: true }); symlinkSync("node_modules/local-dep", join(f.source, "parent"), "dir");
	const before = f.snapshot();
	assertRejected(f, f.prepare([]), before);
});

test("#3280: link targets may use explicit regular payload, never untracked dependency links", t => {
	const f = fixture(t);
	symlinkSync("node_modules/local-dep", join(f.source, "alias"), "dir"); f.git("add", "alias");
	const before = f.snapshot(), result = f.prepare(["node_modules/local-dep"]);
	assertPrepared(f, result);
	assert.equal(readlinkSync(join(result.work, "alias")), "node_modules/local-dep");
	assert.equal(readFileSync(join(result.work, "node_modules/local-dep/index.js"), "utf8"), "module.exports = 42;\n");
	assert.deepEqual(f.snapshot(), before);
	symlinkSync("local-dep", join(f.source, "node_modules", "linked"), "dir");
	const linkedBefore = f.snapshot();
	assertRejected(f, f.prepare(["node_modules/linked"]), linkedBefore);
});

test("#3280: source node-type and literal link-target drift fail deterministically before readiness", t => {
	for (const change of ["file-to-link", "link-to-file", "retarget", "linked-ancestor", "before-file-read", "before-link-read", "before-file-write"]) {
		const f = fixture(t), path = join(f.source, "alias"), regular = change === "file-to-link" || change.startsWith("before-file");
		if (regular) writeFileSync(path, "module.exports = 3;\n"); else symlinkSync("app.cjs", path);
		f.git("add", "alias");
		const index = readFileSync(join(f.source, ".git/index")), head = f.git("rev-parse", "HEAD");
		const preload = join(f.root, "drift.mjs");
		// Builtin interception follows the existing syncBuiltinESMExports pattern;
		// mutate at clone, after a source read, or after a destination write; no sleeps.
		const mutation = regular ? `fs.unlinkSync(path); fs.symlinkSync('app.cjs', path);` :
			change === "link-to-file" ? `fs.unlinkSync(path); fs.writeFileSync(path, 'module.exports = 3;\\n');` :
			change !== "linked-ancestor" ? `fs.unlinkSync(path); fs.symlinkSync('./app.cjs', path);` :
			`fs.renameSync(source, source + '-saved'); fs.symlinkSync(source + '-saved', source, 'dir');`;
		const atClone = change.endsWith("-read"), beforeWrite = change === "before-file-write";
		writeFileSync(preload, `import fs from 'node:fs'; import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
			const source = fs.realpathSync(${JSON.stringify(f.source)}), path = source + '/alias';
			const host = ${atClone ? "cp" : "fs"}, method = ${JSON.stringify(atClone ? "execFileSync" : beforeWrite ? "readFileSync" : regular ? "writeFileSync" : "symlinkSync")}, original = host[method];
			let armed = false, fired = false;
			const clone = cp.execFileSync;
			if (${beforeWrite}) cp.execFileSync = (...args) => { const result = clone(...args); if (args[1].includes('clone')) armed = true; return result; };
			host[method] = (...args) => { const result = original(...args);
				if (!fired && (${atClone ? "args[1].includes('clone')" : beforeWrite ? "armed && String(args[0]) === path" : "String(args[method === 'symlinkSync' ? 1 : 0]).endsWith('/work/alias')"})) { fired = true; ${mutation} }
				return result; }; syncBuiltinESMExports();`);
		const result = f.prepare([], undefined, [], f.baseline, preload);
		assert.equal(result.status, 1, `${change}: ${JSON.stringify(result.receipt)}`);
		assert.equal(result.receipt.status, "setup-failed");
		assert.match(result.receipt.reason, /changed/);
		assert.equal(result.stderr, "");
		if (change.startsWith("before-")) assert.equal(existsSync(join(result.work, "alias")), false);
		assert.equal(result.receipt.probesRun, 0);
		assert.deepEqual(result.receipt.unrunChecks, ["node probe.cjs"]);
		assert.deepEqual(readFileSync(join(f.source, ".git/index")), index);
		assert.equal(f.git("rev-parse", "HEAD"), head);
	}
});

test("#3280: submodules and conflict stages remain unsupported", t => {
	for (const conflict of [false, true]) {
		const f = fixture(t), object = f.git("rev-parse", conflict ? ":app.cjs" : "HEAD");
		execFileSync("git", ["update-index", "--index-info"], { cwd: f.source, env,
			input: conflict ? `0 ${"0".repeat(40)}\tapp.cjs\n100644 ${object} 1\tapp.cjs\n100644 ${object} 2\tapp.cjs\n` : `160000 ${object}\tmodule\n` });
		const before = f.snapshot(), result = f.prepare([]);
		assertRejected(f, result, before);
		assert.equal(existsSync(result.work), false);
	}
});

test("#3009: actual preparer preserves Git publication, baseline, index and required local inputs", t => {
	const f = fixture(t), before = f.snapshot();
	const result = f.prepare(["selected [x].cjs", "node_modules/local-dep"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.receipt.status, "ready");
	assert.ok(result.receipt.payloadBytes > 0 && result.receipt.durationMs >= 0);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: result.work, env, encoding: "utf8" }).trim();
	assert.equal(git("rev-parse", "HEAD"), f.baseline);
	assert.equal(git("ls-files"), f.git("ls-files"));
	assert.equal(git("diff", "--cached", "--binary"), f.git("diff", "--cached", "--binary"));
	assert.equal(git("show", "HEAD:app.cjs"), "module.exports = 1;");
	assert.equal(existsSync(join(result.work, ".evidence")), false);
	assert.equal(existsSync(join(result.work, "deleted.txt")), false);
	const probe = spawnSync(process.execPath, ["probe.cjs"], { cwd: result.work, encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	assert.deepEqual(f.snapshot(), before);
	writeFileSync(join(result.work, "app.cjs"), "isolated mutation\n");
	assert.deepEqual(f.snapshot(), before);
	assert.equal(existsSync(join(result.work, ".git", "objects", "info", "alternates")), false);
});

test("#3009: the documented Bash call creates its own scratch before preparation", { skip: process.platform === "win32" }, t => {
	const f = fixture(t), before = f.snapshot();
	const prompt = readFileSync(new URL("../assets/agents/gentle-ai-verify.md", import.meta.url), "utf8");
	const example = prompt.match(/`(s=\$\(mktemp -d\) && node "\$GENTLE_PI_VERIFIER_PREPARER"[^`]+)`/)?.[1];
	assert.ok(example);
	const plan = JSON.stringify({ include: ["selected [x].cjs", "node_modules/local-dep"], checks: ["node probe.cjs"], baseline: f.baseline });
	const command = example.replace(/'[^']*'$/, `'${plan}'`);
	const childEnv: NodeJS.ProcessEnv = { ...env, GENTLE_PI_VERIFIER_PREPARER: fileURLToPath(helper), TMPDIR: f.root };
	delete childEnv.s;
	const result = spawnSync("bash", ["-c", command], { cwd: f.source, env: childEnv, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).status, "ready");
	assert.deepEqual(f.snapshot(), before);
});

test("#3009: omission controls fail the actual check; oversized payload fails preparation", t => {
	const f = fixture(t);
	for (const include of [["selected [x].cjs"], ["node_modules/local-dep"]]) {
		const result = f.prepare(include);
		assert.equal(result.status, 0, result.stderr);
		assert.notEqual(spawnSync(process.execPath, ["probe.cjs"], { cwd: result.work }).status, 0);
	}
	writeFileSync(join(f.source, "large.bin"), "");
	truncateSync(join(f.source, "large.bin"), 256 * 1024 * 1024 + 1);
	const limited = f.prepare(["large.bin"]);
	assert.notEqual(limited.status, 0);
	assert.match(limited.receipt.reason, /payload exceeds preparation limit/);
	assert.equal(limited.receipt.probesRun, 0);
	assert.equal(existsSync(limited.work), false);
});

test("#3009: missing inputs and unsafe selections fail before probes and preserve source", t => {
	const f = fixture(t), before = f.snapshot();
	for (const input of ["missing-source.cjs", "node_modules/missing-dep", "../source/app.cjs", ".git/config"]) {
		const result = f.prepare([input]);
		assert.notEqual(result.status, 0);
		assert.equal(result.receipt.status, "setup-failed");
		assert.equal(result.receipt.probesRun, 0);
		assert.deepEqual(result.receipt.unrunChecks, ["node probe.cjs"]);
		assert.ok(result.receipt.reason);
		assert.equal(existsSync(result.work), false);
	}
	assert.deepEqual(f.snapshot(), before);
});

test("#3009: dependency links and nonempty scratch fail without writes", t => {
	const f = fixture(t), before = f.snapshot();
	symlinkSync(join(f.source, "node_modules", "local-dep"), join(f.source, "linked-dep"), process.platform === "win32" ? "junction" : "dir");
	const linked = f.prepare(["linked-dep"]);
	assert.notEqual(linked.status, 0);
	assert.match(linked.receipt.reason, /unsupported/);
	const scratch = mkdtempSync(join(f.root, "occupied-"));
	writeFileSync(join(scratch, "keep"), "keep\n");
	const occupied = f.prepare([], scratch);
	assert.notEqual(occupied.status, 0);
	assert.equal(readFileSync(join(scratch, "keep"), "utf8"), "keep\n");
	assert.equal(existsSync(occupied.work), false);
	assert.equal(readFileSync(join(f.source, "app.cjs"), "utf8"), before[2]);
});

test("#3009: unselected live socket is identified and excluded", { skip: process.platform === "win32" }, async t => {
	const f = fixture(t), socket = join(f.source, "daemon.sock"), server = createServer();
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
	t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
	const result = f.prepare(["selected [x].cjs", "node_modules/local-dep"], undefined, ["daemon.sock"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.receipt.excludedRuntimeArtifacts, ["daemon.sock"]);
	assert.equal(existsSync(join(result.work, "daemon.sock")), false);
	assert.ok(existsSync(socket));
});

test("#3009: tracked replacements never silently omit links or expand unselected directories", t => {
	for (const replacement of ["directory", "dangling-link"]) {
		const f = fixture(t), path = join(f.source, "app.cjs");
		unlinkSync(path);
		if (replacement === "directory") { mkdirSync(path); writeFileSync(join(path, "private-unselected.txt"), "private\n"); }
		else symlinkSync("missing-target", path);
		const index = readFileSync(join(f.source, ".git", "index"));
		const result = f.prepare([]);
		assert.notEqual(result.status, 0);
		assert.match(result.receipt.reason, /unsupported/);
		assert.equal(result.receipt.probesRun, 0);
		assert.equal(existsSync(result.work), false);
		assert.deepEqual(readFileSync(join(f.source, ".git", "index")), index);
	}
});

test("#3009: source fsmonitor cannot execute during preparation", t => {
	const f = fixture(t), marker = join(f.root, "monitor-ran"), monitor = join(f.root, "monitor.cjs");
	writeFileSync(monitor, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected execution');`);
	f.git("config", "core.fsmonitor", `node "${monitor.replaceAll("\\", "/")}"`);
	const result = f.prepare(["selected [x].cjs", "node_modules/local-dep"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(marker), false, "preparation must not execute source-configured commands");
});

test("#3009: staged non-UTF8 text and configured diff prefixes preserve the exact index", t => {
	for (const prefix of [undefined, "diff.noprefix", "diff.mnemonicPrefix"]) {
		const f = fixture(t), path = join(f.source, "latin.txt");
		writeFileSync(path, Buffer.from("base caf\xe9\n", "latin1"));
		f.git("add", "latin.txt"); f.git("commit", "-qm", "non-UTF8 baseline");
		const staged = Buffer.from("staged caf\xe9\n", "latin1"), working = Buffer.from("working caf\xe9\n", "latin1");
		writeFileSync(path, staged); f.git("add", "latin.txt"); writeFileSync(path, working);
		if (prefix) f.git("config", prefix, "true");
		const before = f.snapshot(), result = f.prepare([]);
		assert.equal(result.status, 0, result.receipt?.reason ?? result.stderr);
		assert.deepEqual(execFileSync("git", ["show", ":latin.txt"], { cwd: result.work, env }), staged);
		assert.deepEqual(readFileSync(join(result.work, "latin.txt")), working);
		assert.deepEqual(f.snapshot(), before);
		assert.deepEqual(readFileSync(path), working);
	}
});

test("#3009: a valid staged patch above 16MiB remains within the preparation payload", t => {
	const f = fixture(t), bytes = Buffer.alloc(17 * 1024 * 1024, 0x61);
	writeFileSync(join(f.source, "large-staged.txt"), bytes); f.git("add", "large-staged.txt");
	const before = f.snapshot(), staged = f.git("rev-parse", ":large-staged.txt"), result = f.prepare([]);
	assert.equal(result.status, 0, result.receipt?.reason ?? result.stderr);
	assert.equal(execFileSync("git", ["rev-parse", ":large-staged.txt"], { cwd: result.work, env, encoding: "utf8" }).trim(), staged);
	assert.deepEqual(readFileSync(join(result.work, "large-staged.txt")), bytes);
	assert.deepEqual(f.snapshot(), before);
});

test("#3009: unavailable baseline and shallow history fail without changing source", t => {
	const f = fixture(t), before = f.snapshot();
	const unavailable = f.prepare([], undefined, [], "f".repeat(40));
	assert.equal(unavailable.status, 1);
	assert.equal(unavailable.receipt.status, "setup-failed");
	assert.equal(unavailable.receipt.probesRun, 0);
	assert.deepEqual(unavailable.receipt.unrunChecks, ["node probe.cjs"]);
	assert.deepEqual(f.snapshot(), before);
	writeFileSync(join(f.source, ".git", "shallow"), f.git("rev-parse", "HEAD") + "\n");
	assert.equal(f.git("rev-parse", "--is-shallow-repository"), "true");
	const shallow = f.prepare([]);
	assert.equal(shallow.status, 1);
	assert.match(shallow.receipt.reason, /unsupported shallow/);
	assert.equal(shallow.receipt.probesRun, 0);
	assert.equal(existsSync(shallow.work), false);
	assert.deepEqual(f.snapshot(), before);
});

test("#3009: scratch permits linked ancestors but rejects the final directory link", { skip: process.platform === "win32" }, t => {
	const f = fixture(t), parent = join(f.root, "real-parent"), alias = join(f.root, "alias-parent");
	mkdirSync(parent); symlinkSync(parent, alias, "dir");
	const scratch = join(alias, "copy"); mkdirSync(scratch);
	const before = f.snapshot(), prepared = f.prepare(["selected [x].cjs", "node_modules/local-dep"], scratch);
	assert.equal(prepared.status, 0, prepared.receipt?.reason ?? prepared.stderr);
	assert.equal(prepared.receipt.work, join(realpathSync(parent), "copy", "work"));
	assert.equal(spawnSync(process.execPath, ["probe.cjs"], { cwd: prepared.work }).status, 0);
	const target = join(parent, "empty"), linked = join(f.root, "linked-scratch");
	mkdirSync(target); symlinkSync(target, linked, "dir");
	const nested = join(parent, "nested"), deepAlias = join(f.root, "deep-alias");
	mkdirSync(nested); symlinkSync(nested, deepAlias, "dir");
	symlinkSync(target, join(parent, "indirect-link"), "dir"); mkdirSync(join(f.root, "indirect-link"));
	for (const path of [linked, linked + "/", deepAlias + "/../indirect-link"]) {
		const rejected = f.prepare([], path);
		assert.equal(rejected.status, 1);
		assert.match(rejected.receipt.reason, /scratch must be an empty real directory/);
		assert.equal(rejected.receipt.probesRun, 0);
		assert.equal(existsSync(join(target, "work")), false);
	}
	assert.deepEqual(f.snapshot(), before);
});
