# Task Breakdown: Fix #2376 Candidate Owner Preparation Errno Diagnostic

**Feature:** `fix-2376-candidate-owner-preparation-errno-diagnostic`  
**Issue:** #2376 (`gentle_review START: candidate-owner-preparation-failed drops the errno, leaving the failure undiagnosable`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit test for candidate owner preparation errno diagnostic
- [x] In `tests/gentle-ai.test.ts`:
  - Update `ordinary START reports candidate-owner preparation failure as pre-native no mutation` to throw `new CandidateViewError("candidate view owner preparation failed (EACCES)", "candidate-owner-preparation-failed")`.
  - Assert that `result.diagnostics` preserves `message: "candidate view owner preparation failed (EACCES)"`.
  - Evidence: Red test failure `message: 'candidate view rejected before native START'` observed before fix.

### 2. Implementation (GREEN): Preserve CandidateViewError message
- [x] In `extensions/gentle-ai.ts`:
  - In `nativeOperationFailure`, update the pre-native `CandidateViewError` fallback from `"candidate view rejected before native START"` to `error.message`.
  - Evidence: 123/123 tests passing in `tests/gentle-ai.test.ts`.

### 3. Verification & Regressions
- [x] Run test suite: `node --experimental-strip-types --test tests/gentle-ai.test.ts`.
- [x] Run typecheck: `npm run typecheck` (0 diagnostics, 0 regressions).
- [x] Evidence: 0 regressions, all tests passing.

### 4. Work-Unit Commit
- [x] Create conventional commit: `fix(review): preserve candidate-owner preparation errno in diagnostic message (#2376)`.
