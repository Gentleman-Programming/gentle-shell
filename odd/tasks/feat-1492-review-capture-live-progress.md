# Feat #1492: Surface in-flight reviewer lens progress during capture

## Objective
Wire the currently discarded `onUpdate` channel in `gentle_review_capture` and `gentle_review_capture_group` to relay choke points in `lib/review-host-relay.ts` and `extensions/gentle-ai.ts`, surfacing live per-slot progress (`selected -> materializing -> reviewing -> prepared -> submitting -> submitted`) during capture.

## Problem
In a high-tier native review running four reviewer lenses (or a single-slot capture), reviewers run via in-process model completions taking minutes. During this time, the capture tools discard the `onUpdate` callback, leaving the TUI card static and uninformative, looking like a hung tool call with zero visibility into materialization, model review, or group concurrency.

## Solution
1. In `lib/review-host-relay.ts`:
   - Introduce `ReviewHostRelayProgress` type with phases: `selected`, `materializing`, `reviewing`, `prepared`, `submitting`, `submitted`.
   - Thread an optional progress callback through `prepareReviewHostRelaySlot`, `submitReviewHostRelayPreparedResult`, `runReviewHostRelaySlot`, and `runReviewHostRelayReviewerGroup`.
   - Provide clean formatters for single-slot and group progress.
2. In `extensions/gentle-ai.ts`:
   - Accept `onUpdate` in `executeReviewCaptureOperation` and `executeReviewCaptureGroupOperation`.
   - Emit progress updates during materialization/review and as prepared results are submitted sequentially to the native controller.
   - Wire `onUpdate` from `gentle_review_capture` and `gentle_review_capture_group` tool execute handlers.
3. Tests:
   - Add unit tests in `tests/review-host-relay.test.ts` proving progress callbacks receive every phase in order for single and group runs.
   - Add integration tests in `tests/review-relay-transport-agent.test.ts` verifying that `onUpdate` is called with live progress during capture and capture-group execution.

## Tasks
- [ ] 1. Add progress types and callbacks in `lib/review-host-relay.ts` with unit tests (RED -> GREEN).
- [ ] 2. Wire `onUpdate` through `executeReviewCaptureOperation` and `executeReviewCaptureGroupOperation` in `extensions/gentle-ai.ts`.
- [ ] 3. Add tests in `tests/review-relay-transport-agent.test.ts` verifying live progress updates.
- [ ] 4. Run full test suite and typecheck.
- [ ] 5. Commit and open PR referencing #1492.
