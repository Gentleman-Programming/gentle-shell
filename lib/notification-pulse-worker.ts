/**
 * Standalone PulseAudio worker for the native notification backend. Runs as an
 * owned Node child (`node --experimental-strip-types --max-old-space-size=32`)
 * and speaks a single bounded JSON envelope on stdout:
 *   probe -> { schema, ok, available, formats }
 * Serve protocol (persistent mode): line-delimited JSON requests on stdin,
 *   `{ schema, op: "play", path }`, answered by one bounded
 *   `{ schema, ok, played }` envelope per play on stdout. Requests carry a
 *   snapshot PATH reference, not inline bytes: the worker re-reads the owner's
 *   private snapshot with the same bounded nofollow `readSnapshot()` on every
 *   play, so the fail-closed validation of snapshots is preserved verbatim and
 *   no audio bytes ever cross the stdio channel (request lines stay tiny and
 *   bounded). Protocol violations crash the worker with a nonzero exit and the
 *   owner respawns it on the next play; stdin EOF (owner death) exits cleanly
 *   and an idle worker self-retires, so teardown needs no owner round trip.
 * Failures are private: a generic `{ schema, ok:false }` and, for protocol
 * violations, a nonzero exit.
 * It reads only argv, the environment and the owner-supplied snapshot; no SDK,
 * UI, extension, config-owner, cookie-content logging or OS audio surface.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { PulseClient } from "./notification-pulse-client.ts";
import { playPulseWav } from "./notification-pulse-stream.ts";

const SCHEMA = "gentle.audio.pulse/v1";
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Request lines carry only a schema/op/path triple; anything longer is a protocol violation. */
const MAX_REQUEST_BYTES = 4096;
/** Bounded request backlog; an overflow is a protocol violation (crash, owner restarts). */
const MAX_PENDING_REQUESTS = 16;
/** An idle worker self-retires so one owner process never accumulates workers; unref'd, never busy. */
const SERVE_IDLE_EXIT_MS = 60000;

function emit(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ schema: SCHEMA, ...payload })}\n`);
}

/** Re-read the trusted owner snapshot with the same bounded nofollow pattern.
 *  `buffer` is a caller-owned scratch space so persistent serving never
 *  reallocates the 2 MiB read window per play; the returned bytes are a copy. */
async function readSnapshot(path: string, buffer: Buffer): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 44 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("invalid snapshot");
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size) throw new Error("invalid snapshot");
		return Buffer.from(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close().catch(() => { /* close failure must not mask the outcome */ });
	}
}

/** Protocol violation: one generic envelope so the waiting owner settles, then a crash. */
function crash(): never {
	emit({ ok: false });
	process.exit(1);
}

async function serve(): Promise<void> {
	const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
	const queue: string[] = [];
	let running = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => { if (queue.length === 0 && !running) process.exit(0); }, SERVE_IDLE_EXIT_MS);
		idleTimer.unref?.();
	};
	const runOne = async (line: string): Promise<void> => {
		let request: { schema?: unknown; op?: unknown; path?: unknown };
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed !== "object" || parsed === null) return crash();
			request = parsed as { schema?: unknown; op?: unknown; path?: unknown };
		} catch { return crash(); }
		if (request.schema !== SCHEMA || request.op !== "play" || typeof request.path !== "string" || request.path.length === 0) return crash();
		try {
			const bytes = await readSnapshot(request.path, buffer);
			await playPulseWav(bytes, undefined, { clientOptions: { env: process.env } });
			emit({ ok: true, played: true });
		} catch { emit({ ok: false }); } // A private play failure leaves the healthy worker serviceable.
	};
	const drain = async (): Promise<void> => {
		if (running) return;
		running = true;
		while (queue.length > 0) { const line = queue.shift()!; armIdle(); await runOne(line); }
		running = false;
		armIdle();
	};
	process.stdin.setEncoding("utf8");
	let text = "";
	process.stdin.on("data", (chunk: string) => {
		armIdle();
		text += chunk;
		for (;;) {
			const index = text.indexOf("\n");
			if (index === -1) break;
			const line = text.slice(0, index);
			text = text.slice(index + 1);
			if (line.length > MAX_REQUEST_BYTES || queue.push(line) > MAX_PENDING_REQUESTS) crash();
		}
		if (text.length > MAX_REQUEST_BYTES) crash(); // Unterminated request line over the bound.
		void drain();
	});
	process.stdin.on("end", () => process.exit(0));
	process.stdin.on("error", () => process.exit(1));
	armIdle();
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (mode === "probe") {
		try {
			const result = await new PulseClient({ env: process.env }).probe();
			emit({ ok: true, available: result.available, formats: result.formats });
		} catch {
			emit({ ok: true, available: false, formats: [] });
		}
		return;
	}
	if (mode === "serve") {
		await serve();
		return;
	}
	crash();
}

await main();
