# Feature: ODD runtime delegation gate

## Objective

Enforce Gentle Shell's ODD multi-file writer boundary at the runtime tool-call
layer so the primary orchestrator cannot implement two or more non-trivial files
inline after the prompt requires delegation.

## Problem and why

gentle-pi 3.2.1 contains the mandatory 2+ file writer trigger, but ordinary
`edit` and `write` calls still pass through the host hook. Prompt/parity tests
prove delivery of prose, not runtime enforcement. A production Gemini 3.8 Flash
session therefore completed a monolithic multi-file implementation and later
acknowledged the routing violation. This is provider-independent host behavior.

## Scope

- Add a small runtime policy for primary-session direct `edit`/`write` routing.
- Wire it into existing `before_agent_start`, `tool_call`, and successful
  `tool_result` boundaries in `extensions/gentle-ai.ts`.
- Allow one canonical eligible repository path and repeated writes to that path;
  block the second distinct path before mutation with an actionable delegation
  continuation.
- Exclude mandatory `odd/tasks/**` bookkeeping and exempt named/SDD/RPC child
  actors so delegated writers retain multi-file authority.
- Ship focused tests, one real-hook runtime-harness scenario, and concise docs
  with the behavior.

## Non-goals and constraints

- Do not change ODD/SDD selection, background policy, discovery, RDD, profiles,
  or the already-correct prompt/fixture text. Do not add Gemini-specific logic.
- Do not claim protection against opaque shell commands that mutate arbitrary
  files; command-string guessing is outside this evidenced direct-tool defect.
- Count canonical repository-relative paths; record only successful mutations.
  Failed/cancelled calls do not consume the budget.
- Reset ephemeral state at the next primary `before_agent_start`; create no
  durable authority. Preserve every existing sensitive-path, SDD-dispatch,
  writer-surface, bash-safety, and review-mutation hook.
- The refusal names the self-service exit: delegate through `subagent_run`
  (prefer `gentle-ai-worker`, then `worker`), or stop and report that no
  delegation mechanism is callable.
- Tests stay with behavior; no test-only or file-type commit.

## Authorized scope

- `lib/odd-runtime-delegation-gate.ts` (new)
- `extensions/gentle-ai.ts`
- `tests/odd-runtime-delegation-gate.test.ts` (new)
- `tests/runtime-harness.mjs`
- `docs/readme-reference.md`
- `odd/tasks/odd-runtime-delegation-gate.md`

No other source, asset, configuration, lockfile, fixture, or remote artifact is
authorized.

## TDD mode

- **Strict TDD enabled**, sourced from `openspec/config.yaml` (`strict_tdd: true`).
- Exact configured runner: `pnpm test` (`testing.runner.command` and apply/verify
  rules). RED -> GREEN -> REFACTOR is mandatory.
- Current OpenSpec quality prose says no dedicated typecheck exists, while the
  live `package.json` exposes `typecheck`; run that live script as an additional
  check, not as the TDD runner.

## Delivery and forecast

- Strategy: `exception-ok`; the maintainer explicitly accepted
  `size:exception` after final review measured 469 authored lines.
- Rationale: runtime policy, hook wiring, behavioral tests, harness coverage,
  documentation, and recovery evidence form one indivisible review unit.
  Splitting tests or enforcement from integration would create a non-working
  intermediate slice and increase review risk.
- Planned commit: `fix(odd): enforce delegated multi-file writes at runtime`.

## Tasks

- [x] **ODD-GATE-1 — Enforce the primary direct multi-file write boundary.**
  - Route: **delegated direct**, one bounded writer.
  - Trigger evidence: 2+ non-trivial files plus reading that prepares writes;
    Multi-file write and Preparation triggers both fire.
  - RED: prove the current real hook allows a second distinct direct source path;
    pin same-file, bookkeeping, failed-call, reset, and child cases.
  - GREEN: add the minimum provider-independent policy and hook integration;
    reject the second eligible path before execution with the named exit.
  - REFACTOR: isolate path/state logic from prompt, safety, SDD, and review code.
  - Add the runtime-harness scenario and docs, run all checks, perform the parent
    spot-check, and commit code/tests/harness/docs/task state as one unit.
  - Rollback: remove the new module/test, hook wiring, harness scenario, and docs
    paragraph without changing unrelated delegation, review, or SDD behavior.

## Acceptance criteria

- Primary direct `edit`/`write` permits one eligible canonical file and repeated
  writes to it; a second distinct eligible file is blocked before execution.
- The refusal names the bounded-writer continuation or exact unavailable-runtime
  stop. `odd/tasks/**`, failed calls, and cancelled calls do not consume budget.
- A fresh primary start resets state. Named agents, SDD agents, and owned RPC
  children are exempt.
- Existing subagent/writer validation, sensitive-path policy, bash confirmation,
  and review receipts remain unchanged.
- Focused, regression, harness, typecheck, and full-suite checks pass, or exact
  pre-existing/environmental failures are reported without false success.

## Exact checks

1. `node --experimental-strip-types --test tests/odd-runtime-delegation-gate.test.ts`
2. `node --experimental-strip-types --test tests/odd-routing-contract.test.ts tests/background-subagents.test.ts`
3. `pnpm run test:harness`
4. `pnpm run typecheck`
5. `pnpm test`
6. `git diff --check && git diff --stat && git status --short`

The delegated writer runs these in the foreground and reports
`<command>: <observed result>`. The parent re-runs check 1 as the spot-check.

## Progress and next step

- [x] v3.2.1 prompt copies and missing direct-tool enforcement verified read-only.
- [x] Strict TDD resolved from project configuration, not inferred from tests.
- [x] Feature document prepared before any source write.
- [x] Engram mirror `odd/odd-runtime-delegation-gate/tasks` saved and read back
  before the first source write.
- [x] ODD-GATE-1 RED observed in the actual worktree: focused test exited 1
  with 0 pass / 1 fail because the second direct path returned `undefined`.
- [x] Independent verification caught and corrected nested-child state loss,
  symlink identity bypasses, SDD fixture drift, and a missing harness Git root.
- [x] Final focused spot-check: 8 pass / 0 fail.
- [x] Routing regressions: 52 pass / 0 fail.
- [x] `pnpm run test:harness`: pass.
- [x] `pnpm run typecheck`: pass with 197 baseline diagnostics, no regressions,
  and two improvements.
- [x] `pnpm test`: pass with 2695 pass / 0 fail / 38 skipped; provider contract
  and final harness pass.
- [x] Maintainer accepted a single PR with `size:exception` for the final
  469-line coherent unit.
- [x] Work-unit commits: `655e2e2e` (runtime gate, tests, harness, docs) and
  `a6a7eb77` (native R3-001 canonical absolute-path correction).
- [x] Native high-risk review `review-28f6518225f3fc61` corrected R3-001,
  approved target `sha256:9cf03850768674c5350df93cba6c696efce2331c9ad55788fdf2dab57428040c`,
  and burned its authority through exact acknowledgement.

Next: commit this evidence-only task update, then complete issue-first PR
delivery through the explicitly authorized GitHub session.
