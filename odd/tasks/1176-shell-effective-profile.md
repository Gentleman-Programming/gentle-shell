# Shell effective profile (#1176)

## Objective

Show the repository-effective subagent profile in the fullscreen shell header and Status → Project → Profile: global name alone, or the winning pin name with `(local)` / `(repo)` as specified in #1176. The implementation plan is `work-items/active/fix/1176-shell-effective-profile/index.md` (locally ignored).

## Scope and constraints

- Work only on branch `fix/1176-shell-effective-profile` in the current worktree; do not create a worktree.
- Evolve `createActiveProfileReader()` instead of adding a parallel reader; preserve its unsessioned global behavior and atomic-replacement detection. Reuse `resolveProfilePin()` for local/repo precedence, off the per-frame render path. Refresh bound-session cached display at session start and with bounded latency for internal/external edits; dispose cleanly on session replacement/shutdown.
- Preserve project code and documentation style. Do not run Prettier or markdownlint on implementation artifacts, per user instruction.
- The fix (implementation + regression tests + product docs) must remain at or below 400 changed lines, additions plus deletions. Do not sacrifice tests/readability to hit the cap; stop and report if a cohesive solution cannot fit.
- No changes to routing, the profiles panel, orchestrator selection, or compact bar. Do not commit or push the maintainer-requested follow-up until the user reviews its diff and authorizes delivery.
- Authorized expected code surfaces: `extensions/gentle-shell.ts`, `tests/gentle-shell.test.ts`, `docs/readme-reference.md`; reopen scope before touching others.

## TDD and verification

- ODD TDD mode: unknown; `openspec/config.yaml:strict_tdd` is SDD-specific, not proof of ODD mode. Use ordinary behavior-focused tests, recording failures before fixes when feasible; do not claim strict RED/GREEN without observations.
- Focused runner: `node --experimental-strip-types --test tests/gentle-shell.test.ts tests/profile-pin.test.ts`.
- Closure checks: `pnpm run typecheck` and `pnpm test`; no Prettier or markdownlint on fix artifacts.
- Review switch: on (global), read via `gentle-ai review mode status`; use the native candidate lifecycle at the work-unit commit boundary.
- Forecast: 330 changed lines plus 70 contingency, maximum 400 for the fix. Delivery strategy: ask-on-risk; one feature-branch work-unit commit; no PR automatically.

## Task

- [x] P1176-1 — Extend the existing profile reader to resolve the effective profile off-render, keep session lifecycle refresh bounded, cover global/local/repo precedence, transitions, replacement, disposal, and frame cost with regression tests, update product documentation, run focused/full/type checks, and record the work-unit commit.
  - Route: delegated `gentle-ai-worker` (3 non-trivial files to change; multi-file write trigger).
  - Acceptance at initial implementation: both fullscreen surfaces show `name`, `name (Local)`, or `name (Repo)` as appropriate; same-name source transitions redraw; invalid/stale pin layers fall through; no filesystem/Git in repeated digest/render; external edits appear after bounded refresh; no leaked refresh across sessions; compact bar and routing unchanged.
  - Evidence: worker focused tests 126 passed; `pnpm run typecheck` passed with 195 baseline diagnostics and no regression; `pnpm test` passed (3,362 passed, 38 skipped). Independent verifier reran focused tests: 126 passed, 0 failed; `git diff --check` passed. Parent spot check `git diff --check` passed. Implementation diff: 187 additions + 20 deletions = 207 changed lines (before task document), below 400. Commit: `b5e07511abf20846875d3e58493aa9db25dc3ceb` (`fix(shell): show repository-effective agent profile`). Assessment/review: committed candidate risk high (`process_boundary`); initial untracked assessment was unavailable, so an independent verifier ran; native review lineage `review-907c17f25f78e424` closed approved and exact acknowledgement burned authority (`gentle-ai.review-acknowledged/v1`).

- [x] P1176-2 — Integrate current upstream `main` into the existing feature branch, resolve the `session_start` overlap without losing profile polling or main visual settings, rerun focused tests/typecheck/full suite, and record the merge result.
  - Route: parent performs authorized Git merge; delegate nontrivial conflict resolution and verification. No new worktree, no formatters, no push or PR.
  - Acceptance: no conflict markers; both UI features run; current branch is based on upstream main; checks pass; new candidate review handled under the enabled switch.
  - Evidence: only `extensions/gentle-shell.ts:session_start` conflicted; retained main visual settings and feature profile poll. Independent verifier: focused tests 222 passed; `pnpm run typecheck` passed (188 baseline diagnostics, 10 improvements); `pnpm test` passed (3,436 passed, 41 skipped), provider contract and harness passed. `git diff --check` and staged check passed; no unresolved paths. Pi 0.87.1 bundle and Windows-native skipped coverage remain unverified. Merge commit: `5d88e3305f1a62d9b0fbb535eb36a7ab04e4a403` (parents `4f0178f0`, `8035114a`). Final PR diff against main: 251 changed lines. Native review `review-f1ee3b2266438def` approved and acknowledged.

- [x] P1176-3 — Align the visible source suffixes with the maintainer's note on PR #1423 and issue #1176: `(local)` / `(repo)`. Update focused assertions first, then the reader and product documentation, preserving source precedence, polling, and render-path isolation. Verify the focused tests, typecheck, full suite, and final diff. The user inspected and approved the local commit; push remains a separate decision.
  - Route: delegated `gentle-ai-worker` (multiple non-trivial edit surfaces). TDD mode remains unknown; observe an initial failing focused assertion where feasible, without claiming strict TDD.
  - Allowed edit surfaces: `extensions/gentle-shell.ts`, `tests/gentle-shell.test.ts`, `docs/readme-reference.md`, and this task record. No formatter or markdownlint.
  - Evidence: RED observed (`other (Repo)` vs expected `other (repo)`); GREEN focused tests 222/222; `pnpm run typecheck` passed with 188 recorded baseline diagnostics and no regressions; `pnpm test` passed with 3,436 passed and 41 skipped, provider-contract and runtime-harness passed; `git diff --check` passed. Final PR diff: 236 additions + 20 deletions = 256 changed lines, below 400. Pi 0.87.1 installed-bundle and Windows-native paths remain unverified. The user approved the diff for a local commit; no push or PR update was authorized. Native review `review-06ed17044b48f673` approved and acknowledged the reviewed working-tree candidate.

- [ ] P1176-4 — Integrate local `main` at `32c1978a` into the existing PR branch without committing or pushing until the user reviews the result. Resolve the sole `session_shutdown` conflict by retaining profile-poll cleanup and both ODD-phase cleanup calls; verify the merge index, focused shell/profile tests, typecheck, and full suite. Keep upstream-only content intact and report inherited warnings separately.
  - Route: parent owns `git merge --no-commit`; single-file conflict resolution is bounded; command-running checks route to `gentle-ai-verify`.
  - Allowed edit surfaces: `extensions/gentle-shell.ts` for the conflict, plus this task record. No formatter, markdownlint, or new worktree.
  - Acceptance: cleanly resolved index with both behaviors retained, checks reported with actual outcomes; no commit or push without a separate delivery decision.
  - Evidence (pending delivery): merge held by `MERGE_HEAD=32c1978a`, with no unresolved entries. `extensions/gentle-shell.ts:session_shutdown` keeps all three cleanup calls. Staged tree differs from `main` only in the four feature files, including this task record. Focused tests: 231/231 passed; `pnpm run typecheck`: passed with 188 baseline diagnostics and no regressions; `pnpm test`: 3,526 passed, 41 skipped, zero failed, including provider contract and runtime harness. `git diff --cached --check` exits 2 on the upstream-only blank EOF in `tests/gentle-agents.test.ts:4084`; its staged blob is identical to `main` (667b08e2), and no formatter or unrelated edit was applied. Commit and push not authorized.

## Progress

- 2026-09-25: implementation authorized on existing branch, no new worktree; task record created before source writes. Engram mirror pending: mem_save returned `session has already ended`; local file remains authoritative until resynchronized.
- 2026-09-25: reader, polling, regression tests and docs implemented. Polling regression triggers captured 2-second callback deterministically; wall-clock timing not measured. Verifier noted cached Git identity would not reflect a repository change mid-session; the defined scope is the worktree identity bound at session start, refreshed on session replacement. No tests failing; no formatter or markdownlint run.
- 2026-09-25: user authorized local commit; `b5e07511` created with four files and 245 changed lines. Native candidate review was approved and acknowledged. This evidence-only task record update is not part of the approved commit.

## Next step

After the authorized local commit, await a separate user decision before pushing it to PR #1423. A maintainer must still apply `type:bug`.
