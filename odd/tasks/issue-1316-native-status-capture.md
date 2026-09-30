# Recover capture routes from current native STATUS (#1316)

Prepare the minimal single/group capture fix without treating volatile route metadata as provider authority. User authorized updating the feature branch, revalidation, commits, native review and PR creation; **merge and auto-merge are not authorized**.

## Scope and boundaries

- Approved issue: Gentleman-Programming/gentle-shell#1316; related cluster: gentle-ai#4498.
- Branch: `fix/1316-native-status-capture`, dedicated isolated worktree.
- Original base: `664bfdd295e3bd3b2f291344e77bda94f58d5931`.
- Current update target: `4b6b148b7dbd741b3097c00d5888f0209a567f94` (one unrelated upstream commit, including runtime-harness changes).
- PR #1542 remains draft diagnostics only; this fix does not claim to identify every reported miss branch.
- Allowed implementation: `extensions/gentle-ai.ts` and the native/host-relay routing tests. No telemetry, persistence, TTL, retries, flags or new native states.

Fresh Pi-bound STATUS must validate exact current-target lineage/target/binding before relay or capture. Recover committed selectors only from matching trusted routes/candidate projections. Preserve group order/completeness, stale/foreign/terminal rejection, forecast acknowledgement, no-replay rules, registration collisions and downstream selector continuity. Align binding publication and registration eligibility.

## Execution

| Setting | Value |
| --- | --- |
| Workflow | Delegated direct ODD; not SDD; one writer |
| TDD | Strict, explicitly selected by user; `node --experimental-strip-types --test` |
| RDD | Global on; candidate-native consent and acknowledgement remain separate |
| Delivery | One coherent work unit/PR; source/test diff 191 authored lines before upstream update, plus this record; below 400 |
| Memory | Local document authoritative; Engram mirror pending incompatible installed provider |

## Tasks

- [x] **T1 — Baseline/dependencies:** frozen install with scripts disabled; existing bounded tests 25/25, typecheck accepted 187 diagnostics with no regressions.
- [x] **T2 — Reproduce/repair:** initial three recovery regressions RED, then six GREEN. Stale STATUS-count expectation separately RED/GREEN; four exact STATUS requests and zero stale captures asserted. Source/test diff +176/-15.
- [ ] **T3 — Final candidate verification:** prior independent affected-file run 135/135 and named assertion 1/1; revalidation on updated base and native closure pending. No severe candidate-only trust defect found in prior readback.
- [x] **T4 — Classify original-base failures:** independent clean original base reproduced all other 18 failure signatures, same cancellation/timeout and empty-persona harness failure. This proves attribution at the original base, not a fresh full-suite pass at the new update target.
- [x] **T5 — Diagnose harness side effect:** extended fixture invoked existing dispatch hydration and created an owned view. Later exact view/marker/admin-dir/registration absence confirmed, no manual cleanup performed, removal actor unknown. No native lifecycle-authority mutation found in that hydration path.
- [x] **T6 — Update/revalidate against current main:** fast-forwarded only this feature branch to the pinned target; exact patch/task-record hashes preserved through path-limited stash restore, no conflicts, backup retained. Complete affected files 135/135; typecheck baseline187, modules8/8 and diff checks pass. Full suite was not rerun on this target.
- [ ] **T7 — Commit/review/PR** (in progress): coherent Conventional Commit; native assessment and provider-bound review/consent; acknowledge only exact approved continuation; publish only feature branch and open issue-linked PR with one `type:bug` label; report CI, never merge.

## Observed evidence before update

| Check | Outcome |
| --- | --- |
| Recovery RED/GREEN | Three initial failures on unchanged production; final six new tests pass |
| Stale request correction | Expected 3 versus observed 4 before correction; corrected exact vector passes, zero stale captures |
| Complete affected routing files | Independent 135/135, no failures/cancellations/skips; approximately 30.5 seconds |
| Typecheck | Exit 0 against accepted 187 diagnostics, 11 improved pairs; not diagnostic-free TS |
| Runtime-module/diff checks | Eight generated modules match; whitespace check passes |
| Full original candidate suite | Timeout 124 after 4088 tests: 4018 pass, 19 fail, 1 cancelled, 50 skipped; candidate-only count expectation corrected afterwards |
| Clean original base suite | Timeout 124 after 4082 tests: 4013 pass, 18 fail, 1 cancelled, 50 skipped; matching remaining signatures |
| Standalone original harness | Candidate and clean base both fail empty persona assertion; later full-suite phases remain unverified |
| Genuine Pi wiring | Runtime3 loaded registered tools through SDK loader/AgentSession and passed recovery/negative fixtures; fake STATUS, no native-provider E2E claim |

Operator logs retained outside the repository use prefixes `gentle-1316-independent-verify`, `gentle-1316-clean-base-` and `gentle-1316-final-recheck-`. Runtime3 log is evidence only: the temporary script was subsequently extended into failed runtime4 and must not be rerun against shared Git. Future dispatch-hydration experiments require an independent temporary Git common-directory.

## Next step and rollback

Updated feature branch and unchanged local patch revalidated at the pinned target. Create the coherent work-unit commit, assess its committed range, follow native consent/review and prepare the PR. Native assessment previously could not classify the untracked task record and selected the high-risk independent-verifier fallback; prior independent scoped checks passed, but no native review receipt has been claimed. Commit identity and final native/CI outcomes will be recorded after they are observed.

Rollback only this fix's coherent work-unit commit (source, tests and record); preserve unrelated authority and worktrees. No push to main, merge or auto-merge authorization exists.
