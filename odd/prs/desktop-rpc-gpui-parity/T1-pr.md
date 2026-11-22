# feat(desktop): read, clear, and follow the session profile binding over Desktop RPC

Closes #ISSUE

## Summary

- New `get_profile_binding`, `clear_profile_binding`, and event `profile_binding_changed`.
- The binding store (`lib/session-profile-binding.ts`) gains a process-wide observer registry notified on every bind, clear, and startup-none write; observers can never break a write.
- The profiles owner service gains an optional `clear`, running `handleProfilesClear` behind the apply gate with recorded notices; an owner warning is always `not_cleared`.

## Test plan

- RED then GREEN: `tests/desktop-rpc-profile-binding.test.ts` 7/7, `tests/session-profile-binding-observers.test.ts` 2/2, real-owner clear in `tests/session-profile-extension.test.ts` (live and no startup profile); capability lists updated in the pinned tests.
- `tests/desktop-rpc*.test.ts`, the maintainer Desktop RPC test, and `node scripts/check-types.mjs`: no regressions (the only local failures are Windows-only ones that also fail on `main`).

## Risk

item 3 (shared binding store); independent verification passed.
