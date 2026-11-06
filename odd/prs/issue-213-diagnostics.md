## Linked issue
Refs #213 — approved issue. This does not close it or claim the initiating timeout is fixed.

## Verification limits
- Full-suite validation was explicitly deferred after the earlier run was interrupted; its nontermination cause remains unknown. The provider-contract/runtime-harness stages did not complete in that invocation.
- POSIX execution was unavailable on the Windows host; POSIX branches were inspected, not executed.
- Native assessment was unavailable due to undeclared untracked scope. No native review approval is claimed and no real STATUS/retry was run for publication.
- Source verification used baseline `9808b6ef`, an ancestor 52 commits behind main at publication. Upstream integration and CI are not certified green.
- The tracker stays draft/no-merge. No protected size-exception label is requested.

## PR type
- [x] New feature (`type:feature`)

## Summary
- Add one-shot, session-only `/gentle:status-timing enable|disable|show`, off by default, with bounded memory-only monotonic summaries.
- Observe the next authorized STATUS-bearing call, including the public plain facade, without changing deadlines, argv/protocol, authority, consent, elapsed ledger or results/errors.
- Keep source, generated runtime, package inventory, tests and docs together.

## Changes
| Paths | Change |
| --- | --- |
| `lib/status-timing-diagnostics.ts`, `runtime/status-timing-diagnostics.mjs` | Bounded observation and lifecycle clearing |
| `lib/native-review-cli.ts`, `runtime/native-review-cli.mjs` | Resolution/adapter observation, including plain STATUS |
| `extensions/gentle-ai.ts`, `lib/review-sidebar-state.ts` | Session command and host/sidebar stages |
| `scripts/build-runtime-modules.mjs`, `scripts/verify-package-files.mjs` | Generation and resource inventory |
| `tests/status-timing-diagnostics.test.ts`, `tests/verify-package-files.test.ts` | Regression coverage |
| `README.md`, `docs/readme-reference.md` | Command documentation and limitations |
| `odd/tasks/status-timing-publication.md` | Publication evidence |

## Test plan
- Prior focused timing checks: **64/64 PASS**; independent limited reverification **2/2 PASS**; runtime parity and whitespace clean.
- `node scripts/check-types.mjs`: **186 baseline diagnostics, no regressions**.
- `git diff --check`, commit-time `git diff --cached --check`: PASS.
- Shellcheck/skills: not applicable (no shell scripts or skills changed).
- No real STATUS, timeout reproduction or full-suite rerun performed.

## Contributor checklist
- [x] Approved issue linked with human-selected `Refs #213`
- [x] Conventional work-unit commit with tests/docs/runtime
- [x] No incident data committed or automatic STATUS/retry
- [ ] Required CI and current-main integration verified

## Chain Context
| Field | Value |
| --- | --- |
| Tracker PR | https://github.com/Gentleman-Programming/gentle-shell/pull/1950 |
| Position | 1 of 2 children |
| Base | `feat/213-status-timing` |
| Depends on | Draft tracker |
| Follow-up | `test/213-windows-fixtures` |
| Review budget | 826 changed lines / 400; 238 generated runtime lines |
| Starts at | Tracker `c5eebb85`, validated original baseline |
| Ends with | Diagnostics, tests, runtime and docs |
| Excludes | Windows fixtures, native recovery and global-suite fixes |

One bounded slicing pass keeps this cohesive diagnostic unit together; it remains oversized even excluding generated runtime. No tests/docs omitted or compressed, and no protected exception approval claimed.

### Chain Overview
```text
main
 └── feat/213-status-timing (draft tracker)
      └── 📍 feat/213-status-timing-diagnostics
           └── test/213-windows-fixtures
```
