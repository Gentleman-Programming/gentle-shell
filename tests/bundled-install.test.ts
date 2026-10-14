import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, rmSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import test, { after, type TestContext } from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { activateVersion, activeVersion, applyPathEntry, claimPrefix, prefixRoot, distributionFiles, engramExecutable, ensureEngram, ensureLauncher, ensureRuntime, filterNpmrc, installVersion, nodeExecutable,
	nodeRuntimeFiles, pathEntryPlan, pnpmEnvironment, prefixLayout, pruneVersions, removePathEntry, rollbackBundled, setupEnvironment, bundledNpmCommand, ensureNpmShim, upgradeBundled, userNpmrc, writeNpmrcAuth,
	describePathReceipt, readPathReceipt, scheduleWindowsRemoval, writePathReceipt }
	from "../scripts/bundled-install.mjs";

// Real directories, modes, symlinks and uids need a POSIX host.
const posixHost = process.platform === "win32" ? "POSIX filesystem fixtures need a POSIX host" : false;
const posixTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, { skip: posixHost }, fn);
const NODE = "24.21.0";
const PNPM = "11.1.1";
const NPM = "11.19.0";
const ENGRAM = "3.4.0";

// Every temporary home this file creates is removed when the file's tests end.
const roots: string[] = [];
after(() => {
	for (const root of roots) {
		try { chmodSync(root, 0o700); } catch {}
		rmSync(root, { recursive: true, force: true });
	}
});
function home() {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "bundled-install-"));
	roots.push(root);
	const dir = join(root, "home ü");
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}
function claimed(platform = "darwin") {
	const user = home();
	return { home: user, layout: claimPrefix({ platform, env: { HOME: user }, home: user }) };
}

// A ustar member, as the Node and pnpm tarballs carry them.
function tarEntry(name: string, { type = "0", data = Buffer.alloc(0), link = "", mode = "0000644" } = {}) {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write(`${mode}\0`, 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(type, 156);
	header.write(link, 157, 100);
	header.write("ustar\u000000", 257);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tarGz = (entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
// A stored (uncompressed) zip, as small as the Windows Node archive's shape allows.
function zip(files: [string, Buffer][]) {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of files) {
		const bytes = Buffer.from(name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(bytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(bytes.length, 28); central.writeUInt32LE(offset, 42);
		locals.push(local, bytes, data);
		centrals.push(central, bytes);
		offset += 30 + bytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

const nodeStem = `node-v${NODE}-darwin-arm64`;
const nodeBytes = Buffer.from("#!/bin/sh\necho fixture node\n");
const nodeArchive = tarGz([
	tarEntry(`${nodeStem}/`, { type: "5" }),
	tarEntry(`${nodeStem}/bin/`, { type: "5" }),
	tarEntry(`${nodeStem}/bin/node`, { data: nodeBytes }),
	// Links and every other member are skipped, never written.
	tarEntry(`${nodeStem}/bin/npm`, { type: "2", link: "../lib/node_modules/npm/bin/npm-cli.js" }),
	tarEntry(`${nodeStem}/include/node/node.h`, { data: Buffer.from("header") }),
	// npm, bundled in the same verified archive, is kept for Pi's package installs.
	tarEntry(`${nodeStem}/lib/node_modules/npm/`, { type: "5" }),
	tarEntry(`${nodeStem}/lib/node_modules/npm/package.json`, { data: Buffer.from(JSON.stringify({ name: "npm", version: NPM })) }),
	tarEntry(`${nodeStem}/lib/node_modules/npm/bin/npm-cli.js`, { data: Buffer.from("// npm cli\n"), mode: "0000755" }),
	tarEntry(`${nodeStem}/lib/node_modules/npm/bin/npx-cli.js`, { data: Buffer.from("// npx cli\n"), mode: "0000755" }),
	tarEntry(`${nodeStem}/lib/node_modules/npm/bin/link`, { type: "2", link: "/etc/passwd" }),
	tarEntry(`${nodeStem}/lib/node_modules/corepack/package.json`, { data: Buffer.from("{}") }),
]);
const pnpmArchive = tarGz([
	tarEntry("package/package.json", { data: Buffer.from(JSON.stringify({ name: "pnpm", version: PNPM, engines: { node: ">=22.13" }, bin: { pnpm: "bin/pnpm.mjs" } })) }),
	tarEntry("package/bin/pnpm.mjs", { data: Buffer.from("// fixture pnpm\n"), mode: "0000755" }),
	// pnpm runs node-gyp from this folder: it must stay executable.
	tarEntry("package/dist/node-gyp-bin/node-gyp", { data: Buffer.from("#!/bin/sh\n"), mode: "0000755" }),
]);
// The Engram release archive's shape: the executable at the top, beside tools/.
const engramBytes = Buffer.from("#!/bin/sh\necho fixture engram\n");
const engramArchive = tarGz([
	tarEntry("tools/cloud-sync-projects.sh", { data: Buffer.from("#!/bin/sh\n"), mode: "0000755" }),
	tarEntry("engram", { data: engramBytes, mode: "0000755" }),
]);
const engramUrl = `https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM}/engram_${ENGRAM}_darwin_arm64.tar.gz`;
const archives: Record<string, Buffer> = { node: nodeArchive, pnpm: pnpmArchive, engram: engramArchive };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function adapters(overrides: Record<string, unknown> = {}) {
	const calls: { downloads: string[]; runs: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] } = { downloads: [], runs: [] };
	return {
		calls,
		adapters: {
			artifact: (name: string) => ({ name, version: name === "node" ? NODE : name === "engram" ? ENGRAM : PNPM, maxBytes: 1 << 20, integrity: `sha256-${sha256(archives[name])}`,
				url: name === "node" ? `https://nodejs.org/dist/v${NODE}/${nodeStem}.tar.gz` : name === "engram" ? engramUrl : `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM}.tgz` }),
			download: async (descriptor: { name: string }) => { calls.downloads.push(descriptor.name); return archives[descriptor.name]; },
			run: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
				calls.runs.push({ command, args, ...options });
				if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: `v${NODE}\n`, stderr: "" };
				if (args.length === 1 && args[0] === "version") return { status: 0, stdout: `engram ${ENGRAM}\n`, stderr: "" };
				if (args[1] === "--version") return { status: 0, stdout: `${args[0].endsWith("npm-cli.js") ? NPM : PNPM}\n`, stderr: "" };
				return { status: 1, stdout: "", stderr: "unexpected" };
			},
			...overrides,
		},
	};
}

// Rule 1: one prefix with every folder inside it.
test("prefixLayout puts every bundled folder under ~/.gentle-shell on POSIX", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const root = "/home/me/.gentle-shell";
	assert.equal(layout.root, root);
	assert.equal(layout.agent, `${root}/agent`);
	assert.equal(layout.node, `${root}/runtime/node-${NODE}/bin/node`);
	assert.equal(layout.pnpm, `${root}/runtime/pnpm-${PNPM}/package/bin/pnpm.mjs`);
	assert.equal(layout.goRoot, `${root}/runtime/go`);
	assert.equal(layout.engram, `${root}/runtime/engram-${ENGRAM}/engram`);
	assert.deepEqual([layout.pnpmHome, layout.store, layout.cache, layout.state, layout.config],
		["pnpm", "pnpm/store", "pnpm/cache", "pnpm/state", "pnpm/config"].map((folder) => `${root}/${folder}`));
	assert.equal(layout.versions, `${root}/versions`);
	assert.equal(layout.current, `${root}/current`);
	assert.equal(layout.currentKind, "symlink");
	assert.equal(layout.launcher, `${root}/bin/gentle-shell`);
	assert.throws(() => prefixLayout({ platform: "linux", env: {}, home: "relative" }), /home/i);
});

test("prefixLayout uses the Windows private folder and a pointer file for current", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const layout = prefixLayout({ platform: "win32", env, home: "C:\\Users\\me" });
	const root = "C:\\Users\\me\\AppData\\Local\\gentle-shell";
	assert.equal(layout.root, root);
	assert.equal(layout.agent, "C:\\Users\\me\\.gentle-shell\\agent");
	assert.equal(layout.node, `${root}\\runtime\\node-${NODE}\\node.exe`);
	assert.equal(layout.engram, `${root}\\runtime\\engram-${ENGRAM}\\engram.exe`);
	assert.equal(layout.currentKind, "pointer");
	assert.equal(layout.launcher, `${root}\\bin\\gentle-shell.cmd`);
	assert.equal(layout.tmp, `${root}\\tmp`);
	const fallback = prefixLayout({ platform: "win32", env, home: "C:\\Users\\me", root: "C:\\Users\\me\\.gentle-shell-bundle" });
	assert.equal(fallback.versions, "C:\\Users\\me\\.gentle-shell-bundle\\versions");
});

posixTest("claimPrefix creates a private root, tightens its own group- or other-writable root and refuses a link or a non-folder", () => {
	const user = home();
	const layout = claimPrefix({ platform: "darwin", env: { HOME: user }, home: user });
	const info = lstatSync(layout.root);
	assert.ok(info.isDirectory());
	assert.equal(info.mode & 0o777, 0o700);
	// An existing root (the agent home lives there) is kept as it is.
	writeFileSync(join(layout.root, "config.json"), "{}");
	assert.equal(claimPrefix({ platform: "darwin", env: { HOME: user }, home: user }).root, layout.root);
	assert.equal(readFileSync(join(layout.root, "config.json"), "utf8"), "{}");
	const linked = home();
	symlinkSync(layout.root, join(linked, ".gentle-shell"));
	assert.throws(() => claimPrefix({ platform: "darwin", env: { HOME: linked }, home: linked }), /Unsafe bundled prefix/);
	// T3 B3: a real folder of this user that umask 002 (or chmod) left group- or other-writable is
	// tightened (go-w), not refused, and its contents stay.
	for (const mode of [0o775, 0o777]) {
		const shared = home();
		mkdirSync(join(shared, ".gentle-shell"));
		writeFileSync(join(shared, ".gentle-shell", "config.json"), "{}");
		chmodSync(join(shared, ".gentle-shell"), mode);
		assert.equal(claimPrefix({ platform: "darwin", env: { HOME: shared }, home: shared }).root, join(shared, ".gentle-shell"));
		assert.equal(lstatSync(join(shared, ".gentle-shell")).mode & 0o777, mode & ~0o022);
		assert.equal(readFileSync(join(shared, ".gentle-shell", "config.json"), "utf8"), "{}");
	}
	const file = home();
	writeFileSync(join(file, ".gentle-shell"), "");
	assert.throws(() => claimPrefix({ platform: "darwin", env: { HOME: file }, home: file }), /Unsafe bundled prefix|EEXIST|ENOTDIR/);
});

test("claimPrefix on Windows walks then claims %LOCALAPPDATA%, falling back to the profile only on an untrusted owner or ACL", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const primary = "C:\\Users\\me\\AppData\\Local\\gentle-shell";
	const fallback = "C:\\Users\\me\\.gentle-shell-bundle";
	const run = (failing: Record<string, string>) => {
		const walked: string[] = []; const claims: string[] = [];
		const layout = claimPrefix({ platform: "win32", env, home: "C:\\Users\\me", adapters: {
			// Only the candidates themselves are absent: each walk starts at its parent.
			exists: (path: string) => path !== primary && path !== fallback,
			prepare: () => {},
			storage: (path: string) => {
				walked.push(path);
				const check = Object.entries(failing).find(([prefix]) => path.startsWith(prefix))?.[1];
				if (check) throw Object.assign(new Error("Windows ACL evidence rejected"), { check });
			},
			claim: (path: string) => { claims.push(path); return "claimed"; },
		} });
		return { layout, walked, claims };
	};
	const trusted = run({});
	assert.equal(trusted.layout.root, primary);
	assert.deepEqual(trusted.claims, [primary]);
	const moved = run({ [primary]: "ancestor-acl-mask", "C:\\Users\\me\\AppData": "parent-acl-mask" });
	assert.equal(moved.layout.root, fallback);
	assert.deepEqual(moved.claims, [fallback]);
	assert.throws(() => run({ "C:\\Users\\me\\AppData": "parent-reparse" }), /ACL evidence/);
	assert.throws(() => run({ "C:\\": "ancestor-acl-mask" }), /ACL evidence/);
});

test("the plan's prefix is the folder claimPrefix will claim, and a claim that would choose another folder changes nothing", () => {
	const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" };
	const primary = "C:\\Users\\me\\AppData\\Local\\gentle-shell";
	const fallback = "C:\\Users\\me\\.gentle-shell-bundle";
	const adapters = (failing: string | null, claims: string[]) => ({
		exists: (path: string) => path !== primary && path !== fallback,
		prepare: () => {},
		storage: (path: string) => { if (failing && path.startsWith(failing)) throw Object.assign(new Error("Windows ACL evidence rejected"), { check: "parent-acl-mask" }); },
		claim: (path: string) => { claims.push(path); return "claimed"; },
	});
	const none: string[] = [];
	assert.equal(prefixRoot({ platform: "win32", env, adapters: adapters(null, none) }), primary);
	assert.equal(prefixRoot({ platform: "win32", env, adapters: adapters("C:\\Users\\me\\AppData", none) }), fallback, "the same fallback the claim takes");
	assert.equal(prefixRoot({ platform: "linux", env: { HOME: "/home/me" } }), undefined, "POSIX keeps ~/.gentle-shell");
	assert.deepEqual(none, [], "choosing the plan's folder claims nothing");
	const claims: string[] = [];
	assert.throws(() => claimPrefix({ platform: "win32", env, home: "C:\\Users\\me", root: primary, adapters: adapters("C:\\Users\\me\\AppData", claims) }),
		(error: { check?: string; message: string }) => error.check === "prefix-changed" && error.message.includes(fallback));
	assert.deepEqual(claims, [], "nothing is claimed when the folder differs from the consented one");
	assert.equal(claimPrefix({ platform: "win32", env, home: "C:\\Users\\me", root: fallback, adapters: adapters("C:\\Users\\me\\AppData", claims) }).root, fallback);
	assert.deepEqual(claims, [fallback]);
});

test("ensureWindowsPrivateFolder runs the PNPM_HOME claim with only the folder and its marker as data", async () => {
	const windows = await import("../scripts/installer-windows.mjs");
	const source = readFileSync(new URL("../scripts/installer-windows.mjs", import.meta.url), "utf8");
	const pnpmHomeClaim = source.split("const pnpmHomeClaim = String.raw`")[1].split("`;")[0];
	const expected = pnpmHomeClaim.replaceAll("$env:GENTLE_WINDOWS_PNPM_HOME", "$env:GENTLE_WINDOWS_PRIVATE_FOLDER")
		.replaceAll("'.gentle-shell-pnpm-home'", "$env:GENTLE_WINDOWS_PRIVATE_MARKER").replaceAll("'gentle-pi private pnpm home'", "$env:GENTLE_WINDOWS_PRIVATE_TEXT");
	const folder = "C:\\L\\gentle-shell";
	const options = (output: string, walked: string[] = []) => ({ marker: ".gentle-shell-bundle", text: "gentle-shell bundled install", platform: "win32",
		processAdapter: (_command: string, args: string[], env: Record<string, string>) => {
			assert.equal(args[4], expected);
			assert.deepEqual([env.GENTLE_WINDOWS_PRIVATE_FOLDER, env.GENTLE_WINDOWS_PRIVATE_MARKER, env.GENTLE_WINDOWS_PRIVATE_TEXT], [folder, ".gentle-shell-bundle", "gentle-shell bundled install"]);
			return output;
		},
		storage: (path: string) => { walked.push(path); } });
	const walked: string[] = [];
	assert.equal(windows.ensureWindowsPrivateFolder(folder, { SystemRoot: "C:\\Windows" }, options("claimed", walked)), "claimed");
	assert.deepEqual(walked, [folder, `${folder}\\tmp`]);
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, { SystemRoot: "C:\\Windows" }, options("unsafe:foreign")), (error: { check?: string }) => error.check === "foreign");
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, {}, { ...options("claimed"), marker: "..\\x" }), /marker/);
	assert.throws(() => windows.ensureWindowsPrivateFolder(folder, {}, { ...options("claimed"), platform: "darwin" }), /Native Windows/);
});

// Rule 2: the pinned runtime, verified, published once and reused.
posixTest("ensureRuntime installs the verified Node and pnpm into runtime/ and reuses them", async () => {
	const { layout } = claimed();
	const { calls, adapters: fixture } = adapters();
	const first = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture });
	assert.deepEqual(first, { node: layout.node, pnpm: layout.pnpm, go: null, acquired: ["node", "pnpm"] });
	assert.deepEqual(readFileSync(layout.node), nodeBytes);
	assert.equal(lstatSync(layout.node).mode & 0o777, 0o700);
	assert.equal(readFileSync(layout.pnpm, "utf8"), "// fixture pnpm\n");
	// The executable bits the pnpm tarball declares are kept, for the owner only.
	assert.equal(lstatSync(layout.pnpm).mode & 0o777, 0o700);
	assert.equal(lstatSync(join(layout.pnpmDir, "package", "dist", "node-gyp-bin", "node-gyp")).mode & 0o777, 0o700);
	assert.equal(lstatSync(join(layout.pnpmDir, "package", "package.json")).mode & 0o777, 0o600);
	// The Node executable and its npm are published, no links: npm and npx are our own wrappers.
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`)).sort(), [".gentle-shell-runtime", "bin", "gentle-shell", "lib"]);
	// Pi's npmCommand entry, named npm (ensureNpmShim).
	assert.match(readFileSync(layout.npmShim, "utf8"), /npm-cli\.js/);
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`, "bin")).sort(), ["node", "npm", "npx"]);
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`, "lib", "node_modules")), ["npm"]);
	assert.deepEqual(readdirSync(join(layout.runtime, `node-${NODE}`, "lib", "node_modules", "npm", "bin")).sort(), ["npm-cli.js", "npx-cli.js"]);
	assert.equal(readFileSync(layout.npmCli, "utf8"), "// npm cli\n");
	assert.match(readFileSync(join(layout.nodeDir, "bin", "npm"), "utf8"), /exec "\$basedir\/node" "\$basedir\/\.\.\/lib\/node_modules\/npm\/bin\/npm-cli\.js" "\$@"/);
	assert.equal(lstatSync(join(layout.nodeDir, "bin", "npx")).mode & 0o777, 0o700);
	// Each is checked in its staging folder, before it is published.
	const [nodeCheck, npmCheck, pnpmCheck] = calls.runs;
	assert.equal(calls.runs.length, 3);
	assert.deepEqual(nodeCheck.args, ["--version"]);
	assert.match(nodeCheck.command, /\/runtime\/\.stage-[^/]+\/bin\/node$/);
	assert.equal(npmCheck.command, nodeCheck.command);
	assert.match(npmCheck.args[0], /\/runtime\/\.stage-[^/]+\/lib\/node_modules\/npm\/bin\/npm-cli\.js$/);
	assert.equal(npmCheck.args[1], "--version");
	assert.equal(pnpmCheck.command, layout.node);
	assert.match(pnpmCheck.args[0], /\/runtime\/\.stage-[^/]+\/package\/bin\/pnpm\.mjs$/);
	assert.equal(pnpmCheck.args[1], "--version");
	assert.equal(pnpmCheck.env.pnpm_config_store_dir, layout.store);
	const again = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture });
	assert.deepEqual(again.acquired, []);
	assert.deepEqual(calls.downloads, ["node", "pnpm"]);
});

posixTest("ensureRuntime never replaces an unmarked runtime folder and publishes nothing on a failed check", async () => {
	const { layout } = claimed();
	mkdirSync(join(layout.runtime, `node-${NODE}`, "bin"), { recursive: true });
	writeFileSync(join(layout.runtime, `node-${NODE}`, "bin", "node"), "user");
	await assert.rejects(ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: adapters().adapters }), /Conflicting runtime/);
	assert.equal(readFileSync(join(layout.runtime, `node-${NODE}`, "bin", "node"), "utf8"), "user");
	const other = claimed().layout;
	const wrong = adapters({ run: () => ({ status: 0, stdout: "v20.0.0\n", stderr: "" }) }).adapters;
	await assert.rejects(ensureRuntime({ layout: other, platform: "darwin", arch: "arm64", adapters: wrong }), /Node/);
	assert.deepEqual(readdirSync(other.runtime), []);
	const tampered = adapters({ download: async () => Buffer.from("not the pinned bytes") }).adapters;
	await assert.rejects(ensureRuntime({ layout: other, platform: "darwin", arch: "arm64", adapters: tampered }), /integrity|size/);
	assert.deepEqual(readdirSync(other.runtime), []);
});

posixTest("ensureRuntime acquires the pinned Go only when asked", async () => {
	const { layout } = claimed();
	const asked: unknown[] = [];
	const fixture = adapters({ acquireGo: async (options: unknown) => { asked.push(options); return { goPath: "/go/bin/go", version: "1.25.14", acquired: true }; } }).adapters;
	assert.equal((await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture })).go, null);
	assert.equal(asked.length, 0);
	const result = await ensureRuntime({ layout, platform: "darwin", arch: "arm64", go: true, adapters: fixture });
	assert.equal(result.go, "/go/bin/go");
	assert.equal((asked[0] as { root: string }).root, layout.goRoot);
});

// S9: the pinned Engram, verified, published once and reused; only when asked.
posixTest("ensureEngram publishes only the verified engram executable after running it, and ensureRuntime asks for it only when told", async () => {
	const { layout } = claimed();
	const { calls, adapters: fixture } = adapters();
	assert.deepEqual((await ensureRuntime({ layout, platform: "darwin", arch: "arm64", adapters: fixture })).acquired, ["node", "pnpm"]);
	assert.equal(existsSync(layout.engramDir), false);
	assert.deepEqual((await ensureRuntime({ layout, platform: "darwin", arch: "arm64", engram: true, adapters: fixture })).acquired, ["engram"]);
	assert.deepEqual(readdirSync(layout.engramDir).sort(), [".gentle-shell-runtime", "engram"]);
	assert.deepEqual(readFileSync(layout.engram), engramBytes);
	assert.equal(lstatSync(layout.engram).mode & 0o777, 0o700);
	assert.equal(readFileSync(join(layout.engramDir, ".gentle-shell-runtime"), "utf8"), `${engramUrl}\n`);
	// `engram version` ran from the staging folder, before publication.
	const check = calls.runs.at(-1)!;
	assert.deepEqual(check.args, ["version"]);
	assert.match(check.command, /\/runtime\/\.stage-[^/]+\/engram$/);
	assert.equal(await ensureEngram({ layout, platform: "darwin", arch: "arm64", adapters: fixture }), false, "reused");
	assert.deepEqual(calls.downloads, ["node", "pnpm", "engram"]);
	// Another version's answer, or a tampered archive, publishes nothing.
	for (const broken of [adapters({ run: () => ({ status: 0, stdout: "engram 3.0.0\n", stderr: "" }) }).adapters, adapters({ download: async () => Buffer.from("x") }).adapters]) {
		const other = claimed().layout;
		await assert.rejects(ensureEngram({ layout: other, platform: "darwin", arch: "arm64", adapters: broken }), /Engram|integrity|size/);
		assert.deepEqual(readdirSync(other.runtime), []);
	}
});

// A4: a prefix that is not there fails before anything is downloaded.
posixTest("ensureEngram downloads nothing when the prefix is missing", async () => {
	const user = home();
	const layout = prefixLayout({ platform: "darwin", env: { HOME: user }, home: user });
	const { calls, adapters: fixture } = adapters();
	await assert.rejects(ensureEngram({ layout, platform: "darwin", arch: "arm64", adapters: fixture }), /ENOENT/);
	assert.deepEqual(calls.downloads, []);
	assert.equal(existsSync(layout.root), false);
});

test("engramExecutable takes only the top-level engram from the tarball and engram.exe from the zip, regular files only", () => {
	const tarball = { url: "https://github.com/Gentleman-Programming/engram/releases/download/v3.4.0/engram_3.4.0_linux_amd64.tar.gz" };
	const zipped = { url: "https://github.com/Gentleman-Programming/engram/releases/download/v3.4.0/engram_3.4.0_windows_amd64.zip" };
	assert.deepEqual(engramExecutable(engramArchive, tarball), engramBytes);
	const exe = Buffer.from("MZ engram");
	assert.deepEqual(engramExecutable(zip([["tools/cloud-sync-projects.ps1", Buffer.from("x")], ["engram.exe", exe]]), zipped), exe);
	assert.throws(() => engramExecutable(tarGz([tarEntry("engram", { type: "2", link: "/bin/sh" })]), tarball), /Engram archive rejected/);
	assert.throws(() => engramExecutable(tarGz([tarEntry("bin/engram", { data: engramBytes })]), tarball), /Engram archive rejected/);
	assert.throws(() => engramExecutable(zip([["engram", exe]]), zipped), /Engram archive rejected/);
});

test("nodeExecutable takes only node.exe from the Windows zip and only bin/node from the tarball", () => {
	const stem = `node-v${NODE}-win-x64`;
	const exe = Buffer.from("MZ fixture");
	const descriptor = { url: `https://nodejs.org/dist/v${NODE}/${stem}.zip` };
	const archive = zip([[`${stem}/npm.cmd`, Buffer.from("npm")], [`${stem}/node.exe`, exe]]);
	assert.deepEqual(nodeExecutable(archive, descriptor), exe);
	assert.throws(() => nodeExecutable(zip([[`${stem}/npm.cmd`, Buffer.from("npm")]]), descriptor), /Node archive/);
	assert.throws(() => nodeExecutable(zip([[`${stem}/node.exe`, exe], [`${stem}/node.exe`, exe]]), descriptor), /Node archive/);
	const tarball = { url: `https://nodejs.org/dist/v${NODE}/${nodeStem}.tar.gz` };
	assert.deepEqual(nodeExecutable(nodeArchive, tarball), nodeBytes);
	assert.throws(() => nodeExecutable(tarGz([tarEntry(`${nodeStem}/bin/node`, { type: "2", link: "/bin/sh" })]), tarball), /Node archive/);
});

// Rule 3: pnpm's whole world inside the prefix.
test("pnpmEnvironment keeps pnpm's home, store, cache, state and config inside the prefix", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const env = pnpmEnvironment(layout, { platform: "linux", env: {
		HOME: "/home/me", PATH: "/usr/local/bin:/usr/bin", PNPM_HOME: "/home/me/.local/share/pnpm", npm_config_registry: "https://user.example",
		NPM_CONFIG_USERCONFIG: "/home/me/.npmrc", pnpm_config_store_dir: "/elsewhere", XDG_CONFIG_HOME: "/home/me/.config", NODE_OPTIONS: "--require /x.js",
		npm_lifecycle_event: "postinstall", COREPACK_ENABLE_STRICT: "1", HTTPS_PROXY: "http://proxy:3128" } });
	const root = "/home/me/.gentle-shell";
	assert.equal(env.PATH, `${root}/runtime/node-${NODE}/bin:/usr/local/bin:/usr/bin`);
	assert.equal(env.PNPM_HOME, `${root}/pnpm`);
	assert.equal(env.pnpm_config_store_dir, `${root}/pnpm/store`);
	assert.equal(env.pnpm_config_cache_dir, `${root}/pnpm/cache`);
	assert.equal(env.pnpm_config_state_dir, `${root}/pnpm/state`);
	assert.equal(env.pnpm_config_npmrc_auth_file, `${root}/pnpm/config/npmrc`);
	assert.equal(env.XDG_CONFIG_HOME, `${root}/pnpm/config`);
	assert.equal(env.XDG_CACHE_HOME, `${root}/pnpm/cache`);
	assert.equal(env.XDG_STATE_HOME, `${root}/pnpm/state`);
	// pnpm 11 has no manage-package-manager-versions setting; pm-on-fail defaults to
	// "download", which switches to the pnpm a package.json above the folder names.
	assert.equal(env.pnpm_config_manage_package_manager_versions, undefined);
	assert.equal(env.pnpm_config_pm_on_fail, "ignore");
	assert.equal(env.pnpm_config_runtime_on_fail, "ignore");
	assert.equal(env.pnpm_config_update_notifier, "false");
	for (const key of ["npm_config_registry", "NPM_CONFIG_USERCONFIG", "NODE_OPTIONS", "npm_lifecycle_event", "COREPACK_ENABLE_STRICT"]) assert.equal(env[key], undefined, key);
	assert.equal(env.HTTPS_PROXY, "http://proxy:3128");
	assert.equal(env.HOME, "/home/me");
	const withGo = pnpmEnvironment(layout, { platform: "linux", env: { PATH: "/usr/bin" }, go: "/opt/go/bin/go" });
	assert.equal(withGo.PATH, `${root}/runtime/node-${NODE}/bin:/opt/go/bin:/usr/bin`);
});

test("pnpmEnvironment on Windows replaces every Path spelling and moves TEMP into the prefix", () => {
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const env = pnpmEnvironment(layout, { platform: "win32", env: { Path: "C:\\Windows\\System32", TEMP: "C:\\T", tmp: "C:\\T", Pnpm_Home: "C:\\U\\pnpm", SystemRoot: "C:\\Windows" } });
	assert.equal(env.Path, `C:\\L\\gentle-shell\\runtime\\node-${NODE};C:\\Windows\\System32`);
	assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PATH").length, 1);
	assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PNPM_HOME").length, 1);
	assert.equal(env.PNPM_HOME, "C:\\L\\gentle-shell\\pnpm");
	assert.equal(env.TEMP, "C:\\L\\gentle-shell\\tmp");
	assert.equal(env.TMP, "C:\\L\\gentle-shell\\tmp");
	assert.equal(env.tmp, undefined);
	assert.equal(env.SystemRoot, "C:\\Windows");
});

// Rule 4: one frozen install per version, verified, never replacing a folder.
const manifest = { shell: "4.1.0", pi: "1.0.2" };
function fakePnpm(versions = manifest) {
	const runs: { command: string; args: string[]; cwd: string; env: Record<string, string>; marker: string }[] = [];
	const run = (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
		runs.push({ command, args, ...options, marker: readFileSync(join(options.cwd, ".gentle-shell-version"), "utf8") });
		const modules = join(options.cwd, "node_modules");
		// Like pnpm's Windows junctions: absolute links into node_modules/.pnpm.
		const real = join(modules, ".pnpm", `gentle-pi@${versions.shell}`, "node_modules", "gentle-pi");
		mkdirSync(join(real, "bin"), { recursive: true });
		mkdirSync(join(modules, "@earendil-works", "pi-coding-agent"), { recursive: true });
		writeFileSync(join(real, "package.json"), JSON.stringify({ name: "gentle-pi", version: versions.shell }));
		writeFileSync(join(real, "bin", "gentle-shell.mjs"), "");
		symlinkSync(real, join(modules, "gentle-pi"));
		writeFileSync(join(modules, "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: versions.pi }));
		return { status: 0, stdout: "", stderr: "" };
	};
	return { runs, run };
}

posixTest("installVersion runs our pnpm frozen in the final versions/<shell>-<pi> folder and marks it valid last", async () => {
	const { layout } = claimed();
	const pnpm = fakePnpm();
	const result = await installVersion({ layout, manifest, lockfile: "lockfileVersion: '9.0'\n", platform: "darwin", env: { PATH: "/usr/bin" }, adapters: { run: pnpm.run } });
	assert.deepEqual(result, { id: "4.1.0-1.0.2", path: join(layout.versions, "4.1.0-1.0.2"), installed: true });
	assert.equal(pnpm.runs.length, 1);
	const [install] = pnpm.runs;
	assert.equal(install.command, layout.node);
	assert.deepEqual(install.args, [layout.pnpm, "install", "--frozen-lockfile"]);
	// pnpm runs where the version stays: its absolute links (Windows junctions) never dangle.
	assert.equal(install.cwd, result.path);
	assert.equal(install.marker, `installing 4.1.0-1.0.2 ${process.pid}\n`);
	assert.equal(readFileSync(join(result.path, ".gentle-shell-version"), "utf8"), "4.1.0-1.0.2\n");
	assert.equal(realpathSync(join(result.path, "node_modules", "gentle-pi")).startsWith(`${realpathSync(result.path)}/`), true);
	assert.equal(install.env.pnpm_config_store_dir, layout.store);
	const files = distributionFiles(manifest);
	assert.deepEqual(JSON.parse(files["package.json"]).dependencies, { "gentle-pi": "4.1.0", "@earendil-works/pi-coding-agent": "1.0.2" });
	assert.match(files["pnpm-workspace.yaml"], /^allowBuilds:\n {2}gentle-pi: true\nstrictDepBuilds: false\n$/);
	for (const [name, text] of Object.entries({ ...files, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })) assert.equal(readFileSync(join(result.path, name), "utf8"), text, name);
	assert.deepEqual(readdirSync(layout.versions), ["4.1.0-1.0.2"]);
	const again = await installVersion({ layout, manifest, lockfile: "lockfileVersion: '9.0'\n", platform: "darwin", env: {}, adapters: { run: pnpm.run } });
	assert.equal(again.installed, false);
	assert.equal(pnpm.runs.length, 1);
});

posixTest("installVersion rejects a wrong installed version, a foreign folder and an unsafe id, publishing nothing", async () => {
	const { layout } = claimed();
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm({ shell: "4.1.0", pi: "1.0.3" }).run } }), /Pi version/);
	assert.deepEqual(readdirSync(layout.versions), []);
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: () => ({ status: 1, stdout: "", stderr: "ERR_PNPM" }) } }), /pnpm install failed/);
	assert.deepEqual(readdirSync(layout.versions), []);
	// pnpm prints install and postinstall failures on stdout: the error keeps both streams.
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {},
		adapters: { run: () => ({ status: 1, stdout: "postinstall: Gentle AI build failed\n[ELIFECYCLE] exit 1", stderr: "" }) } }),
		(error: Error & { stderr?: string }) => /pnpm install failed \(exit 1\)/.test(error.message) && /Gentle AI build failed/.test(String(error.stderr)));
	assert.deepEqual(readdirSync(layout.versions), []);
	mkdirSync(join(layout.versions, "4.1.0-1.0.2"));
	writeFileSync(join(layout.versions, "4.1.0-1.0.2", "user.txt"), "keep");
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /Conflicting version/);
	assert.equal(readFileSync(join(layout.versions, "4.1.0-1.0.2", "user.txt"), "utf8"), "keep");
	await assert.rejects(installVersion({ layout, manifest: { shell: "../x", pi: "1.0.2" }, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /version/i);
	// A folder whose marker names another version is not ours either.
	writeFileSync(join(layout.versions, "4.1.0-1.0.2", ".gentle-shell-version"), "installing 9.9.9-1.0.0 1\n");
	await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /Conflicting version/);
	assert.equal(readFileSync(join(layout.versions, "4.1.0-1.0.2", "user.txt"), "utf8"), "keep");
});

posixTest("installVersion cleans only its own interrupted install and never one still running", async () => {
	const { layout } = claimed();
	const folder = join(layout.versions, "4.1.0-1.0.2");
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	mkdirSync(join(folder, "node_modules"), { recursive: true });
	writeFileSync(join(folder, ".gentle-shell-version"), `installing 4.1.0-1.0.2 ${dead}\n`);
	writeFileSync(join(folder, "node_modules", "partial"), "crash leftover");
	const result = await installVersion({ layout, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } });
	assert.equal(result.installed, true);
	assert.equal(existsSync(join(folder, "node_modules", "partial")), false);
	assert.equal(readFileSync(join(folder, ".gentle-shell-version"), "utf8"), "4.1.0-1.0.2\n");
	const other = claimed().layout;
	const running = join(other.versions, "4.1.0-1.0.2");
	mkdirSync(running);
	writeFileSync(join(running, ".gentle-shell-version"), `installing 4.1.0-1.0.2 ${process.pid}\n`);
	await assert.rejects(installVersion({ layout: other, manifest, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm().run } }), /in progress/);
	assert.equal(readFileSync(join(running, ".gentle-shell-version"), "utf8"), `installing 4.1.0-1.0.2 ${process.pid}\n`);
	// pruneVersions never counts or deletes an unfinished version.
	assert.deepEqual(pruneVersions(other), []);
	assert.equal(existsSync(running), true);
});

posixTest("installVersion for Windows refuses to run without the pinned Go, so a build never finds the user's go.exe", async () => {
	const { layout } = claimed();
	const pnpm = fakePnpm();
	for (const go of [null, "/usr/local/go/bin/go", join(layout.goRoot, "1.25.14", "go", "bin", "go.exe")]) {
		await assert.rejects(installVersion({ layout, manifest, lockfile: "x", platform: "win32", env: {}, go, adapters: { run: pnpm.run } }), /pinned Go/);
	}
	assert.equal(pnpm.runs.length, 0);
	assert.deepEqual(readdirSync(layout.versions), []);
	const go = join(layout.goRoot, "1.25.14", "go", "bin", "go.exe");
	mkdirSync(posix.dirname(go), { recursive: true });
	writeFileSync(go, "");
	await installVersion({ layout, manifest, lockfile: "x", platform: "win32", env: {}, go, adapters: { run: pnpm.run } });
	assert.equal(pnpm.runs[0].env.Path.split(";")[1], posix.dirname(go));
});

// Rule 5: atomic switch, keep two.
async function installed(layout: ReturnType<typeof prefixLayout>, ids: [string, string][]) {
	for (const [shell, pi] of ids) await installVersion({ layout, manifest: { shell, pi }, lockfile: "x", platform: "darwin", env: {}, adapters: { run: fakePnpm({ shell, pi }).run } });
}
posixTest("activateVersion swaps the current symlink atomically and pruneVersions keeps the active and the previous one", async () => {
	const { layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.1"], ["4.2.0", "1.0.2"]]);
	assert.equal(activeVersion(layout), null);
	for (const id of ["4.0.0-1.0.0", "4.1.0-1.0.1", "4.2.0-1.0.2"]) activateVersion(layout, id);
	assert.equal(readlinkSync(layout.current), "versions/4.2.0-1.0.2");
	assert.equal(activeVersion(layout), "4.2.0-1.0.2");
	mkdirSync(join(layout.versions, "user-folder"));
	assert.deepEqual(pruneVersions(layout), ["4.0.0-1.0.0"]);
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.1.0-1.0.1", "4.2.0-1.0.2", "user-folder"]);
	// Rolling back keeps both.
	activateVersion(layout, "4.1.0-1.0.1");
	assert.deepEqual(pruneVersions(layout), []);
	assert.throws(() => activateVersion(layout, "user-folder"), /not an installed version/);
	assert.throws(() => activateVersion(layout, "../x"), /version/i);
});

posixTest("pruneVersions deletes nothing while current names a version that is not installed", async () => {
	const { layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.1"], ["4.2.0", "1.0.2"]]);
	for (const id of ["4.0.0-1.0.0", "4.1.0-1.0.1"]) activateVersion(layout, id);
	symlinkSync("versions/4.9.0-1.0.9", `${layout.current}.next`);
	renameSync(`${layout.current}.next`, layout.current);
	assert.equal(activeVersion(layout), "4.9.0-1.0.9");
	assert.deepEqual(pruneVersions(layout), []);
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1", "4.2.0-1.0.2"]);
});

posixTest("activateVersion never replaces a current that is not ours and writes a pointer file on Windows layouts", async () => {
	const { layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"]]);
	mkdirSync(layout.current);
	assert.throws(() => activateVersion(layout, "4.0.0-1.0.0"), /Conflicting current/);
	const other = claimed().layout;
	const pointer = { ...other, currentKind: "pointer" };
	await installed(pointer, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.0"]]);
	activateVersion(pointer, "4.0.0-1.0.0");
	activateVersion(pointer, "4.1.0-1.0.0");
	assert.equal(readFileSync(pointer.current, "utf8"), "4.1.0-1.0.0\n");
	assert.equal(activeVersion(pointer), "4.1.0-1.0.0");
	assert.deepEqual(readdirSync(other.root).filter((name) => name.startsWith("current")), ["current"]);
});

// Rule 6: the launcher and the single PATH change.
posixTest("ensureLauncher writes bin/gentle-shell that execs our Node with the current gentle-pi", () => {
	const { layout } = claimed();
	ensureLauncher(layout);
	const text = readFileSync(layout.launcher, "utf8");
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const entry = join(layout.current, "node_modules/gentle-pi/bin/gentle-shell.mjs");
	assert.equal(text, ["#!/bin/sh", "# gentle-shell bundled launcher (generated; do not edit)", `if [ ! -f ${quote(entry)} ]; then`,
		"\techo 'gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.' >&2", "\texit 1", "fi",
		`exec ${quote(layout.node)} ${quote(entry)} "$@"`, ""].join("\n"));
	assert.equal(lstatSync(layout.launcher).mode & 0o777, 0o755);
	// Without an active version it says so; with one it passes every argument and the exit code.
	const missing = spawnSync(layout.launcher, ["x"], { encoding: "utf8" });
	assert.deepEqual([missing.status, missing.stderr], [1, "gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.\n"]);
	mkdirSync(posix.dirname(layout.node), { recursive: true });
	writeFileSync(layout.node, "#!/bin/sh\nprintf '%s|' \"$@\"\nexit 7\n", { mode: 0o700 });
	mkdirSync(join(layout.versions, "v", "node_modules/gentle-pi/bin"), { recursive: true });
	writeFileSync(join(layout.versions, "v", "node_modules/gentle-pi/bin/gentle-shell.mjs"), "");
	symlinkSync("versions/v", layout.current);
	const ran = spawnSync(layout.launcher, ["a b", "$HOME", "'"], { encoding: "utf8" });
	assert.deepEqual([ran.status, ran.stdout], [7, `${entry}|a b|$HOME|'|`]);
	ensureLauncher(layout);
	writeFileSync(layout.launcher, "#!/bin/sh\necho user\n");
	assert.throws(() => ensureLauncher(layout), /Conflicting launcher/);
});

test("ensureLauncher text for Windows reads the current pointer file", async () => {
	const { launcherText } = await import("../scripts/bundled-install.mjs");
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const entry = "%~dp0..\\versions\\%GENTLE_SHELL_CURRENT%\\node_modules\\gentle-pi\\bin\\gentle-shell.mjs";
	assert.equal(launcherText(layout), ["@echo off", "rem gentle-shell bundled launcher (generated; do not edit)", "setlocal DisableDelayedExpansion",
		'set "GENTLE_SHELL_CURRENT="', 'if exist "%~dp0..\\current" set /p GENTLE_SHELL_CURRENT=<"%~dp0..\\current"',
		"if not defined GENTLE_SHELL_CURRENT goto missing", `if not exist "${entry}" goto missing`,
		`"%~dp0..\\runtime\\node-${NODE}\\node.exe" "${entry}" %*`, "exit /b %errorlevel%", ":missing",
		">&2 echo gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.", "exit /b 1", ""].join("\r\n"));
});

posixTest("pathEntryPlan links into ~/.local/bin on PATH, otherwise plans one marked profile line, and both are reversible", () => {
	const { home: user, layout } = claimed();
	ensureLauncher(layout);
	const localBin = join(user, ".local", "bin");
	mkdirSync(localBin, { recursive: true });
	const onPath = pathEntryPlan(layout, { platform: "darwin", env: { PATH: `/usr/bin:${localBin}`, SHELL: "/bin/zsh" }, home: user });
	assert.deepEqual(onPath, { kind: "symlink", path: join(localBin, "gentle-shell"), target: layout.launcher });
	applyPathEntry(onPath);
	assert.equal(readlinkSync(join(localBin, "gentle-shell")), layout.launcher);
	assert.deepEqual(pathEntryPlan(layout, { platform: "darwin", env: { PATH: localBin }, home: user }), { kind: "none" });
	removePathEntry(onPath);
	assert.equal(existsSync(join(localBin, "gentle-shell")), false);

	const zshrc = join(user, ".zshrc");
	writeFileSync(zshrc, "alias ll='ls -l'\n");
	const profile = pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user });
	assert.deepEqual(profile, { kind: "profile", path: zshrc, line: `export PATH="${layout.bin}:$PATH" # gentle-shell bundled install`, create: false });
	const applied = applyPathEntry(profile);
	assert.equal(readFileSync(zshrc, "utf8"), `alias ll='ls -l'\n${profile.line}\n`);
	assert.deepEqual(pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user }), { kind: "none" });
	removePathEntry(applied);
	assert.equal(readFileSync(zshrc, "utf8"), "alias ll='ls -l'\n");
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: "/usr/bin", SHELL: "/bin/bash" }, home: user }).path, join(user, ".bashrc"));
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: "/usr/bin" }, home: user }).path, join(user, ".profile"));
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: "/usr/bin", SHELL: "/bin/zsh", ZDOTDIR: join(user, "zdot") }, home: user }).path, join(user, "zdot", ".zshrc"));
	assert.deepEqual(pathEntryPlan(layout, { platform: "linux", env: { PATH: `/usr/bin:${layout.bin}` }, home: user }), { kind: "none" });
	// Someone else's gentle-shell in ~/.local/bin is never replaced.
	writeFileSync(join(localBin, "gentle-shell"), "user");
	assert.equal(pathEntryPlan(layout, { platform: "linux", env: { PATH: localBin, SHELL: "/bin/bash" }, home: user }).kind, "profile");
});

posixTest("pathEntryPlan never writes through a symlinked, read-only or non-file profile and asks for one manual line instead", () => {
	const { home: user, layout } = claimed();
	const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
	const line = `export PATH="${layout.bin}:$PATH" # gentle-shell bundled install`;
	// stow/chezmoi: the profile is a link into a dotfiles repository.
	const dotfiles = join(posix.dirname(user), "dotfiles");
	mkdirSync(dotfiles);
	writeFileSync(join(dotfiles, "zshrc"), "alias x=y");
	symlinkSync(join(dotfiles, "zshrc"), join(user, ".zshrc"));
	const manual = pathEntryPlan(layout, { platform: "darwin", env, home: user });
	assert.deepEqual(manual, { kind: "manual", path: join(user, ".zshrc"), line, reason: "symlink" });
	applyPathEntry(manual);
	removePathEntry(manual);
	assert.equal(readFileSync(join(dotfiles, "zshrc"), "utf8"), "alias x=y");
	// Once the user added the line, nothing is asked again.
	writeFileSync(join(dotfiles, "zshrc"), `alias x=y\n${line}\n`);
	assert.deepEqual(pathEntryPlan(layout, { platform: "darwin", env, home: user }), { kind: "none" });
	// home-manager: a read-only file; a folder where the profile should be.
	const readOnly = claimed();
	writeFileSync(join(readOnly.home, ".zshrc"), "alias x=y\n");
	chmodSync(join(readOnly.home, ".zshrc"), 0o444);
	assert.equal(pathEntryPlan(readOnly.layout, { platform: "darwin", env, home: readOnly.home }).kind, "manual");
	const folder = claimed();
	mkdirSync(join(folder.home, ".zshrc"));
	assert.equal(pathEntryPlan(folder.layout, { platform: "darwin", env, home: folder.home }).kind, "manual");
	// A fish conf.d reached through a linked ~/.config is not created through the link.
	const fish = claimed();
	mkdirSync(join(dotfiles, "config", "fish", "conf.d"), { recursive: true });
	symlinkSync(join(dotfiles, "config"), join(fish.home, ".config"));
	const fishPlan = pathEntryPlan(fish.layout, { platform: "linux", env: { PATH: "/usr/bin", SHELL: "/usr/bin/fish" }, home: fish.home });
	assert.equal(fishPlan.kind, "manual");
	assert.deepEqual(readdirSync(join(dotfiles, "config", "fish", "conf.d")), []);
});

posixTest("applyPathEntry adds one line after a profile without a final newline, never twice, and removePathEntry restores it exactly", () => {
	const { home: user, layout } = claimed();
	const env = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
	const zshrc = join(user, ".zshrc");
	writeFileSync(zshrc, "alias x=y");
	chmodSync(zshrc, 0o640);
	const plan = pathEntryPlan(layout, { platform: "darwin", env, home: user });
	const applied = applyPathEntry(plan);
	assert.equal(readFileSync(zshrc, "utf8"), `alias x=y\n${plan.line}\n`);
	assert.deepEqual(applyPathEntry(plan), { ...plan, applied: false });
	assert.equal(readFileSync(zshrc, "utf8"), `alias x=y\n${plan.line}\n`);
	removePathEntry(applied);
	assert.equal(readFileSync(zshrc, "utf8"), "alias x=y");
	assert.equal(lstatSync(zshrc).mode & 0o777, 0o640);
	// A profile that turned into a link after planning is never written.
	writeFileSync(join(user, "elsewhere"), "keep");
	const again = pathEntryPlan(layout, { platform: "darwin", env, home: user });
	renameSync(zshrc, join(user, "zshrc.old"));
	symlinkSync(join(user, "elsewhere"), zshrc);
	assert.throws(() => applyPathEntry(again), /changed/);
	assert.equal(readFileSync(join(user, "elsewhere"), "utf8"), "keep");
});

posixTest("pathEntryPlan for bash writes the first file login bash reads and creates ~/.bash_profile only when none exists", () => {
	const bash = (files: string[], platform = "darwin") => {
		const { home: user, layout } = claimed();
		for (const file of files) writeFileSync(join(user, file), "export FROM=user\n");
		return { user, layout, plan: pathEntryPlan(layout, { platform, env: { PATH: "/usr/bin", SHELL: "/bin/bash" }, home: user }) };
	};
	for (const [files, wanted] of [[[".profile"], ".profile"], [[".bash_login", ".profile"], ".bash_login"], [[".bash_profile", ".bash_login", ".profile"], ".bash_profile"]] as [string[], string][]) {
		const { user, plan } = bash(files);
		assert.deepEqual([plan.kind, plan.path, plan.create], ["profile", join(user, wanted), false], wanted);
	}
	// None: ~/.bash_profile is created, and removed again only while it holds nothing else.
	const fresh = bash([]);
	assert.deepEqual([fresh.plan.path, fresh.plan.create], [join(fresh.user, ".bash_profile"), true]);
	removePathEntry(applyPathEntry(fresh.plan));
	assert.equal(existsSync(join(fresh.user, ".bash_profile")), false);
	const kept = bash([]);
	const receipt = applyPathEntry(kept.plan);
	writeFileSync(join(kept.user, ".bash_profile"), "alias l=ls\n", { flag: "a" });
	removePathEntry(receipt);
	assert.equal(readFileSync(join(kept.user, ".bash_profile"), "utf8"), "alias l=ls\n");
	// Interactive non-login bash, what Linux terminals start, reads ~/.bashrc.
	const linux = bash([".profile"], "linux");
	assert.deepEqual([linux.plan.path, linux.plan.create], [join(linux.user, ".bashrc"), true]);
});

test("a login bash still reads the user's ~/.profile after the PATH line is added and removed", { skip: posixHost || (existsSync("/bin/bash") ? false : "no /bin/bash") }, () => {
	const { home: user, layout } = claimed();
	writeFileSync(join(user, ".profile"), "export FROM=profile\n");
	const login = () => {
		const out = spawnSync("/bin/bash", ["-l", "-c", "echo \"[$FROM] $PATH\""], { env: { HOME: user, PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, encoding: "utf8" }).stdout.trim();
		return [out.slice(0, out.indexOf(" ")), out.slice(out.indexOf(" ") + 1)];
	};
	const plan = pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash" }, home: user });
	const receipt = applyPathEntry(plan);
	// macOS's /etc/profile reorders PATH (path_helper): only the pieces are checked.
	const [from, path] = login();
	assert.deepEqual([from, path.split(":").includes(layout.bin)], ["[profile]", true]);
	removePathEntry(receipt);
	const [after, restored] = login();
	assert.deepEqual([after, restored.split(":").includes(layout.bin)], ["[profile]", false]);
	assert.deepEqual(readdirSync(user).filter((name) => name.startsWith(".bash")), []);
});

test("pathEntryPlan on Windows plans one HKCU Path entry applied through an injected adapter", () => {
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const plan = pathEntryPlan(layout, { platform: "win32", env: { Path: "C:\\Windows" }, home: "C:\\U" });
	assert.deepEqual(plan, { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\L\\gentle-shell\\bin" });
	assert.deepEqual(pathEntryPlan(layout, { platform: "win32", env: { PATH: "C:\\Windows;c:\\l\\gentle-shell\\bin\\" }, home: "C:\\U" }), { kind: "none" });
	const registry: string[] = [];
	applyPathEntry(plan, { registry: { add: (entry: string) => registry.push(`+${entry}`), remove: (entry: string) => registry.push(`-${entry}`) } });
	removePathEntry(plan, { registry: { add: () => {}, remove: (entry: string) => registry.push(`-${entry}`) } });
	assert.deepEqual(registry, ["+C:\\L\\gentle-shell\\bin", "-C:\\L\\gentle-shell\\bin"]);
	assert.throws(() => applyPathEntry(plan), /registry adapter/);
});

// T6 (S7): uninstall reverts exactly what was applied, and nothing when nothing was.
test("removePathEntry leaves the PATH alone for a receipt that applied nothing, and applyPathEntry applies nothing when the user Path already held the entry", () => {
	const layout = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" });
	const plan = pathEntryPlan(layout, { platform: "win32", env: { Path: "C:\\Windows" }, home: "C:\\U" });
	const calls: string[] = [];
	const registry = (added: string | undefined) => ({ add: (entry: string) => { calls.push(`+${entry}`); return added; }, remove: (entry: string) => { calls.push(`-${entry}`); } });
	assert.deepEqual(applyPathEntry(plan, { registry: registry("present") }), { ...plan, applied: false });
	assert.deepEqual(applyPathEntry(plan, { registry: registry("added") }), { ...plan, applied: true });
	removePathEntry({ ...plan, applied: false }, { registry: registry(undefined) });
	assert.deepEqual(calls, ["+C:\\L\\gentle-shell\\bin", "+C:\\L\\gentle-shell\\bin"]);
});

posixTest("removePathEntry keeps a profile line and a link that a receipt says were already there", () => {
	const { home: user, layout } = claimed();
	ensureLauncher(layout);
	const zshrc = join(user, ".zshrc");
	const plan = pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user });
	writeFileSync(zshrc, `${plan.line}\n`);
	const receipt = applyPathEntry({ ...plan, create: false });
	assert.equal(receipt.applied, false);
	removePathEntry(receipt);
	assert.equal(readFileSync(zshrc, "utf8"), `${plan.line}\n`);
	const link = join(user, ".local", "bin", "gentle-shell");
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(layout.launcher, link);
	removePathEntry({ kind: "symlink", path: link, target: layout.launcher, applied: false });
	assert.equal(readlinkSync(link), layout.launcher);
});

posixTest("writePathReceipt keeps only an applied receipt in the prefix, private and replaced whole, and readPathReceipt accepts only this install's entry", () => {
	const { home: user, layout } = claimed();
	const env = { SHELL: "/bin/zsh" };
	const line = `export PATH="${layout.bin}:$PATH" # gentle-shell bundled install`;
	const profile = { kind: "profile", path: join(user, ".zshrc"), line, create: true };
	assert.equal(layout.pathReceipt, join(layout.root, "path-entry.json"));
	assert.deepEqual(readPathReceipt(layout, { env, home: user }), { status: "none" });
	assert.equal(writePathReceipt(layout, { ...profile, applied: false }), false);
	assert.equal(existsSync(layout.pathReceipt), false);
	assert.equal(writePathReceipt(layout, { ...profile, applied: true, separator: false }), true);
	assert.equal(lstatSync(layout.pathReceipt).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(readFileSync(layout.pathReceipt, "utf8")), { schema: 1, ...profile, separator: false });
	assert.deepEqual(readPathReceipt(layout, { env, home: user }), { status: "recorded", receipt: { ...profile, separator: false, applied: true } });
	assert.match(describePathReceipt({ ...profile, separator: false, applied: true }), new RegExp(`${line.replace(/[$"]/g, "\\$&")}.*\\.zshrc`));
	const link = { kind: "symlink", path: join(user, ".local", "bin", "gentle-shell"), target: layout.launcher };
	writePathReceipt(layout, { ...link, applied: true });
	assert.deepEqual(readPathReceipt(layout, { env, home: user }), { status: "recorded", receipt: { ...link, applied: true } });
	assert.deepEqual(readdirSync(layout.root).filter((name) => name.includes("path-entry")), ["path-entry.json"]);
	// Anything this prefix did not write is never acted on.
	const foreign = [
		{ ...link, target: "/usr/local/bin/gentle-shell" },
		{ ...profile, line: "export PATH=\"/opt/x:$PATH\" # gentle-shell bundled install", separator: false },
		{ ...profile, path: "relative/.zshrc", separator: false },
		{ kind: "registry", key: "HKCU\\Environment", name: "Path", entry: "C:\\Windows" },
		{ kind: "none" },
	];
	for (const receipt of foreign) {
		writeFileSync(layout.pathReceipt, JSON.stringify({ schema: 1, ...receipt }));
		assert.equal(readPathReceipt(layout, { env, home: user }).status, "invalid", JSON.stringify(receipt));
	}
	for (const text of ["{", JSON.stringify({ schema: 2, ...link }), "[]"]) {
		writeFileSync(layout.pathReceipt, text);
		assert.equal(readPathReceipt(layout, { env, home: user }).status, "invalid", text);
	}
	rmSync(layout.pathReceipt);
	symlinkSync(join(user, ".zshrc"), layout.pathReceipt);
	assert.equal(readPathReceipt(layout, { env, home: user }).status, "invalid");
});

// A1 (T6 verifier): a receipt is trusted only for a file or link the PATH plan
// itself can choose for this user; a forged one is named, never acted on.
posixTest("readPathReceipt accepts a profile line only in a startup file the PATH plan can choose, and a link only at ~/.local/bin/gentle-shell", () => {
	const { home: user, layout } = claimed();
	const { sh, fish } = { sh: `export PATH="${layout.bin}:$PATH" # gentle-shell bundled install`, fish: `set -gx PATH '${layout.bin}' $PATH # gentle-shell bundled install` };
	const read = (receipt: Record<string, unknown>, env: Record<string, string> = {}, platform = "darwin") => {
		writeFileSync(layout.pathReceipt, JSON.stringify({ schema: 1, create: false, separator: false, ...receipt }));
		return readPathReceipt({ ...layout, platform }, { env, home: user }).status;
	};
	// Every file pathEntryPlan picks, per shell, on macOS and Linux.
	for (const name of [".zshrc", ".bash_profile", ".bash_login", ".profile"]) assert.equal(read({ kind: "profile", path: join(user, name), line: sh }), "recorded", name);
	assert.equal(read({ kind: "profile", path: join(user, ".bashrc"), line: sh }, {}, "linux"), "recorded");
	assert.equal(read({ kind: "profile", path: join(user, ".config", "fish", "conf.d", "gentle-shell.fish"), line: fish }), "recorded");
	// ZDOTDIR and XDG_CONFIG_HOME move the zsh and fish files exactly as the plan moves them.
	const zdot = join(user, "zdot");
	const xdg = join(user, "xdg");
	assert.equal(read({ kind: "profile", path: join(zdot, ".zshrc"), line: sh }, { ZDOTDIR: zdot }), "recorded");
	assert.equal(read({ kind: "profile", path: join(user, ".zshrc"), line: sh }, { ZDOTDIR: zdot }), "invalid");
	assert.equal(read({ kind: "profile", path: join(xdg, "fish", "conf.d", "gentle-shell.fish"), line: fish }, { XDG_CONFIG_HOME: xdg }), "recorded");
	// E1: our exact line, but in a file the plan never edits on this system; E2: a created file elsewhere.
	assert.equal(read({ kind: "profile", path: join(user, ".bashrc"), line: sh }), "invalid");
	assert.equal(read({ kind: "profile", path: join(user, "dotfiles", "path.sh"), line: sh, create: true }), "invalid");
	assert.equal(read({ kind: "profile", path: join(user, ".zshenv"), line: sh }), "invalid");
	// The fish line belongs only in the fish file, the sh line only in sh files.
	assert.equal(read({ kind: "profile", path: join(user, ".zshrc"), line: fish }), "invalid");
	assert.equal(read({ kind: "profile", path: join(user, ".config", "fish", "conf.d", "gentle-shell.fish"), line: sh }), "invalid");
	// The link: only ~/.local/bin/gentle-shell to our launcher.
	assert.equal(read({ kind: "symlink", path: join(user, ".local", "bin", "gentle-shell"), target: layout.launcher }), "recorded");
	assert.equal(read({ kind: "symlink", path: join(user, "bin", "gentle-shell"), target: layout.launcher }), "invalid");
	// The bundled self-uninstall, given the forged receipts, leaves both files as they are.
	const bashrc = join(user, ".bashrc");
	const dotfile = join(user, "dotfiles", "path.sh");
	mkdirSync(dirname(dotfile), { recursive: true });
	writeFileSync(bashrc, `alias l=ls\n${sh}\n`);
	writeFileSync(dotfile, `${sh}\n`);
	const forged = readPathReceipt(layout, { env: { SHELL: "/bin/zsh" }, home: user });
	assert.equal(forged.status, "invalid");
	assert.match(forged.status === "invalid" ? forged.reason : "", /does not describe this install's PATH entry/);
	assert.deepEqual([readFileSync(bashrc, "utf8"), readFileSync(dotfile, "utf8")], [`alias l=ls\n${sh}\n`, `${sh}\n`]);
});

// A2: a line the user edited is kept, and the caller learns which file still holds what.
posixTest("removePathEntry reports a profile line it could not find and a link that no longer points at our launcher", () => {
	const { home: user, layout } = claimed();
	const zshrc = join(user, ".zshrc");
	writeFileSync(zshrc, "alias x=y\n");
	const receipt = applyPathEntry(pathEntryPlan(layout, { platform: "darwin", env: { PATH: "/usr/bin", SHELL: "/bin/zsh" }, home: user }));
	const edited = `export PATH="$PATH:${layout.bin}" # gentle-shell bundled install`;
	writeFileSync(zshrc, `alias x=y\n${edited}\n`);
	const kept = removePathEntry(receipt);
	assert.equal(readFileSync(zshrc, "utf8"), `alias x=y\n${edited}\n`);
	assert.equal(kept.removed, false);
	assert.ok(kept.note.includes(zshrc) && kept.note.includes(edited), kept.note);
	writeFileSync(zshrc, `alias x=y\n${receipt.line}\n`);
	assert.deepEqual(removePathEntry(receipt), { removed: true });
	const link = join(user, ".local", "bin", "gentle-shell");
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync("/usr/local/bin/other", link);
	const other = removePathEntry({ kind: "symlink", path: link, target: layout.launcher, applied: true });
	assert.equal(other.removed, false);
	assert.ok(other.note.includes(link), other.note);
	assert.equal(readlinkSync(link), "/usr/local/bin/other");
});

test("readPathReceipt accepts the Windows user Path entry of this prefix only", (t) => {
	// Path arithmetic only: the receipt file itself lives in a real temporary folder.
	const folder = home();
	const layout = { ...prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L", USERPROFILE: "C:\\U" }, home: "C:\\U" }), pathReceipt: join(folder, "path-entry.json") };
	const entry = { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: layout.bin };
	writeFileSync(layout.pathReceipt, JSON.stringify({ schema: 1, ...entry }));
	assert.deepEqual(readPathReceipt(layout, { env: {}, home: "C:\\U" }), { status: "recorded", receipt: { ...entry, applied: true } });
	assert.match(describePathReceipt({ ...entry, applied: true }), /C:\\L\\gentle-shell\\bin in your user Path/);
	writeFileSync(layout.pathReceipt, JSON.stringify({ schema: 1, ...entry, key: "HKLM\\Environment" }));
	assert.equal(readPathReceipt(layout, { env: {}, home: "C:\\U" }).status, "invalid");
	t.diagnostic("simulated Windows layout, real receipt file");
});

// T6: the running node.exe and .cmd launcher cannot delete themselves; a detached
// Windows PowerShell removes them once this process exits, with every path as data.
test("scheduleWindowsRemoval starts one detached Windows PowerShell that waits for the process, with the paths only in its environment", () => {
	const calls: { command: string; args: string[]; options: Record<string, any> }[] = [];
	let unref = false;
	const spawn = (command: string, args: string[], options: Record<string, any>) => { calls.push({ command, args, options }); return { unref: () => { unref = true; } }; };
	const files = ["C:\\L\\gentle shell's $x;\\runtime\\node-24.21.0\\node.exe", "C:\\L\\gentle shell's $x;\\bin\\gentle-shell.cmd"];
	const directories = ["C:\\L\\gentle shell's $x;\\runtime\\node-24.21.0", "C:\\L\\gentle shell's $x;"];
	const last = "C:\\L\\gentle shell's $x;\\.gentle-shell-bundle";
	scheduleWindowsRemoval({ pid: 4242, files, last, directories, env: { SystemRoot: "C:\\Windows", Path: "C:\\Windows" }, spawn });
	assert.equal(calls.length, 1);
	const [{ command, args, options }] = calls;
	// cmd.exe, detached, starts PowerShell with `start`: a detached PowerShell never ran on
	// the Windows runner, and one in Node's job object died with the exiting launcher.
	assert.equal(command, "C:\\Windows\\System32\\cmd.exe");
	assert.deepEqual(args.slice(0, 6), ["/d", "/c", "start", "\"\"", "/min", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
	const shellArgs = args.slice(6);
	// Only fixed tokens and base64 reach cmd's command line: no cmd metacharacter.
	assert.equal(shellArgs.every((arg) => /^[-A-Za-z0-9+/=]+$/.test(arg)), true);
	// The script travels base64-encoded (UTF-16LE): Windows PowerShell 5.1 does not
	// read Node's escaped quotes in a -Command argument, so a plain script arrives broken.
	assert.deepEqual(shellArgs.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
	assert.equal(shellArgs.length, 7);
	const script = Buffer.from(shellArgs[6], "base64").toString("utf16le");
	assert.match(script, /Wait-Process -Id \$waitFor/);
	assert.match(script, /GENTLE_SHELL_REMOVE_FILES/);
	// A4: the marker goes only once every listed file is gone, so a retry still finds the install.
	assert.match(script, /GENTLE_SHELL_REMOVE_LAST/);
	assert.equal(options.env.GENTLE_SHELL_REMOVE_LAST, last);
	for (const path of [...files, ...directories]) assert.equal(args.join(" ").includes(path), false, path);
	assert.deepEqual([options.detached, options.stdio, options.windowsHide, options.cwd, unref], [true, "ignore", true, "C:\\Windows", true]);
	assert.deepEqual([options.env.GENTLE_SHELL_REMOVE_AFTER_PID, options.env.GENTLE_SHELL_REMOVE_FILES, options.env.GENTLE_SHELL_REMOVE_DIRECTORIES, options.env.Path],
		["4242", files.join("\n"), directories.join("\n"), "C:\\Windows"]);
	for (const bad of [{ pid: 0 }, { files: ["relative\\node.exe"] }, { directories: ["\\\\server\\share"] }, { env: {} }, { last: "relative\\marker" },
		// SystemRoot reaches cmd's command line (the PowerShell path): a cmd metacharacter refuses.
		{ env: { SystemRoot: "C:\\Win&calc" } }, { env: { SystemRoot: "C:\\Win%PATH%" } }, { env: { SystemRoot: "C:\\Win^x" } }, { env: { SystemRoot: "C:\\Win\"x" } }]) {
		assert.throws(() => scheduleWindowsRemoval({ pid: 4242, files, directories, env: { SystemRoot: "C:\\Windows" }, spawn, ...bad }), /deferred removal/, JSON.stringify(bad));
	}
	assert.equal(calls.length, 1);
});

// Rule 6 (T1c): Pi installs its packages with npm, so our npm comes from the same verified Node archive.
test("nodeRuntimeFiles takes node.exe, npm and its .cmd shims from the Windows zip, and node plus npm with our wrappers from the tarball", () => {
	const stem = `node-v${NODE}-win-x64`;
	const descriptor = { url: `https://nodejs.org/dist/v${NODE}/${stem}.zip` };
	const archive = zip([[`${stem}/node.exe`, Buffer.from("MZ")], [`${stem}/npm.cmd`, Buffer.from("npm cmd")], [`${stem}/npx.cmd`, Buffer.from("npx cmd")],
		[`${stem}/npm.ps1`, Buffer.from("ps")], [`${stem}/corepack.cmd`, Buffer.from("corepack")], [`${stem}/node_modules/npm/`, Buffer.alloc(0)],
		[`${stem}/node_modules/npm/package.json`, Buffer.from(JSON.stringify({ name: "npm", version: NPM }))],
		[`${stem}/node_modules/npm/bin/npm-cli.js`, Buffer.from("cli")], [`${stem}/node_modules/corepack/package.json`, Buffer.from("{}")]]);
	const files = nodeRuntimeFiles(archive, descriptor);
	assert.deepEqual(files.map((file: { name: string }) => file.name).sort(),
		["node.exe", "node_modules/npm/bin/npm-cli.js", "node_modules/npm/package.json", "npm.cmd", "npx.cmd"]);
	assert.equal(files.npm, NPM);
	// No npm in the archive, or a member escaping the runtime folder, rejects the whole archive.
	assert.throws(() => nodeRuntimeFiles(zip([[`${stem}/node.exe`, Buffer.from("MZ")]]), descriptor), /Node archive/);
	assert.throws(() => nodeRuntimeFiles(zip([[`${stem}/node.exe`, Buffer.from("MZ")], [`${stem}/node_modules/npm/package.json`, Buffer.from(JSON.stringify({ name: "npm", version: NPM }))],
		[`${stem}/node_modules/npm/bin/npm-cli.js`, Buffer.from("cli")], [`${stem}/node_modules/npm/../../evil.js`, Buffer.from("x")]]), descriptor), /Node archive/);
	const tarball = nodeRuntimeFiles(nodeArchive, { url: `https://nodejs.org/dist/v${NODE}/${nodeStem}.tar.gz` });
	assert.deepEqual(tarball.map((file: { name: string }) => file.name).sort(), ["bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm/bin/npm-cli.js",
		"lib/node_modules/npm/bin/npx-cli.js", "lib/node_modules/npm/package.json"]);
	assert.deepEqual(tarball.filter((file: { executable: boolean }) => file.executable).map((file: { name: string }) => file.name).sort(),
		["bin/node", "bin/npm", "bin/npx", "lib/node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npx-cli.js"]);
});

// S12: only the network, registry and authentication keys of the user's npmrc.
test("filterNpmrc keeps registries, per-host credentials, proxies and TLS keys and drops everything else", () => {
	const text = [
		"; a comment", "# another", "registry=https://registry.example.com/", "@acme:registry = https://npm.acme.dev/",
		"//npm.acme.dev/:_authToken=${ACME_TOKEN}", "//registry.example.com/:_auth=dXNlcjpwYXNz", "//host:8443/path/:username=me",
		"//host:8443/path/:_password=c2VjcmV0", "//host:8443/path/:certfile=/certs/me.pem", "//host:8443/path/:keyfile=/certs/me.key",
		"proxy=http://proxy:3128", "https-proxy=http://proxy:3128", "noproxy=localhost", "no-proxy=.internal", "ca=\"-----BEGIN CERTIFICATE-----\"",
		"ca[]=second", "cafile=/certs/ca.pem", "strict-ssl=false", "\"//quoted.example/:_authToken\"=tok",
		"prefix=/home/me/.npm-global", "cache=/tmp/cache", "ignore-scripts=true", "save-exact=true", "_authToken=legacy", "//h/:always-auth=true",
		"node-options=--require /x.js", "script-shell=/bin/zsh", "global=true", "not a key", "=value", "",
		"[section]", "registry=https://inside-a-section.example/",
	].join("\r\n");
	assert.equal(filterNpmrc(text), [
		"registry=https://registry.example.com/", "@acme:registry = https://npm.acme.dev/", "//npm.acme.dev/:_authToken=${ACME_TOKEN}",
		"//registry.example.com/:_auth=dXNlcjpwYXNz", "//host:8443/path/:username=me", "//host:8443/path/:_password=c2VjcmV0",
		"//host:8443/path/:certfile=/certs/me.pem", "//host:8443/path/:keyfile=/certs/me.key", "proxy=http://proxy:3128", "https-proxy=http://proxy:3128",
		"noproxy=localhost", "no-proxy=.internal", "ca=\"-----BEGIN CERTIFICATE-----\"", "ca[]=second", "cafile=/certs/ca.pem", "strict-ssl=false",
		"\"//quoted.example/:_authToken\"=tok", "",
	].join("\n"));
	assert.equal(filterNpmrc(""), "");
	assert.equal(filterNpmrc("save-exact=true\n"), "");
});

posixTest("writeNpmrcAuth writes the filtered npmrc 0600 inside the prefix; userNpmrc reads NPM_CONFIG_USERCONFIG, then ~/.npmrc", () => {
	const { home: user, layout } = claimed();
	assert.equal(userNpmrc({ platform: "darwin", env: {}, home: user }), "");
	writeFileSync(join(user, ".npmrc"), "registry=https://home.example/\nsave-exact=true\n");
	const custom = join(user, "custom.npmrc");
	writeFileSync(custom, "registry=https://custom.example/\n");
	assert.equal(userNpmrc({ platform: "darwin", env: {}, home: user }), "registry=https://home.example/\nsave-exact=true\n");
	assert.equal(userNpmrc({ platform: "darwin", env: { npm_config_userconfig: custom }, home: user }), "registry=https://custom.example/\n");
	assert.equal(userNpmrc({ platform: "darwin", env: { NPM_CONFIG_USERCONFIG: custom }, home: user }), "registry=https://custom.example/\n");
	writeNpmrcAuth(layout, userNpmrc({ platform: "darwin", env: {}, home: user }));
	assert.equal(readFileSync(layout.npmrc, "utf8"), "registry=https://home.example/\n");
	assert.equal(lstatSync(layout.npmrc).mode & 0o777, 0o600);
	writeNpmrcAuth(layout, "");
	assert.equal(readFileSync(layout.npmrc, "utf8"), "");
});

test("pnpmEnvironment keeps the variables the prefix npmrc references and still drops npm settings", () => {
	const user = home();
	const layout = prefixLayout({ platform: "linux", env: {}, home: user });
	mkdirSync(join(layout.root, "pnpm", "config"), { recursive: true });
	writeFileSync(layout.npmrc, "//npm.acme.dev/:_authToken=${NPM_TOKEN}\n//h/:_auth=${npm_config_x}\n");
	const env = pnpmEnvironment(layout, { platform: "linux", env: { PATH: "/usr/bin", NPM_TOKEN: "secret", NPM_OTHER: "o", npm_config_x: "x",
		npm_config_cache: "/home/me/.npm" } });
	// ${NPM_TOKEN} is expanded by pnpm from the environment, so it survives; npm settings and unreferenced npm_* never do.
	assert.equal(env.NPM_TOKEN, "secret");
	for (const key of ["NPM_OTHER", "npm_config_x", "npm_config_cache", "npm_config_userconfig", "npm_config_prefix"]) assert.equal(env[key], undefined, key);
});

test("setupEnvironment runs setup with our Node and npm, then the version's Pi, and keeps the user's XDG folders", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const env = setupEnvironment(layout, { platform: "linux", id: "4.1.0-1.0.2", env: { PATH: "/usr/local/bin:/usr/bin", HOME: "/home/me",
		XDG_CONFIG_HOME: "/home/me/.config", npm_config_registry: "https://user.example", NODE_OPTIONS: "--require /x.js", PNPM_HOME: "/p",
		GENTLE_BOOTSTRAP_TOOLS: "/t", GENTLE_INSTALL_PNPM_ENTRY: "/e", NPM_TOKEN: "t" } });
	const root = "/home/me/.gentle-shell";
	assert.equal(env.PATH, `${root}/runtime/node-${NODE}/bin:${root}/versions/4.1.0-1.0.2/node_modules/.bin:/usr/local/bin:/usr/bin`);
	assert.equal(env.XDG_CONFIG_HOME, "/home/me/.config");
	// npm reads the filtered prefix npmrc and writes its global prefix and cache inside the prefix.
	assert.equal(env.npm_config_userconfig, `${root}/pnpm/config/npmrc`);
	assert.equal(env.npm_config_globalconfig, `${root}/npm/npmrc`);
	assert.equal(env.npm_config_prefix, `${root}/npm/prefix`);
	assert.equal(env.npm_config_cache, `${root}/npm/cache`);
	assert.equal(env.npm_config_update_notifier, "false");
	for (const key of ["npm_config_registry", "NODE_OPTIONS", "PNPM_HOME", "GENTLE_BOOTSTRAP_TOOLS", "GENTLE_INSTALL_PNPM_ENTRY"]) assert.equal(env[key], undefined, key);
	assert.equal(env.NPM_TOKEN, "t");
	assert.equal(env.HOME, "/home/me");
	const windows = setupEnvironment(prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" }),
		{ platform: "win32", id: "4.1.0-1.0.2", env: { Path: "C:\\Windows" } });
	assert.equal(windows.Path, `C:\\L\\gentle-shell\\runtime\\node-${NODE};C:\\L\\gentle-shell\\versions\\4.1.0-1.0.2\\node_modules\\.bin;C:\\Windows`);
	assert.throws(() => setupEnvironment(layout, { platform: "linux", id: "../x", env: {} }), /Unsafe version id/);
});

// T2 (S5, S6, S8): `gentle-shell upgrade` in a bundled install.
const LATEST = { shell: "4.2.0", pi: "1.0.2" };
const releaseModuleFile = (layout: ReturnType<typeof prefixLayout>, id: string) => join(layout.versions, id, "node_modules", "gentle-pi", "scripts", "bundled-install.mjs");
function upgradeAdapters(layout: ReturnType<typeof prefixLayout>, { release = LATEST, status = "published", reported = release, module = {} as Record<string, unknown> } = {}) {
	const calls: { ensureRuntime: unknown[]; verify: { command: string; args: string[]; env: Record<string, string> }[]; loaded: string[]; launchers: unknown[] } =
		{ ensureRuntime: [], verify: [], loaded: [], launchers: [] };
	const releaseModule = { prefixLayout, ensureRuntime: async (options: unknown) => { calls.ensureRuntime.push(options); return { go: null }; },
		ensureLauncher: (next: unknown) => { calls.launchers.push(next); return { written: false }; }, ...module };
	const adapters = {
		latest: async () => release.shell,
		distribution: async (version: string) => (status === "published" ? { status, manifest: { ...release, shell: version }, lockfile: "lockfileVersion: '9.0'\n" } : { status }),
		ensureRuntime: async (options: unknown) => { calls.ensureRuntime.push(options); return { go: null }; },
		install: { run: fakePnpm(release).run },
		load: async (file: string) => { calls.loaded.push(file); return releaseModule; },
		run: async (command: string, args: string[], options: { env: Record<string, string> }) => {
			calls.verify.push({ command, args, env: options.env });
			return { status: 0, stdout: `gentle-shell ${reported.shell}\npi ${reported.pi}\nhome isolated /x\n`, stderr: "" };
		},
	};
	return { adapters, calls };
}
async function activeInstall() {
	const { home: user, layout } = claimed();
	await installed(layout, [["4.0.0", "1.0.0"], ["4.1.0", "1.0.1"]]);
	for (const id of ["4.0.0-1.0.0", "4.1.0-1.0.1"]) activateVersion(layout, id);
	return { user, layout };
}

posixTest("upgradeBundled installs the latest release beside the active one, verifies it, switches current and keeps two", async () => {
	const { user, layout } = await activeInstall();
	const { adapters, calls } = upgradeAdapters(layout);
	const lines: string[] = [];
	const result = await upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: { PATH: "/usr/bin", GENTLE_SHELL_PI: "/x/pi", PI_CODING_AGENT_DIR: "/x" },
		adapters, out: (line: string) => lines.push(line) });
	assert.deepEqual(result, { id: "4.2.0-1.0.2", changed: true, previous: "4.1.0-1.0.1", removed: ["4.0.0-1.0.0"] });
	assert.equal(activeVersion(layout), "4.2.0-1.0.2");
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.1.0-1.0.1", "4.2.0-1.0.2"]);
	// Only the freshly installed version's own module is loaded.
	assert.deepEqual(calls.loaded, [releaseModuleFile(layout, "4.2.0-1.0.2")]);
	const [verify] = calls.verify;
	assert.equal(verify.command, layout.node);
	assert.deepEqual(verify.args, [join(layout.versions, "4.2.0-1.0.2", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs"), "--version"]);
	assert.equal(verify.env.GENTLE_SHELL_PI, undefined);
	assert.equal(verify.env.PI_CODING_AGENT_DIR, undefined);
	// The check runs that version in bundled mode, as if current named it (only for --version).
	assert.equal(verify.env.GENTLE_SHELL_VERIFY_VERSION, "4.2.0-1.0.2");
	assert.match(lines.join("\n"), /Gentle Shell 4\.2\.0 with Pi 1\.0\.2.*4\.1\.0-1\.0\.1.*--rollback/s);
});

posixTest("upgradeBundled changes nothing when the latest release is already current", async () => {
	const { user, layout } = await activeInstall();
	const { adapters, calls } = upgradeAdapters(layout, { release: { shell: "4.1.0", pi: "1.0.1" } });
	const lines: string[] = [];
	const result = await upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters, out: (line: string) => lines.push(line) });
	assert.deepEqual(result, { id: "4.1.0-1.0.1", changed: false });
	assert.deepEqual([calls.ensureRuntime.length, calls.verify.length, calls.loaded.length], [0, 0, 0]);
	assert.match(lines.join("\n"), /Gentle Shell 4\.1\.0 with Pi 1\.0\.1 is already current/);
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1"]);
});

posixTest("upgradeBundled leaves current untouched when the release is unpublished or its verification fails", async () => {
	const { user, layout } = await activeInstall();
	for (const status of ["missing", "unavailable", "rejected"]) {
		await assert.rejects(upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters: upgradeAdapters(layout, { status }).adapters }), /v4\.2\.0/);
	}
	const wrong = upgradeAdapters(layout, { reported: { shell: "4.2.0", pi: "1.0.0" } });
	await assert.rejects(upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters: wrong.adapters }), /reported/);
	assert.equal(activeVersion(layout), "4.1.0-1.0.1");
	// The version this upgrade installed and could not verify is removed again.
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1"]);
});

posixTest("upgradeBundled fails closed when the new version's own module is missing or lacks an export it needs", async () => {
	const { user, layout } = await activeInstall();
	for (const module of [{ ensureLauncher: undefined }, { prefixLayout: "not a function" }]) {
		const { adapters, calls } = upgradeAdapters(layout, { module });
		await assert.rejects(upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters }), /4\.2\.0-1\.0\.2.*bundled-install\.mjs/s);
		assert.equal(calls.verify.length, 0);
	}
	const absent = upgradeAdapters(layout);
	await assert.rejects(upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters: { ...absent.adapters, load: undefined } }), /bundled-install\.mjs/);
	assert.equal(activeVersion(layout), "4.1.0-1.0.1");
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1"]);
});

posixTest("upgradeBundled installs a new release's own pinned runtime and launcher when its pins moved", async () => {
	const { user, layout } = await activeInstall();
	const next = { ...layout, node: join(layout.runtime, "node-26.0.0", "bin", "node") };
	const { adapters, calls } = upgradeAdapters(layout, { module: { prefixLayout: (options: { root: string; home: string }) => {
		assert.deepEqual([options.root, options.home], [layout.root, user]);
		return next;
	} } });
	await upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters });
	// Ours first (the install runs on it), then the release's own, before verification runs on its Node.
	assert.equal(calls.ensureRuntime.length, 2);
	assert.equal((calls.ensureRuntime[1] as { layout: unknown }).layout, next);
	// The release's own runtime includes its pinned Engram (S9); an older release module ignores the flag.
	assert.deepEqual(calls.ensureRuntime.map((options) => (options as { engram?: boolean }).engram), [undefined, true]);
	assert.equal(calls.verify[0].command, next.node);
	assert.deepEqual(calls.launchers, [next]);
	assert.equal(activeVersion(layout), "4.2.0-1.0.2");
});

posixTest("upgradeBundled puts current back when the new launcher cannot be written", async () => {
	const { user, layout } = await activeInstall();
	const { adapters } = upgradeAdapters(layout, { module: { ensureLauncher: () => { throw new Error("Conflicting launcher: /x"); } } });
	await assert.rejects(upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters }), /launcher.*current stays at 4\.1\.0-1\.0\.1/s);
	assert.equal(activeVersion(layout), "4.1.0-1.0.1");
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1"]);
});

posixTest("upgradeBundled reports success with a warning when only pruning fails", async () => {
	const { user, layout } = await activeInstall();
	const { adapters } = upgradeAdapters(layout);
	const lines: string[] = [];
	const result = await upgradeBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters: { ...adapters, prune: () => { throw new Error("EBUSY"); } },
		out: (line: string) => lines.push(line) });
	assert.deepEqual(result, { id: "4.2.0-1.0.2", changed: true, previous: "4.1.0-1.0.1", removed: [], warning: "older versions were not removed (EBUSY)" });
	assert.equal(activeVersion(layout), "4.2.0-1.0.2");
	assert.match(lines.join("\n"), /Upgraded to Gentle Shell 4\.2\.0.*warning: older versions were not removed \(EBUSY\)/s);
});

function rollbackAdapters(module: Record<string, unknown> = {}) {
	const calls: { loaded: string[]; runtimes: unknown[]; engram: unknown[]; launchers: unknown[] } = { loaded: [], runtimes: [], engram: [], launchers: [] };
	const releaseModule = { prefixLayout, ensureRuntime: async (options: { layout: unknown; engram?: boolean }) => {
		calls.runtimes.push(options.layout); calls.engram.push(options.engram); return { go: null }; },
		ensureLauncher: (next: unknown) => { calls.launchers.push(next); return { written: true }; }, ...module };
	return { calls, adapters: { load: async (file: string) => { calls.loaded.push(file); return releaseModule; } } };
}

posixTest("rollbackBundled switches current to the kept previous version with its own launcher, and back", async () => {
	const { user, layout } = await activeInstall();
	const { calls, adapters } = rollbackAdapters();
	const options = { layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters };
	assert.deepEqual(await rollbackBundled(options), { from: "4.1.0-1.0.1", to: "4.0.0-1.0.0" });
	assert.equal(activeVersion(layout), "4.0.0-1.0.0");
	assert.deepEqual(calls.loaded, [releaseModuleFile(layout, "4.0.0-1.0.0")]);
	assert.equal(calls.runtimes.length, 1);
	assert.equal(calls.engram[0], true, "the target's runtime includes its pinned Engram");
	assert.equal(calls.launchers.length, 1);
	assert.deepEqual(await rollbackBundled(options), { from: "4.0.0-1.0.0", to: "4.1.0-1.0.1" });
	assert.equal(calls.loaded[1], releaseModuleFile(layout, "4.1.0-1.0.1"));
	const single = claimed();
	await installed(single.layout, [["4.0.0", "1.0.0"]]);
	activateVersion(single.layout, "4.0.0-1.0.0");
	await assert.rejects(rollbackBundled({ ...options, layout: single.layout, home: single.home }), /No previous Gentle Shell version/);
	assert.equal(activeVersion(single.layout), "4.0.0-1.0.0");
});

posixTest("rollbackBundled fails closed without the target's own module and puts current back when its launcher fails", async () => {
	const { user, layout } = await activeInstall();
	for (const module of [{ ensureLauncher: undefined }, { ensureRuntime: 1 }]) {
		const { calls, adapters } = rollbackAdapters(module);
		await assert.rejects(rollbackBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters }), /4\.0\.0-1\.0\.0.*bundled-install\.mjs/s);
		assert.equal(calls.launchers.length, 0);
		assert.equal(activeVersion(layout), "4.1.0-1.0.1");
	}
	// The real loader: these fixture versions ship no module at all.
	await assert.rejects(rollbackBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {} }), /bundled-install\.mjs/);
	const failing = rollbackAdapters({ ensureLauncher: () => { throw new Error("Conflicting launcher: /x"); } });
	await assert.rejects(rollbackBundled({ layout, home: user, platform: "darwin", arch: "arm64", env: {}, adapters: failing.adapters }), /launcher.*current stays at 4\.1\.0-1\.0\.1/s);
	assert.equal(activeVersion(layout), "4.1.0-1.0.1");
	assert.deepEqual(readdirSync(layout.versions).sort(), ["4.0.0-1.0.0", "4.1.0-1.0.1"]);
});

test("bundledNpmCommand runs our npm through an entry named npm, with only the prefix configuration", () => {
	const layout = prefixLayout({ platform: "linux", env: {}, home: "/home/me" });
	const root = "/home/me/.gentle-shell";
	assert.deepEqual(bundledNpmCommand(layout), [`${root}/runtime/node-${NODE}/bin/node`, `${root}/runtime/node-${NODE}/gentle-shell/npm`,
		`--userconfig=${root}/pnpm/config/npmrc`, `--globalconfig=${root}/npm/npmrc`, `--cache=${root}/npm/cache`, "--update-notifier=false"]);
	// A --prefix flag would also set npm's local prefix: Pi's git-extension
	// install (npm install in the clone, no --prefix of its own) would land there.
	assert.equal(bundledNpmCommand(layout).some((part) => /^--prefix(?:=|$)/.test(part)), false);
	const windows = bundledNpmCommand(prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\U" }));
	assert.deepEqual(windows.slice(0, 2), [`C:\\L\\gentle-shell\\runtime\\node-${NODE}\\node.exe`, `C:\\L\\gentle-shell\\runtime\\node-${NODE}\\gentle-shell\\npm`]);
});

// N1: Pi 1.1.0 names the package manager from the basenames in npmCommand
// (DefaultPackageManager.getPackageManagerName) and picks its install flags from
// that name. Its own code, on this host's paths.
const PI_PACKAGE_MANAGER = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js", import.meta.url);
async function piPackageManager(command: string[]) {
	const { DefaultPackageManager } = await import(PI_PACKAGE_MANAGER.href);
	return new DefaultPackageManager({ cwd: tmpdir(), agentDir: tmpdir(), settingsManager: { getNpmCommand: () => command } });
}
// The same rule with Windows paths, on any runner: Pi calls node:path's
// basename, which is win32's on Windows, and strips only .cmd and .exe.
function windowsPackageManagerName(command: string[]) {
	const name = (part: string) => win32.basename(part).replace(/\.(cmd|exe)$/i, "");
	const supported = new Set(["npm", "pnpm", "bun"]);
	if (supported.has(name(command[0]))) return name(command[0]);
	const wrapped = [...new Set(command.slice(1).map(name).filter((part) => supported.has(part)))];
	if (wrapped.length > 1) throw new Error(`Ambiguous npmCommand package managers: ${wrapped.join(", ")}`);
	return wrapped[0] ?? name(command[0]);
}

test("Pi reads the bundled npmCommand as npm and installs git extensions with npm's flags", async () => {
	const host = process.platform === "win32"
		? prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Ana Li\\AppData\\Local" }, home: "C:\\Users\\Ana Li" })
		: prefixLayout({ platform: process.platform, env: {}, home: "/home/npm" });
	const pi = await piPackageManager(bundledNpmCommand(host));
	assert.equal(pi.getPackageManagerName(), "npm");
	assert.deepEqual(pi.getGitDependencyInstallArgs(), ["install", "--omit=dev", "--legacy-peer-deps"]);
	// The command before N1 read as `node`: plain `npm install` for git extensions.
	const before = await piPackageManager([host.node, host.npmCli, ...bundledNpmCommand(host).slice(2)]);
	assert.equal(before.getPackageManagerName(), "node");
	assert.deepEqual(before.getGitDependencyInstallArgs(), ["install"]);
	// Windows-shaped paths, whatever the folder names (here "npm" and "pnpm" ones).
	const windows = prefixLayout({ platform: "win32", env: { LOCALAPPDATA: "C:\\pnpm\\npm" }, home: "C:\\Users\\bun" });
	assert.equal(windowsPackageManagerName(bundledNpmCommand(windows)), "npm");
	assert.equal(windowsPackageManagerName([windows.node, windows.npmCli]), "node");
});

posixTest("ensureNpmShim writes one regular npm entry that runs our npm-cli.js, rewritten only when it differs", () => {
	const { layout } = claimed();
	assert.throws(() => ensureNpmShim(layout), /npm/);
	mkdirSync(posix.dirname(layout.npmCli), { recursive: true });
	// Prints its version and the arguments it got, like npm --version.
	writeFileSync(layout.npmCli, "console.log(process.argv.slice(2).includes('--version') ? '11.19.0' : JSON.stringify(process.argv.slice(2)));\n");
	// A user's package.json with type module above the prefix must not make the entry an ES module.
	writeFileSync(join(layout.root, "..", "package.json"), JSON.stringify({ type: "module" }));
	assert.deepEqual(ensureNpmShim(layout), { written: true });
	assert.equal(posix.basename(layout.npmShim), "npm");
	assert.equal(lstatSync(layout.npmShim).isFile(), true);
	const version = spawnSync(process.execPath, [layout.npmShim, "--version"], { encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout, "11.19.0\n");
	assert.equal(spawnSync(process.execPath, [layout.npmShim, "install", "--omit=dev"], { encoding: "utf8" }).stdout, '["install","--omit=dev"]\n');
	const text = readFileSync(layout.npmShim, "utf8");
	assert.deepEqual(ensureNpmShim(layout), { written: false });
	writeFileSync(layout.npmShim, "// stale\n");
	assert.deepEqual(ensureNpmShim(layout), { written: true });
	assert.equal(readFileSync(layout.npmShim, "utf8"), text);
	// A link or a folder in its place is never written through or replaced.
	rmSync(layout.npmShim);
	symlinkSync(layout.npmCli, layout.npmShim);
	assert.throws(() => ensureNpmShim(layout), /Conflicting npm entry/);
	assert.equal(readlinkSync(layout.npmShim), layout.npmCli);
});

test("publishing a runtime retries only Windows lock errors on rename, then gives up with the original error", async () => {
	const { renameWithWindowsRetry } = await import("../scripts/bundled-install.mjs");
	const lock = (code: string) => Object.assign(new Error(code), { code });
	const flaky = (failures: string[]) => {
		const calls: string[] = [];
		return { calls, rename: (from: string, to: string) => { calls.push(`${from}>${to}`); const code = failures.shift(); if (code) throw lock(code); } };
	};
	const noWait = { delays: [0, 0, 0, 0] };
	// A scanner or the just-run node.exe holding the staging folder clears after a moment.
	const recovers = flaky(["EPERM", "EBUSY", "EACCES"]);
	await renameWithWindowsRetry("s", "d", { platform: "win32", rename: recovers.rename, ...noWait });
	assert.equal(recovers.calls.length, 4);
	// A lock that never clears surfaces the original error after the last delay.
	const stuck = flaky(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM"]);
	await assert.rejects(renameWithWindowsRetry("s", "d", { platform: "win32", rename: stuck.rename, ...noWait }), (error: { code?: string }) => error.code === "EPERM");
	assert.equal(stuck.calls.length, 5);
	// Any other error, or any other platform, fails at once.
	const other = flaky(["EEXIST"]);
	await assert.rejects(renameWithWindowsRetry("s", "d", { platform: "win32", rename: other.rename, ...noWait }), (error: { code?: string }) => error.code === "EEXIST");
	assert.equal(other.calls.length, 1);
	const posixLock = flaky(["EPERM"]);
	await assert.rejects(renameWithWindowsRetry("s", "d", { platform: "linux", rename: posixLock.rename, ...noWait }), (error: { code?: string }) => error.code === "EPERM");
	assert.equal(posixLock.calls.length, 1);
});
