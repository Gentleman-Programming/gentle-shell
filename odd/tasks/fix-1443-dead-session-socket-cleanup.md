# Fix #1443: Reclaim dead session sockets and suppress ghost peer advertisements

## Objective

Fix Issue #1443 in `lib/agents-session-transport.ts` so that dead sessions with surviving orphaned socket files (e.g. from `SIGKILL`, crash, abnormal exit) are not falsely advertised by `orchestrator_list` as active peers, and orphaned socket endpoints are properly unlinked during stale cleanup.

## Problem

`SessionPresenceRegistry.advertises()` previously evaluated candidate liveness using filesystem `lstat` alone (`stat.isSocket()`). Because UNIX domain socket files survive abnormal terminations (e.g., `SIGKILL`, crashes) where `net.Server.close()` never runs:
1. `orchestrator_list` continues advertising dead sessions as active peers indefinitely.
2. In the client error path (`ActiveSessionClient`), encountering `ECONNREFUSED` called `this.registry.removeOwn(record)`, which deleted the presence `.json` record, but left the orphaned `.sock` file in `paths.sockets` indefinitely.

## Scope

- In `lib/agents-session-transport.ts`:
  - In `advertises(record)`: probe socket connectivity using a bounded, non-blocking connection probe (`connect`). If `ECONNREFUSED` or unreachable, do not advertise (`return false`) and prune stale presence/endpoint.
  - In `removeOwn(record)`: when removing a presence record, also unlink the matching `record.endpoint` socket file if present and owned by the same user, ensuring dead sockets are garbage-collected and not leaked in `paths.sockets`.
- In `tests/agents-session-transport.test.ts`:
  - Add regression tests proving dead sessions with surviving socket files are not advertised.
  - Add regression tests proving client stale cleanup unlinks both the presence record and the dead `.sock` file upon `ECONNREFUSED`.
- Run typecheck and focused test suites.

## Constraints

- Strictly follow Strict TDD Mode: write failing tests first (RED), observe failure, then implement fix (GREEN).
- Preserve existing security invariants: private directory modes, path validation, token checking, non-blocking probes with bounded timeouts.
- Technical artifacts remain in English. Conventional commits only.

## Tasks

- [x] **T1 — Write failing regression tests for dead session socket advertisement and endpoint unlinking (RED).**
- [x] **T2 — Implement socket liveness probe in `advertises` and endpoint cleanup in `removeOwn` (GREEN).**
- [x] **T3 — Full verification and typecheck.**
