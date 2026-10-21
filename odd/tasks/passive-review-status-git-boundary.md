# Guard passive review status outside Git

## Objective

Prevent passive Pi session hooks from invoking native review negotiation in an unversioned cwd, while preserving explicit review bootstrap and existing worktree behavior for issue #656.

## Scope

- `extensions/gentle-ai.ts`: the shared passive session STATUS resolver only.
- `tests/review-agent-end-preflight.test.ts`: outside-Git startup/end regression and controls for in-Git behavior.
- No change to explicit `gentle_review` inspection, native bootstrap, or global RDD mode.

## Tasks

- [x] T1 — Reproduce outside-Git passive STATUS, guard the passive resolver, and verify regression and existing worktree behavior (test-first). Route: delegated writer, two non-trivial files.

## Acceptance criteria

- Outside Git, `session_start` and `agent_end` call neither native review mode nor native target STATUS and do not create `.git`.
- Existing root, nested-directory, and linked-worktree passive checks remain supported.
- Explicit review/bootstrap remains unaffected by the passive guard.

## Checks

- Focused test: `node --experimental-strip-types --test tests/review-agent-end-preflight.test.ts`.
- Typecheck and relevant tests as feasible; report failures and skipped checks precisely.

## Delivery

- Delivery branch: `fix/passive-review-status-git-boundary` (renamed from the issue workspace's original branch for PR naming policy).
- One work unit: test plus guard. User authorized push and PR after issue #656 received `status:approved`.
- Reviewed work-unit commit: `8dae7fa7` (`fix(review): skip passive status outside Git`).

## Progress

- T1 complete: the shared passive resolver now checks for an existing worktree before native review negotiation; explicit review paths are unchanged.
- RED: temporarily without the guard, the new outside-Git test failed with native calls `["reviewMode", "targetStatus"]` instead of `[]`.
- GREEN: `node --experimental-strip-types --test tests/review-agent-end-preflight.test.ts` — 42 passed, 0 failed, including existing nested/sibling-root cases. Independent verifier repeated 42/42.
- `node scripts/check-types.mjs` — exit 0, 188 recorded baseline diagnostics, no regressions (10 improved file/code pairs). `git diff --check` — exit 0.
- Runtime boundary: the test exercises real Git discovery and Pi event handlers, but mocks the native provider; no live Pi/native bootstrap was run.
- Rollback boundary: the guard in `extensions/gentle-ai.ts` and regression in `tests/review-agent-end-preflight.test.ts` (plus this task record).
- Dependency setup: `pnpm install --frozen-lockfile --ignore-scripts` populated ignored `node_modules`; package and lockfile unchanged.
- Native review approved and acknowledged: lineage `review-b9df31fb8fc6ab6c`, target `sha256:32d235ecff07e297de78b84a38daf7ff5e78a07ef2df5e255d5de89539ad8b7d`; authority burned before commit. The commit contains the exact reviewed three-file candidate.
- This bookkeeping update records the reviewed work-unit commit; it changes only this passive task document after acknowledgement.
