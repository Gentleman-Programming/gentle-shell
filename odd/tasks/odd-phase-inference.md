# ODD phase inference

Locator: `odd/tasks/odd-phase-inference.md` (worktree `gentle-pi-worktrees/odd-phase-inference`, branch `feat/odd-phase-inference` from `origin/main` 4f5ab3973).

## Objective

Make the Gentle Shell working label (exploring / deciding / planning / implementing / checking) update deterministically from observed tool calls, so it no longer depends on the model remembering to call `gentle_odd_phase`.

## Problem / why

The label is driven only by the model calling `gentle_odd_phase`. The prompt instruction is one negatively-phrased line framed as best-effort, and models skip it (observed live under Claude Bridge: zero calls across a whole session). A prompt cannot guarantee the behavior; code can.

## Scope

- New pure module `lib/odd-phase-inference.ts`: `inferOddPhase(toolName, input)` → phase or `undefined`.
- `OddPhaseRegistry` records the source of a report (`explicit` vs `inferred`).
- One `tool_execution_start` handler in `extensions/gentle-shell.ts` that reports inferred phases for the primary session.
- Prompt/doc wording: the label is inferred automatically; `gentle_odd_phase` refines it.

## Constraints and decisions

- `gentle_odd_phase` stays as an explicit override.
- Precedence: an explicit report in the current turn is not overridden by an inferred `exploring` (read-only tools); inferred `deciding`, `planning`, `implementing`, `checking` do override (they are stronger progression signals). The existing per-turn clears in `gentle-shell.ts` are unchanged.
- Mapping (conservative; unknown → no change):
  - `read`, `grep`, `find`, `ls`, `codegraph` → `exploring`
  - `ask_user_choice`, `ask_user_question` → `deciding`
  - `todo`; `write`/`edit` under `odd/tasks/` → `planning`
  - `edit`, `write` (other paths) → `implementing`
  - `gentle_review*` → `checking`
  - `bash`/`powershell`: test/typecheck/lint/build commands → `checking`; read-only inspection (`git status|log|diff|show`, `ls`, `cat`, `grep`, `rg`, `find`) → `exploring`; anything else → no change
  - `subagent_*` and any other tool → no change
- Never infer for a subagent/child session.
- No change to the `gentle_odd_phase` tool contract or invalid-token semantics.

## Tasks

- [x] T1 — Pure inference module `lib/odd-phase-inference.ts` + `tests/odd-phase-inference.test.ts` (strict test-first). Route: delegated direct (one writer for T1+T2, 2+ non-trivial files).
- [x] T2 — Registry source marker + `tool_execution_start` wiring in `extensions/gentle-shell.ts` + tests; prompt wording in `extensions/gentle-ai.ts` and `assets/orchestrator-delegation.md`.

- [x] T3 — Shell classifier covers real orchestrator commands: quote- and `$(...)`-aware splitting, loop keywords and no-op builtins as neutral, harmless redirects ignored, wider read-only allowlist (git listing, gh read, text tools). Reason: live use showed the label stuck on "working" because 30 of 41 real `bash` calls were compound commands the first classifier left unchanged. Route: direct inline (one module plus test additions, design already understood; declared deviation from the 2-file writer trigger).

## Acceptance criteria

- Reading/grepping files shows `exploring`; editing shows `implementing`; running tests shows `checking`; asking the user shows `deciding` — without any model call to `gentle_odd_phase`.
- An explicit `researching` survives a following `grep` in the same turn.
- Unknown tools and ambiguous bash commands leave the label unchanged.

## Checks

- `node --experimental-strip-types --test tests/odd-phase-inference.test.ts tests/odd-phase.test.ts tests/odd-phase-loader.test.ts`
- `pnpm typecheck` (no new diagnostics vs baseline)
- `pnpm test` (all stages; pnpm stages may abort with symlinked node_modules — run stages directly if so)

## Delivery

Forecast ~300 authored changed lines; strategy `ask-on-risk`; single PR expected. Push/PR are the user's decision.

## Progress

- Exploration done (gentle-ai-explore task muk3flub-1-c4et).
- T1 implemented (delegated writer, uncommitted): `lib/odd-phase-inference.ts` (pure `inferOddPhase`, table + per-segment shell classification: any checking segment → `checking`; every non-`cd` segment read-only → `exploring`; otherwise unchanged; `mcp__<server>__` prefix stripped; output redirection to a file is not inspection) + `tests/odd-phase-inference.test.ts` (11 tests).
  - RED: `ERR_MODULE_NOT_FOUND` for `lib/odd-phase-inference.ts`. GREEN: 11/11 pass.
- T2 implemented (delegated writer, uncommitted): `OddPhaseRegistry` stores `{phase, source}`; `report(..., source = "explicit")`; new `infer()` (explicit phase survives inferred `exploring`; other inferred phases override; same-phase inference is a no-op that keeps the source and skips redraw); `clear` drops the source. `gentle-shell.ts` wires one `tool_execution_start` handler guarded by `ctx.hasUI && isInteractiveMode(ctx.mode)` (subagents are headless `pi --mode rpc` children without the interactive-host env) and skipping `gentle_odd_phase`. `gentle_odd_phase` reports `"explicit"`. Prompt (`gentle-ai.ts`) and `assets/orchestrator-delegation.md` now say the label is inferred from tool activity and `gentle_odd_phase` refines it; the ordered contract clause asserted by `tests/odd-routing-contract.test.ts` is preserved verbatim.
  - RED: 10 new registry tests failed (`infer` missing); new loader wiring test failed at "reading a file shows exploring". GREEN: 43/43 across the three ODD phase test files.
- Verification (writer, before parent commit):
  - `node --experimental-strip-types --test tests/odd-phase-inference.test.ts tests/odd-phase.test.ts tests/odd-phase-loader.test.ts`: 43 pass, 0 fail.
  - `pnpm typecheck`: pnpm aborts (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, symlinked node_modules); `node scripts/check-types.mjs` exit 0, "188 recorded diagnostic(s), no regressions" — identical to the pre-change baseline.
  - `node --experimental-strip-types --test tests/*.test.ts`: 3968 tests, 3925 pass, 0 fail, 43 skipped.
  - `node scripts/check-provider-contract.mjs`: exit 0, mirror check passed.
  - `node --experimental-strip-types tests/runtime-harness.mjs`: exit 0 (no output).
- Next: parent review, work-unit commit(s), tick T1/T2.

## Closure evidence

- Commits: T1 `aa8e5c094` (feat(odd-phase): add deterministic tool-activity phase inference); T2 `5b37c261a` (feat(shell): infer the ODD working label from primary-session tool calls). Route: delegated direct, one writer (gentle-ai-worker) for T1+T2.
- Parent spot check: focused ODD phase tests 43/43 pass.
- Native review: lineage `review-022bb282059e89e5`, risk high (4 lenses), approved and acknowledged (authority burned).
- Advisory follow-ups (non-blocking): R2-001 readability of the checker table (odd-phase-inference.ts:40); R2-002 wording of assets/orchestrator-delegation.md:99; R3-find-exclusions (:48); R3-make-overbroad (:40); R3-quote-unaware-checking (:87-91); R3-redirect-unproved (:102-104).
- Next: live check in Gentle Shell after switching the daily checkout to this branch or merging; push/PR is the user's decision.

### T3 evidence

- RED: new tests failed on real session commands (loops, quoted pipes, substitutions) and exposed a false positive (`ls $(touch marker)` read as exploring).
- GREEN: focused ODD phase tests 46/46; unit stage 3928 pass / 0 fail / 43 skipped; check-types 188 baseline, no regressions; provider-contract pass; runtime-harness exit 0.
- Measured on this session's log: bash calls inferred as exploring went from 4 to 23; the 10 left unchanged are mutations (switch, commit, sed -i, ln, worktree add), sleep, or a fetch.
- Commits: `725e198c4` (classifier), `f2bbe0f1c` (review correction: ReDoS in the bare-assignment pattern; RED 819 ms on 26 pairs, GREEN 0 ms on 1000 pairs, bounded-time test added).
- Native review: lineage `review-f3616c62793fea5d`, high, 4 lenses + refuter; one bounded correction (14 lines) for R3-assignment-redos, targeted validation approved and acknowledged.
- Advisory follow-ups (non-blocking): backtick substitution not split; `git -c` override stripping; git ref-create flags on branch/tag listing; text tools that can write without redirect (awk/sed `w`, uniq out-file); duplicated assignment regex; GIT_LIST_FLAG placement.
