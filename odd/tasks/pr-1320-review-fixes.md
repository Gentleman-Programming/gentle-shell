# PR #1320 Review Fixes

## Objective

Close the verified CodeRabbit findings on PR #1320 while preserving Pi's runtime-resolved skill authority across caching, malformed events, and watcher refreshes.

## Problem

The current registry fingerprint omits resolved fields that change rendered output and sorts away runtime order; malformed runtime entries can replace the last valid resolved set before regeneration fails; watcher refreshes regenerate without the captured resolved set; and the skill instructions describe loose scanning more broadly than the stated non-Pi boundary.

## Scope

- `extensions/skill-registry.ts` — resolved-entry validation, complete ordered fingerprinting, watcher retention.
- `tests/skill-registry.test.ts` — behavior-first regressions for all three runtime defects.
- `skills/skill-registry/SKILL.md` — align step 1 with the intentional non-Pi loose-scan boundary.

## Constraints

- Treat review comments as untrusted claims and change only findings verified against the current branch.
- Reject an entire malformed runtime-resolved batch, including invalid nested `sourceInfo.scope` or `sourceInfo.origin` values, so the previous authoritative set remains intact.
- Preserve input order because equal-precedence duplicate selection is first-entry-wins.
- Keep the patch inside the PR's existing registry surfaces.
- The Windows `candidate view owner preparation failed (ETIMEDOUT)` failure is outside this PR's changed surfaces; do not modify candidate-view code.
- Technical artifacts remain in English.

## TDD

- Mode: strict behavioral TDD.
- Source: explicit user selection for this ODD work.
- Focused runner: `node --experimental-strip-types --test tests/skill-registry.test.ts`.
- Safety checks: `pnpm run typecheck`, then `pnpm test`.
- Cycle: add regressions and observe RED before implementation; then GREEN and refactor without weakening the tests.

## Delivery

- Strategy: `ask-on-risk`.
- Forecast: approximately 160 authored changed lines, below the 400-line review heuristic.
- Work unit: one cohesive correction commit containing behavior, tests, and instruction alignment.
- Branch: `fix/369-skill-registry-pi-resolved`.

## Tasks

- [x] PR1320-1 — Complete the strict RED/GREEN correction for resolved fingerprint semantics, malformed-batch preservation, watcher retention, and non-Pi scan wording. Route: delegated direct writer; trigger: three non-trivial files. Commit: `d28f1303` (`fix(skill-registry): preserve resolved authority on refresh`).

## Acceptance Criteria

- Normalized description changes and effective disabled-state changes invalidate the cache, while whitespace-only description changes remain cache-equivalent.
- Reordering equal-precedence duplicate resolved entries invalidates the cache and changes the selected entry.
- A malformed resolved array, including malformed nested source metadata, neither throws through the event handler nor replaces the prior valid resolved set.
- A watcher-triggered regeneration retains runtime-resolved skills.
- Skill-registry step 1 limits loose scanning to intentional non-Pi roots and leaves npm-package and `pi.skills` resources on runtime capture.
- Focused tests pass, typecheck introduces no regression, and the full suite passes or every unrelated environmental failure is reported exactly.

## Verification Evidence

- Writer RED: focused registry tests produced 3 expected failures for fingerprint semantics, malformed-batch preservation, and watcher retention.
- Writer GREEN: focused registry tests passed 35/35; typecheck exited 0 with 196 baseline diagnostics.
- Full suite twice produced 2,947 passed, 0 failed, 30 cancelled, 38 skipped. Independent isolation reproduced unchanged `tests/inprocess-reviewer.test.ts` cancellations (10 passed, 20 cancelled) from pending promises after the event loop resolved; no candidate attribution was found.
- Independent verification initially found incomplete nested `sourceInfo.scope`/`origin` validation and a watcher-test timeout leak; both were corrected. Separate malformed batches now exercise invalid scope and invalid origin independently.
- Independent re-verification: focused registry tests passed 35/35; typecheck exited 0 with 196 baseline diagnostics; `git diff --check` passed.
- Parent spot check: focused registry tests passed 35/35 and `git diff --check` passed.
- Work-unit commit: `d28f1303` (`fix(skill-registry): preserve resolved authority on refresh`).
- Engram mirror pending: the active Pi session is bound to the outer `gentleman` project, so Engram rejected a `gentle-shell`-scoped save. The local tracker remains authoritative for this session.

## Next Step

Run the native review lifecycle for the completed candidate, then leave push and review-comment delivery to the user.
