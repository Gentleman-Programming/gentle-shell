# User consent for cross-orchestrator communication (#1364)

- Feature: `feat-1364-cross-orchestrator-consent`
- Branch: `feat/1364-cross-orchestrator-consent` (base `upstream/main` ef55af79)
- Engram mirror: `odd/feat-1364-cross-orchestrator-consent/tasks` (offline/unavailable)
- TDD: strict; runner `node --experimental-strip-types --test tests/session-messaging-grants.test.ts tests/gentle-agents.test.ts`
- Delivery: `single-pr`; the maintainer accepted `size:exception` for PR #1372 (already 527 changed lines before this correction). Preserve tests and docs rather than compressing the diff.
- RDD: on (global, confirmed in this clone); review the new committed candidate before delivery.

## Objective

Require explicit interactive human authorization before any outbound orchestrator-to-orchestrator message or equivalent communication via `orchestrator_send_message`, preventing unauthorized context disclosure and unsolicited session interruptions.

## Problem

Currently, `orchestrator_send_message` can send notifications directly to other advertised sessions without explicit user consent. When a recipient is known or chosen via UI picker, the message payload is dispatched immediately. Cross-orchestrator messaging can leak sensitive repository/task context or interrupt another user's session without the initiating user's knowledge or consent.

## Scope

In:
- `lib/session-messaging-grants.ts`: Ephemeral, in-memory grant manager `SessionMessagingGrants` bound to the active `sessionManager` and initiating `sessionId`. Supports 3 decisions:
  1. `Allow once`: authorizes only the current outbound message to the target recipient; does not retain permission for future messages.
  2. `Allow for this session`: authorizes communication with the target recipient for the lifetime of the initiating session.
  3. `Deny`: fails closed without sending; returns an authorization refusal.
- Interactive prompt: Prompts with recipient ID, message preview, and reason via `ctx.ui.select` when interactive UI is available.
- Fail closed: If `!ctx.hasUI || !ctx.ui?.select`, if aborted, or if session identity changes during the prompt, fail closed without sending.
- `extensions/gentle-agents.ts`: Integrate `SessionMessagingGrants` into `orchestrator_send_message` tool execution before calling `transport.client.sendNotification`. Require a bounded concrete `reason`, and use one validated message snapshot across selection, preview, and send.
- `tests/session-messaging-grants.test.ts` and `tests/gentle-agents.test.ts`: Test all 3 decisions, subsequent messages, changed recipients, headless fail-closed, abort cancellation, and session expiry.

Out:
- Changes to underlying transport client, listener, or registry.
- Changes to inbound message delivery or notification handling.

## Tasks and routes
- [x] T1 (strict TDD tests) — Author failing regression tests for `SessionMessagingGrants` and `orchestrator_send_message` consent interception.
- [x] T2 (implementation) — Implement `SessionMessagingGrants` in `lib/session-messaging-grants.ts` and integrate it into `extensions/gentle-agents.ts`.
- [x] T3 (verification) — Run targeted tests, gentle-agents test suite, and typecheck to verify zero regressions.
- [x] T4 (maintainer consent hardening) — RED/GREEN regressions for mutable tool arguments, cached grants without UI, missing or invalid caller reason, and forged preview metadata; implementation, docs, focused and full package checks in one work unit.
- [ ] T5 (candidate review and collaboration) — Review the exact committed correction, check the contributor branch for drift, push only to the existing PR head, and assess merge readiness. No merge authorization.

## Progress
- 2026-09-23: Created `tests/session-messaging-grants.test.ts` testing `Allow once`, `Allow for this session`, `Deny`, headless fail-closed, abort cancellation, and session expiry / manager replacement.
- 2026-09-23: Implemented `SessionMessagingGrants` in `lib/session-messaging-grants.ts` and wired it into `extensions/gentle-agents.ts` for `orchestrator_send_message`. Added optional `reason` parameter to tool schema. Updated `tests/gentle-agents.test.ts` and `docs/gentle-shell.md`.
- 2026-09-23: Verified suites: `tests/session-messaging-grants.test.ts` (8/8 passed), `tests/gentle-agents.test.ts` (127/127 passed), `npm run typecheck` (0 regressions), and `npm run check:provider-contract` (passed).
- Maintainer continuation: PR #1372 head `4210e56f`; isolated worktree `pr1372-consent-maintainer`. Current PR diff is 521 additions and 6 deletions. The maintainer explicitly accepted a size exception for this PR; the fork branch must be checked for drift before push. Engram mirror remains unavailable because its local server identity cannot be resolved.
- T4 strict TDD: focused RED exit 1 with six intended regression failures; focused GREEN `node --experimental-strip-types --test tests/session-messaging-grants.test.ts tests/gentle-agents.test.ts` exit 0, 143/143 passed. The correction snapshots validated message/reason, preserves preview-to-send identity, rejects missing or invalid reasons, fails closed without UI even after a cached grant, and escapes consent-field controls without modifying outbound payload. A wording-only alignment recheck also passed 143/143.
- T4 independent validation: first sanitized full run passed 3,369 tests (47 skipped), provider contract passed, then exited 1 because `pnpm install --ignore-scripts` omitted the pinned worktree-local Gentle AI binary. Ran `node scripts/install-gentle-ai.mjs` to provision ignored v3.6.1 (exit 0, no tracked changes). Recheck `pnpm run test:harness` exit 0 without a separate success marker; `env -u GENTLE_PI_CONFIG_HOME -u PI_CODING_AGENT_DIR pnpm test` exit 0 (3,378 passed, 38 skipped, 0 failed), provider-contract passed, runtime harness invoked without a separate marker. `pnpm run typecheck` exit 0, reported 195 existing diagnostics and no regressions. `git diff --check` exit 0. These fixture/harness checks do not claim a live Pi UI consent exercise. Rollback boundary: revert the T4 work-unit commit to restore the contributor's pre-hardening consent implementation and tests without changing session transport. T5 committed-range review and delivery remain pending.

## Verification
- `node --experimental-strip-types --test tests/session-messaging-grants.test.ts`
- `node --experimental-strip-types --test tests/gentle-agents.test.ts`
- `npm run typecheck`
