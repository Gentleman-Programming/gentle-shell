# #927 Changes Watcher Leaves an Orphaned Git Process Tree

## Objective

Make the changes watcher's git child die together with its descendants on Windows, so reloading or
exiting the extension leaves no `git` process behind scanning the repository.

## Problem

`shellGitRunner` in `extensions/gentle-shell.ts` bounded a scan by killing the direct child on
timeout. On Windows that is not sufficient. Neither libuv nor `execFile` groups the children in a Job
Object: the timeout ends in `TerminateProcess` on the direct child, which never reaches descendants.
A `git` scan that delegated its work to a child keeps that child running, and the surviving process
is the orphan reported in #927: it keeps running after the extension is gone and competes for the
same worktree.

The empirical check that settled this: killing a `cmd.exe` parent left its non-detached child
writing to the inherited pipe (217 → 272 → 382 bytes after the kill). Only `taskkill /T` issued from
a live parent walks the tree; `detached: true` is a Node spawn flag and has no bearing on children
`git` creates natively.

## Why

Issue #927 reports leftover git scans after the watcher stops. A timeout that reports failure while
leaving a live process is worse than a slow scan: the next session inherits contention it did not
create, and on Windows there is no reliable way to attribute the orphan afterwards.

## Scope

- Add a `killProcessTree` parameter to `shellGitRunner`, threaded from the caller.
- On Windows, enforce a dedicated deadline at `GIT_TIMEOUT_MS`: when it fires, call
  `killProcessTree(pid)` while the direct child is still alive, and after `GIT_TREE_KILL_GRACE_MS`
  (1,000 ms) fall back to a direct-child kill and cut the inherited pipes.
- Track `settled` / `timedOut` so `settle()` clears the timers and resolves once, while the grace
  callback kills the direct child and destroys `stdout` / `stderr`; a timed-out scan resolves with
  `code: 1` rather than hanging on a half-closed stream.
- Unref the timers so they cannot hold the event loop open.
- Leave non-Windows behaviour unchanged.

## Constraints

- Allowed edit surfaces: `extensions/gentle-shell.ts`, `tests/gentle-shell.test.ts`, and this task
  document.
- Preserve the existing scan contract: same success shape, same failure signal apart from the
  timed-out `code: 1`.
- No dependency added for process-tree handling; the platform already provides it.
- Technical artifacts remain in English.
- No `Co-Authored-By` or AI attribution in commits.
- Pushing and opening the PR are authorized separately per work unit.

## Tasks

- [x] **T1 — Reproduce the orphan semantics.** Probed on this Windows host: a direct-child kill
  (`TerminateProcess`, what `child.kill()` and libuv's timeout do) leaves non-detached descendants
  alive and still writing to the inherited pipes, so the reported orphan needs no `detached: true`.
  Only `taskkill /T` from a still-live parent walks the tree. Testing the timeout path therefore has
  to assert that the tree kill is issued while the parent lives, not that the child exited.
- [x] **T2 — Kill the tree on the deadline.** `shellGitRunner` now accepts `killProcessTree`; on
  Windows the deadline calls the tree kill while the direct child is alive, the grace callback kills
  the direct child and cuts the pipes, `settle()` resolves once, and a timed-out scan returns
  `code: 1`. Non-Windows paths are untouched.
- [x] **T3 — Verify the work unit.** 321 tests, 316 passing; the 5 failures are pre-existing on this
  Windows host and reproduce on a pristine checkout of the same base. Typecheck ratchet at 0
  diagnostics. `tests/runtime-harness.mjs` exits 0.

## Acceptance Criteria

- On Windows, a scan that exceeds the deadline attempts to terminate the entire process tree while
  its direct child is still alive. A descendant that outlives its parent keeps the pipe but cannot be
  reached by PID from a dead parent, so the tree kill is best effort: `taskkill` itself may also fail
  under AppLocker or a broken PATH, and only the direct child and the pipes are handled then.
- A timed-out scan resolves with `code: 1` instead of hanging.
- Timers do not keep the process alive after settlement.
- Non-Windows behaviour and the existing scan contract are unchanged.
- No orphaned `git` process remains after a deadline that lands while the direct child is alive.

## Checks

- Work-unit commit: `5c4643681` (`fix(shell): kill the whole Git process tree on Windows scan timeout`),
  +97/−7 across two files: `extensions/gentle-shell.ts` (the fix) and `tests/gentle-shell.test.ts`
  (the regression that pins it).
- Tests: 321 total, 316 passed, 5 failed — all five reproduce on the pristine base commit and are
  Windows-specific pre-existing failures, not caused by this change.
- Typecheck: `node scripts/check-types.mjs` — 0 recorded diagnostics, no regressions.
- Runtime harness: `node --experimental-strip-types tests/runtime-harness.mjs` — exit 0.
- Diff scope: only `extensions/gentle-shell.ts`, `tests/gentle-shell.test.ts` and this task document.
- Deadline-wins regression: `tests/gentle-shell.test.ts` — "a timed-out scan that ends with exit 0
  still reports failure" models execFile answering cleanly with truncated porcelain once the grace
  cuts the pipes. Mutation-checked: deleting the `timedOut` branch in `settle()` turns it red
  (`0 !== 1`), while every other scan test stays green.

## Progress

Fix committed on `fix/changes-watcher-orphan-git-tree` and delivered as PR #2394 with `Fixes #927`.
The PR is `MERGEABLE` and `UNSTABLE`: CI waits on maintainer approval for fork runs, and the
`type:bug` label could not be applied from this account because it lacks triage permission.

PR #1691 (`dnlrsls`, open, no commits since 2026-10-03) addresses the same issue. It is disclosed in
the PR body rather than silently ignored, so the maintainer chooses which implementation to keep.

## Next Step

Push this task document so the PR carries its work-unit record, then wait for the maintainer's label
and fork-CI approval.
