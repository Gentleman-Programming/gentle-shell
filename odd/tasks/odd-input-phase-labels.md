# ODD input phase labels

## Objective
Replace the generic `working…` label in the Gentle input with an honest, concise indication of the current ODD phase (e.g. `exploring…`, `researching…`) while retaining the existing animation and non-working states.

## Problem and evidence
The current prompt renders `working…` from `lib/shell-prompt.ts` while `agent_start`/`agent_settled` only toggle a binary working state. ODD phases exist in orchestrator instructions, not in a Pi runtime event. Inferring phases from arbitrary tool calls or assistant prose would misrepresent the orchestrator's intent.

## Authorized scope and constraints
New isolated worktree `feat/odd-input-phase-labels` from local `origin/main` at 80375c6c. Changes are limited to the Gentle input UI, an explicit narrowly validated phase signal and orchestrator instructions, focused tests and relevant docs. No source changes to the user's dirty primary worktree. Preserve idle/queued labels, animation modes, width constraints, session cleanup and safe fallback to `working…` when no current phase is known. Do not imply the phase is deterministically available: explicit orchestration reporting is best-effort. No remote operations. Technical artifacts in English.

## TDD and delivery
Default-applicable TDD: write failing focused tests first where a runner applies; runner `node --experimental-strip-types --test tests/shell-prompt.test.ts tests/gentle-shell.test.ts` and other focused tests as appropriate. Verify with `pnpm test`, `pnpm typecheck`, `git diff --check`. RDD is on (global); review the work-unit commit under native assessment if due. Delivery strategy `ask-on-risk`, original forecast ~250–400 authored changed lines, generated files excluded. Running source/test count is 589 authored diff lines. User explicitly authorized a local commit with a single-change size exception; no PR, push or merge authorized. Branch point 80375c6c.

## Tasks
- [x] OIP-1 — Establish a bounded, session-scoped explicit ODD phase signal and instruct the orchestrator to set/reset it at meaningful transitions; cover phase validity and lifecycle with tests.
- [x] OIP-2 — Render phase-specific working labels in the Gentle prompt without changing idle/queued behavior, scanner or animation modes; test narrow layouts, transitions, and fallback.
- [x] OIP-3 — Run applicable focused/full checks, typecheck and structural readback; commit work units with Conventional Commit messages and assess the committed candidate when due.

## Acceptance criteria
- The input displays the reported phase while the primary orchestrator is working, including exploring/researching/implementing/checking where reported.
- An unknown or missing phase displays `working…`; no claim that all phases can be inferred from runtime activity.
- Phase state does not leak across sessions, turns or child/background agents; idle and queued labels remain unchanged.
- Existing reflected-light animation and quality/performance/potato modes remain functional.
- Checks and any skips/failures are recorded against exact commands.

## Route
OIP-1/OIP-2: delegated direct — multiple non-trivial code/test files and preparation reading. OIP-3: delegated verification plus parent readback and native gate. One writer, no parallel writes.

## Progress
2026-09-25: Worktree isolated; CodeGraph and read-only mapper confirmed no Pi ODD phase event. Delegated writer added explicit phase registry/tool, prompt rendering and tests. Focused suites: 257 pass, 0 fail; `pnpm typecheck` no regressions; `git diff --check` clean. Independent `pnpm test`: 3510 total, 3475 passed, 1 failed (new `gentle_odd_phase` lacked the Gentle Review tool render contract); provider-contract and runtime harness passed. Independent verification also identified a false-success path (`execute` returned `isError: true` instead of throwing), and a gap in phase-to-ODD-step wording. Targeted correction fixed the render-contract test, made tool errors throw, provided tool result details, corrected phase-to-step wording and added narrow-width coverage. Writer's final `node --experimental-strip-types --test tests/gentle-ai.test.ts tests/odd-phase.test.ts tests/shell-prompt.test.ts tests/gentle-shell.test.ts`: 327 pass, 0 fail; `pnpm test`: 3478 pass, 0 fail, 34 platform skips; provider-contract and runtime harness passed; `pnpm typecheck`: no regressions (188 baseline diagnostics, 10 improved pairs); `git diff --check`: clean. Independent post-correction spot check: same four focused suites 327 pass, 0 fail; `git diff --check` clean. Two wording notes corrected mechanically (test title and Pi-doc comment paraphrases); `node --experimental-strip-types --test tests/odd-phase.test.ts`: 19 pass, 0 fail; `git diff --check`: clean. Session-id changes without prompt reinstallation were not independently exercised. Native assessment of the untracked working-tree candidate was unassessable because intended-untracked scope was not declared; no risk downgrade. Running source/test count after correction: 589 authored diff lines (excluding this document), above the ~400 delivery heuristic. User chose a single large change with a size exception and authorized a local commit. Work-unit commit `50960b9514cb9f749401714fb54f57e24b83ff01` (`feat(shell): show explicit ODD phase in working prompt`) contains 10 files, 620 additions and 2 deletions. Committed-only native assessment against branch point 80375c6c reported `high` (process boundary, `extensions/gentle-ai.ts`); four-lens review lineage `review-683e2f5debcd355d` approved with nonblocking advisory findings and was acknowledged (authority burned). Functional checks passed before freeze; the review approved exactly this commit. No push, PR or merge yet. The user authorized remote `gh` and Git SSH for `Gentleman-Programming/gentle-shell` but not issue creation. Remote search found no clearly matching approved issue; PR is blocked by the issue-first policy, so the branch remains local.

## Next step
Ask whether to create a new issue (which will need maintainer approval), link a specific existing approved issue, or keep the reviewed work local. Do not push/open/merge a PR until the issue-first gate is satisfied; remote permission alone does not waive it.
