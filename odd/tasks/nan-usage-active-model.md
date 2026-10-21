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
- [x] NAN-A7 — One panel row per window: the limit name and its meter on one line, the reset under it, for every provider, with a shared name column.
- [x] NAN-A6 — Drop the redundant window label: the period allowance prints as `name meter percent` in the bar, the sidebar and the panel, while a labeled sub-window (`4h`) keeps its column.

## Acceptance criteria

- A NaN session using `glm5.3-flash` shows `glm5.3-flash period ▰… 10%` in the bar.
- A NaN session whose model is not metered shows the account total (`nan total period ▰… 6%`).
- The panel lists `nan total` and `glm total` as normal limit blocks, and the per-model rows stay.
- Aggregate rows carry no `resets in`.
- Codex and Anthropic keep their meters, rows and order; existing tests need no edit. Superseded for the shared row grammar: the later inline-reset request (`odd/tasks/nan-usage-compact-rows.md`) moved the reset onto the row for every provider, so a Codex window whose payload omits `reset_at` no longer ends on a dangling separator. The sidebar's zero-row rule (`odd/tasks/nan-usage-zero-rows.md`) also applies to every provider. Both changes are deliberate and covered by tests.
- `renderUsageBar(usage, theme)` with two arguments keeps today's behavior (the first limit, because no active model is known). Existing tests need one intentional edit: a NaN payload with a single metered model is per-model data now, so the footer and the bar name that allowance's family or the account total instead of echoing the model the payload listed. See `odd/tasks/pr-1180-review-fixes.md`.
- Focused tests, `pnpm test`, and `pnpm run typecheck` pass.

## Progress

- 2026-09-18: user authorized C + grouping after seeing rendered mockups against the live payload.
- 2026-09-18 (PR #1180 review round): the effective-allowance rule (`fullCap`), the per-provider refresh window, the single-member family rung and the single-allowance gate were corrected; see `odd/tasks/pr-1180-review-fixes.md`.
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

## Native review (closed, approved)

- Lineage `review-73622327c0dfb3c6`, tier `high` (`process_boundary` on `extensions/gentle-shell.ts`), 4 lenses, 673 original changed lines, budget 200 with no correction opened.
- First START returned `consent-binding-stale` (10-minute window, `lineage_created: false`); a second START with a fresh idempotency key created the lineage.
- The group capture failed with `pi-empty-output` and single-slot captures were the working route; the three remaining lenses only admitted after setting `settings.json` `defaultModel` to `glm5.3-flash` for the relay child (restored right after). Root cause is recorded in the tracker follow-up below.
- Closed `approved`; acknowledgement burned authority (`gentle-ai.review-acknowledged/v1`, revision `sha256:ce7084e0…`); delivery left to ordinary repository policy. All 9 findings were admitted as advisory and non-blocking (`R2-doc-contract-fullcap`, `R2-family-percent-dead-fallback`, `R2-quotanumber-bool-flag`, `R2-shared-refresh-timestamp`, `R3-fullcap-omitted`, `R3-timestamp-scale`, `R4-1`, `R4-2`, `R4-3`).

## Relay defect found while reviewing (not caused by this candidate)

The host relay spawns `pi --print --mode text --no-tools …` with the provider prompt on stdin. With the default model `nan/deepseek-v4-flash` the reviewer answers with a tool call, `--no-tools` strips it, and the child exits 0 with empty stdout, which the relay reports as `pi-host-relay-transport-failure` / `pi-empty-output`. Reproduced outside the review with the exact argv (52 KB prompt: 0 bytes, exit 0, ~70s; `--model nan/glm5.3-flash`: 6059 bytes of findings JSON; `--mode json`: 4.3 MB of events). The upstream fix belongs in `lib/review-host-relay.ts` / `lib/opaque-pi-reviewer-adapter.ts`.

## Next step

This commit (NAN-A6) moves the branch one work unit past the reviewed candidate `2b579c80..5669bfb5`, so a new candidate starts at the next review. Delivery (PR) is still the user's decision.
