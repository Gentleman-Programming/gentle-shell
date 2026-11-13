# Feature: codegraph-optimizations

Implement the seven optimization items from the branch audit (tmp/codegraph-branch-analysis.md,
audit of 2026-11-13) as six reviewable work units on the `codegraph` branch. Scope decision:
all seven items, six commits (hygiene items share one commit), user chose Start now.

## Specs

- S1 (git spawns): One git interrogation per cwd per turn. The first codegraph tool call in a
  turn may spawn git (`rev-parse --show-toplevel`, `rev-parse --is-inside-work-tree`,
  `rev-parse --git-path info/exclude`); later calls in the same turn spawn none. The existing
  `turn_start` hook resets the caches. Injectable git seam through `createCodeGraphTool`
  options, same pattern as `daemonExplore`/`warm`/`syncRun`.
- S2 (registry scan): `warmUpDaemon` reads the daemon registry once per call (today:
  `daemonFor` twice, readiness.ts:36/:41); `registeredDaemons` results memoized per canonical
  project for a short window with a test reset seam.
- S3 (dead branches + exports): remove unreachable `child === undefined` (readiness.ts:61);
  keep `daemonFor` guards (canonical→realpathSync can throw if a cwd vanishes) but treat them
  consistently; demote exports with zero consumers (production and test); annotate
  test-consumed exports as test seams.
- S4 (fixture + stat core): one parameterized fakeRegistry helper replaces the 6 `record.json`
  copies in tests/codegraph-readiness.test.ts (copies differ: root/socket/pid/dead variants);
  `indexState` (unknown) and `indexExists` (false) share one stat core while PRESERVING their
  different error semantics.
- S5 (daemon-skip flag): after a full failed chain against a WEDGED daemon (the post-warm attempt
  times out), the daemon is skipped for that cwd until the next turn_start (clearSearchSync);
  within that turn the CLI answers directly, and the flag cannot be cleared by a successful
  daemon answer because the daemon is not asked again that turn. An unavailable daemon (never
  started, died, or no project loaded) never sets the flag: the warm-up exists to start one,
  and the next query re-asks it.
- S6 (MCP dedup): one shared MCP line-conversation helper serves both `ask()` (daemon.ts) and
  `warmUpDaemon` (readiness.ts): same initialize→tools/call staging, same isError/text
  parsing, single NO_PROJECT_TEXT. Hard constraint: zero behavior change, zero existing-test
  edits.
- S7 (verification contract, every unit): the 5 codegraph test files green via `bun test`;
  `bun x tsc --noEmit` error count unchanged from baseline 16 (all pre-existing, none in
  codegraph files); the pending AGENTS.md working-tree edit and untracked bun.lock stay
  untouched and out of every commit.

## Tasks

- T1 (S1): perf(codegraph): cache git interrogations per cwd per turn — inline — commit: f121d12
- T2 (S2): perf(codegraph): scan the daemon registry once per window — inline — commit: 10e8cd8
- T3 (S3): chore(codegraph): drop dead branch, unify guards, narrow exports — inline — commit: 70d639c
- T4 (S4): test(codegraph): shared fakeRegistry helper and stat core — inline — commit: ba870a1
- T5 (S5): feat(codegraph): skip a failed daemon until the next turn — inline — commit: c6248d5
- T6 (S6): refactor(codegraph): one MCP line-conversation helper — inline — commit: —

## Log

- L1: "plan to implement the  optimizations" (verbatim; the seven items are those of
  tmp/codegraph-branch-analysis.md, re-verified post-commit 275206675 in tmp/ben2-r*.txt)
- L2: "benefits of the seven optimization items" — answered read-only (risk/benefit table)
- L3: "someone brokes the code ?" — no: commits 9a72c8d2d + 275206675 landed the planned seed
  slice; 5 codegraph suites green; 16 pre-existing tsc errors in untouched files
- L4: "going back: any of this optimizations can broke the code or not" — answered read-only
- L5: "and the seventh ?" — all seven audit items are covered; items 5+6 share commit T3
- L6: scope selection: "All items, 6 commits (Recommended)" + "Start now (Recommended)"
- L7: T1 implemented — git asked once per cwd per turn; gates: tools 34 pass, 5-file suite 0 fail, tsc 16 pre-existing unchanged; Risk: none (shared helpers pinned by the existing suite; the only behavior change is the cached-turn rule, pinned by the new test)
- L8: T2 implemented — registry read once per project per window + warmUpDaemon single daemonFor; gates: daemon file pass, 5-file suite pass, tsc 16 unchanged; Risk: none (stale liveness within 1s degrades to the existing CLI fallback)
- L9: T3 implemented — unreachable spawn guard removed; the one unguarded daemonFor call (runCodegraph's project line, the unit text's "maybeRewarm" quote) wrapped with the not-alive fallback to realpathSync(cwd), while the maybeRewarm and syncBeforeSearch daemonFor calls were already guarded at HEAD and stay as-is; exports audited 7 demoted, 2 annotated as test seams, evidence tmp/u3-export-audit.txt; gates: suite 84/0, tsc 16 unchanged; Risk: none (behavior-preserving chore; suite is the differential; no new RED test for that reason)
- L10: T4 implemented — 6 record.json fixture copies replaced by one parameterized helper (values preserved per copy); indexExists delegates to indexState === "present" (verified equivalent for present/absent/unknown); gates: readiness file 27/0, suite 84/0, tsc 16 unchanged; Risk: none (test-only dedup plus behavior-identical delegation; suite green pre/post is the differential; no new RED test for that reason)
- L11: T5 implemented — a wedged daemon (post-warm attempt timeout) is skipped per cwd until the next turn; unavailable daemons never set the flag so the warm-then-retry design keeps its original pin (S5 narrowed to the audit's wedged case; the conflicting pre-existing pin was left untouched); gates: tools 35/0, suite 85/0, tsc 16 unchanged; Risk: none (behavior change pinned by the new test; the unavailable path keeps its original pin)
- L12: T6 implemented — shared: McpReply type + parseMcpReply (one JSON-RPC reply line) and mcpCallText (the tools/call failure judgment incl. the single NO_PROJECT_TEXT, now read only by that helper); transport state machines untouched; gates: suite 85/0 pre/post, tsc 16 unchanged; Risk: none (pure refactor; suite is the differential; no test edits)
