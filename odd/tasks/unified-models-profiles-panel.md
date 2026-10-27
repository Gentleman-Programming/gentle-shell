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
- [x] T7 `tests/runtime-harness.mjs` migration (writer task `mvppl322-1-qm07`; visit sequences profiles→editor→close, store-only save assertions, commit `d82a22014`).
- [x] T8 Full suite: unit 7348 pass / 0 regressions, provider-contract PASS, runtime-harness PASS. The 4 TTY launcher failures reproduce identically on main (`main-wsl2-01a14c1b`) through the suite runner — pre-existing environment flake, not caused by this change.

## Live-feedback iteration (2026-09 session)
- Coherence: `enter` and a profile click now open the SAME action menu ("Usar en esta sesión" is its first item); clicks never apply.
- A click on one agent's routing row in the detail pane opens the routing editor focused on that agent — model column → model picker, effort column → effort picker (`edit-routing` result carries `focus`).
- Editor picker titles are Spanish-coherent (`Modelo · <agent>`, `Effort · <agent>`).
- Pre-existing environment flake confirmed on main: the 4 TTY launcher tests fail through `run-test-suite.mjs` on `main-wsl2-01a14c1b` too.

## Live-feedback iteration 2
- The detail pane no longer dumps the effective routing as a second full table (it read as duplication when identical). It now shows a diff: `Efectivo: idéntico al perfil ✓` when the effective routing matches, otherwise `Cambios al aplicar — efectivo → perfil (N)` with one row per changing agent.

## Live-feedback iteration 3
- All UI copy the unified panel introduced is English: action menu items, footer hints, orchestrator picker (Save/Clear/Back), and the effective-routing diff (`Effective: identical to the profile ✓`, `Changes on apply — effective → profile (N)`).

## Live-feedback iteration 4
- The routing editor's model/effort pickers no longer replace the whole screen (the standalone panel's look — Back felt like switching to a second UI). They now render as a centered card over the still-visible agent table, matching the action menu and orchestrator picker. Picker regions are content-relative and translated into frame coordinates by renderPickerOverTable.

## Design reset after live feedback (variant A · table-first)
Three surfaces, two duplicate tables, and a 12-item menu made the unified panel hard to reason about. The panel is now ONE table: orchestrator first row, agents below, popovers for model/effort, profiles as a compact popover state list. `Use in session` / `Apply global` / `Save` operate on exactly what the table shows (WYSIWYG), reusing the guarded apply-global flow. ProfilesPanel, RoutingEditorPanel, and OrchestratorPickerPanel are replaced by RoutingTablePanel.

## Variant A · profiles as tabs (user choice, 2026-10-27)
Design artifact: `odd/design/models-profiles-ui-proposal.html` (variants A/B/C; user picked A on recommendation).
- Tabs are profiles with scope glyphs (◉ session, ★ default, ⌂ repo); ←→ or click switches, with a Save and switch / Discard / Stay guard for unsaved edits.
- Orchestrator is the first row; the Model ▾ / Effort ▾ header sets every agent (replaces the Set all agents row); effort is a one-line strip; the model list marks the current value and offers Custom model id….
- Footer is three buttons: Use in this session (u), Make default (d), Save (s). the profile menu ▾ on the active tab (m): Rename, Duplicate, Use in this repo, Delete. + New (n): copy, from what's running now (replaces Snapshot), empty.
- File operations moved to subcommands: /gentle:models export|restore, /gentle:profiles export <name>|import|publish <name>.
- Fixes found in the redesign: hover used toolPendingBg (#100A0F, invisible on the #060407 Gentleman-Cute background) and now uses selectedBg; pointer actions ran on both press and click, so one click could fire two actions — they now run on click only.

- Live feedback: the ⋯ glyph read as truncated text (same as …). The active tab now shows ▾ and the hint reads "m menu".

## Test migration (variant A) and defects it surfaced
- The background test writer (task mvqyms23-1-maaf) made no progress in 86 turns (65 changed lines, contract changed under it four times) and was cancelled; the parent migrated the tests inline.
- Defects found and fixed while migrating: control sequences in an agent name glued the name to its model (padding measured before sanitizing); provider review roles lost their "Pi persisted default" inherit label in the effort row (gentle-pi#2271); their table cells were cut at 60 columns ("Pi default" now); letter shortcuts compared raw input, so terminals using the kitty keyboard protocol could not use e/s/u/d/n/m/j/k (now matchesKey); the use-session bind lived only in the loop (restored as a runProfilesPanelAction case shared with tests).
- The runtime harness could pass falsely: a mocked panel that never finished let Node drain the event loop and exit 0 with later sections skipped. Earlier "runtime-harness PASS" reports after the table-first rewrite (da497a7b9) were not reliable. The harness now fails when run() has not completed at exit.
- Tests removed with the UI they covered (contracts re-covered on the new screen): the 12-item action menu, the orchestrator picker, the detail pane (line scroll, "now" line, effective-routing table, (session) refresh after snapshot), and s snapshot (replaced by + New › From what's running now).

## Notes
- Writer delegation for T7: gentle-ai-worker task `mvppl322-1-qm07` (runtime-harness only).
- The 4 TTY launcher failures (`tests/gentle-shell-bin.test.ts`) reproduce on main through `run-test-suite.mjs` (verified) but pass in isolation in both trees: pre-existing PTY-timing flake under parallel load.
- Slice boundary: commit `68179a0b8` (1889 authored lines — editor + panel integration + unit tests + docs). Delivery strategy: single feature commit; runtime-harness migration lands as its own commit.
