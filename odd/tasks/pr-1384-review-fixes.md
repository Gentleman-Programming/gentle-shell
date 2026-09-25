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
