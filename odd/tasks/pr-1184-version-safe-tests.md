# PR #1184: Version-safe Windows publication retry tests

## Objective
Update and publish the existing PR's test fixtures so its Windows retry coverage remains valid after integration with current upstream main.

## Problem and rationale
PR head `b9651c55c8126587578d10c606cb2f3a0d1278be` adds tests coupled to Gentle AI 3.1.0, while upstream main pins 4.0.0. Conflict-free Git integration does not reconcile failure-hook destinations, manifests, module paths, or cleanup-prefix assertions. CI run 35337767970 ended `action_required` with zero jobs; CodeRabbit success is not functional verification.

## Authorization and constraints
- User selected prepare, test, and publish to existing PR #1184.
- No PR merge, force push, external workflow approval, or unrelated source changes.
- Use the isolated same-clone Orca worktree; preserve the dirty parent checkout.
- Existing PR target: `mvanhorn/gentle-shell`, branch `fix/946-windows-bundle-publication-retry`, original head above. Recheck before publishing and require an additive fast-forward.
- One writer at a time. Native review only under the user-owned switch; functional checks remain required.

## Scope
- Authoritative installer constants and their use by the added retry tests in `tests/gentle-ai-installer.test.ts`.
- Integrate upstream main into this PR branch additively, never reverting its current installer pin or unrelated changes.
- No change to retry behavior except conflict reconciliation preserving both approved histories. Escalate unexpected conflicts.
- This task document records progress and verification.

## Task checklist
- [ ] T1: Deliver version-independent publication retry tests, verified on the integrated branch, in one Conventional Commit work unit, then publish additively to the existing PR.
  - Prepare current-main integration and observe meaningful failing focused tests (RED), or record why execution is unavailable.
  - Derive versions, tags, module/package identifiers, directories, and cleanup prefixes from authoritative installer exports.
  - Observe GREEN for focused installer coverage; run applicable structural/full checks in isolation with bounded commands.
  - Review the exact candidate according to the native switch and record any unavailable/skipped checks.
  - Commit identity and verified publication evidence must be recorded below.

## Acceptance criteria
- New injected rename failures target the actual live-version directory.
- Expected source manifests match authoritative version/module/tag exports.
- Cleanup assertions inspect the real version's staging, backup, and install artifacts.
- Existing Windows retry, exhaustion, rollback, valid-backup recovery, and non-Windows behavior remain covered.
- No pin downgrade, swallowed errors, new dependencies, unrelated edits, or destructive Git operations.
- Publish only after required checks and authority outcomes are known; fail closed on uncertain push results.

## Verification plan
- Focused: `node --experimental-strip-types --test tests/gentle-ai-installer.test.ts` (bounded timeout).
- Structural: `git diff --check`; generated runtime consistency when applicable.
- Broader checks: inspect the integrated repository runner and avoid installation/native builds or unbounded process spawning; report unavailable prerequisites rather than substitute unrelated environments.
- Test-first applies: integration exposes the stale fixture bug; observe failure before edits, then fix and rerun.
- Runtime harness: assess applicability for this test-only change; no production runtime change intended.

## Progress and evidence
- Isolated worktree: `C:/Users/Blackie/orca/workspaces/main/pr-1184-version-safe-tests`.
- Branch: `dnlrsls/pr-1184-version-safe-tests`, initially at the exact PR head.
- Upstream fetched to `refs/remotes/pr-1184/main`; PR fetched to `refs/remotes/pr-1184/head`.
- GitHub user has upstream maintain/push permission; PR has `maintainerCanModify: true`. Fork repository permission reports no direct push; actual maintainer branch-update authority must be checked before publication.
- Bounded writer task: `murf70r9-6-03j0` settled partial. Upstream main integrated without conflicts; retry behavior auto-merged with no hand edits. Test-only correction: 22 additions / 20 deletions (new imports and fixture assumptions).
- Independent verifier: `murfdgr7-7-j74v` settled. Clean baseline at exact upstream main: 41 tests / 37 passed / 3 failed / 1 skipped, exit 1. Candidate: 51 tests / 47 passed / 3 failed / 1 skipped, exit 1. All three failed names and assertions match base on Windows x64 / Node v24.14.0; no new failures observed.
- Independently selected new retry tests: exactly 10 passed / 0 failed / 0 skipped, exit 0 (2430.4462 ms). Scoped GREEN established, not whole-suite GREEN.
- Upstream main identity: `71b436dd0ad459be32caa3198c5f0243a656e4e1`.
- Native review switch: on (global), clone-local unset.
- RED observed by writer: focused installer file exited 1, 51 tests / 37 passed / 13 failed / 1 skipped; stale version failure hooks produced zero attempts, ENOENT, and missing rejections.
- Post-fix observed by writer: focused file exited 1, 47 passed / 3 failed / 1 skipped; all 10 new retry tests passed. Whole-file GREEN not established.
- Remaining failed names: Darwin/Linux signed bundles retain their four-field manifest and reusable compatibility; extractors use only absolute trusted system paths, never lifecycle PATH or SystemRoot; installer promotes only the expected regular executable with executable POSIX mode. Baseline equivalence independently proved: signed-bundle reuse callback, trusted tar path predicate, and POSIX executable-mode assertion fail identically on this Windows host.
- Other checks: unstaged `git diff --check` passed. Staged integration check reported existing upstream whitespace in README.md:48, odd/tasks/fullscreen-live-header.md:120, tests/review-json-arguments.test.ts:144. Independent authored-scope check against upstream main passed. Generated runtime consistency passed: 8 modules match TypeScript sources and one-shot metrics validation passed. Full suite not launched: node_modules absent and runner shell stages are untimed; no dependency installation or native build performed.
- Native ASSESS: unassessable due untracked task document; returned plan requires self-verification plus independent verifier. No authority transaction started. Switch remains on.
- Commit: pending.
- Publication and CI: pending; do not approve external workflows.

## Next step
Create the verified additive work-unit commit, review the committed PR slice against exact upstream main using native review under the enabled switch, and publish only after the outcome is known. Do not mark T1 complete until publication is confirmed; preserve explicit full-suite and Windows baseline limitations.
