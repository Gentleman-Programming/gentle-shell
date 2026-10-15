# Task Breakdown: Fix #1740 Subagent Settlement Orderly Shutdown

**Feature:** `fix-1740-subagent-settlement-orderly-shutdown`  
**Issue:** #1740 (`bug(agents): settlement can interrupt asynchronous session shutdown`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit tests for orderly shutdown and escalated cleanup
- [ ] Add tests in `tests/agents-runner.test.ts`:
  - Verify that upon `agent_settled`, `AgentRunner` requests orderly shutdown by ending `stdin` and does NOT send `SIGTERM` or `SIGKILL` immediately.
  - Verify that when the child process exits cleanly upon `stdin.end()`, completion settles with code 0 without receiving kill signals.
  - Verify that task completion and cleanup in flight are distinguishable (`lastStep: "cleaning up"`).
  - Verify that if the child fails to exit within `cleanupTimeoutMs`, `AgentRunner` escalates to `SIGTERM` and then `SIGKILL`.
  - Evidence: Red test failure before implementation.

### 2. Implementation (GREEN): Orderly shutdown on settlement
- [ ] In `lib/agents-runner.ts`:
  - Add `cleanupTimeoutMs` to `RunnerLimits` (default 5,000 ms).
  - Implement `settleOrderly(id, status, error)`: ends `child.stdin`, updates `lastStep: "cleaning up"`, and schedules bounded escalation timer for `cleanupTimeoutMs`.
  - Wire `TASK_EVENT.AGENT_SETTLED` to `settleOrderly` instead of immediate signal `requestStop`.
  - In `tests/agents-fake-child.ts`, wire `stdin.on("finish")` to emit clean exit `(0, null)` when `exitOnKill !== false && exitOnEnd !== false`.
  - Evidence: Green test pass.

### 3. Verification & Regressions
- [ ] Run targeted test suite: `node --test tests/agents-runner.test.ts`.
- [ ] Run full test suite and typecheck (`pnpm typecheck`, `pnpm test`).
- [ ] Evidence: 0 regressions, all tests green.

### 4. Work-Unit Commit
- [ ] Create conventional commit: `fix(agents): request orderly shutdown on settlement before escalating termination (#1740)`.
