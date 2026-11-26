## Linked Issue

Refs #2266. Keep open for Slice 3. PR URL: https://github.com/Gentleman-Programming/gentle-shell/pull/2575.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Issue #2266 is `status:approved`. Intended label: `type:bug` (available upstream); a maintainer must apply it because this contributor has READ permission upstream.

## Summary

- Coordination-only tracker until reviewed children integrate; no source tools are in this initial head.
- All four PRs remain draft/no-merge. Source chain, review, bench and Slice 3 coordination must resolve before tracker merge.
- Publication is authorized through the contributor fork; no merge is authorized. Source PRs target immediate parent branches in that fork.

## Chain Context

| Position | Source unit | Candidate diff lines | PR URL |
|---|---|---:|---|
| Tracker | Coordination docs only | 298 at initial publication | https://github.com/Gentleman-Programming/gentle-shell/pull/2575 |
| 1 / 3 dispatch | `1bd87f203` | 46 verified | https://github.com/rubenpenap/gentle-shell/pull/1 |
| 2 / 3 job IPC | `73cc0e8ff` | 194 verified | https://github.com/rubenpenap/gentle-shell/pull/2 |
| 3 / 3 registration | `223ed83e7` | 310 verified | https://github.com/rubenpenap/gentle-shell/pull/3 |

```text
main (Gentleman-Programming/gentle-shell)
└── 📍 upstream #2575 · feat/2266-slice2-tracker
    └── fork #1 · feat/2266-slice2-01-dispatch
        └── fork #2 · feat/2266-slice2-02-job-ipc
            └── fork #3 · feat/2266-slice2-03-registration
```

Starts at verified main `cb0c5a2e548e278bd65fc503552b10862c4efa11`.
Target: `Gentleman-Programming/gentle-shell`, base `main`, head `rubenpenap:feat/2266-slice2-tracker`.
Ends with coordination now; eventual source integration requires separate gate resolution.
Source transplant and bounded test-fixture reconciliation are complete; depends on all child reviews. Follow-up: children 1–3 then Slice 3 coordination.
Out of scope: drain/hold/timers, post-settlement completion, automatic child-model delivery and #2552 fixes.
No size exception is requested or approved; source counts exclude coordination docs and need current-base confirmation.

## Changes Table

| Surface | Change |
|---|---|
| `odd/tasks/2266-slice2-tracker.md`, `odd/pr/2266-slice2-chain/` | Coordination and draft bodies only |

## Test Plan

Current upstream-base aggregate (child 03): parent and independent focused checks **140/140 passed**, typecheck **0 diagnostics**. Child 01 runner **119/119**; child 02 runner/messaging **127/127**. Parent topology and isolated **46/194/310**-line diffs verified.
Current-base `pnpm test` exited **1 before executing tests**: `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` during an automatic dependency-install attempt. No reinstall, retry, CI override or substitute full-suite run. A fresh current-base off-path historical differential remains unverified. CI/packed install: pending.
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
