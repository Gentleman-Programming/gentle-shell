# Herdr aggregate busy while background subagents run (#626)

Locator: `odd/tasks/fix-626-herdr-busy.md`; branch `fix/626-herdr-busy`; issue
gentle-shell#626 (`status:approved`, `bug`, `type:bug`).

## Objective / why

A background `subagent_run` keeps the child active after the parent prompt
becomes available again, but Herdr drops the session to `idle` because its
managed Pi integration derives `working` only from the parent's
`agent_start`/`agent_settled`. Gentle Shell already projects human-input
blockers to the same bus (`herdr:blocked`); it has no projection for owned
background work.

Add one additive, edge-triggered `herdr:busy` `{ active, label }` emission on
Pi's extension event bus, raised while any task owned by the active session is
non-terminal, and lowered when the last one settles. The consumer owns
precedence (`blocked` over `busy`), so `herdr:blocked` is untouched.

## Scope / constraints

- **Protocol is not invented**: mirror `pi-subagents`
  (`src/integrations/herdr-status.ts:258-268`) exactly, because that producer is
  what the real consumer (`eysenfalk/pi-herdr-status`, a drop-in replacement for
  Herdr's bundled Pi integration) already counts. `herdr:busy` is absent from
  this repo today; `herdr:blocked` stays the only other channel.
- **Balanced, edge-triggered, privacy-safe**: raise once, lower once, dedup when
  the label is unchanged, and on a label change emit the lower **before** the
  raise in the same synchronous step (hernanharco's requirement). The label is a
  bounded, content-free string derived from counts only: no prompts, task text,
  agent names, ids, paths or output.
- **No env or pane gate** on the emission path: `herdr:blocked` has none
  (`gentle-ai.ts:1751-1765`), and the event is inert without a consumer. Do not
  touch `lib/herdr-activity.ts` or `extensions/gentle-herdr-activity.ts`
  (different mechanism: socket metadata).
- **Authority unchanged**: the `TaskStore` remains the only source of status. No
  polling, timers, process inspection or second state store.
- **Bounded surface**: prefer the smallest change that keeps the projection pure
  and unit-testable. If adding a new `lib/` module would force regeneration of
  the bundled `runtime/` modules (`scripts/build-runtime-modules.mjs --check`),
  put the helper where it does not, and record the choice in the evidence log.
- No commits, pushes or PRs without explicit user authorization.
- Out of scope: Herdr-side listener, `herdr:blocked` changes, TUI rendering, the
  `/reload` behaviour of other extensions.

## Seams (verified 2026-10-05, path:line)

- Authoritative store: `extensions/gentle-agents.ts:410` (`new TaskStore()`),
  handed to the runner at `:977`. Store queries filter by session via
  `TaskStore.list(parentSessionId)` (`lib/agents-protocol.ts:486-490`).
- Event bus form used by this extension: `pi.events.emit(CHANNEL, payload)`
  (`gentle-agents.ts:1046`, `:1063`).
- Non-terminal transitions (scattered, no single hook): QUEUED at
  `lib/agents-runner.ts:358`; RUNNING at `:476`, `:510`, `:528`, `:553` and
  `:848`; RUNNING resume and WAITING in `lib/agents-protocol.ts:423`, `:437`.
- Terminal transitions funnel through one function: `AgentRunner.finish()`
  (`lib/agents-runner.ts:997`), write at `:1003`. Callers: `cancel():435`,
  launch failures `:477/:511/:529`, quarantine `:914/:939`, `childError():967`,
  `completeExit():994`.
- Existing observation points in the extension: `onFinish` hook
  (`gentle-agents.ts:1052`) and `store.subscribeSummary(...)` (`:1296`).
- Lifecycle handlers to reuse: `pi.on("session_start", ...)` at `:402`, `:507`,
  `:1957`; `session_shutdown` at `:508`, `:2008`.
- Reference to mirror for the edge helper: `herdr:blocked`'s
  `emitEffectiveBlocker` (`gentle-ai.ts:1751-1765`), edge guard at `:1761`.

## Tasks / acceptance

- [ ] **T1 — Pure projector.** New pure helper that takes the owned task
      projections and the previously emitted state and returns the next action:
      `raise(label)`, `relabel(label)` implemented as lower-then-raise,
      `lower()`, or no-op. Label is count-based and bounded. Impossible states
      (lower when not raised, raise when already raised with the same label) are
      no-ops. Fails closed on malformed input without throwing.
- [ ] **T2 — Wiring.** `extensions/gentle-agents.ts` calls the projector on the
      observed transitions only: task created/launched, terminal settlement,
      `session_start` (re-raise for `/reload` and `/resume`), and
      `session_shutdown` (lower). Scoped to the active session's owned tasks. No
      polling and no timers.
- [ ] **T3 — Tests (RED first).** Focused coverage: parent idle with child
      active keeps busy; two background tasks keep busy until the last settles;
      label change emits lower before raise; unchanged label emits nothing;
      `session_start` restores busy; cancellation, failure, timeout and
      shutdown each lower it; no stale busy after the last settlement.
- [ ] **T4 — Checks.** Focused test file green, agents-related test files green,
      `pnpm typecheck` unchanged, `node scripts/build-runtime-modules.mjs --check`
      consistent.
- [ ] **T5 — PR readiness.** Work-unit commit(s) and PR body with `Closes #626`
      plus the AI-assistance disclosure, then ping `@hernanharco` for review.
      Blocked on explicit user authorization for commit, push and PR.

Issue acceptance-criteria mapping for the PR body: parent-idle/child-active ->
T2+T3; multiple tasks until the last settles -> T1+T3; no stale `working` after
completion/failure/cancellation/timeout/shutdown -> T2+T3; deterministic
precedence -> consumer-owned, documented (blocked untouched); status from the
authoritative agent lifecycle, not polling -> T2; focused regression test ->
T3.

## Verification

- Focused runner: `node --experimental-strip-types --test tests/<file>.test.ts`.
- Existing patterns to follow: `tests/gentle-agents.test.ts` (extension under
  test), event capture in `tests/runtime-harness.mjs:65-70`, and `herdr:blocked`
  assertions in `tests/child-safety.test.ts:80` and
  `tests/gentle-ai.test.ts:1414`.
- Independent verification of the final candidate by a separate verifier
  subagent; native review follows because the RDD switch is on.

## Evidence log

- 2026-10-05: claim coordinated on the issue; `hernanharco` yielded
  (`go ahead, this one is yours`) and asked for lower-before-raise plus a
  `/reload` test. Acceptance comment posted.
