# feat(desktop): read credential status and reload credentials over Desktop RPC

Closes #ISSUE

## Summary

- Only safe `ModelRegistry` calls: `getAll`, `getProviderAuthStatus`, `isUsingOAuth`, `getProviderDisplayName`, `refresh`.
- Verified against a real `ModelRuntime`: an offline refresh does not refresh an expired OAuth credential, does not write `auth.json`, runs no `!command`, and makes no network call.

## Test plan

- RED then GREEN: `tests/desktop-rpc-auth.test.ts` 12/12 (the fake registry also exposes the secret-returning calls and the tests prove none is called).
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

item 2 (credentials); independent verification passed; native review requested.
