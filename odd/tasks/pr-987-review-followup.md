# PR #987 review follow-up

## Objective
Finish the review-requested changes on `feat/provider-aware-model-presets` for PR #987, retaining the already implemented routing fixes and updating the branch against current `main` without publishing it.

## Scope and constraints
- PR head: `5c619353ca284ce70e7465858aef0e31dc0b0259`; current local `main`: `12de3e98cac73d2ef85478a93497ccaacf5426a3`.
- Four maintainer routing requests (sdd-remediate, effort aliases, delimiter validation, CRLF) are already represented in source/tests. Do not redo them without contrary test evidence.
- Correct the inaccurate profile-application timing in `docs/readme-reference.md`.
- Integrate `main`; merge-tree reports one content conflict in `extensions/gentle-ai.ts`. Preserve both intents; check merged routing behavior and tests.
- Contract mirror schema findings came from an unrelated historical change and are not in the current PR diff. No provider-owned schema edits here.
- Do not push, open/merge a PR, or mutate GitHub without a separate decision.

## Acceptance
- Documentation distinguishes immediate materialization from routing consumed by the next subagent launch.
- Branch integrates current `main` without conflict markers or lost routing changes.
- Relevant routing tests, typecheck, and applicable harness checks pass, or exact failures are reported.

## Delivery
Strategy: single existing PR; estimated authored follow-up under 400 lines, excluding integration of upstream history. Branch: `feat/provider-aware-model-presets`. No remote delivery authorized.

## Tasks
- [x] T1 — Correct profile routing timing reference. Route: inline, one mechanical documentation edit. Check: review actual application flow and documentation diff; passive doc edit has no meaningful RED.
- [x] T2 — Integrate current main, resolve extension conflict and verify merged routing. Route: delegated writer for conflict resolution plus delegated command verification; trigger: merge of substantial upstream and non-trivial test/source interaction. Check focused model routing tests, typecheck, runtime harness, conflict-marker scan and diff. Record exact command outcomes and work-unit commit.

## Progress
- Explored PR #987, review comments, current source and merge-tree; branch is clean at original PR head.
- Initial read-only mapping found all four maintainer routing fixes present. Merge-tree predicts one conflict in `extensions/gentle-ai.ts`.
- T1 done: corrected immediate application vs next-launch consumption in `docs/readme-reference.md`; `git diff --check` passed; docs-only change has no meaningful RED, runnable test or runtime harness. Work-unit commit `fe5aad43` (`docs(models): correct profile routing activation timing`). Rollback boundary: the documentation sentence and initial task document; no routing behavior changed.
- T2 merge integration: resolved four conflict regions in `extensions/gentle-ai.ts`, retaining current main's responsive panel and Codex preset. Initial focused run 149 passed/3 failed; fixed merged expectations for panel chrome, retired SDD agent, and reference wording. Focused run then 152/152 passed. Short-terminal overflow and selected-agent navigation tests observed RED before minimal renderCard clipping, then GREEN. Final focused run 154/154 passed; `pnpm run typecheck` passed its baseline (188 recorded diagnostics, no regressions, 10 improved); `pnpm run test:harness` exited 0; `TMPDIR="$(cd "$TMPDIR" && pwd -P)" pnpm test` passed 3,948, skipped 41 (3,989 total), including provider contract and runtime harness. Windows-native and unavailable PATH Pi checks remained skipped. Merge-staged `git diff --cached --check` reports upstream whitespace in `README.md:48`, `odd/tasks/fullscreen-live-header.md:120`, and `tests/gentle-agents.test.ts:4117`; those come from main, not this PR's authored diff. Rollback boundary: merge commit plus routing integration resolution and its tests/docs; remove without changing unrelated main work.

- T2 work-unit merge commit: `3878439c` (`fix(models): integrate preset with current main`), second parent `12de3e98`. Branch diff against main passes `git diff main...HEAD --check` and has 8 paths / 501 authored changed lines, exceeding the 400-line review heuristic by 101; no code-golf applied. Native high-risk review of the committed main-to-branch range approved with four lenses, lineage `review-8ebcb201b64359ae`; acknowledgement burned authority for target `sha256:5a379bd9e9f5bcdb98cfab1010bba99eabe093dde842871d45ee637ae84f9fb5`. Three non-blocking advisory findings (R2-001, R2-002, R3-001) are later follow-ups, not corrections to this candidate. Review does not authorize push or merge.

## Next step
Await the user's decision on pushing the updated fork branch and handling the 501-line review workload (keep the cohesive existing PR or plan a separate review slice). Nothing has been pushed.
