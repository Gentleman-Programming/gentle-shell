# Fast RDD routing

Branch: `fix/fast-rdd-routing`

## Objective

Preserve ODD, applicable test-first development, bounded delegation, work-unit commits, and native RDD while removing redundant serial verification and review loops.

## Acceptance

- Read-only diagnosis and explanation never authorize implementation work.
- A delegated writer's passing focused checks remain the verification of record and are not rerun.
- With RDD on, ASSESS is performed at a committed work-unit boundary.
- When native assessment reports `reviewDue=true`, its opaque continuation is handled before independent-verifier routing.
- A closed native review suppresses a duplicate independent verifier.
- Declined, unavailable, unknown, partial, blocked, or unresolved high-risk evidence remains fail-closed.
- At most one independent verifier runs for one work unit.
- Existing background-subagent defaults remain unchanged.

## Tasks

- [x] FRR-1 Restore review-first RDD routing in code, prompt policy, documentation, generated runtime, and focused contract tests.
- [x] FRR-2 Restore canonical high-risk anchors and prompt budgets exposed by the full-suite PR check.
- [ ] FRR-3 Publish the reviewed branch through an issue-linked pull request.

## Route

Delegated direct: one bounded writer because the correction spans multiple non-trivial files. The worker owns focused RED/GREEN checks. The parent performs only the cheapest reported spot check before the work-unit commit.

## Evidence

- Read-only map: subagent `mv3y88gf-7-126g`.
- Work-unit commit: `fix(orchestration): restore review-first RDD routing` (this commit).
- Focused verification: 95 risk-assessment tests and 22 routing-contract tests passed; runtime generation, typecheck, and diff checks passed.
- Full-suite PR check after FRR-1: 6,244 passed, 14 failed, and 71 skipped. Nine candidate-caused contract/budget failures are tracked by FRR-2; five installer failures require the missing `zip` tool.
- FRR-2 work-unit commit: `fix(orchestration): restore routing contract ratchets` (this commit).
- FRR-2 focused verification: 130 passed, 0 failed; `git diff --check` passed. `assets/orchestrator.md` is 8,196 B and `assets/orchestrator-delegation.md` is 20,746 B; rendered core remains within 8,400 B at the controlled long root.
- Engram task mirror: unavailable in this session; no callable observation-write tool is installed.
