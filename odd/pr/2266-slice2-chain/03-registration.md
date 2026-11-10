## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: https://github.com/rubenpenap/gentle-shell/pull/3.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Verified label: `type:bug` (exactly one `type:*` label). Upstream issue #2266 is approved. Draft/no-merge.

## Summary

Register private child tools only with enabled flag, explicit `bash_background` declaration and live owned IPC.
Reuse registry/tool machinery and child-session ownership; scratch-only output, `job_list`/`job_stop`, owned-job cleanup.
Review gates/cleanup first, then help/docs. Child early return and user-owned policy remain intact.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 3 / 3; `223ed83e7fc7c9bb81b99a9cef87deb75fd54f55` |
| Candidate diff lines | 310 verified against immediate parent |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-03-registration` |
| Base / starts at | `feat/2266-slice2-02-job-ipc` |
| Ends with | Live-child tool registration/completion and cleanup, not post-settlement support |
| Depends on | [fork #2](https://github.com/rubenpenap/gentle-shell/pull/2); clean merge-tree preflight |
| Follow-up | Reviewed source-chain integration into [tracker #2575](https://github.com/Gentleman-Programming/gentle-shell/pull/2575); future Slice 3 |

```text
main (Gentleman-Programming/gentle-shell)
└── upstream #2575 · feat/2266-slice2-tracker
    └── fork #1 · feat/2266-slice2-01-dispatch
        └── fork #2 · feat/2266-slice2-02-job-ipc
            └── 📍 fork #3 · feat/2266-slice2-03-registration
```

Out of scope: monitor, nested delegation, Slice 3 drain/hold/timers/deadlines, post-settlement completion and automatic child-model delivery.
Functional post-yield acceptance belongs to Slice 3; tracker cannot merge until chain/review/bench/Slice 3 coordination resolves.
No size exception requested or approved.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/child-background-jobs.ts`, `extensions/gentle-agents.ts` | Child-private setup, ownership and lifecycle cleanup |
| `lib/agents-runner.ts`, `lib/background-jobs-tools.ts` | Scratch-failure capability removal and child-only help |
| `tests/child-background-jobs.test.ts` | Gates, completion and cleanup; existing runner tests remain inherited from earlier units |
| `docs/delegated-verification.md`, `docs/readme-reference.md` | Capability and delivery limits |

## Test Plan

Current-base child 03 parent and independent focused checks: **140/140 passed**, typecheck **0 diagnostics**. Exact parent topology and isolated diff verified; independent public probes preserved exit 7, both markers, one completion, private scratch, ownership, shared ACK sequence and abort-once cleanup.
Current-base full `pnpm test` exited **1 before any tests** with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` during an automatic dependency-install attempt. No retry/reinstall/CI override. Fresh current-base historical off-path differential remains unverified. CI/packed install pending.
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
- [x] Upstream issue approval and exactly one `type:bug` label verified for this child PR.
