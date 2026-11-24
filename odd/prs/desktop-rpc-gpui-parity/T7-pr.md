# feat(desktop): list agent definitions and the default orchestrator over Desktop RPC

Closes #ISSUE

## Summary

- Reads through `discoverAgents`, `loadAgentsConfig`, and `readOrchestratorSettings`; bounded to 200 agents and 64 tools each.

## Test plan

- RED then GREEN: `tests/desktop-rpc-agent-definitions.test.ts` 7/7 over real files in temp homes.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

none (new read-only method).
