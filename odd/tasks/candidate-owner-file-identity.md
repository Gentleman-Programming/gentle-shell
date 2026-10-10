# Exact candidate-owner filesystem identity

Refs #343 (approved cleanup tracker; remains closed). Independent follow-up to merged #672; blocks Windows check on coordination PR #1736. No main merge, auto-merge or runtime reload authorized.

## Invariant and scope
Rollback and reclamation must preserve a replaced marker/root even when two filesystem identifiers exceed Number's safe range. Use exact dev/ino from the same filesystem observation; no new authority representation, retry or gate. Limit changes to the owner module, focused regression and this tracker. Forecast <150 changed lines; dedicated `fix/candidate-owner-file-identity` worktree, current main `a87192ee`.

## Evidence before correction
Observed Windows CI run `37159261739`, job `111309064512`: original replacement-preservation test failed because marker was absent. Actual NTFS identifiers were not logged, so that exact CI cause is inferred, not measured.

On clean current main, a deterministic actual-registry/real-filesystem fixture assigns two distinct 64-bit marker identities (`2^53`, `2^53+1`) which collide when represented as Number. It observes one controlled fsync replacement, no worktree addition, preserved original `.saved` and no lock, but rollback deletes the replacement. Focused command: `node --experimental-strip-types --test --test-name-pattern='candidate owner publication.*replaced|64-bit|precision' tests/review-candidate-view.test.ts`: one passed, one failed. This is modeled precision loss, not native NTFS measurement.

## Plan
- [x] Current-main behavior RED and approved-root/duplicate audit.
- [x] Exact bigint identity, same-stat privacy/type/size validation and GREEN.
- [x] Relevant candidate/repository suite and types/runtime validation.
- [ ] Independent read-only verification by parent (high-risk deletion authority); no semantic approval or native verdict claimed.
- [ ] Separate PR and actual Windows CI; propagate fix without main merge and verify stacked checks.

## Correction verification
Both `regular()` and `directory()` now request `{ bigint: true }` once; their existing template-string dev/ino identity API stays unchanged. UID/mode/nlink/size validation uses that same observation with bigint comparisons; the unrelated numeric chmod probe remains unchanged. No marker JSON, ACL, path, registration or PID-death changes.

Additional controlled root-replacement regression retains the Git pointer and intercepts removal without executing it, protecting fixture replacement data even on RED. Before correction, the focused command above observed 3 tests: 1 pass, 2 fail (marker replacement deleted; directory replacement reached Git removal). After correction: 3 pass, 0 fail.

- `node --experimental-strip-types --test tests/review-candidate-view.test.ts tests/review-repository.test.ts`: 173 tests, 165 pass, 8 Windows-only skips, 0 fail; existing privacy, symlink, replacement, failed-fsync/removal and death-proof controls pass.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions; 12 file/code pairs improved (no baseline update).
- `node scripts/build-runtime-modules.mjs --check`: 8 generated modules match; one-shot metrics sources validated.
- `git diff --check`: passed. Native Windows CI is unavailable locally; modeled precision evidence does not measure the original NTFS identifiers. Review-ready uncommitted diff only; delivery and independent verification remain parent-owned.

Rollback boundary: owner-module precision changes and their regression. Marker JSON, public APIs, privacy/ACL/registration/dead-owner gates must remain unchanged. CodeGraph at parent cwd indexes gentle-ai, not this repository; child CodeGraph unavailable/uninitialized, scoped known-path fallback used.
