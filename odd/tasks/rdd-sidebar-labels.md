# RDD sidebar labels

Locator: `odd/tasks/rdd-sidebar-labels.md` (worktree `gentle-pi-worktrees/rdd-sidebar-labels`, branch `feat/rdd-sidebar-labels` from `origin/main` 49c171ab4). Runs in parallel with `feat/rdd-section-visibility` (isolated worktree, user-approved); both touch the RDD group in `lib/shell-bar.ts`, the parent resolves the overlap when integrating.

## Objective

Make the `🌹 RDD` Status group read as what is happening and who acts, instead of internal state names; hide the file line when the candidate scope is unknown.

## Problem / why

"Closed" and "Approved · awaiting acknowledgement" read as if the user must do something, and "Candidate scope unavailable" reads as an error or a wait. User-reported with a screenshot.

## Scope

State labels (user-approved):

| State | Label |
|---|---|
| checking | Updating… |
| reviewing | Reviewers running… |
| in_review | Review in progress |
| forecast | Preparing reviewers… |
| ready | Not reviewed yet |
| consent | Needs your consent |
| correction | Fixing findings… |
| approved | Approved · finalizing… |
| closed | ✓ Approved |
| declined | Skipped for this change |
| invalidated | Outdated · code changed |
| unavailable | Review unavailable |
| unknown | Status unknown |

Scope line: known scope renders `first.ts +N files` (singular `+1 file`); unknown scope renders no line.

## Constraints

- Display only: no change to snapshot derivation, publisher correlation, or review authority.
- Keep `REVIEW_SCOPE_UNAVAILABLE` as the internal sentinel (snapshot validation requires a non-empty scope); only rendering omits it.

## Tasks

- [x] T1 — Labels + scope wording in `lib/review-sidebar-state.ts`, scope-line omission in `lib/shell-bar.ts`, tests. Route: delegated direct (one writer; 2+ files).

## Checks

- Focused: `node --experimental-strip-types --test tests/review-sidebar-state.test.ts tests/shell-bar.test.ts`
- `node --experimental-strip-types --test tests/*.test.ts`, `node scripts/check-types.mjs`, `node scripts/check-provider-contract.mjs`, `node --experimental-strip-types tests/runtime-harness.mjs`.

## Progress

- T1 (delegated writer, uncommitted, awaiting parent commit): labels replaced per table; `candidateScope` renders `first +1 file` / `first +N files`; `shell-bar.ts` RDD group omits the scope line when scope is `REVIEW_SCOPE_UNAVAILABLE`. Diff: 4 files, +70/−34.
  - RED: focused suites 56 tests, 7 failing on new/updated assertions (label table, `+N files`, sentinel omission).
  - GREEN: focused suites 56/56 pass.
  - Full suite: 3974 tests, 3929 pass, 2 fail, 43 skipped. Failing: `tests/gentle-shell.test.ts:370` and `:392` assert `/Checking/` (old `checking` label, now `Updating…`); outside T1's allowed surfaces, needs a one-word assertion update (`/Updating…/`).
  - `check-types`: 188 recorded, no regressions. `check-provider-contract`: pass. `runtime-harness`: exit 0.

## Delivery

Forecast ~60 lines; single PR.

## Closure evidence

- Supersedes the writer's partial Progress note: the two `tests/gentle-shell.test.ts` assertions (lines 370, 392) that still matched the old `Checking` label were updated by the parent to `Updating…`.
- Commit `66f574b56`. Route: delegated direct (gentle-ai-worker) plus a parent mechanical test-string fix.
- Checks: focused 279/279 (gentle-shell, review-sidebar-state, shell-bar); unit stage 3931 pass / 0 fail / 43 skipped; check-types no regressions; provider-contract pass; harness exit 0.
- Native review `review-f837dc6e7581e272` (medium, reliability) approved and acknowledged.
