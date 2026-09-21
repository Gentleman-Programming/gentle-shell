# Feature: Bounded Retry for Transient Reviewer Relay Failures (#1307)

## Problem
In `lib/inprocess-reviewer.ts`, reviewer completions routed through the in-process host relay fail deterministically whenever a gateway produces a transient streaming error, such as the NaN DeepSeek SSE JSON parse failure:
`Expected property name or '}' in JSON at position 1 (line 1 column 2)`.
Currently, `runInProcessReviewer` has zero retry logic: a single transient stream parsing or transport error immediately terminates the review after ~60s and blocks the RDD review capture.

## Solution
1. In `lib/inprocess-reviewer.ts`:
   - Introduce bounded retry mechanism (`MAX_REVIEWER_COMPLETION_ATTEMPTS = 2`) for transient transport/streaming errors.
   - Define `isTransientReviewerError(errorMessage: string)` detecting SSE JSON parse corruptions, socket resets/timeouts, and 502/503/504 gateway glitches.
   - Add optional `sleep` to `InProcessReviewerDeps` with default exponential/constant backoff and `combinedSignal` abort awareness.
   - If an attempt fails with a transient error and attempts remain, wait backoff and retry.
   - Non-transient errors (auth, schema, tool calls, user aborts, timeouts) fail immediately without retry.
2. In `tests/inprocess-reviewer.test.ts`:
   - Test that transient JSON parse error retries and succeeds on the second attempt.
   - Test that transient `stopReason: "error"` retries and succeeds on the second attempt.
   - Test that exhausting retry attempts returns the clean refusal.
   - Test that non-transient errors fail immediately without retry.

## Tasks
- [x] Task 1: Create ODD feature tracking document
- [x] Task 2: Add unit tests for transient error retries in tests/inprocess-reviewer.test.ts
- [x] Task 3: Implement transient retry logic in lib/inprocess-reviewer.ts
- [x] Task 4: Verify all tests pass
- [x] Task 5: Create work-unit commit (`5fb5018d`)
