# Fix #1768: Exception-Safe Session-Profile Binding Test Resets

## Objective
Make session-profile binding test resets exception-safe across test suites (`tests/session-profile-binding.test.ts` and `tests/gentle-ai.test.ts`), preventing assertion failures from leaking bindings on `globalThis` into subsequent tests.

## Specs
- S1: `tests/session-profile-binding.test.ts` must use `beforeEach` and `afterEach` hooks to guarantee pristine state on entry and reliable teardown on exit.
- S2: `profilesStoreFixture` in `tests/gentle-ai.test.ts` must register `t.after(() => resetSessionProfileBindingsForTesting())` so all panel tests tear down bindings even if an assertion throws.
- S3: Redundant tail-only manual reset calls in `tests/gentle-ai.test.ts` are eliminated in favor of fixture-managed teardown.

## Tasks
- [x] T1: Add `beforeEach` and `afterEach` reset hooks and regression test in `tests/session-profile-binding.test.ts`
- [x] T2: Add `t.after` reset hook in `profilesStoreFixture` in `tests/gentle-ai.test.ts` and clean up manual tail resets
- [x] T3: Verify unit tests and typechecks with zero regressions

## Log
- L1: Issue #1768 opened by @danielgap reporting that tail-only resets in tests leak state when mid-test assertions throw.
- L2: Implemented fixture-level `t.after` in `profilesStoreFixture` and suite-level `beforeEach`/`afterEach` in `tests/session-profile-binding.test.ts`.
- L3: Reviewed by @danielgap. Rebased on upstream/main after #1558 merge, resolved textual conflict in tests, added rationale comments explaining fixture vs suite hook granularity, cleaned up redundant resets in #1558 tests, and polished regression test.
