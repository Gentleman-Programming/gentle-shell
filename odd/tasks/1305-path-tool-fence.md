# Path-tool consent fence (1305 slice 2)

## Objective
Resolve parent-session path-tool targets (read, write, edit, grep, find, ls) against the session worktree boundary. Targets outside the repo root and registered same-clone worktrees trigger the existing permission-request flow naming the absolute target; non-interactive sessions fail closed. Granted targets pass for the session.

## Problem and why
gentle-shell#1305: the parent session's path tools never resolve their target against the session worktree, so nothing structural stops the agent from reading or writing sibling projects without consent. Slice 1 (PR #1520) added the prompt rule; asking is not enforcement. This slice is the runtime fence for path tools.

## Authorized scope and constraints
- Issue #1305 (`status:approved`); maintainer direction 2026-09-30: consent covers reads and writes outside the repo and registered same-clone worktrees, per target and per session. Worktree /home/dseo/gentleman/gentle-shell-1305-slice2, branch feat/1305-path-tool-fence off origin/main 3e2a02f3.
- Boundary = session worktree root + registered same-clone worktrees + session-bound per-target grants (fail-closed, never persisted). Denied access never executes; headless fails closed. Bash coverage is slice 3. Hard budget 400 additions+deletions.

## Tasks
- [x] T1 — Map seams: tool_call hook (extensions/gentle-ai.ts:9528), sensitive-path guard (1551-1689), confirmCommand permission lifecycle (1784), SessionWorktreeRegistry/registeredRootsForSession, ForeignTargetGrants pattern. Delegated scout report corroborated parent reads.
- [x] T2 — RED: tests/path-consent-fence.test.ts written first; module-not-found RED observed, then 8/8 GREEN after implementation.
- [x] T3 — Implementation: lib/path-consent-fence.ts (canonicalizeTarget deepest-existing-ancestor realpath, resolveOutsidePaths, PathTargetGrants, evaluatePathFence); registeredRootsForSession in lib/session-worktree-registry.ts; confirmOutsideBoundaryTargets wired in the hook (PATH_FENCE_TOOL_NAMES gate; one extra microtask for bash broke 4 herdr timing tests, fixed by gating the await).
- [x] T4 — Verification: `node --experimental-strip-types --test tests/path-consent-fence.test.ts tests/gentle-ai.test.ts tests/yolo-customize.test.ts tests/yolo-mode-runtime.test.ts` → 115/115 pass; registry+grants+autonomous+destructive suites 156 run/154 pass with 2 environment-only failures (stale node_modules symlink; resolved by `pnpm install --frozen-lockfile`, then those suites pass); `pnpm typecheck` → 187 recorded diagnostics, no regressions. Authored: 399 additions+deletions (within budget).
- [ ] T5 — PR linked to #1305 as slice 2 (pending user authorization to publish).
- [x] T6 — Refresh 2026-10-02: merged origin/main (30 commits; import-block conflict in extensions/gentle-ai.ts resolved as union). Closed CodeRabbit outside-diff finding on tests/path-consent-fence.test.ts:99-103 with tool-call coverage for the sensitive-path short-circuit and the no-session guard in confirmOutsideBoundaryTargets (tests/gentle-ai.test.ts; each guard mutation-verified RED, then GREEN restored byte-for-byte). The flagged lib test renamed to what it proves and extended with the sensitive-outside confirm case. Checks: fence suites 8/8 + 93/93, typecheck 187 no regressions, runtime modules match.
