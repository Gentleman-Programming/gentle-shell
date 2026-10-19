# Fix 2196: validate role labels against discovered agents

Validate `model_profiles` / profile role keys that name no discovered agent and surface a "did you mean" suggestion in the profiles panel and at launch, instead of the rejected alias approach from PR #2233. Maintainer decision (barbatdev, 2026-10-15): the alias breaks the reason the `gentle-ai-` prefix exists — not to collide with user agents. PR #2233 was closed 2026-10-19; we take the rework in-house.

## Specs

S1: From issue #2196: "There is no warning, no panel hint and no log line." — a role key that matches no discovered agent must no longer be silent.
S2: From maintainer decision: "Validate role labels against the discovered agents, surface a suggestion in the panel and at launch ('worker did not match any agent, did you mean gentle-ai-worker?'), without breaking that an omitted role inherits."
S3: A pure validator reports profile and `model_profiles` keys matching no discovered agent, with a "did you mean" suggestion (exact-match precedence preserved; short-name `worker` suggests packaged `gentle-ai-worker`).
S4: The `/gentle:profiles` panel renders unmatched keys as visibly invalid rows with the suggestion.
S5: Launch warns when the resolved agent's role label matched no profile key; omitted roles keep inheriting (frontmatter → default) exactly as today.
S6: A configured key that does match resolves exactly as before — differential behavior for matched keys is a regression.

## Tasks

T1 (S3): Pure validator `unmatchedProfileKeys()` in lib/agents-config.ts or lib/agent-profiles.ts, with suggestion via shortest-short-name mapping; RED then GREEN.
T2 (S4): Panel rows flag unmatched keys with suggestion; test in tests/agent-profiles.test.ts.
T3 (S5): Launch warn; heredity unchanged; test in tests/gentle-agents.test.ts.
T4 (S6): Differential check for matched keys; suite + typecheck; work-unit commits.

## Log

L1 (user request, verbatim Discord 2026-10-19): "ta vamos con la 2" — close #2233 with credit and implement the rework ourselves (label validation + did-you-mean in panel and launch, per maintainer decision on the PR thread).
L2: PR #2233 closed 2026-10-19 with credit comment; Carlos's tests for the worker/gentle-ai-worker case carry over as fixtures for the validator.
