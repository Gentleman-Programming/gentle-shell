# Desktop RPC: list sessions and switch by id over Desktop RPC

Implements #3320 on branch `feat/desktop-rpc-sessions`. Delivery: single PR closing #3320. Test runner: `node --experimental-strip-types --test` (`pnpm test`), plus `pnpm run typecheck`.

## Specs

- S1 (#3320, Proposed outcome, verbatim): Two Desktop RPC methods, discovered through `capabilities`:
- S2 (#3320, Proposed outcome, verbatim): `list_sessions { scope?: "project" | "all", limit?: number (1–50, default 20), cursor?: string }` → `{ sessions: [{ id, name?, modified, messageCount?, firstMessage (≤ 200 chars), project (display name, never a path), current: boolean }], nextCursor? }`, newest first. It resolves the session directory exactly as the runtime does (custom `sessionDir` included). It never returns a file path, a cwd, or full message text.
- S3 (#3320, Proposed outcome, verbatim): `switch_session { id }` resolves the id through the owner (`findById`) and switches with the command context's `switchSession`. Errors: `not_found` when the id does not resolve in the requested scope, `invalid_request` for bad params, `sessions_unavailable` when no command context is bound. Switching to the current session is a no-op that answers `changed: false`.
- S4 (#3320, Proposed outcome, verbatim): A switch starts a new session, so the router's event `sequence` resets with the new session as it does for Pi's own `switch_session`; the docs state this.

## Tasks

- T1 [S1,S2,S3,S4] Desktop RPC slice: owner seam, method(s)/event, docs in `docs/desktop-rpc.md`, tests. Route: delegated writer (Writer trigger a: parallel independent units in separate worktrees). Status: done. Commit: b3a15cfb0.
- T2 [S1,S2,S3,S4] Push, PR closing #3320 with `type:feature`. Route: parent. Status: pending.

## Log

- L1 (2026-11-16, user): "no, vamos a hacer los RPCs siempre de la mejor manera posible, vamos a crear los issues, aprobarlos y hacer los pr" — scope chosen: "Set recomendado (Recommended)".
- L2: #3320 approved (`status:approved`). Specs above quote its Proposed outcome.
- L3 (T1, writer decisions): (a) `switch_session` accepts an optional `scope` ("project" default | "all") because S3 says "`not_found` when the id does not resolve in the requested scope" and an id listed with `scope: "all"` from another project cannot be resolved by project-only `findById`; "all" falls back to the exact id in Pi's `listAll` listing. (b) Pi's `switchSession` fires `session_shutdown` (stopping the old router) before it returns, so the old router cannot publish the response; the slice answers through `withSession` on the replacement context with the original `requestId` (the extension captures it synchronously before the router dispatches). Proven against the installed runtime by the new maintainer probe. (c) A switch cancelled by a `session_before_switch` handler answers `{ id, changed: false, cancelled: true }`; a refused switch (missing cwd) answers `sessions_unavailable` with a fixed message. (d) `modified` is epoch milliseconds, matching the other slices. (e) A switch during a streaming turn follows Pi: `teardownCurrent` aborts and persists the active turn first; documented. (f) Pi APIs used (`SessionManager.list/listAll/findById`, `ctx.switchSession` with `withSession`) predate 1.2.0 per the changelog; the bridge still shape-checks them and the session manager getters at runtime and degrades to `sessions_unavailable`.
- L4 (T1 verification, 2026-11-16): RED observed first (`tests/desktop-rpc-sessions.test.ts` failed: modules missing). GREEN: `node --experimental-strip-types --test tests/desktop-rpc-sessions.test.ts` 19/19 pass; `tests/desktop-rpc*.test.ts` 189/191 pass, 1 known Windows env failure (`desktop-rpc-permissions.test.ts:191`, 0o600 mode) and 1 load flake in `desktop-rpc-agents.test.ts` (32/32 pass on two isolated reruns); `tests/maintainer/desktop-rpc.maintest.ts` 9/9 pass, including the new real-runtime list + switch probe; `desktop-feed-plan-profiles` 14/14; `desktop-feed-actions` 21/24 and `desktop-feed` 17/20 with the same Windows path/mode/symlink failures and the same non-exiting `desktop-feed` process on the origin/main extension; `pnpm run typecheck` 0 diagnostics; `pnpm run check:runtime-modules` ok; `node scripts/verify-package-files.mjs` ok.
