# Proportionate ODD delegation (gentle-ai#4894)

## Objective and problem
The Pi runtime currently refuses every second distinct direct source write, even when it is a mechanical edit. This is stricter than the ODD rule that delegates changes touching two or more **non-trivial** files. The refusal forces an expensive worker for work that does not need one. ODD also lacks explicit spend-proportional sequencing guidance.

## Scope and constraints
- Remove the unsound session-history-based write refusal in gentle-pi without weakening the normative two-non-trivial-file delegation rule or the unrelated SDD/review safety gates.
- Update the shipped orchestrator guidance to validate consequential premises before implementation, reuse sibling findings, and run focused tests during development before full-suite closure.
- The canonical gentle-ai guidance is in another Git clone and must be aligned separately; no edits to its dirty worktree or unrelated files.
- Do not add a line-count security bypass, new state, new flags, or an extra consent gate. No push or PR is authorized.

## Tasks and routes
- [x] OPD-1 (delegated: multiple non-trivial gentle-pi files) — Removed the blanket runtime gate and wiring; tests and shipped guidance now preserve the two-non-trivial-file policy. Checks: focused test 1/1, runtime harness 1/1, typecheck no regressions, and `pnpm test` exit 0 (2,952 passed, 38 skipped). Work-unit commit `2c48ce124f5055e7859a864281f2035d177d039a`; high-risk native review `review-794e9b5d2b44714f` approved and acknowledged (authority burned). One non-blocking readability advisory remains.
- [ ] OPD-2 (cross-repository, pending compatible executor) — Align the authoritative gentle-ai `internal/components/agentguidance/routing.go` contract and its routing tests with the same spend-proportional guidance; verify generated consumer text and focused Go tests. Acceptance: no runtime-bypass claim or new hard budget; canonical and shipped contracts agree.

## Verification and delivery
TDD mode: unknown (no explicit project/session setting confirmed); ordinary functional checks apply. Runner for gentle-pi: `node --experimental-strip-types --test tests/odd-runtime-delegation-gate.test.ts`; for gentle-ai: `go test ./internal/components/agentguidance`. Forecast: roughly 250 changed lines, excluding this task record. Strategy: ask-on-risk. One reviewable commit per completed work unit on this feature branch; no remote delivery. Native review mode to be read before review, not assumed.

## Progress
- 2026-09-22: Issue and both repositories inspected. The gate has only tool input/path/session history, so it cannot safely distinguish mechanical from consequential edits. Removing the blanket gate is preferable to a line-count heuristic. OPD-2 must not touch the active dirty gentle-ai worktree.
- 2026-09-22: OPD-1 implementation in isolated gentle-pi worktree: removed the obsolete gate module and event wiring, replaced its blanket-refusal tests, updated runtime harness and shipped guidance. Independent checker observed focused test 1/1, runtime harness 1/1, and `pnpm run typecheck` no regressions (196 baseline diagnostics). Source inspection found unrelated SDD/review gates intact. `pnpm test` then exited 0 with 2,952 passing, 38 skipped and no failures; provider-contract check passed. Commit `2c48ce12` assessed high risk and native RDD review `review-794e9b5d2b44714f` closed approved; exact acknowledgement burned authority. The task record update itself is passive documentation and awaits its own worktree commit.
- Engram mirror `odd/odd-proportional-delegation/tasks`: pending because memory tools are not callable in this runtime.

## Next step
Commit this task record, then route OPD-2 from the isolated gentle-ai worktree without touching unrelated work.
