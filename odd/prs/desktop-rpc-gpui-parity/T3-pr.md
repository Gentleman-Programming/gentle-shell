# feat(desktop): add persona, banner, and notifications config stores to Desktop RPC

Closes #ISSUE

## Summary

- Persona and banner owners move to `lib/persona-config.ts` and `lib/banner-config.ts` (atomic sync writers); `/gentle:persona` and the banner use them.
- Only the profile stores keep waiting for a profile apply.

## Test plan

- RED then GREEN: `tests/desktop-rpc-config-settings.test.ts` 12/12, `tests/persona-config.test.ts` 3/3, `tests/desktop-rpc-config.test.ts`; persona read/write compared with the previous code on 192 fixtures.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

item 3 (shared persona and banner owner code); independent verification passed after fixes.
