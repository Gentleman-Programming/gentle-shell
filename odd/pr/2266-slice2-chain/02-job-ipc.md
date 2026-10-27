## Linked Issue

Refs Gentleman-Programming/gentle-shell#2266. PR URL: https://github.com/rubenpenap/gentle-shell/pull/2.
No repository PR template is present; approved mechanical fallback used.

## PR Type

- [x] Bug fix

Verified label: `type:bug` (exactly one `type:*` label). Upstream issue #2266 is approved. Draft/no-merge.

## Summary

Add strict acknowledged job frames with exact keys, phase validation and bounded output.
Review parser validation before runner admission/NOTE-before-ACK handling.
Dispatch plus IPC alone provides no full child background support.

## Chain Context

| Field | Value |
|---|---|
| Position / source unit | 2 / 3; `73cc0e8ff08ef7a2915b323fa80d6ee43487d115` |
| Candidate diff lines | 194 verified against immediate parent |
| Target repository | `rubenpenap/gentle-shell` |
| Head | `feat/2266-slice2-02-job-ipc` |
| Base / starts at | `feat/2266-slice2-01-dispatch` |
| Ends with | Validated job evidence and notification-style ACK handling |
| Depends on | [fork #1](https://github.com/rubenpenap/gentle-shell/pull/1); upstream harness options preserved during reconciliation |
| Follow-up | [fork #3](https://github.com/rubenpenap/gentle-shell/pull/3); [tracker #2575](https://github.com/Gentleman-Programming/gentle-shell/pull/2575) |

```text
main (Gentleman-Programming/gentle-shell)
└── upstream #2575 · feat/2266-slice2-tracker
    └── fork #1 · feat/2266-slice2-01-dispatch
        └── 📍 fork #2 · feat/2266-slice2-02-job-ipc
            └── fork #3 · feat/2266-slice2-03-registration
```

Out of scope: tool registration, monitor, nested delegation, Slice 3 drain/hold/timers and post-settlement delivery.
No automatic child-model delivery or size exception claimed.

## Changes Table

| File | Intended transplanted change |
|---|---|
| `lib/agents-messaging.ts`, `tests/agents-messaging.test.ts` | Strict pending/settled/drained frames and parser tests |
| `lib/agents-runner.ts`, `tests/agents-runner.test.ts` | Authorized evidence, settled NOTE before ACK, bounded duplicate retention |

## Test Plan

Current-base child 02 runner/messaging: **127/127 passed**. Upstream cleanup/exit-on-stdin-end fixture options and the query hook are preserved. Aggregate child 03 parent/independent focused checks: **140/140**, typecheck **0 diagnostics**; child 02 itself does not register job tools.
Current-base full `pnpm test` exited **1 before any tests** with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` during an automatic dependency-install attempt. No retry/reinstall/CI override. Fresh current-base historical off-path differential remains unverified.
Historical only: unit messaging+runner 123/123; final aggregate 136/136, typecheck 0; legacy notification/query differential matched.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; baseline environmental diagnosis is not current-base proof.
Original native retained-selection mismatch created no lineage/approval; current candidate unreviewed.
CI/packed install pending. Offline core-corpus bench not executed; tracker contains exact commands/default-off acceptance.
Preserve both run exits; no new scenarios, paid LLM bench or measurement claims.

## Contributor Checklist

- [x] Immediate-parent boundary and fork-qualified issue reference documented.
- [ ] Clean transplant and isolated candidate diff verified.
- [ ] Fresh checks, native review, bench, packed install and target-policy required CI complete.
- [x] Upstream issue approval and exactly one `type:bug` label verified for this child PR.
