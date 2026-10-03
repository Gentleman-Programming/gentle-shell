# Prompt lifecycle: remaining delivery paths after #1631

## Objective
Every model-visible message Gentle Agents hands to a parent session starts its turn through Pi's prompt lifecycle (`before_agent_start`), never through a direct `triggerTurn` run, in every host state. Held content always reaches the parent without waiting for an unrelated user prompt. Proven on the real Pi host, not only on the fake.

Scope after merging main 2fb7700a: cf3012f7 lets native providers continue through a hidden `triggerTurn` wake by design, so the prompt-lifecycle guarantee applies to the Claude Bridge selection; holds apply to every provider.

## Base
`origin/main` 2549f17a (includes #1631). Pi source read at earendil-works/pi 6f1072c; installed host 0.99.2.

## Host state map (from agent-session.ts)
State of `main` at 2549f17a, before this change. The last column says which task closes each gap.

| Host state | isIdle | isStreaming | #1631 route | Gap on main | Closed by |
| --- | --- | --- | --- | --- | --- |
| idle | true | false | idle: store + prompt wake | none | — |
| run active (incl. between inner `continue()` calls, in-run compaction) | false | true | run: steer | none | — |
| manual / pre-prompt threshold compaction, no run | false | false | hold, released by `session_compact(_failed)` | none | — |
| `/tree` branch summarization, no run | false | false | hold | never released by an event: `session_tree` not handled; cancelled summarization emits no event at all | T2 (`session_tree` flush + held-only re-check) |
| user prompt in its pre-run phase (input handlers, auth, model checks) | true | false | idle: wake sent | wake and user prompt both reach `Agent.prompt()`; loser throws and resets the winner's run flag | T3 (`input` start window) |
| incoming orchestrator session message (transport listener in `gentle-agents.ts`) | any | any | not routed: `sendMessage(followUp, triggerTurn)` | idle: direct run without `before_agent_start` (#1528 on another path); no run + compacting: direct run during compaction | T1 (listener routed through `deliverOrchestratorMessage`) |

## Tasks
- [x] T1: Real-host prompt-lifecycle harness + route incoming orchestrator messages through the delivery router (run keeps followUp). PR A. Commits: 295c7a54 (stale history-restore guard), 27d32193 (router + tests + real-host harness).
- [ ] T2: Hold liveness: release on `session_tree`; held-only bounded re-check covers cancelled summarization and any busy state without an end event. PR B.
- [ ] T3: Pre-run race: mark a starting prompt at `input` so no wake races a user prompt. PR B.
- [ ] T4: #1574 rebased on main; stale notice delivered through `sendToParent(route)`. PR #1574.
- [ ] T5: Issues, PR bodies, close #1595 with pointer to #1631, coordinate with #1518.

## Related
#1528 (closed by #1631), #1518 (receiver-side admission for session messages), #1517, #1092/#1574, pi#5581.

## Evidence
Clean baseline on main 2549f17a (fresh worktree, `env -i`, throwaway HOME): 4564 tests, 4529 pass, 34 skipped, 1 fail. The one failure is environmental: `packed tarball excludes retired workflow paths` parses `npm pack --json` as an array, and npm 12 returns an object keyed by package name (CI pins Node 24 / npm 11). With the real user HOME, 7 more tests fail from local ~/.pi config; never use the real HOME for baselines.

### T1 (base 2549f17a)
Real-host harness `tests/agents-prompt-lifecycle-runtime.test.ts` (real AgentSession, faux provider, probe `before_agent_start` marker). Red on base, green with the fix:
- idle orchestrator message: `provider request 0 must carry the before_agent_start system prompt marker`.
- compaction without a run: `no provider request is issued for the message while compaction runs` (3 !== 2).
- child completion to idle parent and message during an active run: green on base (regression guards: #1631 holds on the real host; the run route is unchanged).
Unit tests in `tests/gentle-agents.test.ts` red on base: idle (`the message is stored without triggerTurn`), compaction hold (`no direct turn starts while the parent compacts`, 1 !== 0), stale ctx (`Missing expected rejection.`), session change (`the old session's held message is not replayed into the new one`, 1 !== 0), busy-then-boundary hold (verified red by the parent). The idle test also asserts that the wake text does not call a session message subagent output; red with the old wake text. The run-route test is a guard and is green on base by design.
Side finding fixed in the same change: `restoreSessionHistory` read `ctx.sessionManager` outside its try, so a shutdown before the disk read landed raised an unhandled rejection (stale ctx). The real-host file failed on it; reverting only that guard reproduces the file-level failure.
Each commit passes on its own (295c7a54: gentle-agents 172/172). Real-host file stable over 5 consecutive runs.
Clean-HOME `pnpm test`: 4574 tests, 4539 pass, 34 skipped, 1 fail (the known `npm pack --json` npm 12 failure); +10 tests vs baseline 4564. `pnpm run typecheck`: no regressions.
Residual: a held orchestrator message is lost if the session is replaced before the boundary (sender already acknowledged), like pending child content. Receiver-side admission (#1518) is not implemented; the route decision is where it would plug in. T2 (release hold on `session_tree` / cancelled summarization) still applies to held orchestrator messages.

### Merge with main 2fb7700a
- cf3012f7 split the idle wake: Claude Bridge keeps a user wake through the prompt lifecycle; native providers get a hidden `gentle-agents.wake` custom-message turn. The real-host harness now registers the faux provider as `claude-bridge`.
- The bridge wake text is persisted per session (`gentle-agents.wake-identity`) and validated against `PARENT_WAKE_TEXT` on restore, so the wake text is no longer changed here and the idle test no longer asserts it.
- cf3012f7 also moved the `restoreSessionHistory` session check inside its try; main's version replaces this branch's guard.
