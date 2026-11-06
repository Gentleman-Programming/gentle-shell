# verifier-2478-diagnostics — strict Risk grammar diagnostics and post-denial disposition

Objective: resolve gentle-shell issue #2478 points 1-4: placement-explicit rejection message, documented launch grammar, assessment≠admission clarification, and the supported post-denial disposition (Option A: no gate-level retry; new launch requires a new explicit user decision).
Branch: fix/verifier-2478-diagnostics (from origin/main 4851dda5a). Runner: node --experimental-strip-types --test tests/verifier-admission.test.ts; typecheck node scripts/check-types.mjs.

## Specs

S1 (issue #2478 point 1, verbatim): "Say that no **supported risk declaration was recognized in task/context**, rather than implying that the underlying change has no risk." — already in main's VERIFIER_RISK_REJECTION; keep the pinned substrings.

S2 (issue point 2, verbatim): "Make the strict `Risk: item N` line grammar explicit in the pre-launch contract, including the line-start requirement. Keep risk evidence tied to the actual change; do not encourage adding a label merely to gain admission."

S3 (issue point 3, verbatim): "Explain that assessment selects a verification plan while verifier admission independently validates the launch envelope; assessment output is not currently an admission input."

S4 (user decision, Option A): document the post-denial disposition: no gate-level disposition exists for the same launch; the rejection is launch-scoped, not feature-scoped; a new verifier launch requires the user's explicit decision in a new prompt and a conforming envelope with evidence tied to the actual change; never fabricate a Risk line or treat inline tests as independent verification.

S5 (user choice): improve VERIFIER_RISK_REJECTION with the accepted placement, with an example (`Risk: item 2 (reason)` at line start) and the non-exhaustive boundary note (a declaration after `; `, `,` or mid-sentence is not recognized). Keep substrings pinned by tests/verifier-settle-reminder.test.ts:70-73.

## Tasks

T1 [S5] RED+GREEN: placement-guidance tests in tests/verifier-admission.test.ts, then extend VERIFIER_RISK_REJECTION in lib/verifier-admission.ts. Route: inline.
T2 [S2-S4] docs/delegated-verification.md: grammar + assessment≠admission + post-denial disposition. Route: inline.
T3 [S1-S5] Focused suites, typecheck, independent verifier (Risk: item 3, changes a gate message agents consume), commit, PR, merge. Route: inline + verify.

## Log

L1 (user request, verbatim): "ahora este https://github.com/Gentleman-Programming/gentle-shell/issues/2478" then "si" — approving Option A (document no gate-level disposition) plus improving the rejection message.
L2: Issue #2478 approved (status:approved) via Alan-TheGentleman admin. Main already carries the S4 wording of #2652; pins are substring-based, so the message can be extended.
L3: Forecast ~70 authored lines (message + tests + docs sections) — single unit; Risk: item 3 (gate message others consume) → one independent verifier.
