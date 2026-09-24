# NaN Usage: Grouped Sidebar Rows

## Objective

The sidebar Usage group prints one aggregate line (`renderUsageBar`), so a NaN session shows a single
allowance while `/gentle:usage` shows the grouped breakdown. Print the same grouped rows in the
sidebar — account total, family totals, models — without the reset dates, which stay in the panel.

## Problem / Why

Reported by the user: "en el sidebar no veo la visualización agrupada como en el panel". The bar line
was deliberately scoped to the active model, but the sidebar is the surface that never needs opening,
so the grouped view has to be readable there too.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- Codex and Anthropic sidebar output stays byte-identical: grouping only runs when the provider
  reports raw allowance numbers (`allowanceGroupsSupported`), which only `parseNanQuota` produces.
- The grouped rows reuse the panel's order and its percent meaning (`Σ used / Σ budget`); no new
  aggregation and no new data model.
- No reset lines in the sidebar: `resets in` belongs to the panel, which has the room.
- The one-line status bar (`renderShellBar`) keeps following the active model, unchanged.
- The sidebar must not overflow at any width; the card wraps and the names give way first.

## Authorized edit surfaces

- `odd/tasks/nan-usage-sidebar-groups.md`
- `lib/shell-bar.ts`
- `tests/shell-bar.test.ts`
- `docs/gentle-shell.md`

## Tasks

- [x] NAN-S1 — RED: lock the grouped sidebar rows, the absent resets and the Codex guard.
- [x] NAN-S2 — GREEN: render the grouped rows in the sidebar's Usage group.
- [x] NAN-S3 — Update the docs and verify (focused tests, full suite, typecheck).

## Acceptance criteria

- A NaN session sidebar lists `nan total`, the family totals and the per-model rows in the panel's
  order and with the panel's percentages.
- No line in the sidebar contains `resets in`.
- A Codex (or any non-NaN) sidebar keeps its single aggregate line, unchanged.
- Every sidebar line stays within the requested width.
- Focused tests, `pnpm test`, and the typecheck pass.

## Progress

- 2026-09-18: user chose "agrupado por sub (NAN) sin info de reset" over the single-line and the
  full-panel-with-resets options.

## Verification evidence

- NAN-S1 RED: `node --experimental-strip-types --test tests/shell-bar.test.ts` — 1 failed, `sidebar groups the NaN allowances by subscription without the panel resets` (actual `['glm5.3-flash']`, expected the six grouped rows); the Codex guard test passed against current behavior.
- NAN-S2 GREEN: `node --experimental-strip-types --test tests/shell-bar.test.ts tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/gentle-shell.test.ts` — 89 passed, 0 failed.
- Full suite: `pnpm test` — exit 0, 2693 tests, 2655 passed, 0 failed, 38 skipped; provider contract mirror passed and the runtime harness ran clean.
- Typecheck: `pnpm run typecheck` — exit 0, 197 recorded diagnostics, no regressions.
- Render through the product code at width 60 with the live payload shape (6 models, two of them unmetered): `nan total 7%`, `deepseek-v4-flash 18%`, `glm total 3%`, `glm5.3-flash 10%`, `glm5.2 1%`, `glm5.3 0%`, and no `resets in` line anywhere in the card.
- Existing assertion updated (intentional shape change): the sidebar assertion inside `renderShellBar meters the model the session is using inside a multi-model provider` now matches the padded grouped row `glm5.3-flash … 10%` instead of the old single line. Codex and Claude sidebar output is unchanged and guarded by a new test.

## Next step

Superseded before review by `odd/tasks/nan-usage-compact-rows.md`: the user asked to drop the `nan total` / `glm total` rows from both surfaces and to print the panel's resets inline, so the reviewed candidate starts one commit later. Nothing is pushed; the native review and the PR remain the user's decisions.
