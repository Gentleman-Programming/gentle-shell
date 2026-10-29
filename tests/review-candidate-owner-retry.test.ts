import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWindowsSystemProbeTimeoutMs, withWindowsSystemProbeRetry } from "../lib/review-candidate-view-owner.ts";

function failingProbe(code: string, attempts: { count: number }): () => string {
	return () => {
		attempts.count += 1;
		const error = new Error(`fixture probe failure (${code})`) as NodeJS.ErrnoException;
		error.code = code;
		throw error;
	};
}

test("windows system probe retries once on a transient timeout and returns the recovered value", () => {
	const attempts = { count: 0 };
	let recovered = false;
	const value = withWindowsSystemProbeRetry(() => {
		attempts.count += 1;
		if (attempts.count === 1) {
			const error = new Error("fixture probe timeout") as NodeJS.ErrnoException;
			error.code = "ETIMEDOUT";
			throw error;
		}
		recovered = true;
		return "S-1-5-21-1";
	});
	assert.equal(value, "S-1-5-21-1");
	assert.equal(recovered, true);
	assert.equal(attempts.count, 2);
});

test("windows system probe does not retry authority-class failures", () => {
	for (const code of ["EPERM", "EACCES", "ENOENT"]) {
		const attempts = { count: 0 };
		const probe = failingProbe(code, attempts);
		assert.throws(() => withWindowsSystemProbeRetry(probe), (error: NodeJS.ErrnoException) => error.code === code);
		assert.equal(attempts.count, 1, `code ${code} must fail closed without a retry`);
	}
});

test("windows system probe fails closed after two transient failures", () => {
	const attempts = { count: 0 };
	const probe = failingProbe("ETIMEDOUT", attempts);
	let thrown: unknown;
	try {
		withWindowsSystemProbeRetry(probe);
	} catch (error) {
		thrown = error;
	}
	assert.equal(attempts.count, 2);
	assert.ok(thrown instanceof Error);
	assert.equal((thrown as NodeJS.ErrnoException).code, "ETIMEDOUT");
});

test("windows system probe does not retry when the first attempt succeeds", () => {
	const attempts = { count: 0 };
	const value = withWindowsSystemProbeRetry(() => {
		attempts.count += 1;
		return "S-1-5-18";
	});
	assert.equal(value, "S-1-5-18");
	assert.equal(attempts.count, 1);
});

test("windows system probes default to a cold-runner-safe bounded timeout", () => {
	assert.equal(resolveWindowsSystemProbeTimeoutMs({}), 15_000);
});

test("windows system probe timeout honors a bounded environment override", () => {
	const env = (value: string) => ({ GENTLE_PI_CANDIDATE_WINDOWS_PROBE_TIMEOUT_MS: value });
	assert.equal(resolveWindowsSystemProbeTimeoutMs(env("30000")), 30_000);
	assert.equal(resolveWindowsSystemProbeTimeoutMs(env("120000")), 120_000);
	for (const invalid of ["0", "-1", "abc", "1.5", "120001", "", "015000"]) {
		assert.equal(resolveWindowsSystemProbeTimeoutMs(env(invalid)), 15_000, invalid);
	}
});

test("every windows system probe uses the configurable timeout", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("../lib/review-candidate-view-owner.ts", import.meta.url), "utf8");
	const probes = source.match(/windowsSystemExecutable\([^)]*\), \[[^\]]*\], \{[^}]*\}/g) ?? [];
	assert.equal(probes.length, 5);
	for (const probe of probes) assert.match(probe, /timeout: resolveWindowsSystemProbeTimeoutMs\(\)/);
});
