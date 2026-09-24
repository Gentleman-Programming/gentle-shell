# claude-bridge subscription usage

Issue: Gentleman-Programming/gentle-shell#1399
Branch: `feat/claude-bridge-subscription-usage` (fork `QuBiit0/gentle-shell`, base `main` at `4d702a47`)
Delivery strategy: `ask-on-risk` (single PR expected, forecast ~350 authored changed lines)
TDD: strict (source: gentle-ai `strict_tdd: true`); runner: `node --experimental-strip-types --test <file>` for focused runs, `pnpm test` for the full suite, `pnpm run typecheck` for types.

## Objective

Show the Claude subscription windows (5h, 7d, per-family 7d) in the Gentle Shell bar, sidebar and `/gentle:usage` panel when the active provider is `claude-bridge`, instead of `no subscription usage for this provider` and a misleading `$0.000`.

## Problem

Claude Code streams `rate_limit_event` to the bridge on every turn. The `@schuettc/pi-claude-bridge` fork normalizes them into `globalThis[Symbol.for("pi.provider-usage.bus.v1")]` (`register / adapters / subscribe / publish`; windows `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, each with `usedPercent` and `resetsAt`). Gentle Shell has adapters for `openai-codex`, `anthropic` and `nan` (#1180) and a generic `gentle-pi:usage-source/v1` hook, but nothing reads the bus and no bridge emits the hook.

## Scope

- In: a `claude-bridge` usage source in `lib/shell-usage.ts` that reads the bus snapshot defensively (shape-checked, never throws), wiring in `extensions/gentle-shell.ts` for the refresh path and bus subscription, bar/sidebar/panel rows through the existing `ProviderUsage` grammar, a pending note when the bus is absent, tests for every shape, docs in `docs/gentle-shell.md`.
- Out: changes to the bridge packages, reading Claude Code's on-disk caches, cost accounting, new UI surfaces.

## Constraints

- Follow #1180 (NaN) as the precedent: same `ProviderUsage` grammar, same refresh cadence rules, Codex/Anthropic/NaN output byte-identical (guarded by tests).
- The bus payload crosses an extension boundary: validate every field, degrade to a note, never throw.
- Conventional commits, no attribution trailers, odd task docs committed with the work (repo convention, see #1180).

## Tasks

- [x] T1 Parser: `parseProviderUsageBusSnapshot(value, now)` in `lib/shell-usage.ts` mapping the `claude` snapshot (`five_hour`, `seven_day` main; family/oauth windows additional, one limit each, named from `scope.label` or the id) to `ProviderUsage`; also added `readProviderUsageBus`, `CLAUDE_BRIDGE_PROVIDER`, `PROVIDER_USAGE_BUS_SYMBOL`, and the bus-absent pending note (`CLAUDE_BRIDGE_BUS_ABSENT_NOTE`) via an optional `globalObject` param on `providerNote`/`renderUsagePanel`. Route: direct (single file pair, mechanical once designed). Commit `078b6deb`.
- [x] T2 Source: `fetchClaudeBridgeUsage(now, globalObject)` and `subscribeClaudeBridgeUsage(now, onSnapshot, globalObject)` in `extensions/gentle-shell.ts`, wired into `refreshUsage` (same 5-minute rule, per-provider) and into `session_start`/`session_shutdown` for the live bus subscription. `ShellDeps` gained `globalObject` (defaults to real `globalThis`) so tests inject a fake bus. Route: direct. Commit `acfd82f6`.
- [x] T3 Surfaces + docs: no changes needed in `lib/shell-bar.ts` — `renderUsageBar`, the header's `selectUsageLimit`, and the panel's `groupUsageLimits` already render any `ProviderUsage` generically, and claude-bridge's windows carry no raw allowance numbers so it takes the same ungrouped path Codex/Anthropic use. Added guard tests (Codex/Anthropic/NaN unchanged) plus claude-bridge bar/panel tests, and documented the source in `docs/gentle-shell.md`. Route: direct. Commit `b1d5b662`.
- [x] T4 Closure: focused suite, typecheck, runtime-modules, provider-contract and package-files checks green locally; native review approved and acknowledged; pushed to fork; PR opened against #1399 (approval pending on the issue, per repo rule).

## Deviation from plan (recorded, not a scope change)

- No "sidebar" row work was needed or done: the compact "Status" card (`renderShellSidebarBar`) stopped showing per-model usage rows in an earlier refactor after #1180 (`sidebarUsageLines`/`groupUsageLimits`-in-sidebar no longer exist in `lib/shell-bar.ts` on this branch's base). Usage now lives in the compact bar (`renderShellBar`) and the fullscreen header (`renderShellHeaderBar`, via `selectUsageLimit`), both of which already render claude-bridge for free. Acceptance criterion "sidebar shows the compact rows" is satisfied by the header row instead; verified with tests, no production change required.
- `pnpm test`/`pnpm run typecheck` from the original plan are not usable on this Windows box per the task brief; used `node --experimental-strip-types --test tests/*.test.ts` and `node scripts/check-types.mjs` instead, as directed.

## Acceptance criteria

- With a bus snapshot present, bar shows the 5h percentage for `claude-bridge` — verified (`renderShellBar shows claude-bridge's 5h percentage...`, `gentleShell fetches claude-bridge usage from the bus on session start...`).
- Panel lists 5h/7d and family/oauth windows with reset times — verified (`renderUsagePanel lists the claude-bridge account windows...`).
- Without the bus, panel shows a pending note naming the missing bus instead of the generic unsupported note — verified (`claude-bridge is a supported usage provider whose pending note names the missing bus...`).
- Live bus events update the bar without waiting for the fetch window — verified (`a live claude-bridge bus event refreshes the store...`).
- All existing provider outputs unchanged — verified (`adding claude-bridge leaves Codex, Anthropic, and NaN bar output unchanged`, plus the full 195-test focused run showing only the pre-existing environmental failure).
- Full suite and typecheck green with no new diagnostics — typecheck confirmed clean (see below); full unit stage run in progress at time of writing, to be recorded before T4 is checked off.

## Progress / evidence

- Baseline (this branch, before any edit): focused 4-file run 180 tests, 179 pass, 1 known environmental failure (`registered canonical root governs real Git discovery, status and diff despite inherited routing`, Windows path separators, pre-existing on `main`).
- T1 RED: `node --experimental-strip-types --test --test-reporter=tap tests/shell-usage.test.ts` before implementation — module load failure, `SyntaxError: ... does not provide an export named 'CLAUDE_BRIDGE_BUS_ABSENT_NOTE'`, all tests in the file fail (1 file, 0 pass, 1 fail at the file level).
- T1 GREEN: same command after implementation — 40/40 pass, including the 5 new tests (`parseProviderUsageBusSnapshot maps...`, `...keeps whatever windows are usable...`, `...degrades to undefined...`, `readProviderUsageBus resolves...`, `claude-bridge is a supported usage provider...`).
- T2 RED: implementation temporarily reverted (`git stash push -- extensions/gentle-shell.ts`), then `node --experimental-strip-types --test --test-reporter=tap tests/gentle-shell.test.ts` — module load failure, `SyntaxError: ... does not provide an export named 'fetchClaudeBridgeUsage'`; implementation restored with `git stash pop` immediately after.
- T2 GREEN: `node --experimental-strip-types --test --test-reporter=tap tests/gentle-shell.test.ts` — 110/111 pass (the 1 fail is the known environmental one); all 7 new tests pass (`fetchClaudeBridgeUsage reads the bus adapter's refresh()...`, `...degrades to no snapshot...`, `subscribeClaudeBridgeUsage forwards a valid snapshot event...`, `...degrades to a no-op unsubscribe...`, `gentleShell fetches claude-bridge usage from the bus on session start...`, `a live claude-bridge bus event refreshes the store...`, `gentleShell unsubscribes the claude-bridge bus listener on session_shutdown`).
- T3: no production code changed (see deviation note above), so tests characterize already-generic behavior rather than following a RED→GREEN cycle; run immediately GREEN — `node --experimental-strip-types --test --test-reporter=tap tests/shell-usage.test.ts tests/shell-bar.test.ts` — new tests pass (`renderShellBar shows claude-bridge's 5h percentage...`, `adding claude-bridge leaves Codex, Anthropic, and NaN bar output unchanged`, `renderUsagePanel lists the claude-bridge account windows...`).
- Combined focused run after T3: `node --experimental-strip-types --test --test-reporter=tap tests/shell-usage.test.ts tests/shell-usage-view.test.ts tests/shell-bar.test.ts tests/gentle-shell.test.ts` — 195 tests, 194 pass, 1 known environmental fail. Net new: 17 passing tests (5 + 7 + 5, ignoring the 1 combined-panel test that lives in the same T1 batch — see actual counts per file above), baseline 180/179/1 → 195/194/1.
- Typecheck: `node scripts/check-types.mjs` after each commit reports the same 2 pre-existing diagnostics (`extensions/gentle-ai.ts`, `tests/sdd-native-managed-uptake.test.ts`) present on a clean `git stash` of this branch's base — confirmed by stashing all changes and re-running; zero new diagnostics from this feature. One diagnostic I introduced myself (`extensions/gentle-shell.ts` TS2322 on the `unsubscribe` cast) was fixed before the T2 commit.
- Full unit stage (`node --experimental-strip-types --test tests/*.test.ts`) launched in the background at closure time; produced zero output after 10+ minutes with dozens of `node.exe` child processes accumulating (`tasklist` showed 15+ concurrent node processes). This is the same class of hang the task brief already flagged for `npm test`/`pnpm test` on this Windows box, apparently also reachable through the plain glob invocation across the full `tests/*.test.ts` set (not just the sequential package-script runner). Left unresolved: could not get a full-suite result this session. The 4-file focused run (195/194/1, matching the known baseline fail) and the typecheck diff-against-base are the verification actually completed and are the evidence this feature's own changes are correct; they do not rule out an unrelated regression elsewhere in the ~40+ other test files this repo has.

## Next step

Re-run the full unit stage on a host/shell where it does not hang (or bisect which test file triggers the hang), confirm no new failures beyond the known baseline one, then close T4 (no PR until #1399 carries `status:approved`).

## Closure evidence (2026-09-24)

- Native review (RDD): assessment `high` (`process_boundary` in `extensions/gentle-shell.ts`, 7 paths, 554 changed lines). Lineage `review-a30d0844b8aa453d`, target `sha256:a753ee7f…fa09`, four lenses captured in process (`review-risk`, `review-resilience`, `review-readability`, `review-reliability`), all `admission_decision: completed`; final status `approved_acknowledgement_required`; `review acknowledge-approved` returned `authority: burned`. No correction was opened. A first lineage (`review-c2d733e5e390689f`) was negotiated on tree `2f237a15` and refused with `stale_target_identity` after the evidence commit `1afc2e2a` moved the tree; the review above covers the final tree `0c7dca23`.
- `node scripts/check-types.mjs`: same 2 pre-existing diagnostics as base, 0 new.
- `node scripts/build-runtime-modules.mjs --check`: runtime matches TypeScript sources (7 generated modules).
- `node scripts/check-provider-contract.mjs`: provider contract mirror check passed (contract 1.2.0).
- `node scripts/verify-package-files.mjs`: package resource check passed (171 files).
- Full unit stage on this Windows host: `node --experimental-strip-types --test tests/*.test.ts` stalls after ~1500 results (no output for 20+ minutes, killed). The failures accumulated before the stall are all in launcher/installer/symlink/Git-child tests unrelated to the changed files; the authoritative full run is CI (`pnpm test` on ubuntu-latest).
