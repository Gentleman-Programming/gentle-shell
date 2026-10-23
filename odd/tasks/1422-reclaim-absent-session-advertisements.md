# Fix: Reclaim conclusively-absent session advertisements before they exhaust discovery (#1422)

## Objective

Bounded, identity-checked session discovery must tolerate and safely reclaim validated presence records whose endpoints are conclusively absent, while retaining live, malformed, or unsafe records and failing closed on hostile input.

## Problem

`SessionPresenceRegistry.listActivations()` and `resolve()` counted every directory entry against `MAX_ENTRIES = 64` **before** filtering. An orphaned advertisement is a valid record whose Unix socket no longer exists: it is indistinguishable from an active peer until its endpoint is checked, yet a directory holding 65 such records failed with `SessionPresenceError` code `busy`, which the extension surfaced as `Error: session discovery is unavailable.` Two live sessions could therefore fail to discover each other whenever enough dead records had accumulated (observed profiles: 70 records / 64 missing sockets, 73 / 71, 199 / 199). `resolve()` additionally counted entries belonging to *other* sessions, so unrelated dead records blocked a single-id resolve and, through it, `orchestrator_send_message` to an already-known peer.

## Solution

- `lib/agents-session-transport.ts`:
  - Replace the boolean `advertises()` with `endpointState()`, returning `"present" | "absent" | "unsafe"`: `"absent"` is a conclusively missing endpoint (`ENOENT`/`ELOOP`); `"unsafe"` is present but a symlink, non-socket, or foreign-owned path; `"present"` is a same-user socket.
  - `listActivations()`: match the entry name first; for a validated record, reclaim only an `"absent"` endpoint through the existing `removeOwn()` (re-read, JSON-compared, dev/ino-guarded, never following a symlink) and continue; retain `"unsafe"`. Count only retained (`"present"`) advertisements against `MAX_ENTRIES`.
  - `resolve()`: match the requested id first, then count only matching entries, so records for other sessions no longer exhaust a single-id resolve.
- The reclaim reuses the exact stale-cleanup discipline the client already applies on send (`ActiveSessionClient.begin`), so listing is no longer strictly read-only but performs only the same conclusively-safe removal.

Safety argument: `ActiveSessionListener` binds its socket before publishing (test "listens before publishing presence and acknowledges one valid chunked notification"), so a published record whose endpoint is `"absent"` can only belong to a publisher that has died; a live session republishes under a fresh capability token, and removal is guarded against a rewritten file.

Non-goals / boundaries:

- Does not duplicate #1538/#1443: a socket file that still exists but has no listener is `"present"` under this `lstat` classification, so it is neither reclaimed nor filtered here; the connect-probe liveness check belongs to that fix.
- Does not change `resolve()`'s return contract (a matching record is still returned even when its endpoint is absent); the client's send path already reclaims on `ENOENT`/`ECONNREFUSED`. The existing "stale activation remains until later liveness cleanup" behavior and its tests are preserved.
- Windows named-pipe presence (#1846) is out of scope; this is the POSIX `SessionPresenceRegistry`.

## Tasks

- [x] T1: RED — `lists advertised peer IDs and reclaims only conclusively-absent records`, `safely reclaims orphaned advertisements beyond the discovery budget`, `resolves one session past unrelated advertisements beyond the discovery budget`, plus a retained-live budget guard.
- [x] T2: GREEN — `endpointState()` + reordered counting + orphan reclaim in `lib/agents-session-transport.ts`.
- [x] T3: Docs — `docs/gentle-shell.md`.
- [x] T4: Verification — focused suite, full unit suite, typecheck, runtime-modules check.

## Progress and Evidence

- RED: `tests/agents-session-transport.test.ts` — the new/updated cases failed for the right reasons: the missing record was not reclaimed (`Missing expected rejection`), 65 orphans reached `busy` at `listActivations` (`if (++count > MAX_ENTRIES)`), and unrelated entries reached `busy` on `resolve("target")`.
- GREEN: focused `tests/agents-session-transport.test.ts` 49/49; combined `agents-session-transport + orchestrator-discovery + windows-session-transport` 90/90.
- Verification: `node scripts/run-test-suite.mjs` → provider-contract PASS, runtime-harness PASS; unit-tests 6671 tests with only the pre-existing, environment-bound `installer-posix-bootstrap` (19) and `gentle-shell-bin` (4) failing, reproduced identically on the baseline worktree. `node scripts/check-types.mjs` → 0 diagnostics. `node scripts/build-runtime-modules.mjs --check` → runtime matches sources.

## Log

- L1 — 2026-10-13 · Fix authored for #1422 as the upstream half (option B) of the durable-reclamation work; the local view (`~/gentle-live-view`) already reclaims the same presence/catalog/transport stores.
