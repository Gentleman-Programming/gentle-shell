# #1494 orchestration overhead: measure, then fix what remains

Objective: re-measure gentle-shell#1494 on current main, then fix the remaining overhead classes, one focused PR per class, and close the umbrella.
Branch/worktree: `fix/overhead-1494` at `.worktrees/overhead-1494` (base origin/main 116c0e997); later tasks branch per PR from updated main. Delivery: one PR per task, merged after green CI. Runner: `node --experimental-strip-types --test`, `pnpm test`, `pnpm run typecheck`.

## Specs

**S1 — User request, verbatim:** "dale y vamos atacando los que quedan", answering the parent's proposal: "¿Querés que corra la medición, o que deje en el issue un comentario con este resumen y la propuesta de cierre?" after this recommendation (parent text, accepted):

> 1. Correr de nuevo el A/B original sobre `main` y fijar el criterio. Yo propongo ≤1.5x en tareas chicas.
> 2. Si pasa, **cerrar #1494** como resuelto en su alcance original.
> 3. Abrir issues enfocados para lo que queda: el overhead de registro y seguimiento, los loops de reconciliación en tareas grandes, la recuperación automática de fallos triviales del verificador dentro de un presupuesto, y la clase de review para cambios de texto en `gentle-ai`.

**S2 — Measurement (T1).** Re-run the original #1494 fixture (three one-line bugs in `inventory.py`, three failing `unittest` tests, the issue's exact prompt) on current main: bare Pi with only the todo extension vs. the gentle-shell harness, same model and effort, at least 3 pairs, isolated directories outside the repo. Report per arm: tests passing, wall time, tool calls, subagent runs, Engram ops, ODD files created, parent tokens. Criterion (parent proposal, accepted in S1): small-task overhead ≤1.5x median wall time and tool calls vs. bare. Never read or copy credentials; use the user's existing provider login only through the normal `pi` runtime.

**S3 — Verifier trivial setup failures (T2).** Parent-observed evidence 2026-11-10: verifier setup failed on its own mistakes (`NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` both `/dev/null`; `--registry` passed to `pnpm list`), and each failure became a human decision until the user wrote "dios hace todo y dejame de joder please". Keep #2641's bound (no repair loops), but a deterministic setup error the verifier itself caused gets one self-corrected preparation attempt without asking the human; a second failure, or an environmental/unavailable prerequisite, still stops with zero tests run.

**S4 — Large-task tracking/reconciliation loops (T3).** From #1494 comment by @wiltonAndrey (2026-11-10): repeated reconciliation failures on the feature document/Engram mirror, whole-document rewrites, an invented exact line-count gate, and the same missing `## Allowed edit surfaces` rejection twice. Scope set after mapping; must preserve tracking and verification guarantees.

**S5 — Bookkeeping share (T4).** @zhalker field data: ~25% of tool calls are `todo`, `mem_*`, `gentle_odd_phase`. Attribute with T1 data before changing policy; fix only what the data shows.

**S6 — Open PR #2951 (T5).** Review "perf(agents): trim always-on agents-family tool prose with a budget"; merge if correct and green.

**S7 — Wording-only review class (T6).** Belongs to the gentle-ai repository (`review assess`); cross-repository work needs explicit consent at that point.

**S8 — Close (T7).** Post the measurement and status to #1494; close it if S2 passes; open focused issues for anything not fixed.

## Tasks

T1 | S2 | delegated worker mwav85lh-5-zy0q + follow-up mwawkaib-e-o37q | done: organic n=3 1.19x wall / 1.21x calls (meets ≤1.5x); full-delegation 7.01x (by design, see L8)
T2 | S3 | writer mwavc41i-9-175g + 1 correction mwaw8et4-c-2bum; verifier mwaw44l7-b-i9d3 FAIL(B1) → recheck mwawb1ag-d-rhbb PASS | done: PR #3084 merged 63c5acfdd (CI green); advisory "if none" open
T3 | S4 | writer mwavc49j-a-mj3u (prompt guidance only); parent clean-env 462/462 | done: PR #3083 merged 4b43fdce1 (CI green)
T4 | S5 | docs: full-delegation small-task cost and purpose (this repo); per-fix mem_save rule lives in the Engram protocol (gentle-engram / gentle-ai), not here → focused issue | pending
T5 | S6 | read-only review mwav8f2m-7-8tw5 → changes requested on PR (author active 4 days ago) | blocked: waiting on @decode2
T6 | S7 | ask cross-repo consent when reached | pending
T7 | S8 | parent | pending

## Log

L1. 2026-11-10 user: "dale y vamos atacando los que quedan" (accepts S1 recommendation).
L2. Context: triage of #1494 found 11 merged PRs citing it (#1723, #1728, #1955, #1986, #2247, #2457, #2460, #2641, #2670, #2976, #3002), #2951 open, no post-change re-measurement, no agreed criterion.
L3. Explorer map: the human round-trip on verifier setup comes from assets/orchestrator-verification.md:24-26 (any setup failure -> Needs your decision), plus gentle-ai-verify.md:41 and the injected paragraph at extensions/gentle-ai.ts:1660 (golden copy). Wilton's five reconciliation strings are not in the repo (agent-authored codemode scripts); whole-file rewrites are already forbidden at orchestrator-memory.md:14; exact line-count gate has no source; the Allowed edit surfaces admission check is correct.
L5. T5 review: PR #2951 mergeable, merged tree 223/223, budget real (main 26345 B -> 25489 B of 25600). Blocker: workspace_root description dropped "main or" though runtime accepts the main checkout. Advisories: env-dependent budget test and silent skip of 8 tools; todo guideline loss. Per standing policy (author activity within 14 days -> request changes, no takeover), posted CHANGES_REQUESTED review. Scratch /private/tmp/pr2951-VgskUj.
L6. T1 (3 pairs, main 116c0e997, openai-codex/gpt-6.1-sol low): A default = full-delegation (profile openai-oauth-delegation, workers openai/gpt-6.1-terra @ max) median 316.7 s vs B 42.9 s = 7.38x wall, 3.0x calls incl. children; subagents 63-82% of wall time. Original classes gone: 0 gentle_review, 0 gentle_odd_phase, no ODD/.atl files, no per-test verifier. Organic (GENTLE_PI_ORCHESTRATOR_MODE=organic) n=1: 1.18x wall, 1.14x calls. Bookkeeping excess = one mem_save per fix ("save after every bugfix"), todo equal in both arms. Report odd/tasks/1494-overhead-measurement.md; scratch /private/tmp/overhead-1494-X8jpvt. Benchmarks need env -i (GENTLE_PI_AGENTS_CHILD leaks). Following up with organic n=3.
L7. Organic n=3: 53.6 s vs B median 45.15 s = 1.19x wall, 17 vs 14 effective calls = 1.21x; the whole call excess is one mem_save per fix in its own turn; parent tokens 4.35x from the larger cached system prompt.
L8. 2026-11-10 user chose "Dejarlo como está y documentarlo" for full-delegation, explaining: "hay casos donde vos tenés un orquestador que es muy caro, como puede ser Astra, por así decirlo, y luego podés tener workers que son muy muy livianitos, como puede ser Dipsyc, Flash o algún modelo local." Parent noted the measured profile is inverted (parent gpt-6.1-sol low, workers gpt-6.1-terra @ max); not changed.
L9. PR #3084 (T2) and PR #3083 (T3) merged 2026-11-10 after full CI.
L4. Parent decisions: T2 = one self-corrected preparation attempt for verifier-caused deterministic setup errors, no human decision; parent may relaunch once with a corrected command form. T3 = prompt guidance only, no new runtime enforcement (goal is less ceremony). First T2 launch lacked workspace_root (ran in main checkout cwd) and was cancelled with 0 tool calls; relaunched in its worktree.
