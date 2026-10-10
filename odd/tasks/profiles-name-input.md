# Profiles panel name input feedback

## Objective

Make `/gentle:profiles` create, duplicate, and rename behave visibly and predictably when the name prompt is submitted.

## Problem

Reproduced in a real Pi 0.87.1 TUI (tmux, temporary HOME):

- The host `ctx.ui.input(title, placeholder)` ignores `placeholder` and does not forward an initial value, so the suggested name (`<name>-copy`, the current name, `e.g. deep-work`) is never shown. The field starts empty.
- Submitting the empty field returns `""`. `createProfile` / `duplicateProfile` / `renameProfile` reject it, and the warning from `ctx.ui.notify` is hidden behind the fullscreen profiles overlay that reopens immediately. It only becomes visible after closing the panel.
- A typed name works (verified store writes), but create and duplicate give no feedback, and the list selection stays on the previous row while the new profile is appended at the bottom.
- `tests/gentle-ai.test.ts` `routingConsumerFixture` has no `ui.input` / `ui.confirm`, so these flows have no coverage.

## Scope

- `extensions/gentle-ai.ts`: `runProfilesPanelAction` create/duplicate/rename branches, `handleProfilesCommand` loop, and the profiles panel rendering needed to show a result line.
- `tests/gentle-ai.test.ts` (fixture `ui.input`, new flow tests).
- No changes to `lib/agent-profiles.ts` validation or the host package.

## Constraints

- Keep `undefined` from `ctx.ui.input` meaning cancel.
- Empty submission: duplicate and rename fall back to the suggested name (`<name>-copy` / unchanged-rename is a no-op with a visible message); create treats it as cancelled with a visible message.
- Results (success, cancel, validation error) must be visible while the panel is open.
- After create/duplicate/rename the new name is selected when the panel reopens.

## Tasks

- [x] T1 — Empty-name defaults and in-panel feedback for create/duplicate/rename, with tests (RED first). Route: delegated direct (writer trigger: 2 non-trivial files).

## Acceptance criteria

- Submitting `""` on duplicate creates `<source>-copy` (or reports a visible conflict).
- Submitting `""` on create creates nothing and shows a visible "cancelled" message in the panel.
- Success and validation errors appear in the reopened panel, and the new/renamed profile is selected.
- Existing profiles tests stay green.

## Checks

- `node --experimental-strip-types --test tests/gentle-ai.test.ts tests/agent-profiles.test.ts`
- `pnpm run typecheck`
- `pnpm test`

## Delivery

- Branch `fix/profiles-name-input` from `origin/main`. Forecast ~150–250 authored lines; strategy `ask-on-risk`, single PR expected.
- Push/PR remain the user's decision.

## Progress

- T1 done. Actions return a `ProfilesPanelReport` (status + selected name); the reopened panel shows the status in its footer and selects the new/renamed profile. Input titles name the empty-field default.
- Evidence:
  - RED: 7 new tests failed before implementation (selection stayed on the source row, footer showed hints, titles lacked the suggestion).
  - `node --experimental-strip-types --test tests/gentle-ai.test.ts tests/agent-profiles.test.ts`: 144 pass, 0 fail.
  - `pnpm run typecheck`: exit 0, no regressions.
  - `pnpm test`: 4 failures in `tests/agents-view-thread-identity.test.ts` (3) and `tests/gentle-shell.test.ts:544`; identical on `origin/main` (211 pass / 4 fail for those two files), so pre-existing and unrelated.
  - Live Pi 0.87.1 TUI (tmux, temporary HOME): empty duplicate created and selected `opensource-copy` with footer status; empty create showed `No profile created: no name entered.`; named create selected the new profile.
- Known follow-ups (not in scope): renaming to the same name reports "already exists"; empty create reselects the first row.
- Engram mirror: pending (session bound to project `gentle-ai`; `gentle-pi` writes refused).

## Next step

User decides on push / PR (issue-first policy applies).
