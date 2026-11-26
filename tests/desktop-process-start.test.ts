import assert from "node:assert/strict";
import { test } from "node:test";
import { readProcessStartMs, type ProcessStartRunner } from "../lib/desktop-feed-sources.ts";

type Reply = { error?: Error | null; stdout?: string; throws?: boolean };

function runner(reply: Reply) {
	const calls: { file: string; args: string[] }[] = [];
	const run: ProcessStartRunner = (file, args, _options, callback) => {
		calls.push({ file, args });
		if (reply.throws) throw new Error("spawn failed");
		callback(reply.error ?? null, reply.stdout ?? "");
		return undefined;
	};
	return { run, calls };
}

test("should return the creation time the process list reports", async () => {
	const { run, calls } = runner({ stdout: "1763553600123\r\n" });
	assert.equal(await readProcessStartMs(4321, run, "win32"), 1763553600123);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].file, "powershell");
	assert.ok(calls[0].args.at(-1)?.includes("ProcessId=4321"));
});

test("should not run anything and return undefined off Windows", async () => {
	for (const platform of ["linux", "darwin"] as const) {
		const { run, calls } = runner({ stdout: "1763553600123" });
		assert.equal(await readProcessStartMs(4321, run, platform), undefined, platform);
		assert.equal(calls.length, 0, platform);
	}
});

test("should not run anything for a pid that is not a positive integer", async () => {
	for (const pid of [0, -4, 1.5, Number.NaN]) {
		const { run, calls } = runner({ stdout: "1763553600123" });
		assert.equal(await readProcessStartMs(pid, run, "win32"), undefined, String(pid));
		assert.equal(calls.length, 0, String(pid));
	}
});

test("should return undefined when the executor reports an error", async () => {
	assert.equal(await readProcessStartMs(4321, runner({ error: new Error("timed out"), stdout: "1763553600123" }).run, "win32"), undefined);
});

test("should return undefined when the executor throws", async () => {
	assert.equal(await readProcessStartMs(4321, runner({ throws: true }).run, "win32"), undefined);
});

test("should return undefined for empty, invalid or non-positive output", async () => {
	for (const stdout of ["", "  \r\n", "not a number", "0", "-5", "123abc", "1763553600123 extra", "12.5"]) {
		assert.equal(await readProcessStartMs(4321, runner({ stdout }).run, "win32"), undefined, JSON.stringify(stdout));
	}
});
