import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, delimiter } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";

// Acquisition pins, not compatibility minima. Sources verified before pinning:
// https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
// https://registry.npmjs.org/pnpm/11.1.1 (dist.integrity and engines.node)
const nodeHashes = Object.freeze({
	"darwin-arm64": "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
	"darwin-x64": "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
	"linux-arm64": "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
	"linux-x64": "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
});
const pnpm = Object.freeze({
	name: "pnpm", version: "11.1.1", engine: ">=22.13",
	url: "https://registry.npmjs.org/pnpm/-/pnpm-11.1.1.tgz",
	integrity: "sha512-0f319zxhe2T6GlaoHDyN/g6WbjOmAQqiVrUXrne+Idk+Ba/8DeGoOw5PKdVp9otEaujwaM1yR8C7PfD7TXvfmg==",
	maxBytes: 32 * 1024 * 1024,
});
// Go toolchain used only to build Gentle AI: https://go.dev/dl/?mode=json&include=all
// lists each archive's sha256 and size; every archive was downloaded and re-hashed
// before pinning. go.dev/dl/<file> redirects to dl.google.com/go/<file>, and
// download() refuses redirects, so the pins name the final URL.
const go = Object.freeze({
	version: "1.25.14",
	maxExpandedBytes: 512 * 1024 * 1024,
	archives: Object.freeze({
		"darwin-arm64": ["darwin-arm64.tar.gz", "5b26c0b6f308240fca2614fb02f622cfcc8c0cc3b69c78bba4845489a4590259", 58123934],
		"darwin-x64": ["darwin-amd64.tar.gz", "b09087a67d5792a8b0fcbf74212d62560c94ac8a8fd750ff920d8cb5f1e20118", 60622678],
		"linux-x64": ["linux-amd64.tar.gz", "a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712", 59909419],
		"linux-arm64": ["linux-arm64.tar.gz", "9bf234ea70ffec9347fdf6b22ce4add51717d3386a38a441e8c8743fceb5eaee", 57360344],
		"win32-x64": ["windows-amd64.zip", "119044a92b3987c341cd6aebb256676dd4780d292f7b4e72a3e9976677841697", 67591780],
		"win32-arm64": ["windows-arm64.zip", "96fb31ae26b288b5311bd31d8252d4a62c8a661e4dbb64d504cc646e4d10a57f", 64735369],
	}),
});
/** The Go version acquireGo publishes. */
export const goPinVersion = go.version;

/** Fixed allowlist; callers cannot supply download URLs, checksums or commands. */
export function artifactFor(name, platform, arch) {
	if (name === "pnpm") return pnpm;
	if (name === "node" && platform === "win32" && ["x64", "arm64"].includes(arch)) {
		const pin = JSON.parse(readFileSync(new URL("./installer-windows-artifacts.json", import.meta.url), "utf8")).node;
		const target = pin[arch];
		if (pin.version !== "24.21.0" || target.url !== `https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-${arch}.zip` || !/^[a-f0-9]{64}$/.test(target.sha256) || pin.maxBytes !== 104857600) {
			throw new Error("Windows artifact metadata rejected");
		}
		return Object.freeze({ name, version: pin.version, platform, arch, url: target.url, integrity: `sha256-${target.sha256}`, maxBytes: pin.maxBytes });
	}
	if (name === "go") {
		const pin = Object.hasOwn(go.archives, `${platform}-${arch}`) ? go.archives[`${platform}-${arch}`] : null;
		if (!pin) throw new Error("Unsupported acquisition target");
		const [suffix, sha256, size] = pin;
		return Object.freeze({ name, version: go.version, platform, arch, url: `https://dl.google.com/go/go${go.version}.${suffix}`,
			integrity: `sha256-${sha256}`, size, maxBytes: size });
	}
	const hash = nodeHashes[`${platform}-${arch}`];
	if (name !== "node" || !hash) throw new Error("Unsupported acquisition target");
	return Object.freeze({ name, version: "24.21.0", platform, arch,
		url: `https://nodejs.org/dist/v24.21.0/node-v24.21.0-${platform}-${arch}.tar.gz`,
		integrity: `sha256-${hash}`, maxBytes: 100 * 1024 * 1024 });
}

async function download(descriptor) {
	const response = await fetch(descriptor.url, { redirect: "error", signal: AbortSignal.timeout(60000) });
	if (!response.ok || !response.body) throw new Error("Download failed");
	const advertised = response.headers.get("content-length");
	if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > descriptor.maxBytes)) {
		await response.body.cancel();
		throw new Error("Download size rejected");
	}
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > descriptor.maxBytes) throw new Error("Download size rejected");
			chunks.push(Buffer.from(value));
		}
		if (advertised && Number(advertised) !== size) throw new Error("Download truncated");
		return Buffer.concat(chunks, size);
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** Pure descriptor selection + injected byte transport/digest for deterministic tests.
 * Production always hashes actual bytes; test adapters (download, digest and the
 * artifact descriptor) are trusted local code only. A descriptor with a size
 * accepts exactly that many bytes.
 * No extraction or execution is allowed before this function succeeds.
 */
export async function verifiedDownload(name, adapters = {}, platform, arch) {
	const descriptor = (adapters.artifact ?? artifactFor)(name, platform, arch);
	let bytes;
	try { bytes = await (adapters.download ?? download)(descriptor); }
	catch { throw new Error("Download failed"); }
	if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > descriptor.maxBytes) throw new Error("Download size rejected");
	if (descriptor.size !== undefined && bytes.length !== descriptor.size) throw new Error("Download size rejected");
	const [algorithm, encoded] = descriptor.integrity.split("-");
	const expected = Buffer.from(encoded, algorithm === "sha256" ? "hex" : "base64");
	const actual = (adapters.digest ?? ((data, hash) => createHash(hash).update(data).digest()))(bytes, algorithm);
	if (!Buffer.isBuffer(actual) || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw new Error("Download integrity mismatch");
	}
	return bytes;
}

function parts(version) {
	if (typeof version !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
	const values = version.replace(/^v/, "").split(".").map(Number);
	return values.every(Number.isSafeInteger) ? values : null;
}
export function compatibleEngine(range, version) {
	if (typeof range !== "string") return false;
	// Preserve raw pin metadata; normalize only simple >=major.minor[.patch] bounds.
	const bound = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(range);
	if (!bound) return false;
	const required = parts(`${bound[1]}.${bound[2]}.${bound[3] ?? "0"}`);
	const actual = parts(version);
	if (!required || !actual) return false;
	for (let index = 0; index < 3; index += 1) {
		if (actual[index] !== required[index]) return actual[index] > required[index];
	}
	return true;
}
function stat(path) {
	try { return lstatSync(path); }
	catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function regular(path) {
	const info = stat(path);
	return info?.isFile() && !info.isSymbolicLink();
}
function processCheck(command, args, env) {
	// TERM can be ignored, leaving spawnSync blocked beyond its timeout. Kill only
	// the spawned prerequisite child; this is not process-tree cancellation.
	// A neutral cwd: inside a project, pnpm 11 reports the version that
	// project's packageManager pins instead of its own.
	const result = spawnSync(command, args, { cwd: "/", env, encoding: "utf8", timeout: 15000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true });
	if (result.error || result.status !== 0) throw new Error("Prerequisite process check failed");
	return result.stdout.trim();
}
function findExecutable(name, env) {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		// Empty/relative PATH entries cannot prove executable ownership.
		if (!directory.startsWith("/")) throw new Error("Unknown prerequisite PATH compatibility");
		const path = join(directory, name);
		if (stat(path)) return path;
	}
	return null;
}
function head(path, size) {
	const buffer = Buffer.alloc(size);
	const fd = openSync(path, "r");
	try {
		return buffer.subarray(0, readSync(fd, buffer, 0, size, 0));
	} finally {
		closeSync(fd);
	}
}
// pnpm installs itself in $PNPM_HOME behind a regular cmd-shim file, not a
// symlink. pnpm 11 names its target in a `# cmd-shim-target=` comment; older
// shims only run the single `"$basedir/<target>" "$@"` next to the shim. The
// target is a starting point for the evidence search, not proof: the command
// itself still has to print the version that evidence names.
function shimTarget(command) {
	if (!regular(command)) return null;
	const text = head(command, 4096).toString("utf8");
	const match = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(text);
	if (match) return stat(match[1]) ? match[1] : null;
	const targets = new Set([...text.matchAll(/"\$basedir\/([^"$`\\]+)"[ \t]+"\$@"/g)]
		.map(([, target]) => join(realpathSync(dirname(command)), target)));
	const [target] = targets;
	return targets.size === 1 && stat(target) ? target : null;
}
function packageFor(target) {
	let directory = dirname(target);
	for (let depth = 0; depth < 4; depth += 1) {
		const file = join(directory, "package.json");
		if (regular(file)) {
			const metadata = JSON.parse(readFileSync(file, "utf8"));
			if (metadata.name === "pnpm") return metadata;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("Existing pnpm compatibility is unknown: package engine evidence missing");
}
// mise, asdf and pnpm's own installer (directly or behind its shim, as
// @pnpm/exe) ship pnpm as a standalone native executable that embeds its own
// Node runtime, so the user's Node engine does not apply to it. Only a Mach-O
// or ELF header qualifies; scripts and shims without a package still need
// package engine evidence.
const nativeHeaders = ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "7f454c46"];
function standalonePnpm(target) {
	return regular(target) && nativeHeaders.includes(head(target, 4).toString("hex"));
}
// The pnpm package a native executable ships in (@pnpm/exe, @pnpm/<platform>,
// pnpm 12), when there is one: its version is what the executable must print.
function standaloneVersion(target) {
	const file = join(dirname(target), "package.json");
	if (!regular(file)) return null;
	const metadata = JSON.parse(readFileSync(file, "utf8"));
	return metadata.name === "pnpm" || /^@pnpm\//.test(metadata.name) ? metadata.version : null;
}
function provePnpm(command, prefix, metadata, nodeVersion, env, processAdapter, known = null) {
	if (metadata && (!parts(metadata.version) || !compatibleEngine(metadata.engines?.node, nodeVersion))) {
		throw new Error("pnpm compatibility is unknown or incompatible; refusing replacement");
	}
	const version = known ?? processAdapter(command, [...prefix, "--version"], env);
	if (metadata ? version !== metadata.version : !parts(version)) throw new Error("pnpm version rejected");
	// Read-only CLI capability checks; do not execute add/bin or write global config.
	for (const capability of ["add", "bin"]) {
		if (!/(?:^|[\s,])--global(?:[\s,=]|$)/.test(processAdapter(command, [...prefix, "help", capability], env))) {
			throw new Error("pnpm global-install capability evidence missing");
		}
	}
}
function privateTools(home) {
	if (!home || !home.startsWith("/") || realpathSync(home) !== resolve(home)) throw new Error("Unsafe tooling HOME");
	const info = lstatSync(home);
	if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022)) throw new Error("Unsafe tooling HOME ownership");
	const tools = mkdtempSync(join(home, ".gentle-shell-bootstrap-tools."));
	try {
		writeFileSync(join(tools, ".bootstrap-owned"), "gentle-pi prerequisite tooling only\n", { mode: 0o600, flag: "wx" });
		return tools;
	} catch {
		rmSync(tools, { recursive: true, force: true });
		throw new Error("Unsafe tooling ownership marker could not be created");
	}
}

/** Remove only the exact private `$HOME/.gentle-shell-bootstrap-tools.*` directory
 * carrying this module's marker. rmSync never follows links inside it.
 * Returns false instead of throwing so success never turns into failure.
 */
export function removeOwnedTools(tools, home) {
	try {
		if (typeof tools !== "string" || typeof home !== "string" || !home.startsWith("/") || resolve(tools) !== tools) return false;
		if (dirname(tools) !== resolve(home) || !basename(tools).startsWith(".gentle-shell-bootstrap-tools.")) return false;
		const info = lstatSync(tools);
		if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) return false;
		const marker = join(tools, ".bootstrap-owned");
		if (!regular(marker) || readFileSync(marker, "utf8") !== "gentle-pi prerequisite tooling only\n") return false;
		rmSync(tools, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/** The pnpm the installer runs: the pinned major (the runner's argv is verified
 * for it, as installer-probes checks) at the pinned version or newer.
 */
export function pinnedPnpmCompatible(version) {
	const actual = parts(version);
	return actual !== null && actual[0] === parts(pnpm.version)[0] && compatibleEngine(`>=${pnpm.version}`, version);
}

/** Reuse only proven engines/capabilities; missing pnpm gets verified registry bytes.
 * An existing pnpm with stable version evidence of another major, older than the
 * pin, or whose simple engine bound rejects this Node is left as it is, and the
 * verified pnpm is acquired exactly as when pnpm is missing. Unknown evidence
 * still refuses. Local test adapters cover transport/hash/process. There is no
 * remote command API. `tools` is a private directory owned by the invoking
 * bootstrap/controller, or a function claiming one only when acquisition starts.
 */
export async function ensurePnpm({ tools, env, nodeVersion, adapters = {} }) {
	const processAdapter = adapters.process ?? processCheck;
	const existing = findExecutable("pnpm", env);
	if (existing) {
		const target = realpathSync(shimTarget(existing) ?? existing);
		const standalone = standalonePnpm(target);
		const metadata = standalone ? null : packageFor(target);
		const bound = /^>=(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(metadata?.engines?.node ?? "");
		// A standalone pnpm reports its version only by running; that answer is reused.
		const version = metadata ? null : processAdapter(existing, ["--version"], env);
		const shipped = standalone ? standaloneVersion(target) : null;
		if (shipped !== null && version !== shipped) throw new Error("pnpm version rejected");
		const incompatible = metadata
			? parts(metadata.version) !== null && bound && (!pinnedPnpmCompatible(metadata.version) || !compatibleEngine(metadata.engines.node, nodeVersion))
			: parts(version) !== null && !pinnedPnpmCompatible(version);
		if (!incompatible) {
			provePnpm(existing, [], metadata, nodeVersion, env, processAdapter, version);
			return { env, acquired: false };
		}
	}
	if (typeof tools === "function") tools = tools();
	const info = stat(tools);
	if (!info?.isDirectory() || info.isSymbolicLink() || realpathSync(tools) !== resolve(tools) || info.uid !== process.getuid() || (info.mode & 0o077)) {
		throw new Error("Unsafe private tooling destination");
	}
	const destination = join(tools, "pnpm");
	if (stat(destination)) throw new Error("Conflicting pnpm destination");
	const tar = findExecutable("tar", env);
	if (!tar) throw new Error("Required utility missing: tar");
	const stage = mkdtempSync(join(tools, "pnpm-stage-"));
	let published = false;
	try {
		const archive = join(stage, "pnpm.tgz");
		writeFileSync(archive, await verifiedDownload("pnpm", adapters), { flag: "wx", mode: 0o600 });
		const names = processAdapter(tar, ["-tzf", archive], env).split("\n");
		if (!names.length || names.some((name) => !name.startsWith("package/") || name.split("/").includes("..") || name.includes("\\"))) {
			throw new Error("Unsafe pnpm archive paths");
		}
		const types = processAdapter(tar, ["-tvzf", archive], env).split("\n");
		if (types.some((line) => !/^[d-]/.test(line))) throw new Error("Unsafe pnpm archive links");
		processAdapter(tar, ["-xzf", archive, "-C", stage], env);
		const pkg = join(stage, "package");
		const entry = join(pkg, "bin/pnpm.mjs");
		if (!regular(entry) || !regular(join(pkg, "package.json"))) throw new Error("pnpm archive entry missing");
		const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
		if (metadata.name !== "pnpm" || metadata.version !== pnpm.version || metadata.engines?.node !== pnpm.engine) throw new Error("pnpm pin metadata rejected");
		provePnpm(process.execPath, [entry], metadata, nodeVersion, env, processAdapter);
		// mkdir is the atomic no-clobber claim (rename alone can replace directories).
		mkdirSync(destination, { mode: 0o700 });
		published = true;
		renameSync(pkg, join(destination, "package"));
		mkdirSync(join(destination, "bin"), { mode: 0o700 });
		const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
		writeFileSync(join(destination, "bin/pnpm"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(destination, "package/bin/pnpm.mjs"))} "$@"\n`, { flag: "wx", mode: 0o700 });
		return { acquired: true, env: { ...env, PATH: `${join(destination, "bin")}${delimiter}${env.PATH}` } };
	} catch {
		if (published) rmSync(destination, { recursive: true, force: true });
		throw new Error("pnpm verified acquisition failed; no installation completed");
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

/** A Go archive member: under `go/`, with no empty, `.` or `..` segment and no
 * backslash, colon or control character. Returns it without a trailing `/`.
 */
function goMember(name, directory) {
	const parts = (directory ? name.replace(/\/$/, "") : name).split("/");
	if (name.length > 1024 || parts[0] !== "go" || /[\\:\u0000-\u001f\u007f]/.test(name) ||
		parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Unsafe Go archive path");
	return parts.join("/");
}

/** A PAX extended header that only renames the next member (`path`, as go.dev
 * uses for non-ASCII names). Any other key could change its meaning: rejected.
 */
function paxPath(data) {
	let path = null;
	for (let rest = data; rest.length > 0;) {
		const space = rest.indexOf(0x20);
		const digits = rest.subarray(0, Math.max(space, 0)).toString("latin1");
		const length = Number(digits);
		if (!/^[1-9]\d{0,5}$/.test(digits) || length > rest.length || rest[length - 1] !== 0x0a) throw new Error("Unsafe Go archive header");
		const record = rest.subarray(space + 1, length - 1).toString("utf8");
		if (!record.startsWith("path=") || path !== null) throw new Error("Unsafe Go archive header");
		path = record.slice(5);
		rest = rest.subarray(length);
	}
	if (path === null) throw new Error("Unsafe Go archive header");
	return path;
}

/** Members of a go.dev `.tar.gz`: POSIX ustar regular files and directories only. */
function goTarEntries(bytes) {
	const tar = gunzipSync(bytes, { maxOutputLength: go.maxExpandedBytes });
	const text = (block, start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0[^]*$/, "");
	const number = (block, start, length) => {
		const value = text(block, start, length).trim();
		if (!/^[0-7]{1,12}$/.test(value)) throw new Error("Unsafe Go archive header");
		return parseInt(value, 8);
	};
	const entries = [];
	let renamed = null;
	for (let offset = 0; ;) {
		if (offset + 512 > tar.length) throw new Error("Unsafe Go archive termination");
		const block = tar.subarray(offset, offset + 512);
		if (block.every((byte) => byte === 0)) {
			if (renamed !== null || !tar.subarray(offset).every((byte) => byte === 0)) throw new Error("Unsafe Go archive termination");
			return entries;
		}
		let checksum = 0;
		for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : block[index];
		if (checksum !== number(block, 148, 8) || block.subarray(257, 265).toString("latin1") !== "ustar\u000000") throw new Error("Unsafe Go archive header");
		const size = number(block, 124, 12);
		const type = String.fromCharCode(block[156]);
		const start = offset + 512;
		if (start + size > tar.length) throw new Error("Unsafe Go archive termination");
		offset = start + Math.ceil(size / 512) * 512;
		if (type === "x" && renamed === null) {
			renamed = paxPath(tar.subarray(start, start + size));
			continue;
		}
		const directory = type === "5";
		if (!directory && type !== "0" && type !== "\0") throw new Error("Unsafe Go archive entry type");
		const prefix = text(block, 345, 155);
		const name = renamed ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
		renamed = null;
		if ((directory && size !== 0) || (!directory && name.endsWith("/")) || text(block, 157, 100) !== "") throw new Error("Unsafe Go archive entry type");
		entries.push({ name: goMember(name, directory), directory, executable: (number(block, 100, 8) & 0o111) !== 0,
			bytes: tar.subarray(start, start + size) });
		if (entries.length > 50000) throw new Error("Unsafe Go archive entry count");
	}
}

/** Members of a go.dev Windows `.zip`: stored or deflated, unencrypted, no ZIP64,
 * each matching its local header and CRC-32. A Unix-made member must be a
 * regular file or directory (go.dev's are), never a link.
 */
function goZipEntries(bytes) {
	const fail = () => { throw new Error("Unsafe Go archive"); };
	const end = bytes.length - 22;
	if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) fail();
	const count = bytes.readUInt16LE(end + 10);
	const directoryStart = bytes.readUInt32LE(end + 16);
	if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || count > 50000 ||
		directoryStart + bytes.readUInt32LE(end + 12) !== end) fail();
	const entries = [];
	let expanded = 0;
	let at = directoryStart;
	for (let index = 0; index < count; index += 1) {
		if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail();
		const [flags, method, crc, compressed, size] = [bytes.readUInt16LE(at + 8), bytes.readUInt16LE(at + 10),
			bytes.readUInt32LE(at + 16), bytes.readUInt32LE(at + 20), bytes.readUInt32LE(at + 24)];
		const nameLength = bytes.readUInt16LE(at + 28);
		const mode = bytes.readUInt32LE(at + 38) >>> 16;
		const local = bytes.readUInt32LE(at + 42);
		const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		const directory = name.endsWith("/");
		const unix = bytes[at + 5] === 3;
		at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
		if (at > end || (flags & 0x41) !== 0 || (method !== 0 && method !== 8) || compressed === 0xffffffff || size === 0xffffffff) fail();
		if (unix && (mode & 0o170000) !== (directory ? 0o040000 : 0o100000)) fail();
		if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) fail();
		const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
		if (bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString("utf8") !== name || data + compressed > directoryStart) fail();
		expanded += size;
		if (expanded > go.maxExpandedBytes || (directory && size !== 0)) fail();
		const raw = bytes.subarray(data, data + compressed);
		const content = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
		if (content.length !== size || crc32(content) !== crc) fail();
		entries.push({ name: goMember(name, directory), directory, executable: unix && (mode & 0o111) !== 0, bytes: content });
	}
	if (at !== end) fail();
	return entries;
}

const GO_MARKER = ".gentle-shell-go";
/** An existing directory owned by this user that no one else can write to. */
function privateDirectory(path) {
	const info = stat(path);
	if (!info?.isDirectory() || info.isSymbolicLink()) return false;
	return process.platform === "win32" || (info.uid === process.getuid() && (info.mode & 0o022) === 0);
}

/** The pinned Go a previous acquireGo published under `root` for this target, or
 * null: `<root>/<version>` private, marked with the exact pinned archive URL,
 * holding a regular `go/bin/go` (`go.exe` on Windows). Read-only; never throws.
 */
export function installedGo(root, platform, arch, adapters = {}) {
	try {
		const descriptor = (adapters.artifact ?? artifactFor)("go", platform, arch);
		const directory = join(root, descriptor.version);
		const goPath = join(directory, "go", "bin", platform === "win32" ? "go.exe" : "go");
		if (!privateDirectory(root) || !privateDirectory(directory) || !regular(join(directory, GO_MARKER))) return null;
		return readFileSync(join(directory, GO_MARKER), "utf8") === `${descriptor.url}\n` && regular(goPath) ? goPath : null;
	} catch {
		return null;
	}
}

/** The pinned Go, only to build Gentle AI: the copy installedGo finds, otherwise
 * the exact go.dev archive, verified (size and SHA-256) before it is read,
 * extracted in process into a private staging directory (regular files and
 * directories under `go/` only; no links, traversal or duplicates), checked
 * against its VERSION and published without replacing anything as
 * `<root>/<version>/go`, marked last. Nothing outside `root` is written, and the
 * user's own Go, PATH and profile are never touched. Adapters (artifact,
 * download, digest) are trusted local test code only.
 * Returns { goPath, version, acquired }.
 */
export async function acquireGo({ root, platform, arch, adapters = {} }) {
	const descriptor = (adapters.artifact ?? artifactFor)("go", platform, arch);
	const executable = platform === "win32" ? "go.exe" : "go";
	const destination = join(root, descriptor.version);
	const reused = installedGo(root, platform, arch, adapters);
	if (reused) return { goPath: reused, version: descriptor.version, acquired: false };
	let stage = null;
	let claimed = false;
	try {
		if (stat(destination)) throw new Error("Conflicting Go destination");
		const bytes = await verifiedDownload("go", adapters, platform, arch);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		if (!privateDirectory(root)) throw new Error("Unsafe Go destination");
		const entries = descriptor.url.endsWith(".zip") ? goZipEntries(bytes) : goTarEntries(bytes);
		stage = mkdtempSync(join(root, ".stage-"));
		for (const entry of entries) {
			const target = join(stage, ...entry.name.split("/"));
			if (entry.directory) {
				mkdirSync(target, { recursive: true, mode: 0o755 });
			} else {
				mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
				// wx: a duplicate member, also one differing only in case, fails closed.
				writeFileSync(target, entry.bytes, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
			}
		}
		const tree = join(stage, "go");
		if (!regular(join(tree, "bin", executable)) || !regular(join(tree, "VERSION")) ||
			readFileSync(join(tree, "VERSION"), "utf8").split("\n")[0] !== `go${descriptor.version}`) throw new Error("Go archive content rejected");
		// mkdir is the atomic no-clobber claim (rename alone can replace an empty directory).
		mkdirSync(destination, { mode: 0o700 });
		claimed = true;
		renameSync(tree, join(destination, "go"));
		writeFileSync(join(destination, GO_MARKER), `${descriptor.url}\n`, { flag: "wx", mode: 0o600 });
		return { goPath: join(destination, "go", "bin", executable), version: descriptor.version, acquired: true };
	} catch (cause) {
		if (claimed) rmSync(destination, { recursive: true, force: true });
		throw new Error("Go verified acquisition failed; nothing was published", { cause });
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}

/** No shell command or URL from the caller is executed: entry is fixed in bundle. */
export async function launchWizard({ bundle, env }) {
	const entry = join(bundle, "bin/gentle-shell-install.mjs");
	if (!regular(entry)) throw new Error("Future wizard entry is missing; no live wizard is available");
	await new Promise((resolveChild, reject) => {
		const child = spawn(process.execPath, [entry], { env, stdio: "inherit", shell: false });
		child.once("error", () => reject(new Error("Wizard child could not start")));
		child.once("exit", (code) => code === 0 ? resolveChild() : reject(new Error("Wizard child failed")));
	});
}

/** `env` and transport/process adapters are injectable for local fixtures only. */
export async function bootstrap(bundle, suppliedTools, { env = process.env, adapters = {} } = {}) {
	const entry = join(bundle, "bin/gentle-shell-install.mjs");
	if (!regular(entry)) throw new Error("Future wizard entry is missing");
	const metadata = JSON.parse(readFileSync(join(bundle, "package.json"), "utf8"));
	if (!compatibleEngine(metadata.engines?.node, process.versions.node)) throw new Error("Node requirement rejected");
	if (metadata.packageManager !== `pnpm@${pnpm.version}`) throw new Error("pnpm acquisition pin differs from repository; update verified descriptors first");
	let tools = suppliedTools;
	let created = false;
	// Private tools are claimed only when pnpm is acquired (missing or incompatible).
	const claim = () => {
		if (!tools) { tools = privateTools(env.HOME); created = true; }
		return tools;
	};
	try {
		const result = await ensurePnpm({ tools: claim, env, nodeVersion: process.versions.node, adapters });
		await launchWizard({ bundle, env: result.env });
	} catch (error) {
		if (created) rmSync(tools, { recursive: true, force: true });
		throw error;
	}
	// Exit 0 means pnpm now persists under $PNPM_HOME or was already the user's.
	if (created && !removeOwnedTools(tools, env.HOME)) {
		console.error(`Bootstrap: installation finished, but temporary tools could not be removed: ${tools}`);
	}
}
/** The Windows helper failure line appends only a fixed-shape reason code. Any
 * other value, including a failed module import, reports `unexpected-helper`.
 */
export function windowsBootstrapMessage(error) {
	const reason = typeof error?.reason === "string" && /^(?:[a-z][a-z-]* \([a-z][a-z-]*\)|unexpected-[a-z][a-z-]*)$/.test(error.reason) ? error.reason : "unexpected-helper";
	return `Windows bootstrap failed; policy, prerequisite or bundle evidence rejected. No installation completed. Reason: ${reason}`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length === 5 && process.argv[2] === "--bootstrap-windows") {
		import("./installer-windows.mjs").then(({ bootstrapWindows }) => bootstrapWindows({ bundle: process.argv[3], tools: process.argv[4], env: process.env })).catch((error) => {
			console.error(windowsBootstrapMessage(error));
			process.exitCode = 1;
		});
	} else if (process.argv.length !== 5 || process.argv[2] !== "--bootstrap") {
		console.error("Use the bundle's POSIX bootstrap script");
		process.exitCode = 1;
	} else {
		bootstrap(process.argv[3], process.argv[4]).catch((error) => {
			// Only controlled errors are emitted; never print URL/process adapter errors.
			const safe = /^(Future wizard|Node requirement|pnpm |Existing pnpm|Unknown prerequisite|Unsafe tooling|Wizard child|Prerequisite process|Required utility)/.test(error.message);
			console.error(safe ? error.message : "Prerequisite bootstrap failed");
			process.exitCode = 1;
		});
	}
}
