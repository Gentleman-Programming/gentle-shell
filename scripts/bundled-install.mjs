// The bundled Gentle Shell install (S2, S3, S6, S7): one private prefix with our
// own pinned Node with its npm and pnpm (and Go only when asked), every pnpm and npm folder inside it,
// one frozen install per version, an atomic `current`, a launcher and one PATH
// entry. The user's node, npm, pnpm and go are never run, read or changed.
// Shared by the web installer and `gentle-shell upgrade`; every effect outside
// plain path arithmetic goes through an injectable adapter for tests.
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync,
	rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { posix, win32 } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";
import { acquireGo, artifactFor, engramPinVersion, verifiedDownload } from "./installer-downloads.mjs";
import { ensureWindowsPrivateFolder, readWindowsPnpmArchive, verifyWindowsStorage } from "./installer-windows.mjs";

// The acquisition pins already verified for the installer; never a second copy.
const pins = Object.freeze({ node: artifactFor("node", "linux", "x64").version, pnpm: artifactFor("pnpm").version });
const RUNTIME_MARKER = ".gentle-shell-runtime";
const VERSION_MARKER = ".gentle-shell-version";
const WINDOWS_MARKER = Object.freeze({ marker: ".gentle-shell-bundle", text: "gentle-shell bundled install" });
const LAUNCHER_MARK = "gentle-shell bundled launcher (generated; do not edit)";
const LAUNCHER_MISSING = "gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.";
const PROFILE_MARK = "# gentle-shell bundled install";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VERSION_ID = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;
const MAX_EXPANDED = 512 * 1024 * 1024;
const INSTALL_TIMEOUT = 15 * 60 * 1000;

const pathFor = (platform) => (platform === "win32" ? win32 : posix);
function stat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}
const regular = (path) => stat(path)?.isFile() === true;
const read = (path) => (regular(path) ? readFileSync(path, "utf8") : null);
/** A value from a Windows environment, whose names are case-insensitive. */
function envValue(env, name, platform) {
	const key = platform === "win32" ? Object.keys(env).find((candidate) => candidate.toUpperCase() === name) : name;
	return key === undefined ? undefined : env[key];
}
/** %LOCALAPPDATA%\gentle-shell, then %USERPROFILE%\.gentle-shell-bundle, as the bootstrap claims its tools. */
function windowsCandidates(env) {
	const usable = (value) => typeof value === "string" && win32.isAbsolute(value) && !value.startsWith("\\\\");
	const local = envValue(env, "LOCALAPPDATA", "win32");
	const profile = envValue(env, "USERPROFILE", "win32");
	return [usable(local) ? win32.join(local, "gentle-shell") : null, usable(profile) ? win32.join(profile, ".gentle-shell-bundle") : null].filter(Boolean);
}

/** Every bundled path, from plain path arithmetic only. POSIX: `~/.gentle-shell`.
 * Windows: `root` as claimPrefix chose it, otherwise the %LOCALAPPDATA% candidate.
 * The agent home stays `<home>/.gentle-shell/agent` on every platform.
 */
export function prefixLayout({ platform, env = {}, home, root }) {
	const path = pathFor(platform);
	if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("The bundled install needs an absolute home directory");
	const windows = platform === "win32";
	const base = root ?? (windows ? windowsCandidates(env)[0] : path.join(home, ".gentle-shell"));
	if (typeof base !== "string" || !path.isAbsolute(base)) throw new Error("The bundled install has no private folder");
	const runtime = path.join(base, "runtime");
	const nodeDir = path.join(runtime, `node-${pins.node}`);
	const pnpmDir = path.join(runtime, `pnpm-${pins.pnpm}`);
	const pnpmHome = path.join(base, "pnpm");
	const npmHome = path.join(base, "npm");
	const bin = path.join(base, "bin");
	return Object.freeze({
		platform, root: base, agent: path.join(home, ".gentle-shell", "agent"), runtime,
		nodeDir, node: windows ? path.join(nodeDir, "node.exe") : path.join(nodeDir, "bin", "node"),
		// The npm bundled in the same Node archive, for Pi's own package installs.
		npmCli: path.join(nodeDir, ...(windows ? [] : ["lib"]), "node_modules", "npm", "bin", "npm-cli.js"),
		// The entry Pi's npmCommand runs that npm through (ensureNpmShim).
		npmShim: path.join(nodeDir, "gentle-shell", "npm"),
		npmHome, npmPrefix: path.join(npmHome, "prefix"), npmCache: path.join(npmHome, "cache"), npmGlobalConfig: path.join(npmHome, "npmrc"),
		pnpmDir, pnpm: path.join(pnpmDir, "package", "bin", "pnpm.mjs"),
		// acquireGo publishes `<goRoot>/<version>/go`.
		goRoot: path.join(runtime, "go"),
		// The pinned Engram (ensureEngram), given to Gentle AI and gentle-engram (S9).
		engramDir: path.join(runtime, `engram-${engramPinVersion}`),
		engram: path.join(runtime, `engram-${engramPinVersion}`, windows ? "engram.exe" : "engram"),
		pnpmHome, store: path.join(pnpmHome, "store"), cache: path.join(pnpmHome, "cache"), state: path.join(pnpmHome, "state"),
		config: path.join(pnpmHome, "config"), npmrc: path.join(pnpmHome, "config", "npmrc"), tmp: path.join(base, "tmp"),
		versions: path.join(base, "versions"), history: path.join(base, "versions.history"),
		// The applied PATH entry (writePathReceipt), which self-uninstall reverts exactly.
		pathReceipt: path.join(base, "path-entry.json"),
		current: path.join(base, "current"), currentKind: windows ? "pointer" : "symlink",
		bin, launcher: path.join(bin, windows ? "gentle-shell.cmd" : "gentle-shell"),
	});
}

/** POSIX: a real directory owned by this user that no one else can write. */
function privateDirectory(path) {
	const info = stat(path);
	if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error(`Unsafe bundled prefix: ${path}`);
}
/** POSIX: removes group and other write access from a real directory of this
 * user, through a descriptor opened without following links; anything else is
 * left for privateDirectory to refuse.
 */
function tightenOwnDirectory(path) {
	let fd;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
	catch { return; }
	try {
		const info = fstatSync(fd);
		if (info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o022)) fchmodSync(fd, info.mode & 0o7755);
	} finally {
		closeSync(fd);
	}
}
function ensureDirectory(path, platform) {
	try { mkdirSync(path, { mode: 0o700 }); }
	catch (error) { if (error.code !== "EEXIST") throw error; }
	if (platform !== "win32") privateDirectory(path);
}
/** The prefix folders and the empty npmrc pnpm reads instead of ~/.npmrc. */
function prepareFolders(layout) {
	for (const path of [layout.runtime, layout.pnpmHome, layout.store, layout.cache, layout.state, layout.config, layout.npmHome, layout.npmPrefix, layout.npmCache,
		layout.versions, layout.bin, layout.tmp]) {
		ensureDirectory(path, layout.platform);
	}
	if (!stat(layout.npmrc)) writeFileSync(layout.npmrc, "", { flag: "wx", mode: 0o600 });
	if (!regular(layout.npmrc)) throw new Error(`Unsafe bundled prefix: ${layout.npmrc}`);
}

/** Claims the prefix and returns its layout. POSIX: `~/.gentle-shell` is created
 * 0700, or kept when it is a real directory of this user (the agent home lives
 * there); group or other write access, which umask 002 leaves, is removed
 * (go-w). A link, a non-folder or another owner's folder is refused. Windows: each candidate's nearest existing
 * folder is walked like the bootstrap's tools (owner, ACL, reparse); only an
 * untrusted owner or ACL on %LOCALAPPDATA% moves to the profile candidate. The
 * chosen folder is claimed with the bootstrap's protected DACL and marked
 * (ensureWindowsPrivateFolder); a non-empty unmarked folder is never adopted.
 * `root`, the consented plan's folder: when the choice differs, it throws
 * (check "prefix-changed") before anything is created or claimed.
 */
export function claimPrefix({ platform, env = {}, home, root, adapters = {} }) {
	if (platform !== "win32") {
		const layout = prefixLayout({ platform, env, home });
		if (root !== undefined && root !== layout.root) throw Object.assign(new Error(`The bundled folder changed since the plan: ${layout.root}`), { check: "prefix-changed" });
		if (realpathSync(home) !== posix.resolve(home)) throw new Error(`Unsafe bundled prefix: ${home}`);
		const info = lstatSync(home);
		if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error(`Unsafe bundled prefix: ${home}`);
		if (stat(layout.root)?.isDirectory()) tightenOwnDirectory(layout.root);
		ensureDirectory(layout.root, platform);
		(adapters.prepare ?? prepareFolders)(layout);
		return layout;
	}
	const storage = adapters.storage ?? verifyWindowsStorage;
	const claim = adapters.claim ?? ((folder) => ensureWindowsPrivateFolder(folder, env, { ...WINDOWS_MARKER, storage }));
	const candidate = prefixRoot({ platform, env, adapters });
	// The consented plan named a folder: a claim that would choose another one changes nothing.
	if (root !== undefined && root !== candidate) throw Object.assign(new Error(`The bundled folder changed since the plan: ${candidate}`), { check: "prefix-changed" });
	claim(candidate);
	const layout = prefixLayout({ platform, env, home, root: candidate });
	(adapters.prepare ?? prepareFolders)(layout);
	return layout;
}

/** The folder claimPrefix will claim, chosen with read-only checks only, so a
 * plan shows the same folder the installation uses. POSIX: undefined (the
 * prefix is always `~/.gentle-shell`). Windows: the first candidate whose
 * nearest existing folder passes the storage walk; an untrusted owner or ACL
 * moves to the next candidate, any other failure throws.
 */
export function prefixRoot({ platform, env = {}, adapters = {} }) {
	if (platform !== "win32") return undefined;
	const exists = adapters.exists ?? ((path) => stat(path) !== null);
	const storage = adapters.storage ?? verifyWindowsStorage;
	const candidates = windowsCandidates(env);
	if (candidates.length === 0) throw new Error("The bundled install has no private folder");
	for (const [index, candidate] of candidates.entries()) {
		let target = candidate;
		while (!exists(target) && win32.dirname(target) !== target) target = win32.dirname(target);
		try {
			storage(target, env);
		} catch (error) {
			if (index + 1 < candidates.length && /^(?:target|parent|ancestor)-(?:owner|acl-mask)$/.test(error?.check ?? "")) continue;
			throw error;
		}
		return candidate;
	}
}

/** The one executable a verified Node archive must contain: `<stem>/bin/node`
 * from the POSIX `.tar.gz` or `<stem>/node.exe` from the Windows `.zip`, a
 * regular file found exactly once. Every other member, links included, is
 * skipped and never written: pnpm runs on node alone, so npm is not needed.
 */
export function nodeExecutable(bytes, descriptor) {
	const { file, stem } = nodeArchive(descriptor);
	return file.endsWith(".zip") ? zipMember(bytes, `${stem}/node.exe`) : tarMember(bytes, `${stem}/bin/node`);
}
function nodeArchive(descriptor) {
	const file = String(descriptor?.url ?? "").split("/").pop();
	const stem = file.replace(/\.(?:tar\.gz|zip)$/, "");
	if (stem === file || !/^node-v\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+$/.test(stem)) throw new Error("Node archive rejected");
	return { file, stem };
}
// Our own POSIX npm and npx: our Node runs npm's entry next to it, whatever `node` is on PATH.
const npmWrapper = (entry) => ["#!/bin/sh", "# gentle-shell bundled npm (generated; do not edit)", 'basedir=$(dirname "$0")',
	`exec "$basedir/node" "$basedir/../lib/node_modules/npm/bin/${entry}" "$@"`, ""].join("\n");
/** Every file runtime/node-<v>/ holds, from one verified Node archive, as
 * [{ name (relative, `/`-separated), data, executable }] with `npm` set to the
 * bundled npm version: the Node executable (as nodeExecutable finds it) and the
 * npm bundled with it, which Pi runs to install its packages. Windows: npm's
 * package under node_modules/npm and its npm.cmd and npx.cmd, which run the
 * node.exe beside them. POSIX: npm's package under lib/node_modules/npm and our
 * own bin/npm and bin/npx wrappers in place of the archive's links. Links,
 * Corepack and every other member are skipped; a member leaving its folder, or
 * an archive without npm, is rejected.
 */
export function nodeRuntimeFiles(bytes, descriptor) {
	const fail = () => { throw new Error("Node archive rejected"); };
	const { file, stem } = nodeArchive(descriptor);
	const windows = file.endsWith(".zip");
	const npm = windows ? "node_modules/npm/" : "lib/node_modules/npm/";
	const files = [{ name: windows ? "node.exe" : "bin/node", data: nodeExecutable(bytes, descriptor), executable: true }];
	const keep = (name, data, executable) => {
		const relative = name.slice(stem.length + 1);
		if (!name.startsWith(`${stem}/`) || !(relative.startsWith(npm) || (windows && /^np[mx]\.cmd$/.test(relative)))) return;
		if (relative.split("/").some((part) => part === "" || part === "." || part === "..") || relative.includes("\\")) fail();
		files.push({ name: relative, data, executable });
	};
	if (windows) {
		for (const entry of zipEntries(bytes, fail)) if (!entry.name.endsWith("/") && !(entry.unix && (entry.mode & 0o170000) !== 0o100000)) keep(entry.name, entry.read(), false);
	} else {
		for (const member of tarMembers(bytes, "Node archive rejected")) if (member.type === "0" || member.type === "\0") keep(member.name, Buffer.from(member.data), (member.mode & 0o100) !== 0);
		files.push({ name: "bin/npm", data: Buffer.from(npmWrapper("npm-cli.js")), executable: true }, { name: "bin/npx", data: Buffer.from(npmWrapper("npx-cli.js")), executable: true });
	}
	let metadata = null;
	try { metadata = JSON.parse(files.find((entry) => entry.name === `${npm}package.json`)?.data.toString("utf8") ?? "null"); }
	catch { fail(); }
	if (metadata?.name !== "npm" || !SEMVER.test(metadata.version ?? "") || !files.some((entry) => entry.name === `${npm}bin/npm-cli.js`)) fail();
	return Object.assign(files, { npm: metadata.version });
}
function tarMember(bytes, wanted, message = "Node archive rejected") {
	let found = null;
	for (const member of tarMembers(bytes, message)) {
		if (member.name !== wanted) continue;
		if ((member.type !== "0" && member.type !== "\0") || found) throw new Error(message);
		found = Buffer.from(member.data);
	}
	if (!found?.length) throw new Error(message);
	return found;
}
/** Every member of a `.tar.gz`: { name, type, mode, data }. Headers are
 * checksummed; anything malformed throws `message`.
 */
function* tarMembers(bytes, message) {
	const fail = () => { throw new Error(message); };
	const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
	const text = (block, start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0[^]*$/, "");
	const number = (block, start, length) => {
		const value = text(block, start, length).trim();
		if (!/^[0-7]{1,12}$/.test(value)) fail();
		return parseInt(value, 8);
	};
	let renamed = null;
	for (let offset = 0; ;) {
		if (offset + 512 > tar.length) fail();
		const block = tar.subarray(offset, offset + 512);
		if (block.every((byte) => byte === 0)) return;
		let checksum = 0;
		for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : block[index];
		if (checksum !== number(block, 148, 8) || block.subarray(257, 262).toString("latin1") !== "ustar") fail();
		const size = number(block, 124, 12);
		const type = String.fromCharCode(block[156]);
		const start = offset + 512;
		if (start + size > tar.length) fail();
		offset = start + Math.ceil(size / 512) * 512;
		const data = tar.subarray(start, start + size);
		// PAX `path=` records and GNU long names rename the next member only.
		if (type === "x") { renamed = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))?.[1] ?? renamed; continue; }
		if (type === "L") { renamed = data.toString("utf8").replace(/\0[^]*$/, ""); continue; }
		if (type === "g" || type === "K") continue;
		// Only the POSIX ustar format has a name prefix; old GNU keeps times there.
		const prefix = block.subarray(257, 263).toString("latin1") === "ustar\0" ? text(block, 345, 155) : "";
		const name = renamed ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
		renamed = null;
		yield { name, type, mode: number(block, 100, 8), data };
	}
}
function zipMember(bytes, wanted, message = "Node archive rejected") {
	const fail = () => { throw new Error(message); };
	let found = null;
	for (const entry of zipEntries(bytes, fail)) {
		if (entry.name !== wanted) continue;
		if (found || (entry.unix && (entry.mode & 0o170000) !== 0o100000)) fail();
		found = entry.read();
	}
	if (!found?.length) fail();
	return found;
}
/** Every central-directory entry of a zip: { name, unix, mode, read() }; read()
 * checks the entry (no encryption or data descriptor, stored or deflated, its
 * local header and CRC) and returns its bytes. Anything malformed calls `fail`.
 */
function* zipEntries(bytes, fail) {
	let end = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
		if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
	}
	if (end < 0) fail();
	const count = bytes.readUInt16LE(end + 10);
	const directory = bytes.readUInt32LE(end + 16);
	if (count === 0xffff || directory === 0xffffffff || directory + bytes.readUInt32LE(end + 12) > end) fail();
	for (let at = directory, index = 0; index < count; index += 1) {
		if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
		const [flags, method, crc, compressed, size] = [bytes.readUInt16LE(at + 8), bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 16),
			bytes.readUInt32LE(at + 20), bytes.readUInt32LE(at + 24)];
		const nameLength = bytes.readUInt16LE(at + 28);
		const mode = bytes.readUInt32LE(at + 38) >>> 16;
		const unix = bytes[at + 5] === 3;
		const local = bytes.readUInt32LE(at + 42);
		const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
		yield { name, unix, mode, read: () => {
			if ((flags & 0x41) || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff) fail();
			if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50) fail();
			const localName = bytes.readUInt16LE(local + 26);
			const data = local + 30 + localName + bytes.readUInt16LE(local + 28);
			if (bytes.subarray(local + 30, local + 30 + localName).toString("utf8") !== name || data + compressed > directory) fail();
			const raw = bytes.subarray(data, data + compressed);
			const content = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
			if (content.length !== size || crc32(content) !== crc) fail();
			return content;
		} };
	}
}

/** The one executable a verified Engram release archive must contain: the
 * top-level `engram` of the POSIX `.tar.gz` or `engram.exe` of the Windows
 * `.zip`, a regular file found exactly once. Its tools/ scripts and anything
 * else are never written.
 */
export function engramExecutable(bytes, descriptor) {
	const message = "Engram archive rejected";
	return String(descriptor?.url ?? "").endsWith(".zip") ? zipMember(bytes, "engram.exe", message) : tarMember(bytes, "engram", message);
}

/** Runs a command without a shell; resolves { status, stdout, stderr }. */
export function runCommand(command, args, { cwd, env, timeout = 15000 }) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		const output = { stdout: "", stderr: "" };
		for (const stream of ["stdout", "stderr"]) child[stream].on("data", (chunk) => { output[stream] = (output[stream] + chunk).slice(-1024 * 1024); });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
		child.once("error", () => { clearTimeout(timer); resolve({ status: null, ...output }); });
		child.once("close", (status) => { clearTimeout(timer); resolve({ status, ...output }); });
	});
}
const ownedRuntime = (directory, url, entry) => read(pathFor(process.platform).join(directory, RUNTIME_MARKER)) === `${url}\n` && regular(entry);

// Windows publication can lose a race with the node.exe just run from the
// staging folder or a real-time scanner still holding it (EPERM, EBUSY,
// EACCES). Only those codes, and only on Windows, are retried after each
// delay; a lock that never clears surfaces the original error.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [200, 400, 800, 1600];
export async function renameWithWindowsRetry(from, to, { platform = process.platform, rename = renameSync, delays = WINDOWS_RENAME_RETRY_DELAYS_MS } = {}) {
	if (platform !== "win32") return rename(from, to);
	for (let attempt = 0; ; attempt += 1) {
		try { return rename(from, to); }
		catch (error) {
			if (attempt >= delays.length || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		}
	}
}

/** Publishes one verified runtime as `directory`: an existing one marked with the
 * same pinned URL is reused, an unmarked one is never replaced. `fill` writes and
 * checks the staging folder; one rename publishes it. Renaming is safe here,
 * unlike after a pnpm install: the extracted trees hold regular files and
 * folders only (both archive readers reject links), so nothing points at the
 * staging path.
 */
async function publishRuntime(layout, name, directory, entry, { platform, arch, adapters }, fill) {
	const descriptor = (adapters.artifact ?? artifactFor)(name, platform, arch);
	if (ownedRuntime(directory, descriptor.url, entry)) return false;
	if (stat(directory)) throw new Error(`Conflicting runtime destination: ${directory}`);
	// Before downloading: a prefix that is not there fails without a download.
	ensureDirectory(layout.runtime, layout.platform);
	const bytes = await verifiedDownload(name, adapters, platform, arch);
	let stage = mkdtempSync(pathFor(process.platform).join(layout.runtime, ".stage-"));
	try {
		await fill(stage, bytes, descriptor);
		writeFileSync(pathFor(process.platform).join(stage, RUNTIME_MARKER), `${descriptor.url}\n`, { flag: "wx", mode: 0o600 });
		if (stat(directory)) throw new Error(`Conflicting runtime destination: ${directory}`);
		await renameWithWindowsRetry(stage, directory);
		stage = null;
		return true;
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}

/** The pinned Engram in runtime/engram-<v>/ (S9): downloaded through
 * verifiedDownload, only its executable written, `engram version` run from the
 * staging folder, marked, then published. Gentle AI's setup uses it through
 * GENTLE_AI_ENGRAM_BIN and gentle-engram through ENGRAM_BIN, so neither
 * installs or finds another Engram. Returns whether it was acquired.
 */
export async function ensureEngram({ layout, platform, arch, env = {}, adapters = {} }) {
	const run = adapters.run ?? runCommand;
	const path = pathFor(process.platform);
	const childEnv = pnpmEnvironment(layout, { platform: layout.platform, env });
	return publishRuntime(layout, "engram", layout.engramDir, layout.engram, { platform, arch, adapters }, async (stage, bytes, descriptor) => {
		const binary = path.join(stage, path.relative(layout.engramDir, layout.engram));
		writeFileSync(binary, engramExecutable(bytes, descriptor), { flag: "wx", mode: 0o700 });
		const result = await run(binary, ["version"], { cwd: layout.runtime, env: childEnv });
		if (result.status !== 0 || String(result.stdout).trim() !== `engram ${descriptor.version}`) throw new Error("Bundled Engram verification failed");
	});
}

/** Our pinned Node with its bundled npm, and pnpm, in runtime/ (and the pinned
 * Go only when `go`, the pinned Engram only when `engram`), each downloaded
 * through verifiedDownload, checked by running it from its staging folder,
 * marked, then published. Returns the paths and what was acquired.
 */
export async function ensureRuntime({ layout, platform, arch, go = false, engram = false, env = {}, adapters = {} }) {
	const run = adapters.run ?? runCommand;
	const path = pathFor(process.platform);
	const childEnv = pnpmEnvironment(layout, { platform: layout.platform, env });
	const acquired = [];
	const node = await publishRuntime(layout, "node", layout.nodeDir, layout.node, { platform, arch, adapters }, async (stage, bytes, descriptor) => {
		const files = nodeRuntimeFiles(bytes, descriptor);
		for (const file of files) {
			const target = path.join(stage, ...file.name.split("/"));
			mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			writeFileSync(target, file.data, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
		}
		const binary = path.join(stage, path.relative(layout.nodeDir, layout.node));
		const result = await run(binary, ["--version"], { cwd: layout.runtime, env: childEnv });
		if (result.status !== 0 || String(result.stdout).trim() !== `v${descriptor.version}`) throw new Error("Bundled Node verification failed");
		const npm = await run(binary, [path.join(stage, path.relative(layout.nodeDir, layout.npmCli)), "--version"], { cwd: layout.runtime, env: childEnv });
		if (npm.status !== 0 || String(npm.stdout).trim() !== files.npm) throw new Error("Bundled npm verification failed");
	});
	if (node) acquired.push("node");
	// Also for a runtime published before the entry existed; one from before npm
	// was published (T1a) has no npm to run, and the launcher then gives Pi none.
	if (regular(layout.npmCli)) ensureNpmShim(layout);
	const pnpm = await publishRuntime(layout, "pnpm", layout.pnpmDir, layout.pnpm, { platform, arch, adapters }, async (stage, bytes, descriptor) => {
		// The tarball's executable bits are kept (bin/pnpm.mjs, dist/node-gyp-bin), for the owner only.
		const modes = new Map([...tarMembers(bytes, "pnpm archive rejected")].map((member) => [member.name, member.mode]));
		for (const entry of readWindowsPnpmArchive(bytes)) {
			const target = path.join(stage, ...entry.name.replace(/\/$/, "").split("/"));
			if (entry.directory) mkdirSync(target, { recursive: true, mode: 0o700 });
			else {
				mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
				writeFileSync(target, entry.bytes, { flag: "wx", mode: (modes.get(entry.name) ?? 0) & 0o100 ? 0o700 : 0o600 });
			}
		}
		const metadata = JSON.parse(readFileSync(path.join(stage, "package", "package.json"), "utf8"));
		const entry = path.join(stage, "package", "bin", "pnpm.mjs");
		if (metadata.name !== "pnpm" || metadata.version !== descriptor.version || metadata.bin?.pnpm !== "bin/pnpm.mjs" || !regular(entry)) {
			throw new Error("Bundled pnpm metadata rejected");
		}
		const result = await run(layout.node, [entry, "--version"], { cwd: layout.runtime, env: childEnv });
		if (result.status !== 0 || String(result.stdout).trim() !== descriptor.version) throw new Error("Bundled pnpm verification failed");
	});
	if (pnpm) acquired.push("pnpm");
	if (engram && await ensureEngram({ layout, platform, arch, env, adapters })) acquired.push("engram");
	let goPath = null;
	if (go) {
		const result = await (adapters.acquireGo ?? acquireGo)({ root: layout.goRoot, platform, arch, adapters });
		goPath = result.goPath;
		if (result.acquired) acquired.push("go");
	}
	return { node: layout.node, pnpm: layout.pnpm, go: goPath, acquired };
}

/** The environment for our pnpm and the scripts it runs: our Node (then our Go,
 * when given) first on PATH; PNPM_HOME, store, cache, state and config inside the
 * prefix through the variables pnpm 11 reads (`pnpm_config_*`, XDG_*); an empty
 * npmrc in place of ~/.npmrc; no switching to the pnpm a package.json above the
 * folder names (pm-on-fail otherwise defaults to "download") or to a Node runtime
 * a root manifest asks to download (runtime-on-fail), and no update check; on
 * Windows TEMP/TMP in the private folder. Every inherited npm/pnpm/Corepack setting, NODE_OPTIONS and
 * NODE_PATH is dropped, except a variable the prefix npmrc references as
 * `${NAME}` (an auth token such as NPM_TOKEN, which pnpm and npm expand); the
 * rest (HOME, proxies, SystemRoot) is kept.
 */
export function pnpmEnvironment(layout, { platform = layout.platform, env = {}, go = null } = {}) {
	const windows = platform === "win32";
	const path = pathFor(platform);
	const dropped = new RegExp(`^(?:npm_.*|pnpm_.*|corepack_.*|node_options|node_path|xdg_(?:config|cache|state|data)_home|path${windows ? "|temp|tmp" : ""})$`, "i");
	const referenced = new Set([...(read(layout.npmrc) ?? "").matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1])
		.filter((name) => !/^(?:npm_config_.*|pnpm_.*)$/i.test(name)));
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !dropped.test(key) || referenced.has(key)));
	const rest = String(envValue(env, "PATH", platform) ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
	const first = [path.dirname(layout.node), ...(go ? [path.dirname(go)] : [])];
	return {
		...kept,
		[windows ? "Path" : "PATH"]: [...first, ...rest].join(path.delimiter),
		PNPM_HOME: layout.pnpmHome,
		XDG_CONFIG_HOME: layout.config, XDG_CACHE_HOME: layout.cache, XDG_STATE_HOME: layout.state,
		pnpm_config_store_dir: layout.store, pnpm_config_cache_dir: layout.cache, pnpm_config_state_dir: layout.state,
		pnpm_config_npmrc_auth_file: layout.npmrc,
		pnpm_config_pm_on_fail: "ignore", pnpm_config_runtime_on_fail: "ignore", pnpm_config_update_notifier: "false",
		...(windows ? { TEMP: layout.tmp, TMP: layout.tmp } : {}),
	};
}
/** Our npm's settings, for the children that run npm (setupEnvironment; pnpm
 * never runs it): the prefix npmrc as its user config, and its global config,
 * global prefix and cache inside the prefix, so nothing reads the user's npm
 * settings or writes the user's npm folders. The prefix also keeps Windows'
 * npm.cmd on our npm: it prefers an npm installed in the global prefix.
 */
function npmEnvironment(layout) {
	return { npm_config_userconfig: layout.npmrc, npm_config_globalconfig: layout.npmGlobalConfig, npm_config_prefix: layout.npmPrefix,
		npm_config_cache: layout.npmCache, npm_config_update_notifier: "false" };
}
/** The environment `gentle-shell setup` runs in from the bundled install: our
 * Node and its npm first on PATH, then the version's node_modules/.bin (its
 * `pi`), then the user's PATH; npm's settings inside the prefix
 * (npmEnvironment). Inherited npm and pnpm settings, NODE_OPTIONS, NODE_PATH
 * and the wizard's GENTLE_BOOTSTRAP_ and GENTLE_INSTALL_ handoff are dropped;
 * the user's XDG folders are kept, since Pi and Gentle AI read their own
 * configuration through them.
 */
export function setupEnvironment(layout, { platform = layout.platform, env = {}, id }) {
	if (typeof id !== "string" || !VERSION_ID.test(id) || id.includes("..")) throw new Error("Unsafe version id");
	const path = pathFor(platform);
	const dropped = /^(?:npm_config_.*|pnpm_.*|corepack_.*|node_options|node_path|path|gentle_(?:bootstrap|install)_.*)$/i;
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !dropped.test(key)));
	const rest = String(envValue(env, "PATH", platform) ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
	const bin = path.join(layout.versions, id, "node_modules", ".bin");
	return { ...kept, [platform === "win32" ? "Path" : "PATH"]: [path.dirname(layout.node), bin, ...rest].join(path.delimiter), ...npmEnvironment(layout) };
}

// S12: the only npmrc keys our pnpm and npm read from the user's npmrc.
const NPMRC_KEYS = /^(?:registry|@[^\s:=]+:registry|\/\/\S+:(?:_authToken|_auth|username|_password|certfile|keyfile)|proxy|https-proxy|noproxy|no-proxy|ca|ca\[\]|cafile|strict-ssl)$/;
/** The user's npmrc reduced to its network, registry and authentication keys:
 * registry, @scope:registry, per-host //host/:_authToken, _auth, username,
 * _password, certfile and keyfile, proxy, https-proxy, noproxy (no-proxy), ca
 * (ca[]), cafile and strict-ssl. Each kept line is copied verbatim, so `${VAR}`
 * references stay for pnpm and npm to expand. Comments and every other key are
 * dropped, and so is everything from the first [section] on: an ini section
 * never applies at the top level.
 */
export function filterNpmrc(text) {
	const kept = [];
	for (const raw of String(text ?? "").split(/\r\n|\r|\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) break;
		const at = line.indexOf("=");
		if (line.startsWith("#") || line.startsWith(";") || at <= 0) continue;
		const key = line.slice(0, at).trim().replace(/^(["'])(.*)\1$/, "$2");
		if (NPMRC_KEYS.test(key)) kept.push(line);
	}
	return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}
/** The user's npmrc text: NPM_CONFIG_USERCONFIG (any case) when it is an
 * absolute path, otherwise ~/.npmrc; empty when that file is missing. At most
 * 1 MiB is read.
 */
export function userNpmrc({ platform, env = {}, home }) {
	const path = pathFor(platform);
	const key = Object.keys(env).find((name) => name.toLowerCase() === "npm_config_userconfig");
	const file = key && path.isAbsolute(env[key] ?? "") ? env[key] : path.join(home, ".npmrc");
	let text;
	try { text = readFileSync(file); }
	catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return ""; throw error; }
	if (text.length > 1024 * 1024) throw new Error(`The npm user configuration is too large: ${file}`);
	return text.toString("utf8");
}
/** Replaces the prefix npmrc (layout.npmrc, the file pnpm and npm read in place
 * of ~/.npmrc) with filterNpmrc(text), mode 0600, with one rename.
 */
export function writeNpmrcAuth(layout, text) {
	const content = filterNpmrc(text);
	replaceAtomically(layout.npmrc, (temp) => {
		writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
		if (layout.platform !== "win32") chmodSync(temp, 0o600);
	});
}

function versionsOf(manifest) {
	const { shell, pi } = manifest ?? {};
	if (!SEMVER.test(shell ?? "") || !SEMVER.test(pi ?? "")) throw new Error("Distribution manifest version rejected");
	return { shell, pi, id: `${shell}-${pi}` };
}
/** The exact project the release lockfile is built from and installed with:
 * gentle-pi and Pi pinned exactly, and only gentle-pi's build scripts allowed,
 * as the global install allows it. Other dependencies' build scripts are
 * skipped, not fatal (pnpm 11 fails on them by default).
 */
export function distributionFiles(manifest) {
	const { shell, pi } = versionsOf(manifest);
	const project = { name: "gentle-shell-distribution", version: shell, private: true, dependencies: { "gentle-pi": shell, "@earendil-works/pi-coding-agent": pi } };
	return { "package.json": `${JSON.stringify(project, null, "\t")}\n`, "pnpm-workspace.yaml": "allowBuilds:\n  gentle-pi: true\nstrictDepBuilds: false\n" };
}

/** The two release assets (T1b), under stable names. */
export const DISTRIBUTION_ASSETS = Object.freeze({ distribution: "gentle-shell-distribution.json", lockfile: "gentle-shell-distribution-lock.yaml" });
const DISTRIBUTION_SCHEMA = 1;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** The distribution asset text: the exact versions, the pinned Node and pnpm
 * the lockfile was resolved with, the files installVersion writes next to it
 * and the lockfile's sha256. Plain data in a fixed order, so the same inputs
 * always give the same bytes.
 */
export function distributionAsset(manifest, lockfile) {
	const { shell, pi, id } = versionsOf(manifest);
	if (typeof lockfile !== "string" || lockfile.length === 0) throw new Error("Release lockfile missing");
	const asset = { schema: DISTRIBUTION_SCHEMA, shell, pi, id, generatedWith: { node: pins.node, pnpm: pins.pnpm }, files: distributionFiles({ shell, pi }),
		lockfile: { name: DISTRIBUTION_ASSETS.lockfile, sha256: sha256(lockfile) } };
	return `${JSON.stringify(asset, null, "\t")}\n`;
}
/** Reads a downloaded asset pair: returns { manifest, lockfile } only for exact
 * versions, a lockfile whose sha256 the asset records, and workspace files equal
 * to the ones this module's installVersion writes (a frozen install with other
 * settings was never verified). generatedWith is recorded, not compared.
 */
export function readDistribution(text, lockfile) {
	let asset;
	try { asset = JSON.parse(text); }
	catch { throw new Error("Distribution asset rejected"); }
	if (asset?.schema !== DISTRIBUTION_SCHEMA) throw new Error("Distribution asset schema rejected");
	const manifest = { shell: asset.shell, pi: asset.pi };
	const { id } = versionsOf(manifest);
	const files = distributionFiles(manifest);
	const recorded = asset.files ?? {};
	if (asset.id !== id || Object.keys(recorded).length !== Object.keys(files).length || Object.entries(files).some(([name, content]) => recorded[name] !== content)) {
		throw new Error("Distribution asset workspace files rejected");
	}
	if (typeof lockfile !== "string" || asset.lockfile?.name !== DISTRIBUTION_ASSETS.lockfile || asset.lockfile?.sha256 !== sha256(lockfile)) {
		throw new Error("Distribution lockfile sha256 mismatch");
	}
	return { manifest, lockfile };
}
function versionDirectory(layout, id) {
	if (typeof id !== "string" || !VERSION_ID.test(id) || id.includes("..")) throw new Error("Unsafe version id");
	return pathFor(process.platform).join(layout.versions, id);
}
/** A published version: a real directory whose marker names it. While pnpm
 * runs, the marker reads `installing <id> <pid>` instead.
 */
function installedVersion(layout, id) {
	const directory = versionDirectory(layout, id);
	return stat(directory)?.isDirectory() === true && read(pathFor(process.platform).join(directory, VERSION_MARKER)) === `${id}\n`;
}
function installedPackage(stage, name, expected, label) {
	const path = pathFor(process.platform);
	const directory = realpathSync(path.join(stage, "node_modules", ...name.split("/")));
	if (!directory.startsWith(`${realpathSync(stage)}${path.sep}`)) throw new Error(`Installed ${label} is outside the version folder`);
	const metadata = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
	if (metadata.name !== name || metadata.version !== expected) throw new Error(`Installed ${label} version mismatch: expected ${expected}, found ${metadata.version}`);
	return directory;
}

function processAlive(pid) {
	try { process.kill(pid, 0); return true; }
	catch (error) { return error.code === "EPERM"; }
}
/** The pinned Go acquireGo published under runtime/go: a regular file there. */
function pinnedGo(layout, go) {
	const path = pathFor(layout.platform);
	if (typeof go !== "string" || !path.isAbsolute(go)) return false;
	const relative = path.relative(layout.goRoot, go);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && regular(go);
}

/** Installs `<shell>-<pi>` into versions/<shell>-<pi>/ in place: that folder
 * is claimed and marked `installing <id> <pid>` first, the distribution files
 * and the release lockfile are written, our pnpm runs `install --frozen-lockfile`
 * there, the installed gentle-pi and Pi versions are checked exactly, and only
 * then the marker is replaced by `<id>`. The folder is never renamed after pnpm
 * ran: on Windows pnpm links packages with absolute junctions when symlinks are
 * not allowed. An installed version is reused; a folder left by an interrupted
 * install of this id (its process gone) is removed and installed again; any
 * other folder is never replaced. On Windows the pinned Go is required, so
 * gentle-pi's postinstall never builds with the user's go.exe. Adapters (run,
 * and distribution for local fixture packages in place of the registry) are
 * trusted local test code only.
 */
export async function installVersion({ layout, manifest, lockfile, platform = layout.platform, env = {}, go = null, adapters = {} }) {
	const files = (adapters.distribution ?? distributionFiles)(manifest);
	const { shell, pi, id } = versionsOf(manifest);
	const destination = versionDirectory(layout, id);
	const path = pathFor(process.platform);
	const marker = path.join(destination, VERSION_MARKER);
	if (installedVersion(layout, id)) return { id, path: destination, installed: false };
	if (platform === "win32" && !pinnedGo(layout, go)) throw new Error("A Windows version install needs the pinned Go from ensureRuntime({ go: true })");
	if (typeof lockfile !== "string" || lockfile.length === 0) throw new Error("Release lockfile missing");
	const existing = stat(destination);
	if (existing) {
		const pending = existing.isDirectory() ? /^installing (\S+) ([1-9]\d*)\n$/.exec(read(marker) ?? "") : null;
		if (pending?.[1] !== id) throw new Error(`Conflicting version destination: ${destination}`);
		if (processAlive(Number(pending[2]))) throw new Error(`An installation of ${id} is in progress (process ${pending[2]})`);
		rmSync(destination, { recursive: true });
	}
	ensureDirectory(layout.versions, layout.platform);
	// mkdir is the atomic claim: a folder created meanwhile by anyone else fails here.
	mkdirSync(destination, { mode: 0o700 });
	try {
		writeFileSync(marker, `installing ${id} ${process.pid}\n`, { flag: "wx", mode: 0o600 });
		for (const [name, text] of Object.entries({ ...files, "pnpm-lock.yaml": lockfile })) writeFileSync(path.join(destination, name), text, { flag: "wx", mode: 0o600 });
		const result = await (adapters.run ?? runCommand)(layout.node, [layout.pnpm, "install", "--frozen-lockfile"],
			{ cwd: destination, env: pnpmEnvironment(layout, { platform, env, go }), timeout: INSTALL_TIMEOUT });
		// pnpm prints install and postinstall failures on stdout: keep both tails.
		if (result.status !== 0) {
			throw Object.assign(new Error(`pnpm install failed (exit ${result.status})`),
				{ stderr: [String(result.stdout ?? "").slice(-6000), String(result.stderr ?? "").slice(-4000)].filter(Boolean).join("\n") });
		}
		const shellDirectory = installedPackage(destination, "gentle-pi", shell, "gentle-pi");
		installedPackage(destination, "@earendil-works/pi-coding-agent", pi, "Pi");
		if (!regular(path.join(shellDirectory, "bin", "gentle-shell.mjs"))) throw new Error("Installed gentle-pi has no launcher entry");
		replaceAtomically(marker, (temp) => writeFileSync(temp, `${id}\n`, { flag: "wx", mode: 0o600 }));
		return { id, path: destination, installed: true };
	} catch (error) {
		// The folder is this call's own claim: nothing else was ever in it.
		rmSync(destination, { recursive: true, force: true });
		throw error;
	}
}

/** The active version id, or null when `current` is absent. A `current` this
 * module did not write (not our symlink or pointer file) throws.
 */
export function activeVersion(layout) {
	const info = stat(layout.current);
	if (!info) return null;
	const id = layout.currentKind === "symlink"
		? (info.isSymbolicLink() ? /^versions\/([^/]+)$/.exec(readlinkSync(layout.current))?.[1] : undefined)
		: (info.isFile() ? /^([^\r\n]+)\n$/.exec(readFileSync(layout.current, "utf8"))?.[1] : undefined);
	if (id === undefined || !VERSION_ID.test(id)) throw new Error(`Conflicting current: ${layout.current}`);
	return id;
}
function readHistory(layout) {
	return (read(layout.history) ?? "").split("\n").filter((id) => VERSION_ID.test(id) && !id.includes(".."));
}
/** Replaces `path` by one rename of a freshly written sibling. */
function replaceAtomically(path, write) {
	const temp = pathFor(process.platform).join(pathFor(process.platform).dirname(path), `.${pathFor(process.platform).basename(path)}-${randomBytes(6).toString("hex")}`);
	try {
		write(temp);
		renameSync(temp, path);
	} catch (error) {
		if (stat(temp)) unlinkSync(temp);
		throw error;
	}
}

/** Switches `current` to an installed version with one rename (a relative
 * symlink on POSIX, a pointer file on Windows) and records it first in the
 * activation history. Returns { id, previous }.
 */
export function activateVersion(layout, id) {
	versionDirectory(layout, id);
	if (!installedVersion(layout, id)) throw new Error(`${id} is not an installed version`);
	const previous = activeVersion(layout);
	replaceAtomically(layout.current, (temp) => {
		if (layout.currentKind === "symlink") symlinkSync(`versions/${id}`, temp);
		else writeFileSync(temp, `${id}\n`, { flag: "wx", mode: 0o600 });
	});
	const history = [...new Set([id, ...(previous ? [previous] : []), ...readHistory(layout)])];
	replaceAtomically(layout.history, (temp) => writeFileSync(temp, `${history.join("\n")}\n`, { flag: "wx", mode: 0o600 }));
	return { id, previous };
}

/** Deletes installed versions beyond the active one and the most recently
 * activated others, `keep` in all. Nothing is deleted unless `current` names an
 * installed version; the active one, unfinished installs and any folder
 * without our marker are never deleted. Returns the deleted ids.
 */
export function pruneVersions(layout, keep = 2) {
	const active = activeVersion(layout);
	if (!active || !installedVersion(layout, active)) return [];
	const kept = new Set([active]);
	for (const id of readHistory(layout)) if (kept.size < Math.max(keep, 1) && installedVersion(layout, id)) kept.add(id);
	const removed = [];
	for (const name of readdirSync(layout.versions).sort()) {
		if (name.startsWith(".") || kept.has(name) || !VERSION_ID.test(name) || !installedVersion(layout, name)) continue;
		rmSync(versionDirectory(layout, name), { recursive: true });
		removed.push(name);
	}
	if (removed.length > 0) replaceAtomically(layout.history, (temp) => writeFileSync(temp, `${readHistory(layout).filter((id) => !removed.includes(id)).join("\n")}\n`, { flag: "wx", mode: 0o600 }));
	return removed;
}

const UNPUBLISHED = Object.freeze({
	missing: (version) => `release v${version} does not publish the bundled distribution yet; try again later`,
	unavailable: (version) => `the bundled distribution of release v${version} could not be downloaded`,
	rejected: (version) => `the bundled distribution of release v${version} did not verify`,
});
const RELEASE_EXPORTS = Object.freeze(["prefixLayout", "ensureRuntime", "ensureLauncher"]);
/** The variable that makes a version's launcher run in bundled mode for
 * `--version` only, as if `current` named that version (lib/gentle-shell-bundled.ts).
 */
const VERIFY_ENV = "GENTLE_SHELL_VERIFY_VERSION";

const NPM_SHIM_MARK = "gentle-shell bundled npm entry (generated; do not edit)";
/** Writes runtime/node-<v>/gentle-shell/npm, a CommonJS file that runs the npm
 * bundled with that Node, and a package.json beside it that keeps it CommonJS
 * under any package.json with "type": "module" above the prefix. Pi names the
 * package manager from the basenames in npmCommand (getPackageManagerName in
 * Pi's core/package-manager.js), so this entry is named exactly `npm`; on
 * Windows it also avoids npm.cmd, which prefers an npm in the global prefix.
 * Each file is replaced with one rename, only when its content differs; a link
 * or anything but a regular file in its place stops it. Returns { written }.
 */
export function ensureNpmShim(layout) {
	const path = pathFor(layout.platform);
	if (!regular(layout.npmCli)) throw new Error(`Bundled npm missing: ${layout.npmCli}`);
	const folder = path.dirname(layout.npmShim);
	const cli = path.relative(folder, layout.npmCli).split(path.sep).map((part) => JSON.stringify(part)).join(", ");
	const files = {
		"package.json": '{ "type": "commonjs" }\n',
		[path.basename(layout.npmShim)]: [`// ${NPM_SHIM_MARK}`, `require(require("node:path").join(__dirname, ${cli}));`, ""].join("\n"),
	};
	const info = stat(folder);
	if (!info) mkdirSync(folder, { mode: 0o700 });
	else if (!info.isDirectory()) throw new Error(`Conflicting npm entry: ${folder}`);
	let written = false;
	for (const [name, text] of Object.entries(files)) {
		const target = path.join(folder, name);
		const existing = stat(target);
		if (existing && !existing.isFile()) throw new Error(`Conflicting npm entry: ${target}`);
		if (existing && readFileSync(target, "utf8") === text) continue;
		replaceAtomically(target, (temp) => writeFileSync(temp, text, { flag: "wx", mode: 0o600 }));
		written = true;
	}
	return { written };
}

/** The command Pi runs for npm in a bundled install (its `npmCommand` setting):
 * our npm on our Node, through the entry named npm (ensureNpmShim), so Pi treats
 * it as npm; it reads only the prefix npmrc and global config, with its cache
 * inside the prefix. npm ranks command-line flags above npm_config_* variables,
 * so the user's environment cannot redirect these. No --prefix: on the command
 * line it also sets npm's local prefix, and Pi installs a git extension's
 * dependencies with `npm install` in the clone, without a --prefix of its own
 * (its npm: installs pass one). No other part's basename is npm, pnpm or bun,
 * which Pi would reject as ambiguous.
 */
export function bundledNpmCommand(layout) {
	return [layout.node, layout.npmShim, `--userconfig=${layout.npmrc}`, `--globalconfig=${layout.npmGlobalConfig}`, `--cache=${layout.npmCache}`,
		"--update-notifier=false"];
}

/** The module an installed version ships (its own pins and launcher), only from
 * a regular file whose real path stays inside that version folder.
 */
async function releaseModule(file, versionPath) {
	if (!regular(file) || !realpathSync(file).startsWith(`${realpathSync(versionPath)}${pathFor(process.platform).sep}`)) return null;
	return import(pathToFileURL(file).href);
}
/** An installed version's own scripts/bundled-install.mjs and its layout of this
 * prefix; it must export prefixLayout, ensureRuntime and ensureLauncher as
 * functions. `active` names the version `current` stays at otherwise.
 */
async function loadRelease({ layout, id, home, platform, env, adapters, active }) {
	const path = pathFor(process.platform);
	const versionPath = versionDirectory(layout, id);
	const file = path.join(versionPath, "node_modules", "gentle-pi", "scripts", "bundled-install.mjs");
	const module = await (adapters.load ?? releaseModule)(file, versionPath);
	if (!module || RELEASE_EXPORTS.some((name) => typeof module[name] !== "function")) {
		throw new Error(`Gentle Shell ${id} has no usable scripts/bundled-install.mjs (${RELEASE_EXPORTS.join(", ")}); current stays at ${active}`);
	}
	return { module, next: module.prefixLayout({ platform, env, home, root: layout.root }) };
}
/** Switches `current` to `id` and writes that version's launcher; when the
 * launcher cannot be written, `current` goes back to `active` (one rename each).
 */
function activateWithLauncher(layout, id, active, { module, next }) {
	activateVersion(layout, id);
	try {
		module.ensureLauncher(next);
	} catch (error) {
		if (active) activateVersion(layout, active);
		else unlinkSync(layout.current);
		throw new Error(`the launcher for Gentle Shell ${id} could not be written (${error.message}); current stays at ${active}`);
	}
}

/** `gentle-shell upgrade` in a bundled install (S5, S6, S8): the latest
 * release's distribution assets (adapters.latest, adapters.distribution) are
 * installed beside the active version with our runtime, then the new version's
 * own module (loaded only from that version folder) installs its pinned runtime
 * when the pins moved. Its launcher, run in bundled mode for that version, must
 * print exactly the release's gentle-pi and Pi before `current` switches; the
 * release's launcher is then written (a failure puts `current` back) and two
 * versions are kept (a pruning failure is only a warning). An already current
 * release changes nothing; any failure leaves `current` as it was and removes a
 * version this call installed. Returns { id, changed, previous?, removed?, warning? }.
 */
export async function upgradeBundled({ layout, home, platform = layout.platform, arch = process.arch, env = {}, adapters, out = () => {} }) {
	const path = pathFor(process.platform);
	const latest = await adapters.latest();
	const release = await adapters.distribution(latest);
	if (release?.status !== "published") throw new Error((UNPUBLISHED[release?.status] ?? UNPUBLISHED.unavailable)(latest));
	const { manifest, lockfile } = release;
	const { shell, pi, id } = versionsOf(manifest);
	const active = activeVersion(layout);
	if (active === id) {
		out(`Gentle Shell ${shell} with Pi ${pi} is already current.`);
		return { id, changed: false };
	}
	const go = platform === "win32";
	const runtime = await (adapters.ensureRuntime ?? ensureRuntime)({ layout, platform, arch, go, env });
	const version = await installVersion({ layout, manifest, lockfile, platform, env, go: runtime.go, adapters: adapters.install ?? {} });
	try {
		const loaded = await loadRelease({ layout, id, home, platform, env, adapters, active });
		// The release's own pins, its Engram included (an older module ignores `engram`).
		await loaded.module.ensureRuntime({ layout: loaded.next, platform, arch, go, engram: true, env });
		const check = await checkLauncher(loaded.next, { id, shell, pi, platform, env, run: adapters.run });
		if (!check.ok) {
			throw Object.assign(new Error(`Gentle Shell ${id} reported ${JSON.stringify(check.reported)}, not gentle-shell ${shell} with pi ${pi}; current stays at ${active}`),
				{ stderr: check.stderr });
		}
		activateWithLauncher(layout, id, active, loaded);
	} catch (error) {
		if (version.installed && activeVersion(layout) !== id) rmSync(version.path, { recursive: true, force: true });
		throw error;
	}
	out(`Upgraded to Gentle Shell ${shell} with Pi ${pi} (from ${active ?? "no active version"}). Run 'gentle-shell upgrade --rollback' to switch back.`);
	try {
		return { id, changed: true, previous: active, removed: (adapters.prune ?? pruneVersions)(layout, 2) };
	} catch (error) {
		const warning = `older versions were not removed (${error.message})`;
		out(`warning: ${warning}`);
		return { id, changed: true, previous: active, removed: [], warning };
	}
}

/** Whether version `id` reports exactly `gentle-shell <shell>` and `pi <pi>` to
 * `--version`: its entry run by our Node, or with `launcher` on POSIX the
 * bin/gentle-shell launcher itself (it runs the version `current` names).
 * The environment is the one our pnpm ran in, without any Pi or Gentle override
 * that could point the launcher at another Pi or agent home.
 * Returns { ok, reported, stderr }.
 */
export async function checkLauncher(layout, { id, shell, pi, platform = layout.platform, env = {}, run = runCommand, launcher = false }) {
	// The environment our pnpm ran in, without any Pi or Gentle override that
	// could point the launcher at another Pi or agent home, plus the one input
	// that runs this version in bundled mode for its --version (exact Pi).
	const launchEnv = { ...Object.fromEntries(Object.entries(pnpmEnvironment(layout, { platform, env })).filter(([key]) => !/^(?:gentle_|pi_)/i.test(key))),
		[VERIFY_ENV]: id };
	const entry = pathFor(platform).join(layout.versions, id, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	const [command, args] = launcher && platform !== "win32" ? [layout.launcher, ["--version"]] : [layout.node, [entry, "--version"]];
	const result = await (run ?? runCommand)(command, args, { cwd: layout.root, env: launchEnv, timeout: 120000 });
	const reported = String(result.stdout ?? "").trim();
	const [shellLine, piLine] = reported.split(/\r?\n/);
	return { ok: result.status === 0 && shellLine === `gentle-shell ${shell}` && piLine === `pi ${pi}`, reported, stderr: String(result.stderr ?? "").slice(-4000) };
}

/** `gentle-shell upgrade --rollback`: `current` switches back to the most
 * recently active other version still installed, with that version's own
 * launcher and runtime pins (its own scripts/bundled-install.mjs, loaded like
 * upgradeBundled loads it). Without a usable module nothing changes; when its
 * launcher cannot be written `current` goes back. Returns { from, to }.
 */
export async function rollbackBundled({ layout, home, platform = layout.platform, arch = process.arch, env = {}, adapters = {} }) {
	const active = activeVersion(layout);
	const previous = readHistory(layout).find((id) => id !== active && installedVersion(layout, id));
	if (!previous) throw new Error("No previous Gentle Shell version is kept to roll back to");
	const loaded = await loadRelease({ layout, id: previous, home, platform, env, adapters, active });
	await loaded.module.ensureRuntime({ layout: loaded.next, platform, arch, go: platform === "win32", engram: true, env });
	activateWithLauncher(layout, previous, active, loaded);
	return { from: active, to: previous };
}

/** The launcher text: our Node running the current gentle-pi's
 * bin/gentle-shell.mjs, passing every argument and the exit code. Without an
 * active version it says so and exits 1. The Windows one reads the pointer file
 * with delayed expansion off, so `!`, `%`, `^` or `&` in the prefix path stay
 * literal inside its quotes.
 */
export function launcherText(layout) {
	if (layout.platform === "win32") {
		const node = win32.relative(layout.root, layout.node);
		const entry = "%~dp0..\\versions\\%GENTLE_SHELL_CURRENT%\\node_modules\\gentle-pi\\bin\\gentle-shell.mjs";
		return ["@echo off", `rem ${LAUNCHER_MARK}`, "setlocal DisableDelayedExpansion", 'set "GENTLE_SHELL_CURRENT="',
			'if exist "%~dp0..\\current" set /p GENTLE_SHELL_CURRENT=<"%~dp0..\\current"', "if not defined GENTLE_SHELL_CURRENT goto missing",
			`if not exist "${entry}" goto missing`, `"%~dp0..\\${node}" "${entry}" %*`, "exit /b %errorlevel%", ":missing",
			`>&2 echo ${LAUNCHER_MISSING}`, "exit /b 1", ""].join("\r\n");
	}
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	const entry = posix.join(layout.current, "node_modules/gentle-pi/bin/gentle-shell.mjs");
	return ["#!/bin/sh", `# ${LAUNCHER_MARK}`, `if [ ! -f ${quote(entry)} ]; then`, `\techo '${LAUNCHER_MISSING}' >&2`, "\texit 1", "fi",
		`exec ${quote(layout.node)} ${quote(entry)} "$@"`, ""].join("\n");
}
/** Writes bin/gentle-shell (bin/gentle-shell.cmd on Windows). A launcher this
 * module wrote is refreshed; any other file there is never replaced.
 */
export function ensureLauncher(layout) {
	const text = launcherText(layout);
	const existing = stat(layout.launcher);
	if (existing && (!existing.isFile() || !readFileSync(layout.launcher, "utf8").split(/\r?\n/)[1]?.endsWith(LAUNCHER_MARK))) {
		throw new Error(`Conflicting launcher: ${layout.launcher}`);
	}
	if (existing && readFileSync(layout.launcher, "utf8") === text) return { written: false };
	ensureDirectory(layout.bin, layout.platform);
	replaceAtomically(layout.launcher, (temp) => {
		writeFileSync(temp, text, { flag: "wx", mode: 0o755 });
		if (layout.platform !== "win32") chmodSync(temp, 0o755);
	});
	return { written: true };
}

/** The startup file that shell reads for the terminals users open:
 * - zsh: $ZDOTDIR/.zshrc (interactive shells);
 * - bash on macOS, where terminals start login shells: the first of
 *   ~/.bash_profile, ~/.bash_login and ~/.profile that exists, as login bash
 *   reads exactly one of them ("INVOCATION" in bash(1)); ~/.bash_profile only
 *   when none exists, since creating it would hide the user's ~/.profile;
 * - bash elsewhere: ~/.bashrc, what an interactive non-login bash (a Linux
 *   terminal) reads; distributions' ~/.profile sources it for login shells;
 * - fish: our own conf.d file; anything else: ~/.profile.
 */
function profileFor(platform, env, home) {
	const files = profileFiles(platform, env, home);
	const shell = posix.basename(String(env.SHELL ?? ""));
	if (shell === "bash" && platform === "darwin") return files.bash.find((path) => stat(path)) ?? files.bash[0];
	return (files[shell] ?? files.other)[0];
}
/** Every startup file profileFor can choose on `platform`, per shell, in its
 * order of preference: the one source for planning a line and for trusting a
 * receipt (readPathReceipt).
 */
function profileFiles(platform, env, home) {
	const config = posix.isAbsolute(env.XDG_CONFIG_HOME ?? "") ? env.XDG_CONFIG_HOME : posix.join(home, ".config");
	return {
		zsh: [posix.join(posix.isAbsolute(env.ZDOTDIR ?? "") ? env.ZDOTDIR : home, ".zshrc")],
		bash: platform === "darwin" ? [".bash_profile", ".bash_login", ".profile"].map((name) => posix.join(home, name)) : [posix.join(home, ".bashrc")],
		fish: [posix.join(config, "fish", "conf.d", "gentle-shell.fish")],
		other: [posix.join(home, ".profile")],
	};
}
/** Whether the installer may edit `path`: "file" (a regular file this user can
 * write, in real folders) or "absent" (creatable inside real, writable folders);
 * otherwise why not: "symlink" (the file or a folder above it under home is a
 * link, as stow, chezmoi and home-manager lay them out), "not-a-file" or
 * "not-writable".
 */
function profileState(path, home) {
	const realHome = realpathSync(home);
	const realFolder = (folder) => {
		const relative = posix.relative(home, folder);
		return relative.startsWith("..") || posix.isAbsolute(relative) || realpathSync(folder) === posix.join(realHome, relative);
	};
	const writable = (target) => {
		try { accessSync(target, constants.W_OK); return true; }
		catch { return false; }
	};
	const info = stat(path);
	if (info) {
		if (info.isSymbolicLink()) return "symlink";
		if (!info.isFile()) return "not-a-file";
		if (!realFolder(posix.dirname(path))) return "symlink";
		return writable(path) ? "file" : "not-writable";
	}
	let folder = posix.dirname(path);
	while (!stat(folder)) {
		if (posix.dirname(folder) === folder) return "not-a-file";
		folder = posix.dirname(folder);
	}
	const existing = stat(folder);
	if (existing.isSymbolicLink()) return "symlink";
	if (!existing.isDirectory()) return "not-a-file";
	if (!realFolder(folder)) return "symlink";
	return writable(folder) ? "absent" : "not-writable";
}
/** The marked line that puts `bin` first on PATH, for fish and for sh-like shells. */
function profileLines(bin) {
	return { fish: `set -gx PATH '${bin}' $PATH ${PROFILE_MARK}`, sh: `export PATH="${bin}:$PATH" ${PROFILE_MARK}` };
}
/** Whether `path`, followed through links, already holds `line`. */
function holdsLine(path, line) {
	try { return readFileSync(path, "utf8").split("\n").includes(line); }
	catch { return false; }
}
/** The single PATH change, planned and not applied:
 * - { kind: "none" } when bin/ or our ~/.local/bin link is already on PATH, or
 *   the profile (even through a link) already holds our line;
 * - POSIX { kind: "symlink", path, target }: ~/.local/bin/gentle-shell when
 *   ~/.local/bin is on PATH and that name is free;
 * - POSIX { kind: "profile", path, line, create }: otherwise one marked line in
 *   the shell's startup file (profileFor), only when profileState allows it;
 * - POSIX { kind: "manual", path, line, reason }: that file may not be edited;
 *   the user adds `line` and nothing is written;
 * - Windows { kind: "registry", key, name, entry }: bin/ in the HKCU user Path.
 */
export function pathEntryPlan(layout, { platform = layout.platform, env = {}, home }) {
	if (platform === "win32") {
		const normal = (value) => win32.normalize(value).replace(/(.)\\+$/, "$1").toLowerCase();
		const entries = String(envValue(env, "PATH", platform) ?? "").split(";").filter(Boolean).map(normal);
		if (entries.includes(normal(layout.bin))) return { kind: "none" };
		return { kind: "registry", key: "HKCU\\Environment", name: "Path", entry: layout.bin };
	}
	const entries = String(env.PATH ?? "").split(":").filter(Boolean).map((entry) => posix.normalize(entry).replace(/(.)\/+$/, "$1"));
	if (entries.includes(layout.bin)) return { kind: "none" };
	const localBin = posix.join(home, ".local", "bin");
	if (entries.includes(localBin) && stat(localBin)?.isDirectory()) {
		const link = posix.join(localBin, "gentle-shell");
		const existing = stat(link);
		if (!existing) return { kind: "symlink", path: link, target: layout.launcher };
		if (existing.isSymbolicLink() && readlinkSync(link) === layout.launcher) return { kind: "none" };
	}
	const profile = profileFor(platform, env, home);
	const fish = profile.endsWith(".fish");
	if (fish ? /['\\\n]/.test(layout.bin) : /["\\$`\n]/.test(layout.bin)) throw new Error(`Unsafe bundled bin path for a shell profile: ${layout.bin}`);
	const line = profileLines(layout.bin)[fish ? "fish" : "sh"];
	if (holdsLine(profile, line)) return { kind: "none" };
	const state = profileState(profile, home);
	if (state === "file" || state === "absent") return { kind: "profile", path: profile, line, create: state === "absent" };
	return { kind: "manual", path: profile, line, reason: state };
}

/** Applies a pathEntryPlan and returns its receipt ({ ...plan, applied }, plus
 * `separator` for a profile line), which removePathEntry needs to revert it
 * exactly. Nothing existing is replaced and nothing is written for "none" or
 * "manual". A profile that changed since the plan (now a link, or created
 * meanwhile) throws. Windows needs an injected `registry` adapter
 * ({ add(entry), remove(entry) }); an add that reports "present" (the user Path
 * already held the entry) applied nothing.
 */
export function applyPathEntry(plan, { registry } = {}) {
	if (plan.kind === "symlink") symlinkSync(plan.target, plan.path);
	else if (plan.kind === "profile") {
		const changed = () => new Error(`The shell profile changed since the PATH plan: ${plan.path}`);
		if (plan.create) {
			let folder = posix.dirname(plan.path);
			while (!stat(folder)) folder = posix.dirname(folder);
			if (!stat(folder).isDirectory()) throw changed();
			mkdirSync(posix.dirname(plan.path), { recursive: true });
			// wx: never through a file or link created meanwhile.
			try { writeFileSync(plan.path, `${plan.line}\n`, { flag: "wx", mode: 0o644 }); }
			catch (error) { if (error.code === "EEXIST") throw changed(); throw error; }
			return { ...plan, applied: true, separator: false };
		}
		if (!stat(plan.path)?.isFile()) throw changed();
		const text = readFileSync(plan.path, "utf8");
		if (text.split("\n").includes(plan.line)) return { ...plan, applied: false };
		const separator = text.length > 0 && !text.endsWith("\n");
		// O_NOFOLLOW: a link swapped in after the check above is refused, not followed.
		const fd = openSync(plan.path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
		try { writeSync(fd, `${separator ? "\n" : ""}${plan.line}\n`); }
		finally { closeSync(fd); }
		return { ...plan, applied: true, separator };
	} else if (plan.kind === "registry") {
		if (typeof registry?.add !== "function") throw new Error("The Windows PATH change needs a registry adapter");
		if (registry.add(plan.entry) === "present") return { ...plan, applied: false };
	} else return { ...plan, applied: false };
	return { ...plan, applied: true };
}
/** Reverts an applied receipt: only our symlink, only our exact marked line
 * (with the newline added before it, so the file reads as before), or only our
 * registry entry is removed. A profile applyPathEntry created is deleted when
 * nothing else is left in it. A profile that is no longer a regular file is
 * left alone, and so is everything a receipt with `applied: false` names: it
 * was there before. Returns { removed: true }, or { removed: false, note }
 * saying what was kept and why (a line the user edited, a link replaced).
 */
export function removePathEntry(plan, { registry } = {}) {
	const removed = { removed: true };
	if (plan.applied === false) return { removed: false, note: "it was there before the install" };
	if (plan.kind === "symlink") {
		const info = stat(plan.path);
		if (!info) return removed;
		if (!info.isSymbolicLink() || readlinkSync(plan.path) !== plan.target) return { removed: false, note: `${plan.path} no longer links to ${plan.target}, so it was kept` };
		unlinkSync(plan.path);
	} else if (plan.kind === "profile") {
		const info = stat(plan.path);
		if (!info) return removed;
		if (!info.isFile() || !plan.line.endsWith(PROFILE_MARK)) return { removed: false, note: `${plan.path} is no longer a regular file, so it was kept` };
		const lines = readFileSync(plan.path, "utf8").split("\n");
		const index = lines.indexOf(plan.line);
		if (index < 0) {
			// Edited by the user: nothing is rewritten; the marked lines left there are named.
			// Without any, the user already took the line out.
			const marked = lines.filter((line) => line.includes(PROFILE_MARK));
			return marked.length > 0 ? { removed: false, note: `${plan.path} still holds ${marked.join(" and ")} (edited, so it was kept)` } : removed;
		}
		lines.splice(index, 1);
		let text = lines.join("\n");
		if (plan.separator && index === lines.length - 1 && text.endsWith("\n")) text = text.slice(0, -1);
		if (plan.create && text === "") {
			unlinkSync(plan.path);
			return removed;
		}
		const mode = info.mode & 0o777;
		replaceAtomically(plan.path, (temp) => {
			writeFileSync(temp, text, { flag: "wx", mode });
			chmodSync(temp, mode);
		});
	} else if (plan.kind === "registry") {
		if (typeof registry?.remove !== "function") throw new Error("The Windows PATH change needs a registry adapter");
		registry.remove(plan.entry);
	}
	return removed;
}

// The PATH receipt (S7): the one PATH change applyPathEntry made, kept in the
// prefix so `gentle-shell self-uninstall` reverts exactly that change.
const RECEIPT_SCHEMA = 1;
const RECEIPT_FIELDS = Object.freeze({ symlink: ["path", "target"], profile: ["path", "line", "create", "separator"], registry: ["key", "name", "entry"] });
/** Writes an applied receipt to layout.pathReceipt (mode 0600, replaced with
 * one rename) and returns true; a receipt that applied nothing writes nothing
 * and returns false, so an earlier receipt stays.
 */
export function writePathReceipt(layout, receipt) {
	if (receipt?.applied !== true) return false;
	const fields = RECEIPT_FIELDS[receipt.kind];
	if (!fields) throw new Error(`Unknown PATH entry kind: ${receipt.kind}`);
	const text = `${JSON.stringify({ schema: RECEIPT_SCHEMA, kind: receipt.kind, ...Object.fromEntries(fields.map((field) => [field, receipt[field]])) }, null, "\t")}\n`;
	replaceAtomically(layout.pathReceipt, (temp) => {
		writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
		if (layout.platform !== "win32") chmodSync(temp, 0o600);
	});
	return true;
}
/** Whether a receipt names only what this prefix writes: our launcher linked as
 * ~/.local/bin/gentle-shell, our exact marked line for bin/ in a startup file
 * pathEntryPlan can choose for this user (profileFiles, with the same ZDOTDIR
 * and XDG_CONFIG_HOME rules), or bin/ in the HKCU user Path.
 */
function ownPathEntry(layout, receipt, { env, home }) {
	if (layout.platform === "win32") return receipt.kind === "registry" && receipt.key === "HKCU\\Environment" && receipt.name === "Path" && receipt.entry === layout.bin;
	if (typeof home !== "string" || !posix.isAbsolute(home)) return false;
	if (receipt.kind === "symlink") return receipt.path === posix.join(home, ".local", "bin", "gentle-shell") && receipt.target === layout.launcher;
	if (receipt.kind !== "profile" || typeof receipt.create !== "boolean" || typeof receipt.separator !== "boolean") return false;
	// Only a file pathEntryPlan can choose here, holding the line it writes there.
	const lines = profileLines(layout.bin);
	const files = profileFiles(layout.platform, env, home);
	return Object.entries(files).some(([shell, paths]) => paths.includes(receipt.path) && receipt.line === lines[shell === "fish" ? "fish" : "sh"]);
}
/** The persisted receipt: { status: "recorded", receipt } (applied: true, as
 * removePathEntry takes it), { status: "none" } without one, or
 * { status: "invalid", reason } for anything that is not a regular file this
 * prefix wrote (never acted on). `env` and `home` are the user's, as
 * pathEntryPlan read them.
 */
export function readPathReceipt(layout, { env = {}, home } = {}) {
	const info = stat(layout.pathReceipt);
	if (!info) return { status: "none" };
	const invalid = (reason) => ({ status: "invalid", reason: `${layout.pathReceipt} ${reason}` });
	if (!info.isFile()) return invalid("is not a regular file");
	if (info.size > 64 * 1024) return invalid("is too large");
	let data;
	try { data = JSON.parse(readFileSync(layout.pathReceipt, "utf8")); }
	catch { return invalid("is not valid JSON"); }
	if (data === null || typeof data !== "object" || Array.isArray(data) || data.schema !== RECEIPT_SCHEMA || !Object.hasOwn(RECEIPT_FIELDS, data.kind)) {
		return invalid("has an unknown format");
	}
	const receipt = { kind: data.kind, ...Object.fromEntries(RECEIPT_FIELDS[data.kind].map((field) => [field, data[field]])), applied: true };
	return ownPathEntry(layout, receipt, { env, home }) ? { status: "recorded", receipt } : invalid("does not describe this install's PATH entry");
}
/** What a recorded receipt changed, for the uninstall plan. */
export function describePathReceipt(receipt) {
	if (receipt.kind === "symlink") return `the link ${receipt.path} to ${receipt.target}`;
	if (receipt.kind === "profile") return `the line ${receipt.line} in ${receipt.path}${receipt.create ? " (and that file, when nothing else is left in it)" : ""}`;
	return `${receipt.entry} in your user Path (${receipt.key})`;
}

// Windows: once process GENTLE_SHELL_REMOVE_AFTER_PID exits, deletes each file
// in GENTLE_SHELL_REMOVE_FILES (retrying while it is still in use), then
// GENTLE_SHELL_REMOVE_LAST (the prefix marker) only when nothing is left at any
// of those paths, so a failed removal can be retried with self-uninstall, then each
// folder in GENTLE_SHELL_REMOVE_DIRECTORIES only when it is empty (never
// recursively, so no link is followed). Every path is data, never script text.
const deferredRemovalScript = `$ErrorActionPreference = 'SilentlyContinue'
$waitFor = [int]$env:GENTLE_SHELL_REMOVE_AFTER_PID
try { Wait-Process -Id $waitFor -Timeout 600 -ErrorAction Stop } catch {}
Start-Sleep -Seconds 2
$files = @($env:GENTLE_SHELL_REMOVE_FILES -split "\`n" | Where-Object { $_ -ne '' })
foreach ($file in $files) {
  for ($try = 0; $try -lt 60; $try++) {
    try { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }; break } catch { Start-Sleep -Milliseconds 500 }
  }
}
$last = $env:GENTLE_SHELL_REMOVE_LAST
if ($last -and @($files | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0) { try { [IO.File]::Delete($last) } catch {} }
foreach ($folder in @($env:GENTLE_SHELL_REMOVE_DIRECTORIES -split "\`n" | Where-Object { $_ -ne '' })) {
  try { [IO.Directory]::Delete($folder, $false) } catch {}
}
exit 0`;
/** Windows self-uninstall: the running node.exe and the .cmd launcher cannot
 * delete themselves, so one detached, hidden Windows PowerShell removes `files`,
 * then `last` once nothing is left at those paths, then the empty
 * `directories` (deepest first), after process `pid` exits.
 * cmd.exe (detached) starts it with `start`, so it outlives the launcher; the
 * script goes as -EncodedCommand (UTF-16LE base64). Absolute local
 * paths only, passed in the environment; `spawn` is injectable for tests.
 */
export function scheduleWindowsRemoval({ pid, files, last, directories, env = {}, spawn: start = spawn }) {
	const systemRoot = envValue(env, "SYSTEMROOT", "win32");
	const safe = (path) => typeof path === "string" && win32.isAbsolute(path) && !path.startsWith("\\\\") && !/[\r\n]/.test(path);
	// SystemRoot is part of cmd's command line (the PowerShell path): no cmd metacharacter.
	const cmdSafe = (path) => safe(path) && !/[&|<>^%!"]/.test(path);
	if (!Number.isInteger(pid) || pid <= 0 || !cmdSafe(systemRoot) || ![...files, ...directories, ...(last === undefined ? [] : [last])].every(safe)) {
		throw new Error("Unsafe deferred removal request");
	}
	// A detached PowerShell never ran on the Windows runner, and a non-detached one
	// sits in Node's job object and dies with the exiting launcher. A detached
	// cmd.exe leaves that job and `start` gives PowerShell its own console, so it
	// outlives the launcher. Only fixed tokens and base64 reach cmd's command line.
	const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const encoded = Buffer.from(deferredRemovalScript, "utf16le").toString("base64");
	const child = start(win32.join(systemRoot, "System32", "cmd.exe"), ["/d", "/c", "start", "\"\"", "/min", powershell,
		"-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
		cwd: systemRoot, detached: true, stdio: "ignore", windowsHide: true,
		env: { ...env, GENTLE_SHELL_REMOVE_AFTER_PID: String(pid), GENTLE_SHELL_REMOVE_FILES: files.join("\n"), GENTLE_SHELL_REMOVE_DIRECTORIES: directories.join("\n"),
			GENTLE_SHELL_REMOVE_LAST: last ?? "" },
	});
	child.unref();
}
