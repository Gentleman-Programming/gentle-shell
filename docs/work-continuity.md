# Bounded work continuity

## Scope and delivered guidance

This is a Shell prompt-guidance improvement, not an incident closure for #2211 or #1669. The always-on parent guidance distinguishes a recoverable failure from genuinely inaccessible proof before a bounded stop, and describes a parent-only route for explicitly authorized maintenance that a worker cannot perform. Neither rule grants permission, changes correction limits, or implements a backup or rollback operation.

| Situation | Guidance delivered to the parent |
| --- | --- |
| A test or harness check fails, but a correction and rerun remain in scope and within the existing budget | Correct and continue without asking for approval of each transition. Do not reset the budget or weaken the check. |
| The human specified one run, no retries, or diagnostic only | Honor that limit; do not propose diagnostic-only or single-attempt authorization unless requested. |
| Proof is genuinely inaccessible, consent is required, an action is denied, or the correction budget is exhausted | Stop and report the blocker. Terminal outcomes and existing bounded-stop rules remain binding; an unavailable verifier is not retried. |
| A worker cannot perform an upgrade | Only the parent may act after explicit authorization of the operation, exact scope and ownership, preservation, permitted tools, applicable fresh consent and guards, a validated backup, applicable artifact/migration validation, and a recovery path are established. |
| An authorized rollback mixes task changes and unrelated changes, even in one file | Preserve unrelated edits; remove only proven task-created helpers. Never blanket restore, reset, or clean. Ambiguous ownership or denial stops the operation. |

Broad feature approval is not destructive-operation authority. Do not reroute a denial to another worker or tool. No real maintenance, backup, migration, rollback, destructive Git operation, or model/provider operation was performed for this work.

## Current bounded checks

On the current Windows workspace, with existing dependencies and no installation, network, provider, or model calls, the bounded verification run recorded these results:

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test tests/work-continuity-contract.test.ts` | Exit 0; 2 passed, 0 failed, 0 skipped, 0 cancelled. |
| `node --experimental-strip-types --test tests/append-system-prompt-route.test.ts` | Exit 0; 4 passed, 0 failed, 0 skipped, 0 cancelled. |
| `node --experimental-strip-types --test tests/review-contract-prompt.test.ts` | Exit 0; 12 passed, 0 failed, 0 skipped, 0 cancelled. |
| `node scripts/check-provider-contract.mjs` | Exit 0; mirror contract 1.4.0, 10 bundle entries, and 2 generated baselines verified. |

Each test command ran once. The parent repeated the provider-mirror check as a spot check; it also exited 0. These checks establish prompt delivery through Pi's `before_agent_start` event, prompt idempotence, child and named-agent exclusions, and offline provider-mirror integrity. They do not execute a model's decisions or reproduce either reported incident. Actual model behavior, including recovery, explicit-limit, upgrade, and mixed-ownership rollback decisions, remains unverified.

## Historical preservation and later baseline evidence

The original preservation snapshot remains historical evidence, not a current conclusion: its recorded focused result was 11 instruction-delivery tests plus typecheck, provider-contract, and runtime-harness passes. Its full-suite record was 337 failures, 1 cancellation, and 331 skipped tests. The full log became unavailable, so those failures were not waived, attributed to this change, or comprehensively compared with baseline.

The snapshot's statement that no representative baseline/candidate comparisons had run was accurate at that time. Subsequent committed Windows diagnostics now provide narrower current evidence:

- [Representative baseline/candidate probes](../odd/diagnostics/work-continuity-windows/representative-baseline-candidate-probes.md) show three exact selected failures on both baseline `eff5d24694b21663095a4790b3ef15de21c290c2` and the original WIP candidate.
- [Remaining commit-path verification](../odd/diagnostics/work-continuity-windows/remaining-commit-path-verification.md) establishes a fourth selected baseline failure, then records its fixture-only portability correction and a complete-file result of 12 passed.
- [Complete-file verification](../odd/diagnostics/work-continuity-windows/complete-file-verification.md) records 17 passed for writer surfaces and 23 passed with 46 POSIX skips for bundled install; the later commit-path report supersedes its earlier 11/12 result for that file.

Those four selected cases are bounded Windows evidence only. They do not attribute all 337 historical failures, test Linux or skipped POSIX behavior, waive the unavailable full-suite evidence, or establish delivery readiness. The later fixture corrections are separate from the original Shell prompt-guidance improvement.

## Ownership and review limits

The continuity clarification is Shell-owned and operates before existing terminal outcomes. The provider owns the mirrored Close contract; its bundle, hashes, and wording remain unchanged. A provider-owned semantic change requires separate authority.

Global RDD was on. An earlier preflight stopped with `immutable_review_transport_unsupported`; no review authority was started, no receipt exists, and review or mode was not retried. That unavailable review transport does not itself authorize or prohibit ordinary delivery; any delivery decision must use its applicable authority and evidence. Two wording advisories remain nonblocking and unproven: the sentence about not proposing diagnostic-only or single-attempt authorization, and the maintenance sentence that stops when a prerequisite is missing. No GitHub issue status was consulted, and this document does not claim publishing, delivery approval, or issue closure.
