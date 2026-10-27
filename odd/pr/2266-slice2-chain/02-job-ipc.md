## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: pending.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Intended label `type:bug`; availability/application unverified. Draft/no-merge.

## Summary

Add strict acknowledged job frames with exact keys, phase validation and bounded output.
Review parser validation before runner admission/NOTE-before-ACK handling.
Dispatch plus IPC alone provides no full child background support.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 2 / 3; `88736250b6c6ba3ad519572319bf87799ba0aed5` |
| Candidate diff lines | 198 historical; confirm after transplant |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-02-job-ipc` |
| Base / starts at | `feat/2266-slice2-01-dispatch` |
| Ends with | Validated job evidence and notification-style ACK handling |
| Depends on | 01-dispatch (URL pending); clean merge-tree preflight |
| Follow-up | 03-registration (URL pending); tracker URL pending |

```text
main (Gentleman-Programming/gentle-shell)
└── feat/2266-slice2-tracker
    └── feat/2266-slice2-01-dispatch
        └── 📍 feat/2266-slice2-02-job-ipc
            └── feat/2266-slice2-03-registration
```

Out of scope: tool registration, monitor, nested delegation, Slice 3 drain/hold/timers and post-settlement delivery.
No automatic child-model delivery or size exception claimed.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/agents-messaging.ts`, `tests/agents-messaging.test.ts` | Strict pending/settled/drained frames and parser tests |
| `lib/agents-runner.ts`, `tests/agents-runner.test.ts` | Authorized evidence, settled NOTE before ACK, bounded duplicate retention |

## Test Plan

Current-base focused/typecheck pending after transplant; upstream runner/extension/tests changed.
Historical only: unit messaging+runner 123/123; final aggregate 136/136, typecheck 0; legacy notification/query differential matched.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; baseline environmental diagnosis is not current-base proof.
Original native retained-selection mismatch created no lineage/approval; current candidate unreviewed.
CI/packed install pending. Offline core-corpus bench not executed; tracker contains exact commands/default-off acceptance.
Preserve both run exits; no new scenarios, paid LLM bench or measurement claims.

## Contributor Checklist

- [x] Immediate-parent boundary and fork-qualified issue reference documented.
- [ ] Clean transplant and isolated candidate diff verified.
- [ ] Fresh checks, native review, bench, packed install and target-policy required CI complete.
- [ ] Target issue approval and exactly one available `type:bug` label confirmed/applied.
