## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: https://github.com/rubenpenap/gentle-shell/pull/1.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Verified label: `type:bug` (exactly one `type:*` label). Upstream issue #2266 is approved. Draft/no-merge.

## Summary

Forward parent-resolved user policy at dispatch; delete stale disabled values.
The child does not resolve policy in its worktree. This unit alone provides no full background support.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 1 / 3; `1bd87f203fb03c91af687d494b06f120bc0fa930` |
| Candidate diff lines | 46 verified against immediate parent |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-01-dispatch` |
| Base / starts at | `feat/2266-slice2-tracker` coordination head |
| Ends with | Dispatch flag forwarding and stale removal |
| Depends on | [tracker #2575](https://github.com/Gentleman-Programming/gentle-shell/pull/2575); upstream test-fixture reconciliation completed |
| Follow-up | [fork #2](https://github.com/rubenpenap/gentle-shell/pull/2), then [fork #3](https://github.com/rubenpenap/gentle-shell/pull/3) |

```text
main (Gentleman-Programming/gentle-shell)
└── upstream #2575 · feat/2266-slice2-tracker
    └── 📍 fork #1 · feat/2266-slice2-01-dispatch
        └── fork #2 · feat/2266-slice2-02-job-ipc
            └── fork #3 · feat/2266-slice2-03-registration
```

Out of scope: job IPC, registration, monitor, nested delegation, Slice 3 drain/hold/timers and post-settlement delivery.
No automatic child-model delivery or size exception claimed.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/agents-runner.ts` | Resolve policy at dispatch and normalize flag |
| `tests/agents-runner.test.ts` | Enabled/off/stale-flag coverage |

## Test Plan

Current-base child 01 runner: **119/119 passed**. Upstream Windows TMP/TEMP fixtures and isolated policy config are preserved. Aggregate child 03 parent/independent focused checks: **140/140**, typecheck **0 diagnostics**; that aggregate is not a claim all tools exist in child 01.
Current-base full `pnpm test` exited **1 before any tests** with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` during an automatic dependency-install attempt. No retry/reinstall/CI override. Fresh current-base historical off-path differential remains unverified.
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
- [x] Upstream issue approval and exactly one `type:bug` label verified for this child PR.
