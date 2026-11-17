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

Before continuing, the parent names the diagnosed cause from the evidence (for example: the test, not the code, was wrong; a wrong hypothesis; missing context; a setup or environment error; a real blocker). The continuation must act on that cause — fix it inline when small and understood, or relaunch with a changed scope, hypothesis or handoff that carries the new evidence. Repeating the same attempt is forbidden. If the next attempt fails with the same diagnosed cause, or no new hypothesis exists, the parent stops that unit as blocked with the evidence and continues independent work; it asks the user only if the blocker is a genuinely human decision.

### S3 Building the RED test is not a fix correction

> "lo de que pase menos, sí, el punto uno puede ser."

Making a new test fail for the expected reason is RED construction, not a correction of the fix. Its own harness or setup errors get the setup bound (one self-fix), separate from the fix's correction limit; if the test still cannot reproduce the failure, the worker returns a reproduction blocker, not "corrections exhausted". No new numbers.

### S4 Preserve

Keep: the worker's two-attempt limit; no blind retries or self-reprompt loops; consent, security, destructive, publishing and remote boundaries; user-set one-run/no-retry limits; native review budgets; independent authorized work continuing. Never raise prompt budgets.

## Tasks

| Task | Status | Specs | Route | Commit |
|---|---|---|---|---|
| T1 Gentle AI: opencode worker + shared correction-bound wording | pending | S1–S4 | bounded writer | pending |
| T2 Gentle Shell: worker agent, always-on continuity paragraph, verification module, docs | pending | S1–S4 | bounded writer | pending |
| T3 Independent verification (risk 3) + full suites | pending | S1–S4 | verifier + parent | pending |
| T4 Measure (bench C11, OpenAI) if authorized | pending | S2–S3 | parent | pending |
| T5 Issues + PRs + merge | pending | all | parent | pending |

## Log

- L1 (user, 2026-11-17, case report): "Hay un caso que me sigue pasando, este: … T1 quedó detenido: el implementador reprodujo el fallo de $HOME/work, pero agotó sus dos correcciones tratando de arreglar el propio test. No cambió el código de producción y no hay GREEN. No voy a pasarle lo mismo a otro agente para esquivar ese límite. Dejo T1 pendiente de una continuación acotada y avanzo con T2…"
- L2 (user): "es que quiero que veamls esto del linite de correcciones, otra vez solo me pasa con openai"
- L3 (user, decision): "Okay, no me parece bien lo de trabajo nocturno para nada lo de que pase menos, sí, el punto uno puede ser. El único tema acá es que tenemos que identificar cuál es el problema del loop y actuar sobre ello. Entonces, lo que yo haría es que el worker siga con dos intentos, pero cuando se acaben, que el orquestador decida con la nueva evidencia cómo continuar. No creo que tenga que ser algo del user. Bien, una cosa es el human in the loop. Pero durante la implementación, el que justamente implemente tiene que controlar dicha implementación es el orquestador."
- L4 (analysis): `assets/agents/gentle-ai-worker.md:74-76` counts every failing check, including the worker's own new test, against the fix's correction limit and hands exhaustion to "explicit human authorization"; `extensions/gentle-ai.ts:1727` tells the parent to "offer an explicit human-controlled bounded continuation". The verifier already has a separate setup self-fix (`assets/orchestrator-verification.md:26`); writers do not. Hypothesis for the OpenAI-only symptom: literal models count RED-construction iterations as corrections. The overnight/pre-authorization idea was rejected by the user.
