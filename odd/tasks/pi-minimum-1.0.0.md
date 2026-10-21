# Pi development minimum 1.0.0

## Objective and authorization
Track the Pi development packages with `>=1.0.0`, following the previous `>=0.99.2` upgrade. The user explicitly requested preserving `>=`. Local engine installation is already verified as 1.0.0; this work makes the repository declaration and resolved development SDK graph consistent.

## Problem and scope
The targeted local install upgraded the engine but left root AI/TUI packages at 0.99.2. Development declarations, workspace maturity exceptions, lockfile, current-development documentation and associated assertions need one coherent upgrade.

Allowed source surfaces: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tests/gentle-shell-launcher.test.ts`, `tests/package-manifest.test.ts`, `docs/gentle-shell.md`, `docs/readme-reference.md`, `lib/vim-editor-adapter.ts`, `tests/vim-editor-adapter.test.ts`, `tests/gentle-shell.test.ts`.

Keep the peer/runtime minimum 0.99.1, wildcard peers, historical fixtures, generated runtime modules, and the 4320-minute maturity policy unchanged. Preserve existing audited Vim releases 0.99.1 and 0.99.2; admit exact 1.0.0 only after actual bundled/unbundled behavioral proof. Keep constructor identity, verified metadata, private shape/snapshot checks and unknown-release fallback protections. Only the eight existing first-party package exceptions change to exact release 1.0.0. No publication or remote operation is authorized.

## Work unit
- [ ] P1: Bump the development minimum, align the resolved graph and provide audited Pi 1.0.0 editor support with tests and documentation.
  - Route: delegated writer; multiple nontrivial manifest/lock/test/doc files and dependency resolution require delegation.
  - Acceptance: development coding-agent/AI/TUI specifiers are `>=1.0.0`; all three root packages resolve to 1.0.0; eight maturity exceptions are version-specific `@1.0.0`; peer/runtime floors and excluded surfaces are unchanged. Actual bundled/unbundled editor tests prove 1.0.0 identity/edit/undo/paste/selection/wrapping/autocomplete behavior, older audited releases remain covered and 1.0.1/range/prefix/mismatched identities remain rejected without mutation.
  - Test-first: change relevant development-range expectations; observe focused RED, then update declarations/lock/docs and observe GREEN. Do not change historical fixtures to manufacture a pass.
  - Checks: focused launcher + manifest tests; `pnpm test`; `pnpm run check:runtime-modules`; `pnpm run typecheck`; wrapper version/help and Git diff checks. Typecheck is a diagnostic-count ratchet, not a zero-error guarantee; never update its baseline.
  - Verification risk: high because dependency resolution/public declarations can affect installed extension identity; writer self-checks plus independent verifier.
  - Commit: pending Conventional Commit after checks and applicable native review. Work-unit commit authorized by substantial ODD; no push/PR/merge.

## Delivery
Strategy: ask-on-risk. Forecast: about 300 authored additions/deletions including editor support and checks; dependency-lock changes count as authored changes for delivery. If actual size exceeds about 400, apply ask-on-risk before committing rather than code-golfing. One cohesive work unit; reassess if actual source scope exceeds this forecast. Running committed authored lines: 0.

## Progress and evidence
- Local installed engine: `gentle-shell --version` reports wrapper 3.7.0 and Pi 1.0.0; help smoke passed. Installer emitted Done but its command timed out; installed state was separately verified.
- Pre-change branch was `fix/nan-reasoning-levels`; source upgrade uses `build/pi-minimum-1.0.0`. Git was clean before task creation.
- Mixed-graph baseline: `pnpm test` failed (4567 tests: 4448 passed, 85 failed, 34 skipped). Failures: 75 shell/modal, 9 Vim adapter, 1 manifest alignment. Provider mirror and real runtime harness passed. Full test log: `/tmp/pi-bash-6c8067dd1571b2c2.log`.
- Runtime modules passed (8 modules). Typecheck failed with 8 additional diagnostics across 7 file/code pairs. No baseline changes permitted.
- P1 metadata writer returned partial: three expected development-floor assertions failed in RED (260 passing), final focused suite passed all 263 tests. Lock-only and frozen installs passed; root engine/AI/TUI now all 1.0.0. Seven source files changed, 63 additions and 68 deletions. Diff whitespace check and version/help smoke passed; no commit yet.
- Native ASSESS was unassessable because the new task document is untracked; RDD is on with unknown candidate outcome. Apply high-risk plan: writer self-verification and independent verification. No authority mutation attempted.
- A read-only audit maps actual Pi 1.0.0 editor identity/private-shape evidence. Existing allowlist rejects 1.0.0; touched field/layout/undo contracts match statically, but bundled/unbundled behavioral checks are still required before admission. Support scope will be added before writes; the unit remains partial until required checks pass.
- Independent aligned-graph typecheck passed (exit 0): 187 diagnostics, no regressions; 11 file/code pairs improved. This is not a zero-error gate. Conditional raw tsc was correctly skipped; no callback/provider edits or baseline refresh justified.
- Editor writer completed: RED observed 114 failures / 264 passing / 0 skipped before production admission; GREEN passed all 378 focused tests / 0 skipped. Actual bundled/unbundled editing, paste-registry undo/history restoration and NORMAL-mode no-fallback tests passed; forged/corrupt/unverified/unknown/mismatched claims remain rejected. Only exact 1.0.0 was added to the production allowlist; no private layout algorithm changes.
- Writer final typecheck passed with 187 diagnostics/no regressions/11 improved pairs; diff check and version/help passed. Overall tracked source diff is 135 additions + 95 deletions across 10 files (230 authored lines).
- Independent final verification passed: full suite 4568 tests / 4534 passed / 0 failed / 34 Windows-only skips; focused actual-host suite 378 passed / 0 failed / 0 skipped; provider mirror and real runtime harness passed; runtime modules 8 passed; typecheck 187 diagnostics/no regressions/11 improved pairs. Full log `/tmp/pi-bash-91ade79337f86518.log`. Independent diff inspection confirmed only authorized surfaces and preserved guards. Verifier mistyped `diff --check.` (no actual check executed); parent ran exact `git diff --check` successfully and repeated wrapper version 3.7.0/Pi 1.0.0.
- Skipped: packed lifecycle, devbinary/crosslane/maintainer execution and live-terminal/manual verification. No publication or commit.
- Native review lineage `review-8a557dd3ba1b34d9` froze the ten tracked source paths; the passive untracked task document was explicitly excluded. Two model captures produced empty output (first stopReason length, second stop); no verdict was admitted or authority acknowledged. An intervening incomplete binding was rejected with no mutation; fresh STATUS and exact stored binding were used for the second attempt. Latest authority remains reviewing/collect-required. No further retry loop.
- Native ASSESS with explicit unavailable returns high-risk fallback (unassessable due untracked bookkeeping document), writer self-checks plus independent verifier; those functional checks are satisfied. Unit/commit closure remains pending the review decision.
- Engram mirror pending: cross-project save to gentle-pi was blocked because this Engram server lacks isolated_session_registration. Preserve this document as authoritative local progress; do not claim a mirror exists.

- Human decision: deliver without retrying native review (no native verdict; lineage left untouched, no reset/recover). Delivery authorized through the configured GitHub CLI session: issue #1641 created with `enhancement`, `type:chore`, `status:approved`; PR to `main` and merge after required checks.
- Delivery strategy: single PR (230 authored lines, within budget). The unrelated NaN commit is excluded by rebasing onto current `main`, where it already landed as #1637.

## Next step
Commit P1, rebase onto current `main`, re-run focused checks on the new base, open the PR linking #1641, wait for required checks, and merge.
