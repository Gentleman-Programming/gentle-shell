# Update current profile from /gentle:models

## Objective
Let `/gentle:models` save the edited routing and update the current agent-model profile in one key press, so the user no longer has to open `/gentle:profiles` and press `s` after configuring models.

## Problem
Today the flow is: `/gentle:models` → configure → `ctrl+s` → `/gentle:profiles` → select profile → `s`. The last two steps exist only to copy the routing just saved into the profile the user is working with.

## Why
User request (2026-09-16): "faltaría un paso desde directamente models" — the profile snapshot should be reachable from the models panel.

## Scope
- New key `u` in the agent list of the models panel: save global routing exactly like `ctrl+s`, then snapshot the resulting routing (plus the orchestrator from `settings.json`) into the current profile.
- "Current profile" = the profile this repository pins when a pin wins, otherwise the globally active profile.
- Missing profiles store: seed it the same way `/gentle:profiles` does (a `current` profile) and update that.
- No active profile and no pin: keep the global save, report that no profile is current and point to `/gentle:profiles`.
- The panel shows which profile `u` targets.
- Docs: `docs/readme-reference.md` models section and command table.

## Constraints
- Strict TDD (source: user CLAUDE.md `Strict TDD Mode: enabled`). Runner: `node --experimental-strip-types --test tests/gentle-ai.test.ts`.
- Global routing write and agent apply keep their existing behavior; the profile update happens after them.
- Snapshot source is the global effective routing (models.json plus materialized stores), never the pin, so a pinned repository does not snapshot the pin onto itself.

## Tasks
- [x] T1 RED: tests in `tests/gentle-ai.test.ts` for `u` (active profile updated, pinned profile preferred, no current profile reported, missing store seeded).
- [x] T2 GREEN: `extensions/gentle-ai.ts` — `save-profile` panel result, `u` key, footer/profile hint, handler that saves then updates the profile.
- [x] T3 Docs: `docs/readme-reference.md`.
- [x] T4 Checks: focused tests 4/4, full unit suite `tests/*.test.ts` 2606 tests / 2568 pass / 0 fail / 38 skipped (TMPDIR=/private/tmp), `pnpm run typecheck` no regressions.

## Acceptance criteria
- Pressing `u` after editing writes `~/.pi/gentle-ai/models.json` and the profile named current in `profiles.json` holds the same routing plus the orchestrator entry.
- In a pinned repository `u` updates the pinned profile, not the globally active one.
- Without a current profile the global save still happens and a warning names `/gentle:profiles`.

## Progress
- T1: RED observed (4 failures on `Current profile:` render), then GREEN 4/4 with `node --experimental-strip-types --test --test-name-pattern="^u " tests/gentle-ai.test.ts`.
- T2: `save-profile` result, `u` key, two-row footer naming the target profile, `resolveCurrentProfileTarget`, `updateCurrentProfileFromSavedRouting`, `readGlobalEffectiveModelConfig` split out of `readEffectiveModelConfig`.
- T3: docs updated (models section and command table).
- `pnpm run typecheck`: 197 recorded diagnostics, no regressions.
- Full unit suite: 2606 tests, 2568 pass, 0 fail, 38 skipped.
- Native review (RDD on, global): preflight STATUS with untracked scope exclude (task doc excluded), START returned consent/v3 envelope, risk high (260 changed lines, 3 files, evidence: process-spawning code in extensions/gentle-ai.ts), lineage review-55904d78bee8ddfd, target sha256:30c10a12…944f72. User granted. Four lenses captured in process (risk, resilience, readability, reliability), all admitted; closure state approved; exact acknowledgement burned authority (gentle-ai.review-acknowledged/v1, consumed revision sha256:5f77be73…d23e). Seven advisory non-blocking findings: R4-001/R2-001/R3-001 assume a pin resolves while the store is missing or lacks the pinned name, but resolveProfilePin returns undefined in both cases, so the label and the write agree (false positives). Open follow-ups: R4-002 wrap the snapshot build in the same 'saved the global routing, but…' warning; R4-003 label resolved before the panel opens vs target re-resolved at write time; R3-002 no test for the invalid-store and write-failure paths; R2-002 duplicated 'none' sentinel.

- CI verify on PR #1100 failed in the runtime harness: the two added panel rows (profile line, second footer row) pushed the long agent list past the 24-row 85% overlay budget. Fix: AGENT_LIST_MAX_VISIBLE_ROWS now subtracts 15 chrome rows instead of 13. Harness passes locally; extension test files 73/73; typecheck no regressions.

## Next step
Commit/PR is the user's decision (not requested). Optional follow-ups from the advisory findings listed above.
