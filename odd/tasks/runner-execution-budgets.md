# Runner execution budgets (per-subagent turn and token ceilings)

Adds optional `max_turns` and `max_total_tokens` to the subagent runner, enforced from the
same RPC event stream the stall watchdog already consumes. Opt-in: with no config, the runner
behaves exactly as it does today. Closes the enforceable-boundary gap of gentle-shell#1125 and
its narrower sibling #1823.

## Specs

S1. **Build the PR as an upstream-ready change.** Request verbatim: *"dale con el PR"*.
    One reviewable slice for `Gentleman-Programming/gentle-shell`, no unrelated edits.
S2. **Evidence for every claim.** Request verbatim: *"evidenciemos todo"* and *"con evidencia
    relevante"*. Every number in this document and in the PR description is measured, and the
    reproduction ships with the change so the claim can be re-run rather than trusted.
S3. **Senior technical quality.** Request verbatim: *"construyelo con una calidad tecnica
    Senior"*. Test-first with RED observed before the fix, no new failure modes, reuse of the
    existing termination path, docs updated with the behavior change, and no regression for
    users who configured nothing.
S4. **Include-ready.** Request verbatim: *"detallalo con evidencia relevante y con pautas bien
    pensadas de la solucion para que lo incluyan en gentle-shell"*. The PR must state the
    problem, the measurement, the minimal design, the declared cost, and the policy question
    the maintainer owns.

## Design

Decisions below are the author's, not requirements quoted from the user; each carries its
rationale and its declared cost.

**D1 — Two optional keys in `subagents.json`, snake_case like the rest: `max_turns` and
`max_total_tokens`.** Absent or invalid means no limit, i.e. today's behavior. Rationale:
`AgentsConfig` is passed to `new AgentRunner(...)` as its `RunnerLimits`
(`extensions/gentle-agents.ts:1014`), so extending the one interface reaches the runner with no
plumbing at all. Declared cost: opt-in means a user who configures nothing gains nothing today;
choosing a default is a policy decision that needs the maintainer's own data.

**D2 — Enforce in `receive()`, after the events of a frame are applied to the store.** Rationale:
`TaskRecord.turns` is already incremented on `TURN_END` and `TaskRecord.tokens` on `USAGE`
(`lib/agents-protocol.ts:431`, `:443`), so the counters the budget reads are the counters the
card already shows. No second accounting path can drift from the displayed one.

**D3 — Reach the ceiling, stop; reuse `TASK_STATUS.TIMED_OUT` and `requestStop`.** Rationale:
a ceiling that can be crossed by one more turn is not a ceiling. Reusing the existing stop path
(SIGTERM, process-group confirmation, slot release, `onFinish`) means the budget introduces no
new termination mechanism and therefore no new failure mode. Declared cost: a child cut at the
boundary returns no final report; the error text says exactly which budget was reached and at
which `lastStep`, so the parent can re-delegate the remainder.

**D4 — No special case for a task waiting on a human answer.** The first design exempted a
`WAITING` task, reasoning that stopping it would erase a question the operator is reading. A
test proved that branch unreachable: `store.apply` already resumes a waiting task on any
non-`ASK` event (`lib/agents-protocol.ts:426`), and only an event that changes `turns` or
`tokens` can cross a ceiling, so the crossing frame is itself the resume. The branch was
removed rather than kept as a reassuring but dead one, and a test now pins the real contract.

**D5 — The token budget fails open.** It only fires on tokens the provider actually reported, so
a model whose gateway reports `usage: 0` (the `supportsUsageInStreaming` family of bugs) never
triggers it. `max_turns` is the robust lever and does not depend on provider telemetry. This is
documented rather than worked around: inventing token accounting the provider did not report
would make the budget fire on fiction.

**D6 — Out of this slice.** Per-task budgets as tool parameters, a soft warning threshold, and
any default value. Each is a separate decision with a separate review surface.

## Evidence

Measured with `node scripts/measure-subagent-carry.mjs` (7-day window, 448 subagent runs with
activity, one workstation). The window slides, so a later run reports slightly different digits
for the same magnitude; the instrument is the reproducible part, not the number.

Carry load is measured as: for each child, sum the bytes of persisted `toolResult` content, and
attribute the running total to every later assistant call in that same child. That is what the
provider bills on each turn, as opposed to the one-time insert cost.

| metric | measured |
|--------|----------|
| children with activity | 448 |
| unique tool-result content | 94,775,839 B (~23.7M tokens at 4 B/token) |
| cumulative carry load | 4,175,948,640 B (~1,044M tokens) |
| amplification | 44.1x |
| tokens recorded by the same runs | 881,689,495 |
| heaviest single child | 475 tool calls, 478 turns, 277,045,190 B carry load |

The multiplier is not result size: built-in tools already cap output at
`DEFAULT_MAX_LINES = 2000` / `DEFAULT_MAX_BYTES = 50 * 1024` (`core/tools/truncate.js:10-11`),
and observed maxima cluster at 51.2-51.3 KB. The multiplier is the number of turns.

The runner has no bound for it. `RunnerLimits` is
`{ maxConcurrency, stallTimeoutMs, toolStallTimeoutMs? }` (`lib/agents-runner.ts:64-70`), and
both watchdogs bound *silence*, not total work. `docs/gentle-shell.md` states the current
contract explicitly: "Subagents have no automatic total execution timeout: a long-running child
remains live while it continues emitting RPC events."

Controlled experiment (same read-only task, same profile and model, n=2 per arm, accessed via
`subagent_run`):

| arm | turns | tool calls | unique bytes | carry load | recorded tokens |
|-----|-------|------------|--------------|------------|-----------------|
| brief bounded to 4 files / stop at 8 calls | 6.0 | 9.0 | 49,854 | 208,125 | 105,930 |
| unbounded brief | 17.0 | 29.0 | 104,047 | 1,034,141 | 433,100 |

5.0x carry load, 4.1x tokens. The bounded runs stopped at 8 and 10 tool calls: a cooperative
child respects an explicit budget, which is exactly the point — that is discipline in a prompt,
and nothing enforces it. The 475-call child above shows what happens without cooperation.

Reproduction: `node scripts/measure-subagent-carry.mjs` walks the child session store and prints
the same aggregates; `--days`, `--top`, `--json` and `--home` adjust the window, the listed
children, the output format and the store it reads.

## Verification

| check | result |
|---|---|
| focused tests (`agents-runner` + `agents-config`) | 112 tests, 112 pass |
| RED before the implementation | the three ceiling tests failed by timeout; both no-regression guards passed |
| unit stage (`tests/*.test.ts`) | 5001 tests, 4954 pass, 3 fail |
| those 3 failures | pre-existing: the same two files report 205/195/3 with and without this change (A/B via `git stash`) |
| `check:provider-contract` | pass |
| `test:harness` | pass |
| `typecheck` | 186 diagnostics, equal to the repository's recorded baseline, no regressions |

The 3 pre-existing failures live in `tests/review-candidate-view.test.ts` and
`tests/review-host-relay-routing.test.ts` and are unrelated to this change.

## Tasks

| id | spec | work | commit |
|----|------|------|--------|
| T1 | S3 | RED: budget tests in `tests/agents-runner.test.ts` (reach stops, absent limit does not, zero usage is inert, a waiting task resumes then stops) | `b2920482` |
| T2 | S3 | GREEN: `maxTurns`/`maxTotalTokens` in `RunnerLimits`, `checkBudget`, wired into `receive()` | `b2920482` |
| T3 | S3 | Config: parse both keys in `parseAgentsConfig`, RED first in `tests/agents-config.test.ts` | `b2920482` |
| T4 | S4 | Docs: config key list and the behavior paragraph in `docs/gentle-shell.md` | `b2920482` |
| T5 | S2 | Evidence: `scripts/measure-subagent-carry.mjs` | `00ae7f24` |
| T6 | S1-S4 | PR description: problem, measurement, design, declared cost, open questions | PR body |

## Log

- L1 (verbatim request): *"dale con el PR, evidenciemos todo y construyelo con una calidad
  tecnica Senior, y detallalo con evidencia relevante y con pautas bien pensadas de la solucion
  para que lo incluyan en gentle-shell...si me dejo enteder la idea?"*
- L2: context carried in from the same session: the amplification was measured first and
  published as a comment on gentle-shell#1125
  (https://github.com/Gentleman-Programming/gentle-shell/issues/1125#issuecomment-6061140877)
  after confirming #1823 is the narrower sibling of the same root cause rather than a separate
  report.
- L3: `checkout` decision — work happens in the linked worktree
  `/Users/edwin/projects/gentle-shell-budget` on branch `feat/runner-execution-budgets` based on
  `main` (`7b9b3a08`), because the installed checkout carries the live session-change fix and must
  keep it.
- L4: the RED run for the ceiling tests fails by timeout, which is the evidence that no ceiling
  existed; the two guards (no config, no reported usage) already pass before the change.
- L5: the first GREEN attempt failed one test and disproved design D4. A test proved the
  waiting-task exemption unreachable, so the branch was removed and the test rewritten to pin the
  real contract instead of the intended one. Recorded rather than quietly deleted because the
  wrong reasoning is the interesting part.
- L6: verification ran in the isolated worktree. The unit stage's 3 failures were attributed with
  an exact A/B (`git stash`) on the two files that contain them: identical counts either way, so
  they are pre-existing. Stages 2 and 3 were run directly with `node` because `pnpm run` tries to
  repair a linked `node_modules` and aborts without a TTY.
- L7: work units `b2920482` (behavior, tests, docs) and `00ae7f24` (measurement script); this
  record is the third. Branch `feat/runner-execution-budgets` in the linked worktree, based on
  `main` `7b9b3a08`. Nothing is pushed.
