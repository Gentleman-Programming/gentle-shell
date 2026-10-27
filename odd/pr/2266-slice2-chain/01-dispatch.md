## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: pending.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Intended label `type:bug`; availability/application unverified. Draft/no-merge.

## Summary

Forward parent-resolved user policy at dispatch; delete stale disabled values.
The child does not resolve policy in its worktree. This unit alone provides no full background support.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 1 / 3; `671362918e1597188377c4163a6ae59388cf93b7` |
| Candidate diff lines | 42 historical; confirm after transplant |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-01-dispatch` |
| Base / starts at | `feat/2266-slice2-tracker` coordination head |
| Ends with | Dispatch flag forwarding and stale removal |
| Depends on | Tracker (URL pending); clean merge-tree preflight |
| Follow-up | 02-job-ipc (URL pending), then 03-registration |

```text
main (Gentleman-Programming/gentle-shell)
└── feat/2266-slice2-tracker
    └── 📍 feat/2266-slice2-01-dispatch
        └── feat/2266-slice2-02-job-ipc
            └── feat/2266-slice2-03-registration
```

Out of scope: job IPC, registration, monitor, nested delegation, Slice 3 drain/hold/timers and post-settlement delivery.
No automatic child-model delivery or size exception claimed.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/agents-runner.ts` | Resolve policy at dispatch and normalize flag |
| `tests/agents-runner.test.ts` | Enabled/off/stale-flag coverage |

## Test Plan

Transplant/current-base focused tests and typecheck pending; upstream runner/extension/tests changed.
Old-base aggregate only: 136/136 focused, typecheck 0, compatibility differentials matched.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; diagnosed baseline environments, not new-base evidence.
Native review pending/unavailable: original retained-selection mismatch produced no lineage/approval; new candidate unreviewed.
CI/packed install pending. Offline core-corpus bench not executed; exact commands and default-off acceptance are in tracker body.
Preserve both bench run exits; no new scenarios, paid LLM probes or measurement claims.
Functional post-yield acceptance is future Slice 3, not this child.

## Contributor Checklist

- [x] Immediate-parent destination and nonclosing fork-qualified reference documented.
- [ ] Clean transplant and isolated candidate diff verified.
- [ ] Current verification, native review, bench and required CI/packed install complete.
- [ ] Target issue approval and exactly one available `type:bug` label confirmed/applied.
