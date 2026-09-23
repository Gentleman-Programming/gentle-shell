# Feature: Bounded Retry for Transient Reviewer Relay Failures (#1307)

## Problem
In `lib/inprocess-reviewer.ts`, reviewer completions routed through the in-process host relay currently have zero retry logic: a single transient network drop or gateway glitch terminates the review and blocks native review capture.

Originally, issue #1307 reported an SSE JSON parse failure on `nan/deepseek-v4-flash`:
`Expected property name or '}' in JSON at position 1 (line 1 column 2)`.
Community investigations (by `microonline` and `matraket`) revealed that this specific error is deterministic: when a model hits NaN's ~60k character streaming reasoning ceiling without producing answer content, the gateway emits a Python dict `repr` (`{'id': ..., 'billed': False}`) instead of valid JSON. Retrying that deterministic truncation with an identical review prompt burns an extra 60–90 seconds of reasoning without chance of success.

## Solution
1. In `lib/inprocess-reviewer.ts`:
   - Introduce bounded retry mechanism (`MAX_REVIEWER_COMPLETION_ATTEMPTS = 2`) strictly for genuine transient transport/network failures (`ECONNRESET`, `ETIMEDOUT`, socket hang up, HTTP 502/503/504/429).
   - Deliberately exclude deterministic JSON parse and truncation errors from retry: they fail immediately on attempt 1 with `PROVIDER_FAILED` to avoid wasting reasoning time and tokens.
   - Add optional `sleep` to `InProcessReviewerDeps` with abort-aware `combinedSignal` handling.
   - Guard against non-Error rejections (`attemptFailed` boolean) so undefined rejections cannot throw uncaught property access errors.
   - Retain `priorFailure` message as evidence in `abortRefusal()` when an abort or timeout fires during backoff sleep.
2. In `tests/inprocess-reviewer.test.ts`:
   - Test that transient network transport errors (e.g. `ECONNRESET`) retry and succeed.
   - Test that transient `503 Service Unavailable` error statuses retry and succeed.
   - Test that deterministic JSON parse / truncation errors do NOT retry (`attempt === 1`).
   - Test that undefined rejections safely refuse with `PROVIDER_FAILED`.
   - Test that abort or timeout during backoff sleep retains `priorFailure` evidence.
   - Test that exhausting retries refuses with `PROVIDER_FAILED`.

## Tasks
- [x] Task 1: Create ODD feature tracking document
- [x] Task 2: Implement transient retry logic and abort-aware sleep in lib/inprocess-reviewer.ts
- [x] Task 3: Exclude deterministic JSON parse errors and handle undefined rejections safely
- [x] Task 4: Add causal regression tests covering transient recovery, deterministic non-retries, and backoff aborts
- [x] Task 5: Verify all tests and typechecks pass
- [ ] Task 6: Create work-unit commit and update PR #1318
