## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: pending.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Intended label `type:bug`; availability/application unverified. Draft/no-merge.

## Summary

Register private child tools only with enabled flag, explicit `bash_background` declaration and live owned IPC.
Reuse registry/tool machinery and child-session ownership; scratch-only output, `job_list`/`job_stop`, owned-job cleanup.
Review gates/cleanup first, then help/docs. Child early return and user-owned policy remain intact.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 3 / 3; `d5fbd6b4155a8755ed3c39aa8f5d2e5966d093a9` |
| Candidate diff lines | 310 historical; confirm after transplant |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-03-registration` |
| Base / starts at | `feat/2266-slice2-02-job-ipc` |
| Ends with | Live-child tool registration/completion and cleanup, not post-settlement support |
| Depends on | 02-job-ipc (URL pending); clean merge-tree preflight |
| Follow-up | Reviewed source-chain integration into tracker (URL pending); future Slice 3 |

```text
main (Gentleman-Programming/gentle-shell)
└── feat/2266-slice2-tracker
    └── feat/2266-slice2-01-dispatch
        └── feat/2266-slice2-02-job-ipc
            └── 📍 feat/2266-slice2-03-registration
```

Out of scope: monitor, nested delegation, Slice 3 drain/hold/timers/deadlines, post-settlement completion and automatic child-model delivery.
Functional post-yield acceptance belongs to Slice 3; tracker cannot merge until chain/review/bench/Slice 3 coordination resolves.
No size exception requested or approved.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/child-background-jobs.ts`, `extensions/gentle-agents.ts` | Child-private setup, ownership and lifecycle cleanup |
| `lib/agents-runner.ts`, `lib/background-jobs-tools.ts` | Scratch-failure capability removal and child-only help |
| `tests/child-background-jobs.test.ts`, `tests/agents-runner.test.ts` | Gates, completion and cleanup |
| `docs/delegated-verification.md`, `docs/readme-reference.md` | Capability and delivery limits |

## Test Plan

Current-base focused/typecheck pending after transplant; upstream runner/extension/tests changed. CI/packed install pending.
Old-base only: final 136/136, typecheck 0; public-API differentials matched without observable regression.
Historical live-child probes preserved exit 7, distinct stdout/stderr and one completion; not post-settlement proof.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; explained baseline environments, not current-base evidence.
Native review pending: original retained-selection mismatch yielded no lineage/approval; new candidate unreviewed.
Offline core-corpus bench not executed; tracker lists exact commands/default-off acceptance. Preserve both run exits.
No new scenarios, paid LLM bench or measurement claims; #2552 remains separate.

## Contributor Checklist

- [x] Immediate-parent boundary and explicit Slice 3 limits documented.
- [ ] Clean transplant, isolated diff, fresh verification and native review complete.
- [ ] Offline bench, packed install and target-policy required CI complete.
- [ ] Target issue approval and exactly one available `type:bug` label confirmed/applied.
