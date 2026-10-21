# Usage Rows: Drop What Consumed Nothing

## Objective

The sidebar's Usage group prints one row per allowance window, including windows sitting at `0%`.
Drop the rows that round to `0%` on that surface — the sidebar is scanned, not read, and a row whose
number is `0%` tells the reader nothing. The bar and the panel keep printing a zeroed allowance, so a
subscription that consumed nothing stays verifiable where there is room to verify it.

## Problem / Why

User request after seeing commit `d366935c` rendered: rows nobody has touched only spend space in the
card that has the least of it.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- The threshold is the row's own number and nothing else: the render path prints `Math.round(percent)`,
  so a fraction below half a percent prints `0%` and leaves, while half a percent keeps its row and
  prints `1%`. No second scale and no separate epsilon.
- A window whose `usedPercent` is not a number never equals zero, so it keeps its row instead of being
  dropped in silence.
- The aggregate line of a provider without raw allowances is one row, so its windows decide together:
  one consumed window keeps the sharing row, all of them zero drop it. A limit with no windows is not
  "zero consumption" — there is nothing to draw, and `renderUsageBar` already answers that — so the rule
  only speaks when there is a window to judge.
- The bar and the panel keep their own contract and still print a zero allowance.
- Codex and Anthropic single-line behavior is otherwise unchanged; `allowanceGroupsSupported` still
  gates the multi-row branch.
- No delivery actions (no push, no PR) without an explicit user decision.

## Authorized edit surfaces

- `odd/tasks/nan-usage-zero-rows.md`
- `lib/shell-bar.ts`
- `tests/shell-bar.test.ts`
- `docs/gentle-shell.md`

## Tasks

- [x] NAN-Z1 — RED: lock the zero-row rule, the rounding boundary, the aggregate decision and the empty-window case.
- [x] NAN-Z2 — GREEN: filter the sidebar rows and the aggregate line in `lib/shell-bar.ts`.
- [x] NAN-Z3 — Update the docs and verify (focused tests, full suite, typecheck).

## Acceptance criteria

- A sidebar row that would print `0%` is not printed, on both the grouped branch and the aggregate branch.
- A window at exactly half a percent keeps its row and prints `1%`.
- A limit with no windows renders no aggregate line and is not reported as zero consumption.
- The bar and the panel still print the zeroed windows.
- Every sidebar line stays within the requested width, and the Usage group survives when nothing was consumed.
- Focused tests, `pnpm test`, and the typecheck pass.

## Progress

- 2026-09-18: implemented and green at the end of the implementing session, but left uncommitted with
  no tracker entry. No push, no PR, no review of this unit.
- 2026-09-18 (this session): RED gate reconstructed from the working tree (see evidence), tracker
  written, unit committed. Nothing was changed in the implementation.

## Verification evidence

- NAN-Z1 RED (reconstructed this session: `git stash push -- lib/shell-bar.ts`, new tests kept):
  `node --experimental-strip-types --test tests/shell-bar.test.ts` — 4 failed, 21 passed:
  `sidebar groups the NaN allowances by subscription without totals or resets` (assertion updated to the
  new shape), `sidebar drops an aggregate allowance that consumed nothing`,
  `sidebar keeps the Usage group when nothing was consumed`,
  `sidebar hides exactly the rows that would print 0%, rounding included`.
- NAN-Z2 GREEN: same command with `lib/shell-bar.ts` restored — 25 passed, 0 failed.
- Focused: `node --experimental-strip-types --test tests/shell-bar.test.ts tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/gentle-shell.test.ts` — 93 passed, 0 failed.
- Full suite: `pnpm test` — exit 0, 2697 tests, 2659 passed, 0 failed, 38 skipped; provider contract mirror check passed and the runtime harness ran clean.
- Typecheck: `pnpm run typecheck` — exit 0, 197 recorded diagnostics, no regressions; 2 file/code pairs improved.
- Commits: the work unit is the commit that carries this document — `feat(shell): hide the allowance rows that consumed nothing`.
- Previous units on this branch (for continuity): `7fd803fc`, `9bc7b9dd`, `8057b8af`, `8b3b35f6`, `4d04e0f7`, `f54d0772`, `8ec15406`, `047e044d`, `d366935c`.

## Next step

This commit closes the last work unit of the feature on `feat/nan-usage-sidebar`. The native review and
the PR are the user's decisions; the branch is delivered through the `egdev6/gentle-shell` fork because
this checkout's account has pull-only access to the upstream repository.
