# PR #1382 Review Fixes

## Objective

Close the verified CodeRabbit review findings on PR #1382 (`#1373` large child instruction transport) by adding regression tests for failure paths during temporary file transport and child startup.

## Problem

PR #1382 added owner-only temporary file transport for large agent instructions and cleanup routines in `lib/agents-runner.ts`. While the happy path and synchronous spawn throw path were tested, coverage was missing for:
1. Instruction write failure after the transport directory is created on disk.
2. Early child error before a PID is assigned (`pid === undefined`).

## Scope

- Add regression tests in `tests/agents-runner.test.ts` covering both failure paths.
- Assert that in each case the task fails with an informative error and the temporary transport directory and file are completely cleaned up.
- Verify test suite and typecheck.

## Constraints

- Keep the patch minimal and limited to PR #1382 review findings.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.

## Tasks

- [x] **T1 — Test transport directory cleanup on instruction write failure.** Simulate write failure after directory creation and assert task failure and directory removal.
- [x] **T2 — Test transport directory cleanup on early child error pre-PID.** Simulate early error before child PID and assert task failure and directory removal.
- [x] **T3 — Full verification.** Run test suite and typecheck.
