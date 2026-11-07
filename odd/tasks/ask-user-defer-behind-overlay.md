# Defer ask_user tools while a fullscreen overlay menu is active

Fix base for issue #2995: a docked `ask_user*` question mounts invisible behind a
fullscreen overlay menu; the first Escape silently cancels it and the second closes
the menu. Chosen direction (user-approved): queue/defer `ask_user_choice` and
`ask_user_question` while a fullscreen overlay menu has interaction in progress.

## Specs

- S1. A new extension event `gentle-pi:fullscreen-activity` with payload
  `{ active: boolean; source: string }` is emitted when a fullscreen overlay menu
  opens (`active: true`) and closes (`active: false`); `source` is a unique,
  non-empty per-menu id (e.g. `"gentle-shell:profiles"`).
- S2. Every `ctx.ui.custom(..., { overlay: true })` fullscreen menu emits the event
  around its interaction, even when the menu run throws; dock-only dialogs do not.
  Sites: extensions/gentle-agents.ts (2), extensions/gentle-ai.ts (1),
  extensions/gentle-guide.ts (1, nonCapturing case included),
  extensions/gentle-shell.ts (5), extensions/gentle-stats.ts (1),
  extensions/history/index.ts (1), voice overlays via lib/voice-command.ts openOverlay.
- S3. `ask_user_choice` (TUI mode) and `ask_user_question` (TUI mode) defer mounting
  their dialog while fullscreen activity is active: they wait until the activity set
  is empty, staying resilient to open/close ordering and duplicate events, and they
  proceed when the set is empty (including immediately).
- S4. Deference is stateless across turns: the ask tools observe the shared event bus
  (`pi.events`), they do not import menu components, and no menu imports ask tools.
  The active-state tracking lives in one lib module (`lib/fullscreen-activity.ts`).
- S5. When the wait is aborted by the request signal, the ask tool returns its normal
  cancelled result without mounting a dialog and without emitting a blocked `active: true`.
- S6. RPC-host and non-TUI ask paths keep their existing behavior (no defer), and the
  existing `gentle-pi:ask-user-choice:blocked` / `gentle-pi:ask-user-question:blocked`
  lifecycle events keep firing on actual (post-defer) dialog mount/unmount only.
- S7. The new event envelope is documented for extension authors next to the existing
  one (docs/readme-reference.md adapter projection section) with the payload contract
  and the known residual race: a menu opened during the ask's mount step may still
  cover the dialog; reconciliation is capped at the defer entry, not continuous.

## Tasks

- T1 (S1, S4) lib/fullscreen-activity.ts: event name, payload shape, emit helper,
  `withFullscreenOverlay` wrapper, `FullscreenActivityMonitor` (set-based state,
  duplicate/unknown-source tolerance, signal-aware wait). Tests first.
- T2 (S2) Wrap all overlay:true menus with the emit helper.
- T3 (S3, S5, S6) Wire the monitor into ask-user-choice.ts and ask-user-question.ts
  TUI paths; defer before dialog mount. Tests first.
- T4 (S7) docs/readme-reference.md: document the event contract.
- T5 Checks: focused node --test, full pnpm test suite, typecheck ratchet (baseline 0).
- T6 (delta) Independent verify (gentle-ai-verify, read-only) found 4 in-scope
  findings, fixed in a8072fdc6. Full suite deltas measured main-vs-branch with
  per-file TAP under identical isolation (jobs 13/14): 444 unique (name,file)
  failures, all 444 common to both sides (0 branch-only, 0 main-only). The
  failures are environment-level (EPERM symlink without Developer Mode, module
  loading, sandbox notifications); no regression from this change.

## Log

- L1. User request (handover from session 01a1b5d9): "preparar la base del PR del fix
  para Gentleman-Programming/gentle-shell issue #2995 (defecto ask_user invisible
  detrás de menús fullscreen overlay)... DIRECCIÓN DEL FIX (elegida con el usuario):
  cola/defer de ask_user* mientras un menú fullscreen overlay tenga interacción en
  curso... Idea de implementación: evento nuevo 'fullscreen activity open/close'
  emitido by cada menú overlay, y que los ask tools hagan defer/retry-check cuando
  esté activo, sin duplicar autoridad ni acoplar a componentes concretos; documentar
  el evento si es API pública nueva." Restrictions: local commits on a new fix/*
  branch are fine; push + PR need explicit user approval; do not touch the issue
  thread (already complete) or the orca feature (deleted).
- L2. node_modules realigned to lockfile 1.4.0: pnpm importPackage fails
  reproducibly on this machine (IVED ENOENT for pi-agent-core tmp dir, 4 runs),
  so pi-agent-core, pi-ai and pi-coding-agent were replaced from `npm pack`ed
  1.4.0 tarballs (node_modules is git-ignored). The handover's "~185 diagnostics
  ratchet" is stale: committed baseline is 0 (clean) and the pass with 1.4.0 types
  is verified. pi-tui 1.4.0 and pi-coding-agent 1.4.0 mechanism quotes verified
  in place: showOverlay saves preFocus and setFocus only when visible and not
  nonCapturing; non-overlay focus records stopped plus assigns focus anyway;
  key dispatch only to focusedComponent; docked dialog mounts via
  pushExtensionDialog (editor slot) with ui.setFocus → hidden under fullscreen
  overlay; resolveBlockedOverlayFocusResume restores the overlay on unmount.
- L3. A later pi-lens scan of gentle-agents.ts flagged 5 pre-existing empty
  catch blocks (same code proven identical in `git show main:extensions/gentle-agents.ts`,
  untouched by this feature's diff). T2 stays spec-scoped; the five catches were
  annotated with a best-effort rationale comment in a separate lint slice to
  unblock the automated checker without expanding the feature review surface.
- L4. Implementation evidence: `withFullscreenOverlay` emits close after the
  custom promise settles, so the close event lands once the overlay is hidden
  and the editor slot restored; `waitIfActive` returns `"released" | "aborted"`
  so S5 aborts stay distinguishable from S3 releases; `FullscreenActivityMonitor`
  counts opens per `source` (Map) so duplicates cannot deadlock and
  unrelated closes cannot release early. `FullscreenActivityEmitter.events`
  stays optional: production sources always carry the pi bus; profile-flow
  `LiveSession` types events as an Optional (Partial `Pick`), and test fixtures pass
  store-only instances; a missing bus publishes nothing. ask tools keep the
  pre-wait aborted-signal mount behavior exactly (S6) and return the tool's own
  cancelled shape on wait-stage aborts (S5). Existing ask tool tests (choice +
  question suites) keep passing unchanged.
- L5. Deferred-turn typecheck/smoke results: lib 14/14, defer suite 21/21,
  repo typecheck gate green (baseline 0) on the final wiring; full test-suite
  run is the acceptance check pending this log entry's commit.
