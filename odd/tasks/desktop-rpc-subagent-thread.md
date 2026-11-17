# Desktop RPC: read a subagent's bounded activity thread over Desktop RPC

Implements #3323 on branch `feat/desktop-rpc-subagent-thread`. Delivery: single PR closing #3323. Test runner: `node --experimental-strip-types --test` (`pnpm test`), plus `pnpm run typecheck`.

## Specs

- S1 (#3323, Proposed outcome, verbatim): One read-only method on the subagents slice:
- S2 (#3323, Proposed outcome, verbatim): `get_subagent_thread { id, sinceVersion?: number }` → `{ id, version, items: [...], dropped, truncated }`. Items use the exact projection and bounds of `gentle-agents.activity/v1`, so the widget and the method never disagree. `sinceVersion` returns only items newer than the client's last read; `dropped` reports items the store evicted.
- S3 (#3323, Proposed outcome, verbatim): Ownership: only subagents whose parent session is the calling session, the same rule `list_subagents` and `cancel_subagent` apply. Anything else answers `not_found`; `agents_unavailable` when the owner is not loaded.
- S4 (#3323, Proposed outcome, verbatim): Served through the existing `DesktopAgentsService` seam (add a `thread(id)` read next to `read`/`cancel`), not a new channel.
- S5 (#3323, Proposed outcome, verbatim): The docs state that tool args and output are the subagent's own data and can contain whatever its tools printed, as #3309 does for job output.

## Tasks

- T1 [S1,S2,S3,S4,S5] Desktop RPC slice: owner seam, method(s)/event, docs in `docs/desktop-rpc.md`, tests. Route: delegated writer (Writer trigger a: parallel independent units in separate worktrees). Status: done. Commit: 9f7b4f3f2.
- T2 [S1,S2,S3,S4,S5] Push, PR closing #3323 with `type:feature`. Route: parent. Status: done — PR #3334.

## Log

- L1 (2026-11-16, user): "no, vamos a hacer los RPCs siempre de la mejor manera posible, vamos a crear los issues, aprobarlos y hacer los pr" — scope chosen: "Set recomendado (Recommended)".
- L2: #3323 approved (`status:approved`). Specs above quote its Proposed outcome.
- L3 (decision, S2 `sinceVersion`): `TaskStore` keeps one `version` per thread (`withItems` bumps it on every change) and a cumulative `dropped` count, but no per-item version; items also change in place (streamed text merges into the last item, tool items receive output/end later). Adding per-item versions would change the persisted thread shape (`restore`/history), a high-risk change not requested. Closest safe behavior: `sinceVersion === version` returns `items: []` (unchanged since the client's last read); any other value returns the whole bounded window, which is guaranteed to contain every changed item. `dropped` is the store's own eviction count verbatim; `truncated` is true when the store holds more items than returned (40-item window or 256 KB halving). Documented in `docs/desktop-rpc.md`.
- L4 (decision, S4): `DesktopAgentsService.thread` is optional in the adapter shape so existing fake adapters (tower, feed tests) still discover; the bridge answers `agents_unavailable` when it is absent.
- L5 (evidence): RED observed with lib/extensions stashed (`SyntaxError: ... does not provide an export named 'parseDesktopAgentThread'`, 1 fail). GREEN: `tests/desktop-rpc*.test.ts` 185 tests, 184 pass, 1 fail = known Windows 0o600 env failure (`desktop-rpc-permissions.test.ts:191`, fails identically on base); `tests/agents-rpc-publisher.test.ts` pass; maintainer probe (subagent/design/jobs) 3/3 pass; `pnpm run typecheck` 0 diagnostics; `pnpm run check:runtime-modules` pass; `node scripts/verify-package-files.mjs` pass. Importers of changed modules (25 files, `--test-force-exit`): 792 tests, 774 pass, 16 fail = known Windows base failures (desktop-feed 3, desktop-feed-actions 3, desktop-feed-actions-guards 3, gentle-agents 7).
- L6 (evidence, verifier follow-up): independent verifier found no blockers. Its 8 probes added to `tests/desktop-rpc-agents.test.ts` (relative imports, helpers prefixed `probe*`) and a docs limit line that tool names are not length-capped (follow-up for widget and RPC together). Commit 87aa54e05. `tests/desktop-rpc-agents.test.ts` + `tests/agents-rpc-publisher.test.ts`: 74/74 pass; `tests/desktop-rpc*.test.ts`: 193 tests, 192 pass, 1 fail = known 0o600 env failure; `pnpm run typecheck`: 0 diagnostics.
- L7 (2026-11-16): Native review (risk, reliability, readability) approved and acknowledged; advisory notes listed in the PR. PR #3334 opened.
