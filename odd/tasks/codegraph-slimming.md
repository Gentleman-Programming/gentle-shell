# Feature: codegraph-slimming

Implement all 17 findings of the 2026-11-15 read-only codegraph review (memory obs 4521) as 5 work units on `feat/improve-codegraph`. All behavior-preserving refactors plus one observable runtime unit (U2); no exports removed, no contract change.

## Specs

S1 (U1 — tool-wrapper slim), quoted from the approved review:
- "`extensions/codegraph-tools.ts:594-664` — five near-identical result blocks in `execute`: 3 success shapes (594-601, 628-634, 646-655) each doing `truncateOutput` → `indexExists ? excludeIndexLocally : undefined` → `withLocalExcludeNote(... "CodeGraph completed without output.")` → spread-details, and 2 failure shapes (635-642, 655-663) — extract `const finish = (output, extra) => …` and `const fail = (error) => …` closures inside `execute` — ~30 lines saved."
- "`extensions/codegraph-tools.ts:650-652` — dead condition: `parameters.operation === CODEGRAPH_OPERATION.INIT || indexExists(cwd)` is always true — every path of the non-INIT block (572-643) already returns, so this tail is init-only; simplify to `const localExclude = excludeIndexLocally(cwd, gitRun);` — 2 lines + one never-taken branch removed."
- "`extensions/codegraph-tools.ts:282-312` — `commandArguments` QUERY and EXPLORE cases differ only in the flag name (`--limit` vs `--max-files`) — compute the flag once and share the array literal — ~8 lines."

S2 (U2 — hot-path fs + buffer parity), quoted:
- "`extensions/codegraph-tools.ts:149-157` — hot-path sync fs: `realpathSync(homedir())` + `realpathSync(tmpdir())` re-run on every tool call (154) before the per-turn `workspaceVerified.has` check (157) — hoist both to module-level consts (or move the 157 check above 151-155: a verified path already passed those checks this turn) — 3 redundant syscalls per call after the first in a turn."
- "`extensions/codegraph-tools.ts:505` + `extensions/codegraph-tools.ts:596` — `indexExists(cwd)` (statSync) runs twice per successful query: once inside `triggerSearchSync`, again on the daemon-ok path — thread the boolean through, or drop the 596 re-check (a live daemon answering ok implies the index exists) — 1 statSync per query."
- "`extensions/codegraph-tools.ts:234-257` — `excludeIndexLocally` re-reads the exclude file plus `mkdirSync`+`realpathSync` on every successful call (comment at 233 says git-once/file-every-call is deliberate) — a per-turn `present` memo next to `excludeApplied` would keep the first-check semantics while saving 4 sync fs calls per query — runtime only, ~3 lines."
- "`extensions/codegraph-tools.ts:79` — limit inconsistency: CLI `PROCESS_MAX_BUFFER = 200_000` bytes can abort (maxBuffer → "CodeGraph failed to run") on multibyte output the daemon path accepts (`MAX_REPLY_CHARS = 1_000_000`, daemon.ts:20) and would truncate to 100 K chars anyway — align the CLI buffer with the daemon cap — robustness parity, 1 line."

S3 (U3 — readiness slim), quoted:
- "`lib/codegraph-readiness.ts:276-293` vs `lib/codegraph-readiness.ts:395-413` — the daemon-less refresh (codegraphWritingIndex check → tryAcquireSyncLease → held-live fallback → unlock → `sync -q` → release) is written twice, once in `prepareReadiness` and once in `syncBeforeSearch`, differing only in failure reporting (ok=false vs onFailed) — extract one `daemonlessRefresh(cwd, {run, locksDir, sink})` returning a discriminated outcome both callers map — ~18 lines."
- "`lib/codegraph-readiness.ts:194-198` — provably-constant tail: `return skipsSession(env, reason)` can only see `CHILD_ENV !== "1"` and `reason !== "reload"` (both returned earlier), so it is always `false` — replace with `return false` (keep `skipsSession` exported; tests use it, codegraph-readiness.test.ts:133-136) — clarity, 1 line."
- "`lib/codegraph-readiness.ts:110-114` and `lib/codegraph-readiness.ts:484-488` — win32/posix spawn branching written twice (`codegraph ${…JSON.stringify…}` string vs arg-array spawn, shared `cwd: tmpdir(), env, windowsHide`) — extract one `spawnCodegraph(args, stdio)` helper — ~10 lines."
- "`extensions/codegraph-tools.ts:254`, `lib/codegraph-readiness.ts:343`, `lib/codegraph-readiness.ts:417` — the same `error instanceof Error ? error.message.split("\n")[0] : String(error)` idiom (twice followed by `.slice(0, 200)`; `gitFailureDetail` at tools.ts:130-136 is a near cousin) — one `firstLineOf(error, max)` helper — ~6 lines."
- "`lib/codegraph-readiness.ts:257-260` vs `lib/codegraph-readiness.ts:380-384` — identical `lastSyncInfo`/`sink` closure pair in `prepareReadiness` and `syncBeforeSearch` — extract `lastInfoSink()` returning `{sink, get}` — ~6 lines."
- "`lib/codegraph-readiness.ts:465-466, 497-499` — stray out-dented lines inside `runCodegraph` (`let exitCode`, `let stderrTail`, the stderr "data" body) — cosmetic re-indent only — 0 lines."

S4 (U4 — daemon share + fixes), quoted:
- "`lib/codegraph-readiness.ts:128-146` vs `lib/codegraph-daemon.ts:193-240` — MCP conversation loop duplicated: `warmUpDaemon`'s stdout handler and `ask()` both hand-roll buffer/newline/`parseMcpReply`/`mcpReplyKind` staging (daemon.ts already exports every piece for exactly this) — export a shared line-buffered MCP conversation from codegraph-daemon.ts and drive both — ~20 lines."
- "`lib/codegraph-daemon.ts:102-103` vs `lib/codegraph-daemon.ts:115-116` — liveness predicate `entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath)` duplicated in `daemonFor` and `daemonSockets` — extract `liveDaemons(cwd, registryDir)`; `daemonFor` = first of it — ~4 lines."
- "`lib/codegraph-daemon.ts:33` — stale comment: \"Test seam: exercised only by the test suite; not part of the tool's runtime surface\" sits above `registeredDaemons` (35), but `daemonFor` (100) and `daemonSockets` (113) call it in production — only the export is test-only; reword to match `resetDaemonRegistryMemo`'s accurate phrasing — 0 lines, removes a false claim."

S5 (U5 — first-gate cleanup), quoted:
- "`extensions/codegraph-first-gate.ts:31-35` — unreachable guard: `try { credited = false; } catch { … }` — a boolean assignment cannot throw; drop the wrapper (the try/catches in `tool_execution_end`/`tool_call` read hostile payloads and stay justified) — ~4 lines."

## Tasks

- T1 — S1 — U1 tool-wrapper slim (tools.ts) — inline — commit: 68a6466
- T2 — S2 — U2 hot-path fs + buffer parity (tools.ts) — inline — commit: 2ebcc4e
- T3 — S3 — U3 readiness slim (readiness.ts + helper import) — inline — commit: _pending_
- T4 — S4 — U4 daemon share + liveness + comment (daemon.ts, readiness.ts) — inline — commit: _pending_
- T5 — S5 — U5 first-gate dead try/catch — inline — commit: _pending_
- T6 — S1-S5 — close: typecheck, full codegraph test sweep, RDD assess, diff report — inline — n/a

## Log

- L1 (user, verbatim): "review codegraph code and teel if there is something can be optimized and/or slimed"
- L2 (user, verbatim): "plan to address all findings"
- L3 (user decision, 2026-11-15): approved "Full plan U1-U5 (Recommended)" — all 5 units, work-unit commits on feat/improve-codegraph, focused tests per unit.
