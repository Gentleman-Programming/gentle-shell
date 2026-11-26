# PR 3264 on gentle-shell v5

Local preparation only, on `update/pr-3264-v5` from `origin/main` `d397fab57fb57a033099564f1e0357eefb861271`. No push, no PR update, no merge.

## Specs

S1: "gentle shell ya va en la v5 y necesito que valides si los pr que hemos publicado siguen vigentes en este stack o si requieren alguna actualizacion"
S2: "dale"

## Tasks

T1 (S1-S2, parent): create this spec, its Engram mirror and the visible todo before any source write. commit: n/a (tracking)
T2 (S1-S2, writer): reapply PR #3264 version-skew behavior on v5 main, with RED/GREEN/PRESERVE tests and any required docs. commit: a7e7be07061dbcc27c71fbba08ffaf08b7927147
T3 (S1-S2, parent): run gates, spot-check one reported command, record commit evidence and report. commit: pending

## Log

L1: "gentle shell ya va en la v5 y necesito que valides si los pr que hemos publicado siguen vigentes en este stack o si requieren alguna actualizacion"
L2: "dale"
L3: Owner chose scope "Solo #3117 y #3264" (ask_user_choice, 2026-11-26). Validation via GitHub API: main HEAD `d397fab57fb57a033099564f1e0357eefb861271`, package version 5.0.0; PR #3264 head `37f1561249e937929b7e04822f6559d0c90a2732`, open, `mergeable=false`, `mergeable_state=dirty`, 4 commits ahead / 234 behind, 5 files +243/-9; PR #3117 remains `mergeable=true`/`unstable` and needs CI approval only.
L4: Verified absence on main of `declaredPackageSkewMessage` and `declaredNpmVersion`; verified presence of `describeVersionJson` in `bin/gentle-shell.mjs:2313-2316`, `lib/gentle-shell-launcher.ts` and `runtime/gentle-shell-launcher.mjs`. The PR's version-report hunks collide with the new `--version --json` branch, so a mechanical rebase is insufficient.
L5: Both PRs had CodeRabbit `success` and two GitHub Actions suites `action_required` on 2026-11-26 (fork workflow approval pending). Local checkout before this task was 4.7.0; v5 gates require dependencies installed from the v5 lockfile.
L6: Risk: item 3 — `--version` output is a consumed CLI surface; the fourth line and JSON path must stay consistent and must not break existing three-line assertions outside the new behavior.
L7: T2 delivered locally in commit `a7e7be07061dbcc27c71fbba08ffaf08b7927147` on `update/pr-3264-v5` (no push, no PR/remote change). Parent spot checks: focused launcher suite 241 tests / 240 pass / 1 skip / exit 0; focused bin risk suite 6/6 pass / exit 0; `node scripts/check-types.mjs` 0 diagnostics / exit 0; `node scripts/build-runtime-modules.mjs --check` 26 generated modules match / exit 0; `git diff --check` clean before commit. Full `tests/gentle-shell-bin.test.ts` exits 1 on this Windows host (119 `EFTYPE` fake-pi.mjs lines; no skew/declared-version assertion among the failures) — pre-existing baseline limitation, not a new regression claim.
L8: Independent `gentle-ai-verify` launch was refused admission because the Risk line was not in the launch text; per the refusal, the parent ran the focused risk test and full suites inline. RDD assess escalated item 3; native assess initially failed on untracked ODD spec and on nested-repo root, then the spec was committed and the committed range reassessed.
L9: RDD ordinary native review closed on lineage `review-3354a9f79ade84a6` (target `sha256:2917470c36627cec81916f65654b421a29f4ef7c93cc260904b463ff63f0a157`, consumed revision `sha256:4a38ee9215a86dd43e3444898398eed9d8d07fc9042aa1a1f71b14a89878fb4c`, lenses risk/readability/reliability, authority burned, `mutation_outcome: committed`). Delivery remains ordinary repository policy: no push, PR update or merge.
L10: The repo pre-commit shape gate rejected both commits on 14 pre-existing skill-frontmatter mismatches outside this change; both commits used the documented `HARNESS_CHECK=off` escape and announced that the shape gate did not run. First commit `a7e7be07061dbcc27c71fbba08ffaf08b7927147`, evidence commit `a21957415bde124ff26328f571e870e013e8611f`.
