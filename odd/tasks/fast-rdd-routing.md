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

## Route

Delegated direct: one bounded writer because the correction spans multiple non-trivial files. The worker owns focused RED/GREEN checks. The parent performs only the cheapest reported spot check before the work-unit commit.

## Evidence

- Read-only map: subagent `mv3y88gf-7-126g`.
- Work-unit commit: `fix(orchestration): restore review-first RDD routing` (this commit).
- Focused verification: 95 risk-assessment tests and 22 routing-contract tests passed; runtime generation, typecheck, and diff checks passed.
- Engram task mirror: unavailable in this session; no callable observation-write tool is installed.
