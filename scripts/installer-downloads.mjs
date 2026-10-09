import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, delimiter } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
 * Production always hashes actual bytes; test adapters are trusted local code only.
 * No extraction or execution is allowed before this function succeeds.
 */
export async function verifiedDownload(name, adapters = {}, platform, arch) {
	const descriptor = artifactFor(name, platform, arch);
	let bytes;
	try { bytes = await (adapters.download ?? download)(descriptor); }
	catch { throw new Error("Download failed"); }
	if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > descriptor.maxBytes) throw new Error("Download size rejected");
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
// pnpm 11 installs itself behind a regular cmd-shim file, not a symlink; its
// package lives only in the shim's `# cmd-shim-target=` comment. The target is
// a starting point for the package search, not proof: provePnpm still runs the
// command and requires its --version to match that package.json.
function shimTarget(command) {
	if (!regular(command)) return null;
	const head = readFileSync(command, "utf8").slice(0, 4096);
	const match = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(head);
	return match && stat(match[1]) ? match[1] : null;
}
function packageFor(command) {
	let directory = dirname(realpathSync(shimTarget(command) ?? command));
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
// mise, asdf and pnpm's own installer ship pnpm as a standalone native executable
// that embeds its own Node runtime, so it has no pnpm package.json and the user's
// Node engine does not apply to it. Only a Mach-O or ELF header qualifies; scripts
// and shims without a package still need package engine evidence.
const nativeHeaders = ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "7f454c46"];
function standalonePnpm(command) {
	const target = realpathSync(command);
	if (!regular(target)) return false;
	const header = Buffer.alloc(4);
	const fd = openSync(target, "r");
	try {
		if (readSync(fd, header, 0, 4, 0) !== 4) return false;
	} finally {
		closeSync(fd);
	}
	return nativeHeaders.includes(header.toString("hex"));
}
function provePnpm(command, prefix, metadata, nodeVersion, env, processAdapter) {
	if (metadata && (!parts(metadata.version) || !compatibleEngine(metadata.engines?.node, nodeVersion))) {
		throw new Error("pnpm compatibility is unknown or incompatible; refusing replacement");
	}
	const version = processAdapter(command, [...prefix, "--version"], env);
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

/** Reuse only proven engines/capabilities; missing pnpm gets verified registry bytes.
 * Local test adapters cover transport/hash/process. There is no remote command API.
 * `tools` must be a private directory owned by the invoking bootstrap/controller.
 */
export async function ensurePnpm({ tools, env, nodeVersion, adapters = {} }) {
	const processAdapter = adapters.process ?? processCheck;
	const existing = findExecutable("pnpm", env);
	if (existing) {
		provePnpm(existing, [], standalonePnpm(existing) ? null : packageFor(existing), nodeVersion, env, processAdapter);
		return { env, acquired: false };
	}
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
	try {
		if (!findExecutable("pnpm", env) && !tools) { tools = privateTools(env.HOME); created = true; }
		const result = await ensurePnpm({ tools, env, nodeVersion: process.versions.node, adapters });
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
