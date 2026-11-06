# NaN Usage Sidebar

## Objective

Show the authoritative NaN Cloud per-model token allowance in Gentle Shell's existing subscription usage surfaces (bar + `/gentle:usage` panel), without inventing a second data model.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- NaN Cloud origin is fixed; redirects are refused and responses are not cached.
- The API key is never logged, persisted, rendered, or included in any error path.
- Refresh is throttled to at most every 5 minutes, plus session start and an explicit `r`.
- Parsing is bounded: unknown or malformed payloads degrade to "no data", never throw. A model that reports no allowance is skipped, as the dashboard skips it; a metered model whose usage cannot be read fails the whole read, because a partial payload would understate every aggregate drawn from it.
- The last valid snapshot survives a failed refresh.
- Codex and Anthropic behavior stays unchanged.
- No delivery actions (no push, no PR) without an explicit user decision.

## Authorized edit surfaces

- `odd/tasks/nan-usage-sidebar.md`
- `lib/shell-usage.ts`
- `lib/shell-usage-view.ts` (only if the view needs a NaN-specific line)
- `lib/shell-bar.ts` (only if the bar needs a NaN-specific case)
- `extensions/gentle-shell.ts`
- `tests/shell-usage.test.ts`
- `tests/shell-usage-view.test.ts`
- `tests/shell-bar.test.ts`
- `tests/gentle-shell.test.ts`
- `docs/gentle-shell.md`

## Source contract

Verified against the official NaN Cloud dashboard bundle (`https://cloud.nan.builders/assets/index-BDzh24-5.js`, read 2026-09-17):

- `GET https://cloud-api.nan.builders/api/usage/quota` with `Authorization: Bearer <NaN API key>`.
- Response: `{ models: [ { model, cap, fullCap, tokensUsed, periodEnd, windowHours, windowTokens, fullWindowTokens, windowTokensUsed, windowResetsAt } ], periodEnd }`.
- Dashboard semantics mirrored here: effective period allowance = `fullCap > 0 ? fullCap : cap`; rolling budget = `fullWindowTokens > 0 ? fullWindowTokens : windowTokens`, and `windowHours` is the hours the model reports. The dashboard's 400M and 4h defaults apply only when the field has no usable positive value, never over one that does; `cap < fullCap` means a prorated first period. The effective allowance is the divisor the parser puts on the period window, so the percentages match the dashboard in a prorated period too. The rolling window is a row only when the model reports `windowTokensUsed` as a finite non-negative number: with no such marker there is no second window, and the period allowance is the whole story.
- Not part of NaN's public OpenAPI contract, so the integration stays defensive by design.

## Tasks

- [x] NAN-1 — Lock the NaN usage contract with failing tests (parser, provider note, fetcher, refresh wiring).
- [x] NAN-2 — Implement the bounded NaN quota parser in `lib/shell-usage.ts`.
- [x] NAN-3 — Implement the fixed-origin fetcher and wire the `nan` provider into the refresh path and render surfaces.
- [x] NAN-4 — Verify (focused tests, full suite, typecheck) and document the feature.

## Acceptance criteria

- An authenticated `nan` session shows real per-model allowance percentages in the bar and the panel.
- The rolling window appears only when the model reports one, labeled by `windowHours`.
- A redirect, non-OK response, malformed payload, or missing key leaves the last valid snapshot untouched and renders no NaN data.
- No secret appears in any rendered line, thrown error, or persisted file.
- Existing Codex and Anthropic tests keep passing unchanged.
- Focused tests, the full suite, and typecheck pass.

## Progress

- 2026-09-17 (previous session, managed checkout): contract locked, NAN-1 RED reached (`11 passed, 1 failed` on `tests/shell-usage.test.ts`). Work was destroyed by `pi update --extensions` resetting the Pi-managed checkout.
- 2026-09-17 (this session): recovered into a real clone. Repository root `/home/egdev/proyectos/gentle-shell` (fresh clone of `Gentleman-Programming/gentle-shell` at `2b579c80`), branch `feat/nan-usage-sidebar`. Global Pi settings and the Pi-managed checkout were not touched.
- Delegation fallback: `subagent_run` rejected `workspace_root=/home/egdev/proyectos/gentle-shell` ("Select an existing worktree in the same Git clone as this session") because the parent session cwd is not the same clone. The parent continued as the sole inline writer.

## Verification evidence

- Baseline before changes: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-usage-view.test.ts` — 14 passed, 0 failed.
- NAN-1 RED: `node --experimental-strip-types --test tests/shell-usage.test.ts` — 1 failed, `does not provide an export named 'parseNanQuota'`.
- NAN-1 RED: `node --experimental-strip-types --test tests/gentle-shell.test.ts` — 1 failed, `does not provide an export named 'fetchNanUsage'`.
- NAN-2 GREEN: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-usage-view.test.ts` — 19 passed, 0 failed.
- NAN-3 GREEN: `node --experimental-strip-types --test tests/gentle-shell.test.ts` — 44 passed, 0 failed.
- Suite: `pnpm test` — exit 0, 2685 tests, 2647 passed, 0 failed, 38 skipped; provider contract mirror check passed; runtime harness ran clean. (The first suite attempt failed in `test:harness` only because `pnpm install --ignore-scripts` had skipped the gentle-ai binary; `node scripts/install-gentle-ai.mjs` installed v3.1.0 and the harness then passed.)
- Typecheck: `node scripts/check-types.mjs` — 197 recorded diagnostics, no regressions.
- Commits: `7fd803fc` (parser + tests + this tracker), `9bc7b9dd` (fetcher, wiring, docs, tests).

## Next step

Feature complete and verified on `feat/nan-usage-sidebar`. Nothing is pushed. The native review could not start for this candidate; see below.

## Native review attempt (blocked, no authority created)

- Target root: `/home/egdev/proyectos/gentle-shell` (unrelated to the session repository, authorized explicitly by the user).
- `gentle_review inspect` → `ready`, lineage `review-76fe20947051c2bb`, forecast `execute/fresh_target_ready`, offered route `--base-ref=2b579c80 --committed-only=true --consent=relay`.
- `gentle_review start` with `{"mode":"ordinary","baseRef":"2b579c80…","committedOnly":true}` → `blocked`, `native-operation-failed`, `error_code: schema-incompatible`, `lineage_created: false`, `mutation_outcome: none`.
- Target-scoped `gentle_review status` → `blocked`, `next_transition` `collect/empty_candidate_base_ref_required`, `collectBindings` one slot (`captureOperation: external.select_base_ref`, schema `gentle-ai.review-base-ref-selection/v1`). Confirmed `repair.counts.lineages: 0` and `candidates: []`, so nothing was created by the failed attempt.
- `gentle_review_capture` with that exact provider slot and the inspect-issued lineage → `capture-binding-rejected` ("unknown, expired, or belongs to a different session route"), `mutation_outcome: none`.
- Diagnosis: with a clean worktree the workspace projection is empty (`paths: []`, `base_tree == candidate_tree == 7484118a`), so native asks for an explicit base-ref selection. The running facade's `start` requires an executable `review.start` transition, and its public capture tools require a lineage this pre-lineage slot does not have. `extensions/gentle-ai.ts` `mapNativeTargetStatus` passes any non-untracked collect through as a `collectBindings` entry, which exposes the slot without a consumer. Upstream is already at `2b579c80`, so no update resolves it.
- This is a provider/facade lifecycle gap for an already-committed candidate with a clean worktree, not a defect in this feature.
- Retry plan (user decision: restart Pi, then retry): after `/reload` or a full restart, `gentle_review inspect` with `workspaceRoot=/home/egdev/proyectos/gentle-shell`, then `gentle_review start` with a fresh `idempotencyKey` and the same committed-range input. A fresh START is legal because no lineage exists.
