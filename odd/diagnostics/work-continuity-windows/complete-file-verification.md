# Complete file verification

## Scope

Three user-authorized complete Node test files were executed once each, in the required order, on a Windows host. No retry, filtered rerun, full suite, install, network operation, source change, commit, or publication was performed.

## Commands and results

1. `node --experimental-strip-types --test tests/writer-surfaces.test.ts`
   - Exit: 0
   - Totals: 17 tests; 17 passed; 0 failed; 0 skipped; 0 cancelled.
   - Duration: 1303.0666 ms.

2. `node --experimental-strip-types --test tests/commit-slice-signal.test.ts`
   - Exit: 1
   - Totals: 12 tests; 11 passed; 1 failed; 0 skipped; 0 cancelled.
   - Duration: 16413.3258 ms.
   - Failed assertion: `commitTargetDirectory follows a cd that precedes the commit through ;, && or ||`.
   - Sanitized excerpt: expected POSIX `/tmp/x`; actual native Windows-resolved `C:\tmp\x`.
   - Classification: assertion failure. It was observed in this complete-file run; its relationship to any historical baseline has not been established.

3. `node --experimental-strip-types --test tests/bundled-install.test.ts`
   - Exit: 0
   - Totals: 69 tests; 23 passed; 0 failed; 46 skipped; 0 cancelled.
   - Duration: 963.6711 ms.
   - Skips: POSIX filesystem fixture tests were skipped because this is not a POSIX host.

## Limitations

- This is Windows-host evidence only. It does not verify Linux or the skipped POSIX filesystem behavior.
- The failing assertion has not been compared with a prior exact baseline, so no causality claim is made.
- The commands may emit Git CRLF warnings while creating and cleaning their test-owned temporary fixtures; those warnings were not test failures.
