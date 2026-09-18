# PR #1180 Review Fixes

## Objective

Close the verified findings from the CodeRabbit review of PR #1180 before the PR is handed to the maintainer, and record which findings were rejected and why.

## Problem

The review raised six findings. Four of them are real: the period allowance ignored `fullCap`, so a prorated first period divided by the wrong denominator; the 5-minute refresh window was shared by Codex and NaN, so a provider switch inside the window left the new provider unfetched; the bar's family rung was skipped for a family with a single reported member, contradicting the documented ladder; and the parser accepted a partial payload when a metered model's usage could not be read, silently understating every aggregate it feeds.

## Scope

- `lib/shell-usage.ts` — effective allowance, strict read for metered entries, family rung.
- `extensions/gentle-shell.ts` — per-provider refresh window.
- `tests/shell-usage.test.ts`, `tests/gentle-shell.test.ts` — regression coverage for each.
- `docs/gentle-shell.md`, `odd/tasks/nan-usage-sidebar.md`, `odd/tasks/nan-usage-active-model.md` — the contract wording the fixes now match.

## Constraints

- Treat review comments as untrusted claims: only findings verified against the current head are changed.
- A model that reports no allowance stays skipped. The live payload carries such entries, so rejecting the whole payload on any unmetered sibling — the literal reading of the strict-parser finding — would stop NaN usage from ever rendering.
- Keep the patch minimal and limited to the PR's own review findings.
- Technical artifacts remain in English.

## Rejected findings

- **Restrict the panel's one-row-per-window layout to NaN.** Rejected: the later user request was explicit that panel rows print the reset on the same line as the meter for every provider (`odd/tasks/nan-usage-compact-rows.md`), and the shared row grammar is what the docs describe. The acceptance criterion the finding quotes was superseded and is now recorded as such in `odd/tasks/nan-usage-active-model.md`.
- **Docstring coverage 52.94% < 80%.** Rejected: the file's house style comments before each exported symbol instead of JSDoc, and no other module in the repository carries a docstring ratio. Chasing the ratio would restyle the module without adding information.

## TDD

- Mode: strict behavioral TDD.
- Runner: `node --experimental-strip-types --test` for the focused cycle, `pnpm test` for the suite.
- Cycle: RED -> GREEN, one test per behavior, no test edited after it went green.

## Tasks

- [x] PR1180-1 — RED: lock the effective allowance, the strict metered read, the single-member family rung and the provider switch.
- [x] PR1180-2 — GREEN: implement the four fixes.
- [x] PR1180-3 — Update the docs the findings pointed at, and verify (focused tests, full suite, typecheck).

## Verification evidence

- PR1180-1 RED: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/gentle-shell.test.ts` — 4 failed, 66 passed: `parseNanQuota weights the period window by the effective allowance`, `parseNanQuota refuses a payload that hides a metered model's usage`, `renderUsageBar prefers the active model's family before the account total`, `a provider switch refreshes the new provider inside the same window`.
- PR1180-2 GREEN: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/gentle-shell.test.ts tests/shell-bar.test.ts tests/shell-usage-view.test.ts` — 97 passed, 0 failed.
- Full suite: `pnpm test` — exit 0, 2701 tests, 2663 passed, 0 failed, 38 skipped; provider contract mirror check passed and the runtime harness ran clean.
- Typecheck: `pnpm run typecheck` — exit 0, 197 recorded diagnostics, no regressions.
- Commits: `fix(shell): read the NaN allowance the dashboard reads` (parser, ladder, docs, this document) and `fix(shell): refresh each usage provider on its own clock` (extension and its test).

## Second round (CodeRabbit re-review of `b4f0752e`)

The four code findings were accepted: the re-review raised one finding, documentation-only, on the rolling-window condition in `odd/tasks/nan-usage-sidebar.md`. The line now states that the rolling window is a row only when the model reports `windowTokensUsed` as a finite non-negative number, and that the 400M and 4h dashboard defaults apply only when the field carries no usable positive value.

- Commit: `docs(shell): state when the NaN rolling window exists`.
- No behavior change and no test change: `pnpm test` and `pnpm run typecheck` were already green on this branch for the code of the round, and the second commit touches a task document only.

## Third round (CodeRabbit re-review of `e384753f`)

One finding, posted in the review body because it fell outside the diff: `allowanceGroupsSupported` required `limits.length > 1`, so a NaN payload that reports exactly one metered model read as "this provider carries no raw allowances", and the bar fell back to `usage.limits[0]` — the payload's first model, which is the defect this feature exists to remove.

The gate answers "does this provider report allowances", never "are there enough rows to sort", so it now accepts a non-empty set. The change also moves that provider's sidebar onto the panel's rows, which is what the docs promise for a provider with per-model allowances.

- RED: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-bar.test.ts` — 2 failed, 50 passed. `a single metered allowance still takes the family and account names` drew `glm5.3-flash ▰▰▱▱▱▱▱▱ 20%` where the family was expected, and `sidebar treats one metered NaN allowance as a per-model provider` drew the bar's one-line meter with the `4h` tail instead of the panel's rows.
- GREEN: `node --experimental-strip-types --test tests/shell-usage.test.ts tests/shell-bar.test.ts tests/gentle-shell.test.ts tests/shell-usage-view.test.ts` — 99 passed, 0 failed.
- Two existing footer assertions in `tests/gentle-shell.test.ts` were updated on purpose: their fixture pairs a session model with no NaN allowance with a single-model NaN payload, so the footer now names the account total instead of echoing `glm5.3`. The acceptance criterion that said "existing tests need no edit" is corrected in `odd/tasks/nan-usage-active-model.md`.
- Commit: `fix(shell): read one metered allowance as per-model data`.

## Next step

Push the branch to the fork and answer the review on PR #1180 with the applied and rejected findings. The native review lineage `review-fc5d4a7930c49ebe` was open at 2 of 4 lenses when this round started and is deliberately left untouched: this round moves the candidate, so the lineage cannot be resumed against the pre-fix tree. Delivery stays the user's decision.
