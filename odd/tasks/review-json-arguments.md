# Review JSON argument compatibility (#1573)

## Objective and scope
Accept JSON objects or serialized object strings for START/ASSESS input and capture bindings without weakening provider authority. Other controller operations, especially consent and maintenance, retain string-only input semantics. Preserve valid string bytes and group order. No generic coercion, SDK upgrade, unrelated fixes or publishing. User explicitly authorized local commits after verification.

## Completed tasks
- [x] T1: Real Pi validation regressions, narrow schema/facade serialization, and provider declaration correction with observed RED/GREEN.
- [x] T2: Independent corrected-candidate verification, baseline diagnosis, and approved native review with exact acknowledgement.

## Evidence
Base/remote main: 7a27c1c008b3922b851da5efb78e4ca4dae6e6b1. Branch: dnlrsls/issue1573. Initial working tree clean.
- Real-validator RED: 1/1 failed with START input must be string; initial GREEN6/6.
- Independent verification found a candidate-caused Anthropic root-anyOf declaration regression. Public adapter payload proved empty candidate properties/required versus complete HEAD declaration, with pretransport sentinel and throwing fetch.
- Provider regression RED6 passed/1 failed (required [] versus operation); corrected GREEN7/7. Restored root object declaration and nullable shell; runtime branches/facade reject null and disallowed-operation objects without native calls.
- Final independent tests27/27 (7 argument/provider +20 sidebar); parent spot check7/7 after native acknowledgement; diff check passed.
- Broader regressions137 passed/3 failed: Windows control-character path ENOENT; missing refuter configuration diagnostic; group failure-envelope mismatch. All three independently reproduced identically on archived HEAD (0/3 focused), so pre-existing.
- Native-routing combined240s timeout; isolated acknowledgement teardown120s timeout on both candidate and HEAD. First STATUS isolated1/1. Internal timeout cause unresolved; not retried after correction.
- Typecheck passed with187 recorded baseline diagnostics/no new regressions.
- pnpm install --frozen-lockfile --ignore-scripts succeeded; tracked manifests/lock unchanged.
- Full suite and live provider request not run. Valid strings unchanged; malformed/non-object strings may reject earlier with different diagnostics.

## Native review
RDD enabled globally. Intended untracked selected tests/review-json-arguments.test.ts only; task document excluded. UI consent resolved. Medium reliability review of255 source/test changed lines approved under lineage review-bc707d1d666bd839. Exact acknowledge-approved succeeded: authority burned, consumed revision sha256:81bbb383e73df8d24fe0086cab9c961cafe373a5eb943c969df6f661ca04728b. Review does not authorize delivery.

## Rationale and next step
Pi validates before tool_call; root provider declaration and runtime validation need separate coverage. Strings stay authoritative; object serialization feeds existing provider-bound checks unchanged. User authorized commit. Work-unit commit: 98cd0d13a409b5f60860d2273f0f015dfee5bc25 (fix(review): accept JSON object arguments at the facade boundary), containing implementation and tests. Staged diff check found one trailing blank line at EOF in the previously untracked regression test; the first commit command stopped before committing. The reviewed bytes were preserved, then the commit succeeded with that formatting warning disclosed. Earlier worktree diff checks did not include the untracked test. Pre-existing failures and timeout are follow-ups outside scope. Push and PR remain user decisions.
Engram mirror remains pending due registration failures; this local document preserves recovery progress.
