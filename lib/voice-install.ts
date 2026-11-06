import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { gentlePiConfigHome } from "./agent-home.ts";
import {
	PARAKEET_MODEL_MANIFEST,
	VOICE_TARGETS,
	voiceRuntimeManifest,
	type VoiceModelManifest,
	type VoiceNpmPackage,
	type VoiceRedirectRule,
	type VoiceRuntimeManifest,
	type VoiceTarget,
} from "./voice-artifacts.ts";

// Explicit acquisition and status of the optional voice runtime and model (S1-S3).
// Nothing runs at import: /gentle:voice calls these on request. A component is
// downloaded into a private staging directory under the voice home, verified by
// size and digest while it streams, and published with a single rename, with its
// install marker written last. A failure removes only that staging directory, so
// it never leaves a marker behind or alters a published component. Downloaded
// code is written to disk only; it is never loaded or executed here.

export type VoiceComponentKind = "runtime" | "model";

export type VoiceInstallErrorCode = "aborted" | "timeout" | "http" | "redirect" | "size" | "integrity" | "archive" | "unsupported" | "io";

export class VoiceInstallError extends Error {
	readonly code: VoiceInstallErrorCode;

	constructor(code: VoiceInstallErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VoiceInstallError";
		this.code = code;
	}
}

// The subset of fetch the installer uses. Redirects are always handled here, so
// every hop is checked against the manifest's rules before it is requested.
export type VoiceFetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

export interface VoiceInstallProgress {
	component: VoiceComponentKind;
	phase: "download" | "extract" | "publish";
	// The model file or package name the event is about.
	item?: string;
	receivedBytes: number;
	totalBytes: number;
	overallReceivedBytes: number;
	overallTotalBytes: number;
}

export interface VoiceTimeouts {
	// The longest wait for response headers or the next body chunk.
	idleMs: number;
	// The whole install, from the first request to publication.
	totalMs: number;
}

interface VoiceInstallCommonOptions {
	// Defaults to resolveVoiceHome(env).
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	fetch?: VoiceFetch;
	signal?: AbortSignal;
	timeouts?: Partial<VoiceTimeouts>;
	onProgress?: (progress: VoiceInstallProgress) => void;
}

export interface VoiceModelInstallOptions extends VoiceInstallCommonOptions {
	manifest?: VoiceModelManifest;
}

export interface VoiceRuntimeInstallOptions extends VoiceInstallCommonOptions {
	target: VoiceTarget;
	manifest?: VoiceRuntimeManifest;
}

export interface VoiceInstallResult {
	kind: VoiceComponentKind;
	path: string;
	alreadyInstalled: boolean;
}

export interface VoiceComponentStatus {
	kind: VoiceComponentKind;
	state: "installed" | "missing" | "invalid";
	path: string;
	reason?: string;
}

const MARKER = ".gentle-voice.json";
const MARKER_SCHEMA = 1;
const MAX_REDIRECTS = 5;
const IDLE_MS = 60_000;
const TOTAL_MS: Record<VoiceComponentKind, number> = { runtime: 20 * 60_000, model: 2 * 60 * 60_000 };
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Everything voice owns lives in one directory of the Gentle AI config home.
export function resolveVoiceHome(env: NodeJS.ProcessEnv = process.env): string {
	return join(gentlePiConfigHome(env), "voice");
}

export function voiceComponentPath(voiceHome: string, kind: VoiceComponentKind, manifest: { id: string }): string {
	return join(voiceHome, kind === "model" ? "models" : "runtime", manifest.id);
}

interface Marker {
	schema: number;
	kind: VoiceComponentKind;
	id: string;
	manifest: string;
	files: Array<{ path: string; size: number }>;
}

const fingerprint = (manifest: VoiceModelManifest | VoiceRuntimeManifest) => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

// Relative POSIX paths that resolve to the same file on every supported system:
// no traversal, separators, drive or stream colons, control characters, Windows
// device names, or trailing dots and spaces that Windows silently strips.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function safeRelativeSegments(path: string): string[] | undefined {
	const segments = path.split("/");
	const safe = segments.every((s) => s !== "" && s !== "." && s !== ".." && !/[\\:\0-\x1f]/.test(s) && !/[. ]$/.test(s) && !WINDOWS_DEVICE.test(s));
	return safe ? segments : undefined;
}

// Reads only: a missing voice home is reported, never created.
export async function readVoiceComponentStatus(options: { voiceHome: string; kind: VoiceComponentKind; manifest: VoiceModelManifest | VoiceRuntimeManifest }): Promise<VoiceComponentStatus> {
	const { voiceHome, kind, manifest } = options;
	const path = voiceComponentPath(voiceHome, kind, manifest);
	const invalid = (reason: string): VoiceComponentStatus => ({ kind, state: "invalid", path, reason });
	try {
		if (!(await lstat(path)).isDirectory()) return invalid("the install path is not a directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind, state: "missing", path };
		throw error;
	}
	let marker: Marker;
	try {
		marker = JSON.parse(await readFile(join(path, MARKER), "utf8")) as Marker;
	} catch {
		return invalid("the install marker is missing or unreadable");
	}
	if (marker?.schema !== MARKER_SCHEMA || marker.kind !== kind || marker.id !== manifest.id || marker.manifest !== fingerprint(manifest) || !Array.isArray(marker.files)) {
		return invalid("the install marker does not match the pinned manifest");
	}
	for (const file of marker.files) {
		const segments = typeof file?.path === "string" ? safeRelativeSegments(file.path) : undefined;
		if (!segments) return invalid("the install marker lists an unsafe path");
		const info = await lstat(join(path, ...segments)).catch(() => undefined);
		if (!info?.isFile() || info.size !== file.size) return invalid(`${file.path} is missing or changed`);
	}
	return { kind, state: "installed", path };
}

export async function readVoiceStatus(options: { voiceHome?: string; env?: NodeJS.ProcessEnv; target?: VoiceTarget } = {}): Promise<{ voiceHome: string; model: VoiceComponentStatus; runtime?: VoiceComponentStatus }> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const model = await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: PARAKEET_MODEL_MANIFEST });
	if (!options.target || !VOICE_TARGETS.includes(options.target)) return { voiceHome, model };
	const runtime = await readVoiceComponentStatus({ voiceHome, kind: "runtime", manifest: voiceRuntimeManifest(options.target) });
	return { voiceHome, model, runtime };
}

// --- Transfer ---------------------------------------------------------------

interface Transfer {
	component: VoiceComponentKind;
	fetch: VoiceFetch;
	controller: AbortController;
	idleMs: number;
	redirects: VoiceRedirectRule[];
	overallReceivedBytes: number;
	overallTotalBytes: number;
	onProgress?: (progress: VoiceInstallProgress) => void;
}

// Settles with the promise, or rejects with the abort reason (cancel, total or
// idle timeout) as soon as the install is aborted, whether or not the injected
// fetch or body stream honours the signal itself.
function untilAborted<T>(promise: Promise<T>, transfer: Transfer): Promise<T> {
	const { signal } = transfer.controller;
	const timer = setTimeout(() => transfer.controller.abort(new VoiceInstallError("timeout", `No data arrived for ${transfer.idleMs} ms.`)), transfer.idleMs);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		const settle = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
		if (signal.aborted) { settle(); reject(signal.reason); return; }
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => { settle(); resolve(value); }, (error) => { settle(); reject(error); });
	});
}

function permitted(url: URL, rules: VoiceRedirectRule[]): boolean {
	if (url.protocol !== "https:" || url.username || url.password) return false;
	return rules.some((rule) => url.origin === rule.origin && url.pathname.startsWith(rule.pathPrefix));
}

async function request(url: string, transfer: Transfer): Promise<Response> {
	let current = new URL(url);
	if (current.protocol !== "https:") throw new VoiceInstallError("redirect", `Refused a non-HTTPS source ${current.origin}.`);
	for (let hop = 0; ; hop++) {
		const response = await untilAborted(transfer.fetch(current.href, { signal: transfer.controller.signal, redirect: "manual", headers: { "accept-encoding": "identity" } }), transfer);
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			const location = response.headers.get("location");
			if (!location || hop >= MAX_REDIRECTS) throw new VoiceInstallError("redirect", `Too many or empty redirects from ${current.origin}${current.pathname}.`);
			const next = new URL(location, current);
			// The query is left out of messages: CDN redirects carry signed tokens.
			if (!permitted(next, transfer.redirects)) throw new VoiceInstallError("redirect", `Refused a redirect to ${next.protocol}//${next.host}${next.pathname}.`);
			current = next;
			continue;
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			throw new VoiceInstallError("http", `${current.origin}${current.pathname} answered HTTP ${response.status}.`);
		}
		return response;
	}
}

interface Expected { item: string; size: number; algorithm: "sha256" | "sha512"; digest: string }

const encodeDigest = (algorithm: Expected["algorithm"], raw: Buffer) => (algorithm === "sha512" ? `sha512-${raw.toString("base64")}` : raw.toString("hex"));

// Streams one artifact to a new file, hashing as it goes. The body is never held
// whole in memory, and reading stops as soon as it exceeds the pinned size.
async function download(url: string, expected: Expected, destination: string, transfer: Transfer): Promise<void> {
	const response = await request(url, transfer);
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) !== expected.size) {
		void response.body?.cancel().catch(() => {});
		throw new VoiceInstallError("size", `${expected.item} is announced as ${declared} bytes, expected ${expected.size}.`);
	}
	if (!response.body) throw new VoiceInstallError("http", `${expected.item} has no response body.`);
	const reader = response.body.getReader();
	const hash = createHash(expected.algorithm);
	const file = await open(destination, "wx", 0o600);
	let received = 0;
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await untilAborted(reader.read(), transfer);
			if (done) { finished = true; break; }
			received += value.byteLength;
			if (received > expected.size) throw new VoiceInstallError("size", `${expected.item} is larger than the pinned ${expected.size} bytes.`);
			hash.update(value);
			await file.write(value);
			transfer.overallReceivedBytes += value.byteLength;
			transfer.onProgress?.({ component: transfer.component, phase: "download", item: expected.item, receivedBytes: received, totalBytes: expected.size, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes: transfer.overallTotalBytes });
		}
	} finally {
		if (!finished) void reader.cancel().catch(() => {});
		await file.close();
	}
	if (received !== expected.size) throw new VoiceInstallError("size", `${expected.item} ended after ${received} of ${expected.size} bytes.`);
	if (encodeDigest(expected.algorithm, hash.digest()) !== expected.digest) throw new VoiceInstallError("integrity", `${expected.item} does not match its pinned ${expected.algorithm} digest.`);
}

// --- Staging and publication ------------------------------------------------

type Build = (payload: string, staging: string, transfer: Transfer) => Promise<Marker["files"]>;

async function install(kind: VoiceComponentKind, manifest: VoiceModelManifest | VoiceRuntimeManifest, overallTotalBytes: number, redirects: VoiceRedirectRule[], options: VoiceInstallCommonOptions, build: Build): Promise<VoiceInstallResult> {
	if (options.signal?.aborted) throw new VoiceInstallError("aborted", "Voice install was cancelled.");
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const finalPath = voiceComponentPath(voiceHome, kind, manifest);
	if ((await readVoiceComponentStatus({ voiceHome, kind, manifest })).state === "installed") return { kind, path: finalPath, alreadyInstalled: true };

	const controller = new AbortController();
	const onAbort = () => controller.abort(new VoiceInstallError("aborted", "Voice install was cancelled."));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const totalMs = options.timeouts?.totalMs ?? TOTAL_MS[kind];
	const deadline = setTimeout(() => controller.abort(new VoiceInstallError("timeout", `Voice install exceeded ${totalMs} ms.`)), totalMs);
	const transfer: Transfer = {
		component: kind,
		fetch: options.fetch ?? ((url, init) => fetch(url, init)),
		controller,
		idleMs: options.timeouts?.idleMs ?? IDLE_MS,
		redirects,
		overallReceivedBytes: 0,
		overallTotalBytes,
		onProgress: options.onProgress,
	};
	let staging: string | undefined;
	try {
		await mkdir(voiceHome, { recursive: true, mode: 0o700 });
		// mkdtemp creates the directory with mode 0700 and a fresh random name.
		staging = await mkdtemp(join(voiceHome, ".staging-"));
		const payload = join(staging, "payload");
		await mkdir(payload, { mode: 0o700 });
		const files = await build(payload, staging, transfer);
		if (controller.signal.aborted) throw controller.signal.reason;
		const marker: Marker = { schema: MARKER_SCHEMA, kind, id: manifest.id, manifest: fingerprint(manifest), files };
		await writeFile(join(payload, MARKER), `${JSON.stringify(marker, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		transfer.onProgress?.({ component: kind, phase: "publish", receivedBytes: 0, totalBytes: 0, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes });
		return await publish(kind, manifest, voiceHome, staging, payload, finalPath);
	} catch (error) {
		if (error instanceof VoiceInstallError) throw error;
		if (controller.signal.aborted) throw controller.signal.reason;
		throw new VoiceInstallError("io", `Voice install failed: ${(error as Error).message}`, { cause: error });
	} finally {
		clearTimeout(deadline);
		options.signal?.removeEventListener("abort", onAbort);
		// Only the staging directory this call created is ever removed.
		if (staging) await rm(staging, { recursive: true, force: true });
	}
}

// One rename publishes the complete payload. An invalid previous directory is
// first moved into this install's staging, so it is restored if the rename fails
// and discarded with the staging once the new component is in place.
async function publish(kind: VoiceComponentKind, manifest: VoiceModelManifest | VoiceRuntimeManifest, voiceHome: string, staging: string, payload: string, finalPath: string): Promise<VoiceInstallResult> {
	await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
	const existing = await readVoiceComponentStatus({ voiceHome, kind, manifest });
	if (existing.state === "installed") return { kind, path: finalPath, alreadyInstalled: true };
	const previous = join(staging, "previous");
	if (existing.state === "invalid") await rename(finalPath, previous);
	try {
		await rename(payload, finalPath);
	} catch (error) {
		if (existing.state === "invalid") await rename(previous, finalPath).catch(() => {});
		// A concurrent install may have published the same component first.
		if ((await readVoiceComponentStatus({ voiceHome, kind, manifest })).state === "installed") return { kind, path: finalPath, alreadyInstalled: true };
		throw error;
	}
	return { kind, path: finalPath, alreadyInstalled: false };
}

// --- Model ------------------------------------------------------------------

export async function installVoiceModel(options: VoiceModelInstallOptions = {}): Promise<VoiceInstallResult> {
	const manifest = options.manifest ?? PARAKEET_MODEL_MANIFEST;
	if (!SAFE_ID.test(manifest.id) || !manifest.files.every((file) => SAFE_FILE.test(file.name))) {
		throw new VoiceInstallError("unsupported", "The model manifest names an unsafe path.");
	}
	const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
	return install("model", manifest, total, manifest.redirects, options, async (payload, _staging, transfer) => {
		for (const file of manifest.files) {
			await download(`${manifest.baseUrl}/${file.name}`, { item: file.name, size: file.size, algorithm: "sha256", digest: file.sha256 }, join(payload, file.name), transfer);
		}
		return manifest.files.map((file) => ({ path: file.name, size: file.size }));
	});
}

// --- Runtime ----------------------------------------------------------------

interface ArchiveEntry { path: string; segments: string[]; executable: boolean; data: Buffer }

const cString = (block: Buffer, start: number, end: number) => {
	const field = block.subarray(start, end);
	const nul = field.indexOf(0);
	return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
};

function octal(block: Buffer, start: number, end: number): number {
	const text = cString(block, start, end).trim();
	return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
}

// Validates a whole npm tarball before anything is written: only regular files
// under package/, no links, devices, directories or extended headers, no
// traversal, case-insensitive duplicates or file/directory clashes, and no more
// entries or bytes than the registry metadata records.
function readArchive(compressed: Buffer, pkg: VoiceNpmPackage): ArchiveEntry[] {
	const reject = (reason: string): never => { throw new VoiceInstallError("archive", `${pkg.name}: ${reason}.`); };
	let tar: Buffer;
	try {
		tar = gunzipSync(compressed, { maxOutputLength: pkg.unpackedSize + (pkg.fileCount + 2) * 1024 + 10240 });
	} catch {
		return reject("the archive does not decompress within its pinned size");
	}
	const entries: ArchiveEntry[] = [];
	const files = new Set<string>();
	const directories = new Set<string>();
	let unpacked = 0;
	let offset = 0;
	let ended = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			if (!tar.subarray(offset).every((byte) => byte === 0)) reject("data follows the end of the archive");
			ended = true;
			break;
		}
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
		if (octal(header, 148, 156) !== sum || cString(header, 257, 263) !== "ustar") reject("an entry header is corrupt");
		const type = header[156];
		if (type !== 0x30 && type !== 0) reject(`entry type '${String.fromCharCode(type!)}' is not a regular file`);
		const name = cString(header, 0, 100);
		const prefix = cString(header, 345, 500);
		const full = prefix ? `${prefix}/${name}` : name;
		if (!full.startsWith("package/")) reject(`${full} is outside package/`);
		const relative = full.slice("package/".length);
		const segments = safeRelativeSegments(relative) ?? reject(`${full} is not a safe relative path`);
		const key = relative.toLowerCase();
		if (files.has(key) || directories.has(key)) reject(`${full} is duplicated`);
		for (let i = 1; i < segments.length; i++) {
			const ancestor = segments.slice(0, i).join("/").toLowerCase();
			if (files.has(ancestor)) reject(`${full} uses a file as a directory`);
			directories.add(ancestor);
		}
		files.add(key);
		const size = octal(header, 124, 136);
		if (!Number.isSafeInteger(size)) reject(`${full} has an invalid size`);
		unpacked += size;
		if (entries.length + 1 > pkg.fileCount) reject(`more than ${pkg.fileCount} entries`);
		if (unpacked > pkg.unpackedSize) reject(`more than ${pkg.unpackedSize} unpacked bytes`);
		const start = offset + 512;
		if (start + size > tar.length) reject(`${full} is truncated`);
		entries.push({ path: relative, segments, executable: (octal(header, 100, 108) & 0o111) !== 0, data: tar.subarray(start, start + size) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	if (!ended) reject("the archive has no end marker");
	const present = new Set(entries.map((entry) => entry.path));
	for (const required of pkg.requiredFiles) if (!present.has(required)) reject(`${required} is missing`);
	return entries;
}

// Installs sherpa-onnx-node, its platform package and node-cpal as sibling directories of one node_modules, the layout the sherpa-onnx
// loader resolves. No package script runs and nothing is loaded.
export async function installVoiceRuntime(options: VoiceRuntimeInstallOptions): Promise<VoiceInstallResult> {
	if (!VOICE_TARGETS.includes(options.target)) throw new VoiceInstallError("unsupported", `Voice dictation has no pinned runtime for ${String(options.target)}.`);
	const manifest = options.manifest ?? voiceRuntimeManifest(options.target);
	if (manifest.target !== options.target || !SAFE_ID.test(manifest.id) || !manifest.packages.every((pkg) => SAFE_ID.test(pkg.name))) {
		throw new VoiceInstallError("unsupported", "The runtime manifest does not describe this target safely.");
	}
	const total = manifest.packages.reduce((sum, pkg) => sum + pkg.size, 0);
	return install("runtime", manifest, total, manifest.redirects, options, async (payload, staging, transfer) => {
		const downloads = join(staging, "downloads");
		await mkdir(downloads, { mode: 0o700 });
		for (const pkg of manifest.packages) {
			await download(pkg.tarball, { item: pkg.name, size: pkg.size, algorithm: "sha512", digest: pkg.integrity }, join(downloads, `${pkg.name}.tgz`), transfer);
		}
		// Every archive is validated before the first file is extracted.
		const archives: Array<[VoiceNpmPackage, ArchiveEntry[]]> = [];
		for (const pkg of manifest.packages) archives.push([pkg, readArchive(await readFile(join(downloads, `${pkg.name}.tgz`)), pkg)]);
		const files: Marker["files"] = [];
		for (const [pkg, entries] of archives) {
			transfer.onProgress?.({ component: "runtime", phase: "extract", item: pkg.name, receivedBytes: 0, totalBytes: pkg.unpackedSize, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes: total });
			const root = join(payload, "node_modules", pkg.name);
			for (const entry of entries) {
				const destination = join(root, ...entry.segments);
				if (!destination.startsWith(root + sep)) throw new VoiceInstallError("archive", `${pkg.name}: ${entry.path} escapes the package.`);
				await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
				await writeFile(destination, entry.data, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
				files.push({ path: posix.join("node_modules", pkg.name, entry.path), size: entry.data.length });
			}
		}
		return files;
	});
}
