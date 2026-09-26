# History follow-ups

## Objective / authorization
Deliver the pending prompt-history follow-ups after the contributor chain (#1390–#1394) merged and tracking issue #818 closed. User authorized: "haz los pendientes" (implement, review, merge).

## Problem
- Capture can only be enabled through `GENTLE_PI_HISTORY_CAPTURE`; a running Pi process cannot persist environment changes, so users need a persisted control in Gentle → Customize.
- Native review advisories on the merged history slices were deferred: GC carry-over after unlink, perpetual line-threshold compaction, and other non-blocking reliability notes. Selector search: `Home`/`End` move list selection instead of the search caret, and `End` loads every record.
- The contributor removed the responsive header and sidebar-aware overlay margin from #1394 (commit `e2cca1f9b`) for a later PR.

## Constraints / decisions
- Capture stays default-off. Precedence: an explicit `GENTLE_PI_HISTORY_CAPTURE` value (on: `1|true|on`, off: `0|false|off`) wins; otherwise the persisted Customize setting; otherwise off. Turning capture off never deletes stored history.
- Follow existing Customize persistence (`lib/visual-customization-policy.ts`, `lib/visual-customize-view.ts`, `extensions/gentle-shell.ts`) and existing policy-file conventions; live change without restart where the existing pattern supports it.
- `hidden.json` keeps sha256 tombstones with legacy plaintext compatibility (decided).
- Preserve contributor attribution when restoring `e2cca1f9b^` work.
- Strict TDD active by configuration; runner `node --experimental-strip-types --test`.

## Route and delivery
Delegated direct: each task touches 2+ non-trivial files; one writer at a time. Strategy: one PR per task (independent rollback), each with an approved issue, native review on the work-unit commit, required CI, then merge. ~400 authored-line heuristic is advisory only.

## Tasks
- [x] F1: Persisted History capture toggle in Customize with env precedence, docs and tests. Route: delegated (Customize + history + docs).
- [x] F2: History reliability follow-ups: GC carry-over after unlink, perpetual line-threshold compaction, still-valid review advisories, `Home`/`End` search caret. Route: delegated.
- [ ] F3: Restore responsive header and sidebar-aware overlay margin from `e2cca1f9b^` onto current main with tests. Route: delegated.
- [ ] F4: Remove temporary worktrees from the chain work. Route: inline.

## Acceptance and checks
`node --experimental-strip-types --test tests/*.test.ts`, `node scripts/check-types.mjs` (no regressions vs baseline), `git diff --check`, native review approved per PR, five required CI checks green.

## Progress
2026-09-26: Worktree `history-followups` on branch `feat/history-customize-toggle` from main `45240bcc2`. Engram mirror stored in the gentle-ai project (session binding); gentle-pi mirror pending.

2026-09-26 F1 (delegated writer): implemented, uncommitted; awaiting parent review and work-unit commit.
- New `lib/history-capture-policy.ts` (sibling of `vim-policy.ts`): `<configHome>/history-capture.json`, schema `gentle-pi.history-capture/v1`, strict validation, atomic write; `resolveHistoryCapture` (status) and `historyCaptureEnabled` (per-prompt gate; an explicit env value short-circuits without reading the file).
- `extensions/history/index.ts`: `HistoryDeps.gentlePiConfigHome` seam; `captureEnabled(env, configHome)` re-read per prompt/open/shutdown; disabled warning names Customize → History, or the env override when env forces off.
- Customize: new `History` category (after Editor) with `Prompt history capture: enable|disable` rows, `(current)` and `· env override` markers, preview `preference · effective`; saving under an env override warns; malformed file is refused, never rewritten (Vim convention).
- Tests: new `tests/history-capture-policy.test.ts`; History-row tests in `tests/gentle-shell.test.ts` (`findCustomizeRow` now scans 9 categories); live toggle, env override, fail-closed in history suites; existing history harnesses now inject an empty config home so a developer's real preference cannot leak in. Two source-shape tests re-pinned to the delegated gate.
- RED observed: policy module missing; 3 extension tests (preference enable, live toggle, Customize message); 3 UI tests (rows missing). GREEN: all pass.
- Checks: `node --experimental-strip-types --test tests/*.test.ts` 3857 tests, 3814 pass, 0 fail, 43 skipped (baseline 3798/0/43); `node scripts/check-types.mjs` exit 0, no regressions; `git diff --check` clean.
- Docs: `docs/prompt-history.md` quick path + precedence table. `docs/readme-reference.md` has no Customize option list, so unchanged; the Customize paragraph lives in `README.md` (outside F1 edit surface) and does not yet mention the History category — proposed follow-up.
- Size: ~310 insertions/52 deletions tracked plus ~200 lines in two new files (above the advisory ~400 heuristic because of tests; not split).

2026-09-26 F2 (delegated writer, branch `fix/history-reliability-followups` from main `d615b2ed2`): advisories evaluated against current code; fixes uncommitted; `Home`/`End` blocked on a product decision.
- Fixed (strict TDD): (a) GC carry-over: complete late lines are appended to the compact file BEFORE the claim is removed (a failed append keeps the whole claim), then one post-removal drain; (b) GC idempotence: compaction runs only when >= 2 files can be merged, so a dir that stays above a threshold is not rewritten every shutdown; (c) `sweepFile`: a failed carry-over append after the rename keeps the raced bytes in a sibling `<file>.carry-<pid>-<ts>.jsonl` store file instead of losing them; (d) `executeDelete`: the partial-sweep notice is chosen after `hidePrompt` via `storeDeleteNotice`, with a new combined `STORE_DELETE_PARTIAL_HIDE_FAILED_TEXT`, so it never claims "hidden" when the tombstone failed; (e) #1475: the disabled warning reports a malformed/unreadable preference as invalid and names the file; (f) `tests/history-session-writer.test.ts` read the ambient home's Customize preference in `captureEnabled is a strict opt-in` (failed under a temp `HOME` with the preference on); every call now uses an empty config home.
- Not fixed: ownerless migration crash lock stays fail-closed by design (pinned by `an ownerless crash lock fails closed...`); documented manual recovery instead. `finally rmdirSync` throwing is contained by the caller's catch. Sweep ENOENT on a file GC just claimed stays a quiet no-op (never a false "deleted" claim).
- RED observed: 4 gc tests (late line absent at claim removal; claim held only the late line; second GC `merged: 1`; single-candidate `merged: 1`), 1 sweep test (`failed: 1`, raced line lost), 2 off-path tests (generic "turn on" copy), delete-confirm import error (missing exports), session-writer under temp HOME (`actual: true`). GREEN: all pass.
- Checks: `node --experimental-strip-types --test tests/*.test.ts` 3865 tests, 3822 pass, 0 fail, 43 skipped; `node scripts/check-types.mjs` exit 0, 188 baseline, no regressions; `git diff --check` clean.
- Docs: `docs/prompt-history.md` (invalid preference warning, migration lock recovery, sweep carry sibling, combined delete notice, two-file compaction minimum, carry-before-removal order).
- `Home`/`End` conflict (search input always focused vs. list jumps pinned by §B2/§D7) resolved by user choice 2, "by query": with any text in the search box (whitespace included) `Home`/`End` fall through to the search input and move its caret, and `End` never jumps or loads the list; with an empty search box the §B2/§D7 list jumps stay. Implemented as a `listOwnsHomeEnd()` guard on the two existing dispatch entries (12 entries, order, and handlers unchanged). New behavior suite `tests/history-search-caret-keys.test.ts` drives the real selector through the `history` command with a fake overlay host. RED: 3 failed (`Home` then "p" pasted nothing; caret-to-end then "3" pasted nothing; `End` with a query or whitespace-only query selected `p00`); the empty-query case passed before and after (pins existing jumps). GREEN: 4/4, plus `history-dispatch` and `history-lazy-windowing` unchanged and passing. Docs: new "Selector keys" section in `docs/prompt-history.md`.
- Checks after `Home`/`End`: `node --experimental-strip-types --test tests/*.test.ts` 3869 tests, 3826 pass, 0 fail, 43 skipped; `node scripts/check-types.mjs` exit 0, 188 baseline, no regressions; `git diff --check` clean (the new untracked test file also has no trailing whitespace). Uncommitted; no review invoked by the writer.

## Next step
Parent: review F2 and close it with a work-unit commit.
