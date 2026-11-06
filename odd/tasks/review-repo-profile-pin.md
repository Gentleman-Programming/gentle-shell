# Issue #1544: Review host relay ignores the repository profile pin

## Objective

Make the review host relay honor the per-repository profile pin: both relay
selection callsites resolve the pinned profile before falling back to global
routing, with whole-profile precedence and no ambient account substitution.

## Problem

The native single and grouped review capture paths call
`reviewHostRelaySelection` with `readModelConfig(cwd)`, which reads only the
global `models.json`. A repository that pins a profile via
`gentle-ai/profile-pin.json` (local) or `.pi/gentle-ai/profile.json` (repo
declaration) still launches its reviewers with the global routing, so two
repositories worked in parallel fight over one global reviewer configuration —
the exact problem the pin was introduced to solve (gentle-shell#1544).

## Scope

- In `extensions/gentle-ai.ts`: use `pinnedEffectiveModelConfig(cwd) ??
  readModelConfig(cwd)` at both `reviewHostRelaySelection` callsites (single
  capture and grouped capture). The existing resolver precedence (local pin >
  repo declaration > global, with sibling-worktree-aware common-dir
  resolution) is reused untouched.
- Whole-profile precedence, not a per-role merge: if a valid pinned profile
  lacks a required reviewer role, the native fail-closed
  `reviewer-config-invalid` refusal stands; no silent fallback to another
  account's routing.
- In `tests/review-host-relay-routing.test.ts`: deterministic tests for single
  pin routing, group pin routing, no-pin global fallback, repo-declaration
  routing, missing-role refusal (single and group), and stale-pin fallback.

## Constraints

- No commits, pushes, labels, or PRs; issue #1544 approval is tracked by the
  parent orchestrator.
- Bounded change (~300 authored lines); tests are not cut to fit the budget.
- Strict TDD: RED observed before the implementation change.

## Tasks

- [x] **T1 — RED: failing relay routing tests for pin precedence.** 5 pin-precedence tests failed against unmodified source (pin ignored; group even launched with models.json routing); no-pin and stale-pin controls passed, encoding preserved global behavior.
- [x] **T2 — GREEN: resolve the pin at both relay callsites.** All 38 relay-routing tests pass, including the 7 new pin tests.
- [x] **T3 — Focused verification: relay routing + profile-pin tests, typecheck.** 58/58 focused tests pass; recorded-diagnostics typecheck shows no regressions. Full `pnpm test` suite not run (see handoff notes).
