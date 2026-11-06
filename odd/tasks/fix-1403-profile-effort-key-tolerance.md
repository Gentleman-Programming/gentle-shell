# Issue #1403: Accept `effort` key in profile routing entries

## Objective

Fix silent dropping of the `effort` key in profile entries by accepting `effort` as an alias for `thinking` in `normalizeRoutingEntry` (`lib/model-routing-authority.ts`).

## Problem

In `subagents.json`, the field is called `effort`, and `extensions/gentle-ai.ts` writes `profile.effort = entry.thinking`. `lib/agents-config.ts` accepts `entry.effort ?? entry.thinking`.
However, `normalizeRoutingEntry` in `lib/model-routing-authority.ts` only read `value.thinking`. When an operator creates or edits a profile with `{ model: "...", effort: "medium" }`, the `effort` key was silently dropped without warning in `readProfilesFileResult(...).drops`, causing the agent to resolve at the default thinking level.

## Scope

- In `lib/model-routing-authority.ts`: Update `normalizeRoutingEntry` to read `value.thinking` first, falling back to `value.effort` if valid.
- In `tests/model-routing-authority.test.ts`: Add strict regression unit tests for `effort` normalization and precedence.
- In `tests/agent-profiles.test.ts`: Add tests verifying that `normalizeProfilesFile` retains thinking level when entries use `effort`.
- Run typecheck and test suites.

## Constraints

- Keep the patch minimal and focused on issue #1403.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.
- Strict TDD discipline: RED test confirmed before implementation fix.

## Tasks

- [x] **T1 — Write failing regression tests for `effort` key tolerance in routing entries.**
- [x] **T2 — Accept `effort` as fallback for `thinking` in `normalizeRoutingEntry`.**
- [x] **T3 — Full verification and typecheck.**
