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
- [x] PF-1 — Reproduce and correct dangling-symlink canonicalization (#1659). Status: done.
  - Allowed behavior/test surfaces: lib/path-consent-fence.ts, tests/path-consent-fence.test.ts.
  - Acceptance: an alias pointing to a missing outside file cannot pass without consent; canonical target identifies the actual destination or safely blocks ambiguity. Relative/chained links and cycles must not hang or silently authorize outside access. Ordinary missing in-root targets remain usable.
  - Checks: focused path-consent suite; record platform limitations, skips and true OS-write witness when available.
  - Evidence: worker RED 3 failed/8 passed; initial GREEN 11 passed; non-directory-ancestor triangulation and final focused suite 12 passed/0 failed/0 skipped. Frozen dependency install succeeded, runtime check matched 8 modules, diff check passed. Native review lineage review-e92e2f6b09363378 found introduced CRITICAL R3-symlink-parent-normalization: lexical `..` normalization can classify inside while OS traversal writes outside. Correction applied: realpath-first traversal, canonical parent for relative dangling links, unresolved child/.. paths block. Exact correction delta 44 diff lines (+12/-3 source, +29 tests). Correction RED: 14 passed/2 failed (ambiguity subtest and enclosing test); GREEN: 16 passed/0 failed/0 skipped. Existing-parent-traversal and relative-parent cases already passed before correction on Windows; these are not RED bypass reproductions. Runtime check: 8 matched; diff check passed. Native targeted validation approved and exact acknowledgement burned review-e92e2f6b09363378 for target sha256:69231f7527071be1d2643bb88a4a831269ef8aa3089eca3e86453e39ee003afc. Independent verifier reported Windows and existing WSL Linux Node v24.21.0: 16 passed/0 failed/0 skipped on each; runtime check 8 matched and diff check clean. Actual write/read witnesses executed on both platforms; no current candidate defect found. Historical defective candidate was not rerun on POSIX, so prior lexical-parent finding remains historical static evidence. Verifier task settled successfully; its older 'native pending' note is superseded by the parent's successful native acknowledgement. Commit: ec485e47cf86a5361fd45c70dc6fb14cd5a03047 (`fix(safety): resolve dangling symlinks before path consent`), locally created after explicit user approval. No publishing.
- [ ] PF-2 — Reproduce and reject malformed durable boundary roots (#1660 primary). Status: in_progress.
  - Candidate behavior/test surfaces: lib/session-worktree-registry.ts, lib/path-consent-fence.ts, tests/session-worktree-registry.test.ts, tests/path-consent-fence.test.ts, tests/gentle-ai.test.ts. Extension hook changes only if exploration establishes necessity and parent adds the exact surface.
  - Acceptance: empty/invalid root entries cannot widen the boundary, valid registered same-clone roots remain accepted; verify entry-to-hook reachability rather than only asserting a pure comparison. Inspect secondary UI/schema claims without assuming fixes or closure.
  - Checks: registry, path-fence and focused hook tests; independent verifier after implementation according to assessment; package/runtime checks as applicable.
  - Evidence: worker reproduced malformed-entry RED on Windows and empty-root entry-to-hook bypass RED on WSL/Linux (outside access returned undefined instead of blocking). Shared canonical-root validation now rejects empty, relative, noncanonical, missing and alias metadata in both durable consumers; extension source unchanged. WSL registry/path suite: 31 passed/0 failed/0 skipped; new hook cases pass. Windows registry/path suite: 30 passed/1 failed (bootstrap fixture discovers ancestor Git); Windows selected hooks: 20 passed/1 failed (control-character directory unsupported). WSL selected hooks: 20 passed/1 failed (native-review case cannot resolve Windows-backed worktree). Worker observed these failures before correction; independent baseline attribution pending. Runtime check: 8 matched; diff check passed. Worker status partial; independent verifier settled successfully (task mut5k0gr-j-jo6e), with no candidate defect in scope. Native review-reliability approved and exact acknowledgement burned review-e0bccc4dd8d233d0 for target sha256:09cdabb42e45c439797c38e6f8b3cd72f55c80b57810ba42306cd9f616c86b7e; no source edits after freeze. Baseline attribution independently verified all three broader-suite failures against exact PF-1 HEAD ec485e47cf86a5361fd45c70dc6fb14cd5a03047. Windows bootstrap expected [] but got ancestor C:\Users\Blackie; control-character fixture mkdir failed ENOENT/errno -4058 on both baseline/candidate; WSL native workspace lookup failed identically with the same cwd because .git contains a Windows absolute pointer. WSL git diff --check is also unavailable for that pointer; Windows diff check is clean. New focused cases: registry 1/1 and real-hook 9/9 on each platform, zero skips. Runtime check matched 8 modules on both. Historical RED remains worker-observed, not independently rerun. Implementation verification complete with documented pre-existing failures; local commit approval pending.
  - Secondary findings: guarded-command confirm directly calls ctx.ui.confirm while path consent optional-chains it; absent capability throws versus denies. No present tool path-key schema drift reproduced; current schemas use path, handwritten collector coverage remains a follow-up. Entire #1660 must remain open.

- [x] PF-V — Independently attribute the required-suite failures against PF-1 HEAD. Status: done (read-only verification completed; PF-2 awaits commit approval).
  - Compare current failures with ec485e47cf86a5361fd45c70dc6fb14cd5a03047 without resets, hidden skips or project mutations. Report exact baseline evidence or limitations. This is verification bookkeeping, not a new behavior change.
  - Evidence: baseline archives of PF-1 HEAD reproduced all three exact errors; focused baseline commands each returned 0 passed/1 failed/0 skipped. Fixtures cleaned; no unexpected mutations. No standalone commit required for this read-only check.

## Verification strategy
Expected commands (run from dependent workspace):
- node --experimental-strip-types --test tests/path-consent-fence.test.ts
- node --experimental-strip-types --test tests/session-worktree-registry.test.ts
- node --experimental-strip-types --test --test-name-pattern="path|boundary|registered|consent" tests/gentle-ai.test.ts
- node scripts/build-runtime-modules.mjs --check
- git diff --check
Install dependencies only with the existing frozen lockfile and disabled lifecycle scripts if needed; do not modify manifests/lockfile or substitute another checkout's source. An unavailable runner or inability to create symlinks is a blocker/limitation, not RED evidence.

## Progress and next step
PF-1 reproduced and implemented, but native review found a candidate-caused critical symlink/parent traversal regression. PF-1 correction is implemented, focused tests pass, and native validation/acknowledgement completed successfully. Independent post-correction verification settled with green Windows/Linux execution and no current defect in the inspected cases. Native validation and exact acknowledgement also completed. Raw-input lexical normalization is unchanged and no comprehensive traversal hardening is claimed. PF-1 local commit ec485e47cf86a5361fd45c70dc6fb14cd5a03047 recorded. PF-2 primary correction and scoped independent verification are complete; broad suites retain three independently confirmed pre-existing platform/environment failures. Native PF-2 review and acknowledgement are complete. Next: obtain explicit local commit approval for PF-2 behavior/tests/tracking with the verification limitations recorded. Secondary #1660 UI/schema work remains follow-up; no push, PR creation or issue closure.
