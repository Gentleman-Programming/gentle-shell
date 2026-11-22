# feat(desktop): read and change the background-subagents policy over Desktop RPC with confirmation

Closes #ISSUE

## Summary

- New `get_background_subagents` and `set_background_subagents` over a versioned owner service in `extensions/gentle-ai.ts` (refuses in subagent child processes).
- Token bound to the request, the shown text, and the state; process-wide single-flight gate; no event (every answer carries the state).

## Test plan

- RED then GREEN: `tests/desktop-rpc-background-subagents.test.ts` 8/8 against the real owner.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

item 2 (a user-owned guard becomes writable from Desktop, behind confirmation); independent verification passed.
