# Feature: CodeGraph cross-session init lock and sync lease

The runtime owns index creation and refresh now, but coordinates only within
one process: two sessions on one fresh project can both run `init -y`, and in
a daemon-less project one session's per-prompt sync can `unlock` another
session's live index lock and corrupt the index it is writing.

## Specs

- S1: Cross-session init lock — two sessions starting on the same fresh
  project never run two concurrent `init -y`: the first holds a lock in the
  shared locks dir; the second waits (bounded) and proceeds once the database
  file exists; it skips (fail-closed) when the lock is held by an unknown or
  still-live holder past the wait budget.
- S2: Sync lease — in a daemon-less project, a session runs the per-prompt or
  session-start `unlock`+`sync` only when it acquires a short-TTL lease; a
  live lease held by another session means zero CLI calls (no unlock, no
  sync), and the warm-up still runs. Fail-closed on unreadable lease state.
- S3 (from the approved plan): lock tokens live under
  `~/.codegraph/locks/<sha256(realpath(project))>.{init,sync}.json` (test
  dirs injectable), token `{ kind, pid, startedAt, expiresAt }`, staleness =
  pid dead or expired, acquired with an exclusive create, released
  best-effort.
- S4: The daemon-alive path is unchanged (sync-only, no lease, no unlock),
  and per-prompt in-process coalescing is unchanged.

## Tasks

- T1 (S3): RED unit tests for the lease/lock primitive (verdict matrix:
  free/live/stale/unknown; acquire/release; steal on stale; init lock wait:
  acquired/present/skipped) in `tests/codegraph-lease.test.ts`; implement
  `lib/codegraph-lease.ts`; GREEN; typecheck. Route: inline. Commit:
  7edcb89. DONE — 10/10 lease tests, tsc zero codegraph errors.
- T2 (S1, S2, S4): RED tests in `tests/codegraph-readiness.test.ts` —
  live sync lease planted ⇒ zero CLI calls but warm-up still runs; no lease ⇒
  unlock+sync as today; init lock held with db appearing ⇒ second session
  reports ok without running init; two real child processes racing init on
  one fresh project ⇒ exactly one `init -y`. Wire `locksDir` through
  `ReadinessInput`/`SearchSyncInput` into `prepareReadiness` and
  `syncBeforeSearch`; GREEN; typecheck; full codegraph test files. Route:
  inline. Commit: this work unit. DONE — RED observed on exactly the 5
  lease tests (race test showed `init 6048 | init 6047`: two concurrent
  inits today); GREEN 25/25 readiness + 10/10 lease + 33/33 tools + 4/4
  daemon + 3/3 child-bootstrap; tsc zero codegraph errors. Pinned existing
  behavior untouched (unlock-then-sync order, daemon-alive sync-only,
  coalescing, failed-unlock paths all still pass).

## Log

- L1: "commit first then go" (user, 2026-11-13 session) after approving the
  Group A plan ("Approve and start", "Group A only") for the gaps named in
  tmp/codegraph-side-by-side.md: cross-session init lock + sync lease.
- L2: T1 committed as 7edcb89; T2 committed as 7b7a2c9. Independent
  verification (gentle-ai-verify, 2026-11-13): S1 PASS, S2 PASS — verdicts
  with file:line evidence, re-check-after-acquire confirmed, race test
  reproduced; three non-blocking advisories recorded (stale-steal TOCTOU
  µs window, late release after TTL steal, 32-hex digest truncation) plus
  two durable probes — ADDED and committed as f4e38c9 (11/11 lease).
  Risk: item 4 (concurrency) — independent verifier RAN (exceeds the
  assess plan). Native assess risk medium, no review due. CLOSED.
