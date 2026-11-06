# Feature: /gentle:stats panel

Locator: `odd/tasks/gentle-stats.md` (worktree `../gentle-pi-stats`, branch `feat/gentle-stats` from `origin/main` 408ac8e4)
Engram mirror: `odd/gentle-stats/tasks` (project `gentle-pi`)

## Objective
Add a `/gentle:stats` command that opens a full-screen panel (same pattern as `/gentle:agents`) showing historical usage stats in Gentle Shell style, inspired by Claude Code `/usage` + `/stats`, using only data Pi already persists.

## Problem / Why
Users have no local view of their Pi usage history (tokens, cost, models, activity). Runtime metrics are ephemeral by design; the session JSONL files already hold everything needed.

## Scope
- Aggregation from `~/.pi/agent/sessions/**/<ISO>_<uuid>.jsonl` (top-level session files via `listSessionFiles`).
- Panel tabs: Overview (heatmap, totals, streaks, favorite model, fun comparison), Models (per-model tokens/cost/share), Session (current session cost, wall duration, tokens, lines +/-).
- Range toggle: all time / last 7 days / last 30 days. Scope toggle: all projects / current project (`cwd`).
- Gentle palette (theme tokens), not Claude Code's orange.

## Non-goals / constraints
- No account-level limit % (that is `/gentle:usage`).
- No API-duration metric (not persisted; show wall time only).
- No new persistence; read-only scan, tolerant to malformed lines.
- `/gentle:usage` name is taken; command is `gentle:stats`.
- Subagent nested sessions are not summed in v1 (disclosed in panel footnote).

## Delivery
Strategy: `single-pr` (user-selected delivery strategy; no protected `size:exception` label authorization inferred). Original forecast ~1100 authored lines; observed branch diff before delivery bookkeeping: 1706 additions + 5 deletions.

## Tasks
- [x] T1 Stats collector (`lib/stats-collector.ts`): parse JSONL → totals, per-model, per-day, sessions, active days, longest session, longest/current streak, most active day, range+scope filters; unit tests with fixtures. Route: delegated (writer; preparation trigger). Risk: medium (writer self-verification). Commit: `24f7b61d` feat(stats): add session usage collector.
  - Evidence: RED `tests/stats-collector.test.ts` failed (module missing); GREEN 11/11 pass; `pnpm typecheck` no regressions. Real-data probe (read-only): 151 sessions, cold load 1.96 s, warm 3 ms (mtime/size cache).
  - Notes: lines +/- come from `SessionChanges` for the live session only (historical patch regeneration would be too costly); session wall time = header timestamp → last assistant message; current streak survives an idle today.
- [x] T2 Stats view (`lib/stats-view.ts`): tabs, heatmap, range/scope toggles, q/esc close, pointer footer; unit tests. Route: delegated. Risk: medium (writer self-verification). Commit: `7ae923bc` feat(stats): add stats overlay view.
  - Evidence: RED `tests/stats-view.test.ts` failed (module missing); GREEN 9/9 (collector + view 20/20); `pnpm typecheck` no regressions. Widths 48/100/120 asserted cell-exact.
  - Notes: heatmap shades are glyph density (`· ░ ▒ ▓ █`) in theme roles `borderMuted`/`accent`, so every Gentle theme recolors it; clickable header tabs, `[× Close]`, and footer hints follow the `UsageView` span pattern with `paintHoverable`. Below ~56 columns the range/scope label is dropped from the tabs row.
- [x] T3 Command wiring (`extensions/gentle-stats.ts` + package registration): `/gentle:stats`, optional shortcut with env `off`, overlay pattern from `openOverlay`, docs; tests. Route: delegated. Risk: medium (writer self-verification). Commit: `a79b424c` feat(stats): add /gentle:stats command.
  - Evidence: RED `tests/gentle-stats.test.ts` failed (module missing); GREEN 6/6; focused stats checks 26/26; `pnpm typecheck` no regressions.
  - Notes: `package.json` needs no change (`pi.extensions` already loads `./extensions`). No default shortcut; `GENTLE_PI_STATS_VIEW_KEY` binds one. Sessions root is `join(getAgentDir(), "sessions")`, the same as Pi's internal `getSessionsDir()`. Docs: `docs/gentle-shell.md` (Gentle Stats section) and the README "Also in the box" table. Not done (outside the authorized surfaces): command-palette catalog entry (`lib/command-palette-catalog.ts`) and the command table in `docs/readme-reference.md`.

## Acceptance criteria
- `/gentle:stats` opens full-screen panel; `q`/`esc` closes with repaint.
- Numbers match a fixture set exactly in tests.
- Empty/malformed session dirs render an empty-state without throwing.

## Checks
- `node --experimental-strip-types --test tests/stats-collector.test.ts tests/stats-view.test.ts tests/gentle-stats.test.ts`
- Full suite `node --experimental-strip-types --test tests/*.test.ts` at closure; typecheck if configured.

## Progress
- Exploration done (handoff: data in session JSONL; `/gentle:agents` overlay pattern at `extensions/gentle-agents.ts:917-964`).
- T1–T3 implemented and committed on `feat/gentle-stats`.
- Full suite at closure (`node --experimental-strip-types --test tests/*.test.ts`): 4498 tests, 4346 pass, 118 fail, 34 skipped. Every failure is in files this feature does not touch and is environmental on the base: `gentle-shell.test.ts` (75) and `vim-editor-adapter.test.ts` (34) report "Unsupported Pi editor layout/version" with Pi 0.99.2 installed; `package-manifest.test.ts` (2), `gentle-shell-bin`/`gentle-shell-launcher` (1 each) still expect the 0.99.1 pin that base commit `e8094f3c` moved to `>=0.99.2`; `gentle-ai.test.ts` (5) are child-safety/Herdr permission lifecycle assertions. Docs assertions in `package-manifest.test.ts` pass.

## Follow-up: missing Pi history
User authorized combining Gentle Shell and regular Pi histories by default. Diagnosis: isolated root has 7 sessions, regular Pi has 151 including OpenAI. Preserve custom original Pi home, deduplicate canonical roots and session IDs; never mutate history files.

- [ ] T4 Fix cross-home history collection and launcher propagation, with deterministic RED/GREEN tests and real-data aggregate-only validation. Route: delegated (multi-file + preparation triggers). Risk: medium; launch isolation must remain unchanged. Base for this work unit: `37fb1241`. No unrelated UI changes.
  - Status: implementation and independent verification observed; parent work-unit commit and native review pending. Required suite remains partial: two proven baseline pin failures, no introduced failures. Keep task unchecked pending closure.
  - Independent verification: `--check` passes; focused suite 364/366 pass with exactly the two baseline pin failures; typecheck reports 187 recorded diagnostics, no regressions. Windows behavior and user visual recheck not verified. Low-risk follow-ups: POSIX test paths and Windows symlink permissions; extension imports launcher module for a constant.
  - Approval: the writer stopped because `bin/gentle-shell.mjs` imports the generated, tracked `runtime/gentle-shell-launcher.mjs` (from `lib/gentle-shell-launcher.ts` via `scripts/build-runtime-modules.mjs`). The user selected option 1: add `runtime/gentle-shell-launcher.mjs` to the surfaces and run `--write` then `--check`. `--write` changed only that runtime file (+18/-1); `--check` exit 0 ("runtime matches TypeScript sources").
  - Implemented: `createStatsLoader().load()` takes one root or several; roots resolve through `realpath` (aliases read once, missing roots skipped); sessions deduplicate by header ID keeping the copy with more usage records, then the newest last usage, then the first canonical path; headers without an ID never merge. `statsSessionRoots(agentDir, env, home)` returns the active `sessions` root plus `GENTLE_SHELL_USER_PI_HOME` (fallback `~/.pi/agent`, never `PI_CODING_AGENT_DIR`). Launcher: `USER_PI_HOME_ENV`/`userPiHome(env, homedir)` (inherited value wins, else `linkDir`); `buildPiInvocation` takes a required `homedir` and adds the variable without changing `PI_CODING_AGENT_DIR`/`GENTLE_PI_AGENT_HOME`; the bin passes `homedir()`. Docs: Gentle Stats section of `docs/gentle-shell.md`.
  - Evidence: baseline focused run (source at `37fb1241`) 359 tests, 357 pass, 2 fail. RED 153 tests reported, 11 fail (missing exports abort two files; single-root loader; bin env undefined). Final focused run 366 tests, 364 pass, 2 fail, and both failures are the baseline pin failures (`real adjacent Pi resolves through its public entry…` expects pi 0.99.1, installed 0.99.2; `Pi baseline and host peers follow the 0.99.1 package contract` expects `0.99.1`, actual `>=0.99.2`). No introduced failures. `pnpm typecheck` exit 0. `tests/package-manifest.test.ts` (docs assertions) 55 tests, 2 fail, both baseline pin assertions on `package.json`.
  - Real-data aggregate probe (streaming, counts only): active home 7 sessions, regular Pi 151, combined 158, 0 shared IDs; combined 3,880,292,659 tokens over 46 active days; `openai-codex` 26,067 usage messages / 3,827,699,365 tokens / 142 sessions; cold load 1.87 s.
  - Deviation: `tests/stats-view.test.ts` (outside surfaces) passes a single root string, so `load()` keeps accepting a string.

## Next step
T4 work-unit commit and native review, then user visual recheck from a fresh launch. Source merge is user-authorized; push/PR remain pending.

## T4 parent closure evidence
- Work-unit commit: `aabedff9cdd3604958aa25cca792cb0d3574c4f9` (`fix(stats): include original Pi session history`).
- User visual verification: user confirmed it now works on 2026-10-01.
- Native review slice: base `37fb12414eec5aa00db10901cede37b491dce276`, lineage `review-f23932c0f0491ac3`. Capture rejected at admission because reviewer reported unavailable candidate inspection while claiming completed inspection. No verdict admitted, no acknowledgement. Fresh STATUS reoffers reviewer slot; review remains pending. Do not replay rejected bytes.
- T4 stays unchecked: focused checks still have two proven baseline failures; native review is pending. No source defect was reported by independent verification.

## Delivery preparation
- GitHub canonical destination: `Gentleman-Programming/gentle-shell` (renamed from gentle-pi), default branch `main`. User authorized gh-session reads, push, PR and merge after checks; separately authorized a new issue and `status:approved`.
- Issue `#1629` created and read back confirmed, approved; user selected closing reference for this dedicated historical-dashboard issue. Broader `#1583` stays open.
- T4 review retry was admitted and approved, then acknowledged: lineage `review-f23932c0f0491ac3`, consumed revision `sha256:3a9823cea06c0ab491fd66c8be1cbbb364fc5508dbac798949b3e4d5c8a89625`. This supersedes the prior rejection/pending state above.
- Nonblocking review follow-ups: provider/home wiring tests, divergent same-ID copies, POSIX fixture paths and Windows symlink test permissions. No correction route opened.
- T4 implementation, independent verification and user visual verification are observed. Two focused baseline pin failures remain; full T4 suite/Windows verification not rerun locally. CI results pending; no waiver inferred.
- Remote main observed at `4efd7b783cbd768c255d75ef0d1fee8876a6738d`. No branch protection or rulesets returned, but repository CI must still be checked before merge.
