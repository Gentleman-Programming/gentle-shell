# RDD section visibility

Locator: `odd/tasks/rdd-section-visibility.md` (worktree `gentle-pi-worktrees/rdd-section-visibility`, branch `feat/rdd-section-visibility` from `origin/main`).

## Objective

Add an `rdd` toggle to Visual customization → Sections so the user can hide the `🌹 RDD` group of the Status card, like the existing changes/agents/todo/usageCost/modelDetails toggles.

## Problem / why

The RDD sidebar group (PR #1500) cannot be hidden; every other optional section can.

## Constraints

- Backward compatible: saved `visual-customization.json` files and visual profiles with the legacy 5-key visibility object must keep loading (not become malformed); a missing `rdd` means shown (`true`). Newly written files include `rdd`.
- Unknown extra keys stay invalid, as today.
- Default: shown.

## Tasks

- [x] T1 — `rdd` visibility key with legacy compatibility in `lib/visual-customization-policy.ts` (type, default, parse/validate normalization) and `lib/visual-profiles.ts`, with tests. Route: delegated direct (one writer for T1+T2; 4+ files).
- [x] T2 — Hide the `🌹 RDD` group in `lib/shell-bar.ts` when `visibility.rdd === false`, and add `rdd` to the Sections rows in `extensions/gentle-shell.ts`, with tests.

## Acceptance criteria

- Sections shows `Section rdd: shown|hidden`; toggling persists and hides/shows the RDD group.
- A legacy 5-key settings file and a legacy profile load as valid with `rdd: true`.

## Checks

- Focused: `node --experimental-strip-types --test tests/visual-customization-policy.test.ts tests/shell-bar.test.ts tests/visual-customize-view.test.ts` plus any visual-profiles test.
- `node --experimental-strip-types --test tests/*.test.ts`, `node scripts/check-types.mjs`, `node scripts/check-provider-contract.mjs`, `node --experimental-strip-types tests/runtime-harness.mjs`.

## Delivery

Forecast ~150 authored lines; `ask-on-risk`; single PR.

## Progress

- Exploration: inline (policy, shell-bar, Sections rows located).
- T1+T2 implemented by one delegated writer (uncommitted; parent commits). Risk tier: medium (settings parsing compatibility + UI toggle, covered by focused tests).
  - Design: `VISUAL_SECTION_KEYS` (`changes, rdd, agents, todo, usageCost, modelDetails`) is the single key list, used by `isVisualSettings` and the Sections rows; `rdd` follows `changes` like the RDD group follows Changes in the Status card. `normalizeVisualSettings` (reader side) accepts the exact legacy 5-key visibility and fills `rdd: true` in canonical order; `isVisualSettings` stays strict so writers persist 6 keys. `parseVisualSettingsFile` and `parseVisualProfilesFile` normalize before strict validation.
  - RED observed: policy test failed to import `VISUAL_SECTION_KEYS`; visual-profiles legacy-profile test failed; shell-bar `rdd` hide test failed. visual-customize-view needed only fixture updates (no meaningful RED).
  - GREEN: focused 4 files 75/75 pass.
  - `node --experimental-strip-types --test tests/*.test.ts`: 3976 tests, 3933 pass, 0 fail, 43 skipped.
  - `node scripts/check-types.mjs`: 188 recorded diagnostics, no regressions (10 file/code pairs improved), exit 0.
  - `node scripts/check-provider-contract.mjs`: passed, exit 0.
  - `node --experimental-strip-types tests/runtime-harness.mjs`: exit 0.
- Next: parent review and work-unit commit.

## Closure evidence

- Commits: T1 `1dda0cadd`, T2 `5d4738218`. Route: delegated direct (one gentle-ai-worker for T1+T2).
- Parent spot check: focused visual tests 75/75. Writer: unit stage 3933 pass / 0 fail; check-types no regressions; provider-contract pass; harness exit 0.
- Native review `review-61e833cf203bc725` (medium, reliability lens) approved and acknowledged.
- Advisory follow-ups: a legacy `null` visibility value coerces to shown via `??` (then fails strict boolean check only for non-null); null case untested; Sections row list not covered by a test.
