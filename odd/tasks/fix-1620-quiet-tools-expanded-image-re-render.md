# Tasks: Fix #1620 Quiet Tools expanded read-with-image re-render crash

## Objective
Prevent Pi from crashing with `TypeError: text.setText is not a function` when re-rendering an expanded `read` tool result containing image content in `quiet-tools`.

## Root Cause
When an expanded `read` result has image content, `quiet-tools` wraps the output of Pi's `officialRenderResult` in a `ToolCardBody` component. On re-render passes (terminal resize, redraw, repaint), Pi's `ToolExecutionComponent` passes the previous component (`ToolCardBody`) as `context.lastComponent`. `sanitizedRenderContext` forwarded `lastComponent` to `officialRenderResult`, which expects `context.lastComponent` to be a Pi `Text` component (or undefined) and calls `text.setText(...)`. Because `ToolCardBody` lacks `setText`, Pi crashes with an uncaught exception.

## Tasks
- [x] 1. Write failing regression test in `tests/quiet-tool-rendering.test.ts` covering expanded image read re-render with `lastComponent` (RED).
- [x] 2. Update `extensions/quiet-tools.ts` to isolate `lastComponent: undefined` when delegating to `officialRenderResult` (GREEN).
- [x] 3. Run full test suite and typecheck verification.
- [ ] 4. Commit work unit with Conventional Commit and publish architectural triage on Issue #1620.

## Evidence
- Reproduction confirmed RED: `TypeError: text.setText is not a function` at `readRenderers.renderResult` in Pi 0.99.2.
- Verified GREEN: 57/57 tests in `tests/quiet-tool-rendering.test.ts` pass cleanly (including subtest 40 covering re-rendering with `lastComponent`).
- `npm run typecheck`: clean, 0 regressions.
- `check:provider-contract` and `check:runtime-modules`: clean.
