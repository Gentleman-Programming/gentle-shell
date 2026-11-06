# Explicit recovery after bounded worker failures
Fix issue #2699 and its implementation-continuation comment on branch `fix/2699-explicit-recovery`; baseline `895f353cab0bbe32d409f21bb505fc238a40330a`.
Delivery: one focused PR, forecast 200–350 authored lines; runner: Node strip-types tests. Risk: item 3 (delivered orchestrator instruction contract).

## Specs
- S1: User request: "revisa y arregla y crea pr https://github.com/Gentleman-Programming/gentle-shell/issues/2699#issuecomment-6664096410"
- S2: Issue: "Distinguish a transient preparation failure from an unavailable verification capability, denied action, terminal review result, or exhausted explicitly bounded correction budget."
- S3: Issue: "Keep the continuation bounded: one explicit request must not authorize automatic retry loops or reset unrelated budgets. Establish scratch requirements/capacity rather than blindly repeating an oversized copy."
- S4: Comment: "distinguish worker-local execution/correction limits, native review budgets, unavailable proof, and ordinary recoverable compilation/implementation failures."
- S5: Comment: "The user is not asking to waive tests, fabricate approval, bypass permissions, or perform destructive operations. They want to finish the feature and obtain the required proof, with an explicit supported way to adjust or recover from implementation attempt limits."

- S6: User corrections: "no delgues"; "continua lee de nuevo por las dudas y analiza posibilidades antes y luego ataca pr y merge, te permito aprobar y cerrar el issue"; "y pide a la gente que vuelva a probar al cerrar".

## Tasks
- T1 [S1–S5] delegated + inline documentation — done — RED 7 new failures/26 passes, GREEN 39/39; provider-contract pass; frozen install corrected environment and typecheck passed 0 diagnostics. Commit pending T2.
- T2 [S1–S5] inline coordination + independent verifier — done — blocker-limited independent recheck143/143 passed; final isolated full suite, types0, runtime modules and package contents all exit0 (job-6). RDD off/global; native review disabled/unmanaged.
- T3 [S1,S6] inline — in_progress — issue approved; commit/push focused slice, open PR, check CI, merge, close issue and ask reporters to retest; explicit user authorization received.

## Log
- L10 Final independent recheck mw4a7j67-6-soat resolved all four blockers,143/143 tests, provider/types/diff0. Parent isolated job-6 full suite passed all stages, typecheck0, runtime16 modules match, package243 files verified. Earlier failed runs retained as evidence, not waived. Module7886/7900B. Delivery slice under400 authored lines.
- L9 User selected "1": approved exact correction surfaces including assets/migrations/agent-body-history.json and isolated system-temp HOME/npm/config environment. Correction task mw4a05gm-5-899a resumes same unspent batch. Original full suite failed with four candidate integration blockers plus environment failures; baseline pnpm aborted before tests, direct baseline unit run failed too (not proof all candidate failures preexist). Independent verifier S2-S5 met, 39 focused +8 probes +36 delivery differential comparisons passed; confirmed four known blockers only. RDD now off (global); no native review started.
- L8 Writer mw49jt9z-2-fmg8 delivered policy/tests; parent added user recovery documentation. Initial typecheck failed24 diagnostics with absent local dependencies; frozen-lockfile install and check-types exited0 with zero diagnostics. No baseline or guard weakened. Issue status:approved applied by explicit authorization. No PR exists yet.
- L7 User authorized the proposed two bounded delegations: "si tu dale, hay pr creo que no no ?". GitHub confirms no PR exists for this branch.
- L1 Original request: "revisa y arregla y crea pr https://github.com/Gentleman-Programming/gentle-shell/issues/2699#issuecomment-6664096410"
- L2 Read issue/comment from GitHub; issue open without labels. Root checkout has unrelated edits; isolated registered worktree `.worktrees/issue-2699` starts at fresh main baseline.
- L4 User: "no delgues"
- L5 User: "continua lee de nuevo por las dudas y analiza posibilidades antes y luego ataca pr y merge, te permito aprobar y cerrar el issue"
- L6 User: "y pide a la gente que vuelva a probar al cerrar"
- L3 Explorer mw49ec4q-1-ziyf mapped categorical continuity wording against narrower setup rule and worker-local partial limits. Locked upstream provider bundle must remain byte-identical. Policy tests prove instruction delivery, not LLM compliance.
