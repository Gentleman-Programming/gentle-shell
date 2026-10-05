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
- [x] T5 — PR #1705 corrections: enforce each token's 80-scalar cap before wrapping, preserve non-forced clear during active transport, honor `HERDR_BIN_PATH`, remove Arabic Letter Mark, and avoid word-boundary truncation when a hard break preserves the full title. Document the two-space prefix and normalization; isolated serial regressions pass.

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

## PR #1705 correction evidence
User authorized the five validated fixes plus the documentation precision change, retaining cached `delivery_strategy=single-pr`; no chain or size-exception choice was added. Parent reported a 16/16 read-only baseline and green prior CI; those results did not invalidate the counterexamples. Correction forecast was 80–150 authored lines, without code golf.
With the exact isolated serial runner above, five new regressions first produced RED 16/21 (five intended failures): 100 ASCII characters stayed in one overlong token, a fitting hard-break title was ellipsized, U+061C survived, a non-forced clear was lost after prior clear plus in-flight activity, and transport ignored the explicit executable. Minimal corrections produced GREEN 21/21.
Initial GREEN also exercised UTF-16-versus-scalar emoji and low-width combining-grapheme cases. Subsequent triangulation added exact 80-scalar row boundaries and a full title at exactly 256 combined token bytes. The latter exposed private LF incorrectly consuming a token byte: RED 20/21, then GREEN 21/21 after excluding framing from the shared budget. Prefixes and ellipsis still count, graphemes remain intact, and actual overflow still truncates only the final row. Non-ASCII wrapping, no-task/root/child/TTL/geometry guards, serialization, offline stubs and PATH fallback remain covered.
Only projection/publisher/transport, focused tests and reference/task docs changed; geometry/cache/FIFO handling, extension lifecycle and managed bridge were not edited. All transport and geometry checks used stubs; no live Herdr, reload, config, sync or delivery action occurred. Type ratchet and broad suites were not rerun; the previously reported 223-vs-200 SDK diagnostics remain historical, not a new baseline. The correction patch is 120 additions plus 20 deletions across four files; isolated `git diff --check` passed. The pre-existing untracked dependency symlink was preserved. Parent owns independent verification, Engram mirror, commit/push/replies/resolution and any activation; there is no post-change UI claim.
