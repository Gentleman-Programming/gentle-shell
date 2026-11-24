# feat(tower): print the Tower URL as one JSON line with gentle-shell tower --json

Closes #ISSUE

## Summary

- `parseTowerArgs` accepts `--json`; help text and docs updated; runtime modules regenerated.

## Test plan

- RED then GREEN: `tests/gentle-shell-launcher-tower.test.ts`, `tests/tower-open.test.ts` (JSON line, failure path), plus a CLI smoke test.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

none (new optional flag).
