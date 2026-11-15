# Harness continuity — authorized autonomous work, tool-backed decisions, canonical ODD state

Make the orchestrator advance inside authorized work, ask only through real tools or genuine human decisions, and keep ODD state canonical across the three deliveries. This document is the docs-only bootstrap: it precedes every source mutation and owns requirements and status.
Branch `feat/harness-continuity`, baseline `3dc902975`. Delivery auto-chain `feature-branch-chain` with LOCAL work-unit commits only; no push, PR, or merge. Runners: the existing Node test runner and repo pipeline. Forecast 1500–3000 authored lines across all three deliveries, generated mirrors excluded; revise from evidence. ~400-line coherent work units are advisory, with no cosmetic splitting.

## Specs

### S1 Authorized autonomy

> "que el agente avance con autonomía dentro del trabajo autorizado, use las herramientas cuando necesita una decisión real y no te traslade decisiones técnicas que le corresponden al orquestador."

The agent continues inside the current authorization. It uses an available tool when a real decision is representable, and it does not return technical decisions that belong to the orchestrator to the human. The latest instruction to continue (L18) is authorized work inside the approved order; it does not reopen T1 or any accepted plan decision.

### S2 Preserve measured ODD

> "La admisión de writers en organic mediante tarea documentada, contexto o paralelismo."
>
> "Los umbrales actuales sin evidencia comparativa que justifique modificarlos."

Preserve modes, the full-delegation choice, isolated parallelism, explicit/native limits, secrets, human edits, remote/provider consent; RDD remains off. The L5 quote is historical evidence for the inventory's section 4 delegation rationale, not spec S4 (questions), and it is not an authoritative factual claim about current routing. A documented feature task ties the launch to an already-classified resumable unit. Preserve current mode-aware admission and the named writer reasons. Size alone or price alone is not a writer reason; small, understood organic work stays inline. Full delegation remains an explicit exception. The T1 acceptance cases specify the current admission; they do not change it, add writer reasons, or create fixture files. Do not invent new thresholds.

### S3 Continuity

> "Hay trabajo autorizado y ejecutable" → "Continuar."

A pending child is a wait event; only a genuine human decision is asked. Denial, missing consent, or an exhausted limit stops all work to which it applies and never resumes a prohibited path; genuinely independent authorized work may continue. Missing proof does not prevent authorized implementation, but it prevents false completion. Remove the generic "Needs your decision" terminal license and mandatory phrase; no blind final-text autoreprompt loop. T2's contract-level verification confirms this contract (L25–L27); live-model behavior remains T12.

### S4 Questions

> "No existe una decisión humana: ejecutar."
>
> "Existe una decisión representable por una herramienta disponible: usarla."
>
> "Hace falta una aclaración abierta o no hay interfaz compatible: texto."

Preserve closed tokens, lossless envelopes, and UI schemas; batch independent decisions when valid. T3 addresses this existing tool routing under the original plan; it is provisional risk 3 because ordinary and consent tool guidance consume shared contracts, and it adds no scope.

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

Canonical route validated: change the upstream `routing.go` and shared `close` source, and the changed bundle bytes require a new minor contract version 1.6. A local generated field-test mirror is allowed without modifying installer 4.5 or the capability digests. The production release artifact is a separate prerequisite to shipping and stays out of scope while publishing is off; implementation and development validation can proceed now. No released 1.6 claim. T2's parity evidence is contract-level only: the final bundle manifest and routing hashes are recorded in L27, with no released 1.6 or live-behavior claim.

### S11 Validation each delivery

> "ok te permito empezar, a darle con todo, ante cada entrega quiero uqe la valides"

Apply applicable RED/GREEN/PRESERVE; use an independent verifier for named risks. The existing static baseline (16/16 plus 27/27) is contract-level, not behavior proof. Freeze host, model, effort, and tools before and after. Measure quality plus hidden checks, unfinished work, question counts and tool use, worker approvals, and time/cost total with role split. Never conflate Codex-vs-Pi with prompt delta. No inference or credentials are authorized by this worker task; live benchmark spend and account scope need separate explicit permitted setup before launch, and no old grants are reused.

Initial acceptance cases for T1 (specification cases that gate T12; T12 owns the executable benchmark fixtures):

- **C1 Clear authorized work** — authorized, executable work continues without a synthetic pause.
- **C2 Real-decision tool** — a representable decision uses the available tool instead of free text.
- **C3 Same-objective surface** — a necessary route inside the same objective and authorized repository is parent-adjudicated.
- **C4 Actual scope change** — new product scope, an unapproved repository, privacy, destructive action, or consent reaches the human.
- **C5 Recoverable setup** — a recoverable setup failure is repaired without a budget reset or false completion.
- **C6 Denial or exhaustion** — denial, missing consent, or an exhausted limit stops all work to which it applies and never resumes a prohibited path; independent authorized work may continue.
- **C7 Small organic** — small, understood organic work stays inline with no writer.
- **C8 Cumulative explore** — cumulative exploration is bounded by the existing thresholds, not a fresh unmeasured budget.
- **C9 Parallel units** — isolated parallel work units keep their seams and evidence separate.
- **C10 Background resume** — background or resumed work re-reads canonical state and does not replay completed or prohibited paths.

Static coverage today comes from the current baseline contracts: `tests/bounded-stop-contract.test.ts`, `tests/no-self-pause-contract.test.ts`, `tests/primary-session-prompt.test.ts`, `tests/full-delegation-closure.test.ts`, `tests/work-continuity-contract.test.ts`, and `tests/append-system-prompt-route.test.ts`. These are contract-level checks; model behavior, cost, and time for C1–C10 remain unproven until T12, and contract tests are not model-adherence proof. T1 claims no new fixture files and no live proof. T2's contract slice is verified and committed locally (L25–L27); T12 remains pending explicit user order, and no live-model proof is claimed.

## Tasks

General rule: every task uses a bounded writer for all repository mutations, the parent owns git/state, and independent verification applies to risk 2/3 (and 6 model compliance) where relevant. Per-delivery validation uses accumulated per-unit evidence plus the delivery seam; no redundant full sweeps. Each delivery validates the static/runtime contract, not live-model proof; no behavioral completion claim is made before the needed benchmark. Source commits are local only; T2 has the two recorded commits (L25), and publishing remains off.

Local review boundaries (planned review organization, not created PRs): initial tracking checkpoint `fa500b099`; T2 canonical upstream slice `f2f7d7b16..4452c25e9`; T2 consumer behavior slice `fa500b099..12cb1a062`; tracking/evidence checkpoint `12cb1a062..fb4049f90`; T3 upstream slice `4452c25e9..93f57cbca`; T3 Pi slice `fb4049f90..5493425db`; the upcoming metadata checkpoint is separate. The next T4 upstream base is `93f57cbca`; Pi implementation begins after this metadata checkpoint, with the parent pinning its exact HEAD in the handoff.

Native review workload (aggregate): 984 authored lines across 4 Pi commits since `origin/main`, locks excluded. This is aggregate accounting, not the per-unit authored/generated accounting. Keep the approved auto-chain/feature-branch-chain strategy, coherent code/tests/docs, advisory review workload visible, and no cosmetic history rewrite.

| Task | Status | Linked specs | Route | Commit |
|------|--------|--------------|-------|--------|
| T1 Baseline and acceptance scenarios, frozen versions | done | S10, S11 | coordinator + bounded writer | `fa500b099` (docs); source baseline `3dc902975`; 16/16 + 27/27 |
| T2 Continuity | done | S1, S3 | bounded writer | GentleAI `4452c25e9900d56484b6ebcb3b8c30872ef715c7`; Pi `12cb1a062b6d996e9bf5de9db493796e16c073f4`; local only, no push/PR/release |
| T3 Questions | done | S4 | bounded writer | Gentle AI `93f57cbcaaa7edb887af9c0797d9e63b8089a322` (7 files, +510/−48; ~470 authored excl. generated); Pi `5493425db3d1e6a6e979913c6219831d732fd380` (13 files, +407/−19; ~404 authored excl. generated); risk item 3 shared contracts; no publishing |
| T4 Surface parent adjudication | in_progress | S5 | bounded writer | pending; provisional risk 3 (shared writer-surface guidance), confirm other risks during bounded mapping |
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
- L12 (evidence, independent baseline): `node --experimental-strip-types --test tests/primary-session-prompt.test.ts tests/full-delegation-closure.test.ts tests/work-continuity-contract.test.ts tests/append-system-prompt-route.test.ts` — run with isolated HOME, TMPDIR, and cache, `env -i`, and timeout 30; observed 27/27 pass, exit 0, 0 failed, 0 skipped. Source bytes are identical to `3dc902975`, and the docs bootstrap commit is `fa500b099`.
- L13 (decision, canonical route): change upstream `routing.go` plus the shared `close` source; changed bundle bytes require a new minor contract version 1.6. A local generated field-test mirror is allowed without modifying installer 4.5 or the capability digests. The production release artifact is a separate prerequisite to shipping and is out of scope while publishing is off; implementation and development validation can proceed now. No released 1.6 claim.
- L14 (risk, verification): T2 touches shared contracts at risk 3; reserve a separate commit and independent verification.
- L15 (transition): T1 is done on the accepted baseline evidence `fa500b099` plus 16/16 and 27/27; T2 is in progress; all other tasks remain pending.
- L16 (evidence, upstream baseline, job 2): `GOPROXY=off GOSUMDB=off go test ./internal/components/agentguidance ./internal/providercontractbundle ./internal/releasepolicy` with isolated HOME/TMPDIR and the existing public module/build cache — exit 0, all 3 packages pass (10.423s, 0.383s, 0.007s), source `f2f7d7b16`. This is a Go package summary, not a test count; no totals are inferred.
- L17 (user, benchmark-first question): "una cosa, no hubiera sido mejor hacer los cambios en gentle shell y probar primero con un bench a ver como impacta ? ademas de costo tiempo?"
- L18 (user, latest instruction, supersedes L17): "igual contiuna ya y termina como vas"
- L19 (decision, delivery order): a benchmark-first option was briefly selected, then L18 explicitly supersedes it. Keep the current approved three-delivery order and continue T2. Behavior, cost, and time are measured at T12; contract tests are not model-adherence proof. T1 is not reopened.
- L20 (evidence, T2 checkpoint): upstream source and tests are green with the initial RED observed. The parent identified 3 residual wording contradictions and the same worker is correcting them. The Linux-specific baseline is pending, and local container availability is not yet proven. T2 is not complete and no independent review has run yet.
- L21 (user, final confirmation): "mejor termina todo y ahi compara, no nos vayamos de lo definido por las dudsa". Final decision unchanged: finish the approved implementation and delivery checks first, then run comparative behavior, cost, and time work; do not rescope from doubts.
- L22 (evidence, T2 contract slice): upstream T2 RED/GREEN is recorded, and the parent's Linux check passed full `agentguidance`. The 23-variant baseline import hash is `be7291944f5587cc4e7676813355142ec63805fe076e5c3fc7d6a41311f5b810`; the one Windows-only skip is `TestClaudeModuleDeliveryWindowsHomeBinding`. Official field-test 1.6 Pi mirroring passed 98/98 for the writer plus parent, with package files 288/69 pinned 4.5 artifacts and card/mirror checks 0. Runtime harness job 4 exited 0 with empty output. Typecheck job 5 initially exited 1 with 13 TS2307 diagnostics in 11 old test pairs from explicit `../node_modules` imports; the bounded setup-only worker verified the existing main SDK targets and created an ignored worktree `node_modules` symlink to main `node_modules`, with no installs or source/baseline changes, and the corrected check exited 0 with `types: 0 recorded diagnostic(s), no regressions` and empty stderr. The initial failure is preserved, not waived.
- L23 (review, T2 contract slice, `mwhz6ftj-m-rq13`): S1, S2, S10, and S11 are met; S3 is UNMET. F1 (P1): the tracked pending-only enum omits the already-decided denial/exhausted boundaries declared by the canon. F2 (P2): the Pi tracking gate's unscoped explicit stop could stop unrelated runnable tasks. One independent-review correction batch is now in progress upstream, then the Pi consumer, and is not a budget reset; re-review is limited to F1/F2 afterward. No commits, no T2 closure, and no model proof. P3 advisories are not new scope.
- L24 (process, edit-surface overrun): the Pi writer edited `tests/orchestrator-prompt-diet-contract.test.ts` outside the original explicit Allowed edit surfaces (the execution itself was authorized). The parent later expressly included that exact same-objective test for review; the reviewer confirmed +24/−0 S3 assertions only, with budgets, modes, and ownership unchanged and no diff defect. This is not a claim of preauthorization or filesystem confinement. Other writers currently use Gentle AI sources only; no overlap.
- L25 (transition, T2 closure): T2 is verified and committed locally at GentleAI `4452c25e9900d56484b6ebcb3b8c30872ef715c7` and Pi `12cb1a062b6d996e9bf5de9db493796e16c073f4` on `feat/harness-continuity`; no push, PR, or release. T2 is done, T3 is in progress, and all other task statuses are unchanged.
- L26 (evidence, T2 bounded recheck): `mwi00qm0-s-pxp9` resolved F1 and F2; S3, S10, and S11 are met at contract level with no new findings. Parent job 6: final 100/100, 0 fail, 0 skip, plus runtime harness 0 on the final corrected bytes. The writer's fresh TSC reports 0 diagnostics and an unchanged baseline. Upstream Linux full run: 140 top PASS, 0 FAIL, 1 Windows SKIP. The final 23-variant baseline is `8dd6520d176bbf0c2de2176b797cb4170d1495f73ce53048e70aaafe3ca777ad`; the earlier `be729` artifact is historical, and older logs are not overwritten.
- L27 (evidence, T2 final artifacts): `-test.update` exited 2 with a parse error and wrote nothing; the corrected `-update` passed. The existing 13-TS2307 setup-failure history is preserved. Final bundle manifest `e8219d5f450ff63c5907044d36073f714269f1914359536fd1d764c36e701709`; routing `7251d74d5ce48f50f979c16a07b01323d5168bbb10bf996c3e1fb2de6a04e678`; field-test local 1.6 with the 4.5 pin unchanged. No live behavior claim; T12 remains pending the explicit user order.
- L28 (process correction, L24 clarification): the parent precommit diff also found `tests/append-system-prompt-route.test.ts` edited outside the original Allowed surfaces (the execution was authorized), the same missed delineation as the diet test. The parent reviewed the actual diff (+16/−5, approximately 21 changed lines): only anchors and expected-continuity clauses adapted to S3 canonical placement; the public 100 suite includes it, and the independent review had the actual full source. The parent expressly accepts that exact test change as necessary same-objective now; it was never preauthorized, and no confinement is claimed. No other unlisted change was found. L24 is not rewritten; this is an appended clarification.
- L29 (workload and rollback documentation): unit review workload is upstream ~498 authored changed lines, including new tests/docs and excluding generated files, and Pi 384. The coherent canonical change and regressions stay together, with no cosmetic file splits. Delivery strategy remains the auto-chain; local commits are not publishing. Rollback boundary: only T2 guidance/consumer changes in the two recorded commits plus paired tests/docs/generated files; do not blanket restore/reset worktrees or remove unrelated/later work or the dependency tree. This is rollback documentation only, with no rollback action.
- L30 (T3 start): T3 addresses the existing S4 tool routing under the original plan, with provisional risk 3 because ordinary and consent tool guidance consume shared contracts; no scope is added.
- L31 (native warning, review workload): after docs commit `fb4049f907f833ad8a9d512df2714eefc20ff02d`, the runtime reported 570 authored changed lines across 3 Pi commits since `origin/main`, with locks excluded from its counter. The writer's accounting is narrower: the upstream coherent unit is ~498 authored lines and the Pi consumer is 384, both excluding generated files. The tool aggregate also includes tracking checkpoints and its own accounting, so the counters are not identical; do not pretend all changes fit the ~400-line heuristic.
- L32 (local review boundaries): initial tracking checkpoint `fa500b099`; T2 canonical upstream slice `f2f7d7b16..4452c25e9`; T2 consumer behavior slice `fa500b099..12cb1a062`; tracking/evidence checkpoint `12cb1a062..fb4049f90`; the next Pi T3 slice starts at `fb4049f90`, and the next upstream T3 slice starts at `4452c25e9`. This is planned review organization, not created PRs. Keep tests and docs with their behavior; no cosmetic rewrite, reset, or splitting of existing commits. The existing auto-chain/feature-branch-chain strategy is preserved, with no publishing, reordering, or new feature. The review workload risk remains visible before any future publishing decision; no PR or release approval is claimed.
- L33 (evidence, T3 canonical source): canonical source first, the same unreleased contract 1.6.0, official generation/mirror only, and installer 4.5.0/released metadata unchanged. The canonical step-3 line grew by +226 B; no handlers, schema, threshold, mode, backstop, or consent protocol changed. Final hashes: manifest `8d5acf377dc663a5d8be3639f0c148231b90e1582316945524942622a12deb68`; routing `e427fb58db600e4e89f00dfeb74c51ce1b77ae67b359786e94dab8c8a2b1f304`; Linux baseline `9d9eaa54240b85fec618be2f71f5da07e771f20377c38771275fea3b3bd150fd`; Pi mirror tree `b4a2993a98acce22806156f9e8826dce5dfcaeb73e0cfd66e498a220cb8123e6`; orchestration `c0e7c4c2...` unchanged.
- L34 (evidence, T3 failures and correction chronology): the first upstream candidate added 654 B to the consumed step, causing a real scratch Pi budget RED (24583 vs 24164, 1 fail/12 pass). Two bounded source corrections fixed no-decision fallback scoping, exclusive tool priority, restricted text fallback, supported batching, and provider-only text-approval prohibition. Some test predicates initially scoped clauses too narrowly and were each corrected once. No cap was raised. The initial v1 RED was before production; RED with the final refined v1 tests against a temporarily restored base was retrospective differential, not newly claimed test-first. Later correction REDs were before edits. Do not rerun or reconstruct history.
- L35 (evidence, T3 RED/GREEN sequence): Pi initial RED 11 tests (4 pass/7 fail); docs RED 12 (11/1); guideline RED 13 (10/3: two gaps, one wrong `[x]` vs `[ ]` fixture), then green. A real full-delegation/lazy parity gap required two additional paths: `assets/orchestrator-full-delegation.md` and `assets/orchestrator-delegation.md`. The parent confirmed no foreign edits and authorized them as SAME-OBJECTIVE technical scope, without asking the human. New parity RED 15 (12/3), then 15/15. The worker acknowledged its "human decision remains" classification was wrong.
- L36 (review, T3 independent verification, `mwi30v95-10-2exv`): no blockers; S4 MET at contract level, S2/S3/S10 preserved, and S11 qualified (live behavior/cost/time pending T12). Own Go packages `agentguidance`, `providercontractbundle`, and `releasepolicy` all exit 0; Pi 15/15, separate 115/115, and diet 13/13; 15 baseline-vs-candidate interactive RPC scenarios with TOTAL_DIFFS=0; registered declarations excluding prompt metadata unchanged; mirror/hash mismatch count 0. Eighteen catalog agents plus a generic render were inspected; do not confuse that with 19 catalog entries.
- L37 (advisories, T3 P3, not fixed): three P3 advisories are recorded, not fixed or used to open another correction: bare wait could be read broadly (No-decision/S3 govern); existing "design decision" Ask words rely on step-3/tool guidance to exclude owned technical choices; pre-existing upstream `internal/assets/skills/_shared/research-lifecycle.md:6` still says one focused product question at a time (candidate for already-planned T11 parity, not a new requirement). Optional style refinements do not block T3.
- L38 (evidence, T3 measured footprint): workflow mode × persona (NOT RDD combinations): organic/gentleman 24152/24164, organic/neutral 24404/24416, full/gentleman 22111/22128, full/neutral 22363/22380. Lazy prompts 12964/13000, delegation 7314/7326. The verifier measured +1402 B of ask-tool guidelines in the SDK always-on `<rules>`, outside the primary-prompt cap; no total-model-cost improvement is claimed. Retain for T12 comparison.
- L39 (evidence, T3 parent spot checks): Pi decision suite 15/15; Go whole package 146 top PASS/0 FAIL/3 platform SKIP (Windows binding, Linux baseline, and Linux budget). The actual prior Linux run was 148 top PASS/0 FAIL/1 Windows-only SKIP and validates unchanged production bytes. Both final retained verifier probes were test-only PRESERVE, with no invented RED: the Go file now has 412 lines, focused 9 functions/126 subtests pass; the parent reran the new detail probe at 1 function/18 agents pass. The Pi file now has 379 lines, suite 17/17, and tools 54/54. The hash probe covers only JSON declaration shape, NOT function bodies; behavior/body evidence is execute tests/differential. Linux was not rerun solely for those platform-independent test additions.
- L40 (evidence, T3 final and close): final parent job 7 exited 0 after 9s: final Pi 17/17, types 0 recorded diagnostics/no regressions, and `git diff --check` clean. Log: `/var/folders/k1/2nnhpdfx0wq8k6w8n2nqx9_h0000gn/T/gpiZluYC/gentle-jobs-3BvBId/job-7.log`. Earlier provider/card/package checks pass; the card is unchanged, and the package has 288 files/69 pinned artifacts. The full repository suite and runtime generation check were not run for T3; delivery validation remains T5. No live-model run. Early writer outer timeouts of 120–300 s deviated from the <=30/parent-background instructions; none actually timed out. Later focused checks used <=30 s and the parent's final types check used the background. Keep the deviation and do not claim failure where none happened. T3 is done with both local commits; T4 is in progress; T1/T2 remain done; T5–T13 remain pending. This closes T3, not Delivery A; no new specs and no reordering.
