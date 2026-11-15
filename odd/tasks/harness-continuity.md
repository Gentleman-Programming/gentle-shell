# Harness continuity — authorized autonomous work, tool-backed decisions, canonical ODD state

Make the orchestrator advance inside authorized work, ask only through real tools or genuine human decisions, and keep ODD state canonical across the three deliveries. This document is the docs-only bootstrap: it precedes every source mutation and owns requirements and status.
Branch `feat/harness-continuity`, baseline `3dc902975`. Delivery auto-chain `feature-branch-chain` with LOCAL work-unit commits only; no push, PR, or merge. Runners: the existing Node test runner and repo pipeline. Forecast 1500–3000 authored lines across all three deliveries, generated mirrors excluded; revise from evidence. ~400-line coherent work units are advisory, with no cosmetic splitting.

## Specs

### S1 Authorized autonomy

> "que el agente avance con autonomía dentro del trabajo autorizado, use las herramientas cuando necesita una decisión real y no te traslade decisiones técnicas que le corresponden al orquestador."

The agent continues inside the current authorization. It uses an available tool when a real decision is representable, and it does not return technical decisions that belong to the orchestrator to the human.

### S2 Preserve measured ODD

> "La admisión de writers en organic mediante tarea documentada, contexto o paralelismo."
>
> "Los umbrales actuales sin evidencia comparativa que justifique modificarlos."

Preserve modes, the full-delegation choice, isolated parallelism, explicit/native limits, secrets, human edits, remote/provider consent; RDD remains off. The L5 quote is historical evidence for the inventory's section 4 delegation rationale, not spec S4 (questions), and it is not an authoritative factual claim about current routing. A documented feature task ties the launch to an already-classified resumable unit. Preserve current mode-aware admission and the named writer reasons. Size alone or price alone is not a writer reason; small, understood organic work stays inline. Full delegation remains an explicit exception. Do not invent new thresholds.

### S3 Continuity

> "Hay trabajo autorizado y ejecutable" → "Continuar."

A pending child is a wait event; only a genuine human decision is asked. Denial, missing consent, or an exhausted limit stops all work to which it applies and never resumes a prohibited path; genuinely independent authorized work may continue. Missing proof does not prevent authorized implementation, but it prevents false completion. Remove the generic "Needs your decision" terminal license and mandatory phrase; no blind final-text autoreprompt loop.

### S4 Questions

> "No existe una decisión humana: ejecutar."
>
> "Existe una decisión representable por una herramienta disponible: usarla."
>
> "Hace falta una aclaración abierta o no hay interfaz compatible: texto."

Preserve closed tokens, lossless envelopes, and UI schemas; batch independent decisions when valid.

### S5 Surfaces

> "El worker no se autoautoriza."

The parent may authorize necessary routes with the same objective in the same authorized repository after assessing ownership, risk, and concurrency. The human is required for actual new product scope, an unapproved repository, independent privacy, destructive actions, and consent boundaries. On extension, continue the same worker and keep still-needed old paths because replacement is not union; no repo-wide workaround and no budget reset; record a concise reason.

Tests: positive coverage of a needed test/helper route; negative coverage of refactor-only scope, another repository, private data, and ownership/overlap conflict.

### S6 Verification

> "No inventaría nuevos números de intentos en esta primera pasada."

Keep worker, setup, recheck, native, and user budgets separate. Changed state may justify a fresh check, but not a budget reset. Verify proportionally with spot checks, probes, and seams; keep applicable TDD, reproduction, high-risk independence, isolation, resource limits, regression coverage, and honest partial reporting.

### S7 State

> "Documento ODD: fuente canónica de requisitos y estado de la feature."
>
> "Todo: proyección visible."
>
> "Engram: continuidad persistente, con su contrato de identidad y actualización."

Reuse existing hooks and projections; preserve exact requirements, evidence, and ownership; add no new storage or reconciliation framework. Make no false persistence claims. Keep tracking for large work only, with the 400-line heuristic. Local work-unit commits stay separate from publishing. Preserve conditional RDD and frozen proof.

### S8 Presentation

Preserve human-language and artifact preferences. Reduce redundant anchors when the runtime owns the state. Keep automatic phase labels and cosmetic defaults. Remove the generic mandatory Key Learnings ritual in favor of actual memory-owned learning.

### S9 Support

Move the verbose provider-defect report workflow into a focused skill/capability loaded when used. Preserve privacy, consent, duplicate, and uncertainty handling. Add no automatic support bureaucracy.

### S10 Parity

Edit the canonical upstream source, then regenerate consumers per unit; never hand-edit generated copies. Map the existing three-call batch, cumulative 3/40k, shared ~5, and context backstop without changing observed thresholds on intuition. Keep justified writer triggers. Clarify the Codex hard-gate referents. Align the real Pi delivery preflight with the text without removing the guard.

### S11 Validation each delivery

> "ok te permito empezar, a darle con todo, ante cada entrega quiero uqe la valides"

Apply applicable RED/GREEN/PRESERVE; use an independent verifier for named risks. The existing 16 static tests were green but are not behavior proof. Freeze host, model, effort, and tools before and after. Cover real decision, no decision, surface expansion, genuine scope, setup failure, denial, small organic, explore, parallel, and background cases. Measure quality plus hidden checks, unfinished work, question counts and tool use, worker approvals, and time/cost total with role split. Never conflate Codex-vs-Pi with prompt delta. No inference or credentials are authorized by this worker task; live benchmark spend and account scope need separate explicit permitted setup before launch, and no old grants are reused.

## Tasks

General rule: every task uses a bounded writer for all repository mutations, the parent owns git/state, and independent verification applies to risk 2/3 (and 6 model compliance) where relevant. Per-delivery validation uses accumulated per-unit evidence plus the delivery seam; no redundant full sweeps. Each delivery validates the static/runtime contract, not live-model proof; no behavioral completion claim is made before the needed benchmark. Source commits are pending for every task.

| Task | Status | Linked specs | Route | Commit |
|------|--------|--------------|-------|--------|
| T1 Baseline and fixtures, frozen host/model/effort/tools | in_progress | S10, S11 | coordinator + bounded writer | pending |
| T2 Continuity | pending | S1, S3 | bounded writer | pending |
| T3 Questions | pending | S4 | bounded writer | pending |
| T4 Surface parent adjudication | pending | S5 | bounded writer | pending |
| T5 Validate Delivery A | pending | S1–S5, S11 | parent + independent verifier | validation record only; static/runtime contract, no behavioral claim before benchmark |
| T6 Verification budgets and proportional checks | pending | S6 | bounded writer | pending |
| T7 Tracking and memory projection | pending | S7 | bounded writer | pending |
| T8 Presentation | pending | S8 | bounded writer | pending |
| T9 Support workflow as focused capability | pending | S9 | bounded writer | pending |
| T10 Validate Delivery B | pending | S6–S9, S11 | parent + independent verifier | validation record only; static/runtime contract, no behavioral claim before benchmark |
| T11 Final parity and routing check | pending | S10 | bounded writer | pending |
| T12 Matched behavior benchmarks | pending | S11 | parent + independent verification | pending |
| T13 Validate Delivery C and close | pending | S1–S11 | parent + independent verifier | validation record only; static/runtime contract, no behavioral claim before benchmark |

## Log

- L1 (user, latest authorization): "ok te permito empezar, a darle con todo, ante cada entrega quiero uqe la valides"
- L2 (user, prior request): "listo dame todo el plan como para empezar a implementar"
- L3 (user, acceptance of plan sections): "para el 5 acepto todo, el 6 tambien, 7 tambien"
- L4 (user, reported symptom): "y te tengo otra, el famoso "autorizas extender el rango a estos archivos?" me pasa muchisimo cuando un worker necesita extender su trabajo y el orquestador me detiene"
- L5 (user, correction on plan section 4, revalidated as ODD behavior): "tambien el 4 muchas de las cosas son por funcionamientos de ODD vuelve a validarlo, por ejemplo lo de organic que un writer tenga una tarea creo que era porque ahi es cuando vemos qeu una tarea es grande y vale la pena delegar sino es meOr que lo haga inline, algo asi era"
- L6 (evidence, baseline read-only): the local baseline is `3dc9029755912358d0a172b4972e5842c239570c` (Shell 4.8.0, Nov 14), seven commits ahead of root main `116821b9a`, and the isolated feature branch was fast-forwarded to it with this document preserved. Upstream gentle-ai `origin/main` is `f2f7d7b16c2cf1afe5e07f717cf8265946ac3feb`, not the unrelated `f109e49ea` HEAD whose branch diverges 2/5; that checkout is not mutated. The benchmark root is stale at `exp/model-economy 1321c60`; the canonical bench baseline is origin `2486ec4`, linked to the bench session, with #2687 results 3/3 explore vs 0/3, 12/12 answers, and no 3-vs-5, time, or cost proof. The S16 gate and P6 parallel measured benefits are accepted and preserved.
- L7 (evidence, source surfaces): `extensions/gentle-ai.ts`; `assets/orchestrator*.md` and agents; the ask extensions; gentle-ai shared/routing/Codex; bench fixtures. Writer mappings are selected by the parent later.
- L8 (plan evidence): plan sections 5, 6, and 7 were accepted as written, and section 4 was revalidated from ODD behavior (L5), not replaced by a partial checklist.
- L9 (process): docs-only bootstrap created in the isolated worktree `feat/harness-continuity` at `116821b9a` before any source mutation, then fast-forwarded to baseline `3dc902975`; no source/test edits and no commits in this step.
- L10 (parent correction, baseline): canonical work uses the latest local refs, with no fetch or network. Do not import the user's unmerged Codex module branch. The benchmark baseline is canonical origin `2486ec4`.
- L11 (evidence, baseline static contract): `node --experimental-strip-types --test tests/bounded-stop-contract.test.ts tests/no-self-pause-contract.test.ts` — parent observed 16/16 pass, exit 0, on `3dc902975`.
