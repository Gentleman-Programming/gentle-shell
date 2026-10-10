/**
 * PulseAudio native-protocol v13 playback stream for PCM WAV: strict WAV
 * validation + extraction, CREATE_PLAYBACK_STREAM v13, REQUEST-driven PCM
 * memblock writes, DRAIN, DELETE. Original MIT (repo-licensed) implementation
 * derived from the official protocol declaration only; no PulseAudio/LGPL
 * implementation code is copied.
 *
 * Reference (read-only, PulseAudio v17.0): src/pulsecore/protocol-native.c
 * (CREATE/DRAIN/DELETE, playback_stream_request_bytes), src/pulsecore/pstream.c
 * (memblock frames), src/pulse/stream.c (write path), PROTOCOL v13. See
 * odd/tasks/native-audio-backend.md.
 *
 * No stream is created here except by an explicit playPulseWav() call; bytes
 * are validated before any connect/create/PCM. Channel positions are the
 * standard mono(0)/stereo(1,2) mapping (channelmap.h not in the reference set).
 */
import { validateNotificationWav } from "./notification-audio.ts";
import {
	MAX_REQUEST_TIMEOUT_MS, PulseClient, loadPulseCookie, resolvePulseCookiePath, type PulseClientOptions,
} from "./notification-pulse-client.ts";
import {
	PulseCommand, PulseSampleFormat, boundedPulseTagWriter, type PulseSampleSpec, type PulseTagReader, type PulseTagWriter,
} from "./notification-pulse-protocol.ts";

export const MAX_PCM_CHUNK = 64 * 1024;
/** 10 s maximum validated duration plus a 1 s termination margin; the DRAIN ack can wait for the full sound. */
export const DEFAULT_PLAYBACK_BUDGET_MS = 11000;
export const MAX_EARLY_REQUESTS = 32;
const PA_INVALID_INDEX = 0xffffffff;
const PA_VOLUME_NORM = 0x10000;

export interface WavPCM {
	readonly format: number;
	readonly sampleSpec: PulseSampleSpec;
	readonly channelMap: readonly number[];
	readonly data: Buffer;
	readonly frameSize: number;
	readonly durationMs: number;
}
export interface PulsePlaybackOptions {
	client?: PulseClient;
	clientOptions?: PulseClientOptions;
	adjustLatency?: boolean;
	budgetMs?: number;
	requestTimeoutMs?: number;
}

function pulseFormatForBits(bits: number): number {
	if (bits === 8) return PulseSampleFormat.U8;
	if (bits === 16) return PulseSampleFormat.S16LE;
	if (bits === 24) return PulseSampleFormat.S24LE;
	if (bits === 32) return PulseSampleFormat.S32LE;
	throw new Error("Pulse stream: unsupported PCM depth");
}

/** Validate with the existing strict 9a validator, then extract fmt/data and map to PulseAudio. */
export function parsePulseWav(bytes: Buffer): WavPCM {
	const durationMs = validateNotificationWav(bytes);
	let offset = 12;
	let bits = 0; let channels = 0; let rate = 0; let data: Buffer | undefined;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString("ascii", offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (id === "fmt ") {
			channels = bytes.readUInt16LE(start + 2);
			rate = bytes.readUInt32LE(start + 4);
			bits = bytes.readUInt16LE(start + 14);
		} else if (id === "data") data = Buffer.from(bytes.subarray(start, start + size));
		offset = start + size + (size % 2);
	}
	if (!data || channels < 1 || channels > 2) throw new Error("Pulse stream: invalid WAV");
	const format = pulseFormatForBits(bits);
	const sampleSpec: PulseSampleSpec = Object.freeze({ format, channels, rate });
	return Object.freeze({
		format, sampleSpec,
		channelMap: Object.freeze(channels === 1 ? [0] : [1, 2]),
		data, frameSize: channels * (bits / 8), durationMs,
	});
}

/** CREATE_PLAYBACK_STREAM v13 args: default sink, all seven flags false, corked/muted false, NORM volume. */
function buildCreateArgs(pcm: WavPCM, adjustLatency: boolean): PulseTagWriter {
	const volumes = Array.from({ length: pcm.sampleSpec.channels }, () => PA_VOLUME_NORM);
	return boundedPulseTagWriter()
		.sampleSpec(pcm.sampleSpec)
		.channelMap(pcm.channelMap)
		.u32(PA_INVALID_INDEX)
		.string(null)
		.u32(0xffffffff) // maxlength
		.boolean(false) // corked
		.u32(0) // tlength
		.u32(0) // prebuf
		.u32(0) // minreq
		.u32(0) // syncid
		.cvolume(volumes)
		.boolean(false).boolean(false).boolean(false).boolean(false).boolean(false).boolean(false).boolean(false) // 7 flags
		.boolean(false) // muted
		.boolean(adjustLatency)
		.proplist([["media.name", "gentle-shell notification"], ["media.role", "event"]]);
}

/** v13 reply: stream/sink indices, missing, buffer attrs, spec, map, device, name, suspended, latency. */
function parseCreateReply(reader: PulseTagReader, pcm: WavPCM): { streamIndex: number; missing: number } {
	const streamIndex = reader.u32();
	reader.u32(); // sink_input index
	const missing = reader.u32();
	reader.u32(); reader.u32(); reader.u32(); reader.u32(); // maxlength, tlength, prebuf, minreq
	const spec = reader.sampleSpec();
	const map = reader.channelMap();
	reader.u32(); // sink device index
	reader.string(); // sink name
	reader.boolean(); // suspended
	reader.usec(); // configured sink latency
	reader.assertEOF();
	if (spec.format !== pcm.sampleSpec.format || spec.channels !== pcm.sampleSpec.channels || spec.rate !== pcm.sampleSpec.rate)
		throw new Error("Pulse stream: server sample spec mismatch");
	if (map.length !== pcm.sampleSpec.channels) throw new Error("Pulse stream: server channel map mismatch");
	return { streamIndex, missing };
}

function streamAbortError(): Error { const error = new Error("Pulse stream: aborted"); error.name = "AbortError"; return error; }
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
	const list = signals.filter((value): value is AbortSignal => value !== undefined);
	if (list.length === 0) return new AbortController().signal;
	if (list.length === 1) return list[0]!;
	return AbortSignal.any(list);
}
function unrefTimer(handle: ReturnType<typeof setTimeout>): void { (handle as { unref?: () => void }).unref?.(); }

/**
 * Play a validated PCM WAV over an authorized Pulse link. The caller supplies a
 * connected+authenticated `client`, or clientOptions to own the connection.
 * Returns after DRAIN and DELETE acks; closes the connection in all paths.
 */
export async function playPulseWav(bytes: Buffer, signal?: AbortSignal, options: PulsePlaybackOptions = {}): Promise<void> {
	const pcm = parsePulseWav(bytes);
	const ownsClient = options.client === undefined;
	const clientOptions = options.clientOptions ?? {};
	const client = options.client ?? new PulseClient(clientOptions);
	const budgetMs = options.budgetMs ?? DEFAULT_PLAYBACK_BUDGET_MS;
	const requestMs = Math.min(options.requestTimeoutMs ?? MAX_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
	const budget = new AbortController();
	const budgetTimer = setTimeout(() => budget.abort(new Error("Pulse stream: budget exceeded")), budgetMs);
	unrefTimer(budgetTimer);
	const combined = combineSignals(signal, budget.signal);
	const total = pcm.data.length;
	const chunkCap = MAX_PCM_CHUNK - (MAX_PCM_CHUNK % pcm.frameSize);
	let streamIndex: number | undefined;
	let created = false;
	let failure: Error | undefined;
	let demand = 0; let sent = 0;
	let wake: (() => void) | undefined;
	const early: Array<{ index: number; bytes: number }> = [];
	const wakeWaiter = () => { const resolve = wake; wake = undefined; resolve?.(); };
	const listener = (command: number, reader: PulseTagReader) => {
		if (command !== PulseCommand.REQUEST) return;
		let index: number; let wanted: number;
		try { index = reader.u32(); wanted = reader.u32(); reader.assertEOF(); }
		catch { failure ??= new Error("Pulse stream: malformed request"); wakeWaiter(); return; }
		if (streamIndex === undefined) {
			if (early.length >= MAX_EARLY_REQUESTS) { failure ??= new Error("Pulse stream: too many early requests"); wakeWaiter(); return; }
			early.push({ index, bytes: wanted }); return;
		}
		if (index !== streamIndex) { failure ??= new Error("Pulse stream: unknown stream request"); wakeWaiter(); return; }
		demand += wanted;
		wakeWaiter();
	};
	const off = client.onEvent(listener);
	try {
		if (ownsClient) {
			await client.connect(combined);
			const cookie = clientOptions.cookie ?? await loadPulseCookie(resolvePulseCookiePath(clientOptions.env ?? {}), combined);
			await client.authenticate(cookie, {}, combined);
		}
		const reply = await client.request(PulseCommand.CREATE_PLAYBACK_STREAM, buildCreateArgs(pcm, options.adjustLatency === true), combined, requestMs);
		const createdReply = parseCreateReply(reply, pcm);
		streamIndex = createdReply.streamIndex;
		created = true;
		for (const request of early) { if (request.index !== streamIndex) throw new Error("Pulse stream: unknown stream request"); demand += request.bytes; }
		demand += createdReply.missing;
		while (sent < total) {
			if (failure) throw failure;
			if (combined.aborted) throw combined.reason instanceof Error ? combined.reason : streamAbortError();
			const available = Math.min(demand, total - sent);
			const aligned = available - (available % pcm.frameSize);
			if (aligned < pcm.frameSize) {
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => { wake = undefined; reject(combined.reason instanceof Error ? combined.reason : streamAbortError()); };
					combined.addEventListener("abort", onAbort, { once: true });
					wake = () => { combined.removeEventListener("abort", onAbort); resolve(); };
				});
				continue;
			}
			const chunk = Math.min(aligned, chunkCap);
			await client.sendDataFrame(streamIndex, pcm.data.subarray(sent, sent + chunk), combined, requestMs);
			sent += chunk; demand -= chunk;
		}
		(await client.request(PulseCommand.DRAIN_PLAYBACK_STREAM, boundedPulseTagWriter().u32(streamIndex), combined, requestMs)).assertEOF();
		(await client.request(PulseCommand.DELETE_PLAYBACK_STREAM, boundedPulseTagWriter().u32(streamIndex), combined, requestMs)).assertEOF();
	} catch (error) {
		failure ??= error as Error;
		if (created && streamIndex !== undefined) {
			try { await client.request(PulseCommand.DELETE_PLAYBACK_STREAM, boundedPulseTagWriter().u32(streamIndex), undefined, 500); }
			catch { /* best effort when the link is still usable */ }
		}
		throw failure;
	} finally {
		off();
		clearTimeout(budgetTimer);
		await client.close();
	}
}
