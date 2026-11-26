# feat(desktop): add cost per day and usage per provider to get_usage_stats

Closes #ISSUE

## Summary

- `aggregateStats` also returns `dayCosts` and `providers`; the Desktop projection adds them. Provider ids now cross the wire on purpose.

## Test plan

- RED then GREEN: `tests/desktop-rpc-stats.test.ts` 15/15.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

none (additive fields).
