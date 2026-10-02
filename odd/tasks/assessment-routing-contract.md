# Assessment routing contract (issue #1175)

Locator: `odd/tasks/assessment-routing-contract.md` · Engram mirror: `odd/assessment-routing-contract/tasks` (project `gentle-pi`)

Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1175 (`status:approved`, expanded with the three changes)
Branch: `fix/assessment-routing-contract` (base `origin/main` ecf23cf66)

## Objective

Make `gentle_review` ASSESS compatible with the native assessment contract, reuse the
runtime-resolved writer profile and validated native closure evidence instead of model
re-declarations, and align the verification policy across the tool description,
`assets/orchestrator-delegation.md`, and `docs/delegated-verification.md`.

## Problem / why

- `decodeReason` requires `path` and `detail`, while the native v2 `assess.schema.json`
  requires only `code`; valid native envelopes are reported as unassessable.
- The projection drops `candidate.consumed`, `review_due`, `review_due_reason`, and
  `next_transition`.
- The model re-declares `writerModelId`/`writerEffort` although the runtime already
  resolved them; an explicit `nativeReviewOutcome: closed` wins without checking the
  exact candidate.
- Policy prose diverges between tool description, orchestrator asset, and docs.

## Scope and constraints

- Gentle Shell only; no Go changes (stop and explain if Go is required).
- Accept supported older envelopes without inventing fields or authority; validate
  supported extra fields; never rebuild opaque native continuations.
- Closure must match the exact candidate; unknown/changed/mismatched evidence stays
  fail-closed. Message acceptance or task completion is never review closure.
- Preserve: RDD on + valid closure for this candidate; declined/unavailable/unknown
  fallback; conservative bias for unknown/mini/low profiles (gemini is not mini);
  functional checks; human consent, RDD switch, native authority.
- No new policy engine or state machine. No provider mirror or byte-pinned docs edits.
- Do not patch the installed package under `~/.local/lib/node_modules`.
- Preserve untracked `odd/tasks/herdr-shell-notifications.md` and
  `odd/tasks/tool-argument-watchdog.md`.

## Tasks

- [x] T1 — Assessment decoder/projection compatible with the native contract (+ tests). Commit `80043b5a1`.
- [x] T2 — Runtime writer profile and exact-candidate closure evidence (+ tests). Commit `1ac00aa33`.
- [x] T3 — Consistent verification policy in tool description, asset, and docs (+ tests if pinned). Commit `8cc8eb03d`.
- [ ] T4 — Single PR against `main` closing #1175 with real check evidence.

Route per task: delegated direct (one `gentle-ai-worker` at a time; 2+ non-trivial files).

## Candidate allowed edit surfaces (confirmed per task before launch)

- lib/review-risk-assessment.ts
- extensions/gentle-ai.ts
- assets/orchestrator-delegation.md
- docs/delegated-verification.md
- lib/agents-runner.ts (only if needed to reach existing facts)
- focused tests (assessment, routing, verification facts)
- runtime/review-risk-assessment.mjs (generated via `pnpm run build:runtime-modules`)
- T2 additions approved by the user (2026-09-30): lib/review-reminder-receipt.ts,
  extensions/gentle-agents.ts, tests/review-reminder-receipt.test.ts

## Mapped facts (read-only scout, 2026-09-30)

- Native `candidate.consumed=true` is written only inside the approved-acknowledgement burn
  (gentle-ai `compact_burn.go`: approved state + exact target identity + ack token) and is
  exact-candidate closure evidence. `review_due`/`consumed` landed in gentle-ai 874719ae0,
  not contained in the pinned v3.7.0, so older envelopes must stay accepted.
- The resolved writer model/thinking lives on the gentle-agents `TaskRecord`; gentle-ai.ts
  cannot reach it. Bridge: carry it on the existing review-mutation receipt.
- `assets/orchestrator-delegation.md` sentences are pinned by
  `tests/rdd-aware-verification-contract.test.ts`; `docs/delegated-verification.md` is not pinned.
- No Go change required.

## Design decisions

- T2 closure: derive `closed` only from native `candidate.consumed === true`; a caller-declared
  `closed` without that corroboration becomes `unknown` (fail-closed). Declined/unavailable
  keep their conservative fallback.
- T2 profile: runtime-recorded profile per pending mutation receipt; any small/unknown → small;
  no runtime evidence → existing behavior. Never more permissive than today.

## Checks

- `node --experimental-strip-types --test <focused tests>`
- `pnpm run build:runtime-modules` (normalizer, before final checks)
- `pnpm run check:runtime-modules`
- `pnpm run typecheck`
- `pnpm test` not run blindly: side effects under review.

Risk tier: high (public contract + review authority boundary) → writer self-verification
plus independent verifier; RDD is on globally, native review consent stays human-owned.

## Delivery

- Strategy: `single-pr` (user decision). Forecast 500–780 authored lines excluding generated.
- `size:exception` AUTHORIZED by the user (2026-09-30) with reason: "Single PR requested by the
  maintainer for three coupled changes (native assess decoder compatibility, runtime writer
  profile + exact-candidate closure evidence, policy text alignment); ~60% of authored lines
  are regression tests; each work-unit commit was natively reviewed separately".
  Running authored total after T2: 1016 lines excluding runtime/.
- PR: against `main`, `Closes #1175`, exactly one `type:*` label (`type:bug`). No release.
- Merge AUTHORIZED by the user (2026-09-30, superseding the earlier no-merge instruction):
  merge commit, only after the local independent verifier and the PR CI checks are green and
  there are no conflicts. `git merge-tree` against origin/main 9553a7146: clean. PR CI
  (`ci.yml` on pull_request) runs `pnpm test`, typecheck, runtime modules, package files and
  packed package on the merge ref.

## Progress

- 2026-09-30: branch created; mapping done. Baseline focused tests on origin/main: 124 pass.
- T1 (route: delegated direct, writer trigger: 3 non-trivial files; risk: high):
  - Writer muo0zl6n-2-h6v9. RED: 9 failing tests (reason with only code, new fields,
    malformed/pair/next_transition rejection, extension projection). GREEN: 75/75.
  - `pnpm run build:runtime-modules`: only runtime/review-risk-assessment.mjs regenerated.
  - Focused tests (review-risk-assessment, native-review-cli, rdd-aware-verification-contract):
    136 pass / 0 fail (writer), re-run by parent: 136 pass / 0 fail.
  - `pnpm run check:runtime-modules`: match (writer + parent). `pnpm run typecheck`: no regressions (writer).
  - Native review (RDD on, host-resolved consent): lineage review-a921d9e5289f11b1, medium,
    lens review-reliability, approved; acknowledged, authority burned for target
    sha256:4fec3e84…. Advisory non-blocking findings R3-001 (lib/review-risk-assessment.ts:105-106,
    WARNING) and R3-002 (:156, SUGGESTION).
  - Commit `80043b5a1` tree e93fee63… equals the reviewed candidate tree.
  - Authored lines: ~350 (excluding runtime/).
  - Follow-up folded into T2: enforce review_due/review_due_reason/consumed consistency so a
    contradictory envelope can never count as closure.

- T2 (route: delegated direct, writer trigger: 5 non-trivial files; risk: high):
  - Writer muo1lj47-3-z917. RED: 14/91 failing in review-risk-assessment (3 decoder
    consistency, 11 ASSESS closure/profile); receipt and gentle-agents tests failed at module
    load (missing `pendingReviewMutationProfiles` export). GREEN: 91/91, 7/7, 11/11.
  - Behavior: `closed` derived only from same-call `candidate.consumed === true`; caller
    `closed` without it → `unknown`; explicit or memo declined/unavailable wins; contradictory
    review_due/reason/consumed rejected. Runtime model/effort recorded on mutation receipts
    (never `"default"`); ASSESS profile from pending receipts (missing/small → small); caller
    input only without receipts; projected `writerProfileSource`.
  - Focused tests (5 files): 318 pass / 0 fail (writer), parent re-run 318 / 0.
  - `check:runtime-modules`: match (writer + parent). `typecheck`: no regressions (writer).
  - Native review: lineage review-ef46f7c571859929, medium, review-reliability, approved,
    acknowledged, authority burned for target sha256:b94ff88a…. Advisory non-blocking:
    R3-001 lib/review-reminder-receipt.ts:88-93 (WARNING), R3-002 extensions/gentle-ai.ts:973,
    R3-003 :920-937, R3-004 :898-902 (SUGGESTION).
  - Commit `1ac00aa33` tree ac4cd04d… equals the reviewed candidate tree.
  - Authored lines: ~672 (excluding runtime/), mostly tests. Running total ~1022 > forecast.
  - Known gap: direct-mutation profile recording (`tool_result` handler) has no dedicated test.

- T3 (route: delegated direct, writer trigger: 4 files incl. prose + test; risk: medium, text-only):
  - Writer muo21di1-4-2wmc. RED: 2/23 failing consistency tests (missing shared closure phrase,
    stale "closed is never derived"). GREEN: 23/23. No pinned sentence changed.
  - ASSESS guidance lives in `promptGuidelines`; asset gained two trigger-5 sentences; docs got
    an outcome precedence table, writer-profile and projection sections, functional-checks note.
  - 8 contract/routing test files: 194 pass / 0 fail (writer + parent re-run).
  - `check:runtime-modules`, `typecheck` (no regressions), `verify-package-files` pass (writer).
  - Native review: lineage review-3b65703d06f6ac90, medium, approved, acknowledged, authority
    burned for target sha256:0e4d41d0…. Advisory non-blocking: R3-001/R3-002 WARNING in
    tests/rdd-aware-verification-contract.test.ts:253-271/:287-293; R3-003, R3-004 SUGGESTION.
  - Commit `8cc8eb03d` tree 4fb83b28… equals the reviewed candidate tree. Authored lines: 109.
- Running authored total: ~1125 lines excluding runtime/.
- Branch verification (independent gentle-ai-verify muo29oc6-5-b4s4, status partial):
  - `pnpm run check:provider-contract`: exit 0. `pnpm run typecheck`: exit 0, no regressions.
  - `pnpm run check:runtime-modules`: exit 0. `node scripts/verify-package-files.mjs`: exit 0.
  - `node --experimental-strip-types --test tests/*.test.ts`: did not finish locally (hang).
    Per-file run: 4206 tests, 4147 pass, 17 fail, 1 cancelled, 41 skipped. Failing files:
    append-system-prompt-route, review-contract-prompt, telemetry-trigger,
    review-agent-end-preflight (hangs). Pre-existing: identical failing test set on merge-base
    ecf23cf66; none of those files is touched by the branch; they pass on current origin/main
    9553a7146 (Pi 0.99.1). Local node_modules has pi-coding-agent 0.87.1 (environmental).
  - Runtime harness (`test:harness`) not run locally: writes to tmpdir and runs `git init`;
    PR CI runs it through `pnpm test` on the merge ref.
  - Diff review: no debug code/TODOs, no fixtures/skills/AGENTS.md changes; only
    runtime/review-risk-assessment.mjs generated.

## Next step

T4: push branch, open PR (Closes #1175, `type:bug`, `size:exception`), wait for PR CI, merge
commit if green and conflict-free.
