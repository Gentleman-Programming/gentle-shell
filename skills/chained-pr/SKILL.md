---
name: gentle-ai-chained-pr
description: "Trigger: PRs over 400 lines, stacked PRs, review slices. Split oversized changes into chained PRs that protect review focus."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Load this skill when a planned PR may exceed **400 changed lines**, an ODD feature's forecast or running authored changed-line count from work-unit commits exceeds about 400, or the user asks for chained/stacked PRs, review slices, or reviewer-load control. The per-task advisory 400 authored-line heuristic does not itself require a PR split.

## Hard Rules

- Recommend slicing PRs over **400 changed lines**; offer the ordered oversized-delivery menu below and follow the user's selection subject to the destination repository's documented contribution/size policy.
- `size:exception` is a Gentle-owned repository policy, not a universal label requirement. Never request, create, or add this label for generic users unless the destination policy uses it. Preserve that policy's maintainer acceptance gates and protected-label human authorization; selection alone grants neither.
- The budget constrains how work is **sliced**, never the code itself. Never delete comments, blank lines, docs, or tests, and never compress or restyle code, to fit under the budget.
- Slicing is bounded: make **one** honest slicing pass. If no cohesive split brings every slice within budget, stop iterating, keep the best cohesive split, and report the final line count and rationale. Recommend a size exception only when the destination policy provides that route.
- Keep each PR reviewable in about **≤60 minutes**.
- In a chain, use one deliverable work unit per PR; keep tests/docs with the unit they verify. A selected single PR may contain multiple coherent work-unit commits.
- State start, end, prior dependencies, follow-up work, and out-of-scope items in every chained PR.
- Every child PR must include a dependency diagram marking the current PR with `📍`.
- In Feature Branch Chain, create a draft/no-merge tracker PR; child PR #1 targets the tracker branch, later children target the immediate parent branch.
- Treat polluted diffs as base bugs: retarget or rebase until only the current work unit appears.
- Do not mix chain strategies after the user chooses one.
- Before creating branches or PRs, verify the target repository's default branch; use it as the integration base, not an assumed `main`. `stacked-to-main` is the historical strategy token even when the default branch has another name.

## Oversized Delivery Menu

Offer exactly three choices in this semantic order; English examples are illustrative and localizable, not mandatory copy. Generate the complete user-facing question, every option label, description, and recommendation marker in the active user's conversation language (English for an English user, Spanish for a Spanish user, etc.). Machine strategy tokens remain unchanged and untranslated.

1. **Feature/tracker branch chain** — `chain_strategy=feature-branch-chain`; review child slices before final feature integration.
2. **Verified default/main branch chain** — `chain_strategy=stacked-to-main`; land independently reviewable slices in order on the verified default branch, whatever its name.
3. **One single PR — least recommended** — `delivery_strategy=single-pr`; keep the entire change in one PR rather than a chain.

The third choice overrides the pending chaining path: clear the chain choice as inapplicable and suppress later chain prompts. `single-pr` is not a `chain_strategy` token. Do not automatically select `exception-ok` or imply an accepted policy exception.

The least recommended marker applies only to this oversized menu. An oversized single PR increases reviewer cognitive load, slows feedback, and couples rollback of otherwise separable work; a focused single PR within 400 changed lines remains reasonable. Delivery selection does not authorize push, PR creation, merge, or changes to review mode or candidate consent.

## Decision Gates

| Condition | Action |
|---|---|
| PR ≤400 changed lines and focused | Keep single PR. |
| PR >400, each slice can land independently | Recommend Stacked PRs to the verified default branch; respect the selected delivery strategy. |
| PR >400, feature must integrate before the default branch | Recommend Feature Branch Chain with tracker; respect the selected delivery strategy. |
| Generated/vendor/migration diff cannot split cleanly | Report the overage; follow destination policy for any required exception. |
| No cohesive split fits the budget after one slicing pass | Stop slicing; report the best cohesive split and why it cannot shrink further, then apply the selected delivery strategy and destination policy. |
| ODD `delivery_strategy` is `ask-on-risk` | When the budget is exceeded, ask once using the menu above for a chain strategy or single PR before the next work-unit commit. |
| ODD `delivery_strategy` is `auto-chain` | Ask for a chain strategy only when missing; otherwise use the cached choice. |
| ODD `delivery_strategy` is `single-pr` | Follow the destination repository's documented contribution/size policy for the overage; do not ask for a chain strategy. |
| ODD `delivery_strategy` is `exception-ok` | Record the explicitly accepted exception under destination policy, including `size:exception` only where applicable; do not ask for a chain strategy. |

## Execution Steps

1. Estimate changed lines and identify independent work units.
2. Apply the delivery-strategy gate above; offer the menu only on a chaining path that needs a choice. For `auto-chain`, use a cached chain strategy without prompting again; if missing, offer all three choices.
3. Verify the target repository's default branch before creating branches/PRs; use the chosen strategy only.
4. On chaining paths only, add Chain Context to each child PR without replacing the repo PR template.
5. Verify each PR independently: CI/tests/docs/manual checks, rollback scope, and clean diff.
6. For Feature Branch Chain only, keep tracker PR draft/no-merge until all child PRs are reviewed and integrated.

## Output Contract

Return the chosen delivery strategy, review budget (`additions + deletions`), scope, verification plan, and any destination-policy exception rationale. For chaining, also return PR order, current PR boundary, and dependency diagram. For `single-pr`, require no tracker, child dependency diagram, or Chain Context; use the destination PR template without chain-only artifacts.

## References

- [references/chaining-details.md](references/chaining-details.md) — strategy diagrams, PR body section, branch commands, and reviewer guidance.
