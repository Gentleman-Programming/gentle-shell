# Task Breakdown: Fix #1692 ask_user_choice Custom Response Transcript Rendering

**Feature:** `fix-1692-ask-user-choice-custom-response-transcript`  
**Issue:** #1692 (`bug(ask): ask_user_choice transcript hides the custom response text the user typed`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit tests for ask_user_choice renderResult with custom response text
- [ ] Add unit tests in `tests/ask-user-choice.test.ts`:
  - Verify that `renderResult` renders selection as `✓ <index>. <label>`.
  - Verify that `renderResult` renders custom response with the typed text: `✓ Custom response — <text>`.
  - Verify that `renderResult` renders cancelled state as `Cancelled`.
  - Evidence: Red test failure before implementation.

### 2. Implementation (GREEN): Render custom response text in ask_user_choice renderResult
- [ ] In `extensions/ask-user-choice.ts`:
  - Update `renderResult` to format `details?.customResponse !== undefined` with the submitted text:
    `✓ Custom response — ${details.customResponse}` (or `✓ Custom response` if empty/whitespace).
  - Evidence: Green test pass.

### 3. Verification & Regressions
- [ ] Run targeted test suite: `node --test tests/ask-user-choice.test.ts`.
- [ ] Run full test suite and typecheck (`pnpm typecheck`, `pnpm test`).
- [ ] Evidence: 0 regressions, all tests green.

### 4. Work-Unit Commit
- [ ] Create conventional commit: `fix(ask): include custom response text in ask_user_choice transcript (#1692)`.
