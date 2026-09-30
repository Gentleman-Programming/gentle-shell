# Fix #1436: unref'd AbortSignal.timeout fixtures cancel all local inprocess-reviewer and rdd-status-line tests on Node 22

## Objective
Fix event loop drainage cancellations on Node 22 in `tests/inprocess-reviewer.test.ts` and `tests/rdd-status-line.test.ts` without touching production code.

## Problem
On Node 22, `AbortSignal.timeout()` uses an unreferenced (`unref()`) timer. When fixtures await a promise that only settles on abort/timeout (such as `new Promise<never>(() => {})` or `signalAwaitingComplete()`), the Node event loop detects no referenced handles and terminates before the test promise resolves, reporting "Promise resolution is still pending but the event loop has already resolved". This cancelled 26 tests in `inprocess-reviewer.test.ts` and 10 tests in `rdd-status-line.test.ts` in cascade.

## Solution
Keep a bounded referenced timer alive while the test fixture awaits completion against the timeout signal, clearing it immediately in `finally`:
1. In `tests/rdd-status-line.test.ts`: wrap `resolveRddModeStatus(neverSettling, ...)` with a bounded referenced `keepalive` timer cleared in `finally`.
2. In `tests/inprocess-reviewer.test.ts`: in `signalAwaitingComplete` and `signalResolvingAbortedComplete`, keep a bounded referenced timer alive while awaiting the signal abort event, cleared in `finally`.

## Verification
- `node --experimental-strip-types --test tests/inprocess-reviewer.test.ts`: 36/36 passed (0 cancelled).
- `node --experimental-strip-types --test tests/rdd-status-line.test.ts`: 18/18 passed (0 cancelled).
- `npm test`: 100% passed across all suites on Node 22.
