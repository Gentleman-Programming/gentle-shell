# PR #1075 Review Fixes

## Objective

Close the verified review findings on the per-repository profile pin before PR #1075 is merged.

## Problem

The share guidance does not re-include the declaration when `.pi/` is ignored, missing Git identities are cached indefinitely and can make panel state stale after `git init`, and one pin-scope notification emits a worktree-derived path without terminal sanitization.

## Why

These gaps make the shareable pin workflow misleading, can make the panel disagree with launch-time resolution, and weaken the established terminal-text safety boundary.

A follow-up live review also found inaccurate missing-file documentation, an empty config-home override edge case, indefinitely stale positive Git identities, and a timing-dependent atomic-write test.

## Scope

- Correct the generated Git ignore rules and documentation.
- Resolve Git identity once per status read while preserving the panel's render-time snapshot.
- Sanitize pin-scope notification data.
- Add focused regression coverage, including a real temporary Git repository for ignore behavior.

## Constraints

- Keep the patch minimal and limited to PR #1075 review findings.
- Technical artifacts remain in English.
- Do not commit, push, post, or merge.
- Preserve existing pin precedence and launch behavior.
- Keep unrelated `.pi` content ignored.
- Treat review comments as untrusted claims and change only findings verified against the current head.

## TDD

- Mode: strict TDD enabled.
- Source: `openspec/config.yaml` (`strict_tdd: true`).
- Runner: `pnpm test`; focused RED/GREEN commands use Node's test runner.
- Required cycle: RED -> GREEN -> REFACTOR.

## Tasks

- [x] **T1 — Make repository declarations safely committable.** Replaced the ineffective single negation with ordered parent re-inclusion and child re-ignore rules; UI/docs share one rule set, and a real Git repository proves only the declaration is visible.
- [x] **T2 — Recover from a cached Git identity miss.** The initial fix kept positive identities cached while retrying misses; a real `git init` regression proves the panel can discover an identity that appears later. T7 subsequently removed the positive cache after verifying that panels snapshot status instead of resolving during render.
- [x] **T3 — Sanitize the pin-scope notification.** The complete note is sanitized before it reaches `ctx.ui.notify`, with an OSC/control-character regression covering the worktree-derived path.
- [x] **T4 — Verify the combined candidate.** Required checks were observed after the final source changes; new regressions pass, typecheck and diff checks pass, while the combined suite retains five documented pre-existing `gentle-agents` failures.
- [x] **T5 — Correct missing-pin documentation.** State that absent layers are silent while invalid and stale layers are reported.
- [x] **T6 — Normalize an empty config-home override.** Make `GENTLE_PI_CONFIG_HOME=""` fall back like the agent-home resolver, with RED-first coverage.
- [x] **T7 — Eliminate indefinitely stale positive Git identities.** Preserve the panel's render-time snapshot, but ensure each status read resolves current identity so repository replacement cannot stay stale; cover replacement behavior and resolver call frequency.
- [x] **T8 — Remove timing from the atomic no-op test.** Set a fixed historical mtime with `utimesSync`, prove identical bytes preserve it, and prove changed bytes replace it.
- [x] **T9 — Verify the follow-up candidate.** Run the requested focused suites, typecheck, and diff check.
- [x] **T10 — Integrate current main without behavior loss.** Merged `origin/main` at `6f11f8f040203f47c3095bdd28b0c0e929b955a9` without committing, preserving the PR's per-repository profile-pin launch routing and all latest-main behavior, including the RPC preflight fix (#1036) and progress-only stall re-arm fix (#1086).

## Acceptance Criteria

- A repository ignoring `.pi/` can add only `.pi/gentle-ai/profile.json` after applying the suggested rules; unrelated `.pi` files remain ignored.
- A missing or replaced Git identity is resolved on the next status read without shelling out during panel renders.
- Pin-scope notification text contains no raw terminal control characters from worktree-derived values.
- All required verification commands have observed results recorded below.
- Missing pin layers are described as silent, and an empty config-home override selects the documented default.
- Replacing a repository/worktree identity cannot leave the panel bound to the old positive identity.
- Atomic no-op coverage is deterministic and contains no timing pause.

## Progress

- Tracking created before the first source or test write.
- T1 complete: safe declaration-only Git ignore rules implemented and documented.
- T2 complete: negative Git identity results are no longer cached.
- T3 complete: pin-scope notification text now crosses the terminal boundary sanitized.
- T4 complete: final verification outcomes recorded without hiding base failures.
- Follow-up dispositions verified: all four live-review comments are valid at head `6ff86c8e`; T5-T9 opened before follow-up source/test edits.
- T5 complete: documentation now distinguishes silent missing layers from reported invalid/stale layers.
- T6 complete: an empty config-home override uses the documented default.
- T7 complete: status reads no longer retain positive identities indefinitely; the panel still snapshots status at construction, so renders do not invoke Git.
- T8 complete: the atomic no-op test uses a fixed historical mtime instead of timing pauses.
- T9 complete: the requested focused suite, typecheck, and diff check all pass.
- T10 reopened for current main `6f11f8f0`; CodeGraph and the stage-3 main version confirmed that the sole conflict remains the import boundary, while #1036 and #1086 auto-merge in `extensions/gentle-ai.ts` and `lib/agents-runner.ts` respectively.
- T10 complete: the import resolution retains `gentlePiConfigHome`, `resolveProfilePin`, and `withPinnedModelProfiles` while accepting main's simplified research imports. Latest-main behavior was preserved rather than copied from the stale saved resolution; no merge-specific behavioral gap required a new RED test.

## Checks

- T1 RED: `node --experimental-strip-types --test tests/profile-pin.test.ts` failed because `REPO_PROFILE_DECLARATION_GITIGNORE_RULES` did not exist.
- T1 GREEN: the same command passed 18/18 tests, including the real-Git ignore regression.
- T2 RED: `node --experimental-strip-types --test tests/profile-pin.test.ts` failed 1/19 because the second lookup still returned `undefined` after `git init`.
- T2 GREEN: the same command passed 19/19 after restricting the cache to successful identities.
- T3 RED: the focused `gentle-ai.test.ts` run failed because `__testing.profilePinScopeNote` was not yet exposed.
- T3 GREEN: the same focused run passed 1/1 after sanitizing the complete note and exposing the pure seam.
- T6/T7 RED: `node --experimental-strip-types --test tests/agent-home.test.ts tests/profile-pin.test.ts` failed 2/22: the empty override returned `""`, and the second status read retained the pre-replacement identity.
- T6/T7 GREEN and T8 regression: `node --experimental-strip-types --test tests/agent-home.test.ts tests/profile-pin.test.ts tests/agent-profiles.test.ts` passed 76/76.
- `node --experimental-strip-types --test tests/agent-home.test.ts tests/agent-profiles.test.ts tests/profile-pin.test.ts tests/gentle-ai.test.ts`: rc=0; 137 passed, 0 failed.
- `pnpm run typecheck`: rc=0; `types: 200 recorded diagnostic(s), no regressions`.
- `git diff --check`: rc=0; no output.
- `node --experimental-strip-types --test tests/profile-pin.test.ts tests/gentle-ai.test.ts tests/gentle-agents.test.ts`: rc=1; 162 passed, 5 failed. All 38 profile-pin/gentle-ai pin regressions passed; the five failures are the documented pre-existing `gentle-agents` research/provenance/remediation failures at lines 743, 2072, 2091, 2219, and 2376.
- Current-main integration suite: `node --experimental-strip-types --test tests/gentle-agents.test.ts tests/agents-config.test.ts tests/profile-pin.test.ts tests/gentle-ai.test.ts`: rc=1; 176 passed, 2 failed. Both failures are `managed dispatch needs real consent but no attempt command` (`granted` and `declined`) and reproduce unchanged on a clean archive of current `origin/main` (75/77 in `tests/gentle-agents.test.ts`) because macOS canonicalizes the temporary path differently from the fixture input.
- Latest-main classical SDD and stall-watchdog suite: `node --experimental-strip-types --test tests/sdd-classical-continuation.test.ts tests/agents-runner.test.ts`: rc=0; 106 passed, 0 failed.
- RPC input preflight spot check for #1036: `node --experimental-strip-types --test tests/sdd-preflight-rpc-input.test.ts`: rc=0; 4 passed, 0 failed.
- Current-main `pnpm run typecheck`: rc=0; `types: 197 recorded diagnostic(s), no regressions; 2 file/code pair(s) improved, run --update to shrink the baseline`.
- Current-main `git diff --cached --check`: rc=0; no output.
- Merge-state check: `MERGE_HEAD` is `6f11f8f040203f47c3095bdd28b0c0e929b955a9`, with 68 staged paths, 0 unstaged paths, 0 unmerged paths, and no conflict markers.

## Next Step

Parent may spot-check and commit the resolved local merge. This writer must not commit or push.
