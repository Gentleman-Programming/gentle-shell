# Bounded work continuity

Shell's always-on parent guidance distinguishes a recoverable failure from genuinely unavailable proof before a bounded stop. It also describes a parent-only route for explicitly authorized maintenance that a worker cannot perform. Neither rule grants permission or changes correction limits.

## Acceptance scenarios

| Situation | Guidance delivered to the parent |
| --- | --- |
| A test or harness check fails, but a correction and rerun remain in scope and within the existing budget | Correct and continue without asking for approval of each transition. Do not reset the budget or weaken the check. |
| The human specified one run, no retries, or diagnostic only | Honor that limit; do not propose diagnostic-only or single-attempt authorization unless requested. |
| Proof is genuinely inaccessible, consent is required, an action is denied, or the correction budget is exhausted | Stop and report the blocker. Terminal outcomes and the existing bounded-stop rules remain binding; an unavailable verifier is not retried. |
| A worker cannot perform an upgrade | Only the parent may act, after explicit authorization of the operation, exact scope and ownership, preservation, permitted tools, applicable fresh consent and guards, a validated backup, applicable artifact/migration validation, and a recovery path are established. |
| An authorized rollback mixes task changes and unrelated changes, even in one file | Preserve unrelated edits; remove only proven task-created helpers. Never blanket restore, reset, or clean. Ambiguous ownership or denial stops the operation. |

Broad feature approval is not destructive-operation authority. Do not reroute a denial to another worker or tool. This policy does not authorize an upgrade, rollback, or other destructive operation now.

## WIP verification status

This patch is preserved as local work in progress, not a verified fix or a ready-to-integrate change.

- Recorded passes: 11 focused instruction-delivery tests, typecheck, provider-contract check, and runtime harness. Independent verification found no severe instruction-contract blockers.
- Recorded full-suite result: 337 failures, 1 cancellation and 331 skipped tests; baseline causality was not established. These failures are not waived or claimed to predate the patch.
- The historical full log and diagnostic scratch are no longer accessible. No representative baseline/candidate Node comparisons ran; source-only Windows fixture hypotheses are not reproductions.
- No tests were rerun for this preservation commit. Native review and behavioral incident verification remain outstanding before any delivery claim. No publishing or issue closure is authorized.

## Evidence and ownership

The focused tests exercise instructions delivered through Pi's `before_agent_start` event, including existing child and named-agent exclusions and bounded-stop contracts. They do not execute a model's decisions or reproduce either reported incident. Runtime scenarios for failure recovery, explicit limits, upgrade and mixed-ownership rollback remain unexecuted.

The continuity clarification is Shell-owned and operates before existing terminal outcomes. The provider owns the mirrored Close contract; its bundle, digest checks and wording remain unchanged. Any change to that contract belongs upstream and requires separate authority; Shell's guidance is not an upstream fix.
