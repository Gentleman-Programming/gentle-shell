## Linked Issue

Refs #2266. Keep open for Slice 3. PR URL: pending.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Intended label: `type:bug`; availability/application for publication unverified.

## Summary

- Coordination-only tracker until reviewed children integrate; no source tools are in this initial head.
- All four PRs remain draft/no-merge. Source chain, review, bench and Slice 3 coordination must resolve before tracker merge.
- Parent owns publication; this body is preparation, not evidence of remote creation.

## Chain Context

| Position | Source unit | Candidate diff lines | PR URL |
|---|---|---:|---|
| Tracker | Coordination docs only | Pending final diff count | pending |
| 1 / 3 dispatch | `671362918` | 42 historical | pending |
| 2 / 3 job IPC | `88736250b` | 198 historical | pending |
| 3 / 3 registration | `d5fbd6b41` | 310 historical | pending |

```text
main (Gentleman-Programming/gentle-shell)
└── 📍 feat/2266-slice2-tracker
    └── feat/2266-slice2-01-dispatch
        └── feat/2266-slice2-02-job-ipc
            └── feat/2266-slice2-03-registration
```

Starts at verified main `cb0c5a2e548e278bd65fc503552b10862c4efa11`.
Target: `Gentleman-Programming/gentle-shell`, base `main`, head `rubenpenap:feat/2266-slice2-tracker`.
Ends with coordination now; eventual source integration requires separate gate resolution.
Depends on clean transplant/preflight and all child reviews; follow-up: children 1–3 then Slice 3 coordination.
Out of scope: drain/hold/timers, post-settlement completion, automatic child-model delivery and #2552 fixes.
No size exception is requested or approved; source counts exclude coordination docs and need current-base confirmation.

## Changes Table

| Surface | Change |
|---|---|
| `odd/tasks/2266-slice2-tracker.md`, `odd/pr/2266-slice2-chain/` | Coordination and draft bodies only |

## Test Plan

Current-base focused/typecheck: **pending** after transplant; CI/packed install: pending.
Historical old-base only: focused 136/136, typecheck 0, differentials without observable regression.
Old full suite: 7,385 total, 7,290 passed, 22 failed, 73 skipped; baseline environmental failures diagnosed, not a current-base pass.
Native review unavailable on original retained-selection mismatch; no lineage/approval. New candidates unreviewed.
Bench per decode2 comment6424231029: deterministic offline core corpus, no new scenarios, not executed:

```text
gentle-ai-bench run --binary <main-build> --out before.json
gentle-ai-bench run --binary <candidate-build-with-your-slice-2> --out after.json
gentle-ai-bench compare --before before.json --after after.json
```

Preserve both run exits. Default policy off: no journey status flip; friction within baseline noise.
No paid LLM bench or measured cost/performance claim. Functional post-yield acceptance belongs to future Slice 3.

## Contributor Checklist

- [x] Nonclosing reference and chain boundaries documented.
- [ ] Issue approval and exactly one available `type:bug` label confirmed/applied for publication.
- [ ] Children integrated; fresh verification, native review, offline bench, packed install and required CI complete.
- [ ] Slice 3 coordination resolved before tracker merge; no merge authorization implied.
