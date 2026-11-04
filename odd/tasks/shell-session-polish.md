# Shell session polish
Objective: deliver the reported shell fixes and effective-agent-profile display without losing local work.
Branches: fix/shell-reload-lifecycle, then fix/shell-panel-agent-profile; delivery: auto-chain / stacked-to-main; runner: Node test runner, check-types and runtime-module checks.

## Specs
- S1: "cosas a arreglar [Image#1] podemos dar un poco de padding entre el header y el sidebar? se pega mucho el todos, y en mobile el panel no ocupa hasta el input o donde dice actualizar el checkout a mian y comprobar el resultado, lo que molesta un poco [Image#2]"
- S2: "ok, una cosa qwue vi, es qeu no mantiene lo elegido el customize de layout para el modo light vs normal vs power user, solo dura lo de la sesion"
- S3: "dale y una cosa, mejor el espaciado entre TODOS y el header pero le metiste como un margin no un padding, el background no se extiende hasta el header, queda un espacio"
- S4: "ah una cosa mas antes del pr y merge, agregar en la parte del sidebar de integrations que perfil se esta usando"; correction: "no no, decia el perfil de agentes"
- S5: "Permissions: NORMAL\npi exiting due to uncaughtException:\nError: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload()."; trigger: "al hacer /reload"
- S6: "rebase con main, pr y merge"; "mete todo lo de main en local ya please"; "pr y merge cuando termines". The human explicitly selected "Sí, usar la sesión de gh configurada" for github.com/Gentleman-Programming/gentle-shell.

## Tasks
- T1 [S1,S3] delegated (runtime context backstop): implemented; renderer checks pass; live mobile-boundary/PNG proof unavailable; commit pending, slice 2.
- T2 [S2] delegated (runtime context backstop): blocked on actual runtime facts; isolated restart/session-switch tests pass but reported loss was not reproduced; regression tests committed as 588658564 for slice 2; no production persistence fix claimed.
- T3 [S4] delegated (runtime context backstop), parent seam correction inline: verified; 143 focused tests pass; joint run 452/454 plus corrected two-test recheck 2/2; commit pending, slice 2.
- T4 [S5] delegated (runtime context backstop): verified; meaningful RED to 311/311 real-worktree GREEN, types/runtime pass, independent bounded PASS; Risk item 4; commit 547d3e31c, slice 1.
- T5 [S6] inline parent Git ownership: local main updated 2d8ced2ad to 6865058f6, codemode 33/33, all ten WIP hashes preserved; slice 1 committed as 547d3e31c (231 authored lines), PR #2837 opened; exact-head CI pending.
- T6 [S6] inline parent Git ownership: slice 2 local preparation in progress on fix/shell-panel-agent-profile; preset-test commit 588658564, panel/profile commit next; publish/rebase after slice 1 merges. Keep unknown odd/work and ignored local-plugin tests untouched.

## Log
- L1 Original request: "cosas a arreglar [Image#1] podemos dar un poco de padding entre el header y el sidebar? se pega mucho el todos, y en mobile el panel no ocupa hasta el input o donde dice actualizar el checkout a mian y comprobar el resultado, lo que molesta un poco [Image#2]"
- L2 User correction: "dale y una cosa, mejor el espaciado entre TODOS y el header pero le metiste como un margin no un padding, el background no se extiende hasta el header, queda un espacio". The top row now shares the first panel surface; no transcript shift.
- L3 User clarification: "no no, decia el perfil de agentes". Reuse ShellBarModel.profile and existing refresh; preserve header, routing and integration-count semantics.
- L4 Reload stack: extensions/gentle-shell.ts:2589:103 -> lib/shell-page.ts:95 host.doRender -> scheduled Timeout. Shutdown now disposes session-owned footer resources; wrappers have liveness and ownership guards. SDK awaits shutdown before context invalidation.
- L5 Persistence evidence: canonical layout presets are light/neutral/power-user. Existing atomic persistence survived session switches and a fresh extension instance with the same isolated config home. Actual process/launch/config-home facts remain needed; no speculative production change.
- L6 Independent reload verifier: baseline 305/311, candidate 308/311; retained-callback probe baseline 305/312, candidate 309/312. Same three archive-only review tests require a Git worktree. Types/runtime exit 0; real-worktree parent 311/311. No live parent reload was run.
- L7 Parent joint check: 454 tests, 452 passed and two obsolete no-profile assertions failed. A scoped correction verifies profile/digest changes and polling in Integrations; targeted recheck 2/2, exit 0. Do not report a wholly green rerun of that original joint command.
- L8 Existing full-suite run exited 1; provider-contract and runtime-harness passed. Ignored local-sidebar-plugin tests fail at baseline and are not tracked. Other config/socket failures are not claimed resolved. No broad local retry or dependency installation.
- L9 Delivery decision: two independently reviewable slices under approximately 400 authored lines each, no size exception or protected-label mutation. Slice 1 contains only reload behavior/tests plus this recovery document; slice 2 contains panel/profile changes and preset-restoration tests. Related approved issues #995 and #1064 use nonclosing references.
- L10 Preservation: .git/gentle-main-update-lwhwt988 contains the validated pre-update WIP patch/manifests. No reset/stash was needed; unknown odd/work and dependency provenance remain untouched. RDD is off; native assessment was unavailable, no review lifecycle was run.
- L11 Slice 1: commit 547d3e31c26c8e0963d148c91dfaf754d404e26d isolates exactly three reload-test hunks from tests/gentle-shell.test.ts; preset and profile expectations remain for slice 2. Staged whitespace check passed, 231 authored lines. Explicit HTTPS push uses the authorized gh credential helper, never ambient SSH; related approved #995 is referenced without closing it.
- L12 PR #2837 opened successfully at https://github.com/Gentleman-Programming/gentle-shell/pull/2837 with type:bug. Wait for all target CI workflows on head 547d3e31c before merging; CodeRabbit is optional unless branch policy requires it. Prepare slice 2 locally without publishing a polluted diff.
- L13 Slice 2 preset coverage is isolated in 588658564 (92 authored lines). This is a test-only evidence unit, not a claim to fix the unreplicated persistence report. First PR CI run 41821918814 is being watched with --exit-status; Windows Hidden Internal Processes already succeeded on the same head.
