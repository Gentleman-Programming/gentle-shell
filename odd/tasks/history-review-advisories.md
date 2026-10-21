# History review advisories

## Objective / authorization
Resolve the five non-blocking native-review advisories left on #1477 and #1480, in one PR, then merge. User authorized: "pr y merge" → "si".

## Advisories
- [x] A1 (#1477, WARNING, `extensions/history/store.ts` ~535-539): sweep carry sibling for the global seed (`history-global.jsonl.carry-*.jsonl`) is not drained by `drainGlobal`.
  - Outcome: REAL defect, fixed. The carry sibling lives in the store root, outside every project dir, so neither `drainGlobal` nor `deleteFromGlobal` listed it. New `listGlobalSeedCarries(root)` feeds both: the drain orders the carries (newest first) after every project file and right before the seed (their bytes are newer than the seed, legacy stays last); tombstones apply through the shared `drainWithHidden`. `deleteFromGlobal` sweeps them too, so a delete reaches every copy.
  - Evidence: `tests/history-scope-delete.test.ts` "the global scope drains and deletes the global seed's carry sibling". RED: drained `['project-newest','legacy-keep']`, expected `['project-newest','raced in','legacy-keep']`. GREEN: passes (hidden raced line filtered, order kept, second delete removes the carry copy).
- [x] A2 (#1477, WARNING, `extensions/history/index.ts` ~739-744): hide-failure notice on the non-store (session-derived) delete path.
  - Outcome: NOT a defect; no code change. The non-store branch of `executeDelete` notifies `hide.message` and returns before the splice. `hidePrompt` only returns two error messages ("Could not write the hide file; the prompt may reappear." and the hidden.json recovery message); neither claims the prompt is hidden. The branch is also unreachable from the UI: open-flow records come from drains as strings (no `source`, treated as `editor`), `deleteCurrent` drops session rows before arming, and the armed confirm is modal.
  - Evidence: `tests/history-delete-confirm.test.ts` "a failed hide on the non-store path reports the hide error and keeps the row" (source-parse of the branch + both real `hidePrompt` error results: rename failure and corrupt hidden.json). Passes on unchanged code; no RED applies because no behavior changes.
- [x] A3 (#1477, SUGGESTION, `extensions/history/store.ts` ~1036-1040): a partial append during carry can leave a torn fragment.
  - Outcome: REAL defect, fixed on the writer side. A failed `appendFileSync` could leave part of the carried bytes without a trailing newline; the owner's next capture merged with it into one corrupt line (lost prompt). `carryIntoRewrite` now calls `trimTornTail(file)` before writing the carry sibling: it truncates only bytes after the last newline (complete lines are never touched; best effort, never throws). The sibling still keeps every carried byte. Reader-side recovery was rejected: it would contradict the existing assertion in `tests/history-multi-reader.test.ts` that a torn fragment plus merged entry parses to null.
  - Evidence: `tests/history-scope-delete.test.ts` "a partially written carry-over leaves no fragment for the next append". RED: file lines parsed to `['keeper', null]`. GREEN: `['keeper','after-carry']`, and the drain holds `after-carry`, `keeper`, `raced in`.
- [x] A4 (#1480, WARNING, `extensions/history/index.ts` ~1206-1220): live `overlayOptions` margin/visible function behavior is not proven by tests.
  - Outcome: coverage gap, closed with tests; the behavior was already correct (no source change). New tests in `tests/history-overlay-margin.test.ts`: "the open picker's margin follows the real sidebar across the breakpoint and teardown" (real `installSidebar`, opened at 139 columns: no margin; 140: rail margin 54; 139: none; 140 then sidebar teardown: none) and "the margin getter reports the value refreshed by the last visible() pass".
  - Evidence: characterization tests pass on current code. Sensitivity checked by a temporary mutation (removed the `rightMargin` refresh in `visible()`): both new tests and the existing live-margin test failed (3 failures); mutation reverted, 14/14 pass.
- [x] A5 (#1480, WARNING, `extensions/history/index.ts` ~556-557): scope radio fit check may be off by one column.
  - Outcome: REAL defect, fixed. Stacked and compact rows print the radio after one leading space, but the fit check compared `width >= radioFull.length`; at exactly 34 columns the full radio was chosen and truncated with an ellipsis. The check is now `width >= radioFull.length + 1` (inline mode always fits it by construction).
  - Evidence: `tests/history-header-layout.test.ts` "the full radio shows exactly when its row, leading space included, fits" (width == needed: full radio, exact row; needed - 1: abbreviated, no truncated header row). RED: `' ◉ Current project | ○ All projec…'`. GREEN: passes; the existing `RADIO - 1` test is unchanged and passes.

## Constraints
Strict TDD by configuration (`node --experimental-strip-types --test`). Fix only still-valid defects; document any advisory found invalid with evidence. Route: delegated writer (2+ non-trivial files).

## Checks
`node --experimental-strip-types --test tests/*.test.ts`, `node scripts/check-types.mjs`, `git diff --check`, native review, five required CI checks.

## Progress
2026-09-26: branch `fix/history-review-advisories` from main `50b2af778`.
2026-09-26: A1-A5 resolved by the delegated writer (route: delegated, writer trigger: `store.ts` + `index.ts` + four test files). Docs: `docs/prompt-history.md` delete section now states that carry files belong to their source file's scope (A1 is user-visible). Not committed; commit, native review, PR, and merge remain with the parent.

## Verification evidence (writer)
- `node --experimental-strip-types --test tests/*.test.ts`: 3897 tests, 3854 pass, 0 fail, 43 skipped.
- `node scripts/check-types.mjs`: exit 0 (188 recorded diagnostics, no regressions).
- `git diff --check`: clean.

## Next step
Parent: work-unit commit(s), RDD assessment/review, PR, five required CI checks, merge.
