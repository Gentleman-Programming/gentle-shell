# PR #1385 Review Fixes

## Objective

Resolve the verified CodeRabbit review findings on PR #1385 (`#1340` questionnaire preview bounds) before merge.

## Problem

1. `previewScrollable` is not reset when moving focus from an option with a preview to an option without one, leaving stale scroll hints and mouse wheel interception active.
2. In inline layout, `maxInlinePreviewRows` is derived solely from terminal height without subtracting rows reserved for question headers, option descriptions, custom input, and chrome, causing tall option lists to overflow terminal bounds.
3. `previewPageSize()` uses a static terminal subtraction (`terminalRows - 8 = 16` at 24 rows) instead of the actual visible content rows (`contentRows = 8` in inline layout), causing PageDown to skip lines 9–16.

## Scope

- Reset preview scrollability and visible rows before render branches in `lib/questionnaire/questionnaire-view.ts`.
- Calculate inline preview row allocation dynamically after reserving rows for question, options, custom row, and chrome.
- Align `previewPageSize()` with the active layout's visible content rows so PageDown/PageUp navigates without line skips.
- Add strict TDD regression tests for each case in `tests/questionnaire-view.test.ts`.

## Constraints

- Keep the patch minimal and limited to PR #1385 review findings.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.
- Strict TDD discipline: RED test confirmed before implementation fix.

## Tasks

- [x] **T1 — Reset preview scrollability when selected option lacks preview.** Clear `previewScrollable` and active preview row counts before render branches, ensuring hint and wheel handlers stay consistent with current selection.
- [x] **T2 — Dynamically budget inline preview rows.** Reserve space for tabs, headers, options, custom row, and hints before sizing inline preview.
- [x] **T3 — Derive previewPageSize from visible content rows.** Ensure PageDown in inline and split layouts steps by visible content rows so no preview lines are skipped.
- [x] **T4 — Full test suite and typecheck verification.** Verify all tests pass cleanly and typecheck passes.
