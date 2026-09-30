# Fix #1491: modified-file diffs render incorrectly in Windows Terminal

## Objective
Sanitize diff lines and expand tabs to prevent column misalignment and vertical frame separator artifacts in Windows Terminal and other terminals when displaying modified file diffs.

## Problem
In `lib/shell-changes-view.ts`, `colorDiff` splits raw diff text on `\n` without stripping `\r` (CRLF) or expanding tabs (`\t`). When diff lines contain tabs or trailing `\r`, terminal tab stops and carriage returns disagree with `visibleWidth` and `truncateToWidth` from `@earendil-works/pi-tui`. This causes text displacement, broken column alignment, and visual frame corruption (`│` separator shifted) across the diff pane.

## Solution
In `lib/shell-changes-view.ts` (`colorDiff`):
1. Sanitize each line using `sanitizeTerminalText(rawLine.replace(/\r/g, ""))`.
2. Expand tabs (`\t`) to 2 spaces (`"  "`) before classification and theme coloring.
3. Add regression tests in `tests/shell-changes-view.test.ts` for tabbed and CRLF modified diffs, asserting that the rendered two-pane frame maintains exact visible width without alignment artifacts.

## Tasks
- [ ] 1. Write failing regression test in `tests/shell-changes-view.test.ts` for tabbed and CRLF diffs (RED).
- [ ] 2. Sanitize and expand tabs in `colorDiff` in `lib/shell-changes-view.ts` (GREEN).
- [ ] 3. Run all tests in `tests/shell-changes-view.test.ts` and verify 32/32 pass.
- [ ] 4. Commit and open PR referencing #1491.
