# Issue #1387: Ignore local registry within .atl instead of editing project .gitignore

## Objective

Ensure that the local skill registry generated inside `.atl/` is ignored by creating `.atl/.gitignore` containing `*`, rather than appending `.atl/` to the project's root `.gitignore`.

## Problem

Starting Pi with the skill registry enabled appended `.atl/` to the project's root `.gitignore`. In team repositories where not all contributors use gentle-shell, this introduced unwanted modifications to shared tracked files that could inadvertently enter pull requests.

## Scope

- In `extensions/skill-registry.ts`: Update `ensureAtlIgnored` to create/maintain `.atl/.gitignore` containing `*` instead of creating or modifying the root `.gitignore`.
- In `tests/skill-registry.test.ts`: Add strict tests verifying:
  - Root `.gitignore` remains untouched (not created or appended).
  - `.atl/.gitignore` is created with `*` ignore rule.
  - Files generated inside `.atl/` do not appear as untracked in Git status.
  - Repeated calls are idempotent.
- Full verification and typecheck.

## Constraints

- Keep the patch minimal and limited to issue #1387.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.
- Strict TDD discipline: RED test confirmed before implementation.

## Tasks

- [x] **T1 — Write failing test in `tests/skill-registry.test.ts`.**
- [x] **T2 — Update `ensureAtlIgnored` in `extensions/skill-registry.ts`.**
- [x] **T3 — Full verification and typecheck.**
- [x] **T4 — Review hardening from CodeRabbit feedback.** Guarantee * is final active rule in .atl/.gitignore and scope git identity in tests.
