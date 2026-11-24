# Orchestrator owns correction exhaustion — diagnose the loop, decide the next step

When a worker exhausts its correction limit, the orchestrator diagnoses why the loop failed and decides how to continue; the user is asked only for genuinely human decisions. Building the RED test no longer spends the fix's corrections.
Branches `feat/orchestrator-owns-correction-exhaustion` in gentle-shell (base `defc9a6e6`) and gentle-ai (base `1ab243ca4`). Delivery: one PR per repository after verification. Runners: Node test runner (Shell), `go test` (Gentle AI).

## Specs

### S1 Orchestrator owns the next step

> "lo que yo haría es que el worker siga con dos intentos, pero cuando se acaben, que el orquestador decida con la nueva evidencia cómo continuar. No creo que tenga que ser algo del user."

> "durante la implementación, el que justamente implemente tiene que controlar dicha implementación es el orquestador."

The worker keeps its limit unchanged: one correction per failing check, a second only if the same check still fails after a real fix, then `status: partial` with the evidence. An exhausted worker limit ends that worker's cycle, not the unit: the parent owns the unit and decides the next step from the returned evidence, without asking the user. The user is asked only for a genuinely human decision (scope, authority, consent, privacy, destructive or publishing actions, denials).

### S2 Act on the cause of the loop

> "El único tema acá es que tenemos que identificar cuál es el problema del loop y actuar sobre ello."

Before continuing, the parent names the diagnosed cause from the evidence (for example: the test, not the code, was wrong; a wrong hypothesis; missing context; a setup or environment error; a real blocker). The continuation must act on that cause, through the route the active delegation mode allows: in organic mode the parent may fix it inline when it is small and understood (Task Size and writer rules unchanged); in full-delegation mode the parent never edits itself and instead launches a new bounded writer whose handoff carries the diagnosis and the new evidence, with a changed scope or hypothesis. Either way the parent decides; the user does not. Repeating the same attempt is forbidden. If the next attempt fails with the same diagnosed cause, or no new hypothesis exists, the parent stops that unit as blocked with the evidence and continues independent work; it asks the user only if the blocker is a genuinely human decision.

### S3 Building the RED test is not a fix correction

> "lo de que pase menos, sí, el punto uno puede ser."

Making a new test fail for the expected reason is RED construction, not a correction of the fix. Its own harness or setup errors get the setup bound (one self-fix), separate from the fix's correction limit; if the test still cannot reproduce the failure, the worker returns a reproduction blocker, not "corrections exhausted". No new numbers.

### S4 Preserve

Keep: the worker's two-attempt limit; no blind retries or self-reprompt loops; consent, security, destructive, publishing and remote boundaries; user-set one-run/no-retry limits; native review budgets; independent authorized work continuing. Never raise prompt budgets.

### S5 A refused delegation never ends the turn blocked

> "Toquemos el hallazgo, cuál sería la mejore solución."

> "si el usuario no sabe y está pidiendo justamente delegar algo que es chico y no está Contemplando la pérdida de tokens y demás, de última, mantenemos como lo tenemos, bloqueamos y le decimos no, no se puede delegar. Lo haré inline o algo así. O le damos ahí las preguntas con las recomendaciones."

Writer admission is unchanged: small organic work stays blocked from delegation, even when the user asks for it. When admission refuses a writer, the parent never ends the turn blocked: for small understood work it does it inline and says in one line why delegation was refused (it costs more for small work); if the user explicitly required delegation, it asks with `ask_user_choice` and a marked recommendation — do it inline (recommended for small work), track it as an ODD task, or switch to full delegation, plus the typed answer — and continues independent work meanwhile.

## Tasks

| Task | Status | Specs | Route | Commit |
|---|---|---|---|---|
| T1 Gentle AI: opencode worker + shared correction-bound wording | pending | S1–S4 | bounded writer | pending |
| T2 Gentle Shell: worker agent, always-on continuity paragraph, verification module, docs | pending | S1–S4 | bounded writer | pending |
| T3 Independent verification (risk 3) + full suites | pending | S1–S4 | verifier + parent | pending |
| T4 Measure (bench C11, OpenAI) if authorized | pending | S2–S3 | parent | pending |
| T5 Issues + PRs + merge | pending | all | parent | pending |
| T6 Gentle Shell: refused delegation never ends blocked (inline or ask with recommendation) | pending | S5 | bounded writer + verifier | pending |

## Log

- L1 (user, 2026-11-17, case report): "Hay un caso que me sigue pasando, este: … T1 quedó detenido: el implementador reprodujo el fallo de $HOME/work, pero agotó sus dos correcciones tratando de arreglar el propio test. No cambió el código de producción y no hay GREEN. No voy a pasarle lo mismo a otro agente para esquivar ese límite. Dejo T1 pendiente de una continuación acotada y avanzo con T2…"
- L2 (user): "es que quiero que veamls esto del linite de correcciones, otra vez solo me pasa con openai"
- L3 (user, decision): "Okay, no me parece bien lo de trabajo nocturno para nada lo de que pase menos, sí, el punto uno puede ser. El único tema acá es que tenemos que identificar cuál es el problema del loop y actuar sobre ello. Entonces, lo que yo haría es que el worker siga con dos intentos, pero cuando se acaben, que el orquestador decida con la nueva evidencia cómo continuar. No creo que tenga que ser algo del user. Bien, una cosa es el human in the loop. Pero durante la implementación, el que justamente implemente tiene que controlar dicha implementación es el orquestador."
- L4 (analysis): `assets/agents/gentle-ai-worker.md:74-76` counts every failing check, including the worker's own new test, against the fix's correction limit and hands exhaustion to "explicit human authorization"; `extensions/gentle-ai.ts:1727` tells the parent to "offer an explicit human-controlled bounded continuation". The verifier already has a separate setup self-fix (`assets/orchestrator-verification.md:26`); writers do not. Hypothesis for the OpenAI-only symptom: literal models count RED-construction iterations as corrections. The overnight/pre-authorization idea was rejected by the user.
- L5 (user, mode-aware correction, 2026-11-17): "Sí está bien, pero el problema es que, según el tipo de delegación que tenga el orquestador, no será él quien lo corrija." S2 rewritten: inline fix only where the active mode allows it (organic); in full delegation the parent decides and relaunches a bounded writer with the diagnosis. The same reply approves the C11 measurement spend (~US$1–1.5) proposed just before.
- L6 (T2 evidence): Pi commit `c94f81193` — worker contract, always-on continuation paragraph (mode-aware route), docs and pinned tests; RED→GREEN on bounded-stop, work-continuity and independent-recovery-delivery; organic primary prompt exactly at cap (24251/24251), full delegation −5 B. Full suite 11242 tests, 4 fail, 96 skipped; types 0; runtime modules OK. Classification: `tests/agents-prompt-lifecycle-runtime.test.ts` 7/7 and `tests/gentle-agents.test.ts` 351/351 pass in isolation (load flakes, #3205 seen before); `tests/session-profile-extension.test.ts` fails the two "A3 foreign launch …" cases identically on current main `defc9a6e6` (48 pass / 2 fail both) — pre-existing on main, not this change.
- L7 (C11 run 1, invalid): all 6 cells were stopped by organic admission ("small task has no existing ODD feature task") before any worker ran; the parent refused to bypass and ended with "needs a harness policy adjustment" even though the user prompt explicitly required delegation. US$0.49. Rerun with an ODD task in the fixture.
- L8 (user, decision): "Toquemos el hallazgo, cuál sería la mejore solución." Options presented: A (admit a verbatim-quoted user request), B (ask instead of stopping, no admission change), C (A + B). User chose C. Added S5/T6.
- L9 (user, scope change): asked when a user would legitimately request delegating small work, then: "si el usuario no sabe y está pidiendo justamente delegar algo que es chico y no está Contemplando la pérdida de tokens y demás, de última, mantenemos como lo tenemos, bloqueamos y le decimos no, no se puede delegar. Lo haré inline o algo así. O le damos ahí las preguntas con las recomendaciones." Option C replaced by B: admission unchanged; legitimate reasons (context relief, parallelism) are already covered by the backstop and parallel-unit reasons, and users who want delegation by default have full-delegation mode. S5 rewritten.
- L10 (evidence): T6 `8d216def4` — admission unchanged (existing admission tests untouched and green); rejection message routes to inline with a one-line cost reason, or ask_user_choice with a recommended inline option when delegation was required; RED 0/4 → GREEN 4/4; writer asset 5423/5426 B; card --check and types 0. Gentle AI `b69e51031` removes delegation-mode wording from the shared gate (user: "Sí, pero eso es porque Gentle aI no tiene full delegación."); Antigravity 53995/54000. Verifier P2 (full delegation: relaunch vs continue-same-worker) fixed in `510f3a942`. C11: run 1 invalid (organic admission, US$0.49); run 2 with an ODD task, 4/4 correct but no worker exhausted its corrections (the fixture's helper already isolates HOME), so the run does not discriminate; total US$1.16 of 1.50; no live-behavior proof for S1–S3. Final Pi suite at 8d216def4: 11247 tests, 5 fail, 96 skipped; the two A3 cases fail identically on main; desktop-feed-performance 10/10, desktop-rpc-changes 28/28 and gentle-shell-desktop 40/40 pass in isolation on both the branch and main (load flakes during the concurrent Go suite).
