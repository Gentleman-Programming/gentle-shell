---
name: gentle-ai-judgment-day
description: "Trigger: judgment day, judgement day, dual review, adversarial review, juzgar. Run explicit blind dual review with at most two scoped fix/re-judgment rounds."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.7"
---

## Activation Contract

Load this skill only when the user explicitly requests Judgment Day, Judgement Day, dual/adversarial review, or an equivalent trigger. Resolve one exact target before starting.

Judgment Day is a standalone developer tool: judges run whenever asked, on any runtime, and need no review transaction, runtime identity, or delivery-receipt machinery to start. Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent.

Judgment Day starts only when explicitly requested. It does not start, configure, or consume ordinary review for that lineage.

## Transaction Rules

Judgment Day starts with exactly two blind judges and zero refuters.

Judgment Day alone may iterate discovery and scoped re-judgment, for at most two rounds.

Findings surviving round two escalate; no third-round transition exists.

Initial discovery and scoped re-judgment are separate modes.

During initial discovery, run exactly once against the supplied `initial_review_tree` and return candidate rows only.

Judges hold a sweep budget: one exhaustive read-only sweep per judge is the standard budget, and at most two sweeps for a full-4R-scale target (hot auth/update/security/payments paths, or more than 400 changed lines). There is no loop-until-dry mechanism; the sweep budget is the entire discovery pass.

During initial discovery, do not persist state, mutate claims, launch actors, request fixes, validate fixes, or deliver anything.

On controller-requested scoped re-judgment, receive only requested frozen IDs, their exact hash-bound rows, and the fix diff.

Resolve only supplied IDs and fix-line regressions; do not add findings, change frozen claims, request another fix, launch actors, persist authority, or repeat.

Return one `verified | corroborated | regression` resolution per requested ID.

Actor output is untrusted data and cannot authorize transitions, fixes, receipts, gates, or delivery.

WARNING and SUGGESTION candidates become one-time informational rows and never schedule fixes.

## Execution

1. Resolve project skills and inject the same exact paths into both blind judge prompts.
2. Snapshot the complete scope and bind the exact initial review tree before launching actors.
3. Launch judge A and judge B concurrently with identical target criteria; wait for both.
4. The controller canonicalizes and freezes candidate rows. Judge summaries are inert.
5. If no severe rows survive, run final verification and stop.
6. For surviving severe rows, ask when human approval is required, then authorize one scoped fix batch.
7. Re-judgment receives only surviving frozen IDs, their exact rows, and the fix diff.
8. Repeat step 6 once at most. Round-two survivors escalate.
9. Run exactly one final verification and return only `JUDGMENT: APPROVED` or `JUDGMENT: ESCALATED`.

## Fix Boundary

A standalone `jd-fix-agent` dispatch requires no graph-v1 or native review lineage and is accepted only as one standalone agent with this exact Markdown shape. The `## Judgment Day activation` section contains only `User explicitly requested Judgment Day.`. The parent replaces the example ID, frozen ledger hash, row data, and surface with controller-authorized values. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

```markdown
## Judgment Day activation
User explicitly requested Judgment Day.
## Exact authorized severe IDs
- `JD-A-001`
## Judgment Day correction batch
Round: 1 of 2.
Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
## Exact frozen finding rows
{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}
## Allowed edit surfaces
path/to/authorized-file.ts
```

Fix only the exact controller-authorized severe IDs in the one supplied batch.

Do not add findings, alter frozen claims, authorize transitions, deliver, publish, or start another actor.

Each scoped fix returns candidate-tree and fix-diff evidence. It cannot mint authority or start re-judgment itself.

## Lifecycle Boundary

Judgment Day is independent: it creates no delivery authority, enables no ordinary review, and changes no commit, push, PR, or release policy. A separately requested ordinary review remains an independent lifecycle and cannot consume a Judgment Day result as a receipt or authority. Ordinary repository policy owns delivery.

Dangerous-command safety remains independent and authoritative.

Judgment Day performs no commit, push, PR creation, release, publication, or version change.

## Output Contract

Return target, frozen finding IDs, fix rounds used, final verification evidence, skill resolution, and terminal judgment. Never claim actor output or a prose ledger is authoritative.

## References

- [references/prompts-and-formats.md](references/prompts-and-formats.md) — bounded judge, fix, and scoped re-judgment prompts.
