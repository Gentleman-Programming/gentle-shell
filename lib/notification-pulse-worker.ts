/**
 * Standalone PulseAudio worker for the native notification backend. Runs as an
 * owned Node child (`node --experimental-strip-types --max-old-space-size=32`)
 * and speaks a single bounded JSON envelope on stdout:
 *   probe -> { schema, ok, available, formats }
 *   play  -> { schema, ok, played }
 * Failures are private: a generic `{ schema, ok:false }` and a nonzero exit.
 * It reads only argv, the environment and the owner-supplied snapshot; no SDK,
 * UI, extension, config-owner, cookie-content logging or OS audio surface.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { PulseClient } from "./notification-pulse-client.ts";
import { playPulseWav } from "./notification-pulse-stream.ts";

const SCHEMA = "gentle.audio.pulse/v1";
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function emit(payload: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ schema: SCHEMA, ...payload })}\n`);
}

/** Re-read the trusted owner snapshot with the same bounded nofollow pattern. */
async function readSnapshot(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 44 || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("invalid snapshot");
		const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== stat.size) throw new Error("invalid snapshot");
		return Buffer.from(buffer.subarray(0, bytesRead));
	} finally {
		await handle.close().catch(() => { /* close failure must not mask the outcome */ });
	}
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
	if (mode === "play") {
		const snapshot = process.argv[3];
		if (snapshot === undefined) { emit({ ok: false }); process.exitCode = 1; return; }
		try {
			const bytes = await readSnapshot(snapshot);
			await playPulseWav(bytes, undefined, { clientOptions: { env: process.env } });
			emit({ ok: true, played: true });
		} catch {
			emit({ ok: false });
			process.exitCode = 1;
		}
		return;
	}
	emit({ ok: false });
	process.exitCode = 1;
}

await main();
