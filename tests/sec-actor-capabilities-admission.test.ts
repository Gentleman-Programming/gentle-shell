/**
 * SEC-13: Per-actor identity/capability binding, registrar admission,
 * and bounded write surface validation at exit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_TOOL_NAMES,
	bindActorSpawnEnv,
	resolveActorCapabilities,
	validateRegistrarToolAdmission,
} from "../lib/actor-capabilities.ts";
import { isPathWithinAllowedSurfaces, validateCapturedWritesAtExit } from "../lib/bounded-writer-admission.ts";

// ---------------------------------------------------------------------------
// resolveActorCapabilities
// ---------------------------------------------------------------------------

test("analyst: gentle-ai-security gets read-only role with prohibited write tools", () => {
	const caps = resolveActorCapabilities("gentle-ai-security", ["read", "bash", "edit"], []);
	assert.equal(caps.role, "analyst");
	assert.equal(caps.actorName, "gentle-ai-security");
	assert.deepEqual(caps.allowedTools, ["read", "grep", "find", "codegraph"]);
	assert.deepEqual(caps.prohibitedTools, ["edit", "write", "bash"]);
	assert.deepEqual(caps.allowedEditSurfaces, []);
});

test("analyst: requested bash/edit/write are overridden to read-only and are prohibited", () => {
	const caps = resolveActorCapabilities("gentle-ai-security", ["bash", "edit", "write"]);
	assert.ok(!caps.allowedTools.includes("bash") && !caps.allowedTools.includes("edit") && !caps.allowedTools.includes("write"));
	assert.ok(caps.prohibitedTools.includes("edit") && caps.prohibitedTools.includes("bash") && caps.prohibitedTools.includes("write"));
});

test("worker: gets worker role with declared tools and no prohibited tools", () => {
	const tools = ["read", "bash", "edit", "write"];
	const caps = resolveActorCapabilities("gentle-ai-worker", tools);
	assert.equal(caps.role, "worker");
	assert.deepEqual(caps.allowedTools, tools);
	assert.deepEqual(caps.prohibitedTools, []);
});

test("verifier: gets verifier role; generic for unrecognized agent", () => {
	assert.equal(resolveActorCapabilities("gentle-ai-verify", ["read"]).role, "verifier");
	assert.equal(resolveActorCapabilities("my-custom-agent", ["read"]).role, "generic");
});

test("allowedEditSurfaces is propagated when provided and omitted otherwise", () => {
	const surfaces = ["lib/*.ts", "tests/**/*.test.ts"];
	assert.deepEqual(resolveActorCapabilities("gentle-ai-worker", ["edit"], surfaces).allowedEditSurfaces, surfaces);
	assert.equal(resolveActorCapabilities("gentle-ai-worker", ["edit"]).allowedEditSurfaces, undefined);
});

// ---------------------------------------------------------------------------
// validateRegistrarToolAdmission
// ---------------------------------------------------------------------------

test("registrar: admits a novel custom tool for a worker actor", () => {
	const caps = resolveActorCapabilities("gentle-ai-worker", ["read", "my_tool"]);
	assert.equal(validateRegistrarToolAdmission("my_tool", caps, ["read"]).admitted, true);
});

test("registrar: rejects duplicate built-in names (read, bash, write) with reason", () => {
	const caps = resolveActorCapabilities("gentle-ai-worker", ["read"]);
	for (const name of ["read", "bash", "write"]) {
		const r = validateRegistrarToolAdmission(name, caps, []);
		assert.equal(r.admitted, false, `expected '${name}' to be rejected`);
		assert.ok(r.reason?.includes(name));
	}
});

test("registrar: rejects prohibited tools for analyst with role in reason", () => {
	const caps = resolveActorCapabilities("gentle-ai-security", []);
	const r = validateRegistrarToolAdmission("edit", caps, []);
	assert.equal(r.admitted, false);
	assert.ok(r.reason?.includes("edit") && r.reason?.includes("analyst"));
	assert.equal(validateRegistrarToolAdmission("bash", caps, []).admitted, false);
});

test("registrar: all BUILTIN_TOOL_NAMES are rejected for re-registration", () => {
	const caps = resolveActorCapabilities("gentle-ai-worker", []);
	for (const name of BUILTIN_TOOL_NAMES) {
		assert.equal(validateRegistrarToolAdmission(name, caps, []).admitted, false, `${name} must be rejected`);
	}
});

// ---------------------------------------------------------------------------
// bindActorSpawnEnv
// ---------------------------------------------------------------------------

test("bindActorSpawnEnv serializes actor identity and capability boundaries into child env", () => {
	const caps = resolveActorCapabilities("gentle-ai-security", []);
	const env = bindActorSpawnEnv(caps, {});
	assert.equal(env["GENTLE_PI_AGENTS_ACTOR"], "gentle-ai-security");
	assert.equal(env["GENTLE_PI_AGENTS_ROLE"], "analyst");
	assert.equal(env["GENTLE_PI_AGENTS_ALLOWED_TOOLS"], "read,grep,find,codegraph");
	assert.equal(env["GENTLE_PI_AGENTS_PROHIBITED_TOOLS"], "edit,write,bash");
});

test("bindActorSpawnEnv preserves telemetry opt-out variables from base env", () => {
	const caps = resolveActorCapabilities("gentle-ai-worker", ["read"]);
	const base = { DO_NOT_TRACK: "1", GENTLE_AI_TELEMETRY: "0", SCARF_NO_ANALYTICS: "1", PATH: "/usr/bin" };
	const env = bindActorSpawnEnv(caps, base);
	assert.equal(env["DO_NOT_TRACK"], "1");
	assert.equal(env["GENTLE_AI_TELEMETRY"], "0");
	assert.equal(env["SCARF_NO_ANALYTICS"], "1");
	assert.equal(env["PATH"], "/usr/bin");
	assert.equal(env["GENTLE_PI_AGENTS_PROHIBITED_TOOLS"], "");
});

// ---------------------------------------------------------------------------
// isPathWithinAllowedSurfaces
// ---------------------------------------------------------------------------

test("isPathWithinAllowedSurfaces: exact match, non-match, empty cases", () => {
	assert.equal(isPathWithinAllowedSurfaces("lib/actor-capabilities.ts", ["lib/actor-capabilities.ts"], "/project"), true);
	assert.equal(isPathWithinAllowedSurfaces("lib/other.ts", ["lib/actor-capabilities.ts"], "/project"), false);
	assert.equal(isPathWithinAllowedSurfaces("", ["lib/*"], "/project"), false);
	assert.equal(isPathWithinAllowedSurfaces("lib/foo.ts", [], "/project"), false);
});

test("isPathWithinAllowedSurfaces: directory traversal is rejected", () => {
	assert.equal(isPathWithinAllowedSurfaces("../outside.ts", ["../outside.ts"], "/project"), false);
	assert.equal(isPathWithinAllowedSurfaces("lib/../../etc/passwd", ["lib/**"], "/project"), false);
});

test("isPathWithinAllowedSurfaces: glob lib/* matches single segment only", () => {
	assert.equal(isPathWithinAllowedSurfaces("lib/core.ts", ["lib/*"], "/project"), true);
	assert.equal(isPathWithinAllowedSurfaces("lib/sub/deep.ts", ["lib/*"], "/project"), false);
});

test("isPathWithinAllowedSurfaces: glob tests/**/*.ts matches flat and nested paths", () => {
	assert.equal(isPathWithinAllowedSurfaces("tests/sec-actor.test.ts", ["tests/**/*.ts"], "/project"), true);
	assert.equal(isPathWithinAllowedSurfaces("tests/sub/nested.test.ts", ["tests/**/*.ts"], "/project"), true);
	assert.equal(isPathWithinAllowedSurfaces("tests/fixture.json", ["tests/**/*.ts"], "/project"), false);
});

// ---------------------------------------------------------------------------
// validateCapturedWritesAtExit
// ---------------------------------------------------------------------------

test("validateCapturedWritesAtExit: all in-scope mutations pass; empty list is valid", () => {
	const mutations = [
		{ path: "lib/actor-capabilities.ts", toolCallId: "tc-1" },
		{ path: "lib/bounded-writer-admission.ts", toolCallId: "tc-2" },
	];
	const r = validateCapturedWritesAtExit(mutations, ["lib/*.ts"], "/project");
	assert.equal(r.valid, true);
	assert.deepEqual(r.outOfScopePaths, []);
	assert.equal(validateCapturedWritesAtExit([], ["lib/*.ts"], "/project").valid, true);
});

test("validateCapturedWritesAtExit: out-of-scope write is rejected; in-scope write is not", () => {
	const mutations = [
		{ path: "lib/actor-capabilities.ts", toolCallId: "tc-1" },
		{ path: "scripts/evil.mjs", toolCallId: "tc-2" },
	];
	const r = validateCapturedWritesAtExit(mutations, ["lib/*.ts"], "/project");
	assert.equal(r.valid, false);
	assert.ok(r.outOfScopePaths.includes("scripts/evil.mjs"));
	assert.ok(!r.outOfScopePaths.includes("lib/actor-capabilities.ts"));
});

test("validateCapturedWritesAtExit: unrelated concurrent mutations not in capturedMutations are not attributed to child", () => {
	// Only child's explicit toolCallId-attributed mutations are validated.
	const childMutations = [{ path: "lib/core.ts", toolCallId: "child-tc-1" }];
	const r = validateCapturedWritesAtExit(childMutations, ["lib/*.ts"], "/project");
	assert.equal(r.valid, true);
	assert.deepEqual(r.outOfScopePaths, []);
});

test("validateCapturedWritesAtExit: multiple out-of-scope paths are all reported", () => {
	const mutations = [
		{ path: "extensions/evil.ts", toolCallId: "tc-1" },
		{ path: "scripts/bad.mjs", toolCallId: "tc-2" },
		{ path: "lib/ok.ts", toolCallId: "tc-3" },
	];
	const r = validateCapturedWritesAtExit(mutations, ["lib/*.ts"], "/project");
	assert.equal(r.valid, false);
	assert.equal(r.outOfScopePaths.length, 2);
	assert.ok(r.outOfScopePaths.includes("extensions/evil.ts") && r.outOfScopePaths.includes("scripts/bad.mjs"));
});
