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

- Split PRs over **400 changed lines** unless a maintainer explicitly accepts `size:exception`.
- The budget constrains how work is **sliced**, never the code itself. Never delete comments, blank lines, docs, or tests, and never compress or restyle code, to fit under the budget.
- Slicing is bounded: make **one** honest slicing pass. If no cohesive split brings every slice within budget, stop iterating, keep the best cohesive split, and report the final line count with a `size:exception` recommendation.
- Keep each PR reviewable in about **≤60 minutes**.
- Use one deliverable work unit per PR; keep tests/docs with the unit they verify.
- State start, end, prior dependencies, follow-up work, and out-of-scope items in every chained PR.
- Every child PR must include a dependency diagram marking the current PR with `📍`.
- In Feature Branch Chain, create a draft/no-merge tracker PR; child PR #1 targets the tracker branch, later children target the immediate parent branch.
- Treat polluted diffs as base bugs: retarget or rebase until only the current work unit appears.
- Do not mix chain strategies after the user chooses one.
- Before creating branches or PRs, verify the target repository's default branch; use it as the integration base, not an assumed `main`. `stacked-to-main` is the historical strategy token even when the default branch has another name.

## Decision Gates

| Condition | Action |
|---|---|
| PR ≤400 changed lines and focused | Keep single PR. |
| PR >400, each slice can land independently | Use Stacked PRs to the verified default branch. |
| PR >400, feature must integrate before the default branch | Use Feature Branch Chain with tracker. |
| Generated/vendor/migration diff cannot split cleanly | Ask maintainer for `size:exception`. |
| No cohesive split fits the budget after one slicing pass | Stop; deliver the best split, report the overage and why it cannot shrink further, and recommend `size:exception`. |
| ODD `delivery_strategy` is `ask-on-risk` | When the budget is exceeded, ask for a chain strategy before the next work-unit commit. |
| ODD `delivery_strategy` is `auto-chain` | Ask for a chain strategy only when missing; otherwise use the cached choice. |
| ODD `delivery_strategy` is `single-pr` | Require `size:exception` for an over-budget single PR; do not ask for a chain strategy. |
| ODD `delivery_strategy` is `exception-ok` | Record accepted `size:exception` for an over-budget single PR; do not ask for a chain strategy. |

## Execution Steps

1. Estimate changed lines and identify independent work units.
2. Apply the delivery-strategy gate above; ask for a chain strategy only on a chaining path that needs a choice.
3. Verify the target repository's default branch before creating branches/PRs; use the chosen strategy only.
4. Add Chain Context to each PR without replacing the repo PR template.
5. Verify each PR independently: CI/tests/docs/manual checks, rollback scope, and clean diff.
6. Keep tracker PR draft/no-merge until all child PRs are reviewed and integrated.

## Output Contract

Return the chosen strategy, PR order, current PR boundary, dependency diagram, review budget (`additions + deletions`), verification plan, and any `size:exception` rationale.

## References

- [references/chaining-details.md](references/chaining-details.md) — strategy diagrams, PR body section, branch commands, and reviewer guidance.
