# Retain the inspected committed selector when inspect resolves ready

## Objective

A plain `gentle_review` START that follows an `inspect` with `baseRef`/`committedOnly` must review exactly the inspected committed range, also when that inspect needed no untracked-path decision.

## Problem

Every `inspect` clears the pre-lineage retained selection (`extensions/gentle-ai.ts` ~7658). It is rewritten with `baseRef`/`committedOnly` only on the `untrackedScope` submission path (~7761-7776) or as a stop selector with `selectionBinding` (~7684), which `readRetainedPreLineageNativeUntrackedSelection` (~6408) excludes. A plain inspect (no `untrackedScope`) that resolves ready stores nothing, so the next plain START (~8196-8296) calls a selectorless STATUS and adopts the native default base-ref (merge-base, #874 `offeredCommittedRangeBaseRef`).

Observed: after lineage L1 reviewed `C0..C1`, `inspect {baseRef: C1, committedOnly: true}` returned the 5-path slice target, but the following START created L2 over the whole branch from `C0` (7 paths, a different target identity).

## Why

The #1192 fix covered only the untracked submission path; the ready path was never exercised by tests (`tests/review-controller-native-routing.test.ts` #1192 tests always pass `untrackedScope`). The native binary behaved correctly.

## Scope

- Retain `baseRef`/`committedOnly` (and the inspected target identity) for a ready plain inspect so START reuses them.
- Deterministic tests for the ready path; existing #1192 behavior unchanged.

## Constraints

- Do not weaken target binding: START must still refuse or re-resolve when the candidate changed since inspect, as today.
- No changes to byte-pinned contract docs (`scripts/verify-package-files.mjs`). Technical artifacts in English.

## Tasks

- [x] T1 Retain the ready-inspect committed selector and cover it with RED/GREEN tests. Route: delegated (writer; 4+ files to understand). A ready plain inspect now stores `{targetIdentity, candidateTree, baseRef, committedOnly}` under the pre-lineage key; untracked fields became optional on `RetainedPreLineageNativeUntrackedSelection`, and START adopts untracked fields only when the entry recorded a decision. Three new tests: ready inspect then START uses its base; a second ready inspect replaces the first; a changed candidate is refused with `native-start-retained-selection-candidate-mismatch`. RED: 77/80, GREEN: 80/80.

## Acceptance criteria

- `inspect {baseRef, committedOnly: true}` without `untrackedScope` that resolves ready, followed by `start {mode: "ordinary"}`, starts native review with that `baseRef` and `committedOnly`.
- The existing #1192 submission-path tests still pass.

## Checks

- Focused routing tests, `node --experimental-strip-types --test tests/*.test.ts`, `node scripts/verify-package-files.mjs`, `node scripts/check-provider-contract.mjs`, `node --experimental-strip-types tests/runtime-harness.mjs`, `node scripts/check-types.mjs`.

## Delivery

- Strategy: `ask-on-risk`. Forecast: under 200 authored changed lines.
- RDD: on (global). Repository policy: approved issue required before PR.

## Progress

- Worktree: `../gentle-pi-worktrees/review-ready-inspect-selector`, branch `fix/review-ready-inspect-selector` from `origin/main` (53d62fbf3).

## Verification evidence

- `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts`: 80 pass (writer and parent).
- `node --experimental-strip-types --test tests/*.test.ts`: 3900 pass, 0 fail, 43 skipped (Windows-only).
- `node scripts/verify-package-files.mjs`: pass (writer and parent). `node scripts/check-provider-contract.mjs`: pass. `node --experimental-strip-types tests/runtime-harness.mjs`: exit 0. `node scripts/check-types.mjs`: no regressions.

## Next step

Deliver: approved issue, then pull request.
