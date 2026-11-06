# Issue 2020 review follow-up
Objective: add visibility-boundary coverage and separate Windows owner identity from PR #2068.
Branch: dnlrsls/issue-2020-subagent-git-overhead; delivery: separate focused PRs, no force-push or merge; runner: node --experimental-strip-types --test.

## Specs
S1. User: "sip", accepting "agregar ese test y separar Windows antes del merge". Add the accepted nine-distinct-task-path visibility test: move the ninth path into view, out of view, and back; assert resolver calls and unknown-result caching while visible.
S2. User: "sip", accepting "agregar ese test y separar Windows antes del merge". Limit PR #2068 to issue #2020's repository-fact cache; preserve the Windows work for a separate relevant issue and PR.

## Tasks
T1 | S1 | inline | done | commit ecebf79de | Coverage test and existing reorder regression passed 2/2; typecheck reported 0 diagnostics; diff check clean. Existing production eviction implements the rule, so no production RED was invented.
T2 | S2 | inline | in_progress | commit pending | Windows revert staged; owner source byte-equivalent to original baseline. Existing retry tests 7/7 pass, typecheck 0 diagnostics; native assessment medium, reviewDue=false. Commit, update description and publish cache-only scope next; do not rewrite history.
T3 | S2 | inline | pending | commit pending | Preserve Windows as an independent same-clone worktree/branch; create relevant issue and request exact issue approval before its PR. Observe checks and report any missing authorization/proof.

## Log
L1. User original request: "sip".
L2. Accepted parent recommendation: "Recomiendo **agregar ese test y separar Windows antes del merge**. No hice cambios."
L3. Existing commits: cache 913c740381405dccaaaef3d6c2cb43ec7a6f75ea; Windows 1efccb5a01445d84ca554e0dea9f733362c4a8c8. PR #2068 currently contains both; nine CI checks passed, but CodeRabbit flagged visibility coverage and Windows scope. Native approval applies only to the original unchanged target, not future edits. Local full-suite/cache/catalog limitations remain recorded.
L4. Forecast: approximately 240 authored source/test diff lines plus task notes across work-unit commits, under the 400-line delivery heuristic. Windows separation uses independent default-base work, not stacked dependency. No docstring expansion or unrelated production fix is authorized.
L5. Job25: selected first-eight visibility test and prior reorder regression passed 2/2 (no skips); typecheck 0 recorded diagnostics/no regressions; diff check clean. Exact resolver trace proves only the newly visible/evicted path resolves at each transition and the continuously visible unknown resolves once.
L6. Job27: Windows owner source matches baseline 2d7ab4 exactly after revert; retry tests 7/7 pass, typecheck 0 diagnostics, staged diff clean. Native current-change assessment: medium, 3 paths/184 diff lines, large runtime writer, reviewDue=false under_budget; own verification stands, no separate verifier required. This is not native approval of the changed target.
