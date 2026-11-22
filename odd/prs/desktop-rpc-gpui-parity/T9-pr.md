# feat(desktop): read package status over Desktop RPC with get_status

Closes #ISSUE

## Summary

- A versioned owner service in `extensions/gentle-ai.ts` reuses the command's helpers (asset counts extracted without changing its lines); the dev binary is resolved, never run.

## Test plan

- RED then GREEN: `tests/desktop-rpc-status.test.ts` 7/7, including the real owner.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

none (new read-only method).
