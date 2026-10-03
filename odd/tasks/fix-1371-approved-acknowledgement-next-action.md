# Additive next_action for approved review acknowledgement (#1371)

- Feature: `fix-1371-approved-acknowledgement-next-action`
- Branch: `fix/1371-approved-acknowledgement-next-action` (base `upstream/main` ef55af79)
- Engram mirror: `odd/fix-1371-approved-acknowledgement-next-action/tasks` (offline/unavailable)
- TDD: strict; runner `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts`
- Delivery: `single-pr`; work-unit commits per task
- RDD: off (global)

## Objective

Provide clear, additive machine guidance (`next_action`) in approved last-event closure envelopes and approved STATUS mappings specifying the exact `gentle_review {"operation":"acknowledge-approved","lineageId":"..."}` facade invocation, preventing machine callers from passing raw native CLI arguments and hitting `controller-only-input` refusals.

## Problem

When a review closes as `approved`, the last-event closure envelope and bound STATUS mapping republish the provider's raw acknowledgement continuation carrying positional arguments (`cwd`, `lineage`, `target`, `expected-revision`, `token`). Machine callers pass those arguments to `gentle_review`, which rejects them with `controller-only-input` because the facade re-derives the one-time token from native status internally and only accepts `lineageId` (and `workspaceRoot`). Callers burn an unnecessary round-trip before seeing the post-refusal hint.

## Scope

In:
- `extensions/gentle-ai.ts`:
  - In `mapLastEventClosure`: when `closure.acknowledgement` is present, add an additive `next_action` naming the exact facade call `gentle_review {"operation":"acknowledge-approved","lineageId":"..."}`, preserving `workspaceRoot` when provided and distinct from process cwd, alongside the untouched raw continuation.
  - In `mapNativeTargetStatus`: when `nextTransition.execute.operation === "review.acknowledge-approved"`, add the additive `next_action` naming the exact facade call.
- `tests/review-controller-native-routing.test.ts`: Add tests asserting `next_action` presence and correctness for approved closure and approved STATUS mapping, including `workspaceRoot` propagation.

Out:
- Any modification of provider-issued raw continuations.
- Changes to Go binary or admission logic.

## Tasks and routes
- [x] T1 (strict TDD tests) — Write failing tests in `tests/review-controller-native-routing.test.ts` asserting additive `next_action` on approved closure envelopes and approved STATUS mappings.
- [x] T2 (implementation) — Add additive `next_action` in `mapLastEventClosure` and `mapNativeTargetStatus` in `extensions/gentle-ai.ts`.
- [x] T3 (verification) — Run review controller test suite, typecheck, and verify zero regressions.

## Progress
- 2026-09-23: Wrote 4 strict regression tests in `tests/review-controller-native-routing.test.ts` asserting additive `next_action` on approved last-event closure envelopes and approved STATUS mappings, verifying preservation of untouched raw acknowledgement continuation, and verifying `workspaceRoot` propagation when distinct from process cwd. Tests initially failed with `undefined`.
- 2026-09-23: Implemented additive `next_action` in `mapLastEventClosure` and `mapNativeTargetStatus` in `extensions/gentle-ai.ts`, dynamically including `workspaceRoot` when provided and distinct from process cwd. Also updated `next_action` in `acknowledge-approved` input refusal to supply the exact self-healing command.
- 2026-09-24: Addressed review feedback from danielgap and CodeRabbit: ensured invalid-input refusal compares workspaceRoot against the implicit resolved root and added strict regression tests in `tests/review-controller-native-routing.test.ts` for self-healing next_action on canonical lineages (with and without workspaceRoot) and fallback slug on invalid/non-canonical lineages; passed workspaceRoot across mapNativeTargetStatus and staleConsentBindingOutcome call sites.
- 2026-09-24: Verified suites: `tests/review-controller-native-routing.test.ts` (78/78 passed), `npm run typecheck` (0 regressions, 195 baseline diagnostics).
- 2026-09-23: Verified suites: `tests/review-controller-native-routing.test.ts` (77/77 passed), `npm run typecheck` (0 regressions, 195 baseline diagnostics), and `npm run check:provider-contract` (passed).

## Verification
- `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts`
- `npm run typecheck`
- `npm run check:provider-contract`
