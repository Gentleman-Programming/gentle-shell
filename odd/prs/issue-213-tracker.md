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
Draft/no-merge integration tracker for the authorized feature-branch chain. This branch currently contains the publication plan only. Review and integrate children in order; do not merge this tracker until integration and required checks are complete.

## Changes
| Path | Change |
| --- | --- |
| `odd/tasks/status-timing-publication.md` | Scope, evidence, work units and chain plan |

## Test plan
The plan was checked with `git diff --cached --check`. No source behavior changes in this tracker yet. The diagnostic child has 64/64 focused checks and independent 2/2 PASS; the fixture child has 4/4 focal and 219/219 regression PASS, independently repeated. Typecheck: 186 baseline diagnostics, no regressions. These are scoped results, not full-suite acceptance.

## Contributor checklist
- [x] Approved issue linked with the human-selected nonclosing reference
- [x] Conventional work-unit commits; tests/docs remain with behavior
- [x] Incident data excluded from commits
- [ ] Children integrated and required CI green
- [ ] Final integration verified against current main

## Chain Context
- Chain: issue-213-status-timing / feature-branch-chain
- Position: draft tracker/final integration
- Base: `main`
- Starts at: validated baseline `9808b6ef`
- Ends with: reviewed diagnostics and portable test fixtures after child integration
- Review budget: initial tracker 25 changed lines / 400; diagnostic child is necessarily oversized with tests/docs/runtime kept together
- Excludes: native authority recovery fixes, automatic STATUS/retries, global-suite fixes and merge

### Chain Overview
```text
main
 └── 📍 feat/213-status-timing (draft tracker)
      └── feat/213-status-timing-diagnostics
           └── test/213-windows-fixtures
```

## Published children
1. https://github.com/Gentleman-Programming/gentle-shell/pull/1951 — diagnostics -> tracker.
2. https://github.com/Gentleman-Programming/gentle-shell/pull/1953 — fixtures -> diagnostics.

Review/integrate children in order. The tracker remains draft/no-merge.
