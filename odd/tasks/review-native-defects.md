# Review native defects surfaced by tsc

Branch: `fix/review-native-defects` (from `origin/main` 7a27c1c0).

Two `tsc` diagnostics in `extensions/gentle-ai.ts` hide defects:

- TS2554 at the `recover-lock` route: `executeNativeRecoveryRoute` takes 6
  arguments but receives 7 (`..., nativeReviewCli, undefined, signal`). The
  stray `undefined` lands in the `signal` slot, so cancelling `recover-lock`
  never reaches the native `review reclaim` process.
- TS2339 `NATIVE_REVIEW_OPERATION.VERSION`: the `version` probe operation was
  removed in `ac75a848`; the comparison is dead code (diagnostics always carry
  an operation), so it is removed without behavior change.

## Tasks

- [ ] 1. `recover-lock` forwards the caller's `AbortSignal` to native reclaim
  (RED test in `tests/review-controller-native-recovery.test.ts`, then fix).
- [ ] 2. Remove the dead `NATIVE_REVIEW_OPERATION.VERSION` comparison, refresh
  the type baseline, run the full suite.

## Evidence
