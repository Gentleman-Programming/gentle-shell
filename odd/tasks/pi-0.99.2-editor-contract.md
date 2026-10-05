# Pi 0.99.2 audited editor compatibility

## Objective and authorization
User authorized investigating and correcting Pi 0.99.2 compatibility to unblock float-chrome PR #1628. Implement the missing compatibility contract, not an unrelated dependency-policy change. Keep the accepted float UI unchanged.

## Problem and why
Main at 408ac8e4 adopted devDependency ranges >=0.99.2 and locked 0.99.2, while Vim/runtime gates and manifest/CLI/packed probes still assume 0.99.1. Local baseline 118 failures and CI 113 unit failures block the merge. The five local-only child-safety failures may result from inherited GENTLE_PI_AGENTS_CHILD; verify with that variable explicitly unset rather than changing unrelated tests.

## Scope and constraints
- Add audited support for 0.99.2 while preserving audited 0.99.1 and rejecting unknown versions; retain MIN_PI_VERSION=0.99.1.
- Share one audited version policy between adapter and shell bundle/local runtime checks; preserve fail-closed shape/agent-tui pairing checks.
- Update tests/probes to distinguish devDependency range policy from installed resolved version. Preserve >=0.99.2 policy, package.json, pnpm-workspace.yaml, lock and runtime generated artifacts.
- Preserve existing fixtures deliberately testing 0.99.1; add positive coverage for 0.99.2 and negative unknown-version coverage.
- No UI redesign, native-mode bypass, environment safety relaxation, unrelated source changes or remote access by workers.
- New compatibility candidate is distinct from the user-declined float-chrome candidate. Follow the enabled native review switch for this new work unit; never infer consent.

## Evidence
- Parent cmp and SHA-256 prove editor.js byte-identical across pnpm-store 0.99.1 and installed 0.99.2: fde684babdeae2c1def1b3f7bb31ba8f7fcc7e4a0e038fd146b63f8f5be274b7.
- dist/undo-stack.js identical: 7fbb318db3521aa1fa6804ffe50245c18d9e9f210a85a48e175fae6a629259cb. Both cmp exit 0.
- Explorer mapped gates lib/vim-editor-adapter.ts:43 and extensions/gentle-shell.ts:65,99; fixed-spec tests in package-manifest, launcher, bin; packed probes scripts/test-packed-runner.mjs.
- Read-only explorer did not load injected skills; parent refreshed registry. Writer must load full exact skills before work and read relevant Pi docs fully.

## Tasks
- [x] C0: map root cause and audit exact installed editor/undo contract. No source changes; SHA/cmp proof above. Base candidate ba1b43ced48513519ba97bb2c65b25a27c22348b.
- [x] C1: implement audited 0.99.2 compatibility with regression tests, packed probes and truthful docs. Route delegated: preparation plus 2+ non-trivial files. Risk high: private editor/undo/public runtime contracts. Deterministic RED before source fix, GREEN afterward. Commit pending checks; estimate 200-350 authored lines, advisory only.
- [x] C2: independently verify the C1 work-unit diff, parent spot check, and follow native review for the exact new compatibility candidate. Publication/merge remain the separate D2 delivery operation: only after applicable GitHub CI green, without bypass. Windows/network probe limits are disclosed.

## Verification
node --experimental-strip-types --test tests/vim-editor-adapter.test.ts tests/package-manifest.test.ts tests/gentle-shell-launcher.test.ts tests/gentle-shell-bin.test.ts
node --experimental-strip-types --test tests/gentle-shell.test.ts tests/vim-*.test.ts
pnpm run typecheck
pnpm run check:runtime-modules
pnpm run check:provider-contract
node scripts/verify-package-files.mjs
env -u GENTLE_PI_AGENTS_CHILD pnpm test
git diff --check
Applicable packed probes: inspect runner invocation and run supported local check-only modes; Windows-specific SDK lifecycle proof may be unavailable locally, rely on actual CI without inventing a pass. No installer/network operations without parent authorization.

## Delivery and recovery
Existing branch feat/float-chrome, PR https://github.com/Gentleman-Programming/gentle-shell/pull/1628 (type:feature, Closes #1613 approved/already closed), user-selected single-pr. Compatibility is a separate Conventional Commit work unit after ba1b43ce; do not compress tests/docs to fit the 400-line planning heuristic. Original float candidate explicitly left unreviewed; new fix requires fresh review handling.
Local current tree clean before this document; no edits by other workers here (gentle-stats is an unrelated isolated worktree, do not access).
C1 progress: initial writer changed 9 allowed files (+254/-93), observed RED then GREEN 433/433 focused. Typecheck/runtime/provider/assets checks pass. Full env-unset suite has 18 remaining gentle-shell fixture failures; child-safety failures disappear with GENTLE_PI_AGENTS_CHILD unset. No commits yet.

User explicitly answered `Approve` to add exactly `tests/gentle-shell.test.ts` to the allowed edit surfaces. Approved correction: use installed pi-tui metadata for 26 runtime-version fixtures, including the unsupported-version loop; no child-safety changes or weakened identity checks. Writer continues as task mupqfkt4-5-7yy2. Real repository GREEN and final full checks still pending; a 247/247 temporary-copy probe is not completion proof.

Next step: finish approved fixture correction, observe writer full-suite checks, independent verifier plus parent spot check, then native review handling for the new compatibility candidate and conditional delivery. Parent owns tracking, commit and remote actions.


## Verified work-unit closure
- C1 commit: `f51dea2ae9e799e73561967d62a30ee5e26eb7e6` (`fix(shell): audit Pi 0.99.2 editor and resolved SDK versions`); 10 behavior/test/doc paths plus this task document, 332 additions + 119 deletions. The ~400-line forecast is advisory; approved fixture substitutions and tracking explain the modest excess, without compression.
- Writer and fresh independent verifier observed 433/433 focused and 322/322 shell/Vim tests; full `env -u GENTLE_PI_AGENTS_CHILD pnpm test`: 4,521 tests, 4,487 passed, 0 failed, 34 Windows-native skipped. Typecheck187/no regressions, runtime8, provider1.2.0, assets155/69, diff checks all passed. Parent spot check after both reports:433/433 passed. Child-safety environment was unset only for the test command; production safety remained unchanged.
- Native review for this compatibility work unit: `review-bd056302dad2eee9`, exact target `sha256:a0eb3e781341643b1020ef221ab3ab323fe3a9c1954fc5cbc365e0bf18003438`, approved and exact acknowledgement returned `authority: burned`, evidence `gentle-ai.review-acknowledged/v1`. Non-blocking advisory findings remain follow-ups; no correction requested. Original float feature review decline is not altered.
- No source changes after verification/review; this closure entry is passive bookkeeping. Actual packed/network SDK and Windows proof is still CI-only; local node syntax/helper and owned-path/bootstrap54/54 passed. Do not imply Windows/native probe success from Linux skips.
- D2 next: push updated PR #1628 via authorized gh HTTPS credential session, record CI results, and merge only when applicable CI is green. Review outcome does not authorize delivery; user authorization and repository policy do.
