import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { VOICE_TARGETS, type VoiceModelManifest, type VoiceNpmPackage, type VoiceRuntimeManifest, type VoiceTarget } from "../lib/voice-artifacts.ts";
import { installVoiceModel, installVoiceRuntime, voiceComponentPath, type VoiceFetch } from "../lib/voice-install.ts";
import { createVoiceSession, VOICE_WORKER_SCHEMA, VoiceSessionError, type VoiceSessionOptions, type VoiceSessionState, type VoiceWorkerSpawnOptions } from "../lib/voice-session.ts";

// The voice session (S1-S3) owns one worker process per dictation. Most tests
// replace the process with a scripted fake; the last ones run the real
// scripts/voice-worker.cjs against fake capture and recognizer modules that the
// real installer placed in an owned scratch voice home. No native module,
// microphone or network is used.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostTarget = VOICE_TARGETS.find((target) => target === `${process.platform}-${process.arch}`);

const FAKE_ASR = `exports.OfflineRecognizer = class {
	createStream() { const stream = { samples: 0, acceptWaveform: (wave) => { stream.samples += wave.samples.length; } }; return stream; }
	decode() {}
	getResult(stream) { return { text: stream.samples > 0 ? " fake transcript " : "" }; }
};
`;
const FAKE_CPAL = `exports.convenience = {
	getDefaultInputDevice: () => ({ deviceId: "fake" }),
	getDefaultInputConfig: () => ({ sampleRate: 16000, channels: 1, sampleFormat: "f32" }),
	getSupportedFormats: () => ["f32"],
	createInputStream: async (options) => {
		const timer = setInterval(() => options.onData(new Float32Array(1600).fill(0.1)), 5);
		return { close: async () => clearInterval(timer) };
	},
};
`;

function tarball(files: Record<string, string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content);
		const header = Buffer.alloc(512);
		header.write(`package/${name}`, 0);
		header.write("0000644\0", 100);
		header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
		header.fill(0x20, 148, 156);
		header.write("0", 156);
		header.write("ustar\0", 257);
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

interface Fixture {
	voiceHome: string;
	target: VoiceTarget;
	manifests: { model: VoiceModelManifest; runtime: VoiceRuntimeManifest };
}

// Installs a fake runtime and model through the real installer, so status,
// markers and layout are exactly what /gentle:voice will find.
async function installFixture(t: test.TestContext, target: VoiceTarget): Promise<Fixture> {
	const base = join(repoRoot, "tmp");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "voice-session-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const voiceHome = join(dir, "voice");
	const bodies = new Map<string, Buffer>();
	const pkg = (name: string, files: Record<string, string>): VoiceNpmPackage => {
		const data = tarball(files);
		const tarballUrl = `https://registry.npmjs.org/${name}/-/${name}-0.0.0.tgz`;
		bodies.set(tarballUrl, data);
		return {
			name,
			version: "0.0.0",
			license: "MIT",
			tarball: tarballUrl,
			size: data.length,
			integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
			unpackedSize: Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0),
			fileCount: Object.keys(files).length,
			requiredFiles: Object.keys(files),
		};
	};
	const runtime: VoiceRuntimeManifest = {
		id: `test-runtime-${target}`,
		target,
		packages: [pkg("sherpa-onnx-node", { "package.json": "{}", "non-streaming-asr.js": FAKE_ASR }), pkg("node-cpal", { "package.json": "{}", "index.js": FAKE_CPAL })],
		redirects: [],
	};
	const model: VoiceModelManifest = { id: "test-model", revision: "test", baseUrl: "https://huggingface.co/test", files: [], redirects: [] };
	for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
		const data = Buffer.from(`fake ${name}`);
		bodies.set(`${model.baseUrl}/${name}`, data);
		model.files.push({ name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
	}
	const fetch: VoiceFetch = async (url) => {
		const body = bodies.get(url);
		return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } }) : new Response(null, { status: 404 });
	};
	await installVoiceRuntime({ voiceHome, target, manifest: runtime, fetch });
	await installVoiceModel({ voiceHome, manifest: model, fetch });
	return { voiceHome, target, manifests: { model, runtime } };
}

// A scripted worker: records what it is sent and exits when its stdin ends,
// unless told to hang so only a kill can end it.
class FakeWorker extends EventEmitter {
	stdin = new PassThrough();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	received: Array<Record<string, unknown>> = [];
	signals: string[] = [];
	hang = false;
	exited = false;

	constructor() {
		super();
		this.stdin.setEncoding("utf8");
		let buffered = "";
		this.stdin.on("data", (chunk: string) => {
			buffered += chunk;
			for (let newline; (newline = buffered.indexOf("\n")) !== -1; buffered = buffered.slice(newline + 1)) this.received.push(JSON.parse(buffered.slice(0, newline)));
		});
		this.stdin.on("end", () => {
			if (!this.hang) this.exit();
		});
	}

	kill(signal: string): boolean {
		this.signals.push(signal);
		setImmediate(() => this.exit());
		return true;
	}

	exit(): void {
		if (this.exited) return;
		this.exited = true;
		setImmediate(() => this.emit("close", 0, null));
	}

	say(message: Record<string, unknown>): void {
		this.line(JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message }));
	}

	line(text: string): void {
		this.stdout.emit("data", `${text}\n`);
	}
}

function scripted(fixture: Fixture, options: Partial<VoiceSessionOptions> = {}) {
	const workers: FakeWorker[] = [];
	const launches: Array<{ executable: string; args: string[]; options: VoiceWorkerSpawnOptions }> = [];
	const states: VoiceSessionState[] = [];
	const session = createVoiceSession({
		target: fixture.target,
		voiceHome: fixture.voiceHome,
		manifests: fixture.manifests,
		workerPath: "/fixed/voice-worker.cjs",
		exitGraceMs: 20,
		env: { HOME: "/home/someone", SECRET_TOKEN: "abc", NODE_OPTIONS: "--require /evil.js", PATH: "/usr/bin" },
		onStateChange: (state) => states.push(state),
		spawn: (executable, args, spawnOptions) => {
			launches.push({ executable, args, options: spawnOptions });
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
		...options,
	});
	const worker = () => workers[0]!;
	const until = async (predicate: () => boolean) => {
		for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.ok(predicate(), "timed out waiting for the session");
	};
	return { session, workers, launches, states, worker, until };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
	await assert.rejects(promise, (error: unknown) => error instanceof VoiceSessionError && error.code === code);
}

test("does nothing until start, and a missing install never launches a worker", async (t) => {
	const base = join(repoRoot, "tmp");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "voice-session-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const voiceHome = join(dir, "voice");
	const fixture: Fixture = { voiceHome, target: "linux-x64", manifests: undefined as never };
	const run = scripted(fixture, { manifests: undefined });
	assert.equal(run.session.state, "idle");
	assert.equal(existsSync(voiceHome), false);
	await rejectsWith(run.session.start(), "not-installed");
	assert.equal(run.session.state, "finished");
	assert.equal(run.launches.length, 0);
	assert.equal(existsSync(voiceHome), false);
	await rejectsWith(run.session.start(), "invalid-state");

	for (const [options, code] of [[{ nodeVersion: "20.18.0" }, "node-version"], [{ target: "win32-arm64" as VoiceTarget }, "unsupported"]] as const) {
		const other = scripted(fixture, { manifests: undefined, ...options });
		await rejectsWith(other.session.start(), code);
		assert.equal(other.launches.length, 0);
	}
});

test("records, stops and returns the transcript from a fixed, scrubbed worker launch", async (t) => {
	const fixture = await installFixture(t, "linux-x64");
	const run = scripted(fixture);
	const started = run.session.start();
	await run.until(() => run.workers.length === 1 && run.worker().received.length === 1);

	const [launch] = run.launches;
	assert.equal(launch!.executable, process.execPath);
	assert.deepEqual(launch!.args, ["/fixed/voice-worker.cjs"]);
	const runtimeRoot = voiceComponentPath(fixture.voiceHome, "runtime", fixture.manifests.runtime);
	assert.equal(launch!.options.cwd, runtimeRoot);
	assert.equal(launch!.options.shell, false);
	assert.equal(launch!.options.detached, false);
	assert.deepEqual(Object.keys(launch!.options.env).sort(), ["GENTLE_PI_AGENTS_CHILD", "HOME", "NODE_NO_WARNINGS"]);

	const request = run.worker().received[0] as any;
	assert.equal(request.type, "start");
	assert.equal(request.runtime.root, runtimeRoot);
	assert.deepEqual(request.runtime.files, ["node_modules/sherpa-onnx-node/package.json", "node_modules/sherpa-onnx-node/non-streaming-asr.js", "node_modules/node-cpal/package.json", "node_modules/node-cpal/index.js"]);
	assert.equal(request.model.root, voiceComponentPath(fixture.voiceHome, "model", fixture.manifests.model));
	assert.deepEqual(request.model.files.encoder, fixture.manifests.model.files[0]);
	assert.equal(request.maxRecordingMs, 120_000);

	run.worker().say({ type: "recording" });
	await started;
	assert.equal(run.session.state, "recording");
	const stopped = run.session.stop();
	assert.deepEqual(run.worker().received.at(-1), { schema: VOICE_WORKER_SCHEMA, type: "stop" });
	run.worker().say({ type: "transcribing" });
	run.worker().say({ type: "result", text: "  dictated text ", truncated: false });
	assert.deepEqual(await stopped, { text: "dictated text", truncated: false });
	assert.deepEqual(run.worker().signals, []);
	assert.deepEqual(run.states, ["starting", "recording", "transcribing", "finished"]);
});

test("cancel discards the transcript, ignores late results and leaves no worker", async (t) => {
	const fixture = await installFixture(t, "linux-x64");

	await t.test("while recording, from a worker that must be killed", async () => {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		run.worker().hang = true;
		await run.session.cancel();
		assert.deepEqual(run.worker().received.at(-1), { schema: VOICE_WORKER_SCHEMA, type: "cancel" });
		assert.deepEqual(run.worker().signals, ["SIGKILL"]);
		assert.equal(run.worker().exited, true);
		run.worker().say({ type: "result", text: "late", truncated: false });
		await rejectsWith(run.session.stop(), "cancelled");
		assert.equal(run.session.state, "finished");
	});

	await t.test("after the result arrived but before the worker exited", async () => {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		run.worker().hang = true;
		const stopped = run.session.stop();
		run.worker().say({ type: "transcribing" });
		run.worker().say({ type: "result", text: "do not keep", truncated: false });
		await run.session.cancel();
		await rejectsWith(stopped, "cancelled");
	});

	await t.test("while starting", async () => {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		await run.session.cancel();
		await rejectsWith(started, "cancelled");
		run.worker().say({ type: "recording" });
		assert.equal(run.session.state, "finished");
		await run.session.dispose();
	});
});

test("an invalid worker response stops the worker", async (t) => {
	const fixture = await installFixture(t, "linux-x64");
	const cases: Array<[string, (worker: FakeWorker) => void]> = [
		["not json", (worker) => worker.line("{oops")],
		["unknown type", (worker) => worker.say({ type: "progress" })],
		["extra field", (worker) => worker.say({ type: "recording", path: "/home/someone" })],
		["wrong schema", (worker) => worker.line(JSON.stringify({ schema: "other", type: "recording" }))],
		["unknown error code", (worker) => worker.say({ type: "error", code: "EACCES /home/someone" })],
		["result before recording", (worker) => worker.say({ type: "result", text: "x", truncated: false })],
		["unterminated oversized line", (worker) => worker.stdout.emit("data", "x".repeat(70 * 1024))],
	];
	for (const [name, misbehave] of cases) {
		await t.test(name, async () => {
			const run = scripted(fixture);
			const started = run.session.start();
			await run.until(() => run.workers.length === 1);
			misbehave(run.worker());
			await rejectsWith(started, "protocol");
			assert.deepEqual(run.worker().signals, ["SIGKILL"]);
		});
	}
});

test("worker failures surface as fixed messages; stderr is never forwarded", async (t) => {
	const fixture = await installFixture(t, "linux-x64");
	const run = scripted(fixture);
	const started = run.session.start();
	await run.until(() => run.workers.length === 1);
	run.worker().stderr.emit("data", `Error: cannot load ${fixture.voiceHome}/runtime TOKEN=abc\n`.repeat(1000));
	run.worker().say({ type: "error", code: "runtime-load" });
	const error = await started.then(() => undefined, (reason: unknown) => reason);
	assert.ok(error instanceof VoiceSessionError);
	assert.equal(error.code, "runtime-load");
	assert.equal(error.message, "The voice runtime could not be loaded on this system.");
	assert.deepEqual(run.worker().signals, []);
});

test("a model-invalid error while recording ends the session and a later stop reports it", async (t) => {
	// The worker verifies the model digests while it records (T4).
	const fixture = await installFixture(t, "linux-x64");
	const run = scripted(fixture);
	const started = run.session.start();
	await run.until(() => run.workers.length === 1);
	run.worker().say({ type: "recording" });
	await started;
	run.worker().say({ type: "error", code: "model-invalid" });
	await run.until(() => run.session.state === "finished");
	await rejectsWith(run.session.stop(), "model-invalid");
	assert.deepEqual(run.states, ["starting", "recording", "finished"]);
	assert.ok(!run.worker().received.some((message) => message.type === "stop"), "no stop is sent to a finished worker");
});

test("timeouts, a silent transcript and an early exit fail cleanly", async (t) => {
	const fixture = await installFixture(t, "linux-x64");

	await t.test("start timeout", async () => {
		const run = scripted(fixture, { startTimeoutMs: 20 });
		await rejectsWith(run.session.start(), "timeout");
		assert.deepEqual(run.workers[0]!.signals, ["SIGKILL"]);
	});

	await t.test("transcribe timeout", async () => {
		const run = scripted(fixture, { transcribeTimeoutMs: 20 });
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		await rejectsWith(run.session.stop(), "timeout");
		assert.deepEqual(run.worker().signals, ["SIGKILL"]);
	});

	await t.test("empty transcript", async () => {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		const stopped = run.session.stop();
		run.worker().say({ type: "transcribing" });
		run.worker().say({ type: "result", text: "   ", truncated: false });
		await rejectsWith(stopped, "no-speech");
	});

	await t.test("exit while recording", async () => {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		run.worker().exit();
		await run.until(() => run.session.state === "finished");
		await rejectsWith(run.session.stop(), "worker-exited");
	});
});

test("a transcript split inside UTF-8 characters at any byte is decoded exactly", async (t) => {
	const fixture = await installFixture(t, "linux-x64");
	const text = "canción del niño 🎤 añadida";
	const bytes = Buffer.from(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: "result", text, truncated: false })}\n`);
	for (let split = 1; split < bytes.length; split++) {
		const run = scripted(fixture);
		const started = run.session.start();
		await run.until(() => run.workers.length === 1);
		run.worker().say({ type: "recording" });
		await started;
		const stopped = run.session.stop();
		run.worker().say({ type: "transcribing" });
		run.worker().stdout.emit("data", bytes.subarray(0, split));
		run.worker().stdout.emit("data", bytes.subarray(split));
		assert.deepEqual(await stopped, { text, truncated: false }, `split at byte ${split}`);
	}
});

test("a transcript produced by the recording limit is returned by a later stop", async (t) => {
	const fixture = await installFixture(t, "linux-x64");
	const run = scripted(fixture, { maxRecordingMs: 1000 });
	const started = run.session.start();
	await run.until(() => run.workers.length === 1);
	assert.equal((run.worker().received[0] as any).maxRecordingMs, 1000);
	run.worker().say({ type: "recording" });
	await started;
	run.worker().say({ type: "transcribing" });
	run.worker().say({ type: "result", text: "cut short", truncated: true });
	run.worker().exit();
	await run.until(() => run.session.state === "finished");
	assert.deepEqual(await run.session.stop(), { text: "cut short", truncated: true });
});

test("the real worker process records and transcribes through fake installed modules", { skip: !hostTarget && "no pinned voice target for this host" }, async (t) => {
	const fixture = await installFixture(t, hostTarget!);
	const session = createVoiceSession({ target: fixture.target, voiceHome: fixture.voiceHome, manifests: fixture.manifests, startTimeoutMs: 10_000, transcribeTimeoutMs: 10_000 });
	await session.start();
	assert.equal(session.state, "recording");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(await session.stop(), { text: "fake transcript", truncated: false });
	assert.equal(session.state, "finished");

	const cancelled = createVoiceSession({ target: fixture.target, voiceHome: fixture.voiceHome, manifests: fixture.manifests, startTimeoutMs: 10_000 });
	await cancelled.start();
	await cancelled.cancel();
	assert.equal(cancelled.state, "finished");
	await rejectsWith(cancelled.stop(), "cancelled");
});
