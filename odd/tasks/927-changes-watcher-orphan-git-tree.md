# #927 Changes Watcher Leaves an Orphaned Git Process Tree

## Objective

Make the changes watcher's git child die together with its descendants on Windows, so reloading or
exiting the extension leaves no `git` process behind scanning the repository.

## Problem

`shellGitRunner` in `extensions/gentle-shell.ts` bounded a scan by killing the direct child on
timeout. On Windows that is not sufficient. libuv places children in a Job Object, so killing the
direct child also kills descendants that are not detached — but a descendant spawned with
`detached: true` escapes the job and survives. That surviving process is the orphan reported in
#927: it keeps running after the extension is gone and competes for the same worktree.

## Why

Issue #927 reports leftover git scans after the watcher stops. A timeout that reports failure while
leaving a live process is worse than a slow scan: the next session inherits contention it did not
create, and on Windows there is no reliable way to attribute the orphan afterwards.

## Scope

- Add a `killProcessTree` parameter to `shellGitRunner`, threaded from the caller.
- On Windows, enforce a dedicated deadline at `GIT_TIMEOUT_MS` and escalate with
  `GIT_TREE_KILL_GRACE_MS` (1,000 ms) to a tree kill instead of a direct-child kill.
- Track `settled` / `timedOut` so `settle()` closes pipes exactly once and a timed-out scan resolves
  with `code: 1` rather than hanging on a half-closed stream.
- Unref the timers so they cannot hold the event loop open.
- Leave non-Windows behaviour unchanged.

## Constraints

- Allowed edit surfaces: `extensions/gentle-shell.ts` and this task document.
- Preserve the existing scan contract: same success shape, same failure signal apart from the
  timed-out `code: 1`.
- No dependency added for process-tree handling; the platform already provides it.
- Technical artifacts remain in English.
- No `Co-Authored-By` or AI attribution in commits.
- Pushing and opening the PR are authorized separately per work unit.

## Tasks

- [x] **T1 — Reproduce the orphan semantics.** Confirmed against libuv's Windows job handling that a
  direct-child kill reaches non-detached descendants and that a `detached: true` descendant escapes,
  which is the only way the reported orphan can exist. Testing the timeout path therefore has to
  assert that the tree is gone, not that the child exited.
- [x] **T2 — Kill the tree on the deadline.** `shellGitRunner` now accepts `killProcessTree`; on
  Windows the timeout path escalates to a tree kill after `GIT_TREE_KILL_GRACE_MS`, `settle()` closes
  pipes and resolves once, and a timed-out scan returns `code: 1`. Non-Windows paths are untouched.
- [x] **T3 — Verify the work unit.** 321 tests, 316 passing; the 5 failures are pre-existing on this
  Windows host and reproduce on a pristine checkout of the same base. Typecheck ratchet at 0
  diagnostics. `tests/runtime-harness.mjs` exits 0.

## Acceptance Criteria

- A scan that exceeds the deadline on Windows terminates the entire process tree, including detached
  descendants.
- A timed-out scan resolves with `code: 1` instead of hanging.
- Timers do not keep the process alive after settlement.
- Non-Windows behaviour and the existing scan contract are unchanged.
- No orphaned `git` process remains after the extension stops.

## Checks

- Work-unit commit: `5c4643681` (`fix(shell): kill the whole Git process tree on Windows scan timeout`),
  +97/−7 across `extensions/gentle-shell.ts`.
- Tests: 321 total, 316 passed, 5 failed — all five reproduce on the pristine base commit and are
  Windows-specific pre-existing failures, not caused by this change.
- Typecheck: `node scripts/check-types.mjs` — 0 recorded diagnostics, no regressions.
- Runtime harness: `node --experimental-strip-types tests/runtime-harness.mjs` — exit 0.
- Diff scope: only `extensions/gentle-shell.ts` and this task document.

## Progress

Fix committed on `fix/changes-watcher-orphan-git-tree` and delivered as PR #2394 with `Fixes #927`.
The PR is `MERGEABLE` and `UNSTABLE`: CI waits on maintainer approval for fork runs, and the
`type:bug` label could not be applied from this account because it lacks triage permission.

PR #1691 (`dnlrsls`, open, no commits since 2026-10-03) addresses the same issue. It is disclosed in
the PR body rather than silently ignored, so the maintainer chooses which implementation to keep.

## Next Step

Push this task document so the PR carries its work-unit record, then wait for the maintainer's label
and fork-CI approval.
