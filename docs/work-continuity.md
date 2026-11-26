# Bounded work continuity

## Scope and delivered guidance

This is a Shell prompt-guidance improvement, not an incident closure for #2211 or #1669. The provider-owned canonical Close now owns the authorized-work boundary: run authorized steps; wait for a pending child whose completion will resume the turn without asking the human. A real human decision, an explicit user stop, a denial, missing consent, or an exhausted limit stops only the work it applies to. If a failure has no permitted route left, report the affected work as incomplete rather than waiting for a decision nobody needs to make. Continue independent authorized work. Pi's always-on continuity keeps its unique guard, budget, worker-continuation, and maintenance clauses without restating that boundary or licensing a generic **Needs your decision** stop. The parent-only maintenance route remains guidance for an explicitly authorized operation a worker cannot perform. The worker's progress rule does not grant permission, change explicit limits, or implement a backup or rollback operation.

| Situation | Guidance delivered to the parent |
| --- | --- |
| A test or harness check fails, and correction remains in scope | A failed check is an obstacle. Keep correcting while each attempt names a cause from the output and changes something to address it. Never repeat the same change or stop because of an attempt count. |
| The human specified one run, no retries, or diagnostic only | Honor the explicit limit only for the work it names. Do not reset or bypass it. |
| Proof is missing, partial, unavailable, or declined; consent is required; an action is denied; or an explicit limit is exhausted | Missing proof forbids claiming completion of the affected work, never an independently authorized next step. Keep running required authorized checks that any applicable limit still allows. Denial, missing consent, and exhaustion stop only the work they apply to. Terminal outcomes and native review budgets remain binding; an unavailable verifier is not retried automatically. The narrow human-requested quota recovery below is a separate attempt. |
| The same cause fails again after a real fix with no new hypothesis; passing would require weakening, skipping or rewriting the check; or correction would cross allowed edit surfaces or an explicit limit | The worker returns `status: partial` with evidence. The worker's cycle ends, not the unit. On any such partial handoff, even after the first failure, the parent acts on the diagnosis without asking the user, within user scope and native authority: organic mode may fix inline when small and understood; full delegation launches a new bounded writer carrying the diagnosis and new evidence with a changed scope or hypothesis. The parent never repeats the same attempt or bypasses a limit. With no permitted new approach, it reports only that work as incomplete and continues independent work. Only a genuinely human decision goes to the user. See `docs/delegated-verification.md`. |
| A worker cannot perform an upgrade | Only the parent may act after explicit authorization of the operation, exact scope and ownership, preservation, permitted tools, applicable fresh consent and guards, a validated backup, applicable artifact/migration validation, and a recovery path are established. |
| An authorized rollback mixes task changes and unrelated changes, even in one file | Preserve unrelated edits; remove only proven task-created helpers. Never blanket restore, reset, or clean. Ambiguous ownership or denial stops the operation. |

A tracked task may end the turn pending only while it waits on already-launched work; for the affected work an already-decided denial, missing consent, the user's explicit stop, or an exhausted limit applies; or a genuine human decision stays outstanding. A partial user stop applies only to that work, unrelated runnable authorized work continues, and the turn never abandons runnable work or presents an unverified outcome as final. A report never turns into a blind self-reprompt loop.

Broad feature approval is not destructive-operation authority. Do not reroute a denial to another worker or tool. No real maintenance, backup, migration, rollback, destructive Git operation, or model/provider operation was performed for this work.

## Temporary verifier quota recovery

The always-on prompt points to `assets/orchestrator-quota-recovery.md`; the parent loads these conditions only when recovery is requested.

A verifier that ended on a temporary quota error without a verdict has not supplied proof or approval. Its automatic cycle stops. After availability is restored, the human can explicitly request one new bounded attempt at the missing verification for the same candidate. A general request to continue implementation is not that request.

Preserve the failed attempt and still-valid successful checks; run the missing verification rather than replaying passed suites. Before dispatch, confirm the previous child has ended and no child has uncertain status. A candidate change requires the ordinary verification decision for that changed candidate. Do not automatically wait, retry, or substitute a provider/model. Consent, actual denials, explicit one-run/no-retry limits, terminal native outcomes and exhausted native budgets remain binding; this request does not reset them.

This guidance changes no runtime quota detection, provider selection, or native review authority. The provider-owned Close boundary and the pinned installer contracts remain outside this quota-recovery rule. Delivered-instruction tests do not establish model adherence or a successful subscription-recovery journey.

## Current bounded checks

On the earlier Windows workspace, with existing dependencies and no installation, network, provider, or model calls, the bounded verification run recorded these results against the then-current contract 1.4.0 mirror. The current field-test mirror is contract 1.7.0 and `node scripts/check-provider-contract.mjs` validates its bytes:

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

The continuity clarification is Shell-owned and defers to the provider-owned Close contract for the authorized-work boundary. This delivery consumes the contract 1.7.0 field-test mirror generated from the finished canonical source through `scripts/mirror-provider-contract.mjs`; Pi never hand-edits bundle bytes or the manifest digest, and the released installer pin and capability rows remain unchanged. A released provider, installer, RDD-switch, native-guard, question-tool, or surface-policy change requires separate authority.

Global RDD was on. An earlier preflight stopped with `immutable_review_transport_unsupported`; no review authority was started, no receipt exists, and review or mode was not retried. That unavailable review transport does not itself authorize or prohibit ordinary delivery; any delivery decision must use its applicable authority and evidence. Earlier wording advisories concerned the diagnostic-only sentence, now removed with the generic terminal license, and the maintenance sentence, which remains guidance without new authority. No GitHub issue status was consulted, and this document does not claim publishing, delivery approval, or issue closure.
