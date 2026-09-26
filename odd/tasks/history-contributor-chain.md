# Complete contributor history chain

## Objective / authorization
Adapt and merge Gentle Shell History PRs #1391 (migration/seeding), #1393 (deletion/tombstones), and #1394 (compaction), in order. Exclude unrelated PR #1452. User authorized adaptation and merge. Issue #818 is approved. Earlier #1390/#1392/#1453–#1455 are already merged.

## Problem and constraints
The open PRs are cumulative branches from older main. #1393/#1394 switch the current `GENTLE_PI_HISTORY_CAPTURE` opt-in to `GENTLE_PI_HISTORY_ENABLE`; #1394's compaction can remove a file with concurrent appends and the seed gate, and runs at shutdown while capture is off. Current main is moving. Preserve existing privacy semantics, contributor attribution, and all unrelated work; do not merge an unsafe head and assume revert restores lost data.

## Route and delivery
Delegated direct writer for multi-file implementation and preparatory reading. One writer at a time; isolate each PR adaptation in its own worktree. Existing cumulative chain is the delivery strategy, in order #1391 → #1393 → #1394. Each slice is a work unit with tests/docs and Conventional Commit. Forecast: incremental #1391 ~510 lines; #1393 ~700 lines; #1394 ~600 lines, beyond the advisory 400-line PR budget; preserve coherent behavior and report size exception rather than code-golf. Check PR policy, exact head, mergeability, and required CI before each merge. Do not wait for optional CodeRabbit; evaluate critical findings on final heads. Review mode is user-owned.

## Tasks
- [ ] H1: Reconcile #1391 against current main, fix migration/seed privacy and retry issues with deterministic tests; verify and merge only when eligible. Route: delegated, multiple nontrivial source/test files. Commit and merge identities pending.
- [ ] H2: Reconcile #1393 against post-H1 main, preserve `GENTLE_PI_HISTORY_CAPTURE`, ensure exact tombstones, race-safe deletion, and failure reporting; verify and merge only when eligible. Route: delegated, multiple nontrivial source/test files. Commit and merge identities pending.
- [ ] H3: Reconcile #1394 against post-H2 main, preserve capture compatibility and seed gate, protect active writers during GC, and update truthful docs; verify and merge only when eligible. Route: delegated, multiple nontrivial source/test files. Commit and merge identities pending.

## Acceptance and checks
Run focused `tests/history-*.test.ts`, project verification/typecheck, `git diff --check`, and required exact-head CI as applicable. Each merged slice preserves current main's opt-in behavior and shows no lost prompts in concurrency/failure tests. No automatic rollback is a substitute for data safety. Record failures/skips/pending honestly.

## Progress
2026-09-26: Remote heads inspected: #1391 `649711c`, #1393 `e302337`, #1394 `5981153`; origin/main `06c9915` at the H1 snapshot. #1391 cumulative diff since #1455 is 1796 additions/23 deletions across 13 files; later cumulative PRs are larger. Separate #1391 worktree created at `fix/history-pr1391-adaptation`. H1 writer observed RED 2 migration failures, GREEN 14/14 focused tests. With node_modules linked from the main checkout, independent verification passed 168 history tests, typecheck had 188 baseline diagnostics and no regression, and `git diff --check` passed. Integration with main, commit, PR checks and merge remain pending. Engram mirror `odd/history-contributor-chain/tasks` pending: this session is bound to the separate gentle-ai project and Engram rejects a gentle-pi write.

## Next step
H1 is blocked: native review lineage `review-88445da92b015b5c` escalated with `targeted_validator_rejected` for R3-001/R3-002 after the single bounded correction. Do not publish or merge this candidate as approved. Diagnose the native refusal through supported maintainer inspection or make a separately authorized fresh candidate; keep H2/H3 pending. Last integrated commit `15249c57b`, correction commit `cc6ecca68`; independent recheck: 172 focused history tests pass, typecheck retains 188 baseline diagnostics without regressions, diff check passed. `pnpm test` aborted before tests because pnpm attempted a noninteractive `node_modules` purge; the equivalent direct unit stage ran 3,754 tests (3,707 pass, 4 fail, 43 skip), while direct provider-contract and runtime-harness stages passed. Three failures are presence-poll timeouts in `agents-view-thread-identity.test.ts`; one `gentle-shell.test.ts` border mismatch includes unexpected `INSERT`. Baseline attribution unverified. Native review is still escalated. No PR push or merge occurred.
