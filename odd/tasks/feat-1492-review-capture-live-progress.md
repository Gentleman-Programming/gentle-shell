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
   - Emit periodic elapsed-time progress updates while reviewers are actively in the `reviewing` phase.
   - Provide full JSDoc docstrings for formatters and relay functions.
2. In `extensions/gentle-ai.ts`:
   - Accept `onUpdate` in `executeReviewCaptureOperation` and `executeReviewCaptureGroupOperation`.
   - Emit progress updates during materialization/review and as prepared results are submitted sequentially to the native controller.
   - Keep slots in `prepared` during STATUS verification; emit `submitting` strictly when submission begins via the runner callback.
   - Wire `onUpdate` from `gentle_review_capture` and `gentle_review_capture_group` tool execute handlers.
3. Tests:
   - Add unit tests in `tests/review-host-relay.test.ts` proving progress callbacks receive every phase in order for single and group runs, plus periodic elapsed-time reviewing progress.
   - Add integration tests in `tests/review-relay-transport-agent.test.ts` verifying that `onUpdate` is called with live progress during capture and capture-group execution.

## Tasks
- [x] 1. Add progress types and callbacks in `lib/review-host-relay.ts` with unit tests (RED -> GREEN).
- [x] 2. Wire `onUpdate` through `executeReviewCaptureOperation` and `executeReviewCaptureGroupOperation` in `extensions/gentle-ai.ts`.
- [x] 3. Add tests in `tests/review-relay-transport-agent.test.ts` verifying live progress updates.
- [x] 4. Run full test suite and typecheck.
- [x] 5. Address CodeRabbit review: periodic reviewing elapsed-time updates, defer grouped submitting phase to runner, and add JSDoc docstrings.
