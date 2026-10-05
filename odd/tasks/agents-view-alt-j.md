# Agents view shortcut: Alt+J

## Objective and scope
Fix #1565 by moving default agents view from Alt+A to Alt+J, preserving prompt select-all, environment overrides, trimming, disabling and stop/collapse shortcuts. No installed-runtime/configuration changes.

- Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1565.
- Branch: fix/agents-view-alt-j; base: 4fcddc2fcf8c0909d1407b8441977ca38d5e0987 (main).
- Delivery strategy: ask-on-risk; forecast 60 authored lines, actual source/tests/docs 45 (38 added, 7 removed), plus tracking.
- Human authorized preparation and approval request. PR publication waits for status:approved.

## Tasks
- [x] T1: Remap default agents view, test/document, verify, review and commit. Status: done.
  - Route: gentle-ai-worker (multi-file); gentle-ai-verify (partial result and independent spot-check).
  - Acceptance observed: default Alt+J registration without Alt+A; overrides/trim/off/empty preserved; derived widget hints updated; Alt+A selection unchanged.
  - Work-unit commit: 6b5ace3fdbe63c1429b8ccb6f1ccdbdeb371b314, fix(agents): move default view shortcut to Alt+J (93 authored lines including tracking).
  - Native assessment: medium, large writer, reviewDue false (under_budget). Initial assessment was unassessable due untracked intended tracking file; parent staged all five paths, resolving that issue.
  - Native review: review-949baca5ecd983a1, consolidated review-reliability approved; exact acknowledgement completed, authority burned (gentle-ai.review-acknowledged/v1). No further lifecycle action pending.
- [ ] T2: Publish PR after maintainer approval and verified delivery destination. Status: partial; PR published, maintainer type:bug label still required.

## Verification evidence
- Writer muqzzij3-5-1mnr: RED three expected default failures before source change; GREEN 501 focused tests.
- Independent verifier mur05e3a-6-eh2f: 501 focused tests passed again.
- Initial pnpm test: 4545 passed, one failed, 34 skipped; failed dev-binary announcement test at tests/gentle-ai-dev-binary-surfacing.test.ts:189.
- Follow-up mur096ip-7-rkb6: direct Node on current/base both failed identically (6 passed, 1 failed) with inherited GENTLE_PI_AGENTS_CHILD=1; both passed 7/7 with only that process-local flag unset. Failure is pre-existing environment/test isolation, not caused by this change. No test-source fix or installation performed.
- env -u GENTLE_PI_AGENTS_CHILD pnpm test: PASS, 4546 passed, 0 failed, 34 skipped; provider contract and runtime harness PASS.
- pnpm run typecheck: PASS, 187 baseline diagnostics, no regressions.
- pnpm run check:runtime-modules: PASS.
- node scripts/verify-package-files.mjs: PASS.
- pnpm run test:packed-package: PASS.
- git diff --check: PASS.
- Physical terminal testing: unavailable/skipped.
- Parent staged intended paths during verification; index change was expected and parent-owned.

## Publication
- Issue has status:needs-review; actor viewerPermission READ, cannot self-approve.
- Approval request privacy-scanned and readback confirmed: https://github.com/Gentleman-Programming/gentle-shell/issues/1565#issuecomment-5953405443.
- No duplicate issue, push or PR created. No repository PR template found.

## Prepared PR summary
Title: fix(agents): move default view shortcut to Alt+J
Reference: Fixes #1565
Type: Bug fix (type:bug)

- Move default Agents view to Alt+J to avoid prompt select-all interception.
- Preserve Alt+A selection and explicit shortcut overrides; update hints and docs.
- Add default-registration and override/disabling regressions.
- Verification: focused 501/501 twice; process-isolated full suite 4546 passed, 34 skipped; typecheck, runtime modules, package files and packed-package checks passed. Physical terminal check not performed. Document pre-existing child-environment failure above.

## Main integration verification
- User request: "deberiamos verificarlo nuevamente ya que actualizamos a main?"; authorization: "si dale" to integrate and verify without publication.
- Integrated main 794cb93a with a non-rewriting merge; no conflicts.
- Focused tests: 528 passed, 0 failed, 0 skipped.
- env -u GENTLE_PI_AGENTS_CHILD pnpm test: 4882 passed, 0 failed, 34 skipped; provider-contract and runtime-harness passed.
- Integration commit: b82b94526c926bdde02625365846c84275a2518d.
- Independent verifier muuec3ga-1-v1bw passed 528 focused tests and git diff --check main...HEAD, confirming default, overrides, selection and hints.
- Updated native review review-13b5f9aacf3d7cf2 approved with review-reliability; exact acknowledgement completed and authority burned (gentle-ai.review-acknowledged/v1). Previous native approval remains historical only.
- Physical terminal testing and updated typecheck/package checks not performed in this integration pass.

## Publication outcome
- Issue #1565 status:approved confirmed.
- Authorized fork MarsSall/gentle-pi verified as a fork of Gentleman-Programming/gentle-shell, actor ADMIN on fork.
- Non-force push succeeded; origin points to that fork. Documentation-only review evidence commit: 12b4df24.
- PR https://github.com/Gentleman-Programming/gentle-shell/pull/1797 OPEN; title, body, main base and MarsSall:fix/agents-view-alt-j head confirmed by readback.
- Creation succeeded, but adding type:bug failed due upstream permissions. PR has no labels. No create retry or label retry attempted.
- GitHub checks queued/in progress; physical keyboard verification outstanding.

## CodeRabbit follow-up
- User authorized correcting applicable feedback, then explicitly authorized commit and push.
- Added empty/nonempty draft tests through real GentlePromptEditor, registered Agents callback and real overlay; host key matching is simulated at the public editor seam, not production InteractiveMode wiring.
- Both regressions fail with the historical Alt+A default and pass with Alt+J. Alt+A select-all, draft preservation and overlay opening are asserted.
- Added agentsViewKey JSDoc explaining default, explicit overrides and disabling.
- Focused tests: 474 passed. Full suite: 4884 passed, 0 failed, 34 skipped; provider-contract and runtime-harness passed. git diff --check passed.
- Native review review-92a3457356fd8d94 approved and acknowledged; authority burned (gentle-ai.review-acknowledged/v1).
- Previous published-head CI passed; new-head CI and CodeRabbit readback remain pending. Physical keyboard and updated typecheck/package checks were not performed.

## Next step
Maintainer must add type:bug to PR #1797. Await new-head CI and review; do not merge or claim merge-ready.
