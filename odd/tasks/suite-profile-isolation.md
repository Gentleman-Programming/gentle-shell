# Isolate suite fixtures from inherited profile and session role

The fixture-isolation fix is independently verified on base `2fb7700a`: both launch modes
and all three full-suite stages pass. Production is unchanged. Tracking issue #1656 is approved;
the fix is ready for PR review, not merged.

## Root class

- The agent-home fixture changed `HOME` and `USERPROFILE` but inherited `GENTLE_PI_CONFIG_HOME`. The production override priority is correct; the fixture must unset and restore the override.
- The principal startup fixture cleared `GENTLE_PI_SHELL` but inherited `GENTLE_PI_AGENTS_CHILD=1`. Child sessions correctly disable the shell card and use a warning fallback when UI exists. The second failure is deterministic child-role contamination, not an intermittent production bug.
- Startup also needs an owned temporary config root so profile resolution never uses the launching operator's profile store. No real user profile was inspected.

## Changes and boundaries

- `tests/agent-home.test.ts`: save/unset/restore the config override; cover restoration for both defined and undefined inherited values.
- `tests/gentle-ai-dev-binary-surfacing.test.ts`: isolate config and principal role with per-test hooks; restore inherited values and remove the owned config directory. Add a deliberate child-role case requiring exactly one warning even with the shell enabled. Clean up temporary dev-override directories.
- Existing principal card-deferral, headless silence, and explicit-shell-off assertions remain intact. Production child guards, APIs, provider behavior, configuration files, and dependencies are unchanged.
- Rollback boundary: these two fixture files and this task record only. The implementation writer
  performed no commits or delivery actions; the feature work-unit reference is
  `fix/suite-profile-isolation-01a102af`.

## Evidence

Test-first evidence spans the parent and delegated writer: the parent observed the failing
fixtures before edits; the writer then supplied the passing and alternate-launch checks.
The RED rows are actual parent executions, not executions claimed by the writer.

| Stage | Command / evidence | Result |
| --- | --- | --- |
| Parent RED | `node --experimental-strip-types --test tests/agent-home.test.ts tests/gentle-ai-dev-binary-surfacing.test.ts` on the base before edits | 9 tests, 8 passed, 1 failed (agent-home) |
| Parent RED, child role | `GENTLE_PI_AGENTS_CHILD=1 node --experimental-strip-types --test tests/agent-home.test.ts tests/gentle-ai-dev-binary-surfacing.test.ts` before edits | 9 tests, 7 passed, 2 failed |
| Writer GREEN | `node --experimental-strip-types --test tests/agent-home.test.ts tests/gentle-ai-dev-binary-surfacing.test.ts` | 13 tests, 13 passed, 0 failed, 0 skipped |
| Writer TRIANGULATE | `GENTLE_PI_CONFIG_HOME=/synthetic-inherited-config GENTLE_PI_AGENTS_CHILD=1 node --experimental-strip-types --test tests/agent-home.test.ts tests/gentle-ai-dev-binary-surfacing.test.ts` | 13 tests, 13 passed, 0 failed, 0 skipped; the synthetic inherited path is not used for I/O |
| Type validation | `node scripts/check-types.mjs` | Exit 0; 186 recorded diagnostics, no regressions; 12 file/code pairs improved |
| Provider contract | `node scripts/check-provider-contract.mjs` | Exit 0; contract 1.2.0, 9 bundle entries, 2 generated baselines |

An initial writer type check found one new TS2339 diagnostic because a `beforeEach` hook context is typed as `TestContext | SuiteContext`. Replacing hook-local `t.after` registration with a paired `afterEach` cleanup removed it; both focused commands were rerun successfully afterward. The diagnostic baseline was not updated.

The 13-test count includes two restoration subtests. Alternate coverage protects the correct child fallback, principal card deferral, headless silence, explicit shell-off fallback, and config override restoration. No real provider requests or Pi runtime API changes were involved. The package-manager test
bootstrap was not run; the independent verifier executed the existing three-stage suite runner
with the package scripts' Node equivalents.

## Independent acceptance

- Both focused launch commands above: 13 passed, zero failed or skipped.
- Full unit stage: 4,744 tests, 4,700 passed, zero failed, 44 skipped, zero cancelled.
- Provider-contract and runtime-harness stages: both passed; overall runner exit 0.
- Typecheck: 186 recorded diagnostics, no regressions. Diff whitespace check passed.
- Readback confirmed environment restoration, owned config isolation, unchanged existing toast
  assertions, and the explicit child-warning case.

The first independent full run changed the tested process's umask to `077` while protecting its
log, causing an unrelated directory-mode assertion (`0755` expected, `0700` observed). A corrected
capture protected only the log descriptor with mode `0600`, preserving inherited environment and
umask; that one corrected run passed all stages. No source change or skip suppressed that failure.

## Tracking and authority

Existing open issues #1656 (caller agent-session state) and #1717 (runner home state) track this
isolation root class. A maintainer explicitly approved #1656, and GitHub readback confirmed
`status:approved`; #1717 is unchanged. No duplicate issue was created.

The user's exact merge approval applied only to PR #1727, which is already merged and that authority is spent. This new work unit is not merged. There is no authority for a new PR merge, auto-merge, push to main, or merge API action.
