# Lean delegation context and evidence-budget rule (issue #1587)

Locator: `odd/tasks/lean-delegation-context.md` · Engram mirror: `odd/lean-delegation-context/tasks` (project `gentle-pi`)

Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1587 (`status:approved`)
Full study: https://github.com/Gentleman-Programming/gentle-ai/issues/5139
Branch: `feat/lean-delegation-context` (base `origin/main` 289cee5ba)

## Objective

Stop delegated subagents from loading the gentle-ai orchestrator-only managed `AGENTS.md`
blocks while keeping project conventions, and replace the file-count / tool-call delegation
triggers in the Gentle Shell prompt assets with the measured evidence-budget rule.

## Why (measured)

- Child explorer prefix: 86.8k tokens with context files vs 49.5k without; ~37k are
  orchestrator-only managed blocks. No cross-session cache reuse on claude-bridge.
- Forced delegation per question: ~140k weighted tokens (~89k lean); +46–65% tokens and ~3×
  wall time on targeted questions with no quality gain.
- Selective (evidence-budget) delegation: cost-neutral (±2%) with ~27k fewer parent tokens.
- Current rules: 0 delegations in controlled runs, even past the 4-file trigger.

## Scope and constraints

- Gentle Shell only. Provider-mirrored and byte-pinned contract text stays untouched.
- Children fail safe: if managed blocks cannot be filtered, keep today's behavior.
- Keep writer and verification delegation; keep human consent, RDD, and native authority.
- Orchestrator prompt stays within its 8 KiB budget.
- Preserve untracked `odd/tasks/herdr-shell-notifications.md` and `odd/tasks/tool-argument-watchdog.md`.

## Working policy for this feature (the rule being implemented)

- Inline reads only for one parallel batch (≤3 calls, ~≤10k tokens); larger mapping → one explorer
  with a ≤2k-token path:line handoff; 2+ non-trivial files → one writer; bounded command output.

## Mapped facts (explore muo79eso-6-318q)

- Pi `before_agent_start` exposes `event.systemPromptOptions.contextFiles` ({path, content}[]) as a
  per-turn mutable copy; Pi renders from the mutated options. pi-claude-bridge 0.9.0 keeps a
  reference to the same options object and rebuilds its appended prompt from its `contextFiles`.
- Children (`GENTLE_PI_AGENTS_CHILD=1`, lib/agents-runner.ts:207/:454) load the gentle-ai
  extension; its `before_agent_start` child path (extensions/gentle-ai.ts ~:9356) leaves
  contextFiles untouched today.
- Core triggers in assets/orchestrator.md ("4-file rule", "Long-session rule ~20 tool calls, 5
  exploratory reads") are pinned by tests/odd-routing-canonical-ratchet.test.ts,
  tests/odd-routing-contract.test.ts, tests/orchestrator-budget.test.ts (8 KiB, tiny headroom).
  fixtures/odd-routing-canonical.md is sha-pinned upstream canon: never edited locally.
- Local node_modules was pi-coding-agent 0.87.1 (lockfile 0.99.1); synced with
  `pnpm install --frozen-lockfile --ignore-scripts`. The 4 previously failing local test files
  now pass (4/9/17/59).

## Design decisions

- T1: in the child path of gentle-ai `before_agent_start`, replace
  `systemPromptOptions.contextFiles` (same options object) with copies whose orchestrator-only
  managed blocks are removed: `orchestrator`, `sdd-orchestrator`, `sdd-model-assignments`,
  `agent-routing` (they bind themselves to the orchestrator). Nested blocks not on that list
  (e.g. `remote-authorization` inside `agent-routing`) and all other blocks (`codegraph-guidance`,
  `engram-protocol`, unknown names) plus all unmanaged project text are kept. Malformed or
  unbalanced markers leave that file unchanged (fail safe). Primary sessions untouched.
- T2: Gentle Shell leads; local trigger anchors are updated intentionally (canon fixture
  unchanged, divergence tracked by gentle-ai#5139).

## Tasks

- [x] T1 — Lean child context: filter gentle-ai managed orchestrator blocks out of delegated
      children's context (+ tests, + measured prefix). Commit `302d0950d`.
- [x] T2 — Evidence-budget delegation rule in Gentle Shell prompt assets (+ contract tests). Commit `14bd23568`.
- [ ] T3 — Single PR closing #1587; merge commit after green CI (user-authorized).

## Checks

- Focused `node --experimental-strip-types --test <files>` per task.
- `pnpm run typecheck`, `pnpm run check:runtime-modules`, `node scripts/verify-package-files.mjs`.
- Measured child prefix before/after with a headless delegation (T1).

## Delivery

- Strategy: single PR (user decision). Merge commit after green CI and no conflicts (authorized
  2026-09-30). No release.

## Progress

- 2026-09-30: branch created; issue #1587 created and approved; mapping delegated
  (explore task muo79eso-6-318q, handoff under the ≤2k contract).
- Baseline child explorer prefix: 86.8k tokens (with context files), 49.5k (--no-context-files).
- T1: route delegated direct (writer trigger: new lib module + extension + tests); risk high
  (changes what every subagent sees) → writer self-verification + native review (RDD on) +
  live measurement of the child prefix.

- T1 attempt 1 (writer muo7u2od-7-tw8z): lib/child-context-files.ts + hook in gentle-ai.ts; unit
  RED/GREEN 23/23; 111/111 focused; typecheck/runtime/package checks pass. LIVE MEASUREMENT FAILED:
  real child still 87.7k. Diagnosis: in the isolated Gentle Shell home the launcher injects the
  gentle-pi package into the parent only (-e); children load only settings.json packages, so
  gentle-ai.ts never runs in the child (no gentle-ai custom entries in child session). Manual
  GENTLE_PI_AGENTS_CHILD=1 session with the package: 94.4k → 56.9k, so the filter logic works.
- T1 redesign (continued writer, task muo82w22-8-f4hz): dedicated extensions/child-context.ts
  passed to every child via the existing `extensionPaths` → `--extension` mechanism; gentle-ai.ts
  hook reverted. Lesson: unit tests did not model how children load extensions; live measurement
  is the acceptance check.

- T1 redesign result: extensions/child-context.ts + gentle-agents `childContextExtensionPaths`
  → `--extension` for every child; gentle-ai.ts untouched. RED: module-not-found / missing export;
  GREEN 20/20 + wiring 1/1. Writer: 327/327 focused; typecheck no regressions; runtime and package
  checks pass. Parent spot check: child-context-files + gentle-agents 180/180.
  LIVE: real delegated explorer children start at 56.9k and 57.9k tokens (baseline 86.8k/87.7k),
  −30k (−34%) per delegation; answers correct.
  Native review: lineage review-0b23f374b16c0bf8, medium, approved, acknowledged, authority burned
  (target sha256:8c82a8b1…). Advisory non-blocking: R3-001 WARNING extensions/child-context.ts:11-20,
  R3-002 WARNING tests/gentle-agents.test.ts:4311-4312, R3-003/R3-004 SUGGESTION.
  Commit `302d0950d` tree d6b83029… equals the reviewed tree. Authored ~500 lines (tests-heavy).

- T2 (route: delegated direct, writer trigger: 10 files; risk: medium, prompt text + tests):
  - Writer muo8calm-9-n5jm. RED: new cross-surface consistency test failed (`missing contract:
    **Evidence-budget rule**`); GREEN 193/193 focused. Full unit suite `tests/*.test.ts`:
    4289 tests, 4255 pass, 0 fail, 0 cancelled (34 skipped). typecheck no regressions; runtime and
    package checks pass. Rendered orchestrator prompt 7544 B at a 161-char root (budget 8192).
  - Canon fixture and AGENTS.md unchanged; ratchet updates local mirror anchors only (comment cites
    gentle-ai#5139). tests/package-manifest.test.ts:1621 regex updated (old wording now false).
  - Parent spot check: 54/54 (contract, budget, ratchet).
  - Native review: lineage review-dc09524924a05bf6, medium, approved. Advisory: R3 WARNING context
    backstop threshold at assets/orchestrator.md:56 (the model cannot observe its own context size
    directly → follow-up, relates to #1117); two SUGGESTIONs (ratchet semantics, readme not in the
    agreement test).
  - INCIDENT (parent): acknowledgement and commit were launched in parallel; STATUS saw an empty
    working tree (`empty_candidate_base_ref_required`) and the acknowledgement did not run. Recovery:
    `git reset --soft HEAD~1` of the unpushed commit (identical tree dac946aa), bound STATUS offered
    the exact acknowledge-approved, executed through the facade → authority burned (target
    sha256:0c6f1603…), then recommitted with the same message → `14bd23568`, tree dac946aa… =
    reviewed tree. Lesson: acknowledge strictly before committing, never in parallel.
  - Authored lines: +65 −34 = 99.
- Running authored total: ~600 lines (T1 ~500, tests-heavy; T2 99).

- T3: PR https://github.com/Gentleman-Programming/gentle-shell/pull/1590 (`type:feature`). First CI
  run on head 73c00efe2: all jobs green; verify `pnpm test` 4289 tests, 4255 pass, 0 fail.
  CodeRabbit (🟡 Minor, same spot as native advisory R3-002): the child-context wiring test built
  the expected path with `URL.pathname` (percent-encoding, `/C:/` on Windows). RED reproduced in a
  worktree under a path with a space (0/1); fixed with `fileURLToPath` → GREEN 1/1, file 160/160,
  typecheck no regressions. Native review lineage review-deab0e498746b6ac approved with no
  findings, acknowledged BEFORE committing → commit `31a04c252`, tree 375e42c3… = reviewed tree.

## Follow-ups

- Context backstop (~150k) relies on the model knowing its context size; consider a mechanical
  signal (relates to #1117).
- Gentle AI generated assets and canon: apply the same rule and child-context scoping
  (gentle-ai#5139).
- Parent prefix reduction (duplicated managed blocks, tool schemas) tracked in gentle-ai#5139.

## Next step

Wait for CI on the final head, merge commit if green and conflict-free.
