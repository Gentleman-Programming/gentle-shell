# NaN Usage Sidebar

## Objective

Show the authoritative NaN Cloud per-model token allowance in Gentle Shell's existing subscription usage surfaces (bar + `/gentle:usage` panel), without inventing a second data model.

## Constraints

- Strict behavioral TDD: a focused failing test precedes every behavior.
- NaN Cloud origin is fixed; redirects are refused and responses are not cached.
- The API key is never logged, persisted, rendered, or included in any error path.
- Refresh is throttled to at most every 5 minutes, plus session start and an explicit `r`.
- Parsing is bounded: unknown or malformed payloads degrade to "no data", never throw.
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
- Dashboard semantics mirrored here: effective period allowance = `fullCap > 0 ? fullCap : cap`; rolling budget = `fullWindowTokens > 0 ? fullWindowTokens : windowTokens` (dashboard default 4h / 400M when the model sends none); `windowHours` defaults to 4; `cap < fullCap` means a prorated first period.
- Not part of NaN's public OpenAPI contract, so the integration stays defensive by design.

## Tasks

- [ ] NAN-1 — Lock the NaN usage contract with failing tests (parser, provider note, fetcher, refresh wiring).
- [ ] NAN-2 — Implement the bounded NaN quota parser in `lib/shell-usage.ts`.
- [ ] NAN-3 — Implement the fixed-origin fetcher and wire the `nan` provider into the refresh path and render surfaces.
- [ ] NAN-4 — Verify (focused tests, full suite, typecheck) and document the feature.

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
- Pending.

## Next step

NAN-1 RED: add the failing NaN parser/provider/fetcher tests.
