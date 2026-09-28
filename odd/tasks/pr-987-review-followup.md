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
- [~] T2 — Integrate current main, resolve extension conflict and verify merged routing. Route: delegated writer for conflict resolution plus delegated command verification; trigger: merge of substantial upstream and non-trivial test/source interaction. Check focused model routing tests, typecheck, runtime harness, conflict-marker scan and diff. Record exact command outcomes and work-unit commit.

## Progress
- Explored PR #987, review comments, current source and merge-tree; branch is clean at original PR head.
- Initial read-only mapping found all four maintainer routing fixes present. Merge-tree predicts one conflict in `extensions/gentle-ai.ts`.
- T1 done: corrected immediate application vs next-launch consumption in `docs/readme-reference.md`; `git diff --check` passed; docs-only change has no meaningful RED, runnable test or runtime harness. Work-unit commit `fe5aad43` (`docs(models): correct profile routing activation timing`). Rollback boundary: the documentation sentence and initial task document; no routing behavior changed.

## Next step
Merge `main`, preserve both sides of the extension conflict, run focused/full applicable checks, and commit the integration work unit.
