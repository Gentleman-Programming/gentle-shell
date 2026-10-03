# PR #1384 Populated-Apply Confirmation

## Objective

Close the maintainer-flagged gap on PR #1384: applying a *populated* profile
globally still replaces every materialized route without confirmation
(`Ctrl+S` → `enter` sequence from #1349). Global applies now always confirm,
naming what changes before anything is written.

## Decisions (operator, 2026-09-30)

- Behavior: confirm **every** global profile apply. Populated profiles get a
  dialog naming replaced routes, cleared agents, and added agents. The
  empty / orchestrator-only dialogs from commit `efc7b52a` stay specialized.
- Repo-pinned applies stay silent (repo-scoped, no global state touched).
- Delivery: local only. No push, no PR comment unless the operator later
  authorizes it.

## Scope

- `extensions/gentle-ai.ts`: extend the `case "apply"` guard — read the
  current global routing via `readModelRoutingAuthorityAsync` before the
  prompt, compute a diff (replaced / cleared / added agent routes), prompt on
  every global apply, abort on decline before any write or live switch.
- `tests/gentle-ai.test.ts`: flip the "nonempty global apply never asks for
  confirmation" assertion; add populated-apply regressions (decline preserves
  all four surfaces byte-identically; confirm applies and reports).

## Out of scope

- #1557 key rebinding (`a`) reconciliation — follow-up when that branch lands.
- Snapshot/undo of successful applies (jonathanludena's general case).
- `odd/tasks/pr-1384-review-fixes.md` cleanup — operator decision at delivery.

## Tasks

- [x] T1 — RED: populated-apply regression (prompt shown, decline preserves
  models.json/subagents.json/store/settings byte-identically and no live
  switch). Observed: `confirmCalls.length 0 !== 1` on both new tests and on
  the flipped orchestrator-persistence assertion.
- [x] T2 — Implement the universal confirmation with route diff.
- [x] T3 — GREEN: focused profile tests (37 pass), full
  `tests/gentle-ai.test.ts` (96 pass), typecheck (187 diagnostics, baseline
  unchanged), `git diff --check` clean.
- [ ] T4 — Work-unit commit (local only) and delivery report.

## CodeRabbit closure round (2026-10-02, both Major threads)

- Finding 1 (materialized-only routes): the populated dialog now diffs against
  the effective current routing — saved global routing merged with materialized
  routes via the new `readGlobalEffectiveModelConfigFromAsync` helper (reuses
  `listDiscoverableAgentsAsync` / `readMaterializedRoutingEntryAsync`, same as
  `readEffectiveModelConfigAsync`, which now delegates to it). `models.json`
  alone hid routes the approval actually clears. Unreadable-authority
  disclosure branch unchanged and still authoritative.
- Finding 2 (orchestrator effects): when a populated profile has an
  `orchestrator` entry, both the readable and unreadable populated messages
  append "set the configured orchestrator entry in settings.json, and attempt
  to switch this session to that orchestrator model" (same wording as the
  orchestrator-only dialog; never an unconditional switch promise). No
  orchestrator entry → messages unchanged.
- T7 — RED observed: 4 new tests fail — dialog claimed "its agent routes
  already match the current global routing" while approval would clear
  helper's materialized route (2 tests); readable and unreadable populated
  messages lacked the settings.json / live-switch disclosure (2 tests).
- T8 — GREEN: focused profile tests 43 pass, full `tests/gentle-ai.test.ts`
  102 pass, typecheck 187 diagnostics (baseline unchanged), `git diff --check`
  clean. Confirm-path regression added (materialized-only route cleared on
  approval); existing message assertions untouched.

## QA R4 closure (2026-09-30)

- Finding: with an invalid routing authority the apply guard fell back to
  `currentRouting = {}`, so the populated dialog labeled every profile route
  `(added)` and never disclosed the replace/clear-to-inherit effect.
- Fix: when `readModelRoutingAuthorityAsync` is not `valid` at prompt time, the
  populated dialog uses an alternative message disclosing the unreadable
  current routing and that applying replaces global routing so every existing
  agent route may be replaced or cleared back to inherit. Guard structure,
  decline semantics, empty/orchestrator-only dialogs, and repo-pinned silence
  unchanged.
- T5 — RED observed: `AssertionError ... the dialog must disclose that the
  current global routing is unreadable` with actual message ending
  `worker: openai/alpha (added). Continue?` on both new tests.
- T6 — GREEN: focused profile tests 39 pass, full `tests/gentle-ai.test.ts`
  98 pass, typecheck 187 diagnostics (baseline), `git diff --check` clean.

## Constraints

- Strict TDD: observe RED before changing production code.
- Technical artifacts in English; dialog copy stays consistent with the
  existing `efc7b52a` style.
- Allowed edit surfaces: `extensions/gentle-ai.ts`, `tests/gentle-ai.test.ts`
  (plus this task doc).
