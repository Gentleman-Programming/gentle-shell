// Maintainer provider-relay matrix — behavior-first tests (gentle-pi#311).
//
// `pnpm test` never picks this up: it globs `tests/*.test.ts` only, and this
// file lives one directory deeper and ends in `.maintest.ts`. It runs only
// via `pnpm run test:maintainer`. Strict validation + no-production-resolution
// always run; real-binary tests run only when env-supplied maintainer binaries
// exist (self-skip; fail-loud under GENTLE_PI_REQUIRE_MAINTAINER=1). Never fakes
// green. Tests never hardcode machine-specific paths; the verifier supplies
// them via env. The baseline is described generically; external evidence
// establishes whether it is the immutable RC8 runtime.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
import { ARM_POSITIVE_ENV, CASE_KINDS, DEFAULT_ROLE_VECTOR_TIMEOUT_MS, DESCRIPTOR_SCHEMA, DescriptorValidationError, POSITIVE_JOURNEY_COMMAND, PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA, PROVIDER_ROLE_VECTOR_KINDS, PROVIDER_ROLE_VECTOR_ROLE, PROVIDER_ROLE_VECTOR_VERB, ProviderRoleVectorError, ROLE_STREAM_MAX_BYTES, ROLE_VECTOR_FAILURE, loadDescriptor, resolveDeclaredExecutable, runMatrix, runProviderRoleVector, validateDescriptor } from "../../scripts/maintainer/provider-relay-matrix.mjs";
const BASELINE_ENV = "GENTLE_PI_MAINTAINER_BASELINE_BINARY";
const CAPABLE_ENV = "GENTLE_PI_MAINTAINER_CAPABLE_BINARY";
const REQUIRE_ENV = "GENTLE_PI_REQUIRE_MAINTAINER";
// Every declared-but-nonexistent executable path these tests use lives inside
// one private sandbox. A predictable /tmp path is squattable: another user can
// pre-create it between runs, and a test that resolves it would then spawn a
// file it never wrote. mkdtemp's unpredictable name plus 0700 removes that.
const SANDBOX = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-sandbox-"));
chmodSync(SANDBOX, 0o700);
process.on("exit", () => rmSync(SANDBOX, { recursive: true, force: true }));
const sandboxPath = (name: string) => join(SANDBOX, name);
const PLACEHOLDER_BINARY = sandboxPath("not-a-real-gentle-ai-binary");
const baselineBinary = process.env[BASELINE_ENV];
const capableBinary = process.env[CAPABLE_ENV];
const armed = process.env[REQUIRE_ENV] === "1";

const BINDING_TOKENS = Object.freeze([
	"--lineage=review-1d5aadacc600e167",
	`--expected-revision=sha256:${"c".repeat(64)}`,
	`--target=sha256:${"d".repeat(64)}`,
	`--repository-context=rctx1_${"e".repeat(64)}`,
	"--lens=review-reliability",
	"--order=0",
	`--subject-hash=sha256:${"a".repeat(64)}`,
]);
const CAPTURE_TOKENS = Object.freeze([...BINDING_TOKENS, "--agent=pi", "--materialize=true"]);
const SUBMISSION = Object.freeze({
	operationToken: "capture-result",
	argumentTokens: Object.freeze([...BINDING_TOKENS, "--input={{value}}"]),
	values: Object.freeze([{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: BINDING_TOKENS.length }]),
});

const ROLE_LINEAGE = "review-fixture-role-vector", ROLE_REVISION = `sha256:${"a".repeat(64)}`;
const ROLE_TARGET = `sha256:${"b".repeat(64)}`;
const ROLE_CONTEXT = `rctx1_${"c".repeat(64)}`;
const ROLE_REQUEST_HASH = `sha256:${"9".repeat(64)}`;
const REFUTER_TOKENS = Object.freeze([`--lineage=${ROLE_LINEAGE}`, `--expected-revision=${ROLE_REVISION}`, `--target=${ROLE_TARGET}`, `--repository-context=${ROLE_CONTEXT}`, "--agent=pi", "--execute=true"]);
const VALIDATOR_TOKENS = Object.freeze([`--lineage=${ROLE_LINEAGE}`, `--expected-revision=${ROLE_REVISION}`, `--target=${ROLE_TARGET}`, `--repository-context=${ROLE_CONTEXT}`, `--request-hash=${ROLE_REQUEST_HASH}`, "--agent=pi", "--execute=true"]);
const VALIDATION_REQUEST = Object.freeze({ schema: "gentle-ai.review-targeted-validation-request/v1", requestHash: ROLE_REQUEST_HASH });
const ROLE_ARTIFACT = Object.freeze({ schema: "gentle-ai.review-provider-role-capture/v1", lineage_id: ROLE_LINEAGE, target_identity: ROLE_TARGET, role: "refuter", captured: true });

const REVIEWER_SELECTION = "test-provider/test-model";
function descriptor(overrides = {}) {
	return {
		schema: DESCRIPTOR_SCHEMA,
		gentleAiExecutable: PLACEHOLDER_BINARY,
		reviewerSelection: REVIEWER_SELECTION,
		cases: [{ name: "baseline-negative-control", kind: "relay-unavailable", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }],
		...overrides,
	};
}
function rejects(obj, fragment) {
	assert.throws(() => validateDescriptor(obj), (error) => error instanceof DescriptorValidationError && error.message.includes(fragment));
}
function tempDescriptor(t, obj) {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "d.json");
	writeFileSync(path, JSON.stringify(obj));
	return path;
}

// ---------------------------------------------------------------------------
// Strict descriptor validation — exact shape, no defaults, no production
// resolution. Pure/deterministic; always runs.
// ---------------------------------------------------------------------------
test("valid descriptor validates and returns a normalized copy", () => {
	const d = validateDescriptor(descriptor());
	assert.equal(d.schema, DESCRIPTOR_SCHEMA);
	assert.deepEqual(d.cases[0]!.captureArgumentTokens, [...CAPTURE_TOKENS]);
	assert.deepEqual(d.cases[0]!.submission.values, SUBMISSION.values);
});
test("rejects malformed descriptor fields with exact-shape errors (no defaults, no production resolution)", () => {
	rejects({ ...descriptor(), schema: "gentle-pi.maintainer.provider-relay-descriptor/v2" }, "descriptor.schema must be exactly");
	rejects({ ...descriptor(), gentleAiExecutable: "gentle-ai" }, "absolute path");
	rejects({ ...descriptor(), gentleAiExecutable: undefined }, "absolute path");
	rejects({ ...descriptor(), extra: 1 }, "descriptor.extra");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, extra: 1 }] }, "extra");
	assert.deepEqual([...CASE_KINDS], ["relay-unavailable", "positive-lens", ...PROVIDER_ROLE_VECTOR_KINDS]);
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, kind: "bogus" }] }, "kind must be one of");
	const dup = { ...descriptor().cases[0]!, name: "dup" };
	rejects({ ...descriptor(), cases: [structuredClone(dup), structuredClone(dup)] }, "duplicated");
	// Every case must declare the real provider-issued materialize slot.
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, captureArgumentTokens: [...CAPTURE_TOKENS].filter((t) => t !== "--agent=pi") }] }, "--agent=pi");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, captureArgumentTokens: [...CAPTURE_TOKENS].filter((t) => t !== "--materialize=true") }] }, "--materialize=true");
});
test("submission is validated through the real relay resolver before any process launches (exact shape)", () => {
	const twoValues = structuredClone(SUBMISSION);
	twoValues.values = [...SUBMISSION.values, { slot: "extra", domain: "artifact_path_or_stdin", substitutionLocation: 0 }];
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: twoValues }] }, "not a bindable provider form");
	const noSlot = structuredClone(SUBMISSION);
	noSlot.argumentTokens = [...BINDING_TOKENS, "--input=/no/value/slot"];
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: noSlot }] }, "not a bindable provider form");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: { ...structuredClone(SUBMISSION), extra: 1 } }] }, "extra");
});
test("loadDescriptor reads and validates a descriptor file", (t) => {
	const path = tempDescriptor(t, descriptor());
	assert.equal(loadDescriptor(path).schema, DESCRIPTOR_SCHEMA);
	assert.throws(() => loadDescriptor(join(dirname(path), "missing.json")), /could not read descriptor/);
	writeFileSync(join(dirname(path), "bad.json"), "{not json");
	assert.throws(() => loadDescriptor(join(dirname(path), "bad.json")), /not valid JSON/);
});

function roleDescriptor(kind: "provider-role-refuter" | "provider-role-validator", overrides: Record<string, unknown> = {}) {
	const tokens = kind === "provider-role-refuter" ? REFUTER_TOKENS : VALIDATOR_TOKENS;
	const entry: Record<string, unknown> = { name: `${kind}-case`, kind, argumentTokens: [...tokens] };
	if (kind === "provider-role-validator") entry.validationRequest = structuredClone(VALIDATION_REQUEST);
	return { schema: DESCRIPTOR_SCHEMA, gentleAiExecutable: PLACEHOLDER_BINARY, reviewerSelection: REVIEWER_SELECTION, cases: [entry], ...overrides };
}
const ROLE_STUB_BINARY = sandboxPath("gentle-ai-role-stub");
writeFileSync(ROLE_STUB_BINARY, "stub");
test("role vector descriptors validate and return a normalized copy with exact provider tokens", () => {
	assert.deepEqual([...PROVIDER_ROLE_VECTOR_KINDS], ["provider-role-refuter", "provider-role-validator"]);
	assert.deepEqual(PROVIDER_ROLE_VECTOR_VERB, { "provider-role-refuter": "capture-refuter", "provider-role-validator": "capture-validation" });
	assert.deepEqual(PROVIDER_ROLE_VECTOR_ROLE, { "provider-role-refuter": "refuter", "provider-role-validator": "targeted-validator" });
	const refuter = validateDescriptor(roleDescriptor("provider-role-refuter")).cases[0]!;
	assert.equal(refuter.kind, "provider-role-refuter");
	assert.deepEqual(refuter.argumentTokens, [...REFUTER_TOKENS]);
	assert.equal("validationRequest" in refuter, false);
	assert.equal("captureArgumentTokens" in refuter, false);
	assert.equal("submission" in refuter, false);
	const validator = validateDescriptor(roleDescriptor("provider-role-validator")).cases[0]!;
	assert.deepEqual(validator.argumentTokens, [...VALIDATOR_TOKENS]);
	assert.deepEqual(validator.validationRequest, VALIDATION_REQUEST);
});
test("role vector descriptors require exactly one --agent=pi and --execute=true, never a lens slot", () => {
	for (const [name, argumentTokens, expected] of [
		["missing agent", REFUTER_TOKENS.filter((t) => t !== "--agent=pi"), "--agent=pi"], ["duplicate agent", [...REFUTER_TOKENS, "--agent=pi"], "--agent=pi"],
		["conflicting agent", [...REFUTER_TOKENS, "--agent=other"], "--agent=pi"], ["missing execute", REFUTER_TOKENS.filter((t) => t !== "--execute=true"), "--execute=true"],
		["duplicate execute", [...REFUTER_TOKENS, "--execute=true"], "--execute=true"], ["conflicting execute", [...REFUTER_TOKENS, "--execute=false"], "--execute=true"],
	] as const) {
		rejects(roleDescriptor("provider-role-refuter", { cases: [{ name, kind: "provider-role-refuter", argumentTokens: [...argumentTokens] }] }), expected);
	}
	rejects(roleDescriptor("provider-role-refuter", { cases: [{ name: "r", kind: "provider-role-refuter", argumentTokens: [...REFUTER_TOKENS, "--materialize=true"] }] }), "--materialize=true");
});
test("targeted-validator descriptor requires exactly one request hash matching validationRequest", () => {
	const mismatched = { ...structuredClone(VALIDATION_REQUEST), requestHash: `sha256:${"0".repeat(64)}` };
	rejects(roleDescriptor("provider-role-validator", { cases: [{ name: "v", kind: "provider-role-validator", argumentTokens: [...VALIDATOR_TOKENS], validationRequest: mismatched }] }), "must include exactly one");
	rejects(roleDescriptor("provider-role-validator", { cases: [{ name: "v", kind: "provider-role-validator", argumentTokens: [...VALIDATOR_TOKENS, `--request-hash=${ROLE_REQUEST_HASH}`], validationRequest: structuredClone(VALIDATION_REQUEST) }] }), "must include exactly one");
	rejects(roleDescriptor("provider-role-validator", { cases: [{ name: "v", kind: "provider-role-validator", argumentTokens: [...VALIDATOR_TOKENS] }] }), "validationRequest");
	rejects(roleDescriptor("provider-role-refuter", { cases: [{ name: "r", kind: "provider-role-refuter", argumentTokens: [...REFUTER_TOKENS], validationRequest: structuredClone(VALIDATION_REQUEST) }] }), "validationRequest");
	const badHash = { ...structuredClone(VALIDATION_REQUEST), requestHash: "not-a-sha256" };
	rejects(roleDescriptor("provider-role-validator", { cases: [{ name: "v", kind: "provider-role-validator", argumentTokens: [...VALIDATOR_TOKENS], validationRequest: badHash }] }), "sha256");
});

test("refuter vector: runMatrix executes exactly once through review.capture-refuter with exact provider tokens and returns the typed artifact", async () => {
	const calls: Array<{ kind: string; argumentTokens: readonly string[]; gentleAiExecutable: string; validationRequest?: unknown }> = [];
	const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), {
		armPositive: true,
		roleRunner: async (request) => {
			calls.push({ kind: request.kind, argumentTokens: request.argumentTokens, gentleAiExecutable: request.gentleAiExecutable, ...(request.validationRequest === undefined ? {} : { validationRequest: request.validationRequest }) });
			return { schema: PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA, lineageId: ROLE_LINEAGE, targetIdentity: ROLE_TARGET, role: "refuter", captured: true };
		},
	});
	assert.equal(calls.length, 1, "the refuter vector must execute exactly once");
	assert.equal(calls[0]!.kind, "provider-role-refuter");
	assert.equal("validationRequest" in calls[0]!, false, "the refuter vector must not carry a validation_request");
	assert.deepEqual(calls[0]!.argumentTokens, [...REFUTER_TOKENS]);
	assert.ok(calls[0]!.argumentTokens.includes("--execute=true"));
	assert.ok(!calls[0]!.argumentTokens.includes("--materialize=true"));
	assert.equal(calls[0]!.gentleAiExecutable, ROLE_STUB_BINARY);
	assert.equal(verdict!.verdict, "pass");
	assert.equal(verdict!.role, "refuter");
	assert.equal(verdict!.captured, true);
	assert.equal(verdict!.lineageId, ROLE_LINEAGE);
	assert.equal(verdict!.targetIdentity, ROLE_TARGET);
});
test("validator vector: runMatrix executes exactly once through review.capture-validation and preserves the request-hash binding", async () => {
	const calls: Array<{ kind: string; argumentTokens: readonly string[]; validationRequest?: unknown }> = [];
	const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-validator"), gentleAiExecutable: ROLE_STUB_BINARY }), {
		armPositive: true,
		roleRunner: async (request) => {
			calls.push({ kind: request.kind, argumentTokens: request.argumentTokens, ...(request.validationRequest === undefined ? {} : { validationRequest: request.validationRequest }) });
			return { schema: PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA, lineageId: ROLE_LINEAGE, targetIdentity: ROLE_TARGET, role: "targeted-validator", captured: true };
		},
	});
	assert.equal(calls.length, 1, "the validator vector must execute exactly once");
	assert.equal(calls[0]!.kind, "provider-role-validator");
	assert.deepEqual(calls[0]!.argumentTokens, [...VALIDATOR_TOKENS]);
	assert.ok(calls[0]!.argumentTokens.includes(`--request-hash=${ROLE_REQUEST_HASH}`));
	assert.deepEqual(calls[0]!.validationRequest, VALIDATION_REQUEST);
	assert.equal(verdict!.verdict, "pass");
	assert.equal(verdict!.role, "targeted-validator");
	assert.equal(verdict!.captured, true);
});
test("an unarmed role vector blocks loudly and never fakes green (no model launch)", async () => {
	const calls: unknown[] = [];
	const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), {
		roleRunner: async () => { calls.push("ran"); return ROLE_ARTIFACT; },
	});
	assert.equal(calls.length, 0, "an unarmed role vector must never reach the runner");
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, new RegExp(ARM_POSITIVE_ENV));
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
});
test("handshake refusal reports relay-contract negotiation, distinct from a missing role surface", async () => {
	for (const [kind, message] of [[ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED, "relay handshake refused"], [ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE, "missing role surface"]] as const) {
		const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), { armPositive: true, roleRunner: async () => { throw new ProviderRoleVectorError(kind, "execute", message); } });
		assert.equal(verdict!.verdict, "blocked"); assert.match(verdict!.reason, kind === ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED ? /relay-contract negotiation/ : /provider role capture surface/);
	}
});
test("negative control: an unsupported role surface fails closed with zero role invocation and no mutation", async () => {
	const calls: unknown[] = [];
	const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), {
		armPositive: true,
		roleRunner: async (request) => {
			calls.push(request);
			throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE, "execute", "the declared gentle-ai binary lacks the provider role capture surface");
		},
	});
	assert.equal(calls.length, 1, "the runner was probed exactly once to detect the missing surface");
	assert.equal(verdict!.verdict, "blocked");
	assert.equal(verdict!.mutationOutcome, "none");
	assert.match(verdict!.reason, /provider role capture surface/);
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
	assert.notEqual(verdict!.verdict, "pass");
	assert.notEqual(verdict!.verdict, "fail");
});
test("negative control: a role vector failure (not surface-unavailable) is reported as fail, never pass", async () => {
	const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), {
		armPositive: true,
		roleRunner: async () => {
			throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", "gentle-ai role vector failed");
		},
	});
	assert.equal(verdict!.verdict, "fail");
	assert.match(verdict!.reason, /role-failed/);
});
test("runProviderRoleVector treats a prelaunch abort as not-started with no mutation", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: process.execPath, signal: controller.signal }), (error) => error instanceof ProviderRoleVectorError && error.kind === ROLE_VECTOR_FAILURE.ROLE_ABORTED && error.stage === "launch" && error.mutationOutcome === "none");
});
function roleChild(t: test.TestContext, name: string, source: string) {
	const path = sandboxPath(`${name} preload.cjs`), savedNodeOptions = process.env.NODE_OPTIONS; writeFileSync(path, `const roleArgv = ["review", ...process.argv.slice(2)], Module = require("node:module"), resolveFilename = Module._resolveFilename; Module._resolveFilename = function (request, ...args) { return /[\\\\/]review$/.test(request) ? ${JSON.stringify(path)} : resolveFilename.call(this, request, ...args); }; ${source}`);
	t.after(() => { if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedNodeOptions; rmSync(path, { force: true }); }); return { executable: process.execPath, env: { NODE_OPTIONS: `--require=${JSON.stringify(path)}` } };
}
test("runProviderRoleVector executes both real stub-child verbs and decodes snake_case artifacts", async (t) => {
	for (const kind of PROVIDER_ROLE_VECTOR_KINDS) {
		const log = sandboxPath(`${kind}.json`), child = roleChild(t, `${kind}.cjs`, `const fs = require("node:fs"), refuter = roleArgv[1] === "capture-refuter"; fs.writeFileSync(${JSON.stringify(sandboxPath("ROLE_LOG_PLACEHOLDER"))}.replace("ROLE_LOG_PLACEHOLDER", ${JSON.stringify(`${kind}.json`)}), JSON.stringify(roleArgv)); process.stdout.write(JSON.stringify({ schema: ${JSON.stringify(PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA)}, lineage_id: ${JSON.stringify(ROLE_LINEAGE)}, target_identity: ${JSON.stringify(ROLE_TARGET)}, role: refuter ? "refuter" : "targeted-validator", captured: true })); process.exit(0);`);
		const artifact = await runProviderRoleVector({ kind, argumentTokens: kind === "provider-role-refuter" ? REFUTER_TOKENS : VALIDATOR_TOKENS, gentleAiExecutable: child.executable, env: child.env });
		assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["review", PROVIDER_ROLE_VECTOR_VERB[kind], ...(kind === "provider-role-refuter" ? REFUTER_TOKENS : VALIDATOR_TOKENS)]);
		assert.deepEqual(artifact, { schema: PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA, lineageId: ROLE_LINEAGE, targetIdentity: ROLE_TARGET, role: PROVIDER_ROLE_VECTOR_ROLE[kind], captured: true });
	}
});
test("runProviderRoleVector rejects malformed artifact binding shape before stale binding comparison", async (t) => {
	for (const malformed of [{ lineage_id: "", target_identity: ROLE_TARGET }, { lineage_id: ROLE_LINEAGE, target_identity: "not-a-sha256" }]) {
		const child = roleChild(t, `malformed-${malformed.lineage_id || "lineage"}.cjs`, `process.stdout.write(JSON.stringify({ schema: ${JSON.stringify(PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA)}, role: "refuter", captured: true, ...${JSON.stringify(malformed)} })); process.exit(0);`);
		await assert.rejects(runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: child.executable, env: child.env }), (error) => error instanceof ProviderRoleVectorError && error.kind === ROLE_VECTOR_FAILURE.ROLE_FAILED && /typed shape/.test(error.message));
	}
});
test("runProviderRoleVector classifies an empty successful artifact as unknown and requires STATUS re-query", async (t) => {
	const child = roleChild(t, "empty-artifact.cjs", "process.exit(0);");
	await assert.rejects(runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: child.executable, env: child.env }), (caught) => {
		assert.ok(caught instanceof ProviderRoleVectorError); assert.equal(caught.kind, ROLE_VECTOR_FAILURE.EMPTY_ARTIFACT); assert.equal(caught.stage, "execute"); assert.equal(caught.mutationOutcome, "unknown"); assert.match(caught.message, /re-query negotiated STATUS before any retry/); return true;
	});
});
test("runProviderRoleVector bounds each output stream before JSON or exit handling", async (t) => {
	for (const stream of ["stdout", "stderr"] as const) {
		const child = roleChild(t, `overflow-${stream}.cjs`, `process.${stream}.write("x".repeat(${ROLE_STREAM_MAX_BYTES + 1})); setInterval(() => {}, 1_000);`);
		await assert.rejects(runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: child.executable, env: child.env, timeoutMs: 1_000 }), (error) => error instanceof ProviderRoleVectorError && error.kind === ROLE_VECTOR_FAILURE.ROLE_OUTPUT_OVERFLOW && error.mutationOutcome === "unknown");
	}
});
async function descendantPid(path: string) {
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) { if (existsSync(path)) { const pid = Number(readFileSync(path, "utf8")); if (pid > 0) return pid; } await new Promise((resolve) => setTimeout(resolve, 10)); }
	assert.fail("fixture did not report a positive descendant PID");
}
async function assertReaped(pid: number) {
	assert.ok(pid > 0, "only a positive descendant PID may be probed"); for (let attempt = 0; attempt < 50; attempt += 1) try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
	assert.fail("role termination left a deterministic child-process descendant running");
}
test("role watchdog and abort reap descendants on every platform", async (t) => {
	for (const mode of ["watchdog", "abort"] as const) await t.test(mode, async (t) => {
		const grandchild = sandboxPath(`role-grandchild-${mode}.pid`), child = roleChild(t, `hang-role-child-${mode}.cjs`, `const fs = require("node:fs"), { spawn } = require("node:child_process"), grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "" } }); fs.writeFileSync(${JSON.stringify(sandboxPath("ROLE_PID_PLACEHOLDER"))}.replace("ROLE_PID_PLACEHOLDER", ${JSON.stringify(`role-grandchild-${mode}.pid`)}), String(grandchild.pid)); setInterval(() => {}, 1000);`), controller = new AbortController();
		const run = runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: child.executable, env: child.env, timeoutMs: 1_000, signal: controller.signal }), pid = await descendantPid(grandchild);
		t.after(() => { if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
		assert.ok(DEFAULT_ROLE_VECTOR_TIMEOUT_MS > 600_000, "the outer 900s watchdog FIRES after the provider-owned 600s deadline with setup/cancellation margin");
		if (mode === "abort") controller.abort();
		await assert.rejects(run, (error) => error instanceof ProviderRoleVectorError && error.kind === (mode === "abort" ? ROLE_VECTOR_FAILURE.ROLE_ABORTED : ROLE_VECTOR_FAILURE.ROLE_TIMED_OUT) && error.mutationOutcome === "unknown");
		await assertReaped(pid);
	});
});
test("failed tree termination settles despite a surviving descendant retaining inherited pipes", async (t) => {
	const grandchild = sandboxPath("role-pipe-holder.pid"), controller = new AbortController();
	const child = roleChild(t, "pipe-holder-role-child.cjs", `const fs = require("node:fs"), { spawn } = require("node:child_process"), grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "" } }); fs.writeFileSync(${JSON.stringify(sandboxPath("ROLE_PID_PLACEHOLDER"))}.replace("ROLE_PID_PLACEHOLDER", ${JSON.stringify("role-pipe-holder.pid")}), String(grandchild.pid)); setInterval(() => {}, 1000);`);
	const run = runProviderRoleVector({ kind: "provider-role-refuter", argumentTokens: REFUTER_TOKENS, gentleAiExecutable: child.executable, env: child.env, signal: controller.signal, terminateProcessTree: (process) => { process.kill("SIGKILL"); return false; } });
	const pid = await descendantPid(grandchild); t.after(() => { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } });
	const started = Date.now(); controller.abort(); await assert.rejects(run, (error) => error instanceof ProviderRoleVectorError && error.kind === ROLE_VECTOR_FAILURE.ROLE_TERMINATION_FAILED && error.stage === "execute" && error.mutationOutcome === "unknown");
	assert.ok(Date.now() - started < 500, "failed tree termination must not wait for descendant-held pipes to close"); assert.doesNotThrow(() => process.kill(pid, 0), "the fixture descendant must survive while retaining inherited pipes");
});
test("stale-target fail-closed: missing or duplicate required binding tokens are rejected before runner invocation", () => {
	const drop = (tokens: readonly string[], prefix: string) => tokens.filter((t) => !t.startsWith(prefix));
	for (const prefix of ["--lineage=", "--target=", "--expected-revision=", "--repository-context="]) {
		rejects(roleDescriptor("provider-role-refuter", { cases: [{ name: "r", kind: "provider-role-refuter", argumentTokens: drop(REFUTER_TOKENS, prefix) }] }), `exactly one "${prefix}`);
	}
	rejects(roleDescriptor("provider-role-refuter", { cases: [{ name: "r", kind: "provider-role-refuter", argumentTokens: [...REFUTER_TOKENS, `--lineage=${ROLE_LINEAGE}`] }] }), "exactly one \"--lineage=\"");
	const badTarget = REFUTER_TOKENS.map((t) => t.startsWith("--target=") ? "--target=not-a-sha256" : t);
	rejects(roleDescriptor("provider-role-refuter", { cases: [{ name: "r", kind: "provider-role-refuter", argumentTokens: badTarget }] }), "malformed");
});
test("stale-target fail-closed: a returned artifact with mismatched lineage or target fails, never passes", async () => {
	const stale = `sha256:${"f".repeat(64)}`;
	for (const [lineageId, targetIdentity] of [[stale, ROLE_TARGET], [ROLE_LINEAGE, stale]] as const) {
		const [verdict] = await runMatrix(validateDescriptor({ ...roleDescriptor("provider-role-refuter"), gentleAiExecutable: ROLE_STUB_BINARY }), {
			armPositive: true,
			roleRunner: async () => ({ schema: PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA, lineageId, targetIdentity, role: "refuter", captured: true }),
		});
		assert.equal(verdict!.verdict, "fail");
		assert.match(verdict!.reason, /stale artifact/);
	}
});

// ---------------------------------------------------------------------------
// No-production-resolution — the runner uses only declared executables and
// never falls through to the package-local production binary.
// ---------------------------------------------------------------------------
test("runMatrix uses only the declared executable, never the production resolver", async () => {
	const [verdict] = await runMatrix(validateDescriptor({ ...descriptor(), gentleAiExecutable: sandboxPath("not-a-gentle-ai-binary") }));
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, /gentleAiExecutable/);
	assert.notEqual(verdict!.verdict, "pass");
});
test("resolveDeclaredExecutable checks absolute paths verbatim and bare names on PATH only", () => {
	assert.equal(resolveDeclaredExecutable(sandboxPath("nonexistent-absolute-123")), null);
	assert.equal(resolveDeclaredExecutable(""), null);
});

// ---------------------------------------------------------------------------
// Mis-declared capable binary — a `relay-unavailable` case is a negative
// control, so the arm gate must not trust the maintainer-declared `kind`. A
// declaration-only gate pointed at a CAPABLE binary would materialize, launch
// a REAL pi model, and run a REAL `capture-result --input=...` submission
// before reporting `fail`: the mutation would already have happened. Driven by
// local stub executables (the repo's fake-executable idiom), so it is
// deterministic and needs no arming.
// ---------------------------------------------------------------------------
function capableStubHarness(t: test.TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-capable-stub-"));
	chmodSync(directory, 0o700);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const materializeLog = join(directory, "materialized");
	const submitLog = join(directory, "submitted");
	const gentleAi = join(directory, "gentle-ai");
	// Deliberately CAPABLE: it honours --materialize=true and would accept a
	// submission, exactly like a binary a maintainer mis-declared as incapable.
	writeFileSync(
		gentleAi,
		`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--materialize=true")) {
	fs.writeFileSync(${JSON.stringify(materializeLog)}, JSON.stringify(argv));
	process.stdout.write("prompt-bytes");
	process.exit(0);
}
fs.writeFileSync(${JSON.stringify(submitLog)}, JSON.stringify(argv));
process.stdout.write(JSON.stringify({ schema: "gentle-ai.review-result-artifact/v2", admission_decision: "completed" }));
process.exit(0);
`,
	);
	chmodSync(gentleAi, 0o755);
	return { gentleAi, materializeLog, submitLog };
}
// gentle-pi#311 P4: lens captures no longer spawn a pi child, so the
// mis-declared-capable negative control no longer needs an "unlaunchable pi"
// fixture -- it must instead fail closed at the reviewer-registry stage
// (`unresolvableReviewerRegistry`, provider-relay-matrix.mjs), before any
// completion or submission.
test("a relay-unavailable case against a CAPABLE binary fails closed at the reviewer stage: zero completion, zero submission", async (t) => {
	const stub = capableStubHarness(t);
	const [verdict] = await runMatrix(validateDescriptor({ ...descriptor(), gentleAiExecutable: stub.gentleAi }));
	// The declared binary really is capable, so the negative control cannot
	// pass — but it must fail WITHOUT mutating anything.
	assert.equal(verdict!.verdict, "fail");
	assert.match(verdict!.reason, /kind=reviewer-model-not-found stage=pi mutationOutcome=none/);
	// The load-bearing assertion: the real submission never fired.
	assert.equal(existsSync(stub.submitLog), false, "a relay-unavailable case must never reach submit");
	// Materialize still happens: it is the honest capability probe, and it is
	// read-only (mutationOutcome stays "none" before submit).
	assert.equal(existsSync(stub.materializeLog), true);
});
// ---------------------------------------------------------------------------
// gentle-pi#311 P4: the two "resolve-once" tests this section held (a POSIX
// subprocess proof and a platform-neutral boundary proof) verified that a
// bare `pi` PATH declaration was resolved exactly once and never re-resolved
// between precheck and launch (issue #324). Lens captures now run in-process
// through an injected reviewer registry — there is no executable to resolve
// or re-resolve, so that TOCTOU class no longer exists for this transport and
// the coverage was removed rather than kept as dead assertions. The armed
// positive-lens journey's new wiring (the in-process reviewer registry built
// from `descriptor.reviewerSelection`) is covered below instead.
// ---------------------------------------------------------------------------
test("armed positive-lens: runMatrix completes end-to-end through the in-process reviewer registry against a stub gentle-ai binary", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-armed-positive-"));
	chmodSync(directory, 0o700);
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const materializeLog = join(directory, "materialized");
	const submitLog = join(directory, "submitted");
	const gentleAi = join(directory, "gentle-ai");
	// A capable gentle-ai: materialize returns a frozen prompt carrying the
	// real GENTLE_AI_REVIEW_BINDING and GENTLE_AI_REVIEW_CONTEXT lines
	// (exactly what Go embeds in production) so the armed in-process reviewer
	// can echo the subject_hash and the changed-path manifest the submission
	// expects. Submit does NOT accept unconditionally: it reads the --input
	// payload and refuses any result missing a field Go admission requires
	// (subject_hash, inspection.status, inspection.paths, findings,
	// evidence), so a faux reviewer that drifts from the reviewer contract
	// fails here instead of only against the real binary.
	const subjectHash = `sha256:${"a".repeat(64)}`;
	const manifestPaths = ["lib/review-host-relay.ts", "docs/review-integration.md"];
	const bindingLine = `GENTLE_AI_REVIEW_BINDING {"subject_hash":"${subjectHash}"}`;
	const contextLine = `GENTLE_AI_REVIEW_CONTEXT ${JSON.stringify({ changed_path_manifest: manifestPaths.map((path) => ({ path, status: "modified" })) })}`;
	writeFileSync(
		gentleAi,
		`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--materialize=true")) {
	fs.writeFileSync(${JSON.stringify(materializeLog)}, JSON.stringify(argv));
	process.stdout.write(${JSON.stringify(`${bindingLine}\n${contextLine}\nreview this diff\n`)});
	process.exit(0);
}
const inputToken = argv.find((token) => token.startsWith("--input="));
const payload = JSON.parse(fs.readFileSync(inputToken.slice("--input=".length), "utf8"));
fs.writeFileSync(${JSON.stringify(submitLog)}, JSON.stringify({ argv, payload }));
const missing = [];
if (payload.subject_hash !== ${JSON.stringify(subjectHash)}) missing.push("subject_hash");
if (payload.inspection?.status !== "completed") missing.push("inspection.status");
if (!Array.isArray(payload.inspection?.paths) || payload.inspection.paths.length === 0) missing.push("inspection.paths");
if (!Array.isArray(payload.findings)) missing.push("findings");
if (!Array.isArray(payload.evidence)) missing.push("evidence");
if (missing.length > 0) {
	process.stderr.write("reviewer result is missing required fields: " + missing.join(", "));
	process.exit(1);
}
process.stdout.write(JSON.stringify({ schema: "gentle-ai.review-result-artifact/v2", admission_decision: "completed" }));
process.exit(0);
`,
	);
	chmodSync(gentleAi, 0o755);
	const [verdict] = await runMatrix(validateDescriptor({
		...descriptor(),
		gentleAiExecutable: gentleAi,
		cases: [{ name: "armed-positive-lens", kind: "positive-lens", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }],
	}), { armPositive: true });
	assert.equal(verdict!.verdict, "pass", JSON.stringify(verdict));
	assert.ok(verdict!.promptByteLength! > 0);
	assert.ok(verdict!.resultByteLength! > 0);
	assert.equal(existsSync(materializeLog), true);
	assert.equal(existsSync(submitLog), true, "an armed, successful positive-lens case must reach submit");
	// The submitted payload must carry every field Go admission requires and
	// inspect exactly the frozen manifest, so the faux reviewer can never
	// drift from the reviewer contract unnoticed.
	const submitted = JSON.parse(readFileSync(submitLog, "utf8")) as { payload: Record<string, unknown> };
	assert.equal(submitted.payload["subject_hash"], subjectHash);
	assert.deepEqual(submitted.payload["inspection"], { status: "completed", paths: manifestPaths });
	assert.deepEqual(submitted.payload["findings"], []);
	assert.ok(Array.isArray(submitted.payload["evidence"]) && (submitted.payload["evidence"] as unknown[]).length > 0);
});
test("armed positive-lens: a malformed reviewerSelection blocks with a clear reason, never a synthesized model", async (t) => {
	const stub = capableStubHarness(t);
	const [verdict] = await runMatrix(validateDescriptor({
		...descriptor({ reviewerSelection: "not-a-provider-slash-id" }),
		gentleAiExecutable: stub.gentleAi,
		cases: [{ name: "malformed-reviewer-selection", kind: "positive-lens", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }],
	}), { armPositive: true });
	assert.equal(verdict!.verdict, "fail");
	assert.match(verdict!.reason, /reviewerSelection/);
	assert.equal(existsSync(stub.submitLog), false, "a malformed reviewer selection must never reach submit");
});

// ---------------------------------------------------------------------------
// Negative control — a baseline runtime without --materialize fails closed as
// relay-unavailable with zero Pi launch and zero submission. The baseline is
// env-supplied (GENTLE_PI_MAINTAINER_BASELINE_BINARY); external evidence
// establishes whether it is the immutable RC8 runtime. Self-skip / fail-loud.
// ---------------------------------------------------------------------------
const baselineArmed = typeof baselineBinary === "string" && baselineBinary.length > 0 && baselineBinary.startsWith("/") && existsSync(baselineBinary);
const baselineReason = () => `${BASELINE_ENV} is unset or not an existing absolute path; supply the baseline gentle-ai binary (external evidence establishes whether it is RC8), or set ${REQUIRE_ENV}=1 to fail instead of skip.`;
if (!baselineArmed && armed) throw new Error(baselineReason());
if (!baselineArmed) console.log(`tests/maintainer/provider-relay.maintest.ts: ${baselineReason()}`);
function baselineDescriptor(kind = "relay-unavailable" as const) {
	return validateDescriptor({ ...descriptor(), gentleAiExecutable: baselineBinary, cases: [{ name: "baseline-negative-control", kind, captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }] });
}
test("negative control: runMatrix proves the baseline fails closed as relay-unavailable with zero mutation", { skip: !baselineArmed }, async () => {
	const [verdict] = await runMatrix(baselineDescriptor());
	assert.equal(verdict!.kind, "relay-unavailable");
	assert.equal(verdict!.verdict, "pass");
	assert.equal(verdict!.stage, "materialize");
	assert.equal(verdict!.mutationOutcome, "none");
	assert.equal(verdict!.reason, REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE);
});
test("negative control: the real relay returns a typed relay-unavailable error before Pi launches", { skip: !baselineArmed }, async () => {
	// The baseline lacks --materialize, so it fails at materialize before any
	// pi launch; RELAY_UNAVAILABLE at materialize proves Pi never launched.
	let caught: unknown;
	try {
		await runReviewHostRelaySlot({ captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION), gentleAiExecutable: baselineBinary! });
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof ReviewHostRelayError);
	const e = caught as ReviewHostRelayError;
	assert.equal(e.kind, REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE);
	assert.equal(e.stage, "materialize");
	assert.equal(e.mutationOutcome, "none");
	assert.match(e.stderr, /flag provided but not defined: -(?:materialize|agent)/);
});
test("negative control: an armed positive-lens against the baseline blocks because it lacks the surface", { skip: !baselineArmed }, async () => {
	const [verdict] = await runMatrix(baselineDescriptor("positive-lens"), { armPositive: true });
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, /lacks the pi host relay surface/);
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
});
// ---------------------------------------------------------------------------
// Honest positive arming/skip — the organic journey needs a real capable
// binary and a real review session (lifecycle machinery beyond this work
// unit); the reviewer leg itself runs through the in-process registry built
// from `descriptor.reviewerSelection` (gentle-pi#311 P4), never a real pi
// child. The runner blocks the positive leg before materialize unless armed.
// These tests run WITHOUT the arm (the verifier arms it).
// ---------------------------------------------------------------------------
const capableArmed = typeof capableBinary === "string" && capableBinary.length > 0 && capableBinary.startsWith("/") && existsSync(capableBinary);
const capableReason = () => `${CAPABLE_ENV} is unset or not an existing absolute path; supply a capable gentle-ai binary (local build of origin/main with the pi host-relay surface), or set ${REQUIRE_ENV}=1 to fail instead of skip.`;
if (!capableArmed && armed) throw new Error(capableReason());
if (!capableArmed) console.log(`tests/maintainer/provider-relay.maintest.ts: ${capableReason()}`);
function positiveDescriptor(gentleAi = capableBinary) {
	return validateDescriptor({ ...descriptor(), gentleAiExecutable: gentleAi!, cases: [{ name: "positive-lens-relay", kind: "positive-lens", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }] });
}
test("positive arming/skip: an unarmed positive leg blocks loudly and never fakes green", { skip: !capableArmed }, async () => {
	const [verdict] = await runMatrix(positiveDescriptor());
	assert.equal(verdict!.kind, "positive-lens");
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, new RegExp(ARM_POSITIVE_ENV));
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
	assert.notEqual(verdict!.verdict, "pass");
	assert.notEqual(verdict!.verdict, "fail");
});
test("positive arming/skip: the exact next evidence command is surfaced for the separate verifier", { skip: !capableArmed }, async () => {
	const [verdict] = await runMatrix(positiveDescriptor());
	assert.match(verdict!.command!, /node --experimental-strip-types scripts\/maintainer\/provider-relay-matrix.mjs --descriptor/);
	assert.match(verdict!.command!, /GENTLE_PI_MAINTAINER_ARM_POSITIVE=1/);
});
