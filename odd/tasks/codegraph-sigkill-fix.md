# Feature: codegraph-sigkill-fix

Battery run 20261115-183924 remediation: fix the deterministic POSIX SIGKILL regression (U1, repo code, own commit), then the tmp/ harness polish units (U2-U4) and battery-prompt baseline refresh (U5), closed by a full 4-rig battery re-run.

## Specs

- S1 (U1, regression): On POSIX (mac/linux) the test `runCodegraph: a SIGTERM-ignoring command is SIGKILLed before the timeout result` FAILS with "this test timed out after 5000ms, before its done callback was called" (mac 5002.89ms/5003.24ms, linux 5001.47ms/5000.59ms; deterministic 2/2 iterations; skipped on win). It passed at a2345ab and broke at 9120e3122; suspect commit `017f6042d` "harden readiness abort, recheck, cache and kill paths" (lib/codegraph-readiness.ts). Requirement: escalation resolves well inside the 5s test ceiling on POSIX; the existing test pins it (RED -> GREEN); 4 T01 suites + typecheck green; T01 re-run green on .37 and .38.
- S2 (U2, harness): T03 re-runs log `WORKTREE_ADD_EXIT=255` because `wt-cg-test` worktree/branch survives the prior run. Requirement: `test03-worktrees.sh` and `test03-worktrees.ps1` remove the worktree and branch at the end, emitting `WORKTREE_RM_EXIT`; removal failure is logged, never fatal.
- S3 (U3, harness): `test02-subagents.sh`/`.ps1` emit `STATUS_P_*`/`SYNC_P_*`/`QUERY_P_EXIT` but no `QUERY_P_MS`. Requirement: the timed wrapper also emits `QUERY_P_MS` beside `QUERY_P_EXIT`.
- S4 (U4, harness): mac PATH accumulates repeated `export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"` segments across pathfix runs (`GATE_PATH` showed 5 repetitions). Requirement: `vmfix-path-posix.sh` removes existing `.local/bin`/`.bun/bin` PATH-export duplication (both .zshrc and .zshenv) before appending the canonical line, keeping `FIX_DONE`.
- S5 (U5, docs): battery .md baselines are 67/0-era; measured at 9120e3122: T01 81 tests (mac/linux 80/1, win 78 pass/3 skip), T02 44 (linux 43+1 skip #2558), T03 11/0, "Indexed 977 files". Requirement: after U1's commit, refresh expected baselines + recorded tip sha in `tmp/vmtest-battery-prompt.md`.
- S6 (close): full battery re-run at the new tip (4 rigs + T04 UNC): expect 9/9 + T04 green, early stop at iteration 1.

## Tasks

- T1: S1 — reproduce RED locally, diagnose 017f6042d kill path, fix lib/codegraph-readiness.ts, GREEN + typecheck, work-unit commit. Route: inline (orchestrator). Commit: <pending>
- T2: S2 — worktree cleanup in test03-worktrees.sh/.ps1 (run dir host/). Route: inline. Commit: n/a (tmp/)
- T3: S3 — QUERY_P_MS in test02-subagents.sh/.ps1 (run dir host/). Route: inline. Commit: n/a (tmp/)
- T4: S4 — idempotent pathfix in vmfix-path-posix.sh (run dir host/). Route: inline. Commit: n/a (tmp/)
- T5: S5 — .md baseline refresh at the post-U1 tip. Route: inline. Commit: n/a (tmp/)
- T6: S6 — full battery re-run + report. Route: inline (VM battery). Commit: n/a

## Log

- L1 (2026-11-15, user): "plan to address all findings, regressions and failures"
- L2 (2026-11-15, user, side question): "this plan is for code or for tests"
- L3 (2026-11-15, user, decision): "commit first and go with all" — U1 committed first as its own work-unit commit on feat/improve-codegraph, then U2-U5 + full battery re-run; UNC status optimization (U6) deferred.
