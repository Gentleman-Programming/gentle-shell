# Runtime admission for independent verifiers

Objective: the independent verifier (`gentle-ai-verify`) runs only for changes that declare a named high-risk item,
the same way S16 admission keeps small-task writers inline. Branch `feat/harness-r1-runtime-checks` (harness roadmap
R1, same single PR). Runner: `pnpm test`.

## Specs

- S1 (user, verbatim): "Me gusta dale" — accepting the proposal: "en la sesión primaria, `gentle-ai-verify` se admite
  solo si la tarea declara un ítem de alto riesgo (una línea `Risk: item N`), pertenece a un documento de feature, o
  el contexto pasó el backstop. Si no, se rechaza con 'verificá inline: focused test + suite'. Es genérico (cualquier
  modelo)."
- S2 Evidence: bench gate run `gate-p50-r1` x5 run 2 launched `gentle-ai-verify` on a small, not high-risk task
  (USD 0.20 of a USD 0.63 cell); the verification rule in the prompt says an independent verifier runs only for a
  named high-risk item.
- S3 Admission: in the primary session, a `subagent_run` launch of `gentle-ai-verify` (and the generic `verify`
  alias if one exists in the agent catalog) is admitted only when (a) its task or context has a line declaring a
  named high-risk item from the Task Size list, in the form `Risk: item N` with N in 1-6 (several items allowed, e.g.
  `Risk: item 2, item 3 (reason)`); or (b) it carries an existing feature-document task line as writer admission
  accepts (`Spec: odd/tasks/<feature>.md, T<n>`, document must exist under the root); or (c) the measured parent
  context reached the context backstop (same function as writer admission). `Risk: none` or no line is rejected.
- S4 Rejection message (English, generic, no model or provider names): states that an independent verifier runs only
  for a change that declares a named high-risk item, tells the parent to run the change's focused test and suite
  inline now, not to retry the launch, and never to add a Risk line or create a feature document only to get a
  verifier admitted.
- S5 Unchanged: children, named agents, continuations (`subagent_continue`), Judgment Day agents, native review
  relays, read-only explorers, and writer admission behave exactly as before (prove the previous cases still hold).
- S6 Prompt and docs: the verification rule text points out that the runtime enforces it (keep module byte budgets);
  `docs/readme-reference.md` documents the admission next to the writer admission paragraph.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S6 | verifier admission, message, tests, prompt/doc text | delegated (context backstop: parent session is past it) | done (commit `feat(guards): admit the independent verifier only for named high-risk changes`, L2) |

## Log

- L1 (user, 2026-10-15): "Me gusta dale y mientras se hace explica el backstop" after the proposal in S1. Correction
  recorded in the bench roadmap L18: the earlier "retry after rejection" reading was wrong (the two writer launches
  were one parallel batch); the real waste was the verifier launch on a small task.
- L2 (T1, 2026-10-15): `lib/verifier-admission.ts` `rejectUnriskedVerifierLaunch` gates primary `subagent_run` launches
  of `gentle-ai-verify` (the catalog has no generic `verify` alias): admitted by a line starting `Risk: item N`
  (N 1-6, optional list marker), by a feature-document task line through the new shared
  `namesExistingFeatureDocumentTask` (writer admission now uses it too), or by `contextBackstopReached`; wired after
  writer admission in the `extensions/gentle-ai.ts` `tool_call` handler. Prompt: core rule 3 ", as rarely as
  possible" became ", runtime-enforced" (rendered core 9094 B at the 128-char root, budget 9100 B; the long-root case
  was at 9099 B before, so the `Risk: item N` detail went to `orchestrator-verification.md`, 7497/7500 B); the
  normative-section hash pin and the two exact-text pins were updated. Docs: third admission paragraph in
  `docs/readme-reference.md`. Evidence: RED (stub admitting everything) 5/7 failing in
  `tests/verifier-admission.test.ts`; GREEN 29/29 with the writer-admission and child-guard files; `pnpm test` all
  three stages passed (6875 tests, 6803 pass, 0 fail, 72 skipped); `pnpm -s typecheck` 0 diagnostics. A native
  review relay (`review-risk`) keeps its earlier candidate-view rejection, asserted by its message prefix.
