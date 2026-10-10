# Fix #1648: allow empty input `{}` and empty string for ambient inspect

## Objective

Prevent `gentle_review inspect` from rejecting ambient inspection calls when `input` is provided as an empty JSON object `"{}"` or empty string `""`. Ensure `committed-only-invalid` is only returned when `committedOnly` is actually supplied without `baseRef`.

## Problem

When a caller (such as an LLM conforming to tool schemas) calls `gentle_review` with `{"operation": "inspect", "input": "{}"}`:
`extensions/gentle-ai.ts:7843` checks:
```ts
if (rawInspect !== undefined && baseRef === undefined) return nativeInspectInputRejection("committed-only-invalid");
```
Because `rawInspect` is `{}` (not `undefined`) and `baseRef` is `undefined`, the controller returns `committed-only-invalid` even though `committedOnly` was never passed.
Additionally, passing empty string `input: ""` throws a JSON parse error instead of treating it as omitted input.

## Scope

- In `extensions/gentle-ai.ts`, treat empty/whitespace input string as `undefined` for `inspect`.
- In `extensions/gentle-ai.ts`, reject `committed-only-invalid` only if `rawInspect?.committedOnly !== undefined && baseRef === undefined`.
- When `rawInspect` is empty `{}` (no `baseRef` and no `committedOnly`), allow it to proceed to ambient inspect.
- In `tests/review-controller-native-routing.test.ts`, add tests proving:
  - `input: "{}"` proceeds to ambient inspect.
  - `input: ""` proceeds to ambient inspect.
  - `input: '{"committedOnly": true}'` still rejects `committed-only-invalid`.
  - `input: '{"committedOnly": false}'` still rejects `committed-only-invalid`.

## Tasks

- [x] T1 Reproduce #1648 with failing unit tests in `tests/review-controller-native-routing.test.ts` (RED).
- [x] T2 Fix inspect input validation in `extensions/gentle-ai.ts` (GREEN).
- [x] T3 Verify full test suite, runtime module checks, and typechecks.
- [x] T4 Commit work unit and document verification evidence (commit `975e1709`).

## Verification Evidence

- **RED observed**:
  - `INSPECT accepts empty object and empty string input for ambient inspection`: failed with `AssertionError: expected ready for input "{}" ('blocked' !== 'ready')`, rejected with `native-inspect-input-invalid` and `reason: "committed-only-invalid"`.
- **GREEN observed**:
  - Test passed for `"{}"`, `""`, and `"   "`, successfully executing ambient `targetStatus` (3/3 calls).
  - Malformed committed-range selectors (`{ committedOnly: true }`, `{ committedOnly: false }`) continue to fail closed with `committed-only-invalid`.
  - `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts`: 89 passed, 0 failed.
  - `pnpm run typecheck`: clean (187 recorded baseline diagnostics, 0 regressions).
  - `pnpm run check:runtime-modules`: clean (8 generated modules).
  - `pnpm test`: 4,539 passed, 0 failed, 34 skipped (all three stages PASS: `unit-tests`, `provider-contract`, `runtime-harness`).


## Acceptance Criteria

- `executeReviewControllerOperation` with `operation: "inspect"` and `input: "{}"` or `input: ""` succeeds and dispatches ambient inspection.
- Calls providing `committedOnly` without `baseRef` continue to fail closed with `committed-only-invalid`.
- All tests in `tests/review-controller-native-routing.test.ts` and full test suite pass.
