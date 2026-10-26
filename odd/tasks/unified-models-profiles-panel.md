# Unify /gentle:models into /gentle:profiles with a pointer-driven routing editor

## Objective
One fullscreen surface for model routing: `/gentle:models` and `/gentle:profiles` open the same profiles panel, and each profile's routing is edited in place with a mouse-first (but keyboard-complete) routing editor.

## Problem
Two overlapping commands: `/gentle:models` edited global routing in a keyboard-only panel with different visuals, while `/gentle:profiles` managed the profiles that actually own that routing. The user asked to unify them and make the model-picker UI "LINDA" (beautiful), useful, intuitive, and mouse-responsive (hover + click).

## Design
- `/gentle:models` keeps its housekeeping (legacy override migration, invalid `models.json` surfacing, store seeding) and then opens the same `ProfilesPanel` loop as `/gentle:profiles`, preselecting the current profile target (pin, else active).
- New `RoutingEditorPanel` (replaces `SddModelPanel`): fullscreen table `AGENT | MODEL | EFFORT` plus `orchestrator` and `Set all agents` rows; searchable model picker; effort picker; clickable footer buttons (Save · Custom · Inherit · Export · Restore · Cancel).
- Mouse: hover fills the whole row (pending background, same as the profiles list), click on a row opens the model picker, click on an `effort=` cell opens the effort picker, wheel scrolls lists and moves the cursor, footer buttons act on click. Hit regions are recorded in terminal coordinates during render (+1 row for the card border, +2 columns for the border/space).
- Keyboard preserved from the old panel: `j/k`, `enter`, `e`, `i`, `c`, `x`, `r`, `g`/`G`, `ctrl+s` (save), `esc`.
- Save semantics: the editor writes the draft into the selected profile via `updateProfile` + `writeProfilesFileSync`. No global `models.json` write, no materialization, no live-model switch. Applying globally remains the profiles panel's `a` with its existing confirmations.
- ProfilesPanel gains `m` (edit routing) and pointer support in the detail pane: hovering a Profile routing row fills it; clicking one opens the editor for the shown profile.
- Export/restore of `models.json` move into the editor (`x`/`r`, also clickable).
- The old `u` (save routing + snapshot into current profile) is superseded: saving the editor IS the profile write. `resolveCurrentProfileTarget` still drives the `/gentle:models` preselection.

## Constraints
- Reuse the panel action-loop pattern: no nested overlays; every action reopens panels and reads fresh state.
- All existing guardrails intact: apply-global confirmations, pin honesty notes, escape-stripping of agent/model labels.
- Tests: `tests/gentle-ai.test.ts` routing-editor suite (render, terminal fill, pointer interactions, store writes); `tests/runtime-harness.mjs` migrated to the new visit sequences.

## Tasks
- [x] T1 `RoutingEditorPanel` with mouse hit regions, hover fill, clickable footer, model/effort pickers.
- [x] T2 `edit-routing` result + `m` key + detail-pane routing-row click/hover in `ProfilesPanel`.
- [x] T3 `runProfilesPanelAction` edit-routing loop (custom model input, export, restore, save-to-store).
- [x] T4 `/gentle:models` as preselecting alias (`openProfilesPanelLoop` extraction); remove `SddModelPanel`/old handler/`u` helpers.
- [x] T5 Unit tests: updated model-panel tests + new pointer tests (hover, click-to-picker, option commit, footer buttons, effort cell, wheel).
- [x] T6 Docs: `docs/readme-reference.md` models/profiles sections and command table.
- [ ] T7 `tests/runtime-harness.mjs` migration (delegated, in progress).
- [ ] T8 Full suite green + commit.

## Notes
- Writer delegation for T7: gentle-ai-worker task `mvppl322-1-qm07` (runtime-harness only).
- Known flaky under parallel load: 4 TTY launcher tests in `tests/gentle-shell-bin.test.ts` passed in isolation and on main; re-verify in the final full run.
