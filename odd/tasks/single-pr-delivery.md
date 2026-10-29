# Single-PR delivery choice

## Objective, problem and why
Add the omitted `single-pr` delivery outcome as the third, least-recommended option in the oversized menu, after feature/tracker-branch chaining and default-branch chaining. Define semantics rather than mandatory UI wording.

## Authorized scope
- Worktree: `/Users/alanbuscaglia/work/gentle-pi-worktrees/single-pr-delivery`.
- Branch: `feat/single-pr-delivery`; base: `290c0dc1352d65ed134bcf07187e81be955645a7` (local main).
- Local implementation, tests, docs and work-unit checking; unrelated dirty original-worktree source edits remain untouched.
- No remote access, push, PR creation or merge.

## Edit surfaces
- `assets/orchestrator-delegation.md`
- `skills/chained-pr/SKILL.md`
- `skills/chained-pr/references/chaining-details.md`
- `skills/work-unit-commits/SKILL.md`
- `skills/branch-pr/SKILL.md`
- `docs/readme-reference.md`
- `tests/chained-pr-skill.test.ts`
- `tests/branch-pr-skill.test.ts`
- `tests/odd-routing-contract.test.ts`
- Parent alone maintains this feature document.

## Acceptance criteria and constraints
- Semantic order: feature/tracker chain (`feature-branch-chain`), verified default/main chain (`stacked-to-main`), single PR (`delivery_strategy=single-pr`, least recommended for oversized changes only).
- Complete user-facing question, labels, descriptions and recommendation marker follow the active user's conversation language. Tokens remain untranslated; English documentation examples are illustrative/localizable, not fixed UI copy.
- Single PR overrides the pending chain path, makes the chain choice inapplicable, suppresses reprompts and needs no tracker, child dependency diagram or Chain Context; it does not auto-select `exception-ok`.
- `size:exception` is not universal. Never require or add the label for generic users unless the actual destination policy uses it. Preserve real destination-policy acceptance and protected-label authorization gates.
- Preserve focused <=400-line single PRs, cached chains, verified default branch and tracker-first child base. Shape selection does not authorize publishing, merge or review-mode/consent changes.
- Adjacent skill corrections are limited to directly contradictory delivery rules. No SDK/UI redesign, SDD state, canonical-fixture edits, upstream mirrors or unrelated policy cleanup.
- About 400 authored lines is advisory, not a reason to compress code or omit tests/docs.

## Delivery and task
- Strategy: `ask-on-risk`; forecast 150-250 authored lines excluding tracking. Actual behavior work unit: 212 lines (177 additions + 35 deletions), nine files; one local work-unit commit, no PR planned.
- [x] **T1 — Add and verify the third delivery choice** (completed).
  - Route: delegated direct; nine non-trivial instruction/doc/test surfaces triggered writer/preparation delegation. Read-only mapping and independent verification were delegated separately.
  - Work-unit commit: `bcf2ce4f9dd16dfbcf88d9a7c54b56f78007dd93` — `feat(delivery): offer localized single-PR fallback`.
  - Initial RED before instruction edits: skill 7/13 and routing/ratchet 19/21. Initial GREEN: 13/13 and 21/21.
  - Independent checks exposed an inherited critical SDD rule forcing chains despite explicit single-PR selection. One accepted scoped correction qualified that row and added regression/negative mutations.
  - Correction RED: one new regression failed, 13 existing skill tests passed. Final GREEN: 14/14 skill tests and 21/21 routing/ratchet tests; both negative mutations rejected.
  - Fresh final read-only verifier repeated all 35 tests and whitespace checks; functional PASS, residual conflict resolved, candidate bytes unchanged.

## Native review and assessment evidence
- RDD remained on, decided by global. Initial workspace ASSESS was unavailable because the untracked tracking document required declaration; the high-risk fallback independent-verifier plan was fully satisfied.
- INSPECT explicitly excluded this tracking-only untracked document. Native START classified the behavior candidate medium and selected `review-reliability`.
- Initial 197-line candidate: `review-54b929d0ad0a7906`, approved and exactly acknowledged. Its approval was not reused after correction.
- Final 212-line candidate: `review-1ff8eeba14b078a6`, target `sha256:320fd2574ee747352ee8de38b32c7ad57c8f7a1b0c2f0886be52c86e33127137`, candidate tree `4ef4af97c7a45a9cce213d18e4eba539ed8bccca`.
- First final capture failed with WebSocket transport error and no mutation. Fresh STATUS reoffered the bound slot; one bounded reattempt approved it.
- Exact final acknowledgement returned `native-approved-acknowledgement-completed`, authority burned, consumed revision `sha256:35a9317deceeecb92cec7c5637c4a16f4669f1b0f81b056fb7e016d89651a756`. No later STATUS on that lineage.
- Later workspace/committed-range ASSESS still could not resolve the untracked declaration; no risk/closure assessment was fabricated. Existing writer and independent proof cover the conservative fallback, and actual native acknowledgement separately records review closure.
- Source work-unit commit occurred after acknowledgement without normalization or byte changes; no active commit hooks were present.

## Checks and limitations
- `node --experimental-strip-types --test tests/chained-pr-skill.test.ts tests/branch-pr-skill.test.ts`: writer and final independent verifier PASS, 14/14.
- `node --experimental-strip-types --test tests/odd-routing-contract.test.ts tests/odd-routing-canonical-ratchet.test.ts`: writer and final independent verifier PASS, 21/21.
- `git diff --check`: writer and independent verifier PASS.
- Full `pnpm test` not run: focused instruction/contract suite is proportional; no executable runtime implementation changed.
- Browser/SDK verification inapplicable. Static tests prove instruction contracts, not autonomous model adherence or actual generated localized UI.
- Node v24.14.1 and pnpm 11.1.1 observed; ignored linked-worktree `node_modules` reuses installed local dependencies without fetching packages.
- Task file and full Engram mirror synchronized; implementation source and verification are complete.

## Next step
Local work is ready for human inspection. Push, PR creation and merge remain unrequested and unperformed; follow the destination's actual policy if delivery is later authorized.
