# Feature: Suppress RDD review reminder and contract prompt in delegated child sessions (#1267)

## Objective

Prevent delegated child sessions (`GENTLE_PI_AGENTS_CHILD === "1"`) from receiving the `agent_end` review-preflight reminder and primary-session prompts (gentlePrompt, reviewContractPrompt), which derail child worker completion evidence into review-routing handoffs.

## Problem

With receipt-driven development enabled:
1. `agent_end` checks `ctx.hasUI !== true` and subagent depth, but does not guard against `permissionEnvironment.GENTLE_PI_AGENTS_CHILD === "1"`. Delegated workers running in child processes have depth 0 and receive the `gentle-pi.review-preflight` message, triggering a follow-up turn in the child.
2. In `before_agent_start`, child sessions without an explicit agent name in the start event are not recognized by `isNamedAgent` or `isSddAgent`, causing primary-session prompts (such as `reviewContractPrompt` and `gentlePrompt`) and telemetry to be injected into child sessions.

## Solution

1. In `extensions/gentle-ai.ts` (`agent_end`): immediately return if `permissionEnvironment.GENTLE_PI_AGENTS_CHILD === "1"` after `oddDelegationGate.endChild`.
2. In `extensions/gentle-ai.ts` (`before_agent_start`): classify sessions with `permissionEnvironment.GENTLE_PI_AGENTS_CHILD === "1"` as non-primary (`isPrimarySession = !isNamedAgent && !isSddAgent && !isChild`), avoiding injecting `gentlePrompt`, `reviewContractPrompt`, or telemetry into child sessions.
3. Add regression tests in `tests/review-agent-end-preflight.test.ts` and `tests/review-contract-prompt.test.ts`.

## Tasks

- [x] T1: RED - Add regression tests for child session review suppression
- [x] T2: GREEN - Implement child session guard in extensions/gentle-ai.ts
- [x] T3: Verification - Run test suite and check for regressions
- [x] T4: Work-unit commit for issue #1267

## Progress and Evidence

- Commit: `1081a872 fix(review): suppress RDD reminder and primary prompts in child sessions (#1267)`
- RED: `agent_end sends nothing and performs no STATUS call when GENTLE_PI_AGENTS_CHILD is 1` failed reproducing status query in child session. `before_agent_start does not inject the review execution contract or gentlePrompt for a child session (GENTLE_PI_AGENTS_CHILD=1)` failed reproducing prompt injection.
- GREEN: Both test suites pass 100% (42/42 in `review-agent-end-preflight.test.ts`, 8/8 in `review-contract-prompt.test.ts`).
- Verification: `pnpm run check:provider-contract`, `pnpm run typecheck`, and `pnpm run check:runtime-modules` all pass with 0 errors/regressions.
