import {
	REVIEW_MODE,
	REVIEW_PROJECTION,
	SNAPSHOT_CLEANUP_ACTION,
	SNAPSHOT_CLEANUP_TRIGGER,
	type SnapshotV1,
	type ReviewMode,
} from "../lib/review-snapshot.ts";
import { existsSync, renameSync } from "node:fs";
import { correctionBudget, REVIEW_RISK_TIER } from "../lib/review-risk.ts";
import type { ReviewLockPlatformAdapterV1 } from "../lib/review-lock.ts";
import {
	REVIEW_EVENT,
	REVIEW_LENS,
	REVIEW_ROUTE,
	TRIVIALITY,
	type ReviewLens,
	type ReviewRoute,
} from "../lib/review-triggers.ts";

export function qualifiedReviewLockPlatform(): ReviewLockPlatformAdapterV1 {
	return {
		name: "test-no-replace",
		assertQualified() {},
		proveOwnerDead() { return true; },
		moveNoReplace(source, destination) {
			if (existsSync(destination)) throw new Error("destination already exists");
			renameSync(source, destination);
		},
	};
}

export interface TestSnapshotOptions {
	mode?: ReviewMode;
	baseTree: string;
	completeTree: string;
	initialTree?: string;
	genesisPaths?: string[];
	route?: ReviewRoute;
	lenses?: readonly ReviewLens[];
	policyHash?: string;
}

export function testSnapshot(options: TestSnapshotOptions): SnapshotV1 {
	const route = options.route ?? REVIEW_ROUTE.TRIVIAL;
	const lenses = options.lenses ?? [];
	const initialTree = options.initialTree ?? options.completeTree;
	const selected = lenses[0];
	const changedLines = route === REVIEW_ROUTE.FULL_4R ? 401 : route === REVIEW_ROUTE.TRIVIAL ? 1 : 10;
	return {
		schema: "gentle-ai.review-snapshot/v1",
		mode: options.mode ?? REVIEW_MODE.ORDINARY,
		repository_root: "/test/repository",
		base_tree: options.baseTree,
		complete_snapshot_tree: options.completeTree,
		review_projection:
			initialTree === options.completeTree
				? { kind: REVIEW_PROJECTION.COMPLETE }
				: { kind: REVIEW_PROJECTION.INTENDED_COMMIT, tree: initialTree },
		initial_review_tree: initialTree,
		genesis_paths: options.genesisPaths ?? ["app.ts", "src/auth.ts", "src/retry.ts", "src/review.ts"],
		intended_untracked: [],
		risk_tier: route === REVIEW_ROUTE.FULL_4R ? REVIEW_RISK_TIER.HIGH : route === REVIEW_ROUTE.TRIVIAL ? REVIEW_RISK_TIER.LOW : REVIEW_RISK_TIER.MEDIUM,
		original_changed_lines: changedLines,
		correction_budget: correctionBudget(changedLines),
		diff_evidence: {
			event: REVIEW_EVENT.ORDINARY_START,
			changedLines,
			triviality:
				route === REVIEW_ROUTE.TRIVIAL
					? TRIVIALITY.PROVEN
					: TRIVIALITY.NON_TRIVIAL,
			evidenceComplete: true,
			executableChanged: route !== REVIEW_ROUTE.TRIVIAL,
			configurationChanged: false,
			hotPathChanged: false,
			riskSignal: selected === REVIEW_LENS.RISK,
			resilienceSignal: selected === REVIEW_LENS.RESILIENCE,
			reliabilitySignal: selected === REVIEW_LENS.RELIABILITY,
		},
		route,
		lenses: [...lenses],
		policy_hash: options.policyHash ?? "a".repeat(64),
		object_store: {
			snapshot_directory: "/test/repository/.git/gentle-ai/reviews/snapshots/test",
			object_directory: "/test/repository/.git/gentle-ai/reviews/snapshots/test/objects",
			alternate_object_directory: "/test/repository/.git/objects",
			metadata_path: "/test/repository/.git/gentle-ai/reviews/snapshots/test/snapshot.json",
			sensitivity: "workspace-content",
			cleanup_trigger: SNAPSHOT_CLEANUP_TRIGGER.LINEAGE_TERMINAL,
			cleanup_action: SNAPSHOT_CLEANUP_ACTION.DELETE_ISOLATED_STORE,
		},
	};
}
