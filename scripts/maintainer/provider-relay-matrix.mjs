#!/usr/bin/env node
// Maintainer provider-relay matrix (gentle-pi#311, first direct work unit).
//
// Read-only maintainer harness driving the REAL Pi host relay
// (lib/review-host-relay.ts#runReviewHostRelaySlot) through explicit
// maintainer runtime descriptors. Validates an EXACT descriptor shape, uses
// ONLY declared executables (never re-resolves the production binary), and
// emits one machine-readable NDJSON verdict per case. Not a production path:
// `pnpm test` never imports it; `pnpm run test:maintainer` runs the tests;
// the CLI is the entry point the separate verifier uses for the real organic
// positive journey after a user-visible forecast.
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError, classifyReviewHostRelayRefusal, resolveReviewHostRelaySubmission, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../../lib/review-relay-contract.ts";
export const DESCRIPTOR_SCHEMA = "gentle-pi.maintainer.provider-relay-descriptor/v1";
export const PROVIDER_ROLE_VECTOR_KINDS = Object.freeze(["provider-role-refuter", "provider-role-validator"]);
export const CASE_KINDS = Object.freeze(["relay-unavailable", "positive-lens", ...PROVIDER_ROLE_VECTOR_KINDS]);
export const PROVIDER_ROLE_VECTOR_VERB = Object.freeze({ "provider-role-refuter": "capture-refuter", "provider-role-validator": "capture-validation" });
export const PROVIDER_ROLE_VECTOR_ROLE = Object.freeze({ "provider-role-refuter": "refuter", "provider-role-validator": "targeted-validator" });
export const PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA = "gentle-ai.review-provider-role-capture/v1";
export const ROLE_STREAM_MAX_BYTES = 1024 * 1024;
export const ROLE_VECTOR_FAILURE = Object.freeze({
	ROLE_SURFACE_UNAVAILABLE: "role-surface-unavailable",
	ROLE_LAUNCH_FAILED: "role-launch-failed",
	ROLE_FAILED: "role-failed",
	ROLE_TIMED_OUT: "role-timed-out",
	ROLE_OUTPUT_OVERFLOW: "role-output-overflow",
	ROLE_TERMINATION_FAILED: "role-termination-failed",
	ROLE_ABORTED: "role-aborted",
	EMPTY_ARTIFACT: "empty-artifact",
	HANDSHAKE_REFUSED: "handshake-refused",
});
const REQUEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const RCTX_RE = /^rctx1_[0-9a-f]{64}$/;
// Provider-returned lineage and target bindings are the sole authority and must be unique.
const ROLE_BINDING_RE = Object.freeze({ "--lineage=": /^.+$/, "--expected-revision=": REQUEST_HASH_RE, "--target=": REQUEST_HASH_RE, "--repository-context=": RCTX_RE });
// The 900s watchdog FIRES after the provider-owned 600s deadline and leaves setup/cancellation margin.
export const DEFAULT_ROLE_VECTOR_TIMEOUT_MS = 900_000;
export class ProviderRoleVectorError extends Error {
	kind;
	stage;
	exitCode;
	stderr;
	timedOut;
	mutationOutcome;
	// Unreadable outcomes after launch are unknown and require STATUS re-query.
	constructor(kind, stage, message, details) {
		super(message);
		this.name = "ProviderRoleVectorError";
		this.kind = kind;
		this.stage = stage;
		this.exitCode = details?.exitCode ?? null;
		this.stderr = details?.stderr ?? "";
		this.timedOut = details?.timedOut ?? false;
		this.mutationOutcome = details?.mutationOutcome ?? (kind === ROLE_VECTOR_FAILURE.ROLE_FAILED || kind === ROLE_VECTOR_FAILURE.ROLE_TIMED_OUT || kind === ROLE_VECTOR_FAILURE.ROLE_OUTPUT_OVERFLOW ? "unknown" : "none");
	}
}
// The positive lens runs only when explicitly armed: the organic journey
// needs a real capable binary, a real pi, and a real review session. Without
// the arm the runner blocks the positive leg before materialize.
export const ARM_POSITIVE_ENV = "GENTLE_PI_MAINTAINER_ARM_POSITIVE";
export const POSITIVE_JOURNEY_COMMAND =
	"GENTLE_PI_MAINTAINER_ARM_POSITIVE=1 node --experimental-strip-types scripts/maintainer/provider-relay-matrix.mjs --descriptor <descriptor.json>  # needs a real capable gentle-ai binary + real pi on PATH + real binding tokens from a live review session (gentle-ai review status --next-transition)";
export class DescriptorValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "DescriptorValidationError";
	}
}
const isObj = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStr = (value) => typeof value === "string" && value.length > 0;
const isStrArr = (value) => Array.isArray(value) && value.length > 0 && value.every(isStr);
const fail = (message) => {
	throw new DescriptorValidationError(message);
};
// Reject any key outside an exact allowed set; keeps the descriptor shape
// strict so a maintainer cannot smuggle production overrides through it.
const exactKeys = (obj, allowed, label) => {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) fail(`${label}.${key} is not allowed; exact shape is {${[...allowed].join(",")}}`);
	}
};
// Strict, exact-shape descriptor validation: no defaults, no production
// resolution. The submission is validated through the REAL relay resolver so
// the completing form is provably bindable before any process launches.
export function validateDescriptor(value) {
	if (!isObj(value)) fail("descriptor must be a JSON object");
	exactKeys(value, new Set(["schema", "gentleAiExecutable", "reviewerSelection", "cases"]), "descriptor");
	if (value.schema !== DESCRIPTOR_SCHEMA) fail(`descriptor.schema must be exactly "${DESCRIPTOR_SCHEMA}"`);
	if (!isStr(value.gentleAiExecutable) || !isAbsolute(value.gentleAiExecutable)) fail("descriptor.gentleAiExecutable must be a non-empty absolute path; the runner never re-resolves the production binary");
	// gentle-pi#311 P4: the positive-lens journey used to need a declared real
	// `pi` binary; lens captures now run in-process, so it instead needs a
	// "provider/id" reviewer selection the armed run resolves through a
	// scripted-but-real completion (never a fake pi child).
	if (!isStr(value.reviewerSelection)) fail("descriptor.reviewerSelection must be a non-empty string");
	if (!Array.isArray(value.cases) || value.cases.length === 0) fail("descriptor.cases must be a non-empty array");
	const seen = new Set();
	return { schema: value.schema, gentleAiExecutable: value.gentleAiExecutable, reviewerSelection: value.reviewerSelection, cases: value.cases.map((entry, index) => {
			if (!isObj(entry)) fail(`descriptor.cases[${index}] must be an object`);
			if (!isStr(entry.name)) fail(`descriptor.cases[${index}].name must be a non-empty string`);
			if (seen.has(entry.name)) fail(`descriptor.cases[${index}].name "${entry.name}" is duplicated`);
			seen.add(entry.name);
			if (!CASE_KINDS.includes(entry.kind)) fail(`descriptor.cases[${index}].kind must be one of ${JSON.stringify([...CASE_KINDS])}`);
			if (PROVIDER_ROLE_VECTOR_KINDS.includes(entry.kind)) {
				return validateRoleCaseEntry(entry, index);
			}
			exactKeys(entry, new Set(["name", "kind", "captureArgumentTokens", "submission"]), `descriptor.cases[${index}]`);
			if (!isStrArr(entry.captureArgumentTokens)) fail(`descriptor.cases[${index}].captureArgumentTokens must be a non-empty array of non-empty strings`);
			// A real host-relay materialize slot is the provider-issued
			// --agent=pi --materialize=true pair; the descriptor must declare
			// exactly that so the negative control exercises the unknown-flag
			// refusal and the positive leg exercises the real surface.
			for (const required of ["--agent=pi", "--materialize=true"]) {
				if (!entry.captureArgumentTokens.includes(required)) fail(`descriptor.cases[${index}].captureArgumentTokens must include the provider-issued "${required}" token`);
			}
			const submission = entry.submission;
			if (!isObj(submission)) fail(`descriptor.cases[${index}].submission must be an object; a materialize slot without a provider submission is a contract mismatch, never synthesized`);
			exactKeys(submission, new Set(["operationToken", "argumentTokens", "values"]), `descriptor.cases[${index}].submission`);
			if (!isStr(submission.operationToken)) fail(`descriptor.cases[${index}].submission.operationToken must be a non-empty string`);
			if (!isStrArr(submission.argumentTokens)) fail(`descriptor.cases[${index}].submission.argumentTokens must be a non-empty array of non-empty strings`);
			if (!Array.isArray(submission.values) || submission.values.length === 0 || !submission.values.every(isObj)) {
				fail(`descriptor.cases[${index}].submission.values must be a non-empty array of objects`);
			}
			for (const [vi, ve] of submission.values.entries()) {
				exactKeys(ve, new Set(["slot", "domain", "substitutionLocation"]), `descriptor.cases[${index}].submission.values[${vi}]`);
				if (!isStr(ve.slot) || !isStr(ve.domain)) fail(`descriptor.cases[${index}].submission.values[${vi}] must have non-empty string slot and domain`);
			}
			// Delegate binding semantics (count, substitution location, the
			// {{value}} slot) to the REAL relay resolver so they never drift.
			try {
				resolveReviewHostRelaySubmission({
					operationToken: submission.operationToken,
					argumentTokens: submission.argumentTokens,
					values: submission.values.map((ve) => ({ slot: ve.slot, domain: ve.domain, substitutionLocation: ve.substitutionLocation })),
				});
			} catch (error) {
				fail(`descriptor.cases[${index}].submission is not a bindable provider form: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { name: entry.name, kind: entry.kind, captureArgumentTokens: [...entry.captureArgumentTokens], submission: { operationToken: submission.operationToken, argumentTokens: [...submission.argumentTokens], values: submission.values.map((ve) => ({ ...ve })) } };
		}),
	};
}
// Validates provider-issued role tokens and the validator's minimal request-hash binding.
function validateRoleCaseEntry(entry, index) {
	const label = `descriptor.cases[${index}]`;
	const allowedKeys = new Set(["name", "kind", "argumentTokens", ...(entry.kind === "provider-role-validator" ? ["validationRequest"] : [])]);
	exactKeys(entry, allowedKeys, label);
	if (!isStrArr(entry.argumentTokens)) fail(`${label}.argumentTokens must be a non-empty array of non-empty strings`);
	// Each self-contained execute control must appear exactly once at its exact value.
	for (const required of ["--agent=pi", "--execute=true"]) {
		const prefix = `${required.slice(0, required.indexOf("=") + 1)}`;
		const matches = entry.argumentTokens.filter((token) => token.startsWith(prefix));
		if (matches.length !== 1 || matches[0] !== required) fail(`${label}.argumentTokens must include exactly one provider-issued "${required}" token`);
	}
	if (entry.argumentTokens.includes("--materialize=true")) {
		fail(`${label}.argumentTokens must not include --materialize=true; a role vector is self-contained, never a lens materialize slot`);
	}
	const bindings = {};
	for (const [prefix, pattern] of Object.entries(ROLE_BINDING_RE)) {
		const matches = entry.argumentTokens.filter((t) => t.startsWith(prefix));
		if (matches.length !== 1) fail(`${label}.argumentTokens must include exactly one "${prefix}" token, found ${matches.length}`);
		const value = matches[0].slice(prefix.length);
		if (!pattern.test(value)) fail(`${label}.argumentTokens "${prefix}" value is malformed`);
		bindings[prefix] = value;
	}
	const result = { name: entry.name, kind: entry.kind, argumentTokens: [...entry.argumentTokens], lineage: bindings["--lineage="], targetIdentity: bindings["--target="] };
	if (entry.kind === "provider-role-validator") {
		const vr = entry.validationRequest;
		if (!isObj(vr)) fail(`${label}.validationRequest must be an object; the provider-embedded validation_request binding is required on the targeted-validator vector`);
		exactKeys(vr, new Set(["schema", "requestHash"]), `${label}.validationRequest`);
		if (vr.schema !== "gentle-ai.review-targeted-validation-request/v1") fail(`${label}.validationRequest.schema must be exactly "gentle-ai.review-targeted-validation-request/v1"`);
		if (!isStr(vr.requestHash) || !REQUEST_HASH_RE.test(vr.requestHash)) fail(`${label}.validationRequest.requestHash must be a sha256 digest`);
		const expectedToken = `--request-hash=${vr.requestHash}`;
		const requestHashTokens = entry.argumentTokens.filter((token) => token.startsWith("--request-hash="));
		if (requestHashTokens.length !== 1 || requestHashTokens[0] !== expectedToken) fail(`${label}.argumentTokens must include exactly one provider-issued "${expectedToken}" token that binds the embedded validation_request`);
		result.validationRequest = { schema: vr.schema, requestHash: vr.requestHash };
	}
	return Object.freeze(result);
}
export function loadDescriptor(path) {
	if (!isStr(path)) fail("a descriptor path is required");
	let raw, parsed;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		fail(`could not read descriptor at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		fail(`descriptor at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateDescriptor(parsed);
}
// Resolves a declared executable without a shell: absolute path checked
// verbatim, bare name searched on PATH. Never re-resolves production. PATH
// matches are normalized to absolute paths (a relative component like `.`
// must not yield a relative candidate; the relay launches from scratch).
export function resolveDeclaredExecutable(executable) {
	if (isAbsolute(executable)) return existsSync(executable) && statSync(executable).isFile() ? executable : null;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, executable);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}
const missingReason = (executable, label) => `${label} "${executable}" is not an existing executable; arm the descriptor with a real binary, or set GENTLE_PI_REQUIRE_MAINTAINER=1 to fail instead of block.`;
// A reviewer registry whose `find` always misses. Mirrors the pre-in-process
// "unlaunchable pi" trick this replaced: the maintainer-declared `kind` is
// not evidence that the declared gentle-ai binary is actually incapable, so
// a `relay-unavailable` negative control against a mis-declared CAPABLE
// binary must still never complete a reviewer or submit anything. Resolving
// nothing guarantees a typed MODEL_NOT_FOUND refusal before any completion
// or submission, so the control cannot become a hidden real mutation even
// against a binary that turns out to be capable (gentle-pi#311 P4).
function unresolvableReviewerRegistry() {
	return {
		find: () => undefined,
		getApiKeyAndHeaders: async () => ({ ok: false, error: "the relay-unavailable negative control never resolves a reviewer" }),
	};
}
// The armed, organic positive-lens journey needs the real gentle-ai binary's
// materialize/submit protocol exercised end-to-end, but this harness cannot
// assume a maintainer's real provider credentials. Instead of a fake pi
// child, this registers pi-ai's own faux provider -- the SAME api-registry
// the real `completeSimple` dispatches through in production -- so the real
// `runInProcessReviewer` -> real `completeSimple` path runs with no network.
// The scripted response reads the frozen prompt's `GENTLE_AI_REVIEW_BINDING`
// line for the subject_hash and its `GENTLE_AI_REVIEW_CONTEXT` line for the
// changed-path manifest, and answers with every field the reviewer result
// contract requires -- subject_hash, a completed inspection over exactly the
// frozen paths, findings, evidence -- so the real Go admission accepts it
// (gentle-pi#311 P4). Not unregistered: each
// call uses a fresh random api id, and this runs at most once per short-lived
// process (the CLI's single `main()` or one test), so a leaked entry in the
// process-global api-registry is harmless.
// Reads the one-line JSON that follows a frozen prompt marker (the binding
// and context lines Go writes at the top of every reviewer task). Returns
// undefined when the marker is absent or its JSON is malformed, so the faux
// reviewer answers with an incomplete result that real admission refuses
// instead of throwing inside the provider and masking the contract drift.
function frozenPromptMarkerJson(promptText, marker) {
	const prefix = `${marker} `;
	for (const line of promptText.split("\n")) {
		if (!line.startsWith(prefix)) continue;
		try { return JSON.parse(line.slice(prefix.length)); } catch { return undefined; }
	}
	return undefined;
}
function armedFauxReviewerRegistry(reviewerSelection) {
	const separatorIndex = reviewerSelection.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === reviewerSelection.length - 1) {
		throw new DescriptorValidationError(`descriptor.reviewerSelection "${reviewerSelection}" must have the "provider/id" shape`);
	}
	const provider = reviewerSelection.slice(0, separatorIndex);
	const modelId = reviewerSelection.slice(separatorIndex + 1);
	const api = `gentle-pi-maintainer-faux-reviewer-${randomUUID()}`;
	const faux = registerFauxProvider({ api, provider, models: [{ id: modelId }] });
	faux.setResponses([(context) => {
		const content = context.messages[0]?.content;
		const textPart = Array.isArray(content) ? content.find((part) => part.type === "text") : undefined;
		const promptText = textPart?.text ?? "";
		const binding = frozenPromptMarkerJson(promptText, "GENTLE_AI_REVIEW_BINDING");
		const frozenContext = frozenPromptMarkerJson(promptText, "GENTLE_AI_REVIEW_CONTEXT");
		const manifest = Array.isArray(frozenContext?.changed_path_manifest) ? frozenContext.changed_path_manifest : [];
		const paths = manifest.map((entry) => entry?.path).filter((path) => typeof path === "string" && path.length > 0);
		return fauxAssistantMessage(JSON.stringify({
			subject_hash: binding?.subject_hash,
			inspection: { status: "completed", paths },
			findings: [],
			evidence: ["armed maintainer faux reviewer inspected every frozen candidate path"],
		}));
	}]);
	const model = faux.getModel();
	return {
		find: () => model,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux-key" }),
	};
}
function terminateRoleProcessTree(child) {
	if (child.pid === undefined) return false;
	if (process.platform === "win32") {
		try { const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: false, windowsHide: true, timeout: 5_000 }); if (result.error === undefined && result.status === 0) return true; } catch {}
		child.kill("SIGKILL"); return false;
	}
	try { process.kill(-child.pid, "SIGKILL"); return true; } catch (error) { if (error?.code === "ESRCH") return true; child.kill("SIGKILL"); return false; }
}
export async function runProviderRoleVector(request) {
	const verb = PROVIDER_ROLE_VECTOR_VERB[request.kind];
	if (verb === undefined) throw new TypeError(`runProviderRoleVector received an unknown role vector kind: ${request.kind}`);
	if (request.signal?.aborted) throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_ABORTED, "launch", "gentle-ai role vector was aborted before launch", { mutationOutcome: "none" });
	const argv = ["review", verb, ...request.argumentTokens], env = { ...process.env, ...request.env, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT };
	let capture, launched = false;
	try {
		capture = await new Promise((resolve, reject) => {
			const child = spawn(request.gentleAiExecutable, argv, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, ...(process.platform === "win32" ? {} : { detached: true }) });
			launched = child.pid !== undefined;
			const stdout = [], stderr = []; let stdoutBytes = 0, stderrBytes = 0, terminationCause = null, treeTerminationFailed = false, settled = false;
			const captured = (exitCode) => ({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, terminationCause, treeTerminationFailed });
			const collect = (stream, chunks) => (chunk) => { if (terminationCause !== null) return; const bytes = chunk.length; if ((stream === "stdout" ? stdoutBytes : stderrBytes) + bytes > ROLE_STREAM_MAX_BYTES) { terminate(stream); return; } if (stream === "stdout") stdoutBytes += bytes; else stderrBytes += bytes; chunks.push(chunk); };
			const onStdout = collect("stdout", stdout), onStderr = collect("stderr", stderr);
			const abort = () => terminate("abort");
			const cleanup = () => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); child.stdout.off("data", onStdout); child.stderr.off("data", onStderr); child.off("error", onError); child.off("close", onClose); };
			const settle = (result) => { if (settled) return; settled = true; cleanup(); resolve(result); };
			const onError = (error) => { if (terminationCause === null) { if (settled) return; settled = true; cleanup(); reject(error); } else settle(captured(null)); };
			const onClose = (code) => settle(captured(code));
			const terminate = (cause) => {
				if (terminationCause !== null) return;
				terminationCause = cause;
				treeTerminationFailed = !(request.terminateProcessTree ?? terminateRoleProcessTree)(child);
				if (treeTerminationFailed) { child.stdout.destroy(); child.stderr.destroy(); settle(captured(null)); }
			};
			child.stdout.on("data", onStdout); child.stderr.on("data", onStderr); child.on("error", onError); child.on("close", onClose);
			const timer = setTimeout(() => terminate("timeout"), request.timeoutMs ?? DEFAULT_ROLE_VECTOR_TIMEOUT_MS); timer.unref();
			if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
		});
	} catch (error) {
		if (request.signal?.aborted && launched) throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_ABORTED, "execute", "gentle-ai role vector was aborted after launch", { mutationOutcome: "unknown" });
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_LAUNCH_FAILED, "launch", `gentle-ai role vector could not start: ${error instanceof Error ? error.message : String(error)}`);
	}
	const stderrText = capture.stderr.toString("utf8");
	if (capture.treeTerminationFailed) throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_TERMINATION_FAILED, "execute", "gentle-ai role vector tree termination could not be confirmed; re-query negotiated STATUS before any retry", { exitCode: capture.exitCode, stderr: stderrText, mutationOutcome: "unknown" });
	if (capture.terminationCause === "abort") throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_ABORTED, "execute", "gentle-ai role vector was aborted after launch", { exitCode: capture.exitCode, stderr: stderrText, mutationOutcome: "unknown" });
	if (capture.terminationCause === "stdout" || capture.terminationCause === "stderr") throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_OUTPUT_OVERFLOW, "execute", `gentle-ai role vector ${capture.terminationCause} exceeded the ${ROLE_STREAM_MAX_BYTES}-byte limit; re-query negotiated STATUS before any retry`, { exitCode: capture.exitCode, stderr: stderrText });
	if (capture.terminationCause === "timeout") throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_TIMED_OUT, "execute", "gentle-ai role vector exceeded its outer watchdog; re-query negotiated STATUS before any retry, and the same transcript must not relaunch blindly", { exitCode: capture.exitCode, stderr: stderrText, timedOut: true });
	if (capture.exitCode !== 0) {
		const refusal = classifyReviewHostRelayRefusal(stderrText);
		if (refusal === "handshake") throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED, "execute", stderrText, { exitCode: capture.exitCode, stderr: stderrText });
		if (refusal === "unknown-flag") throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE, "execute", "the declared gentle-ai binary lacks the provider role capture surface", { exitCode: capture.exitCode, stderr: stderrText });
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", "gentle-ai role vector failed", { exitCode: capture.exitCode, stderr: stderrText });
	}
	if (capture.stdout.length === 0) throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.EMPTY_ARTIFACT, "execute", "gentle-ai role vector produced no artifact bytes; re-query negotiated STATUS before any retry", { exitCode: 0, stderr: stderrText, mutationOutcome: "unknown" });
	let artifact;
	try { artifact = JSON.parse(capture.stdout.toString("utf8")); } catch (error) { throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", `gentle-ai role vector returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { exitCode: 0, stderr: stderrText }); }
	const expectedRole = PROVIDER_ROLE_VECTOR_ROLE[request.kind];
	if (!isObj(artifact) || artifact.schema !== PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA || artifact.role !== expectedRole || artifact.captured !== true || !isStr(artifact.lineage_id) || !REQUEST_HASH_RE.test(artifact.target_identity)) throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", "gentle-ai role vector returned an artifact that does not match the expected typed shape", { exitCode: 0, stderr: stderrText });
	return { schema: artifact.schema, lineageId: artifact.lineage_id, targetIdentity: artifact.target_identity, role: artifact.role, captured: true };
}
// Runs the matrix against the REAL relay. A case that cannot run honestly is
// `blocked` (never `pass`); `fail` is an armed case whose outcome mismatched.
export async function runMatrix(descriptor, options = {}) {
	const positiveArmed = options.armPositive ?? (process.env[ARM_POSITIVE_ENV] === "1");
	// Smallest test seam: an optional injected relay function. Defaults to
	// the real relay so production CLI behavior is identical when unset; tests
	// inject a fake to assert the exact resolved path reaches the boundary
	// without executing a real subprocess (platform-neutral #324 evidence).
	const relay = options.relay ?? runReviewHostRelaySlot;
	// Test seam only; production defaults to the real role runner.
	const roleRunner = options.roleRunner ?? runProviderRoleVector;
	const verdicts = [];
	for (const caseEntry of descriptor.cases) {
		const gentleAiPath = resolveDeclaredExecutable(descriptor.gentleAiExecutable);
		if (gentleAiPath === null) {
			verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: missingReason(descriptor.gentleAiExecutable, "gentleAiExecutable") });
			continue;
		}
		// Self-contained role vectors require explicit arming and a real provider result.
		if (PROVIDER_ROLE_VECTOR_KINDS.includes(caseEntry.kind)) {
			if (!positiveArmed) {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: `${caseEntry.kind} case is not explicitly armed; set ${ARM_POSITIVE_ENV}=1 with a real capable gentle-ai binary, a real pi, and a real review session (real binding tokens from \`gentle-ai review status --next-transition\`) to run the organic role vector. The runner never synthesizes a provider verdict.`, command: POSITIVE_JOURNEY_COMMAND });
				continue;
			}
			try {
				const artifact = await roleRunner({ kind: caseEntry.kind, argumentTokens: caseEntry.argumentTokens, gentleAiExecutable: gentleAiPath, ...(caseEntry.validationRequest === undefined ? {} : { validationRequest: caseEntry.validationRequest }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
				if (artifact.lineageId !== caseEntry.lineage || artifact.targetIdentity !== caseEntry.targetIdentity) {
					throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", `role vector returned a stale artifact: expected lineage=${caseEntry.lineage} target=${caseEntry.targetIdentity}, got lineage=${artifact.lineageId} target=${artifact.targetIdentity}`);
				}
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", role: artifact.role, lineageId: artifact.lineageId, targetIdentity: artifact.targetIdentity, captured: artifact.captured });
			} catch (error) {
				if (error instanceof ProviderRoleVectorError) {
					if (error.kind === ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED) {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", stage: error.stage, mutationOutcome: error.mutationOutcome, reason: `the declared gentle-ai binary refused relay-contract negotiation: ${error.message}`, command: POSITIVE_JOURNEY_COMMAND });
					} else if (error.kind === ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE) {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", stage: error.stage, mutationOutcome: error.mutationOutcome, reason: `the declared gentle-ai binary lacks the provider role capture surface: ${error.message}`, command: POSITIVE_JOURNEY_COMMAND });
					} else {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `role vector error kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}: ${error.message}`, stderr: error.stderr, timedOut: error.timedOut });
					}
				} else {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `unexpected non-role error: ${error instanceof Error ? error.message : String(error)}` });
				}
			}
			continue;
		}
		// The positive lens needs an explicit arm; the negative control never
		// resolves a reviewer (fails closed at the reviewer stage or earlier).
		if (caseEntry.kind === "positive-lens" && !positiveArmed) {
			verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: `positive-lens case is not explicitly armed; set ${ARM_POSITIVE_ENV}=1 with a real capable gentle-ai binary and a real review session (real binding tokens from \`gentle-ai review status --next-transition\`) to run the organic journey. The runner never synthesizes a provider result.`, command: POSITIVE_JOURNEY_COMMAND });
			continue;
		}
		// `relay-unavailable` is a NEGATIVE CONTROL: it must never complete a
		// reviewer and never submit. The maintainer-declared `kind` is not
		// evidence that the declared binary is actually incapable, so the arm
		// gate cannot key off the declaration alone. Pointed at a mis-declared
		// CAPABLE binary, a declaration-only gate materializes, runs a REAL
		// reviewer completion, and executes a REAL `capture-result --input=...`
		// submission, and only then reports `fail` — the mutation already
		// happened. So give the negative control a reviewer registry that can
		// never resolve: an incapable binary still classifies relay-unavailable
		// at materialize (the control stays genuine, since it never reached the
		// reviewer stage anyway), while a capable one fails closed at the
		// reviewer stage as kind=reviewer-model-not-found stage=pi
		// mutationOutcome=none, with zero completion and zero submission
		// (gentle-pi#311 P4, superseding the pre-in-process "unlaunchable pi").
		try {
			// A malformed `reviewerSelection` (caught here rather than at
			// descriptor-validation time, since it is only ever exercised by an
			// armed positive-lens case) must fail this case the same way a real
			// relay error would, never crash the whole matrix.
			const reviewerRegistry = caseEntry.kind === "relay-unavailable" ? unresolvableReviewerRegistry() : armedFauxReviewerRegistry(descriptor.reviewerSelection);
			const request = {
				captureArgumentTokens: caseEntry.captureArgumentTokens,
				submission: caseEntry.submission,
				gentleAiExecutable: gentleAiPath,
				reviewerRegistry,
				selection: descriptor.reviewerSelection,
				routingKey: "review-relay-matrix",
				...(options.signal === undefined ? {} : { signal: options.signal }),
			};
			const result = await relay(request);
			if (caseEntry.kind === "relay-unavailable") {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: "expected relay-unavailable (runtime without --materialize) but the relay succeeded; the descriptor's binary is unexpectedly capable" });
			} else {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", promptByteLength: result.promptByteLength, resultByteLength: result.resultByteLength, submissionByteLength: result.submission.length });
			}
		} catch (error) {
			if (error instanceof DescriptorValidationError) {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: error.message });
			} else if (error instanceof ReviewHostRelayError) {
				if (caseEntry.kind === "relay-unavailable") {
					if (error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE && error.stage === "materialize" && error.mutationOutcome === "none") {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", stage: error.stage, mutationOutcome: error.mutationOutcome, reason: REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE });
					} else {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `expected relay-unavailable at materialize with zero mutation, got kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}`, stderr: error.stderr });
					}
				} else if (error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE) {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", stage: error.stage, reason: `the declared gentle-ai binary lacks the pi host relay surface: ${error.message}`, command: POSITIVE_JOURNEY_COMMAND });
				} else {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `relay error kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}: ${error.message}`, stderr: error.stderr });
				}
			} else {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `unexpected non-relay error: ${error instanceof Error ? error.message : String(error)}` });
			}
		}
	}
	return verdicts;
}
async function main() {
	const argv = process.argv.slice(2);
	const index = argv.indexOf("--descriptor");
	if (index === -1 || argv[index + 1] === undefined) {
		process.stderr.write("usage: provider-relay-matrix.mjs --descriptor <path.json>\n");
		process.exitCode = 2;
		return;
	}
	let descriptor;
	try {
		descriptor = loadDescriptor(argv[index + 1]);
	} catch (error) {
		process.stderr.write(`descriptor validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
		return;
	}
	const verdicts = await runMatrix(descriptor, { armPositive: process.env[ARM_POSITIVE_ENV] === "1" });
	for (const verdict of verdicts) {
		process.stdout.write(`${JSON.stringify(verdict)}\n`);
		if (verdict.verdict !== "pass") process.exitCode = 1;
	}
}
if (process.argv[1]?.endsWith("provider-relay-matrix.mjs")) await main();
