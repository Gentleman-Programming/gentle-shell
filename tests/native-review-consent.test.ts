import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GENTLE_AI_VERSION } from "../lib/gentle-ai-binary.ts";
import {
	NativeReviewCliV216,
	NativeReviewConsentBindingError,
	NativeReviewConsentRequiredError,
	type ExecFileAdapter,
} from "../lib/native-review-cli.ts";
import { NativeReviewCliV216 as RuntimeNativeReviewCliV216 } from "../runtime/native-review-cli.mjs";
import type { ReviewConsentV2 } from "../lib/review-integration-v2.ts";

const fixtureRoot = join(process.cwd(), "contracts", "review-integration", "v2", "fixtures");
const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
const executableDigest = "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705";

function capabilities(): Record<string, unknown> {
	const value = fixture<Record<string, unknown>>("capabilities.fixture.json");
	(value.package as Record<string, unknown>).version = GENTLE_AI_VERSION;
	return value;
}

function unrelatedStatus(targetIdentity: string): Record<string, unknown> {
	const status = fixture<Record<string, unknown>>("status.fixture.json");
	status.applicability = "unrelated";
	delete status.receipt;
	status.action = "start";
	status.replayability = "not_replayable";
	status.target_identity = targetIdentity;
	status.candidates = [];
	delete status.authority;
	delete status.frozen;
	delete status.next_transition;
	const projection = status.projection as Record<string, unknown>;
	projection.initial_snapshot_identity = targetIdentity;
	projection.current_snapshot_identity = targetIdentity;
	return status;
}

function startTransitionTokens(targetIdentity: string): readonly string[] {
	return [
		"--contract=gentle-ai.review-integration/v2",
		"--cwd=/repo",
		`--target=${targetIdentity}`,
		"--projection=workspace",
		"--agent=pi",
		"--consent=relay",
	] as const;
}

function executableStartStatus(targetIdentity: string): Record<string, unknown> {
	const status = unrelatedStatus(targetIdentity);
	const tokens = startTransitionTokens(targetIdentity);
	status.next_transition = {
		kind: "execute",
		reason_code: "review_start_required",
		execute: {
			operation: "review.start",
			arguments: tokens.map((token) => {
				const separator = token.indexOf("=");
				return { name: token.slice(2, separator), value: token.slice(separator + 1), token };
			}),
			preconditions: [],
			binding: { target_identity: targetIdentity },
		},
	};
	return status;
}

function queuedAdapter(outputs: readonly Record<string, unknown>[]): { adapter: ExecFileAdapter; calls: Array<readonly string[]> } {
	// V216 no longer probes capabilities before negotiated STATUS. Keep the
	// historical queue construction below, but discard only its obsolete probe
	// response so every remaining entry binds the current invocation.
	const queue = outputs.filter((body) => body.schema !== "gentle-ai.review-integration.capabilities/v2");
	const calls: Array<readonly string[]> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push(request.arguments);
			const body = queue.shift();
			if (body === undefined) throw new Error("unexpected native invocation");
			return { stdout: JSON.stringify(body), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

function client(adapter: ExecFileAdapter): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined);
}

function runtimeClient(adapter: ExecFileAdapter): RuntimeNativeReviewCliV216 {
	return new RuntimeNativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined);
}

test("negotiated ordinary START executes the complete STATUS-rendered relay vector and preserves the consent envelope", async () => {
	const consent = fixture<Record<string, unknown>>("consent.fixture.json");
	const target = String(consent.target_identity);
	const tokens = startTransitionTokens(target);
	for (const createClient of [client, runtimeClient]) {
		const queue = queuedAdapter([capabilities(), executableStartStatus(target), structuredClone(consent)]);
		await assert.rejects(
			() => createClient(queue.adapter).start({ cwd: "/repo" }),
			(error: unknown) => {
				assert.equal((error as { name?: string }).name, "NativeReviewConsentRequiredError");
				const required = error as { consent: { raw: Record<string, unknown>; targetIdentity: string } };
				assert.deepEqual(required.consent.raw, consent);
				assert.equal(required.consent.targetIdentity, target);
				return true;
			},
		);
		assert.deepEqual(queue.calls, [
			["review", "status", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--projection", "workspace", "--agent", "pi", "--next-transition"],
			["review", "start", ...tokens],
		]);
	}
});

test("controller-prebound START target checks STATUS once and executes its exact matching transition", async () => {
	const consent = fixture<Record<string, unknown>>("consent.fixture.json");
	const target = String(consent.target_identity);
	const tokens = startTransitionTokens(target);
	for (const createClient of [client, runtimeClient]) {
		const queue = queuedAdapter([capabilities(), executableStartStatus(target), structuredClone(consent)]);
		await assert.rejects(
			() => createClient(queue.adapter).start({ cwd: "/repo", targetIdentity: target, projection: "workspace" }),
			(error: unknown) => (error as { name?: string }).name === "NativeReviewConsentRequiredError",
		);
		assert.equal(queue.calls.filter((arguments_) => arguments_[1] === "status").length, 1, "a prebound target is a drift check, never a STATUS bypass");
		assert.deepEqual(queue.calls.at(-1), ["review", "start", ...tokens]);
	}
});

test("consent follow-up executes the provider-named invocation exactly once and refuses changed lineage or target bindings", async () => {
	const consent = fixture<ReviewConsentV2 extends never ? never : Record<string, unknown>>("consent.fixture.json");
	const decodedConsent = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(consent);
	const preboundLineage = "Review.Lineage_42";
	for (const choice of decodedConsent.choices) {
		choice.invocation = choice.invocation.replace("review-consent-fixture", preboundLineage);
	}
	const started = fixture<Record<string, unknown>>("start.fixture.json");
	started.lineage_id = preboundLineage;
	started.artifact_subjects = [];
	const queue = queuedAdapter([capabilities(), started]);
	const native = client(queue.adapter);
	const result = await native.answerConsent!({ cwd: "/repo", consent: decodedConsent, answer: "granted" });
	assert.equal(result.kind, "started");
	assert.ok(result.kind === "started");
	assert.equal(result.start.lineageId, preboundLineage);
	assert.deepEqual(queue.calls.at(-1), decodedConsent.choices[0].invocation.split(" ").slice(1));
	assert.equal(queue.calls.filter((arguments_) => arguments_.includes("granted")).length, 1);

	const runtimeQueue = queuedAdapter([capabilities(), structuredClone(started)]);
	const runtimeResult = await runtimeClient(runtimeQueue.adapter).answerConsent({ cwd: "/repo", consent: decodedConsent, answer: "granted" });
	assert.equal(runtimeResult.kind, "started");
	assert.ok(runtimeResult.kind === "started");
	assert.equal(runtimeResult.start.lineageId, preboundLineage);
	assert.equal(runtimeQueue.calls.filter((arguments_) => arguments_.includes("granted")).length, 1);

	const changedLineage = JSON.parse(JSON.stringify(started).replaceAll(preboundLineage, "different-lineage")) as Record<string, unknown>;
	const lineageQueue = queuedAdapter([capabilities(), changedLineage]);
	await assert.rejects(
		() => client(lineageQueue.adapter).answerConsent!({ cwd: "/repo", consent: decodedConsent, answer: "granted" }),
		/lineage mismatch/,
	);
	assert.equal(lineageQueue.calls.filter((arguments_) => arguments_[0] === "review" && arguments_[1] === "start").length, 1);

	const changed = structuredClone(decodedConsent);
	changed.targetIdentity = `sha256:${"b".repeat(64)}`;
	await assert.rejects(
		() => native.answerConsent!({ cwd: "/repo", consent: changed, answer: "declined" }),
		/target|binding/,
	);
});

// A binding mismatch is decided entirely inside Pi, before the provider is
// launched, so it must not be reported as a provider failure (issue #247).
test("consent answer preserves quoted Windows provider cwd tokens and launches the provider exactly once", async () => {
	const windowsCwd = "C:\\Users\\x\\repo with spaces";
	const gitBashCwd = "/c/Users/x/repo with spaces";
	const cwdPairs = process.platform === "win32"
		? [{ providerCwd: windowsCwd, requestedCwd: gitBashCwd }, { providerCwd: gitBashCwd, requestedCwd: windowsCwd }, { providerCwd: gitBashCwd, requestedCwd: gitBashCwd }, { providerCwd: windowsCwd, requestedCwd: windowsCwd }]
		: [{ providerCwd: windowsCwd, requestedCwd: windowsCwd }];
	for (const { providerCwd, requestedCwd } of cwdPairs) {
		const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
		const lineage = "windows-cwd-lineage";
		for (const choice of decoded.choices) {
			choice.invocation = choice.invocation
				.replace("--cwd /repo", `--cwd "${providerCwd}"`)
				.replace("review-consent-fixture", lineage);
		}
		const started = JSON.parse(JSON.stringify(fixture<Record<string, unknown>>("start.fixture.json")).replaceAll("review-start-fixture", lineage)) as Record<string, unknown>;
		const expected = [
			"review", "start", "--contract", "gentle-ai.review-integration/v2", "--cwd", providerCwd,
			"--target", decoded.targetIdentity, "--projection", "workspace", "--lineage", lineage, "--consent", "granted",
		];
		for (const createClient of [client, runtimeClient]) {
			const queue = queuedAdapter([capabilities(), structuredClone(started)]);
			const result = await createClient(queue.adapter).answerConsent({ cwd: requestedCwd, consent: decoded, answer: "granted" });
			assert.equal(result.kind, "started");
			assert.deepEqual(queue.calls, [expected]);
		}
	}
});

test("consent answer preserves quoted UNC and drive-root cwd tokens", async () => {
	for (const providerCwd of ["\\\\server\\share", "C:\\"]) {
		const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
		const lineage = "windows-root-lineage";
		for (const choice of decoded.choices) {
			choice.invocation = choice.invocation
				.replace("--cwd /repo", `--cwd "${providerCwd}"`)
				.replace("review-consent-fixture", lineage);
		}
		const started = JSON.parse(JSON.stringify(fixture<Record<string, unknown>>("start.fixture.json")).replaceAll("review-start-fixture", lineage)) as Record<string, unknown>;
		const expected = [
			"review", "start", "--contract", "gentle-ai.review-integration/v2", "--cwd", providerCwd,
			"--target", decoded.targetIdentity, "--projection", "workspace", "--lineage", lineage, "--consent", "granted",
		];
		for (const createClient of [client, runtimeClient]) {
			const queue = queuedAdapter([capabilities(), structuredClone(started)]);
			const result = await createClient(queue.adapter).answerConsent({ cwd: providerCwd, consent: decoded, answer: "granted" });
			assert.equal(result.kind, "started");
			assert.deepEqual(queue.calls, [expected]);
		}
	}
});

test("unmatched consent invocation quotes reject before provider launch", async () => {
	for (const quote of ["'", '"']) {
		const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
		const choice = decoded.choices.find((candidate) => candidate.answer === "granted") as { invocation: string };
		choice.invocation = `${choice.invocation} ${quote}`;
		for (const createClient of [client, runtimeClient]) {
			const queue = queuedAdapter([]);
			await assert.rejects(
				() => createClient(queue.adapter).answerConsent({ cwd: "/repo", consent: decoded, answer: "granted" }),
				(error: unknown) => error instanceof TypeError && error.message === "Native consent invocation has invalid quoting",
			);
			assert.deepEqual(queue.calls, []);
		}
	}
});

test("different, duplicate, missing, and malformed consent cwd options reject before provider launch", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
	const drifted = (replace: (invocation: string) => string): ReviewConsentV2 => {
		const consent = structuredClone(decoded);
		const choice = consent.choices.find((candidate) => candidate.answer === "granted") as { invocation: string };
		choice.invocation = replace(choice.invocation);
		return consent;
	};
	const cases = [
		{ label: "different", reason: "consent-invocation-cwd-changed", consent: drifted((value) => value.replace("--cwd /repo", "--cwd /another-repo")) },
		{ label: "duplicate", reason: "consent-invocation-option-invalid", consent: drifted((value) => `${value} --cwd /repo`) },
		{ label: "missing", reason: "consent-invocation-option-invalid", consent: drifted((value) => value.replace("--cwd /repo ", "")) },
		{ label: "malformed", reason: "consent-invocation-cwd-changed", consent: drifted((value) => value.replace("--cwd /repo", '--cwd ""')) },
	] as const;
	for (const scenario of cases) {
		const queue = queuedAdapter([]);
		await assert.rejects(
			() => client(queue.adapter).answerConsent!({ cwd: "/repo", consent: scenario.consent, answer: "granted" }),
			(error: unknown) => error instanceof NativeReviewConsentBindingError && error.reason === scenario.reason,
		);
		assert.deepEqual(queue.calls, [], `${scenario.label} cwd must not launch the provider`);
	}
});

test("a consent invocation binding mismatch is a typed pre-native error that never launches the provider", async () => {
	const consent = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
	const queue = queuedAdapter([]);
	await assert.rejects(
		() => client(queue.adapter).answerConsent!({ cwd: "/repo/.git/gentle-ai/candidate-views/a1c7fdae", consent, answer: "granted" }),
		(error: unknown) => {
			assert.ok(error instanceof NativeReviewConsentBindingError);
			assert.equal(error.name, "NativeReviewConsentBindingError");
			assert.equal(error.reason, "consent-invocation-cwd-changed");
			assert.equal(error.launchAttempted, false);
			assert.equal(error.mutationOutcome, "none");
			assert.match(error.message, /repository binding changed/);
			return true;
		},
	);
	assert.deepEqual(queue.calls, []);
});

// `decodeReviewConsentV2` already rejects a malformed invocation, so these
// guards defend against a consent object that drifted after decoding. Each one
// must still name itself rather than collapse into a generic failure.
test("every consent invocation binding guard reports its own reason without launching the provider", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
	const drifted = (mutate: (consent: ReviewConsentV2) => void): ReviewConsentV2 => {
		const value = structuredClone(decoded);
		mutate(value);
		return value;
	};
	const rewriteGranted = (consent: ReviewConsentV2, replace: (invocation: string) => string): void => {
		const choice = consent.choices.find((candidate) => candidate.answer === "granted") as { invocation: string };
		choice.invocation = replace(choice.invocation);
	};
	const cases = [
		{
			reason: "consent-answer-unknown",
			consent: drifted((consent) => { (consent as { choices: unknown }).choices = consent.choices.filter((choice) => choice.answer !== "granted"); }),
		},
		{ reason: "consent-invocation-not-start", consent: drifted((consent) => rewriteGranted(consent, (value) => value.replace("review start", "review finalize"))) },
		{ reason: "consent-invocation-contract-changed", consent: drifted((consent) => rewriteGranted(consent, (value) => value.replace("gentle-ai.review-integration/v2", "gentle-ai.review-integration/v1"))) },
		{ reason: "consent-invocation-target-changed", consent: drifted((consent) => { (consent as { targetIdentity: string }).targetIdentity = `sha256:${"c".repeat(64)}`; }) },
		{ reason: "consent-invocation-projection-changed", consent: drifted((consent) => { (consent as { projection: string }).projection = "staged"; }) },
		{ reason: "consent-invocation-answer-changed", consent: drifted((consent) => rewriteGranted(consent, (value) => value.replace("--consent granted", "--consent declined"))) },
		{ reason: "consent-invocation-option-invalid", consent: drifted((consent) => rewriteGranted(consent, (value) => `${value} --consent granted`)) },
	] as const;
	for (const scenario of cases) {
		const queue = queuedAdapter([]);
		await assert.rejects(
			() => client(queue.adapter).answerConsent!({ cwd: "/repo", consent: scenario.consent, answer: "granted" }),
			(error: unknown) => {
				assert.ok(error instanceof NativeReviewConsentBindingError, `${scenario.reason} must be a typed binding error`);
				assert.equal(error.reason, scenario.reason);
				return true;
			},
		);
		assert.deepEqual(queue.calls, [], `${scenario.reason} must not launch the provider`);
	}
});

test("fresh consent START accepts the strictly decoded provider-created lineage and rejects a mismatched target", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
	const freshConsent = structuredClone(decoded);
	for (const choice of freshConsent.choices) {
		choice.invocation = choice.invocation.replace(" --lineage review-consent-fixture", "");
	}
	const freshStart = JSON.parse(JSON.stringify(fixture<Record<string, unknown>>("start.fixture.json"))
		.replaceAll("review-start-fixture", "provider-created-lineage")) as Record<string, unknown>;
	const queue = queuedAdapter([capabilities(), freshStart]);
	const result = await client(queue.adapter).answerConsent!({ cwd: "/repo", consent: freshConsent, answer: "granted" });
	assert.equal(result.kind, "started");
	assert.ok(result.kind === "started");
	assert.equal(result.start.lineageId, "provider-created-lineage");
	assert.equal(queue.calls.filter((arguments_) => arguments_[0] === "review" && arguments_[1] === "start").length, 1);
	assert.equal(queue.calls.at(-1)?.includes("--lineage"), false);

	const runtimeQueue = queuedAdapter([capabilities(), structuredClone(freshStart)]);
	const runtimeResult = await runtimeClient(runtimeQueue.adapter).answerConsent({ cwd: "/repo", consent: freshConsent, answer: "granted" });
	assert.equal(runtimeResult.kind, "started");
	assert.ok(runtimeResult.kind === "started");
	assert.equal(runtimeResult.start.lineageId, "provider-created-lineage");
	assert.equal(runtimeQueue.calls.filter((arguments_) => arguments_[0] === "review" && arguments_[1] === "start").length, 1);
	assert.equal(runtimeQueue.calls.at(-1)?.includes("--lineage"), false);

	const mismatchedTarget = structuredClone(freshStart);
	((mismatchedTarget.repository_context as Record<string, unknown>).target_identity as string) = `sha256:${"b".repeat(64)}`;
	const mismatchQueue = queuedAdapter([capabilities(), mismatchedTarget]);
	await assert.rejects(
		() => client(mismatchQueue.adapter).answerConsent!({ cwd: "/repo", consent: freshConsent, answer: "granted" }),
		/target mismatch/,
	);
	assert.equal(mismatchQueue.calls.filter((arguments_) => arguments_[0] === "review" && arguments_[1] === "start").length, 1);
});

test("duplicate, empty, missing, and malformed consent lineages fail before provider launch", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(fixture<Record<string, unknown>>("consent.fixture.json"));
	const drifted = (replace: (invocation: string) => string): ReviewConsentV2 => {
		const consent = structuredClone(decoded);
		const choice = consent.choices.find((candidate) => candidate.answer === "granted") as { invocation: string };
		choice.invocation = replace(choice.invocation);
		return consent;
	};
	const cases = [
		{ label: "duplicate", consent: drifted((value) => `${value} --lineage duplicate-lineage`) },
		{ label: "empty", consent: drifted((value) => value.replace("--lineage review-consent-fixture", "--lineage=")) },
		{ label: "missing", consent: drifted((value) => value.replace("--lineage review-consent-fixture", "--lineage")) },
		{ label: "malformed", consent: drifted((value) => value.replace("--lineage review-consent-fixture", "--lineage invalid/lineage")) },
	] as const;
	for (const scenario of cases) {
		const queue = queuedAdapter([]);
		await assert.rejects(
			() => client(queue.adapter).answerConsent!({ cwd: "/repo", consent: scenario.consent, answer: "granted" }),
			(error: unknown) => {
				assert.ok(error instanceof NativeReviewConsentBindingError, `${scenario.label} lineage must be a typed binding error`);
				assert.equal(error.reason, "consent-invocation-option-invalid");
				return true;
			},
		);
		assert.deepEqual(queue.calls, [], `${scenario.label} lineage must not launch the provider`);
	}
});

test("declined consent decodes the provider's explicit empty authority fields without creating a lineage", async () => {
	const rawConsent = fixture<Record<string, unknown>>("consent.fixture.json");
	const consent = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV2(rawConsent);
	const declined = {
		operation: "review/start",
		action: "declined",
		lenses_required: false,
		lineage_id: "",
		state: "",
		risk_level: "high",
		selected_lenses: [],
		lens_bindings: [],
		projection: "workspace",
		target_identity: consent.targetIdentity,
		changed_files: 1,
		changed_lines: 1,
		correction_budget: 0,
		risk_evidence: ["shell scripting in scripts/deploy.sh"],
		consent: "declined_this_candidate",
	};
	const queue = queuedAdapter([capabilities(), declined]);
	const result = await client(queue.adapter).answerConsent!({ cwd: "/repo", consent, answer: "declined" });
	assert.equal(result.kind, "declined");
	assert.equal("lineageId" in result, false);
	assert.deepEqual(queue.calls.at(-1), consent.choices[1].invocation.split(" ").slice(1));
});

// --- consent/v3 (dev-binary field-test lane) ---
//
// Fixture provenance: consent-v3.captured.json, start-v3-consent-granted
// .captured.json, and start-v3-consent-declined.captured.json were captured
// 2026-08-16 from the real binary at /home/gentleman/.cargo/bin/gentle-ai
// reporting "gentle-ai 2.4.0-main.b1afef46"; full capture commands are
// documented in tests/review-integration-v2-forward.test.ts.

const devbinaryFixtureRoot = join(process.cwd(), "tests", "fixtures", "devbinary");
const devbinaryFixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(devbinaryFixtureRoot, name), "utf8")) as T;

function piConsent(rewriteInvocation: (invocation: string) => string = (invocation) => invocation): Record<string, unknown> {
	const consent = devbinaryFixture<Record<string, unknown>>("consent-v3.captured.json");
	consent.agent = "pi";
	for (const choice of consent.choices as Array<Record<string, unknown>>) {
		choice.invocation = rewriteInvocation(String(choice.invocation));
	}
	return consent;
}

function piBoundConsent(): Record<string, unknown> {
	return piConsent((invocation) => invocation.replace(" --consent ", " --agent pi --consent "));
}

test("Pi START rejects a Pi-bound consent/v3 envelope when any provider choice omits or misbinds the Pi agent", async () => {
	const target = String(devbinaryFixture<Record<string, unknown>>("consent-v3.captured.json").target_identity);
	const tokens = startTransitionTokens(target);
	const invalidUnselectedChoice = (replace: (invocation: string) => string): Record<string, unknown> => {
		const consent = piBoundConsent();
		const choice = (consent.choices as Array<Record<string, unknown>>).find((candidate) => candidate.answer === "declined")!;
		choice.invocation = replace(String(choice.invocation));
		return consent;
	};
	const cases = [
		["missing", piConsent()],
		["embedded", piConsent((invocation) => invocation.replace(" --consent ", " --note=--agent\\ pi --consent "))],
		["duplicate", invalidUnselectedChoice((invocation) => invocation.replace("--agent pi", "--agent pi --agent pi"))],
		["conflicting", invalidUnselectedChoice((invocation) => invocation.replace("--agent pi", "--agent pi --agent claude-code"))],
	] as const;
	for (const [label, consent] of cases) {
		for (const createClient of [client, runtimeClient]) {
			const queue = queuedAdapter([capabilities(), executableStartStatus(target), structuredClone(consent)]);
			await assert.rejects(
				() => createClient(queue.adapter).start({ cwd: "/repo" }),
				(error: unknown) => {
					assert.equal((error as { name?: string }).name, "NativeReviewCliError", `${label} binding must fail closed before consent presentation`);
					assert.equal((error as { code?: string }).code, "schema-incompatible");
					return true;
				},
			);
			assert.deepEqual(queue.calls.at(-1), ["review", "start", ...tokens]);
		}
	}
});

test("Pi START rejects a foreign consent/v3 envelope and only relays exact Pi-bound choice invocations", async () => {
	const consent = devbinaryFixture<Record<string, unknown>>("consent-v3.captured.json");
	const target = String(consent.target_identity);
	const tokens = startTransitionTokens(target);
	for (const createClient of [client, runtimeClient]) {
		const foreignQueue = queuedAdapter([capabilities(), executableStartStatus(target), structuredClone(consent)]);
		await assert.rejects(
			() => createClient(foreignQueue.adapter).start({ cwd: "/repo" }),
			(error: unknown) => {
				assert.equal((error as { name?: string }).name, "NativeReviewCliError");
				assert.equal((error as { code?: string }).code, "schema-incompatible");
				return true;
			},
		);
		assert.deepEqual(foreignQueue.calls.at(-1), ["review", "start", ...tokens]);
		for (const piBound of [
			piBoundConsent(),
			piConsent((invocation) => invocation.replace(" --consent ", " --agent=pi --consent ")),
		]) {
			const piQueue = queuedAdapter([capabilities(), executableStartStatus(target), piBound]);
			await assert.rejects(
				() => createClient(piQueue.adapter).start({ cwd: "/repo" }),
				(error: unknown) => {
					assert.equal((error as { name?: string }).name, "NativeReviewConsentRequiredError");
					const required = error as { consent: { raw: Record<string, unknown>; schema: string; targetIdentity: string; agent?: string } };
					assert.deepEqual(required.consent.raw, piBound);
					assert.equal(required.consent.schema, "gentle-ai.review-integration.consent/v3");
					assert.equal(required.consent.targetIdentity, target);
					assert.equal(required.consent.agent, "pi");
					return true;
				},
			);
			assert.deepEqual(piQueue.calls.at(-1), ["review", "start", ...tokens]);
		}
	}
});

test("a granted Pi consent/v3 answer replays the captured exact agent-bound invocation", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV3(piBoundConsent(), "pi");
	const cwd = decoded.choices[0].invocation.split(" --cwd ")[1]!.split(" ")[0]!;
	const started = devbinaryFixture<Record<string, unknown>>("start-v3-consent-granted.captured.json");
	const queue = queuedAdapter([capabilities(), started]);
	const result = await client(queue.adapter).answerConsent!({ cwd, consent: decoded, answer: "granted" });
	assert.equal(result.kind, "started");
	assert.ok(result.kind === "started");
	assert.equal(result.start.lineageId, "review-377c60e10b852cfc");
	assert.equal(result.start.selectedLenses.length, 4);
	// The follow-up runs the provider-owned invocation verbatim, exactly once.
	assert.deepEqual(queue.calls.at(-1), decoded.choices[0].invocation.split(" ").slice(1));
	assert.equal(queue.calls.filter((arguments_) => arguments_.includes("--agent") && arguments_.includes("pi")).length, 1);
	assert.equal(queue.calls.filter((arguments_) => arguments_.includes("granted")).length, 1);

	const runtimeQueue = queuedAdapter([capabilities(), structuredClone(started)]);
	const runtimeResult = await runtimeClient(runtimeQueue.adapter).answerConsent({ cwd, consent: decoded, answer: "granted" });
	assert.equal(runtimeResult.kind, "started");
});

test("a declined Pi consent/v3 answer replays the captured exact agent-bound invocation and creates no authority", async () => {
	const decoded = (await import("../lib/review-integration-v2.ts")).decodeReviewConsentV3(piBoundConsent(), "pi");
	const cwd = decoded.choices[1].invocation.split(" --cwd ")[1]!.split(" ")[0]!;
	const declined = devbinaryFixture<Record<string, unknown>>("start-v3-consent-declined.captured.json");
	const queue = queuedAdapter([capabilities(), declined]);
	const result = await client(queue.adapter).answerConsent!({ cwd, consent: decoded, answer: "declined" });
	assert.equal(result.kind, "declined");
	assert.ok(result.kind === "declined");
	assert.equal(result.consent, "declined_this_candidate");
	assert.equal(result.targetIdentity, decoded.targetIdentity);
	assert.deepEqual(queue.calls.at(-1), decoded.choices[1].invocation.split(" ").slice(1));
	assert.equal(queue.calls.filter((arguments_) => arguments_.includes("--agent") && arguments_.includes("pi")).length, 1);
});
