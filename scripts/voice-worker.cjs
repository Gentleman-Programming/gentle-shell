"use strict";
// Voice dictation worker (S1-S3). lib/voice-session.ts runs this file as its own
// Node process, so capture callbacks, the blocking recognizer load and the decode
// never run inside Gentle AI. It speaks JSON lines: stdin receives one `start`
// request, then `stop` or `cancel`; stdout carries `recording`, `transcribing`,
// and one final `result` or `error`. Errors carry a closed code only, never a
// message, path or native error text.
//
// Capture starts as soon as the runtime files pass validation and node-cpal is
// loaded, so the first words are recorded. The model digests are then verified
// while recording, by streamed hashing that never blocks capture for long.
// sherpa-onnx and the model are loaded only after every digest matched and stop
// arrived; their synchronous load would stall capture callbacks. A mismatch
// found while recording ends the session with model-invalid at once.
//
// The optional native packages are loaded only after the files they come from
// pass validation, and only from the roots in the start request, which the
// parent computes from its pinned manifests. The validation refuses links, special
// files, foreign owners and digest mismatches; it does not make the install
// tamper-proof against the same user, who can replace the files at any time.

const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, readdir } = require("node:fs/promises");
const path = require("node:path");
const { addAbortSignal } = require("node:stream");

const SCHEMA = "gentle.voice/v1";
const TARGETS = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"];
const MODEL_ROLES = ["encoder", "decoder", "joiner", "tokens"];
// The only runtime files ever loaded; both must be listed as required files.
const SHERPA_ENTRY = "node_modules/sherpa-onnx-node/non-streaming-asr.js";
const CPAL_ENTRY = "node_modules/node-cpal/index.js";
const MAX_INPUT_LINE = 64 * 1024;
const MAX_TREE_ENTRIES = 256;
const MAX_TEXT = 16 * 1024;
const TARGET_RATE = 16000;
// Less than a tenth of a second of audio is treated as no audio at all.
const MIN_SECONDS = 0.1;
const SAFE_SEGMENT = /^[A-Za-z0-9@_][A-Za-z0-9._@+-]*$/;
// Integer formats are scaled to [-1, 1]; unsigned formats are centred first.
const SAMPLE_FORMATS = {
	f32: { offset: 0, scale: 1 },
	f64: { offset: 0, scale: 1 },
	i8: { offset: 0, scale: 128 },
	i16: { offset: 0, scale: 32768 },
	i24: { offset: 0, scale: 8388608 },
	i32: { offset: 0, scale: 2147483648 },
	u8: { offset: 128, scale: 128 },
	u16: { offset: 32768, scale: 32768 },
	u32: { offset: 2147483648, scale: 2147483648 },
};

class WorkerFailure extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

const fail = (code) => {
	throw new WorkerFailure(code);
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isSafeRelative = (value) => typeof value === "string" && value.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
const isInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function parseStart(message) {
	if (!hasExactKeys(message, ["schema", "type", "target", "maxRecordingMs", "numThreads", "runtime", "model"])) fail("invalid-request");
	if (message.schema !== SCHEMA || message.type !== "start" || !TARGETS.includes(message.target)) fail("invalid-request");
	if (!isInteger(message.maxRecordingMs, 1000, 600000) || !isInteger(message.numThreads, 1, 8)) fail("invalid-request");
	const { runtime, model } = message;
	if (!hasExactKeys(runtime, ["root", "files"]) || !hasExactKeys(model, ["root", "files"])) fail("invalid-request");
	if (typeof runtime.root !== "string" || !path.isAbsolute(runtime.root) || typeof model.root !== "string" || !path.isAbsolute(model.root)) fail("invalid-request");
	const runtimeFiles = runtime.files;
	if (!Array.isArray(runtimeFiles) || runtimeFiles.length > MAX_TREE_ENTRIES || !runtimeFiles.every(isSafeRelative)) fail("invalid-request");
	if (!runtimeFiles.includes(SHERPA_ENTRY) || !runtimeFiles.includes(CPAL_ENTRY)) fail("invalid-request");
	if (!hasExactKeys(model.files, MODEL_ROLES)) fail("invalid-request");
	for (const role of MODEL_ROLES) {
		const file = model.files[role];
		const valid = hasExactKeys(file, ["name", "size", "sha256"]) && isSafeRelative(file.name) && !file.name.includes("/") && isInteger(file.size, 1, Number.MAX_SAFE_INTEGER) && /^[0-9a-f]{64}$/.test(file.sha256);
		if (!valid) fail("invalid-request");
	}
	return message;
}

// Walks an installed component and returns its regular files by relative path.
// Anything that is not a plain directory or regular file, is owned by another
// user, or is writable by everyone makes the whole component invalid. Ownership
// and modes are not checked on Windows, where Node reports neither.
async function readTree(root, uid, code) {
	const files = new Map();
	let entries = 0;
	const check = (info) => {
		if (uid !== undefined && (info.uid !== uid || (info.mode & 0o002) !== 0)) fail(code);
	};
	const rootInfo = await lstat(root).catch(() => fail(code));
	if (!rootInfo.isDirectory()) fail(code);
	check(rootInfo);
	const walk = async (directory, prefix) => {
		for (const name of await readdir(directory)) {
			if (++entries > MAX_TREE_ENTRIES) fail(code);
			const relative = prefix ? `${prefix}/${name}` : name;
			const info = await lstat(path.join(directory, name));
			check(info);
			if (info.isDirectory()) await walk(path.join(directory, name), relative);
			else if (info.isFile()) files.set(relative, info);
			else fail(code);
		}
	};
	await walk(root, "").catch((error) => {
		throw error instanceof WorkerFailure ? error : new WorkerFailure(code);
	});
	return files;
}

// Hashes a file chunk by chunk, so capture callbacks keep running in between.
function sha256(openRead, file, signal) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		addAbortSignal(signal, openRead(file))
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

async function validateRuntime(runtime, uid) {
	const files = await readTree(runtime.root, uid, "runtime-invalid");
	for (const required of runtime.files) if (!files.has(required)) fail("runtime-invalid");
}

async function validateModel(model, uid, openRead, signal) {
	const files = await readTree(model.root, uid, "model-invalid");
	for (const role of MODEL_ROLES) {
		const pin = model.files[role];
		if (files.get(pin.name)?.size !== pin.size) fail("model-invalid");
	}
	// The digests are checked on every session: the marker only records sizes.
	for (const role of MODEL_ROLES) {
		if (signal.aborted) fail("model-invalid");
		const pin = model.files[role];
		const digest = await sha256(openRead, path.join(model.root, pin.name), signal).catch(() => fail("model-invalid"));
		if (digest !== pin.sha256) fail("model-invalid");
	}
}

// Prefers 32-bit float input; otherwise keeps the device default when it is a
// format this worker can scale. Rates and channel counts stay at the default.
function chooseInputConfig(convenience, deviceId) {
	const defaults = convenience.getDefaultInputConfig(deviceId);
	const formats = convenience.getSupportedFormats(deviceId);
	if (!isRecord(defaults) || !isInteger(defaults.sampleRate, 8000, 384000) || !isInteger(defaults.channels, 1, 64)) fail("unsupported-input");
	const sampleFormat = Array.isArray(formats) && formats.includes("f32") ? "f32" : defaults.sampleFormat;
	if (!Object.hasOwn(SAMPLE_FORMATS, sampleFormat)) fail("unsupported-input");
	return { sampleRate: defaults.sampleRate, channels: defaults.channels, sampleFormat };
}

// Collects interleaved device frames as mono samples at the device rate, up to
// a fixed number of samples. Returns false once the limit is reached.
class MonoRecorder {
	constructor(config, maxSamples) {
		this.config = config;
		this.format = SAMPLE_FORMATS[config.sampleFormat];
		this.maxSamples = maxSamples;
		this.chunks = [];
		this.length = 0;
	}

	append(data) {
		const { channels } = this.config;
		const { offset, scale } = this.format;
		const frames = Math.min(Math.floor(data.length / channels), this.maxSamples - this.length);
		const mono = new Float32Array(frames);
		for (let frame = 0; frame < frames; frame++) {
			let sum = 0;
			for (let channel = 0; channel < channels; channel++) sum += (Number(data[frame * channels + channel]) - offset) / scale;
			const value = sum / channels;
			mono[frame] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
		}
		this.chunks.push(mono);
		this.length += frames;
		return this.length < this.maxSamples;
	}

	samples() {
		const all = new Float32Array(this.length);
		let at = 0;
		for (const chunk of this.chunks) {
			all.set(chunk, at);
			at += chunk.length;
		}
		this.chunks = [];
		return all;
	}
}

// Converts to 16 kHz. Downsampling averages each output sample's input window,
// a box filter that keeps most aliasing out of the speech band; upsampling
// interpolates linearly.
function resample(input, fromRate) {
	if (fromRate === TARGET_RATE) return input;
	const step = fromRate / TARGET_RATE;
	const output = new Float32Array(Math.floor(input.length / step));
	for (let i = 0; i < output.length; i++) {
		const start = i * step;
		if (step > 1) {
			const from = Math.floor(start);
			const to = Math.min(input.length, Math.max(from + 1, Math.floor(start + step)));
			let sum = 0;
			for (let j = from; j < to; j++) sum += input[j];
			output[i] = sum / (to - from);
		} else {
			const j = Math.floor(start);
			const next = input[Math.min(j + 1, input.length - 1)];
			output[i] = input[j] + (next - input[j]) * (start - j);
		}
	}
	return output;
}

class WorkerSession {
	constructor(io, exit) {
		this.io = io;
		this.exit = exit;
		this.state = "waiting";
		this.stream = undefined;
		this.recorder = undefined;
		this.request = undefined;
		// Settles once every model digest matched; rejects with model-invalid.
		this.modelVerified = undefined;
		this.verification = new AbortController();
		this.truncated = false;
	}

	send(message) {
		this.io.write(`${JSON.stringify({ schema: SCHEMA, ...message })}\n`);
	}

	// Ends the session once: closes capture, reports at most one final message.
	async end(final) {
		if (this.state === "ended") return;
		this.state = "ended";
		this.verification.abort();
		await this.closeStream();
		if (final) this.send(final);
		this.exit(final?.type === "error" ? 1 : 0);
	}

	async closeStream() {
		const stream = this.stream;
		this.stream = undefined;
		if (stream) await Promise.resolve(stream.close()).catch(() => {});
	}

	async handle(message) {
		if (this.state === "waiting") return this.begin(parseStart(message));
		if (!hasExactKeys(message, ["schema", "type"]) || message.schema !== SCHEMA) fail("invalid-request");
		if (message.type === "cancel") return this.end(undefined);
		if (message.type === "stop") {
			if (this.state === "recording") return this.transcribe();
			if (this.state === "loading") fail("invalid-request");
			return undefined;
		}
		fail("invalid-request");
	}

	async begin(request) {
		this.state = "loading";
		const { io } = this;
		if (request.target !== `${io.platform}-${io.arch}`) fail("runtime-invalid");
		// A cancel can arrive during any await; each step re-checks before going on.
		await validateRuntime(request.runtime, io.uid);
		if (this.state !== "loading") return;
		this.request = request;
		let cpal;
		try {
			cpal = io.loadModule(this.fromRuntime(CPAL_ENTRY));
		} catch {
			fail("runtime-load");
		}
		await this.openCapture(cpal?.convenience, request.maxRecordingMs);
	}

	// Starts in the same step that enters recording, so no stop can see a
	// session without a pending verification.
	verifyModel() {
		this.modelVerified = validateModel(this.request.model, this.io.uid, this.io.openRead ?? createReadStream, this.verification.signal);
		// While recording, a failed verification ends the session at once: the
		// audio could never be transcribed. Later, transcribe() reports it.
		this.modelVerified.catch((error) => {
			if (this.state === "recording") void this.fail(error);
		});
	}

	fromRuntime(entry) {
		return path.join(this.request.runtime.root, ...entry.split("/"));
	}

	// Loads sherpa-onnx and the recognizer; only called once the model verified.
	loadRecognizer() {
		const { request } = this;
		const fromModel = (role) => path.join(request.model.root, request.model.files[role].name);
		let asr;
		try {
			asr = this.io.loadModule(this.fromRuntime(SHERPA_ENTRY));
		} catch {
			fail("runtime-load");
		}
		try {
			return new asr.OfflineRecognizer({
				featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
				modelConfig: {
					transducer: { encoder: fromModel("encoder"), decoder: fromModel("decoder"), joiner: fromModel("joiner") },
					tokens: fromModel("tokens"),
					numThreads: request.numThreads,
					provider: "cpu",
					modelType: "nemo_transducer",
				},
			});
		} catch {
			fail("model-load");
		}
	}

	async openCapture(convenience, maxRecordingMs) {
		if (!isRecord(convenience)) fail("runtime-load");
		let device;
		try {
			device = convenience.getDefaultInputDevice();
		} catch {
			fail("no-input-device");
		}
		if (!isRecord(device) || typeof device.deviceId !== "string" || device.deviceId.length === 0) fail("no-input-device");
		let config;
		try {
			config = chooseInputConfig(convenience, device.deviceId);
		} catch (error) {
			throw error instanceof WorkerFailure ? error : new WorkerFailure("unsupported-input");
		}
		this.recorder = new MonoRecorder(config, Math.ceil((config.sampleRate * maxRecordingMs) / 1000));
		try {
			// The native layer holds the stream weakly; this session keeps it alive.
			this.stream = await convenience.createInputStream({
				deviceId: device.deviceId,
				config,
				onData: (data) => this.onData(data),
				onError: () => void this.fail(new WorkerFailure("capture")),
				autoStart: true,
				queueCapacityBuffers: 64,
			});
		} catch {
			fail("capture");
		}
		if (this.state !== "loading") return this.closeStream();
		this.state = "recording";
		this.send({ type: "recording" });
		this.verifyModel();
	}

	onData(data) {
		if (this.state !== "recording" || !ArrayBuffer.isView(data)) return;
		if (!this.recorder.append(data)) {
			this.truncated = true;
			void this.transcribe().catch((error) => this.fail(error));
		}
	}

	async transcribe() {
		this.state = "transcribing";
		this.send({ type: "transcribing" });
		await this.closeStream();
		if (this.state !== "transcribing") return;
		// Nothing from sherpa-onnx or the model is loaded before every digest matched.
		if (!this.modelVerified) fail("model-invalid");
		await this.modelVerified;
		if (this.state !== "transcribing") return;
		const { sampleRate } = this.recorder.config;
		const captured = this.recorder.samples();
		if (captured.length < sampleRate * MIN_SECONDS) fail("empty-audio");
		const samples = resample(captured, sampleRate);
		const recognizer = this.loadRecognizer();
		let text;
		try {
			const stream = recognizer.createStream();
			stream.acceptWaveform({ sampleRate: TARGET_RATE, samples });
			recognizer.decode(stream);
			text = recognizer.getResult(stream)?.text;
		} catch {
			fail("decode");
		}
		if (typeof text !== "string") fail("decode");
		await this.end({ type: "result", text: text.trim().slice(0, MAX_TEXT), truncated: this.truncated });
	}

	fail(error) {
		const code = error instanceof WorkerFailure ? error.code : "internal";
		return this.end({ type: "error", code });
	}
}

// Runs one dictation session. `io` supplies stdin, stdout, exit, the module
// loader, an optional file reader (`openRead`, fs.createReadStream by default)
// and the process facts, so tests can drive the worker in-process with
// fake modules; the real entry point below passes Node's own.
// Resolves after the session has ended and `io.exit` was called once.
function runVoiceWorker(io) {
	return new Promise((resolve) => {
		let buffered = "";
		const session = new WorkerSession(io, (code) => {
			io.input.removeListener("data", onData);
			io.input.removeListener("end", onEnd);
			io.exit(code);
			resolve();
		});
		// Messages are handled as they arrive, not queued: a cancel must reach the
		// session while it is still validating or loading.
		const dispatch = (handler) => {
			try {
				void Promise.resolve(handler()).catch((error) => session.fail(error));
			} catch (error) {
				void session.fail(error);
			}
		};
		const onData = (chunk) => {
			buffered += String(chunk);
			let newline;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				dispatch(() => {
					let message;
					try {
						message = line.length <= MAX_INPUT_LINE ? JSON.parse(line) : undefined;
					} catch {
						message = undefined;
					}
					return session.handle(message);
				});
			}
			if (buffered.length > MAX_INPUT_LINE) {
				buffered = "";
				dispatch(() => fail("invalid-request"));
			}
		};
		// A closed stdin means the parent is gone: stop capturing and leave.
		const onEnd = () => dispatch(() => session.end(undefined));
		io.input.on("data", onData);
		io.input.on("end", onEnd);
		if (!isInteger(Number(String(io.nodeVersion).split(".")[0]), 22, Number.MAX_SAFE_INTEGER)) {
			void session.end({ type: "error", code: "node-version" });
		}
	});
}

module.exports = { runVoiceWorker };

if (require.main === module) {
	const io = {
		input: process.stdin,
		write: (line) => process.stdout.write(line),
		exit: (code) => process.stdout.write("", () => process.exit(code)),
		loadModule: (file) => require(file),
		platform: process.platform,
		arch: process.arch,
		nodeVersion: process.versions.node,
		uid: typeof process.getuid === "function" ? process.getuid() : undefined,
	};
	process.on("uncaughtException", () => {
		process.stdout.write(`${JSON.stringify({ schema: SCHEMA, type: "error", code: "internal" })}\n`, () => process.exit(1));
	});
	process.stdin.setEncoding("utf8");
	void runVoiceWorker(io);
}
