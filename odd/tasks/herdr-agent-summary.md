# Herdr active-agent summary

Locator: `odd/tasks/herdr-agent-summary.md`; branch `feat/herdr-agent-summary`.

## Objective / why
Expose the active Todo title in Herdr's Agents sidebar without another model call or changing lifecycle authority.

## Scope / constraints
User-approved refinement supersedes the MVP phase/tool projection: only `◐` plus `in_progress` Todo title, at most two display-cell-bounded rows. Source `gentle:activity` owns `summary`/`summary2`, not semantic state. No prompts, arguments, output, notes, fallback tools or ODD labels. No personal config, managed bridge, live Herdr, reload, sync, dependencies, commits, pushes or PRs. One sequential writer; independent parent verification follows.
User explicitly approved 500–600 total authored lines (previous estimate 383), without code golf. Package worktree and first config row were already selected; parent owns adding the second row and any activation.

## Tasks / acceptance
- [x] T1 — Pure task-only projection: malformed/empty clears, sanitized Unicode, words/graphemes, at most two rows, last-row ellipsis and combined 256-byte budget.
- [x] T2 — Cached geometry: bounded 256-KiB session snapshot beside an absolute socket path, root width minus five, five-second cache, conservative 24-column fallback; injected columns in extension tests.
- [x] T3 — Root TUI extension: no phase/tool dependency, serialized latest-only transport, timeout/offline containment, TTL 30s/refresh 10s, atomic unused-row and boundary cleanup.
- [x] T4 — Document separate rows `['$summary'], ['$summary2']`, persisted resize lag and unsupported-layout limitation; focused checks pass.

## Verification
Strict TDD explicitly activated by parent. Exact isolated serial runner:
`env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_BIN_PATH NODE_OPTIONS=--max-old-space-size=1024 node --experimental-strip-types --test --test-concurrency=1 tests/herdr-activity.test.ts tests/gentle-herdr-activity.test.ts`.
RED before production: 4/14 passed; 10 intended failures exposed old phase/tool fallback, old signature, missing geometry and missing second-token clear. GREEN: 14/14 passed. Triangulation RED: 14/15 passed, malformed successful Todo retained `◐ valid`; corrected snapshot handling then GREEN: 15/15 passed. Transport and snapshot IO were stubbed only, never live Herdr or real user data. Unicode, growth-after-stat bounds, cache/fallback, long-to-short atomic clear, root/children, ownership, offline and ordering covered.
Prior parent evidence, not rerun here: focused launcher/child checks passed, generated-runtime check passed (8 runtime checks); type ratchet has pre-existing 223 vs 200 diagnostics. This TS refinement has clean focused editor diagnostics. No new type-baseline claim.

## Progress / next step
Reconciled cancelled-writer bytes: production was still phase/tool MVP; partial RED tests existed. Preserved unrelated launcher-test changes and node_modules symlink. Final authored count after the nonblocking-open correction: 578 lines in the six scoped surfaces (548 new-file lines + 30 documentation additions); 595 including 17 preserved launcher-test additions. Within the approved 500–600 total.
Geometry is persisted, not instantaneous: snapshot may lag resize five seconds and cache another five. Fallback/layouts cannot guarantee exact live sidebar width. Pathological graphemes exceeding the shared byte budget become ellipsis rather than leaking combining marks.
Native review is unavailable without managed-asset work; no sync attempted. Parent owns independent verification, second config row and delivery. Engram mirror remains parent-owned: no validated memory project was supplied.

Independent FIFO finding resolved: numeric `O_RDONLY | (O_NONBLOCK ?? 0)` avoids waiting for FIFO writers (including symlink targets), then existing fstat rejects non-files and finally closes the descriptor; missing platform constants are omitted for Windows compatibility. Contract regression (no live FIFO/Herdr): RED 15/16, expected numeric flags but observed `"r"`; GREEN 16/16 with the exact isolated serial runner above. Regression verifies fallback 24, no non-file read and exactly one close; existing 256-KiB bound, five-second cache and Unicode/two-row/256-byte/icon checks remain green.
