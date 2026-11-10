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
- L6. Upstream sync: main moved 4ee18723f -> f4cc69a33 (release 4.7.0) with 24
  commits (review delivery preflight, bounded RDD startup, session consent,
  execution-surface guard, design-canvas autofit, images disk cache). Nothing
  upstream fixes #2995: the log for `4ee18723f..origin/main` filtered by
  `ask_user|overlay|defer|fullscreen` is empty. pi-tui and pi-coding-agent stay
  at 1.4.0 in the lockfile, so the mechanism this fix targets (focus dispatch
  only to the focused component, overlay restore on unmount) is unchanged. The
  eight commits were rebased onto f4cc69a33 with zero conflicts (backup tag
  `backup/pre-main-sync` -> ac9927cdd); the only shared file is
  extensions/gentle-ai.ts and the upstream hunks sit far from both touch points.
  Re-verified on the new base: typecheck 0 diagnostics, the four feature suites
  80/80, and the wrap inventory still 1:1 — 12 `overlay: true` sites against 12
  `withFullscreenOverlay` calls — so no upstream menu slipped past the defer.
  `build-runtime-modules.mjs --check` still matches its 16 generated modules.
- L7. Field verification by the user on the rebased tree, launched with
  `node bin/gentle-shell.mjs --link --package-root .` (loads this working tree as
  the gentle-pi package against the real pi home). The menu exercised by hand was
  `/gentle:profiles` (the routing-table panel, `gentle-ai:routing-table`): the
  ask dialog deferred instead of mounting hidden beneath it and mounted once the
  panel closed. User verdict: "funciona". That is the only menu field-tested; the
  remaining eleven wraps are covered by the unit suites, not by hand.
- L8. Scope audit before delivery: HEAD has 15 `ctx.ui.custom` call sites. Twelve
  carry `overlay: true` and all twelve are wrapped, so the inventory is 1:1. The
  other three (the two ask dialogs themselves and non-overlay docked dialogs such
  as the music inherit prompt and the review-consent UI) do not take the
  fullscreen overlay path, so the defer does not apply to them by design. The
  documented residual race stands: a menu opening while an ask is already mounted
  still covers it. The upstream repository ships no PULL_REQUEST_TEMPLATE, so the
  PR body follows the branch-pr format directly.
- L9. User approved delivery: push the branch and open the PR. The PR states
  honestly that exactly one menu was verified by hand and that the rest rely on
  the unit suites. Direct push to the upstream was rejected (403): none of the
  contributor accounts holds write on the organization, so the delivery goes
  through the `risaavedraf/gentle-shell` fork. PR #3052 opened against
  `Gentleman-Programming/gentle-shell:main`.
- L10. Delivery size decision: the branch is 993 authored lines (956 added, 37
  removed) against the advisory ~400 review budget — 311 production, 550 tests,
  132 docs. One honest slicing pass was tried (contract plus its tests 478, the
  twelve wraps 102, the defer plus its tests 281, docs 132) and no cohesive split
  both lands independently and respects the budget: the contract and the wraps
  change no observable behavior on their own, and the contract slice alone
  already exceeds 400. The single PR was kept and the numbers, the split analysis
  and the residual-race caveat were recorded as a PR comment
  (issuecomment-6742870480). The repository defines `size:exception`, but the
  contributor account has no triage permission, so a maintainer must apply it.
- L11. Repository-wide suite over the rebased tree: the `unit-tests` stage failed
  only on environmental causes (7 EPERM symlink errors in the writer fixtures),
  and `provider-contract` together with `runtime-harness` reported FAIL without
  executing because that background shell had no `pnpm` on PATH. Both were
  re-run directly: `node scripts/check-provider-contract.mjs` passes (contract
  1.4.0, 10 bundle entries), and `node --experimental-strip-types
  tests/runtime-harness.mjs` ran 13 times in total — one assertion at line 445
  (`discovered.errors` came back non-empty) on the first run immediately after
  the 35-minute suite, then twelve consecutive passes (eight on this branch, three
  on a pristine `origin/main` tree, three under concurrent load next to the
  provider-contract check). The failing payload was not captured, so the single
  failure stays an unreproducible transient with no root cause: it is not
  attributable to this diff, and no clean-run claim rests on it. The scratch
  worktree used for the comparison was removed afterwards.
- L12. CodeRabbit round on PR #3052: six inline findings, all Trivial, each
  adjudicated against the tree before touching anything. Valid: the pre-aborted
  test discarded `waitIfActive`'s outcome, so a regression returning `"released"`
  passed; `deadend` is not a word; the duplicate-open, unrelated-close and
  question-abort paths had no test; and the harness `release()` ran no-op
  closures instead of the bus unsubscribe (its `busHandlers` counter was read
  nowhere and reported 1 while the monitors held 2 bus listeners). Partly valid:
  the pre-abort difference is the deliberate choice recorded in L4, but that
  entry, and the reference sentence written from it, claimed the old mount
  behavior held *always* when the code keeps it only with no menu open. Invalid:
  MD037 needs an emphasis pair and line 59 has none - its lone `*` is the
  `ask_user*` glob - and the repository ships no markdownlint config, dependency,
  script or job. Fixed as tests plus prose only; the defer mechanism is untouched.
  L4 stays as written history and is superseded on that one point.
