# Prompt lifecycle: remaining delivery paths after #1631

## Objective
For the Claude Bridge selection, every model-visible message Gentle Agents hands to a parent session starts its turn through Pi's prompt lifecycle (`before_agent_start`), never through a direct `triggerTurn` run, in every host state. Held content reaches the parent without waiting for an unrelated user prompt, unless the session changes first (see the T1 residual below). Proven on the real Pi host, not only on the fake.

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
- [x] T1: Real-host prompt-lifecycle harness + route incoming orchestrator messages through the delivery router (run keeps followUp). PR A. Commit: 40804023 (router, real-host harness and the stale history-restore guard).
- [x] T2: Hold liveness: release on `session_tree`; held-only bounded re-check (HOLD_RECHECK_MS) covers cancelled summarization and any busy state without an end event. PR B. Commit: 4c9314ed (with T3).
- [x] T3: Pre-run race: mark a starting prompt at `input` (INPUT_PROMPT_GRACE_MS) so no wake races a user prompt while that start window is open; a pre-run phase longer than the window re-opens it (see the T2 / T3 residual). Reproduced on the real host. PR B. Commit: 4c9314ed (with T2).
- [x] T4: #1574 rebased on main; stale notice delivered through `sendToParent(route)`. PR #1574. Commit: 9fe8b2e8 (the #1574 head).
- [x] T5: Issue #1638; PR A #1639 (review-bd684f463bca000e), PR B #1640 stacked (review-d08854df6e5f6ebc); #1574 rebased onto main as one commit (review-b2f434e0d31ab90e); #1595 closed with pointer to #1631; #1518 referenced in #1639 body and code comment.

## Related
#1528 (closed by #1631), #1518 (receiver-side admission for session messages), #1517, #1092/#1574, pi#5581.

## Evidence
The commit hashes below are from the original branch history, before each PR was rebased onto main and squashed to one commit (#1639 40804023, #1640 4c9314ed).

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

### T2 / T3 (base 67f0ea89)
Red on base (real host, `tests/agents-prompt-lifecycle-runtime.test.ts`):
- T2 completed `/tree` summarization and cancelled (`abortBranchSummary`) summarization: `timed out waiting for the delivered turn` (content stays held).
- T3 reproduced: a user prompt parked in a probe `input` handler plus a child completion makes the wake and the prompt race; the user's `session.prompt()` rejects with `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.` (assertion `no caller sees a concurrent-prompt error`). With the change: one run, no error, marked requests, completion carried by the user's run.
Unit tests (`tests/gentle-agents.test.ts`) red on base: session_tree release, re-check release, child content re-check, boundary cancels re-check, session change cancels re-check (all `0 !== 1`), starting-prompt no wake (`0 !== 1`), expired input grace (`1 !== 0`). Guards green on base by design: nothing-held never arms; input with streamingBehavior or during a run changes nothing.
Real-host file 7/7, stable over 5 consecutive runs. Residual: pre-run phase longer than INPUT_PROMPT_GRACE_MS re-opens the old window; a re-check polls once per second only while content is held for a busy-without-run parent.
Parent review found a regression in the first T3 draft: a dispatched wake reaches `input` itself, and the handler replaced the wake's PARENT_WAKE_GRACE_MS start window with INPUT_PROMPT_GRACE_MS, so content arriving while that wake was still starting sent a second, racing wake. Fixed (an open start window is never shortened) with the unit test `the dispatched wake's own input does not shorten its start window`, red on the draft (`no second wake while the first is still starting`). Commits split and each verified: T2 alone 190/190; T3 tests red on the T2 commit (3 fail), green with T3 (195/195).
Clean-HOME `pnpm test` with T3: 4587 tests, 4551 pass, 34 skipped, 2 fail: the known npm 12 `npm pack --json` failure and `SDK loads both extensions on one bus and drives real customize view (shell first: false)` (tests/yolo-mode-runtime.test.ts). That test loads only gentle-ai and gentle-shell, neither imports gentle-agents, and it is load-sensitive: 0/15 sequential runs fail on main 2549f17a and 0/15 with this branch, while it failed under concurrent load on both. Not caused by this change.

### T4 (base 2549f17a)
The textual rebase of #1574 applied cleanly but kept `sendMessage(notice, { steer, triggerTurn: true })`, which re-introduces #1528 for stale notices on an idle parent. Red on the plain rebase: idle parent (notice sent with triggerTurn:true instead of stored), hold then boundary (same), stale + fresh in one idle flush (same); run-route guard green. Green: gentle-agents 178/178. Clean env: only the npm 12 failure and two `review-host-relay-routing` failures that reproduce identically on a clean main checkout.

### Merge with main 2fb7700a
- cf3012f7 split the idle wake: Claude Bridge keeps a user wake through the prompt lifecycle; native providers get a hidden `gentle-agents.wake` custom-message turn. The real-host harness now registers the faux provider as `claude-bridge`.
- The bridge wake text is persisted per session (`gentle-agents.wake-identity`) and validated against `PARENT_WAKE_TEXT` on restore, so the wake text is no longer changed here and the idle test no longer asserts it.
- cf3012f7 also moved the `restoreSessionHistory` session check inside its try; main's version replaces this branch's guard.

### Merge with main ed536d4f (#1833)
- #1833 re-queues a completion whose forward throws and gives an idle parent a bounded retry; child messages and held session messages stay at most once, as on main.
- The held-only re-check reads `completionsMaybePending`, which the flush clears before forwarding. A re-queued completion now sets it again, so a later hold still arms the re-check. Test: `a completion re-queued after a failed forward still arms the held-only re-check` (red without the line: no re-check armed).
