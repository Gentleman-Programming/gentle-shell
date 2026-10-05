# Bridge-only agent wake

## Intent
- Objective: show the synthetic Gentle Agents user notification only when the orchestrator's currently selected provider comes from a bridge plugin (for example Claude Bridge).
- Problem: idle background subagent delivery unconditionally emits a visible synthetic user turn.
- Why: native Pi providers should continue automatically without this chat noise.
- Authorized scope: parent wake routing and focused regression tests. Preserve result delivery, coalescing, streaming steering, and prompt-start grace. Do not change installer work or bridge plugins.
- Acceptance: bridge selected => existing user wake; native selected => hidden custom wake that still triggers a turn; runtime provider switching is respected; background completion and query behavior remains correct.

## Plan
- [ ] T1 — Route idle wakes by the live selected provider and prove regressions. Route: delegated (non-trivial extension and test edits, SDK exploration). Risk: medium initially; native assessment will determine independent checks. Test-first: observe focused regression RED, implement GREEN, rerun wake-related tests and typecheck. Keep tests with behavior in one work-unit commit.

## Delivery
- Strategy: ask-on-risk. Forecast: approximately 120 authored additions/deletions, excluding generated output. No publishing or PR authorized.
- Branch: `fix/bridge-only-agent-wake`; unrelated dirty installer files preserved.
- Work-unit commit: pending.
- Running authored count: 0.

## Progress and evidence
- T1: in progress; read-only mapping found unconditional `sendUserMessage` in `extensions/gentle-agents.ts` dispatchWake.
- SDK supports custom hidden messages with `triggerTurn:true`; simply dropping the user message would lose continuation.
- Bridge means selected model provider, not RPC/UI mode or arbitrary extension registration.
- Exact surfaces: `extensions/gentle-agents.ts`, `tests/gentle-agents.test.ts`. Current evidenced bridge ID: `claude-bridge`; no SDK bridge semantic marker. Do not classify arbitrary extension providers as bridges.
- Writer `muqwuqx6-2-bzz2` returned partial: extension and tests changed (144 additions, 16 deletions). RED: 175 pass / 11 intended failures. GREEN: 186 pass / 0 fail. Fourteen deterministic cases added.
- `node --experimental-strip-types --test tests/gentle-agents.test.ts`: passed 186/186 for writer, independent verifier and parent. `pnpm run typecheck`: failed with two TS2345 errors in unchanged `tests/installer-posix-bootstrap.test.ts:235,238` from an untyped heterogeneous tuple loop (:226–231). Statements are identical in HEAD and do not depend on candidate code; clean-HEAD compilation unverified.
- Independent verifier `muqx30qs-3-6rgo`: focused tests passed 186/186. Typecheck failed with the two TS2345 errors above. Full `pnpm test` failed: 4684 tests, 4648 passed, 1 failed, 35 skipped; provider-contract and runtime-harness stages passed. Failure: `tests/gentle-ai-dev-binary-surfacing.test.ts:189` (assertion :202), `session start defers the active-override announcement to the shell card`. Causal inspection completed: inherited `GENTLE_PI_AGENTS_CHILD=1` disables shell in unchanged `lib/shell-bar.ts:109–112`, causing the fallback warning in unchanged `extensions/gentle-ai.ts:9371–9374`. Test clears GENTLE_PI_SHELL but not child flag. No unrelated fixes or reruns performed.
- Parent spot check: focused command passed 186/186 (~20.5 seconds).
- RDD inspect performed; workspace scope mixes installer changes with this candidate and requires intended-untracked selection. No START performed; avoid freezing unrelated work.
- Native ASSESS returned unassessable due to unrelated untracked scope; plan requires independent verifier (treated as high). Isolate this work unit as a committed range before review; do not review accumulated installer work.
- Required checks: focused deterministic tests, related agent delivery tests, typecheck, parent spot check, RDD for this candidate under the user-owned switch.
- Independent verifier final: no candidate-caused blocker found, but overall checks not green. SDK confirms hidden custom wake starts a model turn; tests mock calls rather than run a live model. Writer RED/GREEN observed; parent inspected extension diff and reran focused tests. Native review and commit pending. T1 remains incomplete until delivery/check decisions are resolved.
- [ ] B1 — Resolve verification blockers and isolate review scope. Investigate causality read-only; unrelated fixes require separate authorization. Do not silently accept failed checks.

## Next step
Needs user decision: authorize an isolated work-unit commit to review only this change, with unrelated check failures explicitly retained, or leave implementation uncommitted and pause. No publishing/PR/merge. Do not change installer or shell tests without separate scope authorization.
