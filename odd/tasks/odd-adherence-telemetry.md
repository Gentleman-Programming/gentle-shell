# Feature: ODD adherence telemetry

## Objective

Make the ODD routing rules observable. Record locally and silently what the
runtime delegation gate sees on every primary turn — counts, triggers, refusals,
follow-through — so skipped delegation stops being invisible and any future
decision layer has a measured baseline to beat.

## Problem and why

The runtime gate (`lib/odd-runtime-delegation-gate.ts`) enforces only the second
distinct `edit`/`write` path in a primary Pi session. It stores only the first
path, resets per primary turn, and exposes no numbers. Whether the trigger fires,
whether a refusal is followed by a delegation, and which backstops (about 20 tool
calls, 5 exploratory reads, 2 non-mechanical edits) are crossed without
delegation are all unmeasured today.

Measured from local transcripts (pre-gate population, 2026-09): in 108 Pi primary
sessions there were 110 turns that mutated repository files directly; 64 of them
(58%) touched two or more distinct eligible paths with no delegation in the turn,
and 147 turns crossed the 20-tool-call backstop with no delegation. Baseline
report: `/tmp/odd-adherence/baseline.txt`; analyzer `/tmp/odd-adherence/analyze.py`.
Claude primary sessions show the opposite profile: 3 violations in 21
mutation-turns, but 118 backstop turns.

Without rates, any proposal to add a decision layer (including a local decision
model) is unfalsifiable.

## Scope

- New recorder module: one JSONL line per primary turn with counts only — tool
  calls, reads, successful edits, distinct eligible paths, first/second path
  order, delegations — plus gate refusals and backstop flags.
- Wire it into the existing `before_agent_start`, `tool_call`, and successful
  `tool_result` boundaries in `extensions/gentle-ai.ts`, next to
  `OddRuntimeDelegationGate`, consuming the gate's own decision instead of
  recomputing path eligibility.
- New reader script that prints the adherence metrics, including the join with
  `odd/tasks/*.md` route declarations.
- One documentation section.

## Non-goals and constraints

- Local only. Never sent over the network. Never a durable authority. Never
  blocks, delays, or changes a decision. Any failure is swallowed silently.
- Respect `DO_NOT_TRACK=1` and `CI=true`: record nothing when either is set.
- No path strings, prompts, tool output, or content in the log. Session identity
  is a short hash; repository identity is a short hash of the canonical worktree
  root.
- The log path derives from the injected `processEnv` (tests inject a temporary
  HOME); never call `os.homedir()` directly.
- No path re-derivation: canonical path logic stays in the gate module and is
  reused, not duplicated.
- Do not change gate decisions, thresholds, refusal text, or any other hook
  behavior.

## Authorized scope

- `lib/odd-runtime-delegation-gate.ts`
- `lib/odd-adherence-telemetry.ts` (new)
- `extensions/gentle-ai.ts`
- `tests/odd-adherence-telemetry.test.ts` (new)
- `scripts/odd-adherence-report.mjs` (new)
- `docs/readme-reference.md`
- `odd/tasks/odd-adherence-telemetry.md` (parent-owned task state)

No other source, asset, configuration, lockfile, fixture, or remote artifact is
authorized.

## TDD mode

- **Strict TDD enabled**, sourced from `openspec/config.yaml` (`strict_tdd: true`).
- Exact configured runner: `pnpm test`; focused runs use
  `node --experimental-strip-types --test <file>`.
- RED -> GREEN -> REFACTOR is mandatory for the recorder.

## Record schema v1 (fixed)

One line per primary turn, appended to `$HOME/.gentle-ai/odd-adherence.jsonl`:

```json
{"v":1,"ts":"2026-09-21T14:31:02Z","session":"8f3a1c2d","repo":"a91b04e7","provider":"pi","turn":7,
 "tool_calls":34,"reads":6,"edits":5,"distinct_paths":3,"first_path_order":9,"second_path_order":24,
 "delegations":0,"blocked":true,"blocked_kind":"multi-file-write","no_delegation_mechanism":false,
 "backstops":{"tool_calls":true,"reads":false,"edits":true}}
```

## Tasks

- [x] **ODD-ADH-1 — Recorder module.**
  - Route: **delegated direct**, one bounded writer.
  - Trigger evidence: recorder module, hook wiring, reader, tests, and docs are
    four or more files plus reading that prepares writes; Multi-file write and
    Preparation triggers both fire.
  - RED: prove with a failing test that a primary turn emits no adherence line.
  - GREEN: add the minimum recorder that renders schema v1 from observed turn
    counts and gate decisions.
  - REFACTOR: isolate counting from path canonicalization and from I/O; the
    appender is injected.
  - Rollback: delete the new module and test; wiring and reader stay untouched.
- [x] **ODD-ADH-2 — Hook wiring.**
  - RED: prove the extension never appends a line for a refused second path.
  - GREEN: tap `before_agent_start`, `tool_call`, successful `tool_result`;
    consume the gate result; append once per primary turn and on refusal.
  - Rollback: revert `extensions/gentle-ai.ts`.
- [x] **ODD-ADH-3 — Reader script.**
  - `scripts/odd-adherence-report.mjs` prints: trigger fire rate, violation rate,
    follow-through after refusal, backstop rates, provider split, and route
    declarations joined from `odd/tasks/*.md` when run inside a repository.
  - Rollback: delete the script.
- [x] **ODD-ADH-4 — Documentation.**
  - One section in `docs/readme-reference.md`: what is recorded, where, how to
    read it, and how to opt out.
- [ ] **ODD-ADH-5 — Parent verification and close.**
  - Verification observed; the work-unit commit is the remaining step and is
    pending the maintainer's decision.

## Verification evidence

- Parent spot-check: `tests/odd-adherence-telemetry.test.ts` 10/10,
  `tests/odd-runtime-delegation-gate.test.ts` 9/9,
  `tests/odd-routing-contract.test.ts` 12/12.
- Falsifiability, parent-run: changing `state.blocked = true` to `false` in the
  recorder fails exactly one test ("refusal records two distinct eligible paths
  and a blocked turn") and restoring returns 10/10. The writer also proved the
  new read-budget regression test is falsifiable by removing the guard
  (9 tests: 1 fail naming "a read cannot consume the primary direct write path
  budget"; restored: 9/9).
- Independent verifier: `pnpm test` 2973 tests, 2934 pass, 1 fail
  (`tests/gentle-ai.test.ts:747`, reproduced on base `cf1fdb65` and therefore
  pre-existing), 38 skipped; two further failures were intermittent, passed on
  focused rerun and on the base archive. `pnpm run typecheck` exit 0 with no
  regressions against the 196-diagnostic baseline.
- Two defects found by the verifier and fixed: the gate module's `recordSuccess`
  now guards `edit`/`write` at the boundary, and the recorder no longer resolves
  canonical paths on the `tool_call` path (resolution moved to the refusal branch
  and to `tool_result`).

## Acceptance criteria

- A primary turn that writes one eligible file and one distinct eligible file is
  recorded with `distinct_paths: 2`, `blocked: true`, `delegations: 0`.
- A turn that delegates first records `delegations >= 1` and `blocked: false`.
- `odd/tasks/**`, failed calls, and child actors never consume or record budget.
- `DO_NOT_TRACK=1` or `CI=true` produces no file and no error.
- A read-only filesystem, a missing HOME, or an unwritable path never surfaces an
  error and never changes a tool result.
- No path string, prompt text, or tool output appears anywhere in the log.
- Existing gate, routing-contract, and harness behavior is unchanged.

## Exact checks

1. `node --experimental-strip-types --test tests/odd-adherence-telemetry.test.ts`
2. `node --experimental-strip-types --test tests/odd-runtime-delegation-gate.test.ts`
3. `node --experimental-strip-types --test tests/odd-routing-contract.test.ts`
4. `pnpm run typecheck`
5. `node scripts/odd-adherence-report.mjs` against a synthetic log fixture
6. `git diff --check && git status --short`

The delegated writer runs 1, 2, 3, 4, and 6 in the foreground and reports
`<command>: <observed result>`. The parent re-runs check 1 as the spot-check;
the verifier runs `pnpm test`.

## Progress and next step

- [x] Pre-gate adherence baseline measured from local transcripts (read-only).
- [x] Feature document created; writer dispatch next.
