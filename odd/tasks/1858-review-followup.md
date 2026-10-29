# #1858 review follow-up: integrate the chain tip into the tracker

Branch: `feat/1829-audio-integrate-tracker` (from `feat/1829-audio-04-events`), target: `feat/1829-audio-tracker`.
Source: ElCaaarnal's changes-requested review on #1858 plus the CodeRabbit findings already fixed in `e07c154d`.

## Tasks

- [x] Merge `feat/1829-audio-tracker` into the chain tip, resolving conflicts toward the chain tip. Evidence: `f6e6d93c`.
- [x] Re-apply the cleanup fix on the integrated `play()` so no early `return` skips the cleanup error, and include bounded stderr in the process failure message. Test-first.
- [x] Remove the remaining absolute local paths from `odd/tasks/sound-notifications.md`.
- [x] Open the PR into `feat/1829-audio-tracker` with `Refs #1829`.
- [x] Convert #1858 back to draft and refresh its body with the real head, size and state.

## Non-goals

- Rebasing the tracker onto `main`: deferred until the chain is integrated, as requested in the review.
- Any merge into `main`.
