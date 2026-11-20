import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
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
	const prepare = (include: string[], scratch = mkdtempSync(join(root, "copy-")), runtimeArtifacts: string[] = [], requestedBaseline = baseline) => {
		const result = spawnSync(process.execPath, [fileURLToPath(helper), source, scratch,
			JSON.stringify({ include, baseline: requestedBaseline, runtimeArtifacts, checks: ["node probe.cjs"] })], { env, encoding: "utf8" });
		return { ...result, scratch, work: join(scratch, "work"), receipt: result.stdout ? JSON.parse(result.stdout) : undefined };
	};
	return { root, source, git, baseline, snapshot, prepare };
}

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

// gentle-shell#3401: the sensitive-path policy governs what the preparer stages.
const addTracked = (f: ReturnType<typeof fixture>, files: Record<string, string>) => {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(f.source, path, ".."), { recursive: true });
		writeFileSync(join(f.source, path), text);
		f.git("add", "-f", "--", path);
	}
};
const refused = (result: ReturnType<ReturnType<typeof fixture>["prepare"]>, reason: string) => {
	assert.equal(result.status, 1);
	assert.equal(result.receipt.status, "setup-failed");
	assert.equal(result.receipt.reason, reason);
	assert.equal(result.receipt.probesRun, 0);
	assert.deepEqual(readdirSync(result.scratch), [], "refusal happens before any clone or copy");
};

test("#3401 S3: tracked sensitive files prepare ready, are skipped, reported, and leave HEAD and status intact", t => {
	const f = fixture(t);
	addTracked(f, { ".env": "DUMMY=1\n", "auth.json": "{}\n", "keys/id.pem": "dummy\n" });
	f.git("commit", "-qm", "track sensitive");
	const before = f.snapshot(), result = f.prepare([]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.receipt.status, "ready");
	assert.deepEqual(result.receipt.skippedSensitive, [".env", "auth.json", "keys/id.pem"]);
	for (const path of [".env", "auth.json", "keys/id.pem"]) assert.equal(existsSync(join(result.work, path)), false, path);
	assert.equal(result.receipt.head, f.git("rev-parse", "HEAD"));
	assert.equal(result.receipt.baseline, f.baseline);
	const work = (...args: string[]) => execFileSync("git", args, { cwd: result.work, env, encoding: "utf8" });
	assert.equal(work("rev-parse", "HEAD").trim(), result.receipt.head);
	assert.equal(work("status", "--porcelain", "--untracked-files=no"), execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: f.source, env, encoding: "utf8" }));
	assert.deepEqual(f.snapshot(), before);
});

test("#3401 S3: a repository tracking a fixture key file prepares ready (gentle-pi's own case)", t => {
	const f = fixture(t);
	addTracked(f, { "tests/fixtures/x/proxy.key": "dummy\n" });
	f.git("commit", "-qm", "track fixture key");
	const result = f.prepare([]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.receipt.status, "ready");
	assert.deepEqual(result.receipt.skippedSensitive, ["tests/fixtures/x/proxy.key"]);
	assert.equal(existsSync(join(result.work, "tests/fixtures/x/proxy.key")), false);
});

test("#3401: an ordinary repository's receipt gains only an empty skippedSensitive", t => {
	const result = fixture(t).prepare(["selected [x].cjs"]);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(Object.keys(result.receipt).sort(), ["baseline", "durationMs", "excludedRuntimeArtifacts", "fileCount", "head", "payloadBytes", "probesRun", "skippedSensitive", "status", "work"]);
	assert.deepEqual(result.receipt.skippedSensitive, []);
});

test("#3401 S4: a directory in include skips untracked and ignored sensitive files and reports them", t => {
	const f = fixture(t);
	writeFileSync(join(f.source, ".gitignore"), ".evidence/\nnode_modules/\nsub/ignored-cred.txt\nsub/.env\n");
	mkdirSync(join(f.source, "sub", "secrets"), { recursive: true });
	for (const [path, text] of [["sub/ok.txt", "ok\n"], ["sub/auth.json", "{}\n"], ["sub/.env", "DUMMY=1\n"], ["sub/ignored-cred.txt", "dummy\n"], ["sub/secrets/x.txt", "dummy\n"]]) writeFileSync(join(f.source, path), text);
	const before = f.snapshot(), result = f.prepare(["sub"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.receipt.status, "ready");
	assert.deepEqual(result.receipt.skippedSensitive, ["sub/.env", "sub/auth.json", "sub/secrets"]);
	assert.equal(readFileSync(join(result.work, "sub", "ok.txt"), "utf8"), "ok\n");
	assert.equal(readFileSync(join(result.work, "sub", "ignored-cred.txt"), "utf8"), "dummy\n");
	for (const path of ["sub/.env", "sub/auth.json", "sub/secrets"]) assert.equal(existsSync(join(result.work, path)), false, path);
	assert.deepEqual(f.snapshot(), before);
	assert.deepEqual(f.prepare(["selected [x].cjs"]).receipt.skippedSensitive, []);
});

for (const named of [[".env"], ["sub/.env"], ["sub/secrets"], ["selected [x].cjs", "sub/auth.json"]]) {
	test(`#3401 S5: naming a sensitive path in include is refused: ${named.join(",")}`, t => {
		const f = fixture(t);
		mkdirSync(join(f.source, "sub", "secrets"), { recursive: true });
		for (const path of ["sub/.env", "sub/auth.json", ".env"]) writeFileSync(join(f.source, path), "DUMMY=1\n");
		const bad = named.filter(path => /\.env$|auth\.json$|secrets$/.test(path)), before = f.snapshot();
		refused(f.prepare(named), `include names sensitive paths: ${JSON.stringify(bad)}. Remove them from include and re-run the preparer, or verify that check without the isolated preparer`);
		assert.deepEqual(f.snapshot(), before);
	});
}

test("#3401 S6: a sensitive file present only in Git history is staged as history, not as a file (pinned)", t => {
	// The clone transfers reachable objects so HEAD and the baseline keep their
	// identity; rewriting history would break the receipt's head/baseline contract.
	// Only the working tree and index are governed by the policy.
	const f = fixture(t);
	addTracked(f, { ".env": "DUMMY=1\n" });
	f.git("commit", "-qm", "add env");
	f.git("rm", "-q", "--cached", "--", ".env");
	f.git("commit", "-qm", "remove env");
	const result = f.prepare([]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(result.work, ".env")), false);
	assert.equal(execFileSync("git", ["log", "--all", "--name-only", "--format="], { cwd: result.work, env, encoding: "utf8" }).split("\n").includes(".env"), true);
});
