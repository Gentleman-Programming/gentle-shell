# Task Breakdown: Fix #2384 Parent Wake Text Delivery Kind

**Feature:** `fix-2384-parent-wake-text-delivery-kind`  
**Issue:** #2384 (`bug(agents): the parent wake always says "subagent output", also for background jobs and monitors`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit tests for dynamic delivery-kind wake text
- [x] Add tests in `tests/gentle-agents.test.ts`:
  - Verify that a `bash_background` exit notice wakes the parent with `"Review the background job's exit notice and continue."`
  - Verify that a `monitor` events notice wakes the parent with `"Review the delivered monitor events and continue."`
  - Verify that `nativeParentWakeText` maps single and mixed delivery kinds distinctly.
  - Verify that mixed deliveries held during compaction resolve to `"Review the delivered output and continue."` upon boundary flush.
  - Evidence: Red test failure observed on all 3 integration tests before fix.

### 2. Implementation (GREEN): Dynamic delivery-kind wake text resolution
- [x] In `extensions/gentle-agents.ts`:
  - Define `WakeDeliveryKind` (`"subagent" | "job" | "monitor"`).
  - Define `WAKE_TEXT_SUBAGENT`, `WAKE_TEXT_JOB`, `WAKE_TEXT_MONITOR`, `WAKE_TEXT_OUTPUT`.
  - Implement and export `nativeParentWakeText(kinds: ReadonlySet<WakeDeliveryKind>): string`.
  - Track `pendingWakeKinds` in `gentleAgents` across `sendToParent` calls.
  - Route delivery kinds through `flushJobNotices` (`"job" | "monitor"`) and `deliver` / `deliverStale` / `deliverMessage` (`"subagent"`).
  - Pass resolved wake text into `PARENT_WAKE_TYPE` message content on wake dispatch.
  - Re-accumulate `kinds` into `pendingWakeKinds` if wake dispatch throws.
  - Evidence: All 4 tests green, 33/33 wake tests green.

### 3. Verification & Regressions
- [x] Run targeted test suite: `node --experimental-strip-types --test --test-name-pattern="wake" tests/gentle-agents.test.ts`.
- [x] Run typecheck: `npm run typecheck` (0 diagnostics, 0 regressions).
- [x] Evidence: 0 regressions, all tests passing.

### 4. Work-Unit Commit
- [x] Create conventional commit: `fix(agents): tailor parent wake text to delivered kind (#2384)`.
