import assert from "node:assert/strict";
import test from "node:test";
import {
	NativeBinaryUnavailableError,
	REQUIRE_DEV_BINARY_ENV,
	REQUIRE_NATIVE_BINARY_ENV,
	requireDevBinary,
	requireNativeBinary,
} from "./support/native-binary-gate.ts";

// Two suites used to decide for themselves whether to run:
//
//   tests/native-review-parity-runtime.test.ts
//     const test = resolvedBinary === undefined ? baseTest.skip : baseTest;
//   tests/gentle-ai-binary.test.ts
//     const verifiedBinaryTest = releaseDigestsPinned && existsSync(...) ? test : test.skip;
//
// Both skip silently when the pinned runtime is absent, so a fresh clone or a
// CI job that never installed the binary reports green with zero real coverage
// of the thing those suites exist to cover. That is exactly how an earlier
// protocol-minor gap stayed hidden: the suite reported 0 fail while every test
// in it had skipped. The gate keeps the local convenience and removes the
// silence -- under GENTLE_PI_REQUIRE_NATIVE_BINARY=1 an absent binary is a
// failure, not a skip.

const PINNED = { resolvedBinary: "/tmp/gentle-ai", digestsPinned: true } as const;

test("the env var name is the one CI sets", () => {
	assert.equal(REQUIRE_NATIVE_BINARY_ENV, "GENTLE_PI_REQUIRE_NATIVE_BINARY");
});

test("a resolved binary with pinned digests runs, and names no skip reason", () => {
	for (const env of [{}, { GENTLE_PI_REQUIRE_NATIVE_BINARY: "1" }]) {
		const gate = requireNativeBinary({ ...PINNED, env });
		assert.equal(gate.run, true);
		assert.equal(Object.hasOwn(gate, "reason"), false);
	}
});

test("without the env var an unresolved binary yields a skip carrying a concrete reason", () => {
	const gate = requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: {} });

	assert.equal(gate.run, false);
	assert.match(gate.reason as string, /\S/);
	// The reason must name what is missing and how to get it, so a reader of CI
	// output does not have to go read the gate to understand the skip.
	assert.match(gate.reason as string, /binary/i);
	assert.match(gate.reason as string, new RegExp(REQUIRE_NATIVE_BINARY_ENV));
});

test("without the env var unpinned digests yield a skip with a distinct reason", () => {
	const unresolved = requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: {} });
	const unpinned = requireNativeBinary({ ...PINNED, digestsPinned: false, env: {} });

	assert.equal(unpinned.run, false);
	assert.ok("reason" in unresolved);
	assert.match(unpinned.reason as string, /digest/i);
	assert.notEqual(unpinned.reason, unresolved.reason, "the two causes must be distinguishable in output");
});

test("under the env var an unresolved binary throws instead of skipping", () => {
	assert.throws(
		() => requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: { GENTLE_PI_REQUIRE_NATIVE_BINARY: "1" } }),
		(error: unknown) => error instanceof NativeBinaryUnavailableError && /binary/i.test((error as Error).message),
	);
});

test("under the env var unpinned digests throw instead of skipping", () => {
	assert.throws(
		() => requireNativeBinary({ ...PINNED, digestsPinned: false, env: { GENTLE_PI_REQUIRE_NATIVE_BINARY: "1" } }),
		(error: unknown) => error instanceof NativeBinaryUnavailableError && /digest/i.test((error as Error).message),
	);
});

test("only an exact \"1\" arms the gate, so a stray value cannot silently disarm CI", () => {
	// A truthy-looking value that is not "1" must not be treated as armed, and
	// must not be treated as arming either: the contract is one exact value.
	for (const value of ["0", "", "true", "yes", "false"]) {
		const gate = requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: { GENTLE_PI_REQUIRE_NATIVE_BINARY: value } });
		assert.equal(gate.run, false, `${JSON.stringify(value)} must not arm the gate`);
	}
	assert.throws(() => requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: { GENTLE_PI_REQUIRE_NATIVE_BINARY: "1" } }), NativeBinaryUnavailableError);
});

// Phase 13.12/13.13 follow-up: the same loud-skip gate, extended to the
// third self-skipping suite (tests/devbinary/native-review-parity.devtest.ts),
// gated behind its OWN env var so ordinary CI (no dev binary provisioned)
// keeps skipping silently by default.

test("the dev-binary env var name is distinct from the pinned-binary one", () => {
	assert.equal(REQUIRE_DEV_BINARY_ENV, "GENTLE_PI_REQUIRE_DEV_BINARY");
	assert.notEqual(REQUIRE_DEV_BINARY_ENV, REQUIRE_NATIVE_BINARY_ENV);
});

test("an existing dev binary path runs, and names no skip reason", () => {
	for (const env of [{}, { GENTLE_PI_REQUIRE_DEV_BINARY: "1" }]) {
		const gate = requireDevBinary({ devBinaryPath: "/opt/dev/gentle-ai", exists: true, env });
		assert.equal(gate.run, true);
		assert.equal(Object.hasOwn(gate, "reason"), false);
	}
});

test("without the env var a missing GENTLE_AI_DEV_BINARY yields a skip carrying a concrete reason", () => {
	const gate = requireDevBinary({ devBinaryPath: undefined, exists: false, env: {} });
	assert.equal(gate.run, false);
	assert.match(gate.reason as string, /GENTLE_AI_DEV_BINARY/);
	assert.match(gate.reason as string, new RegExp(REQUIRE_DEV_BINARY_ENV));
});

test("without the env var a set but non-existent dev binary path yields a distinct skip reason", () => {
	const missingVar = requireDevBinary({ devBinaryPath: undefined, exists: false, env: {} });
	const badPath = requireDevBinary({ devBinaryPath: "/no/such/gentle-ai", exists: false, env: {} });
	assert.equal(badPath.run, false);
	assert.ok("reason" in missingVar);
	assert.match(badPath.reason as string, /\/no\/such\/gentle-ai/);
	assert.notEqual(badPath.reason, missingVar.reason, "the two causes must be distinguishable in output");
});

test("under the env var a missing dev binary throws instead of skipping", () => {
	assert.throws(
		() => requireDevBinary({ devBinaryPath: undefined, exists: false, env: { GENTLE_PI_REQUIRE_DEV_BINARY: "1" } }),
		(error: unknown) => error instanceof NativeBinaryUnavailableError && /GENTLE_AI_DEV_BINARY/.test((error as Error).message),
	);
	assert.throws(
		() => requireDevBinary({ devBinaryPath: "/no/such/gentle-ai", exists: false, env: { GENTLE_PI_REQUIRE_DEV_BINARY: "1" } }),
		(error: unknown) => error instanceof NativeBinaryUnavailableError && /\/no\/such\/gentle-ai/.test((error as Error).message),
	);
});

test("GENTLE_PI_REQUIRE_NATIVE_BINARY never arms the dev-binary gate, and vice versa", () => {
	assert.equal(requireDevBinary({ devBinaryPath: undefined, exists: false, env: { GENTLE_PI_REQUIRE_NATIVE_BINARY: "1" } }).run, false);
	assert.equal(requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: { GENTLE_PI_REQUIRE_DEV_BINARY: "1" } }).run, false);
});

test("the gate reads the passed env, never the ambient process env", () => {
	const original = process.env[REQUIRE_NATIVE_BINARY_ENV];
	try {
		process.env[REQUIRE_NATIVE_BINARY_ENV] = "1";
		// An explicit empty env must win: tests have to be able to exercise the
		// unarmed branch even on a CI runner where the variable is set.
		const gate = requireNativeBinary({ resolvedBinary: undefined, digestsPinned: true, env: {} });
		assert.equal(gate.run, false);
	} finally {
		if (original === undefined) delete process.env[REQUIRE_NATIVE_BINARY_ENV];
		else process.env[REQUIRE_NATIVE_BINARY_ENV] = original;
	}
});
