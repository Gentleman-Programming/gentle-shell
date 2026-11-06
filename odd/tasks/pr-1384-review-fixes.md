# PR #1384 Review Fixes

## Objective

Close the verified CodeRabbit review finding on PR #1384 (`#1349` empty profile wipe guard) by requiring confirmation when applying orchestrator-only profiles that lack agent routes.

## Problem

Commit `b0a590be` checked `Object.keys(normalized).length === 0` to prompt for confirmation. However, a profile that contains only an orchestrator entry (`orchestrator: { model: "..." }`) has `Object.keys(normalized).length === 1`. Applying it skipped confirmation, replaced global routing with the orchestrator-only config, and wiped materialized routes for all omitted agents in `subagents.json`.

## Scope

- In `extensions/gentle-ai.ts`, check whether any agent routes exist (excluding the reserved orchestrator key) before applying a profile.
- Add regression coverage in `tests/gentle-ai.test.ts` for orchestrator-only profiles.
- Verify typecheck and tests.

## Constraints

- Keep the patch minimal and limited to PR #1384 review findings.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.
- Strict TDD discipline: RED test confirmed before implementation fix.

## Tasks

- [x] **T1 — Guard orchestrator-only profiles against unconfirmed agent route wipes.** Check for absence of agent routes (e.g. `!Object.keys(normalized).some((name) => !isProfileOrchestratorKey(name))`) in the profile apply flow.
- [x] **T2 — Regression tests and typecheck verification.** Verify orchestrator-only profile application prompts for confirmation and aborts when declined.
- [x] **T3 — Correct confirmation copy and strengthen safety assertions.** Implementation and independent nan QA complete: dialog distinguishes empty/orchestrator-only profiles and explains settings plus attempted live-session change. Decline preserves models, subagents, profile store, settings and live switches; confirmation clears omitted routes; nonempty/repo-pinned applies do not prompt. Work-unit commit pending explicit user authorization.
- [ ] **T4 — Validate the correction candidate and report delivery readiness.** Run candidate assessment and native review under the enabled user-owned RDD switch. Commit, push and PR merge remain pending explicit user direction.

## QA follow-up (2026-09-30)

The operator accepted independent nan QA findings on target `03ea59771bb7d18adc28f8702890b306bf7d1069`. The confirmation works, but the orchestrator-only message incorrectly promises an empty config and omits settings/live-session effects. Existing tests do not explicitly assert preservation of every affected surface or confirmed omitted-agent clearing.

- Allowed source surfaces: `extensions/gentle-ai.ts`, `tests/gentle-ai.test.ts`.
- Route: delegated `gentle-ai-worker`; multi-file writer trigger (two nontrivial source/test files).
- TDD: strict, retained from this feature document's Constraints; observe failing copy regression before changing production code, then GREEN.
- Focused runner: `node --experimental-strip-types --test --test-name-pattern="profile" tests/gentle-ai.test.ts`.
- Closure checks: `node --experimental-strip-types --test tests/gentle-ai.test.ts`; `node scripts/check-types.mjs`; `git diff --check`.
- Environment: target requires pi-coding-agent 0.99.1; parent dependencies previously contained 0.85.1. Use matching dependencies in an isolated test worktree, without installing or modifying operator routing.
- Delivery strategy: ask-on-risk; forecast approximately 80–160 additional authored lines, one cohesive correction unit; no size-driven split required yet.
- Local branch `pr-1384` fast-forwarded to updated PR head `03ea5977`; no history rewritten.
- Progress: T3 verified locally. Writer (glm-4.7/high) observed RED for title and conditional live-switch wording, then GREEN. Independent nan/mimo-v2.6-flash QA observed focused 35/35 and full extension 94/94 tests, typecheck 187 baseline diagnostics/no regressions, and full-tree diff check exit 0 using pi 0.99.1 dependencies. Temporary test worktrees removed; parent dependencies and operator config unchanged.
- T4 blocked: native assessment returned schema-incompatible/unassessable, requiring independent verification (completed). Native inspect then stopped with managed_assets_outdated, offering `/home/jbarbat/.local/share/gentle-ai/main/gentle-ai sync --agent pi`. No lineage started and no review approval obtained. Synchronizing installed assets is outside this source-only correction and awaits operator direction.
- Remaining checks: manual TUI Escape/cancel smoke and installed packed-package check not performed; no new CI run because corrections remain local.
- Delivery: no correction commit, push or PR merge executed. Engram mirror unavailable (session already ended). Next step: operator decides whether to sync managed assets for native review and authorize delivery separately.
