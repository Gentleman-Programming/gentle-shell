# Task Breakdown: Fix #1740 Subagent Settlement Orderly Shutdown

**Feature:** `fix-1740-subagent-settlement-orderly-shutdown`  
**Issue:** #1740 (`bug(agents): settlement can interrupt asynchronous session shutdown`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit tests for orderly shutdown and escalated cleanup
- [x] Add tests in `tests/agents-runner.test.ts`:
  - Verify that upon `agent_settled`, `AgentRunner` requests orderly shutdown by ending `stdin` and does NOT send `SIGTERM` or `SIGKILL` immediately.
  - Verify that when the child process exits cleanly upon `stdin.end()`, completion settles with code 0 without receiving kill signals.
  - Verify that task completion and cleanup in flight are distinguishable (`lastStep: "cleaning up"`).
  - Verify that if the child fails to exit within `cleanupTimeoutMs`, `AgentRunner` escalates to `SIGTERM` and then `SIGKILL`.
  - Verify that confirmation deadline retains its full window after SIGKILL.
  - Evidence: Red test failure before implementation.

### 2. Implementation (GREEN): Orderly shutdown on settlement
- [x] In `lib/agents-runner.ts`:
  - Add `cleanupTimeoutMs` to `RunnerLimits` (default 5,000 ms).
  - Implement `settleOrderly(id, status, error)`: ends `child.stdin`, updates `lastStep: "cleaning up"`, and schedules bounded escalation timer for `cleanupTimeoutMs`.
  - Wire `TASK_EVENT.AGENT_SETTLED` to `settleOrderly` instead of immediate signal `requestStop`.
  - Set `cleanupDeadlineAt` immediately prior to `SIGKILL` so confirmation window is not exhausted by the cleanup timeout.
  - In `tests/agents-fake-child.ts`, override `stdin.end()` and queue a clean exit `(0, null)` in a microtask. `exitOnStdinEnd` controls EOF independently of `exitOnKill`; when omitted it falls back to `exitOnKill` for compatibility with existing fixtures.
  - Evidence: Green test pass.

### 3. Verification & Regressions
- Historical PR author report: targeted tests, full suite and typecheck passed; this is not a fresh verification claim.
- The October 20 review reported 102/103 runner tests passing on Windows, with the same `TEMP`/`TMP` environment assertion failure on the merge base, and zero typecheck diagnostics. These are reviewer-reported results, not a reproduction by this follow-up.
- Current local evidence is recorded below; failed or unavailable checks must not be interpreted as green.

### 4. Work-Unit Commit
- [x] Original implementation exists in PR #1775 (follow-up starts from `70bff6d4b1c34144bb83b14361fdb35dbcbb6b52`).

## Follow-up verification (Windows, Node 24.14.0, Pi 1.2.0)

- User authorized completing the existing PR's test and documentation gaps; no duplicate fix or publication.
- RED: `node --experimental-strip-types --test --test-name-pattern='allows delayed cleanup' tests/agents-runner.test.ts` exited 1: the original fake completed immediately instead of remaining `running` during delayed cleanup.
- GREEN: the delayed-cleanup test and full-confirmation-deadline test passed (2/2). EOF behavior is independently configurable; delayed cleanup advances 2,000 ms, checks `running` / `cleaning up` with no signals, then verifies completion, one finish notification and cancelled escalation after advancing beyond the original deadline.
- The deadline test now advances the harness clock by 5,000 ms and 250 ms instead of merely invoking timer callbacks.
- Real Pi RPC smoke attempted without model calls, using isolated configuration and a 2-second `session_shutdown` hook. FAILED before receiving the `get_state` response; asynchronous hook completion was therefore not verified. No claim of full runner/Pi integration or Engram persistence verification.
- Full runner file: 103/104 tests passed; exit 1 on `retains permission broker fd3 and assigns messaging IPC to fd4` because actual child environment includes Windows `TEMP`/`TMP` beyond the expected object. This matches the earlier review's reported failure, but no fresh baseline comparison was run here.
- `git diff --check`: passed.
- Native assessment: medium, `reviewDue: false` (`under_budget`); self-verification required, no independent verifier or native review requested.
- Typecheck completed: `types: 0 recorded diagnostic(s), no regressions`.
- Full suite explicitly stopped on user authorization after more than 16 minutes. The log contains 251 lines beginning `✖`; no final suite summary or exit result was produced. Unit stage did not finish; provider-contract and runtime-harness stages were not reached. These failures are not established as pre-existing or environmental without baseline evidence.
- Read-only blocker diagnosis: the incomplete log does contain concrete diagnostics, despite lacking the final failure-detail summary. Lines 4061–4088 show seven asynchronous `assert.ok(flags & constants.O_NOFOLLOW)` failures, matching the audio fixtures in `tests/notification-audio.test.ts:101,496`. Lines 1552–1571 show a native Node `execution_async_id` assertion and stack associated with failed `tests/gentle-ai-doctor-herdr.test.ts`. These observations do not establish all 251 failures' causes or baseline status.
- Smoke static checks: local Pi 1.2.0 declares `dist/bundle/cli.js` and that entry exists; `--no-extensions` still permits explicit `-e`. Missing entry and suppression of explicit extensions are not supported explanations. Early-exit cause remains unknown because stdout/stderr were not retained.
- No full-suite rerun, smoke retry, or unrelated source fix was performed during this diagnosis.
- User subsequently authorized exactly one instrumented smoke. It exited 1 after 593 ms, signal `null`, no timeout, stdout empty, and no RPC response. Captured stderr identifies an extension fixture parse error: `Failed to load extension ... shutdown.mjs ... ParseError ... Unterminated string constant`, at generated fixture line 1, column 91. This diagnostic attempt failed while loading the generated smoke fixture, before exercising EOF or the shutdown hook; it is not evidence of a runner shutdown regression. The precise fixture/transport escaping mechanism was not inspected before cleanup. The isolated directory was removed. No second attempt was run.
- Correction to the earlier unknown-cause status: the instrumented attempt now has an identified pre-RPC fixture-loading failure; the original uninstrumented attempt cannot independently be assigned that cause.
- At that boundary, successful real RPC async-cleanup evidence was missing; user subsequently authorized correcting the fixture and one additional smoke.
- Corrected fixture uses separate source lines and `console.error` markers instead of embedded escaped string newlines. `node --check` passed (exit 0). The single authorized smoke selected `--provider openai --model gpt-4o` explicitly to avoid relying on model autodetection, sent only `get_state`, received a successful RPC response, and closed stdin. No prompt/model call was made (`messageCount: 0`).
- Real Pi 1.2.0 RPC smoke PASSED: exit 0, signal `null`, no timeout, total 2,434 ms, 2,026 ms from EOF to process close. Captured stderr was exactly `CLEANUP_START\nCLEANUP_DONE\n`, proving the asynchronous 2-second `session_shutdown` hook completed before exit. stdout contained the successful `get_state` response. Isolated directory removed; no suite rerun.
- Scope limit: this proves real RPC EOF shutdown awaits the extension hook, not complete `AgentRunner` + Pi end-to-end settlement or Engram persistence. Full runner/Pi integration and a fresh baseline comparison for unrelated suite failures remain unverified; full suite remains incomplete.
- No new commit or push.

## Bounded Windows environment assertion follow-up

Coverage of the four authorized steps:

1. **Original PR head comparison:** archived original HEAD `70bff6d4b1c34144bb83b14361fdb35dbcbb6b52` (not the merge base) with `git archive HEAD lib extensions tests scripts package.json tsconfig.json | tar -xf - -C .verification-pr1775/baseline-70bff6d4`. The exact directory was absent before creation. From that directory, `node --experimental-strip-types --test --test-name-pattern='^AgentRunner retains permission broker fd3 and assigns messaging IPC to fd4$' tests/agents-runner.test.ts` exited 1 (0/1): full environment equality rejected extra Windows `TMP` and `TEMP`, both equal to `TMPDIR`. The same command against the current working tree before the fix exited 1 with the same assertion. This freshly establishes that this specific failure exists at the original PR head; it does not establish baseline status for unrelated suite failures. Captured stdout/stderr: `.verification-pr1775/baseline-red.log` and `.verification-pr1775/current-red.log`.
2. **Expectation-only correction:** expected environment now includes `TMP` and `TEMP` only on Windows, using the same expected scratch value as `TMPDIR`. Full environment equality, scratch-name validation, fd3 transport and fd4 IPC assertions remain intact. The exact focused command above then exited 0 (1/1); output: `.verification-pr1775/focused-green.log`. No production changes or history-dependent committed tests.
3. **Focused regression validation:** `node --experimental-strip-types --test tests/agents-runner.test.ts` exited 0: 104/104 passed, zero failures/skips/cancellations (output: `.verification-pr1775/full-runner.log`). This includes delayed cleanup, escalation/deadline cases and the existing Windows/Linux launch contract matrix. `pnpm typecheck` exited 0: `types: 0 recorded diagnostic(s), no regressions` (output: `.verification-pr1775/typecheck.log`). Earlier 103/104 runner results above are historical and superseded by this bounded runner validation, not by a full-suite pass.
4. **Review boundary:** preserve pre-existing delayed-cleanup/fake-child/deadline changes and historical evidence. The only new test edit is the expected scratch environment. Final diff whitespace validation and review are recorded in the handoff; no commit, push or PR update performed.

Scratch inventory: `.verification-pr1775/baseline-70bff6d4/` contains only archived tracked `lib/`, `extensions/`, `tests/`, `scripts/`, `package.json`, and `tsconfig.json`; no node_modules junction/symlink was needed or created. The worker retained the five logs outside that directory and deleted nothing. Parent subsequently read all five logs, reviewed the test diff, and removed only this exact baseline directory and these five logs after checking the scratch inventory; the empty scratch root was also removed. The paths above describe temporary capture locations, not retained repository artifacts. `git diff --check` passed; only the same three intended tracked files remain modified.

Risk: the full suite remains incomplete, with audio/Node diagnostics separate and unbaselined. No further smoke was run; the earlier successful real Pi RPC EOF/2-second hook smoke does not prove complete AgentRunner + Pi integration or Engram persistence.
