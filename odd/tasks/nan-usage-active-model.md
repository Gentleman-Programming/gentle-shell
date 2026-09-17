# NaN Usage: Active-Model Bar + Family Groups

## Objective

Fix the live defect reported by the user ("el consumo de glm no sale"): the shell bar always paints
`usage.limits[0]`, so a NaN session using `glm5.3-flash` shows the first model the server happens to
list (`deepseek-v4-flash`). Make the bar follow the session model, and group the NaN per-model
allowances by family in the `/gentle:usage` panel without inventing any UI element that Codex and
Anthropic do not already have.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- Panel grammar stays the shared one: `limit name` line plus `window gauge percent reset` lines.
  Groups and the account total are ordinary limit blocks, never headers, never token/cap columns.
- Aggregates are weighted by allowance (`ΣtokensUsed / Σcap`). Averaging percentages is forbidden.
- An aggregated row carries no reset: its members close on different dates (2026-10-01 vs 2026-10-17).
- Codex and Anthropic behavior is unchanged, and that is enforced by a guard rather than by a promise:
  aggregation only runs when every emitted limit's first window carries raw numbers, which only
  `parseNanQuota` can produce.
- `parseNanQuota` stays a faithful mapping of the payload; grouping is a presentation decision.
- No secret is logged, rendered, or persisted; no new network call.
- No delivery actions (no push, no PR) without an explicit user decision.

## Authorized edit surfaces

- `odd/tasks/nan-usage-active-model.md`
- `lib/shell-usage.ts`
- `lib/shell-bar.ts`
- `tests/shell-usage.test.ts`
- `tests/shell-bar.test.ts`
- `docs/gentle-shell.md`

## Source contract (unchanged)

`GET https://cloud-api.nan.builders/api/usage/quota` returns `{ periodStart, models: [...] }`; each
model carries `model`, `cap`, `tokensUsed`, `periodEnd`, and optionally the rolling-window fields.
Verified live on 2026-09-17/18: 6 models, `deepseek-v4-flash` first, no `windowTokensUsed` in any
entry (so the rolling `4h` row never renders on real data).

## Decisions

- Bar ladder: **exact model → family total → account total → `limits[0]`**. The last rung is today's
  behavior, kept as the fallback for payloads without raw numbers.
- Bar label: the full model id (user's choice).
- Panel: `nan total` account row when two or more limits exist, `glm total`-style family rows when a
  family has two or more metered models, families sorted by allowance desc, members by usage desc.
- Single-member families emit no group row: it would duplicate the only member.

## Tasks

- [x] NAN-A1 — RED: lock the bar selection ladder and the raw window numbers with failing tests.
- [x] NAN-A2 — GREEN: keep `used`/`budget` on the NaN period window and select the bar limit by active model.
- [x] NAN-A3 — RED: lock the grouped panel (account row, family rows, no aggregate reset, provider guard) with failing tests.
- [x] NAN-A4 — GREEN: group the limits in the view layer without touching the parser contract.
- [x] NAN-A5 — Wire the bar to `ShellBarModel.modelId`, update the docs, verify (focused tests, full suite, typecheck).

## Acceptance criteria

- A NaN session using `glm5.3-flash` shows `glm5.3-flash period ▰… 10%` in the bar.
- A NaN session whose model is not metered shows the account total (`nan total period ▰… 6%`).
- The panel lists `nan total` and `glm total` as normal limit blocks, and the per-model rows stay.
- Aggregate rows carry no `resets in`.
- Codex and Anthropic bar and panel output is byte-identical to before these changes.
- `renderUsageBar(usage, theme)` with two arguments keeps today's behavior; existing tests need no edit.
- Focused tests, `pnpm test`, and `pnpm run typecheck` pass.

## Progress

- 2026-09-18: user authorized C + grouping after seeing rendered mockups against the live payload.
- 2026-09-18: NAN-A1..A5 closed. Commits `8057b8af` (raw numbers + bar ladder + tests), `8b3b35f6` (grouping + panel + tests), `4d04e0f7` (bar wiring, docs).

## Verification evidence

- NAN-A1 RED: `node --experimental-strip-types --test tests/shell-usage.test.ts` — 3 failing (`renderUsageBar prefers…`, `…without raw allowances…`, `parseNanQuota keeps the raw numbers…`).
- NAN-A2 GREEN: 20 passed, 0 failed.
- NAN-A3 RED: 2 failing (`renderUsagePanel groups…`, `renderUsagePanel lists the NaN account total…`).
- NAN-A4 GREEN: `tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/shell-bar.test.ts tests/gentle-shell.test.ts` — 86 passed, 0 failed.
- NAN-A5 RED: `tests/shell-bar.test.ts` failed with the bar drawing `deepseek-v4-flash period ▰▱▱▱▱▱▱▱ 18%` inside a `glm5.3-flash` session; GREEN after passing `model.modelId`: 43 passed, 0 failed across the usage and bar suites.
- Full suite: `pnpm test` — exit 0, 2691 tests, 2653 passed, 0 failed, 38 skipped, provider contract mirror passed, runtime harness ran clean.
- Typecheck: `pnpm run typecheck` — exit 0, 197 recorded diagnostics, no regressions, and 2 file/code pairs improved (baseline left untouched: it is outside this change's edit surfaces).
- Live check with the real payload and the product code (`GET /api/usage/quota` → HTTP 200, 2026-09-18 ~01:20 CEST): `glm5.3-flash → glm5.3-flash period ▰▱▱▱▱▱▱▱ 10%`, `deepseek-v4-flash → deepseek-v4-flash period ▰▰▱▱▱▱▱▱ 19%`, `qwen3.6` and `gemma4` (unmetered) → `nan total period ▰▱▱▱▱▱▱▱ 6%`; panel shows `nan total`, `deepseek-v4-flash`, `glm total`, then the three GLM models.
- Shared-path change to flag for review: a panel window without a reset no longer ends in a dangling separator (it also affects a Codex window whose payload omits `reset_at`; whitespace only).

## Next step

Feature branch holds three unreviewed work-unit commits. User decision: native review of each commit or of the branch slice, then PR.
