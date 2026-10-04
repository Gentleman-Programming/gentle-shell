# Task Breakdown: Fix #1741 Subagent Tasks Durable Launch State & Interruption Reconciliation

**Feature:** `fix-1741-subagent-tasks-durable-launch-state`  
**Issue:** #1741 (`bug(agents): abrupt parent death loses running subagent tasks with no durable trace`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Write unit tests for launch persistence and abrupt-death reconciliation
- [ ] Add tests in `tests/gentle-agents.test.ts`:
  - Verify that a launched task is durably written to disk (`tasksDir`) upon launch before any completion event.
  - Verify that if the parent dies abruptly (no `session_shutdown` or `runner.cancelAll`), a subsequent session or `resolveTask` / `subagent_status` recovers the task in a terminal `failed` state with error `"interrupted: parent process terminated while task was in flight"`.
  - Verify that `subagent_list_tasks` in a resumed session shows the interrupted task.
  - Evidence: Red test failure before implementation.

### 2. Implementation (GREEN): Persist on launch and reconcile interrupted stored tasks
- [ ] In `extensions/gentle-agents.ts`:
  - Add `persistLaunch(task)` to persist the task to disk asynchronously upon launch (and update upon child process spawn).
  - Add `reconcileStored(stored: StoredTask)` to reconcile un-terminalized tasks (`!isFinished(stored.task.status)`) into `TASK_STATUS.FAILED` with error `"interrupted: parent process terminated while task was in flight"`, `lastStep: "interrupted"`, and `endedAt`. Persist the reconciled state to disk.
  - Wire `reconcileStored` into `resolveTask(id)` and `restoreSessionHistory(ctx, sessionId)`.
  - Evidence: Green test pass.

### 3. Verification & Regressions
- [ ] Run targeted test suite: `node --test tests/gentle-agents.test.ts`.
- [ ] Run full test suite and typecheck (`pnpm typecheck`, `pnpm test`).
- [ ] Evidence: 0 regressions, all tests green.

### 4. Work-Unit Commit
- [ ] Create conventional commit: `fix(agents): persist durable launch state and reconcile interrupted subagent tasks (#1741)`.
