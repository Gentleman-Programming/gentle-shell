# Tasks: First Baseline Domain Unit

All work is owned by implementation. This plan covers only the first stacked PR; no task below claims broader feature completion.

- [x] **RED:** Add `tests/session-file-baseline.test.ts` with a missing-module failure, then behavior tests for key separation, first unavailable retention, snapshots, comparisons, and restoration. <!-- sdd-owner: implementation -->
- [x] **GREEN:** Add `lib/session-file-baseline.ts` with the pure instantiable store, collision-safe tuple encoding, and explicit states/results. <!-- sdd-owner: implementation -->
- [x] **TRIANGULATE:** Exercise absent-to-available, available version change-and-restore, unavailable current state, and caller mutation after registration. <!-- sdd-owner: implementation -->
- [x] **REFACTOR:** Clarify names and snapshot boundaries while retaining the focused behavior. <!-- sdd-owner: implementation -->
- [x] Run `node --experimental-strip-types --test tests/session-file-baseline.test.ts` and record the observed strict-TDD evidence. <!-- sdd-owner: implementation -->

## Deferred after this unit

Parent capture timing, persistence, managed children, session/ancestry projection, and changes-view integration remain future chained deliverables. They are intentionally neither implemented nor marked complete here.
