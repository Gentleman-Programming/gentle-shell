# Feature: CodeGraph worktree index seeding (Group D)

A linked Git worktree without a `.codegraph` index is seeded by copying the
main checkout's database and syncing it — ~65% faster than a full init —
instead of `init -y`. Seed failure falls back to the existing init path, so
correctness never depends on seeding.

## Specs

- S1: Seedable iff the cwd is a linked worktree (`.git` is a file), its
  `codegraph.db` is absent, and the main checkout's `codegraph.db` exists;
  main worktrees and plain repos keep the unchanged init path.
- S2: Seed sequence under the worktree's init lock (re-checked absence after
  acquire): staged copy of `codegraph.db` + `-wal`/`-shm` sidecars
  (`.seeding` names never count as an index), the standard
  `.codegraph/.gitignore`, rename into place (db last), then `sync -q` as the
  integrity check; on sync failure the db is removed (worktree returns to
  absent) and the outcome tells the caller to fall back to init.
- S3: `prepareReadiness`'s init branch prefers seed when seedable
  (seeded/target-exists ⇒ ok; seed-failed ⇒ the existing init path;
  deferred ⇒ fail-closed skip, no init); the session-start cwd is the v1
  trigger.
- S4 (user condition, folded): AGENTS.md trim in the same slice — the
  Worktrees bullet loses the "runs init there" clause (runtime owns
  seed→init), Index hygiene loses the manual confirm/add clause, and
  Post-compaction revalidation loses the "freshness limits" half (per-prompt
  runtime sync covers it); each rewrite keeps its surviving clauses.

## Tasks

- T1 (S1, S2): RED unit tests `tests/codegraph-seed.test.ts` (seedable
  matrix; staged copy→rename→sync; sync failure removes db) + two-child race
  on one worktree ⇒ exactly one seed; implement `lib/codegraph-seed.ts`;
  GREEN; typecheck. Route: inline. Commit: 9a72c8d. DONE — 6/6 seed
  (real git worktrees), full suites green, tsc clean.
- T2 (S3, S4): RED wiring tests (seed injected into `ReadinessInput`:
  seeded/target-exists/seed-failed/deferred/not-seedable paths; main-repo
  init and sync pins unchanged); wire `prepareReadiness` + default seed;
  AGENTS.md trim; GREEN; full codegraph suites. Route: inline. Commit:
  this work unit. DONE — RED on exactly the 2 wiring tests → GREEN 27/27
  readiness + 6/6 seed + 11/11 lease + 33/33 tools + 4/4 daemon + 3/3
  child-bootstrap; tsc zero codegraph errors. AGENTS.md trim applied in
  the working tree but NOT committed with this unit — it stays pending
  with the other uncommitted instruction-layer edits (show/what/where,
  trust-by-calling) per the user's standing constraint.

## Log

- L1: "now plan for worktrees (D)" + custom answers "check if there is
  something to remove from agents.md" and "Approve and start" (user,
  2026-11-13 session).
- L2: Known deviation accepted at close: the mid-session
  SESSION_WORKTREE_CHANGED trigger is NOT wired in v1 — the event payload
  carries only {sessionId}, not roots, and the registry instance is owned by
  another extension; a worktree registered mid-session is seeded at its next
  session start. To be reported in the completion report.
- L3: Commits 9a72c8d (seed lib + tests) and 2752066 (wiring). Independent
  verification (gentle-ai-verify): S1/S3/S4 PASS, S2 FAIL on one clause —
  the staged-rename comparator was INVERTED (db first), so a failing sidecar
  rename could leave a torn db counted as an index. FIXED d1e000d: comparator
  flipped (sidecars first, db last) + crash-window test RED against the old
  order, GREEN after; firmlink-spelling advisory also fixed (realpathSync in
  the resolver test). Final suites 7/7 seed + 27/27 readiness + 11/11 lease
  + 33/33 tools + 4/4 daemon + 3/3 child-bootstrap, tsc zero codegraph
  errors. Native assess medium, no review due (writer self-verification
  stood; independent verifier exceeded it). CLOSED.
