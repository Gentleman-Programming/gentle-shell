## Linked issue
Refs #213 — approved issue. This does not close it or claim the initiating timeout is fixed.

## Verification limits
- Full-suite validation was explicitly deferred after the earlier run was interrupted; its nontermination cause remains unknown. The provider-contract/runtime-harness stages did not complete in that invocation.
- POSIX execution was unavailable on the Windows host; POSIX branches were inspected, not executed.
- Native assessment was unavailable due to undeclared untracked scope. No native review approval is claimed and no real STATUS/retry was run for publication.
- Source verification used baseline `9808b6ef`, an ancestor 52 commits behind main at publication. Upstream integration and CI are not certified green.
- The tracker stays draft/no-merge. No protected size-exception label is requested.

## PR type
- [x] Maintenance/tooling (`type:chore`)

## Summary
- Deterministic EACCES preference fixture asserts refusal, zero writes and unchanged bytes; restores filesystem mocks and builtin ESM exports.
- Windows `pi.cmd` PATH fixture retains POSIX shebang behavior and isolated `ComSpec`/`SystemRoot`.
- Exactly nine path fixtures use OS-correct absolute resolution without weakened assertions. No production changes in this child.

## Changes
| Path | Change |
| --- | --- |
| `tests/card-style-policy.test.ts` | EACCES fixture; only physical chmod probe is POSIX-specific |
| `tests/gentle-shell-bin.test.ts` | Platform PATH executable and environment |
| `tests/gentle-shell-launcher.test.ts` | Nine absolute-path fixtures |
| `odd/tasks/status-timing-publication.md` | Publication evidence |

## Test plan
- RED focal: 1 PASS / 3 FAIL; later scoped regression: 210 PASS / 9 FAIL.
- `node --experimental-strip-types --test --test-name-pattern="denied preference read|invalid or unreadable preference files|a genuinely absent adjacent peer|malformed adjacent metadata" tests/card-style-policy.test.ts tests/gentle-shell-bin.test.ts`: **4/4 PASS**, no skips.
- `node --experimental-strip-types --test tests/card-style-policy.test.ts tests/gentle-shell-launcher.test.ts`: **219/219 PASS**, no skips.
- Independent verifier repeated both commands: **PASS**, no candidate-caused blocker.
- `node scripts/check-types.mjs`: 186 baseline diagnostics, no regressions.
- `git diff --check`: PASS. POSIX inspected, not executed.
- Shellcheck/skills: not applicable (test-only changes).

## Contributor checklist
- [x] Approved issue linked with `Refs #213`
- [x] Conventional commit and semantic assertions retained
- [x] Scoped own checks and independent verification PASS
- [x] No production or incident-data changes
- [ ] Required CI and current-main integration verified

## Chain Context
| Field | Value |
| --- | --- |
| Tracker PR | https://github.com/Gentleman-Programming/gentle-shell/pull/1950 |
| Position | 2 of 2 children |
| Base | `feat/213-status-timing-diagnostics` |
| Depends on | https://github.com/Gentleman-Programming/gentle-shell/pull/1951 |
| Follow-up | Integrate children in order; tracker stays draft |
| Review budget | 82 fixture lines plus bounded publication metadata / 400 |
| Starts at | Diagnostics `69932a04` |
| Ends with | Portable Windows fixtures |
| Excludes | Further fixture expansion, historical hang diagnosis, global-suite fixes |

### Chain Overview
```text
main
 └── feat/213-status-timing (draft tracker)
      └── feat/213-status-timing-diagnostics
           └── 📍 test/213-windows-fixtures
```
