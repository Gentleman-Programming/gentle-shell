# Proportional task routing (gentle-shell#1494)
Branch: `fix/1494-small-task-overhead` (base `origin/main` cf3012f7) · Worktree: `/home/gentleman/work/gentle-pi-1494` · Delivery: single-pr with size exception (L14) · Runner: `node --experimental-strip-types --test <file>`; full `npm test`, `npm run typecheck`
Engram mirror: `odd/proportional-task-routing/tasks` · Route: inline for every task (L1: "sin delegar")

## Specs
S1. Scope: "la 4 y 5 no se tocan, los otros si". In scope: cause 1 (Verification rule contradicts Inline Direct), cause 2 (classification counts steps), cause 3 (writer and evidence triggers count files and lookups). Out of scope: cause 4 (gentle-engram memory protocol) and cause 5 (RDD review behavior).
S2. Small vs large: "definamos muy bien que es una tarea chica o grande, desde cuando hay que hacer todo el prcoeso o no". A task is small when all three hold:
    - Understood: the outcome is specified, what and where to change is known, no open product or design decision; proven within one bounded read batch (~3 calls, ~10k tokens).
    - Contained risk: it touches no high-risk item (S5).
    - Resume test: "Si la sesión se cortara ahora, ¿alguien podría terminar el trabajo solo con el pedido original y el `git diff`?" Yes → small.
    Never classify by number of files, commands or tests, fixes, or a requested todo list.
S3. Large means only: the resume test fails (multiple sessions, waits on something external, separate deliverables, or long requirements that compaction could lose). Large turns on the full process: feature doc + Engram mirror + todo, writer delegation, work-unit commits. Small runs inline: read, edit (several files of one understood change included), focused test and suite once each, RED observed inline, no explore/worker/verify, no feature doc or mirror, no commits unless asked, todo optional.
S4. Per-mechanism escalation: "en la escalada, hay que escalar TODO? o por ejemplo si hay una decision de diseño que luego de definirse sigue manteniendo lso anteriores criterios para no delegar, o por ejemplo hace falta leer mas, por ahi solo hciendo un explore ya estaria." Each mechanism turns on only by its own trigger; after it resolves, re-evaluate and stay small when the criteria still hold:
    | Mechanism | Trigger |
    | Ask the user | open product or design decision |
    | Delegated explore | understanding needs more than one bounded read batch |
    | Independent verifier | high risk (S5) |
    | Feature doc + mirror + work-unit commits | resume test fails |
    | Delegated writer | the task is tracked (resume test fails) or the ~150k context backstop |
S5. High risk: "que es alto riesgo?" A change is high risk when a mistake would be hard to detect, hard to undo, or reaches beyond the change. It touches any of:
    1. Data or irreversible effects: migrations, deleting or rewriting persisted data, persisted formats.
    2. Security: auth, permissions, credentials, secrets, guards or sandbox.
    3. Contracts others consume: public API, CLI flags, config formats, published exports, prompts or contracts another repo mirrors.
    4. Concurrency: locks, races, async ordering.
    5. Delivery or environment: installers, release, CI, deploy, dependency changes.
    6. No safety net: no test would catch a regression in what changes.
    "Unclear" counts as high only when a bounded look cannot tell whether items 1-5 apply. When RDD is on and native assess returns a tier, that tier wins.
S6. Agent-raised risk: "que el agente defina segun nuestros criterios que es algo que amerite una verificacion o un RDD". Accepted design (L9): the agent may raise risk citing an S5 item, never lower it; lowering stays deterministic in Go. With RDD on, the raise travels as a field of the existing assess call (no new call): `{"operation":"assess","escalate":{"item":2,"reason":"..."}}`. The field does not exist today ("para el 2, entonces no habria que hacer nada porque ya viene el escalado de golpe y listo no?" → L11): it needs gentle-ai G2, the gentle_review facade, and the rule text.
S7. Efficiency axes: "1- reduccion en consumo de tokens, 2- tratar de que sea mas ingreso que egreso de los mismos, 3- latencia, 4- contexto cargado en el agente por las reglas, ver como hacer lazy loading".
    - The small path reads no lazy rule file: the always-on kernel holds everything it needs.
    - `assets/orchestrator-delegation.md` (49 KB) splits into per-mechanism modules, each with a byte budget, loaded only when its mechanism turns on.
    - The always-on prompt does not grow beyond the current 8,192 B budget.
    - Prefer input over output: reference instead of copy, edit instead of rewrite, mechanical work done by code instead of the model.
S8. Replication: "todo lo que hagamos ahora se tiene que replicar para los otros agentes de gentle-ai". Pilot in gentle-pi, measure, then port to the gentle-ai canon (`internal/components/agentguidance/routing.go`) with a parity check.
S9. Measurement: bench baseline (origin/main cf3012f7) vs after, same scenarios: #1494 three-bug fixture; Alan's two small bugs; a known-large task; a risky change in an innocently named file; a task with a design decision mid-way. Metrics: input, output and cache-read tokens, input/output ratio, wall time, turns, subagents, always-on bytes.

### Acceptance criteria
- AC1 (S2) [contract] one canonical definition of the three criteria; other files reference it, never restate it.
- AC2 (S2) [contract] the text says file, command/test, fix counts and a todo request never classify; "two or more meaningful implementation steps" has 0 occurrences in extensions, assets, the skill and docs (the canon fixture changes only with G1, L15).
- AC3 (S3) [contract] Inline Direct allows running the focused test and suite inline; "only a read-only check within the evidence budget stays inline" is gone; Simple Delegation no longer cites "running focused tests/builds" for small work; test-first RED stays.
- AC4 (S4) [contract] the five mechanisms with their triggers and the re-evaluate rule; the writer trigger no longer counts files.
- AC5 (S5) [contract] the high-risk list exists once in gentle-pi; native tier wins when available; "unclear" bounded as in S5.
- AC6 (S6) [contract+unit] gentle_review assess accepts `escalate` with item 1-6 and a reason; anything else is rejected; never lowers (blocked on G2 for native effect).
- AC7 (S7) [contract] always-on render ≤ 8,192 B; no lazy module referenced on the small path; each lazy module under its byte budget.
- AC8 (S9) [bench] #1494 fixture: 0 `subagent_run`, 0 files under `odd/tasks/`, 0 commits, tests 3/3; Alan's shared-logic bug: 0 explore/worker/verify, hidden tests pass; known-large task still creates the doc and delegates; design-decision task continues inline after the answer; risky-innocent-path task gets raised risk.
- AC9 [all] `npm test` and `npm run typecheck` pass; tests pinning old wording change in the same commit.

## Tasks
- [ ] T0 (S9) in progress · baseline bench re-run at main cd4ba5a7 (L17), arm B on s1-tasklog, s2-ledger, l1-tasklog; new scenarios pending
- [x] T1 (S1-S5, S7) inline · always-on Task Size + Mechanisms in assets/orchestrator.md; harness Classify/steps 5-6; delegation, skill, readme aligned; contract tests · RED→GREEN · 3e5c8012 (rebased from 6f882b6b)
- [x] T2 (S7) inline · orchestrator-delegation.md split into tracking/verification/writer/prompts modules; union test helper; AC7 budget test · refactor under existing contract tests · 6f8a78b8
- [x] T3 (S5, S6) inline · `escalate` input on gentle_review assess (raise-only, pi-side), HIGH_RISK_ITEMS, rule text in verification/tracking modules · RED→GREEN · 711ad9db
- [x] T4 (S7) inline · edit-not-rewrite rule and codemode mirror refresh in orchestrator-memory.md; extension-side auto-mirror spike → F3 · RED→GREEN · f508715f
- [x] T5 (S9) inline · existing scenarios (L25) and new bench scenarios x1/x2/x4 measured (L31); design-decision scenario not measurable unattended
- [x] G1 (S8) gentle-ai `fix/1494-task-size-canon` (worktree ~/work/gentle-ai-1494, on main 665a181a) · canon + 12 orchestrators + shared sections + docs · RED→GREEN · 66399a57
- [x] G2 (S6) gentle-ai · `review assess --escalate-item/--escalate-reason` · RED→GREEN · 95ee74d0
- [x] G3 (S6) filed as gentle-ai#5216 (follow-up, not implemented here)
- [x] F1 filed as gentle-shell#1722 (~/AGENTS.md is 58,881 B with gentle-ai blocks)
- [x] F3 filed as engram#1636 (gentle-engram lives in the engram repo, plugin/pi)
- [x] F2 (S7) inline · skip the mirrored RDD review contract (8.5 KB) when RDD reads off; on/unknown keep it · RED→GREEN · 08fda673
- [x] T6 (S2-S7) inline · RDD review follow-ups from the four slice reviews (L28) · RED→GREEN · fe973987 (+ 6bc82417 regenerated runtime module)

## Log
L1 2026-10-03 user (verbatim): > sin delegar y en nuevo worktree, vamos a analizar https://github.com/Gentleman-Programming/gentle-shell/issues/1494
L2 2026-10-03 analysis: cause 1 assets/orchestrator.md:41 vs :58, orchestrator-delegation.md:141,179,194-200; cause 2 harness Classify "two or more meaningful implementation steps" (extensions/gentle-ai.ts) and orchestrator-delegation.md:75; cause 3 orchestrator.md:54-55, orchestrator-delegation.md:137-138; cause 4 gentle-engram protocol; cause 5 contracts/review-provider-contract-mirror/v1.2.0/bundle/orchestration/pi.md:7. Pinned by tests/odd-routing-contract.test.ts:270,279, tests/rdd-aware-verification-contract.test.ts, tests/orchestrator-budget.test.ts:356, fixtures/odd-routing-canonical.md.
L3 2026-10-03 user (verbatim): > la revision obligatoria es de RDD?
   finding: yes, and RDD is off by default (extensions/gentle-ai.ts:5376).
L4 2026-10-03 user (verbatim): > la 4 y 5 no se tocan, los otros si, definamos muy bien que es una tarea chica o grande, desde cuando hay que hacer todo el prcoeso o no
L5 2026-10-03 user (verbatim): > dfine para cada item un acceptance criteria
L6 2026-10-03 user (verbatim): > ojo con algo, en la escalada, hay que escalar TODO? o por ejemplo si hay una decision de diseño que luego de definirse sigue manteniendo lso anteriores criterios para no delegar, o por ejemplo hace falta leer mas, por ahi solo hciendo un explore ya estaria. Luego tambien... que es alto riesgo?
   finding: gentle-pi has no written high-risk list; the tier comes from native assess (orchestrator-delegation.md:101,181-186).
L7 2026-10-03 user (verbatim): > que es C, y vale la pena retomar? o que tiene seguimiento?
L8 2026-10-03 user (verbatim): > el  ASSESS nativo de gentle-ai tenemos que cmbiarlo entonces para lo nuevo que estamos haciendo y que el agente defina segun nuestros criterios que es algo que amerite una verificacion o un RDD
L9 2026-10-03 user (verbatim): > es que todo lo que hagamos ahora se tiene que replicar para los otros agentes de gentle-ai, pero sabes que pasa? no tienes en memoria los experiemntos que hicimos con un modelo intermedio para definir el nivel de severidad tanto para odd como rdd? el determinismo funciona pero no es un accurate ahora mismo
   evidence (gentle-ai Engram 20843-20845, PR #4971): Go heuristic uses paths + a small regex and leaves small active code at medium; Laya real-diff AUC 0.57; Kev-4B AUC 0.74, 7.1% ODD escalations, ~4/8 justified, ~1.4 s/commit, ~18 GB; both blind to weakened auth in innocent paths and secret leaks.
   user (verbatim): > dale  (accepting escalate-only: agent raises, never lowers; lowering stays deterministic)
L10 2026-10-03 user (verbatim): > dale, dame toda la planificacion y piensa tambien como hacerlo de esta manera 1- reduccion en consumo de tokens, 2- tratar de que sea mas ingreso que egreso de los mismos, 3- latencia, 4- contexto cargado en el agente por las reglas, ver como hacer lazy loading
   measured: always-on orchestrator.md 7,599 B; harness block ~5 KB; RDD mirror pi.md 8,509 B always injected; orchestrator-delegation.md 49,435 B lazy but monolithic; gentle-ai-worker.md 10,969 B per worker.
L11 2026-10-03 user (verbatim): > para el 2, entonces no habria que hacer nada porque ya viene el escalado de golpe y listo no?
   finding: assess accepts only baseRef/committedOnly/writerModelId/writerEffort (extensions/gentle-ai.ts:890-916); "escalated" in lib/native-review-cli.ts:240 is a recovery disposition, unrelated.
L12 2026-10-03 user (verbatim): > ok escribe todo en un odd y vamos a darle!!
L13 2026-10-03 forecast: T1 ~250, T2 ~1,000 mostly moved lines, T3 ~150, T4 ~150 authored changed lines; above the ~400 budget, so ask-on-risk asks for the chain strategy before the first commit.
L14 2026-10-03 user (answers): chain strategy > pr con size exception · T0 bench > Sí, autorizo (read and run `~/work/gentle-shell-bench`, 5 scenarios against origin/main cf3012f7).
L15 2026-10-03 T1 evidence (risk: medium, prompt-contract change; route inline per L1; checks: self-verification, no delegation per L1):
   RED: tests/task-size-routing-contract.test.ts 5/5 failed on missing `## Task Size` / `## Mechanisms`.
   GREEN: 8 prompt-contract files 154/154; unit stage 4619 pass / 0 fail / 44 skipped; provider-contract and runtime-harness pass when run directly (`npm test` stages fail only on `pnpm run` deps check over the symlinked node_modules: ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, environmental); `npm run typecheck` no regressions.
   Sizes: core render 7,704 → 8,035 B (budget 8,192); full always-on prompt 14,586 → 15,049 B (+463 B for the decision kernel). The core now points at the harness test-first policy instead of restating it.
   Decisions: the canon fixture and ratchet canonical anchors stay (they mirror gentle-ai); the ratchet marks writer/mapping as "Gentle Shell leads the canon (gentle-shell#1494)" until G1. Trigger list renumbered 1 Ask, 2 Evidence-budget, 3 Verification, 4 Track, 5 Writer, 6 Incident, 7 Context backstop; step 6 commits apply to tracked tasks only.
   Conflict ahead: gentle-shell#1713 (fix/1713-spec-by-reference) also edits harness steps 5-6; rebase after it merges.
L16 2026-10-03 T0 baseline (product copy of 4.0.0 with gentle-pi replaced by `npm pack` of cf3012f7 at /var/tmp/gentle-shell-bench/product/base-cf3012f7; config bench.1494-base.json; run id base1494): B s1-tasklog accepted at round 0, 315 s, 45 turns, $0.279 (vanilla A from pilot-s1: 56 s, 6 turns, $0.062).
L17 2026-10-03 rebase: gentle-shell#1713 merged (PR #1718, main cd4ba5a7); T1 rebased onto it (conflicts in harness steps 4-6 and orchestrator-delegation.md resolved by re-applying T1 on top of #1713's text) → 3e5c8012; all unit tests 4623/0. Baseline moved to main cd4ba5a7 so before/after differ only by #1494 (product base-cd4ba5a7, config bench.1494-base2.json, run id base1494b). Earlier cf3012f7 runs kept as extra data: s2-ledger 470 s, 58 turns, $0.422; l1-tasklog aborted (SIGINT) when the baseline moved.
L18 2026-10-03 T2 evidence (risk: medium, prompt asset move; inline per L1): user (verbatim): > si  (accepting the module split).
   Split: orchestrator-delegation.md 51,4xx → 19,078 B; new orchestrator-tracking.md 11,989 B, orchestrator-verification.md 4,590 B, orchestrator-writer.md 4,014 B, orchestrator-prompts.md 12,705 B. Small path loads none; each mechanism points at its module from the core. Core render 8,084 B (budget 8,192): dropped the Mental Model section (folded into Task Size) and shortened pointers.
   Test-first exception: a pure text move has no meaningful RED; the 16 test files that read the delegation detail now read the union (tests/support/orchestrator-modules.ts) so every moved clause stays pinned; new AC7 test (budgets, pointers, small path) written with the move.
   Checks: all unit tests 4624 pass / 0 fail; provider-contract pass; runtime-harness pass (union read); verify-package-files pass; typecheck no regressions.
L19 2026-10-03 user (verbatim): > Sigue todos termina
L20 2026-10-03 T3 evidence (risk: HIGH, changes the gentle_review assess input contract, S5 item 3; independent verifier not run because the user forbade delegation (L1), self-verified):
   RED: tests/agent-risk-escalation.test.ts failed to load (no HIGH_RISK_ITEMS export).
   GREEN: agent-risk-escalation 8/8; all unit tests 4632 pass / 0 fail; provider-contract pass; runtime-harness pass; typecheck no regressions.
   Design: lib/review-risk-assessment.ts adds HIGH_RISK_ITEMS, decodeAgentRiskEscalation (item integer 1-6, reason 1-500 chars, no extra keys) and escalatedRisk (passive/medium -> high, never lowers); the assess facade accepts `escalate`, returns `nativeRisk` and `agentEscalation`, and plans verification on the raised tier. The raise is pi-side only until gentle-ai assess accepts it (G2) and the package pin moves; the native review tier is unchanged until then.
   Budget: orchestrator-verification.md budget 5,000 -> 5,500 B for the escalation section (now 5,113 B).
L21 2026-10-03 T4 evidence (risk: medium, prompt text; inline per L1):
   RED: task-size-routing-contract "T4: tracking updates edit in place..." failed on the missing clauses.
   GREEN: all unit tests 4633 pass / 0 fail.
   Spike: gentle-pi cannot mirror to Engram without the model today; memory tools belong to the separate gentle-engram package (engram CLI `save` has no topic-key upsert in its help). The zero-output path available now is a codemode script that reads the file and calls mem_save (used throughout this feature). Automatic mirroring on write belongs in gentle-engram → F3.
L22 2026-10-03 G1/G2 in gentle-ai (outside this repo, authorized by L19): worktree ~/work/gentle-ai-1494, branch fix/1494-task-size-canon stacked on fix/odd-spec-by-reference (the #1713 canon parity, not yet merged). G2 a0f8584c: assess flags raise passive/medium to high with an `agent_escalation` reason; START lens selection still uses the native tier (the raise makes the review due now, it does not change lens count). G1 2d6cea5f: routing.go Task Size + high-risk list + per-mechanism triggers, 12 orchestrator assets, shared sections, hermes skill, usage/trigger-rules docs. Full `go test ./... -timeout 30m`: 79 packages ok; the only failure was the refusal-resolution ratchet on the two new escalation errors, fixed by naming the rerun command (targeted rerun ok).
L23 2026-10-03 T5 partial: baseline (main cd4ba5a7, base1494b) vs after (6f8a78b8, after1494a), arm B gpt-6.1-sol low:
   s1-tasklog base 335 s, 56 turns, $0.339, input 108k + 503k cache, output 7.2k, subagents (verify/worker), odd doc created · after 77 s, 10 turns, $0.105, input 40k + 148k cache, output 1.1k, 0 subagents, 0 odd files, accepted at round 0. Vanilla A: 56 s, 6 turns, $0.062.
   s2-ledger base 479 s, 43 turns, $0.361 · after pending. l1-tasklog base 559 s, 48 turns, $0.403, accepted at round 1 · after pending.
L24 2026-10-03 user (verbatim): > Hacelos
   Created and read back (body match, labels from each form): gentle-ai#5216 (G3), gentle-shell#1722 (F1), engram#1636 (F3). Duplicate search found no equivalent; related: gentle-ai#4815, engram#1449.
L25 2026-10-03 T5 results, arm B gpt-6.1-sol low, one run per cell (n=1), baseline main cd4ba5a7 vs after 6f8a78b8; every after cell accepted at round 0:
   | task | baseline | after | delegation after |
   | s1-tasklog (3-line bug) | 335 s, 56 turns, $0.339, odd doc | 77 s, 10 turns, $0.105, no doc | none |
   | s2-ledger (shared root cause) | 479 s, 43 turns, $0.361, odd doc | 276 s, 27 turns, $0.207, no doc | 1 gentle-ai-explore |
   | l1-tasklog (data migration) | 559 s, 48 turns, $0.403, odd doc, accepted at round 1 | 539 s, 72 turns, $0.555, no doc | 1 gentle-ai-verify |
   Reading: s1 is the #1494 case and now runs fully inline. s2 needed one explore (understanding beyond the batch), as S4 intends. l1 is high risk (S5 item 1: data migration with backup), so it got exactly the independent verifier; it is single-session and resumable from the diff, so by S2/S3 it is not large and creates no doc. It cost more ($0.555 vs $0.403) but passed acceptance without the feedback round the baseline needed.
   AC8 correction: "known-large task still creates the doc and delegates" assumed l1 is large; under the accepted definition it is high-risk, not large. A genuinely large scenario (multi-session or separate deliverables) still has to be authored to check the tracking path.
L26 2026-10-03 user (verbatim): > Vamos con todas
   (accepting F2, the new bench scenarios, and push/PR delivery.)
   Rebase: gentle-pi #1721 (canon parity of #1713) merged; branch rebased onto origin/main 7693fe49 (one conflict in harness steps 4-6, re-applied); all unit tests 4633/0, core 8,084 B.
L27 2026-10-03 F2 evidence (risk: medium; RDD loading only, RDD behavior unchanged):
   RED: review-contract-prompt "skips the review execution contract when RDD is off" failed (contract still appended).
   GREEN: review-contract-prompt 12/12; all unit tests 4636/0; provider-contract pass; runtime-harness pass; typecheck no regressions.
   Rule: the contract is appended only when the primary session's RDD line is not a validated `off`; `unknown` keeps it (fails safe). Re-evaluated on every agent start through the existing 30 s status memo, so enabling RDD restores it on the next turn.
L28 2026-10-03 RDD: the whole branch exceeded the reviewer context budget (`lens_context_budget_exceeded`, 33 files, 1,131 lines); user chose per-part review and granted each slice. All four approved and acknowledged (lens review-reliability, worktree gentle-pi-1494-rv):
   slice 1 T1 7693fe49..fea6c543 review-6d2889a73f541791: R3-T1-checkoff-unproved (W), R3-weak-verify-regex (W), R3-readme-stale-verifier (W), R3-ratchet-parity-lost (S), R3-rule-number-ambiguity (S).
   slice 2 T2 fea6c543..fa9bc41b: R3-writer-dangling-above-ref (W), R3-union-read-loses-placement (W), R3-harness-duplicated-module-list (S), R3-mislabeled-union-assertion (S).
   slice 3 T3+T4+docs fa9bc41b..0da7dfbd: R3-001 agentEscalation present even when the tier did not change (S).
   slice 4 F2 0da7dfbd..08fda673: R3-memo-cleanup-not-finally (S).
L29 2026-10-03 T6 evidence (risk: medium; inline per L1): all eleven follow-ups fixed.
   RED: task-size-routing-contract T6 placement/readme tests and agent-risk-escalation `applied` test failed first.
   GREEN: real dependencies installed in the worktree (`CI=true pnpm install --frozen-lockfile`, replacing the node_modules symlink); `npm test` all stages passed (unit 4650 pass / 0 fail, provider-contract, runtime-harness), which now proves AC9 directly; typecheck no regressions.
   Changes: writer module points at orchestrator-prompts.md; Writer rule named instead of numbered; readme sizes by large/small; `agentEscalation.applied`; per-module placement test; exact Verification-rule regex; ratchet tripwire that fails once the canon gains Task Size (gentle-ai#5217); harness imports DELEGATION_MODULES; Judgment Day shape asserted against orchestrator-writer.md; memo cleanup in finally.
L30 2026-10-03 delivery: user approved gentle-shell#1494 and gentle-ai#5217 (status:approved added, read back); PRs gentle-shell#1723 and gentle-ai#5218 opened with type:bug and size:exception (L14 "pr con size exception"); branches pushed.
L31 2026-10-03 T5 new scenarios (local bench commit 3db290c; base main 7693fe49 vs after 08fda673; arm B gpt-6.1-sol low; n=1):
   | task | baseline | after |
   | x1-inventory (#1494 port, task list requested) | 430 s, 75 turns, $0.394; explore + verify + 3 workers + doc | 124 s, 24 turns, $0.099; inline with todo, 0 subagents, no doc |
   | x2-ledger-import (persisted data, innocent file) | 394 s, 51 turns, $0.410; explore + verify + worker + doc | 149 s, 18 turns, $0.204; exactly one gentle-ai-verify, no doc |
   | x4-ledger-split-deliveries (two deliveries, resumable) | 1144 s, 102 turns, $0.847; explore + 2 verify + 2 workers + doc + 2 commits; round 1 | 1533 s, 134 turns, $1.178; explore + 2 verify + 3 workers + doc + 2 commits; round 1 |
   All accepted (x4 both after one feedback round). x1 and x2 show the intended routing (AC8 small and high-risk paths). x4 takes the large path in both arms as intended (doc, writers, per-delivery commits); the after run cost 39% more with one extra worker, which one run cannot separate from noise. The design-decision scenario (AC-E3) is not measurable with the unattended runner, which cannot answer a question; AC4 covers the re-evaluate rule by contract.
   CI: gentle-shell#1723 failed `check:runtime-modules` (stale runtime/review-risk-assessment.mjs); regenerated in 6bc82417 (assess: medium, under_budget, not due); CI green. gentle-ai#5218 all checks green, including E2E.
   Remaining advisory review notes (not fixed, separate later work): R3-applied-false-branch-unproved (no test for applied=false), R3-harness-ts-import-from-mjs (harness depends on Node type stripping, already required by test:harness).
