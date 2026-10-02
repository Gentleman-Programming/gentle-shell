# Agents view shortcut: Alt+J

## Objective and scope
Fix #1565 by moving default agents view from Alt+A to Alt+J, preserving prompt select-all, environment overrides, trimming, disabling and stop/collapse shortcuts. No installed-runtime/configuration changes.

- Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1565.
- Branch: fix/agents-view-alt-j; base: 4fcddc2fcf8c0909d1407b8441977ca38d5e0987 (main).
- Delivery strategy: ask-on-risk; forecast 60 authored lines, actual source/tests/docs 45 (38 added, 7 removed), plus tracking.
- Human authorized preparation and approval request. PR publication waits for status:approved.

## Tasks
- [ ] T1: Remap default agents view, test/document, verify, review and commit. Status: in_progress.
  - Route: gentle-ai-worker (multi-file); gentle-ai-verify (partial result and independent spot-check).
  - Acceptance observed: default Alt+J registration without Alt+A; overrides/trim/off/empty preserved; derived widget hints updated; Alt+A selection unchanged.
  - Commit: pending.
  - Native assessment: medium, large writer, reviewDue false (under_budget); candidate outcome unknown. Initial assessment was unassessable due untracked intended tracking file; parent staged all five paths, resolving that issue. Review preflight pending.

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

## Next step
Commit verified work unit, follow native review preflight for this candidate, record commit/review evidence, and await maintainer approval before publishing the PR.
