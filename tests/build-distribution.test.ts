import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_ASSETS, claimPrefix, distributionAsset, distributionFiles, installVersion, pnpmEnvironment, readDistribution } from "../scripts/bundled-install.mjs";
import { buildDistribution, main, verifyDistribution } from "../scripts/build-distribution.mjs";
import { artifactFor } from "../scripts/installer-downloads.mjs";
import { PI_INSTALL_VERSION } from "../scripts/installer-preflight.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Real directories, modes and uids need a POSIX host.
const posixHost = process.platform === "win32" ? "POSIX filesystem fixtures need a POSIX host" : false;
const posixTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, { skip: posixHost }, fn);
const manifest = { shell: "4.1.0", pi: "1.0.2" };
const LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A new folder in the system tmpdir, removed when the test ends. */
function temporary(t: TestContext) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "build-distribution-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function claimed(t: TestContext) {
	const home = join(temporary(t), "home");
	mkdirSync(home, { mode: 0o700 });
	return claimPrefix({ platform: "darwin", env: { HOME: home }, home });
}
type Run = { command: string; args: string[]; cwd: string; env: Record<string, string>; files: Record<string, string> };
/** Our pnpm resolving the lockfile: it records what it saw, writes the lockfile,
 * and, like pnpm 11 after skipped builds, may rewrite pnpm-workspace.yaml. */
function fakeResolver({ lockfile = LOCKFILE, rewrite = false, status = 0, missing = 0 } = {}) {
	const runs: Run[] = [];
	const run = (command: string, args: string[], { cwd, env }: { cwd: string; env: Record<string, string> }) => {
		runs.push({ command, args, cwd, env, files: Object.fromEntries(readdirSync(cwd).map((name) => [name, readFileSync(join(cwd, name), "utf8")])) });
		// As pnpm 11.1.1 prints it, on stdout, before the registry lists a just-published version.
		const name = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
		if (runs.length <= missing) return { status: 1, stdout: `[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for gentle-pi@${name} while fetching it from https://registry.npmjs.org/\n`, stderr: "" };
		if (status !== 0) return { status, stdout: "", stderr: "ERR_PNPM_FETCH_404" };
		writeFileSync(join(cwd, "pnpm-lock.yaml"), lockfile);
		if (rewrite) writeFileSync(join(cwd, "pnpm-workspace.yaml"), "allowBuilds:\n  gentle-pi: true\n  koffi: set this to true or false\nstrictDepBuilds: false\n");
		return { status: 0, stdout: "", stderr: "" };
	};
	return { runs, run };
}

test("the distribution asset records the exact versions, the pins, the workspace files installVersion writes and the lockfile sha256", () => {
	const text = distributionAsset(manifest, LOCKFILE);
	assert.deepEqual(DISTRIBUTION_ASSETS, { distribution: "gentle-shell-distribution.json", lockfile: "gentle-shell-distribution-lock.yaml" });
	assert.deepEqual(JSON.parse(text), {
		schema: 1, shell: "4.1.0", pi: "1.0.2", id: "4.1.0-1.0.2",
		generatedWith: { node: artifactFor("node", "linux", "x64").version, pnpm: artifactFor("pnpm").version },
		files: distributionFiles(manifest),
		lockfile: { name: "gentle-shell-distribution-lock.yaml", sha256: sha256(LOCKFILE) },
	});
	assert.equal(text.endsWith("}\n"), true);
	assert.equal(distributionAsset({ ...manifest }, `${LOCKFILE}`), text, "the same inputs give the same bytes");
	assert.notEqual(distributionAsset(manifest, `${LOCKFILE}\n`), text);
	for (const bad of [{ shell: "^4.1.0", pi: "1.0.2" }, { shell: "4.1", pi: "1.0.2" }, { shell: "4.1.0", pi: "latest" }, { shell: "4.1.0", pi: "v1.0.2" }, { shell: "4.1.0", pi: "1.x" }]) {
		assert.throws(() => distributionAsset(bad, LOCKFILE), /version rejected/, JSON.stringify(bad));
	}
	assert.throws(() => distributionAsset(manifest, ""), /lockfile/i);
});

test("readDistribution accepts only an unchanged pair whose workspace files are the ones installVersion writes", () => {
	const text = distributionAsset(manifest, LOCKFILE);
	assert.deepEqual(readDistribution(text, LOCKFILE), { manifest, lockfile: LOCKFILE });
	assert.throws(() => readDistribution(text, `${LOCKFILE}# changed\n`), /lockfile sha256/);
	const asset = JSON.parse(text);
	const tampered = (change: (value: typeof asset) => void) => { const copy = structuredClone(asset); change(copy); return `${JSON.stringify(copy, null, "\t")}\n`; };
	assert.throws(() => readDistribution(tampered((value) => { value.files["pnpm-workspace.yaml"] = "allowBuilds:\n  koffi: true\n"; }), LOCKFILE), /workspace files/);
	assert.throws(() => readDistribution(tampered((value) => { value.schema = 2; }), LOCKFILE), /schema/);
	assert.throws(() => readDistribution(tampered((value) => { value.pi = "^1.0.2"; }), LOCKFILE), /version rejected/);
	assert.throws(() => readDistribution("not json", LOCKFILE), /Distribution asset rejected/);
	// A release built with other pinned runtimes still installs with ours: only recorded, not compared.
	assert.deepEqual(readDistribution(tampered((value) => { value.generatedWith.pnpm = "11.2.0"; }), LOCKFILE).manifest, manifest);
});

posixTest("buildDistribution resolves the lockfile with our pnpm from the unmodified distribution files and returns both assets", async (t) => {
	const layout = claimed(t);
	const resolver = fakeResolver({ rewrite: true });
	const env = { PATH: "/usr/bin", npm_config_registry: "http://user.example" };
	const result = await buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", env, adapters: { run: resolver.run } });
	assert.equal(resolver.runs.length, 1);
	const [run] = resolver.runs;
	assert.equal(run.command, layout.node);
	assert.deepEqual(run.args, [layout.pnpm, "install", "--lockfile-only"]);
	assert.deepEqual(run.files, distributionFiles(manifest), "pnpm resolves exactly the files installVersion writes, and no lockfile");
	assert.deepEqual(run.env, pnpmEnvironment(layout, { env }));
	assert.equal(dirname(run.cwd), layout.tmp);
	assert.equal(existsSync(run.cwd), false, "the resolution folder is removed");
	assert.deepEqual(result.manifest, manifest);
	assert.deepEqual(Object.keys(result.assets).sort(), [DISTRIBUTION_ASSETS.distribution, DISTRIBUTION_ASSETS.lockfile].sort());
	assert.equal(result.assets[DISTRIBUTION_ASSETS.lockfile], LOCKFILE);
	// pnpm's rewritten workspace file (placeholders for skipped builds) never reaches the asset.
	assert.equal(result.assets[DISTRIBUTION_ASSETS.distribution], distributionAsset(manifest, LOCKFILE));
	assert.equal(JSON.parse(result.assets[DISTRIBUTION_ASSETS.distribution]).lockfile.sha256, sha256(LOCKFILE));
	const again = await buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", env, adapters: { run: fakeResolver({ rewrite: true }).run } });
	assert.deepEqual(again.assets, result.assets, "the same lockfile gives byte-identical assets");
});

posixTest("buildDistribution pins Pi to PI_INSTALL_VERSION and refuses a non-exact version or a failed resolution before publishing anything", async (t) => {
	const layout = claimed(t);
	const pinned = await buildDistribution({ layout, shell: "4.1.0", adapters: { run: fakeResolver().run } });
	assert.deepEqual(pinned.manifest, { shell: "4.1.0", pi: PI_INSTALL_VERSION });
	assert.equal(JSON.parse(pinned.assets[DISTRIBUTION_ASSETS.distribution]).pi, PI_INSTALL_VERSION);
	for (const [shell, pi] of [["^4.1.0", "1.0.2"], ["4.1.0", "~1.0.2"], ["latest", "1.0.2"], ["4.1.0", "1.0.2 || 1.0.3"], ["4.1.0+build", "1.0.2"]]) {
		const resolver = fakeResolver();
		await assert.rejects(buildDistribution({ layout, shell, pi, adapters: { run: resolver.run } }), /version rejected/, `${shell} ${pi}`);
		assert.equal(resolver.runs.length, 0, "pnpm never runs for a non-exact version");
	}
	const failed = fakeResolver({ status: 1 });
	await assert.rejects(buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run: failed.run, sleep: async () => {} } }),
		(error: Error & { output?: string }) => /lockfile resolution failed/.test(error.message) && error.output === "ERR_PNPM_FETCH_404");
	assert.equal(failed.runs.length, 1, "only a gentle-pi missing from the registry is retried");
	await assert.rejects(buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run: fakeResolver({ lockfile: "" }).run } }), /lockfile/i);
	assert.deepEqual(readdirSync(layout.tmp), [], "no resolution folder is left behind");
});

posixTest("the assets install with installVersion: it writes the recorded workspace files and the lockfile byte for byte", async (t) => {
	const layout = claimed(t);
	const { assets } = await buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run: fakeResolver().run } });
	const { manifest: read, lockfile } = readDistribution(assets[DISTRIBUTION_ASSETS.distribution], assets[DISTRIBUTION_ASSETS.lockfile]);
	let written: Record<string, string> = {};
	const run = (_command: string, args: string[], { cwd }: { cwd: string }) => {
		assert.deepEqual(args.slice(1), ["install", "--frozen-lockfile"]);
		written = Object.fromEntries(["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"].map((name) => [name, readFileSync(join(cwd, name), "utf8")]));
		const shell = join(cwd, "node_modules", "gentle-pi"); const pi = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(shell, "bin"), { recursive: true }); mkdirSync(pi, { recursive: true });
		writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "gentle-pi", version: read.shell }));
		writeFileSync(join(shell, "bin", "gentle-shell.mjs"), "");
		writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: read.pi }));
		return { status: 0, stdout: "", stderr: "" };
	};
	await installVersion({ layout, manifest: read, lockfile, platform: "darwin", env: {}, adapters: { run } });
	const recorded = JSON.parse(assets[DISTRIBUTION_ASSETS.distribution]).files;
	assert.deepEqual(written, { ...recorded, "pnpm-lock.yaml": assets[DISTRIBUTION_ASSETS.lockfile] });
});

posixTest("verifyDistribution installs the pair with our runtimes, activates it and requires the launcher to report both exact versions", async (t) => {
	const layout = claimed(t);
	// Runtimes already published under their pinned URLs are reused, so nothing is downloaded.
	for (const [name, directory, entry] of [["node", layout.nodeDir, layout.node], ["pnpm", layout.pnpmDir, layout.pnpm]]) {
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "");
		writeFileSync(join(directory, ".gentle-shell-runtime"), `${artifactFor(name, "darwin", "arm64").url}\n`);
	}
	const distribution = distributionAsset(manifest, LOCKFILE);
	const installs: string[][] = [];
	const run = (_command: string, args: string[], { cwd }: { cwd: string }) => {
		installs.push(args.slice(1));
		const shell = join(cwd, "node_modules", "gentle-pi"); const pi = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(join(shell, "bin"), { recursive: true }); mkdirSync(pi, { recursive: true });
		writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "gentle-pi", version: manifest.shell }));
		writeFileSync(join(shell, "bin", "gentle-shell.mjs"), "");
		writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: manifest.pi }));
		return { status: 0, stdout: "", stderr: "" };
	};
	const launches: string[] = [];
	const launch = (stdout: string) => (launcher: string) => { launches.push(launcher); return { status: 0, stdout, stderr: "" }; };
	const options = { layout, distribution, lockfile: LOCKFILE, platform: "darwin", arch: "arm64", env: {} };
	const result = await verifyDistribution({ ...options, adapters: { run, launch: launch("gentle-shell 4.1.0\npi 1.0.2\nhome isolated /h\n") } });
	assert.deepEqual(installs, [["install", "--frozen-lockfile"]]);
	assert.deepEqual(launches, [layout.launcher]);
	assert.deepEqual(result, { id: "4.1.0-1.0.2", version: "gentle-shell 4.1.0\npi 1.0.2\nhome isolated /h" });
	assert.equal(readFileSync(layout.launcher, "utf8").includes("gentle-shell bundled launcher"), true);
	// Another Pi (a fallback) or another gentle-shell fails the verification.
	await assert.rejects(verifyDistribution({ ...options, adapters: { run, launch: launch("gentle-shell 4.1.0\npi 1.1.0\n") } }), /launcher reported/);
	await assert.rejects(verifyDistribution({ ...options, adapters: { run, launch: () => ({ status: 1, stdout: "", stderr: "boom" }) } }), /launcher reported/);
	await assert.rejects(verifyDistribution({ ...options, lockfile: `${LOCKFILE}x`, adapters: { run, launch: launch("") } }), /lockfile sha256/);
	// The launcher runs in the same filtered environment as our pnpm, without Pi or Gentle overrides.
	const host = { HOME: "/h", PATH: "/usr/bin", NODE_OPTIONS: "--require /x.js", NODE_PATH: "/x", npm_config_prefix: "/x", PNPM_HOME: "/x", PI_CODING_AGENT_DIR: "/x", GENTLE_SHELL_PI: "/x" };
	let seen: Record<string, string> = {};
	await verifyDistribution({ ...options, env: host, adapters: { run, launch: (_launcher: string, { env }: { env: Record<string, string> }) => {
		seen = env; return { status: 0, stdout: "gentle-shell 4.1.0\npi 1.0.2\n", stderr: "" };
	} } });
	const { PI_CODING_AGENT_DIR: _pi, GENTLE_SHELL_PI: _shell, ...kept } = host;
	assert.deepEqual(seen, pnpmEnvironment(layout, { platform: "darwin", env: kept }));
	for (const key of ["NODE_OPTIONS", "NODE_PATH", "npm_config_prefix", "PI_CODING_AGENT_DIR", "GENTLE_SHELL_PI"]) assert.equal(key in seen, false, key);
	assert.equal(seen.PATH.split(":")[0], dirname(layout.node), "our Node first on PATH");
});

posixTest("buildDistribution retries while the just-published gentle-pi is not on the registry, then fails clearly", async (t) => {
	const layout = claimed(t);
	const waits: number[] = [];
	const sleep = async (ms: number) => { waits.push(ms); };
	const late = fakeResolver({ missing: 2 });
	const result = await buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run: late.run, sleep } });
	assert.equal(result.assets[DISTRIBUTION_ASSETS.lockfile], LOCKFILE);
	assert.equal(late.runs.length, 3);
	assert.deepEqual(waits, [30000, 30000]);
	assert.equal(new Set(late.runs.map((run) => run.cwd)).size, 3, "each attempt resolves in a fresh folder");
	for (const run of late.runs) assert.deepEqual(run.files, distributionFiles(manifest));
	waits.length = 0;
	const never = fakeResolver({ missing: 99 });
	await assert.rejects(buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run: never.run, sleep } }),
		(error: Error & { output?: string }) => /gentle-pi@4\.1\.0 is not on the registry after 10 attempts/.test(error.message) && /ERR_PNPM_NO_MATCHING_VERSION/.test(error.output ?? ""));
	assert.equal(never.runs.length, 10);
	assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 270000, "about five minutes in all");
	// A missing Pi, or another gentle-pi version, is a real failure: never retried.
	for (const missing of ["@earendil-works/pi-coding-agent@1.0.2", "gentle-pi@4.1.0-beta.1", "gentle-pi@4.1.01"]) {
		let runs = 0;
		const run = () => { runs += 1; return { status: 1, stdout: `[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for ${missing} while fetching it\n`, stderr: "" }; };
		await assert.rejects(buildDistribution({ layout, shell: "4.1.0", pi: "1.0.2", adapters: { run, sleep } }), /lockfile resolution failed/, missing);
		assert.equal(runs, 1, missing);
	}
	assert.deepEqual(readdirSync(layout.tmp), [], "no resolution folder is left behind");
});

posixTest("the CLI removes the temporary prefix it created when build or verify fails, and refuses bad input before creating one", async (t) => {
	const root = temporary(t);
	const options = { temporaryRoot: root, env: { PATH: "/usr/bin" }, adapters: { download: async () => Buffer.from("not the pinned archive") } };
	await assert.rejects(main(["verify", "--assets", join(root, "missing")], options), /ENOENT/);
	assert.deepEqual(readdirSync(root), [], "verify with unreadable assets");
	const assets = join(root, "assets"); mkdirSync(assets);
	writeFileSync(join(assets, DISTRIBUTION_ASSETS.distribution), distributionAsset(manifest, LOCKFILE));
	writeFileSync(join(assets, DISTRIBUTION_ASSETS.lockfile), LOCKFILE);
	await assert.rejects(main(["verify", "--assets", assets], options), /Download integrity mismatch/);
	assert.deepEqual(readdirSync(root), ["assets"], "verify whose runtime download fails");
	await assert.rejects(main(["build", "--shell", "4.1.0", "--out", join(root, "out")], options), /Download integrity mismatch/);
	assert.deepEqual(readdirSync(root), ["assets"], "build whose runtime download fails");
	await assert.rejects(main(["build", "--shell", "^4.1.0", "--out", join(root, "out")], options), /version rejected/);
	await assert.rejects(main(["publish"], options), /Usage/);
	assert.deepEqual(readdirSync(root), ["assets"]);
});

// publish.yml: the distribution assets reach the release only after the frozen
// install passed on all three systems, and the existing jobs keep their shape.
function jobs(workflow: string) {
	const body = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
	return new Map([...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n([\s\S]*?)(?=^ {2}[A-Za-z0-9_-]+:\n|(?![\s\S]))/gm)].map((match) => [match[1], match[2]]));
}
test("publish.yml builds the distribution after npm publication, verifies it on three systems and only then uploads it", () => {
	const workflow = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
	const all = jobs(workflow);
	assert.deepEqual([...all.keys()], ["publish", "installers", "distribution", "distribution-verify", "distribution-assets"]);
	for (const name of ["publish", "installers"]) assert.doesNotMatch(all.get(name)!, /distribution/, `${name} is unchanged`);
	assert.match(workflow, /^permissions:\n {2}contents: read\n/m, "the workflow default stays read-only");
	for (const use of workflow.matchAll(/uses: (\S+)/g)) assert.match(use[1], /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${use[1]} is pinned by commit SHA`);

	const build = all.get("distribution")!;
	assert.match(build, /^ {4}needs: publish$/m, "gentle-pi@<tag> must be on npm before it is resolved");
	assert.match(build, /^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
	assert.match(build, /ref: \$\{\{ github\.sha \}\}/, "built on the verified release commit");
	assert.match(build, /RELEASE_TAG: \$\{\{ needs\.publish\.outputs\.tag \}\}/);
	assert.match(build, /node scripts\/build-distribution\.mjs build --shell "\$\{RELEASE_TAG#v\}" --out "\$\{RUNNER_TEMP\}\/distribution"/);
	assert.match(build, /uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}name: gentle-shell-distribution\n/);

	const verify = all.get("distribution-verify")!;
	assert.match(verify, /^ {4}needs: distribution$/m);
	assert.match(verify, /^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
	assert.match(verify, /matrix:\n {8}os: \[ubuntu-latest, macos-latest, windows-latest\]\n/);
	assert.match(verify, /fail-fast: false/);
	assert.match(verify, /runs-on: \$\{\{ matrix\.os \}\}/);
	assert.match(verify, /ref: \$\{\{ github\.sha \}\}/);
	assert.match(verify, /uses: actions\/download-artifact@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}name: gentle-shell-distribution\n/);
	assert.match(verify, /node scripts\/build-distribution\.mjs verify --assets "\$\{RUNNER_TEMP\}\/distribution"/);
	assert.doesNotMatch(verify, /gh release|contents: write/);

	const upload = all.get("distribution-assets")!;
	assert.match(upload, /^ {4}needs: \[publish, distribution-verify\]$/m, "uploaded only after every verify lane passed");
	assert.match(upload, /^ {4}permissions:\n {6}contents: write\n(?! {6})/m);
	assert.match(upload, /RELEASE_TAG: \$\{\{ needs\.publish\.outputs\.tag \}\}/);
	assert.match(upload, /gh release upload "\$\{RELEASE_TAG\}" "\$\{RUNNER_TEMP\}\/distribution\/gentle-shell-distribution\.json" "\$\{RUNNER_TEMP\}\/distribution\/gentle-shell-distribution-lock\.yaml" --repo "\$\{GITHUB_REPOSITORY\}" --clobber/);
	for (const [name, job] of all) if (name !== "distribution-assets") assert.doesNotMatch(job, /gentle-shell-distribution\.json/, `${name} never uploads the assets`);
});
