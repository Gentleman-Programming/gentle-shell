# Path consent fence hardening

## Objective and problem
Harden the in-flight path-tool consent fence from PR #1610 without duplicating #1305 or modifying the contributor's branch. Two reported mechanisms need reproduction: dangling symlink canonicalization (#1659) and malformed durable worktree roots (#1660).

## Why
Neither a filesystem alias nor malformed session metadata may silently widen the user's authorized file boundary.

## Ownership and base
- Repository: Gentleman-Programming/gentle-shell.
- Dependent branch: dnlrsls/fix-path-fence-hardening-1659-1660.
- Exact base: a67ac168ddcb5b6929154f09a44117d5a0cea5b7 (open PR #1610, danielgap).
- Workspace: C:/Users/Blackie/orca/workspaces/main/fix-path-fence-hardening-1659-1660.
- Parent checkout is dirty and stale; do not change it.
- No push, PR creation, merge, issue edits, or contributor-fork mutation authorized.
- User explicitly authorized the PF-1 local work-unit commit on 2026-10-04. No publishing is authorized. Later commits require explicit approval.

## Scope and constraints
Keep single-writer execution and use deterministic test-first RED/GREEN where the runner permits. Preserve per-target/session grants, registered same-clone roots, ordinary missing targets and normal authorized inside-root work. Do not add a config flag, lifecycle state, or parallel authority. About 400 changed lines per unit is advisory, never a reason to omit tests or compress code.
Bash fencing is #1305 slice 3 and remains excluded. #1660 also reports UI-confirmation semantics and path-input schema drift: inspect these claims, report verified findings and remaining work, and do not claim the entire issue closed after only fixing malformed roots.

## Tasks
- [ ] PF-1 — Reproduce and correct dangling-symlink canonicalization (#1659). Status: in_progress.
  - Allowed behavior/test surfaces: lib/path-consent-fence.ts, tests/path-consent-fence.test.ts.
  - Acceptance: an alias pointing to a missing outside file cannot pass without consent; canonical target identifies the actual destination or safely blocks ambiguity. Relative/chained links and cycles must not hang or silently authorize outside access. Ordinary missing in-root targets remain usable.
  - Checks: focused path-consent suite; record platform limitations, skips and true OS-write witness when available.
  - Evidence: worker RED 3 failed/8 passed; initial GREEN 11 passed; non-directory-ancestor triangulation and final focused suite 12 passed/0 failed/0 skipped. Frozen dependency install succeeded, runtime check matched 8 modules, diff check passed. Native review lineage review-e92e2f6b09363378 found introduced CRITICAL R3-symlink-parent-normalization: lexical `..` normalization can classify inside while OS traversal writes outside. Correction applied: realpath-first traversal, canonical parent for relative dangling links, unresolved child/.. paths block. Exact correction delta 44 diff lines (+12/-3 source, +29 tests). Correction RED: 14 passed/2 failed (ambiguity subtest and enclosing test); GREEN: 16 passed/0 failed/0 skipped. Existing-parent-traversal and relative-parent cases already passed before correction on Windows; these are not RED bypass reproductions. Runtime check: 8 matched; diff check passed. Native targeted validation approved and exact acknowledgement burned review-e92e2f6b09363378 for target sha256:69231f7527071be1d2643bb88a4a831269ef8aa3089eca3e86453e39ee003afc. Independent verifier reported Windows and existing WSL Linux Node v24.21.0: 16 passed/0 failed/0 skipped on each; runtime check 8 matched and diff check clean. Actual write/read witnesses executed on both platforms; no current candidate defect found. Historical defective candidate was not rerun on POSIX, so prior lexical-parent finding remains historical static evidence. Verifier task settled successfully; its older 'native pending' note is superseded by the parent's successful native acknowledgement. Commit: explicitly authorized; preparing local work-unit commit with behavior, tests and this document. No publishing.
- [ ] PF-2 — Reproduce and reject malformed durable boundary roots (#1660 primary). Status: pending.
  - Candidate behavior/test surfaces: lib/session-worktree-registry.ts, lib/path-consent-fence.ts, tests/session-worktree-registry.test.ts, tests/path-consent-fence.test.ts, tests/gentle-ai.test.ts. Extension hook changes only if exploration establishes necessity and parent adds the exact surface.
  - Acceptance: empty/invalid root entries cannot widen the boundary, valid registered same-clone roots remain accepted; verify entry-to-hook reachability rather than only asserting a pure comparison. Inspect secondary UI/schema claims without assuming fixes or closure.
  - Checks: registry, path-fence and focused hook tests; independent verifier after implementation according to assessment; package/runtime checks as applicable.
  - Evidence: pending. Commit: not authorized.

## Verification strategy
Expected commands (run from dependent workspace):
- node --experimental-strip-types --test tests/path-consent-fence.test.ts
- node --experimental-strip-types --test tests/session-worktree-registry.test.ts
- node --experimental-strip-types --test --test-name-pattern="path|boundary|registered|consent" tests/gentle-ai.test.ts
- node scripts/build-runtime-modules.mjs --check
- git diff --check
Install dependencies only with the existing frozen lockfile and disabled lifecycle scripts if needed; do not modify manifests/lockfile or substitute another checkout's source. An unavailable runner or inability to create symlinks is a blocker/limitation, not RED evidence.

## Progress and next step
PF-1 reproduced and implemented, but native review found a candidate-caused critical symlink/parent traversal regression. PF-1 correction is implemented, focused tests pass, and native validation/acknowledgement completed successfully. Independent post-correction verification settled with green Windows/Linux execution and no current defect in the inspected cases. Native validation and exact acknowledgement also completed. Raw-input lexical normalization is unchanged and no comprehensive traversal hardening is claimed. PF-2 is queued and untouched. User authorized the PF-1 local commit. Next: record its resulting identity, then start PF-2 with test-first reproduction and hook-level boundary checks. No push, PR creation or issue closure.
