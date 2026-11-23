import assert from "node:assert/strict";
import test from "node:test";
import {
	FULL_4R_LENSES,
	LARGE_CHANGED_LINE_THRESHOLD,
	REVIEW_LENS,
	REVIEW_EVENT,
	REVIEW_ROUTE,
	TRIVIALITY,
	buildDiffEvidence,
	classifyReviewRoute,
	type DiffEvidence,
	type TriggerEvent,
} from "../lib/review-triggers.ts";

function evidence(overrides: Partial<DiffEvidence> = {}): DiffEvidence {
	return {
		event: REVIEW_EVENT.ORDINARY_START,
		changedLines: 20,
		triviality: TRIVIALITY.NON_TRIVIAL,
		evidenceComplete: true,
		executableChanged: true,
		configurationChanged: false,
		hotPathChanged: false,
		riskSignal: false,
		resilienceSignal: false,
		reliabilitySignal: false,
		...overrides,
	};
}

test("routing constants expose stable runtime values", () => {
	assert.deepEqual(REVIEW_ROUTE, {
		TRIVIAL: "trivial",
		STANDARD: "standard",
		FULL_4R: "full-4R",
	});
	assert.equal(LARGE_CHANGED_LINE_THRESHOLD, 400);
	assert.deepEqual(FULL_4R_LENSES, [
		REVIEW_LENS.RISK,
		REVIEW_LENS.RESILIENCE,
		REVIEW_LENS.READABILITY,
		REVIEW_LENS.RELIABILITY,
	]);
});

test("objectively trivial documentation diff requests zero lenses", () => {
	const plan = classifyReviewRoute(
		evidence({
			changedLines: 8,
			triviality: TRIVIALITY.PROVEN,
			executableChanged: false,
		}),
	);
	assert.equal(plan.route, REVIEW_ROUTE.TRIVIAL);
	assert.deepEqual(plan.lenses, []);
});

test("objectively trivial hot-path documentation remains trivial", () => {
	const plan = classifyReviewRoute(
		evidence({
			triviality: TRIVIALITY.PROVEN,
			executableChanged: false,
			hotPathChanged: true,
		}),
	);
	assert.equal(plan.route, REVIEW_ROUTE.TRIVIAL);
	assert.deepEqual(plan.lenses, []);
});

for (const [name, overrides] of [
	["incomplete evidence", { evidenceComplete: false }],
	["executable ambiguity", { triviality: TRIVIALITY.UNPROVEN, executableChanged: true }],
	[
		"configuration ambiguity",
		{
			triviality: TRIVIALITY.PROVEN,
			executableChanged: false,
			configurationChanged: true,
		},
	],
] satisfies Array<[string, Partial<DiffEvidence>]>) {
	test(`${name} fails conservatively to one standard lens`, () => {
		const plan = classifyReviewRoute(evidence(overrides));
		assert.equal(plan.route, REVIEW_ROUTE.STANDARD);
		assert.deepEqual(plan.lenses, [REVIEW_LENS.READABILITY]);
	});
}

test("standard routing selects exactly one dominant lens by fixed precedence", () => {
	assert.deepEqual(
		classifyReviewRoute(
			evidence({ riskSignal: true, resilienceSignal: true, reliabilitySignal: true }),
		).lenses,
		[REVIEW_LENS.RISK],
	);
	assert.deepEqual(
		classifyReviewRoute(
			evidence({ resilienceSignal: true, reliabilitySignal: true }),
		).lenses,
		[REVIEW_LENS.RESILIENCE],
	);
	assert.deepEqual(
		classifyReviewRoute(evidence({ reliabilitySignal: true })).lenses,
		[REVIEW_LENS.RELIABILITY],
	);
	assert.deepEqual(classifyReviewRoute(evidence()).lenses, [REVIEW_LENS.READABILITY]);
});

for (const changedLines of [399, 400]) {
	test(`${changedLines} ordinary changed lines remain standard`, () => {
		const plan = classifyReviewRoute(evidence({ changedLines }));
		assert.equal(plan.route, REVIEW_ROUTE.STANDARD);
		assert.equal(plan.lenses.length, 1);
	});
}

test("401 ordinary changed lines route to full 4R in stable order", () => {
	const plan = classifyReviewRoute(evidence({ changedLines: 401 }));
	assert.equal(plan.route, REVIEW_ROUTE.FULL_4R);
	assert.deepEqual(plan.lenses, FULL_4R_LENSES);
});

test("non-trivial hot path routes to full 4R regardless of size", () => {
	const plan = classifyReviewRoute(evidence({ changedLines: 1, hotPathChanged: true }));
	assert.equal(plan.route, REVIEW_ROUTE.FULL_4R);
	assert.deepEqual(plan.lenses, FULL_4R_LENSES);
});

for (const event of ["pre-commit", "pre-push", "pre-pr", "on-ci", "on-schedule"] satisfies TriggerEvent[]) {
	test(`${event} cannot classify outside ordinary transaction start`, () => {
		assert.throws(
			() => classifyReviewRoute(evidence({ event, changedLines: 401 })),
			/only.*ordinary.*start/i,
		);
	});
}

test("runtime evidence proves documentation-only changes trivial", () => {
	const result = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
		changedPaths: ["README.md", "docs/review-routing.md", "docs/guides/routing.mdx"],
		changedLines: 14,
	});
	assert.equal(result.triviality, TRIVIALITY.PROVEN);
	assert.equal(result.evidenceComplete, true);
	assert.equal(result.executableChanged, false);
	assert.equal(result.configurationChanged, false);
});

test("runtime evidence treats executable and configuration content as unproven", () => {
	const source = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
		changedPaths: ["src/review.ts"],
		changedLines: 4,
	});
	assert.equal(source.triviality, TRIVIALITY.UNPROVEN);
	assert.equal(source.executableChanged, true);

	const config = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
		changedPaths: ["config/review.yaml"],
		changedLines: 2,
	});
	assert.equal(config.triviality, TRIVIALITY.UNPROVEN);
	assert.equal(config.configurationChanged, true);
});

test("documentation-like executable and configuration paths remain non-trivial", () => {
	for (const expected of [
		{ path: "requirements.txt", executableChanged: false, configurationChanged: true },
		{ path: "CMakeLists.txt", executableChanged: false, configurationChanged: true },
		{ path: "assets/agents/review-risk.md", executableChanged: true, configurationChanged: false },
		{ path: "skills/drakonc-ai/SKILL.md", executableChanged: true, configurationChanged: false },
		{ path: "src/pages/dashboard.mdx", executableChanged: true, configurationChanged: false },
		{ path: "README.sh", executableChanged: true, configurationChanged: false },
	] as const) {
		const result = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
			changedPaths: [expected.path],
			changedLines: 4,
		});

		assert.equal(result.triviality, TRIVIALITY.UNPROVEN, expected.path);
		assert.equal(result.executableChanged, expected.executableChanged, expected.path);
		assert.equal(result.configurationChanged, expected.configurationChanged, expected.path);
		assert.equal(classifyReviewRoute(result).route, REVIEW_ROUTE.STANDARD, expected.path);
	}
});

test("runtime evidence identifies hot paths and dominant-risk signals", () => {
	const hot = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
		changedPaths: ["src/auth/session.ts"],
		changedLines: 5,
	});
	assert.equal(hot.hotPathChanged, true);
	assert.equal(hot.riskSignal, true);

	const resilient = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
		changedPaths: ["infra/deploy/rollback.ts"],
		changedLines: 5,
	});
	assert.equal(resilient.resilienceSignal, true);
});

test("sensitive configuration basenames select the risk lens at pre-commit", () => {
	for (const path of [
		".env",
		"services/api/.env.production",
		"config/environment.json",
		"config/credentials.json",
		"config/secrets.yaml",
		"config/tokens.toml",
		"config/permissions.json",
		"config/policy.yaml",
		"config/security.ini",
	]) {
		const evidence = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
			changedPaths: [path],
			changedLines: 3,
		});
		const plan = classifyReviewRoute(evidence);

		assert.equal(evidence.configurationChanged, true, path);
		assert.equal(evidence.riskSignal, true, path);
		assert.equal(plan.route, REVIEW_ROUTE.STANDARD, path);
		assert.deepEqual(plan.lenses, [REVIEW_LENS.RISK], path);
	}
});

test("ordinary files containing sensitive-looking substrings do not select risk", () => {
	for (const path of [
		"config/tokenizer.json",
		"config/political-map.json",
		"config/secret-santa.yaml",
		"config/security-notes.yaml",
		"docs/policy.md",
		"src/environment.ts",
	]) {
		const evidence = buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
			changedPaths: [path],
			changedLines: 3,
		});
		const plan = classifyReviewRoute(evidence);

		assert.equal(evidence.riskSignal, false, path);
		assert.deepEqual(
			plan.lenses,
			path === "docs/policy.md" ? [] : [REVIEW_LENS.READABILITY],
			path,
		);
	}
});

test("incomplete runtime collection remains standard instead of trivial", () => {
	const plan = classifyReviewRoute(
		buildDiffEvidence(
			REVIEW_EVENT.ORDINARY_START,
			{ changedPaths: [], changedLines: 0 },
			false,
		),
	);
	assert.equal(plan.route, REVIEW_ROUTE.STANDARD);
	assert.deepEqual(plan.lenses, [REVIEW_LENS.READABILITY]);
});

test("incomplete triviality evidence cannot suppress a known 401-line full route", () => {
	const plan = classifyReviewRoute(
		evidence({
			changedLines: 401,
			triviality: TRIVIALITY.UNPROVEN,
			evidenceComplete: false,
		}),
	);
	assert.equal(plan.route, REVIEW_ROUTE.FULL_4R);
	assert.deepEqual(plan.lenses, FULL_4R_LENSES);
});

test("stable full-lens order is independent of standard-risk signals", () => {
	const plan = classifyReviewRoute(
		evidence({
			changedLines: 401,
			riskSignal: true,
			resilienceSignal: true,
			reliabilitySignal: true,
		}),
	);
	assert.deepEqual(plan.lenses, [
		REVIEW_LENS.RISK,
		REVIEW_LENS.RESILIENCE,
		REVIEW_LENS.READABILITY,
		REVIEW_LENS.RELIABILITY,
	]);
});

test("runtime collection keeps a large documentation-only hot-path edit trivial", () => {
	const plan = classifyReviewRoute(
		buildDiffEvidence(REVIEW_EVENT.ORDINARY_START, {
			changedPaths: ["docs/auth/recovery.md"],
			changedLines: 900,
		}),
	);
	assert.equal(plan.route, REVIEW_ROUTE.TRIVIAL);
	assert.deepEqual(plan.lenses, []);
});
