# codegraph lock-safe worktree seed

Worktree indexes are produced by copying the parent checkout's .codegraph
through a lock-safe snapshot; init/index never runs for a worktree that has a
parent index. Authorized by "go with Lock-safe copy" after the r4 e2e round
showed the forbidden init fallback firing whenever the main writer was busy.

## Specs

- S1: "in worktrees .codegraph must be copied in the worktree and never run init or index" (user, 2026-11-17)
- S2: "go with Lock-safe copy" (user, 2026-11-17)
- S3: AGENTS.md:16 rule: "init is for fresh projects without a parent index." The r2-r4 e2e worktrees all HAD a parent index, so the runtime's init fallback violated S1/S3.

## Tasks

- T1 [done] | S1-S3 | RED tests: run node tmp/e2e-cg-locksafe/splice-red-tests.mjs (busy-writer snapshot, main-init-lease defer, blocked placement, readiness seed-failed stand-down) and observe exactly the expected REDs | tests/codegraph-seed.test.ts, tests/codegraph-readiness.test.ts | commit: none
- T2 [done] | S1-S3 | Implement: seedWorktreeIndex lock-safe snapshot copy (node:sqlite VACUUM INTO, standalone journal_mode=DELETE output, no sidecar copying, defer only while the main checkout's own init lease is live) + prepareReadiness seed-failed stand-down guard so a parent-index worktree never inits | lib/codegraph-seed.ts, lib/codegraph-readiness.ts | commit: none
- T3 [done] | S1-S3 | GREEN + differential: bun test the two touched files, then all 8 codegraph-family files, comparing against the pre-change baseline tmp/e2e-cg-locksafe/baseline-suites.log (169 pass / 0 fail); no previously-passing test may fail | - | commit: none

## Log

- L1: "run e2e codegraph test for worktree if complies with what is said in agents.md. check if the codegraph is init, unlock and sync is run and if engram is queried"
- L2: "index was run in the parent or in the worktree ?" — answered: index target was the worktree; executor was the session runtime; process cwd was harness temp dirs with explicit positional path args.
- L3: "in worktrees .codegraph must be copied in the worktree and never run init or index" — norm stated; r4 index verdict reversed to NON-COMPLIANT (memory obs 4488 updated).
- L4: "go with Lock-safe copy" — mechanism selected (option b of the proposed a/b/c); r4 evidence: tmp/e2e-cg-wt-r4/.
- L5 (2026-11-17): gentle-ai-worker mwlc11bf-2-ib12 completed T1-T3. RED: red-run2.log 64 pass / 2 fail, exactly the mandated failures (busy-writer main-busy vs seeded; readiness seed-failed fell back to run:init -y). GREEN: green-run.log 66/66. Family differential: after-suites.log 170 pass / 0 fail vs baseline 169/169 (only +1 net new test; no previously-passing test fails). Deviation: 3-line fixture repair in openMainDbWithWal (rmSync pre-written db before open; worktreePair's writeDb pre-creates the marker table). Independent verification: gentle-ai-verify mwlcgq2n-3-5b1z dispatched (Risk item 3, shared seed/readiness code). No commits.
- L6 (2026-11-17): gentle-ai-verify mwlcgq2n-3-5b1z: S1/S2/S3 PASS, no shared-code regression (fresh runs 66/66, 170/170, check-types clean; only init launch site readiness.ts:400 gated behind not-seedable/seed-undefined; 0 stale sidecar refs). Advisories (pre-existing, outside diff): user-invoked init not parent-gated; linkedWorktreeIdentity failure edge falls to init. Scope note: AGENTS.md:16 sidecar-copy wording now contradicts the snapshot implementation (doc edit is the user's call). Cosmetic splice under-indent fixed (13 lines, tmp/e2e-cg-locksafe/fix-indent.mjs); re-verified 66/66. Live r5 e2e (tmp/e2e-cg-wt-r5/): init 0, copy proven (127,431 edges vs main 127,439), engram after codegraph. Fix remains uncommitted.
- L7 (2026-11-17): gentle-ai-verify mwlcrkgq-4-yu5n (Risk item 3, this prompt's scope): ALL PASS. Indent fix confirmed whitespace-only (13 lines, script-asserted prefixes verbatim in current bytes) with a fresh 66/66 re-run; every r5 claim independently confirmed against raw artifacts (0 init / 0 unlock / 2 sync; codegraph query+explore before mem_search+mem_context, re-confirmed by an independent awk scan of the raw jsonl; 973/127,431 vs 973/127,439 edges, no truncation warnings; worktree clean, main 12 entries identical). Verification artifacts: tmp/e2e-cg-locksafe/verify-*.
