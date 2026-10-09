import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import test from "node:test";

// Preserve the oversized-output subprocess boundary from frozen source 41210ef5.
// This is a candidate probe, not proof of the original file-worker crash cause.
test("one synchronous child exceeds the output limit", () => {
 writeSync(2, "PROBE_BEFORE\n");
 const result = spawnSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], {
  env: process.env, shell: false, encoding: "utf8", timeout: 15000,
  killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true
 });
 writeSync(2, "PROBE_AFTER " + JSON.stringify({
  error: result.error?.code ?? null, status: result.status, signal: result.signal,
  stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
  stderrBytes: Buffer.byteLength(result.stderr ?? "")
 }) + "\n");
 assert.equal(result.error?.code, "ENOBUFS");
 assert.equal(result.stderr, "");
});
