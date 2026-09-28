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
Strategy: single PR, exception request pending. Branch: `feat/provider-aware-model-presets`. The prior work was published at `e2ca63c1a8a13fb35e511bd37aeb8553e1a4d8c9`; its diff is 425 additions plus 82 deletions across eight files. The user explicitly chose to retain one PR and prepare (not publish) a `size:exception` request after verification. No maintainer exception is approved. Do not split, rewrite history, commit, push, comment, or apply labels. The follow-up source/tests add 113 and remove 29 lines; the final PR size is recorded in the request draft below.

## Tasks
- [x] T1 — Correct profile routing timing reference. Route: inline, one mechanical documentation edit. Check: review actual application flow and documentation diff; passive doc edit has no meaningful RED.
- [x] T2 — Integrate current main, resolve extension conflict and verify merged routing. Route: delegated writer for conflict resolution plus delegated command verification; trigger: merge of substantial upstream and non-trivial test/source interaction. Check focused model routing tests, typecheck, runtime harness, conflict-marker scan and diff. Record exact command outcomes and work-unit commit.

- [x] T3 — Fix startup routing authority with regression tests: preserve a valid pin's omitted-agent fallback, accept saved `effort` aliases, and validate exactly the parsed snapshot applied during atomic replacement. Route: delegated writer. Retrospective RED/GREEN observed; see methodology limitation below. No extra provider presets. No commit authorized.
- [x] T4 — Independently verify focused routing, pin, harness, typecheck and full suite. Route: delegated verifier; observed results and skips recorded below. No commit authorized.
- [x] T5 — Prepare an English `size:exception` request with measured diff size and rationale, without publishing it. Route: parent synthesis. Actual maintainer approval remains a merge prerequisite; this task only delivers the draft.

## Progress
- Explored PR #987, review comments, current source and merge-tree; branch is clean at original PR head.
- Initial read-only mapping found all four maintainer routing fixes present. Merge-tree predicts one conflict in `extensions/gentle-ai.ts`.
- T1 done: corrected immediate application vs next-launch consumption in `docs/readme-reference.md`; `git diff --check` passed; docs-only change has no meaningful RED, runnable test or runtime harness. Work-unit commit `fe5aad43` (`docs(models): correct profile routing activation timing`). Rollback boundary: the documentation sentence and initial task document; no routing behavior changed.
- T2 merge integration: resolved four conflict regions in `extensions/gentle-ai.ts`, retaining current main's responsive panel and Codex preset. Initial focused run 149 passed/3 failed; fixed merged expectations for panel chrome, retired SDD agent, and reference wording. Focused run then 152/152 passed. Short-terminal overflow and selected-agent navigation tests observed RED before minimal renderCard clipping, then GREEN. Final focused run 154/154 passed; `pnpm run typecheck` passed its baseline (188 recorded diagnostics, no regressions, 10 improved); `pnpm run test:harness` exited 0; `TMPDIR="$(cd "$TMPDIR" && pwd -P)" pnpm test` passed 3,948, skipped 41 (3,989 total), including provider contract and runtime harness. Windows-native and unavailable PATH Pi checks remained skipped. Merge-staged `git diff --cached --check` reports upstream whitespace in `README.md:48`, `odd/tasks/fullscreen-live-header.md:120`, and `tests/gentle-agents.test.ts:4117`; those come from main, not this PR's authored diff. Rollback boundary: merge commit plus routing integration resolution and its tests/docs; remove without changing unrelated main work.

- T2 work-unit merge commit: `3878439c` (`fix(models): integrate preset with current main`), second parent `12de3e98`. Branch diff against main passes `git diff main...HEAD --check` and has 8 paths / 501 authored changed lines, exceeding the 400-line review heuristic by 101; no code-golf applied. Native high-risk review of the committed main-to-branch range approved with four lenses, lineage `review-8ebcb201b64359ae`; acknowledgement burned authority for target `sha256:5a379bd9e9f5bcdb98cfab1010bba99eabe093dde842871d45ee637ae84f9fb5`. Three non-blocking advisory findings (R2-001, R2-002, R3-001) are later follow-ups, not corrections to this candidate. Review does not authorize push or merge.

### Current follow-up
- Reconciled the earlier record against live PR metadata and the local head: prior changes have been pushed; the old next-step text was stale.
- Safely switched the clean worktree from `fix/1484-windows-staging-paths` to the exact PR head. Initial mapper could only inspect the former branch; those observations were not treated as proof of the reported bugs. Target-branch remapping confirmed all three paths.
- T3 complete: valid repository pins bypass automatic global replay; stale/invalid/missing pins still reconcile globally. Opt-in strict parsing accepts `effort`, keeps `thinking` precedence, and validates the same parsed value it returns; ordinary lenient readers retain their contract. Tests cover empty/omitted/conflicting globals, resolved definition model/effort and pinned worker routing, saved aliases, and atomic replacement in both validity directions.
- Methodology limitation: implementation preceded tests, so this was not test-first. Parent rejected the first race fixture (`worker: null` versus valid worker) because the old validator would already reject the differing key counts. Corrected same-key fixture uses invalid A with an unsupported field and valid B; exact original-HEAD startup/validator plus only the replacement hook produced 2 expected failures. Restoring final code produced 2 passes. Writer then passed 120 routing/pin and 63 package/runtime tests, harness, typecheck and diff check.
- T4 independent verification: 183 focused tests passed with zero failures/skips; runtime harness and provider contract passed; typecheck passed its baseline with 188 recorded diagnostics, no regressions and 10 improved file/code pairs; `git diff --check` clean. Canonical-TMPDIR full suite: 3,949 passed, 0 failed, 41 skipped. Skips include unavailable PATH Pi 0.87.1 bundle checks and Windows-native checks. No unexpected repository mutations. Pin regression resolves production profiles without launching an actual child; replacement uses a deterministic hook and real atomic rename, not scheduler timing.
- Parent acknowledged native review `review-ff6848be57d3fad3` for task-document-only target `sha256:0033578e8674730c9fd90d646c4e05b7737b9b4da33262d6a276247e08b02076`.
- A later explicit review reminder interrupted implementation. Parent paused the writer and completed four-lens review `review-9bf03280c6a37617`, acknowledged for intermediate target `sha256:972b55a63c3a2513808e571254025957b0521be9e747aac6d616aea92f1a96bb`. Four non-blocking advisories were returned. This does not prove the final regressions or later changes complete. Writer resumed under task `mulnbzzs-5-egvv`.

## Size exception request draft (not published)
Would you approve an explicit `size:exception` for this PR after the routing fixes? The updated local candidate is 615 changed lines (529 additions, 86 deletions), including 325 test/harness lines and this 51-line task record. It preserves pinned omitted-agent routing, accepts legacy saved `effort`, and validates the exact snapshot applied; focused and full-suite checks pass. I am requesting one review unit because the preset exercises the same complete-snapshot reconciliation contract and keeping its regression coverage together avoids intermediate routing semantics. A foundation/preset split is possible; this request is not a claim that it cannot be split. No additional provider presets are included. If an exception is not acceptable, this PR should remain unmerged until it is split.

## Next step
Finish the controller-owned native review of the complete candidate; its result is recorded separately from this task file. Await explicit authorization to publish the fixes/request and maintainer approval of `size:exception` before merge. No follow-up commits, push, comments, labels, or history rewrites have been performed.
