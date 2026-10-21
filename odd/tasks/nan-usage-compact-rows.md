# Usage Rows: No Totals, Inline Resets

## Objective

The user asked for two space wins in the usage surfaces: drop the `nan total` / `glm total`
aggregate rows from the sidebar and the panel, and print each panel row's reset on the same line as
its name, meter and percentage instead of a line underneath.

## Problem / Why

"los totales de nan y glm puedes ocultarlos, no aportan mucho y ganamos espacio. Tanto en el sidebar
como en el panel. En el panel puedes colocar los resets en la misma linea que el resto."

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- The aggregate math stays: the bar's fallback ladder (exact model → family total → account total →
  `limits[0]`) still needs `allowanceTotal` for a session model with no allowance of its own. Only the
  rendered rows go.
- The family ordering survives the totals: families stay together, families sort by what they consume
  and members by usage, so the panel and the sidebar keep reading most-consumed first.
- Codex and Anthropic keep their existing rows and order; `allowanceGroupsSupported` still gates the
  reordering and the sidebar's multi-row branch.
- A row whose window reports no reset ends at its percentage; no dangling separator.
- No delivery actions (no push, no PR) without an explicit user decision.

## Authorized edit surfaces

- `odd/tasks/nan-usage-compact-rows.md`
- `lib/shell-usage.ts`
- `lib/shell-bar.ts`
- `tests/shell-usage.test.ts`
- `tests/shell-usage-view.test.ts`
- `tests/shell-bar.test.ts`
- `docs/gentle-shell.md`

## Tasks

- [x] NAN-C1 — RED: lock the total-free rows and the inline reset with failing tests.
- [x] NAN-C2 — GREEN: order the limits without emitting aggregate rows, and print the reset inline.
- [x] NAN-C3 — Update the docs and verify (focused tests, full suite, typecheck).

## Acceptance criteria

- The panel lists no row whose name ends in `total`, for any provider, and still lists every model
  allowance in the family-then-usage order.
- A panel row that reports a reset prints `name meter percent · resets in …` on one line; a row
  without one ends at the percentage.
- The sidebar lists the same model rows it lists today minus the totals, and still prints no
  `resets in`.
- The bar keeps naming the aggregated allowance when the session model has none (`nan total …`).
- Focused tests, `pnpm test`, and the typecheck pass.

## Progress

- 2026-09-18: user asked for both changes after seeing the grouped commit `047e044d` rendered.

## Verification evidence

- NAN-C1 RED: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/shell-bar.test.ts` — 5 failed (`renderUsagePanel lists each provider with meters, resets, and a stale marker`, `…lists each NaN model allowance with its reset on the same row`, `…orders the NaN allowances by family and prints no totals`, `UsageView frames the panel…`, `sidebar groups the NaN allowances by subscription without totals or resets`), 40 passed (the 5 failures were the old totals and the reset-under-the-meter shape).
- NAN-C2 GREEN: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/shell-bar.test.ts tests/gentle-shell.test.ts` — 89 passed, 0 failed.
- Full suite: `pnpm test` — exit 0, 2693 tests, 2655 passed, 0 failed, 38 skipped; provider contract mirror passed and the runtime harness ran clean.
- Typecheck: `pnpm run typecheck` — exit 0, 197 recorded diagnostics, no regressions.
- Render through the product code (no network), panel at 80 columns: `deepseek-v4-flash 18% · resets in 13d 0h`, `glm5.3-flash 10% · …`, `glm5.2 1% · …`, `glm5.3 0% · …` — four rows, no `total` row, one line per window. Sidebar at 60 columns: the same four rows in the same order, ending at the percentage.
- Kept deliberately: `allowanceTotal` still backs `selectUsageLimit`, so the bar keeps naming the aggregated allowance (`nan total …`) when the session model has no allowance of its own; `renderShellBar` tests covering that ladder pass unchanged.

## Next step

Verified on `feat/nan-usage-sidebar`. Nothing is pushed; the native review and the PR remain the user's decisions. The review candidate is this commit.
