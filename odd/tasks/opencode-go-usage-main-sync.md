# OpenCode Go usage — main sync

- Feature: `opencode-go-usage-main-sync`
- Branch: `feat/opencode-go-usage` (base `main` 1c624274, single feature commit bd11f758)
- Engram mirror: topic `odd/opencode-go-usage-main-sync/tasks` (project gentle-pi)
- TDD: strict; focused runner `node --experimental-strip-types --test tests/<file>.test.ts`; full `pnpm test` (+ `pnpm run typecheck`)
- Delivery: owner decides commit / PR / push (not taken by the agent)

## Objective

Bring `origin/main` into `feat/opencode-go-usage` and keep the OpenCode Go
subscription-usage feature working against the current repository state, or
report exactly which parts of it no longer fit.

## Problem — why this is not a mechanical merge

The feature commit is one commit on a base **406 commits** behind `origin/main`.
Every file it touches was rewritten upstream in the same interval:

| File | Branch change | Upstream change since merge base |
| --- | --- | --- |
| `README.md` | 5 lines (usage bullets) | −1056/+? restructure; section moved to `docs/gentle-shell.md` |
| `extensions/gentle-shell.ts` | +55/−? | 754 lines changed |
| `lib/shell-bar.ts` | 10 lines | 224 lines changed |
| `lib/shell-usage.ts` | 39 lines | 360 lines changed |
| `tests/gentle-shell.test.ts` | 30 lines | 1827 lines changed |
| `tests/shell-bar.test.ts` | 10 lines | 289 lines changed |
| `tests/shell-usage.test.ts` | 25 lines | 389 lines changed |

A dry-run merge reports **17 conflict hunks across all 7 files**.

Known structural drift:
- `SUPPORTED_USAGE_PROVIDERS` upstream is `[CODEX_PROVIDER, ANTHROPIC_PROVIDER, NAN_PROVIDER]`.
- Provider notes now come from a `UsageSourceRegistry` + `providerNote()`, not a
  module-level `Record`.
- `renderUsagePanel(usages, theme, width, now, active?, registry?)` gained a
  registry parameter; `UsageStore.all()` already exists upstream.
- Upstream fetches more than Codex (NaN quota); the branch's single-provider
  `refreshUsage` shape must not regress that.
- The README usage section moved to `docs/gentle-shell.md`.

## Scope

In:
- Merge `origin/main` into `feat/opencode-go-usage`.
- Port OpenCode Go support (parse, fetch, provider registration, bar/panel
  wiring) onto the upstream structure without regressing Codex, Claude, or NaN.
- Move the feature's user-facing documentation to `docs/gentle-shell.md`.
- Keep the existing OpenCode Go test intent (supported provider + refresh note,
  rolling required / weekly + monthly optional windows) on the new test base.

Out:
- No push, no PR, no force-push, no rebase of published history.
- No new feature behavior beyond what the branch commit already introduced.
- No changes to upstream NaN/Codex/Claude behavior.

## Tasks

- [x] T1 Merge `origin/main` into the branch and record the conflict set.
- [x] T2 Port OpenCode Go parsing + provider registration into `lib/shell-usage.ts`.
- [x] T3 Port the fetch loop into `extensions/gentle-shell.ts` without dropping upstream providers.
- [x] T4 Wire the sidebar/panel usage lines in `lib/shell-bar.ts`.
- [x] T5 Port the three test files onto the upstream test base.
- [x] T6 Move the usage documentation to `docs/gentle-shell.md`.
- [x] T7 Focused tests + `pnpm run typecheck` green on the merged tree.
- [ ] T8 Independent verification of the merged result.

## What the merge changed, and why

`origin/main` rewrote every file the branch touched, so the port is a
re-implementation of the same behavior on the new structure, not a text merge.

1. **`lib/shell-usage.ts`** — kept every upstream addition (NAN provider, NaN
   parser, `UsageSourceRegistry`, `windowLabel`, allowance grouping) and added
   back only the OpenCode Go pieces: the two raw interfaces,
   `OPENCODE_GO_PROVIDER`, `MONTH`, `parseOpenCodeGoWindow`,
   `parseOpenCodeGoUsage`, the supported-provider entry and its pending note.
   The window labels stay literal (`5h`, `week`, `month`) because the provider
   names its own windows; `windowLabel` would print the monthly one as `30d`.
2. **`extensions/gentle-shell.ts`** — upstream's `refreshUsage` refreshes the
   **active** provider only, through a source/NaN/Codex ladder. OpenCode Go
   joins that ladder as a fourth rung, instead of the branch's unconditional
   `[CODEX, OPENCODE_GO]` loop, so upstream's per-provider 5-minute discipline
   and provider-switch behavior are preserved. The API-key subscription flag
   (`subscription`) keeps its OpenCode Go special case. `fetchOpenCodeGoUsage`
   now refuses redirects and keeps no cached copy, matching the hardening the
   file already requires for the other key-bearing fixed-origin fetcher.
3. **`lib/shell-bar.ts`** — takes upstream wholesale. The branch's
   `usages` / `usageNow` / `activeProvider` model fields fed a sidebar Usage
   group that upstream **removed**: context, cost and usage moved to the
   always-visible header row, and `/gentle:usage` already lists every collected
   snapshot with the active provider first. The branch's sidebar edit is
   therefore superseded, not ported.
4. **Tests** — the three files keep both sides: upstream's NaN/source tests and
   the branch's OpenCode Go coverage, re-expressed against the new test base
   (`fakeFetch` records `init`, so redirect/cache hardening is asserted).
   `fakeContext`'s branch-added `tokens` map was dropped: with the active-
   provider ladder it had no consumer and upstream's `token` is enough.
5. **`README.md`** — resolved to `origin/main` verbatim. The branch edited a
   usage section that no longer exists in the 342-line README; its content now
   lives in `docs/gentle-shell.md`.
6. **`docs/gentle-shell.md`** — the branch's user-facing documentation, ported
   to the new home: OpenCode Go joins the provider list, the bar's subscription
   names, and gets its own bullet.

## Evidence

- Branch baseline before the merge: 61/61 pass on the three shell test files.
- Dry-run and real merge: 17 conflict hunks across all 7 files.
- Focused: `tests/shell-usage.test.ts` + `tests/shell-bar.test.ts` — 73/73 pass.
- Focused: `tests/gentle-shell.test.ts` — 108/108 pass.
- Full unit stage — 3442 tests, 3394 pass, 47 skipped, **1 fail**
  (`tests/review-host-relay-routing.test.ts:282`). Reproduced identically on a
  pristine `origin/main` worktree: **pre-existing, base-only, unrelated to this
  merge**.
- `pnpm run check:provider-contract` — pass.
- `pnpm run test:harness` — pass (needed the package-local Gentle AI v3.7.0
  binary, absent in this clone until `node scripts/install-gentle-ai.mjs` ran).
- `node scripts/check-types.mjs` — no regressions; 195 recorded diagnostics
  against a 200 baseline (4 file/code pairs improved; baseline left untouched).

