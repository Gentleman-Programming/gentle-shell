import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import type { VoiceModelManifest, VoiceNpmPackage, VoiceRuntimeManifest } from "../lib/voice-artifacts.ts";
import {
	installVoiceModel,
	installVoiceRuntime,
	readVoiceComponentStatus,
	resolveVoiceHome,
	VoiceInstallError,
	type VoiceFetch,
	type VoiceInstallProgress,
} from "../lib/voice-install.ts";

// Optional voice acquisition (S1-S3): the runtime and the Parakeet model are
// downloaded only on explicit request, verified by size and digest while they
// stream, staged privately and published with one rename. Every rejection must
// leave no published component and no staging behind, and never touch an
// install that already exists. The network is injected; scratch stays in tmp/.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function scratch(t: test.TestContext): string {
	const base = join(repoRoot, "tmp");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "voice-tests-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "voice");
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sha512 = (data: Buffer) => `sha512-${createHash("sha512").update(data).digest("base64")}`;

interface Route { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; stallAfter?: number }

function fakeFetch(routes: Record<string, Route>): { fetch: VoiceFetch; calls: string[] } {
	const calls: string[] = [];
	const fetch: VoiceFetch = async (url, init) => {
		calls.push(url);
		assert.equal(init.redirect, "manual");
		const route = routes[url];
		if (!route) return new Response("missing", { status: 404 });
		const chunks = route.chunks ?? [];
		let index = 0;
		const body = route.status && route.status >= 300 && route.status < 400 ? null : new ReadableStream<Uint8Array>({
			pull(controller) {
				if (route.stallAfter !== undefined && index >= route.stallAfter) return new Promise<void>(() => {});
				if (index >= chunks.length) { controller.close(); return; }
				controller.enqueue(new Uint8Array(chunks[index++]!));
			},
		});
		return new Response(body, { status: route.status ?? 200, headers: route.headers });
	};
	return { fetch, calls };
}

const halves = (data: Buffer) => [data.subarray(0, data.length >> 1), data.subarray(data.length >> 1)];

const HF = "https://huggingface.co/acme/tiny/resolve/0123456789abcdef0123456789abcdef01234567";
const CDN = "https://us.aws.cdn.hf.co/xet-bridge-us/blob";

function modelFixture(files: Record<string, Buffer>): VoiceModelManifest {
	return {
		id: "tiny-model-0123456",
		revision: "0123456789abcdef0123456789abcdef01234567",
		baseUrl: HF,
		files: Object.entries(files).map(([name, data]) => ({ name, size: data.length, sha256: sha256(data) })),
		redirects: [
			{ origin: "https://huggingface.co", pathPrefix: "/api/resolve-cache/models/acme/tiny/0123456789abcdef0123456789abcdef01234567/" },
			{ origin: "https://us.aws.cdn.hf.co", pathPrefix: "/xet-bridge-us/" },
		],
	};
}

const encoder = Buffer.from("encoder-bytes-".repeat(64));
const tokens = Buffer.from("a 0\nb 1\n");

function modelRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
	return {
		// The observed Hugging Face shapes: a relative 307 into resolve-cache for
		// plain files and an absolute 302 to the regional Xet CDN for LFS files.
		[`${HF}/encoder.onnx`]: { status: 302, headers: { location: `${CDN}/encoder?sig=1` } },
		[`${CDN}/encoder?sig=1`]: { headers: { "content-length": String(encoder.length) }, chunks: halves(encoder) },
		[`${HF}/tokens.txt`]: { status: 307, headers: { location: "/api/resolve-cache/models/acme/tiny/0123456789abcdef0123456789abcdef01234567/tokens.txt?x=1" } },
		["https://huggingface.co/api/resolve-cache/models/acme/tiny/0123456789abcdef0123456789abcdef01234567/tokens.txt?x=1"]: { chunks: [tokens] },
		...overrides,
	};
}

const modelManifest = () => modelFixture({ "encoder.onnx": encoder, "tokens.txt": tokens });

function leftovers(voiceHome: string): string[] {
	if (!existsSync(voiceHome)) return [];
	return readdirSync(voiceHome).filter((name) => name.startsWith(".staging"));
}

async function rejects(promise: Promise<unknown>, code: string): Promise<VoiceInstallError> {
	try { await promise; } catch (error) {
		assert.ok(error instanceof VoiceInstallError, String(error));
		assert.equal(error.code, code, error.message);
		return error;
	}
	assert.fail(`expected ${code}`);
}

test("the voice home lives under the Gentle AI config home and reports components as missing", async (t) => {
	const env = { GENTLE_PI_CONFIG_HOME: join(repoRoot, "tmp", "voice-config") };
	assert.equal(resolveVoiceHome(env), join(gentlePiConfigHome(env), "voice"));
	const voiceHome = scratch(t);
	const status = await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: modelManifest() });
	assert.equal(status.state, "missing");
	assert.equal(existsSync(voiceHome), false, "status never creates the voice home");
});

test("the model streams through permitted redirects, is verified and published atomically", async (t) => {
	const voiceHome = scratch(t);
	const { fetch } = fakeFetch(modelRoutes());
	const progress: VoiceInstallProgress[] = [];
	const result = await installVoiceModel({ voiceHome, manifest: modelManifest(), fetch, onProgress: (p) => progress.push(p) });
	assert.equal(result.alreadyInstalled, false);
	assert.equal(readFileSync(join(result.path, "encoder.onnx")).equals(encoder), true);
	assert.equal(readFileSync(join(result.path, "tokens.txt")).equals(tokens), true);
	assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: modelManifest() })).state, "installed");
	assert.deepEqual(leftovers(voiceHome), []);
	const downloads = progress.filter((p) => p.phase === "download");
	assert.ok(downloads.length >= 3);
	assert.equal(downloads.at(-1)!.overallReceivedBytes, encoder.length + tokens.length);
	assert.equal(downloads.at(-1)!.overallTotalBytes, encoder.length + tokens.length);
	assert.ok(downloads.every((p, i) => i === 0 || p.overallReceivedBytes >= downloads[i - 1]!.overallReceivedBytes));
	if (process.platform !== "win32") assert.equal(statSync(voiceHome).mode & 0o077, 0, "voice home is private");
});

test("an installed component is reported as such without any network access", async (t) => {
	const voiceHome = scratch(t);
	await installVoiceModel({ voiceHome, manifest: modelManifest(), fetch: fakeFetch(modelRoutes()).fetch });
	const second = fakeFetch(modelRoutes());
	const result = await installVoiceModel({ voiceHome, manifest: modelManifest(), fetch: second.fetch });
	assert.equal(result.alreadyInstalled, true);
	assert.deepEqual(second.calls, []);
});

test("a digest mismatch is rejected and leaves nothing published or staged", async (t) => {
	const voiceHome = scratch(t);
	const tampered = Buffer.from(tokens); tampered[0] = 0x7a;
	const { fetch } = fakeFetch(modelRoutes({ ["https://huggingface.co/api/resolve-cache/models/acme/tiny/0123456789abcdef0123456789abcdef01234567/tokens.txt?x=1"]: { chunks: [tampered] } }));
	await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch }), "integrity");
	assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: modelManifest() })).state, "missing");
	assert.deepEqual(leftovers(voiceHome), []);
});

test("a body longer than the pinned size is cut off as a size violation", async (t) => {
	const voiceHome = scratch(t);
	const { fetch } = fakeFetch(modelRoutes({ [`${CDN}/encoder?sig=1`]: { chunks: [encoder, Buffer.from("extra")] } }));
	await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch }), "size");
	const mismatchedLength = fakeFetch(modelRoutes({ [`${CDN}/encoder?sig=1`]: { headers: { "content-length": "1" }, chunks: [encoder] } }));
	await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch: mismatchedLength.fetch }), "size");
	assert.deepEqual(leftovers(voiceHome), []);
});

test("redirects outside the permitted hosts, paths or HTTPS are refused before they are followed", async (t) => {
	const voiceHome = scratch(t);
	for (const location of ["https://evil.example/xet-bridge-us/blob", "http://us.aws.cdn.hf.co/xet-bridge-us/blob", "https://us.aws.cdn.hf.co/other/blob"]) {
		const { fetch, calls } = fakeFetch(modelRoutes({ [`${HF}/encoder.onnx`]: { status: 302, headers: { location } } }));
		await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch }), "redirect");
		assert.equal(calls.includes(location), false, location);
	}
	assert.deepEqual(leftovers(voiceHome), []);
});

test("cancelling mid-download aborts, cleans the staging and publishes nothing", async (t) => {
	const voiceHome = scratch(t);
	const controller = new AbortController();
	const { fetch } = fakeFetch(modelRoutes({ [`${CDN}/encoder?sig=1`]: { chunks: halves(encoder), stallAfter: 1 } }));
	const pending = installVoiceModel({
		voiceHome, manifest: modelManifest(), fetch, signal: controller.signal,
		onProgress: (p) => { if (p.phase === "download") controller.abort(); },
	});
	await rejects(pending, "aborted");
	assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: modelManifest() })).state, "missing");
	assert.deepEqual(leftovers(voiceHome), []);
});

test("a stalled download is aborted by the idle time bound", async (t) => {
	const voiceHome = scratch(t);
	const { fetch } = fakeFetch(modelRoutes({ [`${CDN}/encoder?sig=1`]: { chunks: halves(encoder), stallAfter: 1 } }));
	await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch, timeouts: { idleMs: 30, totalMs: 5_000 } }), "timeout");
	assert.deepEqual(leftovers(voiceHome), []);
});

test("a failed install never disturbs an existing component directory", async (t) => {
	const voiceHome = scratch(t);
	const finalPath = join(voiceHome, "models", modelManifest().id);
	mkdirSync(finalPath, { recursive: true });
	writeFileSync(join(finalPath, "encoder.onnx"), "previous");
	assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: modelManifest() })).state, "invalid");
	const { fetch } = fakeFetch(modelRoutes({ [`${CDN}/encoder?sig=1`]: { chunks: [Buffer.from("wrong")] } }));
	await rejects(installVoiceModel({ voiceHome, manifest: modelManifest(), fetch }), "size");
	assert.equal(readFileSync(join(finalPath, "encoder.onnx"), "utf8"), "previous");
	assert.deepEqual(readdirSync(finalPath), ["encoder.onnx"]);
	// A verified install replaces the invalid one only as a whole.
	const result = await installVoiceModel({ voiceHome, manifest: modelManifest(), fetch: fakeFetch(modelRoutes()).fetch });
	assert.equal(readFileSync(join(result.path, "encoder.onnx")).equals(encoder), true);
	assert.deepEqual(leftovers(voiceHome), []);
});

// --- Runtime packages -------------------------------------------------------

interface TarEntry { name: string; data?: Buffer; type?: string; mode?: number; linkname?: string; prefix?: string; size?: number }

function tarHeader(entry: TarEntry, size: number): Buffer {
	const header = Buffer.alloc(512);
	header.write(entry.name, 0, 100);
	header.write(`${(entry.mode ?? 0o644).toString(8).padStart(6, "0")} \0`, 100);
	header.write("000000 \0", 108);
	header.write("000000 \0", 116);
	header.write(`${size.toString(8).padStart(11, "0")} `, 124);
	header.write("00000000000 ", 136);
	header.fill(" ", 148, 156);
	header.write(entry.type ?? "0", 156);
	header.write(entry.linkname ?? "", 157, 100);
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write(entry.prefix ?? "", 345, 155);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
}

function tgz(entries: TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.data ?? Buffer.alloc(0);
		blocks.push(tarHeader(entry, entry.size ?? data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function npmPackage(name: string, entries: TarEntry[], requiredFiles: string[], limits: { fileCount?: number; unpackedSize?: number } = {}): { pkg: VoiceNpmPackage; tarball: Buffer } {
	const tarball = tgz(entries);
	const unpacked = entries.reduce((total, e) => total + (e.size ?? e.data?.length ?? 0), 0);
	return {
		tarball,
		pkg: {
			name, version: "1.0.0", license: "Apache-2.0", requiredFiles,
			tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
			size: tarball.length, integrity: sha512(tarball),
			fileCount: limits.fileCount ?? entries.length, unpackedSize: limits.unpackedSize ?? unpacked,
		},
	};
}

const loader = Buffer.from("module.exports = require('../fake-native-darwin-arm64/addon.node');\n");
const addon = Buffer.from("\x7fnative");

function runtimeFixture(nativeEntries: TarEntry[] = [{ name: "package/addon.node", data: addon, mode: 0o755 }, { name: "package/package.json", data: Buffer.from("{}") }]) {
	const node = npmPackage("fake-node", [{ name: "package/package.json", data: Buffer.from("{}") }, { name: "package/lib/addon.js", data: loader }], ["package.json", "lib/addon.js"]);
	const native = npmPackage("fake-native-darwin-arm64", nativeEntries, ["addon.node"]);
	const manifest: VoiceRuntimeManifest = { id: "fake-runtime-1.0.0-darwin-arm64", target: "darwin-arm64", packages: [node.pkg, native.pkg], redirects: [] };
	const routes: Record<string, Route> = {
		[node.pkg.tarball]: { chunks: [node.tarball] },
		[native.pkg.tarball]: { chunks: halves(native.tarball) },
	};
	return { manifest, routes };
}

test("runtime packages are verified and extracted as sibling node_modules directories", async (t) => {
	const voiceHome = scratch(t);
	const { manifest, routes } = runtimeFixture();
	const result = await installVoiceRuntime({ voiceHome, target: "darwin-arm64", manifest, fetch: fakeFetch(routes).fetch });
	assert.equal(readFileSync(join(result.path, "node_modules", "fake-node", "lib", "addon.js")).equals(loader), true);
	const native = join(result.path, "node_modules", "fake-native-darwin-arm64", "addon.node");
	assert.equal(readFileSync(native).equals(addon), true);
	if (process.platform !== "win32") assert.equal(statSync(native).mode & 0o111, 0o111, "executable bit is kept");
	assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "runtime", manifest })).state, "installed");
	assert.deepEqual(readdirSync(join(result.path, "node_modules")).sort(), ["fake-native-darwin-arm64", "fake-node"]);
	assert.deepEqual(leftovers(voiceHome), []);
});

test("unsafe archive entries are rejected before anything is extracted", async (t) => {
	const voiceHome = scratch(t);
	const good = { name: "package/addon.node", data: addon };
	const cases: Array<[string, RegExp, TarEntry[], { fileCount?: number; unpackedSize?: number }?]> = [
		["symlink", /entry type '2'/, [good, { name: "package/link", type: "2", linkname: "/etc/passwd" }]],
		["hardlink", /entry type '1'/, [good, { name: "package/hard", type: "1", linkname: "package/addon.node" }]],
		["directory", /entry type '5'/, [good, { name: "package/dir/", type: "5" }]],
		["traversal", /not a safe relative path/, [good, { name: "package/../../escape.txt", data: Buffer.from("x") }]],
		["Windows device name", /not a safe relative path/, [good, { name: "package/lib/aux.js", data: Buffer.from("x") }]],
		["absolute", /outside package\//, [good, { name: "/abs/escape.txt", data: Buffer.from("x") }]],
		["outside package/", /outside package\//, [good, { name: "other/file.txt", data: Buffer.from("x") }]],
		["duplicate", /duplicated/, [good, { name: "package/ADDON.node", data: addon }]],
		["file used as directory", /uses a file as a directory/, [good, { name: "package/addon.node/inner", data: Buffer.from("x") }]],
		["too many entries", /more than 1 entries/, [good, { name: "package/b.txt", data: Buffer.from("x") }], { fileCount: 1 }],
		["too many bytes", /unpacked bytes/, [good, { name: "package/b.txt", data: Buffer.alloc(600) }], { unpackedSize: addon.length + 10 }],
		["missing required file", /addon\.node is missing/, [{ name: "package/other.node", data: addon }]],
	];
	for (const [label, reason, entries, limits] of cases) {
		const fixture = runtimeFixture();
		const native = npmPackage("fake-native-darwin-arm64", entries, ["addon.node"], limits);
		fixture.manifest.packages[1] = native.pkg;
		fixture.routes[native.pkg.tarball] = { chunks: [native.tarball] };
		const error = await rejects(installVoiceRuntime({ voiceHome, target: "darwin-arm64", manifest: fixture.manifest, fetch: fakeFetch(fixture.routes).fetch }), "archive");
		assert.match(error.message, reason, label);
		assert.equal((await readVoiceComponentStatus({ voiceHome, kind: "runtime", manifest: fixture.manifest })).state, "missing", label);
		assert.deepEqual(leftovers(voiceHome), [], label);
	}
	assert.equal(existsSync(join(dirname(voiceHome), "escape.txt")), false);
	assert.equal(existsSync(join(voiceHome, "escape.txt")), false);
});

test("a runtime is refused for a target outside the five known ones", async (t) => {
	const voiceHome = scratch(t);
	const { fetch, calls } = fakeFetch({});
	await rejects(installVoiceRuntime({ voiceHome, target: "win32-arm64" as never, fetch }), "unsupported");
	assert.deepEqual(calls, []);
	assert.equal(existsSync(voiceHome), false);
});
