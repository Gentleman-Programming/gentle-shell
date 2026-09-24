# Feature: ODD todo continuity and calm Thinking labels

## Objective
Keep Pi's visible `todo` list synchronized with every substantial ODD feature, and make collapsed `Thinking…` labels static pink instead of globally animated blue.

## Problem / Why
- ODD creates durable `odd/tasks/<feature>.md` and Engram progress, but the current contract calls the visible `todo` projection optional. The list can therefore remain absent or stale while work proceeds.
- `pi-pretty` writes a global hidden-thinking label. Its best-effort per-row patch can miss the host's actual component class, causing every historical `Thinking…` row to animate. Its session-derived accent can also render blue instead of following Gentleman-Cute's rose palette.

## Authorized scope
- ODD orchestration contract and focused contract tests.
- Gentle Pi's `pi-pretty` wrapper, Gentleman-Cute theme, and focused tests.
- This feature document and its Engram mirror.
- Preserve unrelated in-progress `sdd-trigger-boundary` edits.

## Constraints
- The feature file and Engram copy remain durable authorities; `todo` is the required session/UI projection for substantial ODD only.
- Keep exactly one visible todo task `in_progress`; update it at task boundaries and whenever the plan changes.
- Do not depend on Pi private component internals for per-row animation.
- Preserve working/editor animation; disable only collapsed Thinking-label animation.
- No commit, push, PR, release, or remote mutation.

## Tasks
- [x] **T1 — Make ODD todo projection mandatory.** Added RED contract assertions, then required creating/rebuilding the visible `todo` list when substantial ODD tracking starts and synchronizing it after every task/progress change.
- [x] **T2 — Make Thinking labels static pink.** Added RED focused assertions, disabled `pi-pretty`'s global Thinking shimmer in the Gentle Shell wrapper without leaking environment state, and mapped Gentleman-Cute `thinkingText` to `softRose`.
- [x] **T3 — Verify focused behavior.** ODD routing, pi-pretty wrapper, and theme tests pass; `git diff --check` passes.
- [x] **T4 — Verify the complete candidate.** Ran broader checks and structural readback. Native review inspection was performed but START was not allowed because the ambient candidate also contains unrelated tracked `sdd-trigger-boundary` edits; no review lineage or receipt was created.

## Acceptance criteria
1. A substantial ODD feature must create/rebuild the visible `todo` list from reconciled feature tasks before the first source write.
2. ODD must update both durable authorities and the visible `todo` projection at every task transition and material plan change.
3. Small/read-only work still does not require an ODD artifact or todo list.
4. Historical and active collapsed `Thinking…` labels are static and rose-colored under Gentleman-Cute.
5. Gentle Shell's separate `working…` editor animation remains unchanged.
6. No unrelated existing worktree changes are overwritten.

## Checks
- `node --test --experimental-strip-types tests/odd-routing-contract.test.ts`
- `node --test --experimental-strip-types tests/pi-pretty.test.ts`
- `node --test --experimental-strip-types tests/gentle-theme.test.ts`
- `git diff --check`
- Broader checks selected after the focused suites pass.

## Progress
- Exploration complete: root causes and non-overlapping edit surfaces identified.
- User selected robust static pink Thinking labels over a private-internals per-row animation patch.
- T1–T3 complete. Engram mirror remains pending because this Pi runtime session is bound to project `gentle-ai` and rejects writes to `gentle-pi`; the local feature document is authoritative until a gentle-pi session resynchronizes it.

## Verification evidence
- RED: focused run reported 4 intended failures (missing ODD todo contract ×2, Thinking shimmer override, rose `thinkingText`).
- GREEN: `node --test --experimental-strip-types tests/odd-routing-contract.test.ts tests/pi-pretty.test.ts tests/gentle-theme.test.ts` — 18/18 pass.
- `git diff --check` — pass.
- `pnpm run typecheck` — pass with the recorded 197-diagnostic baseline and no regressions (2 file/code pairs improved).
- `pnpm run check:provider-contract` — pass (contract 1.2.0).
- `pnpm run test:harness` — pass.
- `pnpm test` — 2620 pass, 2 fail, 38 skip. Both failures are pre-existing/environmental and outside this feature: remediation native scope mismatch, and macOS `/private/var` versus `/var` CodeGraph temp-path alias.
- Structural readback confirms the feature changes are limited to the ODD contract/tests, pi-pretty wrapper/test, and Gentleman-Cute theme/test; unrelated tracked SDD-trigger changes remain present and untouched.
- Native `inspect` returned an intended-untracked selection stop over a mixed tracked candidate that includes unrelated SDD-trigger files. START was not run; no lineage or receipt exists.

## Next step
Reload Pi to activate the wrapper/theme changes. Resynchronize the Engram mirror from a Pi session rooted in `gentle-pi`; isolate the candidate before any native review or delivery.
