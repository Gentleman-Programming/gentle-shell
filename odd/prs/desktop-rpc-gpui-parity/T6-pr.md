# feat(desktop): push subagent progress (turns, tool calls, running tool) in agents_update

Closes #ISSUE

## Summary

- The agents owner subscribes to each active task and throttles progress notifications through its scheduler.
- `lastActivityAt` stays out of the Desktop RPC `agents_update` entries (the `gentle-agents.activity/v1` widget still publishes it), so streamed text does not turn into events.

## Test plan

- RED then GREEN: `tests/desktop-rpc-agents.test.ts` 56/56, including a real-owner test of the throttled progress event.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

none (additive fields on an existing event).
