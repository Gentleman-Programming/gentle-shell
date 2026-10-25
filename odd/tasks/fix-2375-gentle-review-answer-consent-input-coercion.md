# Task Breakdown: Fix #2375 Gentle Review Answer Consent Input Coercion

**Feature:** `fix-2375-gentle-review-answer-consent-input-coercion`  
**Issue:** #2375 (`bug(review): gentle_review answer-consent input is unreachable from direct tool calls (object never coerced to string) (4.3.0)`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit test for answer-consent object input coercion
- [x] In `tests/review-json-arguments.test.ts`:
  - Add test asserting that `validate("gentle_review", { operation: "answer-consent", input })` with object input `{ consentBinding: "bound-1", answer: "granted" }` is admitted and coerced into a serialized string by `parseReviewControllerParameters`.
  - Assert that execution reaches the consent registry without throwing `"Review controller input must be a string"`.
  - Evidence: Red test failure `Review controller input must be a string` observed before fix.

### 2. Implementation (GREEN): Coerce answer-consent object input
- [x] In `extensions/gentle-ai.ts`:
  - Include `value.operation === REVIEW_CONTROLLER_OPERATION.ANSWER_CONSENT` alongside `START` and `ASSESS` in `parseReviewControllerParameters`.
  - Update schema description in `REVIEW_CONTROLLER_PARAMETER_FIELDS.input` to `START/ASSESS/answer-consent`.
  - In `tests/review-json-arguments.test.ts`, exempt `answer-consent` from fail-closed string-only operation test.
  - Evidence: All 9 tests in `tests/review-json-arguments.test.ts` pass green.

### 3. Verification & Regressions
- [x] Run test suite: `node --experimental-strip-types --test tests/review-json-arguments.test.ts tests/review-controller.test.ts`.
- [x] Run typecheck: `npm run typecheck` (0 diagnostics, 0 regressions).
- [x] Evidence: 0 regressions, all tests passing.

### 4. Work-Unit Commit
- [x] Create conventional commit: `fix(review): coerce answer-consent object input to serialized string (#2375)`.
