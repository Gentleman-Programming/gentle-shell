# In-process reviewer completion (no pi child)

- Feature: `inprocess-reviewer-completion`
- Branch: `fix/inprocess-reviewer-completion` (worktree `~/work/gentle-pi-worktrees/inprocess-reviewer`, base `origin/main` fd67435f)
- Engram mirror: topic `odd/inprocess-reviewer-completion/tasks` (project gentle-pi)
- Sibling feature (gentle-ai): `odd/tasks/pi-inprocess-reviewer-assess-transition.md` in `~/work/gentle-ai-worktrees/pi-inprocess-reviewer`
- TDD: strict (session config); runner `pnpm test` (+ `pnpm run typecheck`)
- Delivery: `single-pr`; work-unit commits per task
- RDD: on (global)

## Objective

Execute every pi-runtime reviewer role (four lenses, refuter, targeted validator) as an in-process model completion through the live `ctx.modelRegistry`, so any provider the interactive pi can use (core, models.json, extension-registered, OAuth) reviews without a `pi --print` child, without `--no-extensions`, and without the `GENTLE_PI_REVIEW_RELAY_EXTENSIONS` allowlist.

## Problem

gentle-ai#4611: the relay child (`opaque-pi-reviewer-adapter.ts`) runs `pi --print --no-extensions`, which drops extension-registered providers (`Model not found`) and strips env-provided API keys. The env allowlist requires per-provider manual configuration and Go roles have no parity.

## Scope

In:
- `lib/inprocess-reviewer.ts`: resolve `provider/id` via `modelRegistry.find`, auth via `getApiKeyAndHeaders`, run `completeSimple(model, {messages:[frozen prompt]}, {apiKey, headers, reasoning, signal, timeoutMs})`, return assistant text; typed failures (model_not_found, auth_unavailable, empty_output, timed_out, provider_failed); thinking mapping (`off`/`max` clamp).
- Lens relay: replace the pi child spawn with the in-process completion; thread `ctx.modelRegistry` from `gentle_review_capture` down to the relay; keep Go materialize + `--input` submission unchanged.
- Roles: recognize the new gentle-ai status v8 role inputs (`--materialize=true` + submission), complete in-process, submit through the descriptor.
- Remove `opaque-pi-reviewer-adapter.ts`, `-e` forwarding, `GENTLE_PI_REVIEW_RELAY_EXTENSIONS`, `GENTLE_PI_REVIEW_RELAY_PI_TIMEOUT_MS` semantics tied to a process (keep a completion timeout with the same formula); update docs.

Out:
- Any change to Go admission; gentle-ai pin bump (separate release step).

## Constraints

- The completion carries only the frozen prompt as one user message: no systemPrompt, no tools, no session, no extension hooks.
- Never invent a model or fall back to another provider; a missing model/auth is a typed refusal that names the routing config key.
- Keep `readModelConfig` as the single reader for `review-<lens>`, `review-refuter`, `review-validator`.
- Bound output before submission (reuse the existing byte bound used for pi stdout).

## Tasks

- [x] P1 — `lib/inprocess-reviewer.ts` with injected `complete` seam and fake registry tests.
- [x] P2 — Lens relay uses in-process completion; delete pi child adapter, `-e`/env allowlist; tests updated.
- [x] P3 — Roles: decode status v9 role inputs with submission; run in-process; submit via `--input`; tests.
- [x] P4 — Docs (`docs/review-integration.md`, P2/P3), harness (`3f2d1c4b`, `f39eb289`), cross-lane: `tests/crosslane/cross-lane.mjs` decodes a static closure fixture only and carries no role/pi-child expectations, so nothing remained after P3.

## Acceptance criteria

- `pnpm test` and `pnpm run typecheck` green.
- No `spawn(` of `pi` for reviewer roles remains (`grep -n "\-\-print" lib/ extensions/` empty for review paths).
- With a fake registry exposing an extension-registered provider, a lens capture completes and submits without any child process.

## Forecast

~700 authored changed lines (deletions heavy). Exceeds 400 → single PR, `size:exception`, user decision.

## Progress / evidence

- P1 — commits `b00e807d` (module + 18 tests) and `713b7b73` (review correction). Checks: `node --test tests/inprocess-reviewer.test.ts` 20/20; `pnpm run typecheck` no regressions; `pnpm test` main suite green, `test:harness` fails pre-existing (gentle-ai v3.2.1 binary not installed under `--ignore-scripts`). Decision: forward thinking `max` verbatim (pi-ai 0.85.1 supports it; the model's `thinkingLevelMap` clamps). Assess: medium, 565 lines (slice budget reached). RDD: consent granted; lineage `review-ac0ad49f948525d0`, one lens (`review-reliability`) → CRITICAL `R3-resolved-abort-unclassified` (resolved abort misclassified) → corrected in 84 lines (plan 84/200) → targeted validation approved → acknowledged (`gentle-ai.review-acknowledged/v1`). Reviewed boundary: `713b7b73`.
- P2 — commit `86cd9b3d` (12 files, +562/−1374). Checks: relay + transport-agent + module tests 71/71; full `tests/*.test.ts` 2715 pass / 0 fail; `pnpm run typecheck` no regressions; `check:provider-contract` ok; `test:harness` pre-existing failure (binary not installed). Decisions: no ambient default model (missing routing model → `reviewer-config-invalid`); `PI_TIMED_OUT`/`PI_FAILED` kind names kept for identical semantics, 7 new `REVIEWER_*` kinds added; `runReviewHostRelaySlot` gained an injectable `runReviewer` seam. Follow-up for P4: `scripts/maintainer/provider-relay-matrix.mjs`, `tests/devbinary/pi-host-relay.devtest.ts`, `tests/maintainer/provider-relay.maintest.ts` still assume a pi child launcher. Assess: high, 1936 lines (`process_boundary`) → immediate candidate. RDD: consent granted; lineage `review-d482e8bfb5178bed`, four lenses (risk, resilience, readability, reliability) → approved with no correction → acknowledged. Reviewed boundary: `86cd9b3d`.
- P4a (harness half of P4) — commit `3f2d1c4b` (3 files, +292/−298). Checks: `pnpm run test:maintainer` 29 pass / 5 skip (gated); `pnpm run test:dev-binary` 10 skipped without `GENTLE_AI_DEV_BINARY` (with the installed 3.1.1 dev binary: rewritten garbage-result test passes; two other devtests fail pre-existing on untracked-selection/manifest expectations of that older binary); `pnpm run test:cross-lane` passed; `pnpm test` main suite 2715/0; typecheck no regressions. Decision: positive journeys use pi-ai's `registerFauxProvider` so the real `completeSimple` dispatch runs without network. Assess: high, 590 lines (`process_boundary`). RDD: consent granted; lineage `review-e6cfda8917fd9e77`, four lenses → CRITICAL R2-001/R3-001 (faux reviewer omitted `inspection`; maintest stub accepted anything) → corrected in `f39eb289` (74 lines, plan 74/200; stub now refuses contract-incomplete payloads) → targeted validation approved → acknowledged. Reviewed boundary: `f39eb289`.
- P3 — commit `031e26c2` (9 files, +514/−105). Checks: focused suites 171/171; full `tests/*.test.ts` 2720 pass / 0 fail; typecheck no regressions; `test:maintainer` 29 pass / 5 skip; `test:harness` pre-existing failure. Decisions: status decoder ladder extended v9→v8→v7 (v8 on the v7 surface; role `submission` gated on v9 only); materialize verb derived from `submission.operationToken` so lenses and roles share one relay; older `--execute` role vectors still dispatch through the native CLI. Assess: high, 619 lines (`process_boundary`). RDD: consent granted; lineage `review-79260d875fc1351c`, four lenses → approved, no correction → acknowledged. Reviewed boundary: `031e26c2`.
- Build/pin — commit `af9fe678` (regenerated `runtime/review-integration-v2.mjs`; `docs/review-integration.md` hash re-pinned in `scripts/verify-package-files.mjs`). Final checks: `tests/*.test.ts` 2720/0; `check:provider-contract` ok; typecheck no regressions; `check:runtime-modules` ok; `verify-package-files` ok. Assess: medium, 185 lines → feature end closes the slice; consent granted; lineage `review-2580a89cfbd8fb60`, one lens → approved → acknowledged. Reviewed boundary: `af9fe678`.

## Next step

Push and open the PR; merge after CI. Bump the gentle-ai pin once gentle-ai ships status/v9 (gentle-ai PR #4784).
