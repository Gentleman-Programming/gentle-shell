# Flatten gentle_review root schema for Claude Agent SDK compatibility (#1698)

## Objective and scope
Prevent `gentle_review` from being dropped under Claude Agent SDK providers (such as `pi-claude-bridge` and Claude Code). Anthropic API rejects root-level `anyOf`/`oneOf`/`allOf` combinators in tool `input_schema`. Flatten `REVIEW_CONTROLLER_PARAMETERS` to a clean `type: "object"` root schema, keeping operation-specific `input` type constraints fail-closed at the facade/runtime level.

## Completed tasks
- [x] T1: Strict TDD test reproducing rejection of root-level `anyOf`/`oneOf`/`allOf` for `gentle_review`.
- [x] T2: Flatten `REVIEW_CONTROLLER_PARAMETERS` in `extensions/gentle-ai.ts` by removing root-level `anyOf`.
- [x] T3: Align `tests/review-json-arguments.test.ts` to assert that non-START/ASSESS operations reject objects at the controller execution layer.
- [x] T4: Verify full test suite, typecheck, and package files.

## Evidence
Base: upstream/main at cf3012f7. Branch: fix/1698-gentle-review-schema-top-level-anyof.
- TDD RED: `gentle_review parameters must not have root-level anyOf` (actual: 2 branches, expected: undefined).
- TDD GREEN: 8/8 tests passed in `tests/review-json-arguments.test.ts`.
- Routing tests: 96/96 passed in `tests/review-controller-native-routing.test.ts`.
- Typecheck: 186 recorded diagnostics, 0 regressions, 12 improved.
- Package files: 155 files, 69 exact byte-pinned artifacts checked.
