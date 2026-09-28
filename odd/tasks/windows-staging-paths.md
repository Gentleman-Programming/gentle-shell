# Windows installer staging paths — issue #1484

## Objective and scope
Support package-local staging under deep Windows pnpm roots without changing Windows long-path policy, relocating the runtime, or weakening provenance/publication checks.

The report describes a 233-character package root and `mkdtemp` failing with ENOENT before Go starts. This is distinct from #946's transient rename locks; open PRs #1184/#1280 are out of scope.

- Base: `f14b19a2584aaadaef681973088de49176f881a3`.
- Branch: `fix/1484-windows-staging-paths`.
- Edit surfaces: `scripts/gentle-ai-installer.mjs`, `tests/gentle-ai-installer.test.ts`; parent-owned tracking in this file.
- Preserve pinned Go metadata/version/hash, canonical manifest, real-directory/symlink checks, cooperative locking, same-volume atomic publication, recovery, and rollback.
- No external-temp relocation, EXDEV fallback, rename retries, or dependency changes. User explicitly authorized commit, push, and PR creation after review; merge and issue closure are not authorized.

## Evidence and accepted approach
Node v24.9.0 `src/node_file.cc` converts paths with `ToNamespacedPath` in `MKDir` but not in `Mkdtemp`: https://github.com/nodejs/node/blob/v24.9.0/src/node_file.cc.
Node documents `path.toNamespacedPath` as a Windows namespace conversion and a POSIX no-op: https://nodejs.org/api/path.html#pathtonamespacedpathpath.

Both staging prefixes now pass through `toNamespacedPath` at the `mkdtemp` boundary. No publication or cleanup behavior was redesigned. The public `installGentleAi()` regression drives real filesystem publication with fake Go. It constructs a multi-component path beyond 260 characters independently of host temp-directory length. POSIX simulates the boundary; Windows retains native builtins. The test covers failed-build cleanup, publication, integrity hash/checksum, verified reuse, and no staging/owned-lock leftovers. Builtins and temp fixtures are restored in `finally`.

## Tasks
- [x] T1 — Reproduce the long-prefix staging failure, apply minimal normalization, and verify regression coverage. **Done.** Delegated writer because two non-trivial files change. Parent readback caught and corrected an initially host-length-dependent test and an invalid Windows mock. Final focused RED/GREEN and installer checks observed via writer report.
- [x] T2 — Independently verify the diff and applicable full checks; complete candidate-scoped native review. **Done.** Independent verifier passed all available checks; medium-risk consolidated reliability review approved and acknowledged.
- [ ] T3 — Validate the deep-root install/build/launch on native Windows. **Blocked: no Windows runner available.** POSIX simulation is not Windows runtime evidence; do not close the issue on that basis.
- [ ] T4 — Commit, push, and open a PR on user request. **Blocked on issue approval.** Implementation commit: `d1bcbb79608d606988096dfb98cf25ee24124bad`. Delivery target is branch `fix/1484-windows-staging-paths` on the existing `NicolasIppoliti/gentle-pi` fork (ADMIN), whose parent is `Gentleman-Programming/gentle-shell` (READ). PR creation is blocked because #1484 has no `status:approved` label. Do not self-approve the issue.

## Acceptance and verification
- Writer RED: `node --experimental-strip-types --test --test-name-pattern='long|staging' tests/gentle-ai-installer.test.ts` — 1/2 failed with simulated staging ENOENT when conversions were removed; restored afterward.
- Writer GREEN: same command — 2/2 passed.
- Writer focused: `node --experimental-strip-types --test tests/gentle-ai-installer.test.ts` — 42/42 passed.
- Writer type gate: `pnpm typecheck` — passed, 188 recorded baseline diagnostics, no regressions.
- Writer structural: `git diff --check` — passed.
- Parent readback: only the intended two source/test surfaces plus this tracking file changed.
- Independent focused spot check: 42/42 passed.
- Independent `pnpm test`: all three stages passed; 3,959 tests passed, 41 skipped, zero failures.
- Independent `pnpm typecheck`: 188 recorded baseline diagnostics, no regressions.
- Independent `git diff --check`: passed; worktree status unchanged before/after checks.
- Native Windows install/build/launch under deep pnpm root: pending; this macOS host only exercised POSIX boundary simulation. Native namespace propagation into Go cwd and mixed-form rename remain unobserved.
- Native assessment remains unassessable because the separate read-only assessor rejects the untracked task record without explicit scope; independent verification was completed under the conservative plan. The review facade explicitly excluded this passive tracking file and froze only the source/test candidate.
- Native review: first consent declined with no lineage; user explicitly requested the prompt again and granted the new request. Medium tier, 61 authored lines, consolidated `review-reliability` lens. Lineage `review-104bd0d943f4412f`, target `sha256:1793b239205449b4e3d18c2105168d06a2e949e064fecab4583f93a8881fee86` approved. Exact acknowledgement returned `native-approved-acknowledgement-completed`, authority burned. One informational non-blocking warning `R3-001` at `scripts/gentle-ai-installer.mjs:659`; no correction offered. The facade did not provide the warning's full text. Do not rerun the approved review for this advisory.

## Delivery and review workload
One cohesive behavior/test work unit; source/test diff is 57 additions + 4 deletions (61 authored lines), within forecast 60–180. Strategy: `ask-on-risk` if scope expands; approximately 400 lines is advisory, never a reason to omit tests or compress code.
Behavior/test commit: `d1bcbb79608d606988096dfb98cf25ee24124bad` — `fix(installer): support long Windows staging paths`.
This passive progress record is a separate documentation commit and was excluded from the source/test native review. Commit/push/PR are user-authorized; upstream issue approval remains a required PR precondition. Merge not authorized.
Rollback boundary: remove the two staging-prefix conversions and the dedicated regression test; no runtime data migration.

## Next step
Open the PR against upstream `main` only after a maintainer approves #1484. No repository PR template exists in this checkout; use the contribution skill's required sections and a single `type:bug` label. Keep Windows validation explicitly pending and obtain native evidence for T3; do not close issue #1484 from simulation alone.
