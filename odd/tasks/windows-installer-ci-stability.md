# Windows installer CI stability

## Request and scope

Stabilize the intermittent Windows installer CI failure without changing the active runtime or weakening production safety checks. PR #2006 is merged. PR #2008 remains a diagnostic draft, with a non-closing reference to #1965. No merge of this follow-up is authorized.

Root classification is E (unclear): a five-second entry-fixture deadline is a candidate, not a confirmed explanation of the historical worker failures.

## Evidence

- Original run 38002406329 attempts 1 and 2 lost the entire Windows bootstrap test worker after about six seconds, without a named assertion. Attempt 1 runner cleanup found an orphan PowerShell process.
- Main baseline and two diagnostic runs passed on Node 24.21.0. Original-order diagnostic 38006557758 passed 336 installer cases, with 62 platform-specific skips, and all 15 native cases without skips. First entry took 2,283 ms.
- A normal `spawnSync` timeout should return an error and yield a named assertion. The missing worker is a separate fact requiring raw exit evidence.
- Upstream nodejs/node#65756 records Windows isolated-test child access violations; nodejs/node#65778 fixes a Realm lifetime defect. The 24.21.0 release predates that fix. This is another candidate, not proof that our failure is the same crash.

## Bounded experiment

1. Extract the current direct entry invocation into a behavior-preserving test helper.
2. Add one native regression using the same CMD → PowerShell ancestry, five-second deadline, fresh fixture ownership marker and existing PID-plus-creation-time records. The child sleeps for a bounded 20 seconds, without network or production mutations.
3. Observe whether the direct call returns within its deadline/cleanup allowance and whether a recorded descendant survives. Always clean only fresh recorded processes through the existing ownership-checked guard.
4. Publish this RED candidate only to the isolated diagnostic branch and inspect TAP, including any file-level raw exit code. A Linux skip is not RED or native proof.
5. Only after a concrete failure, choose the corresponding fix. If deadline/descendant handling fails, prefer reuse of the existing guarded native fixture runner over new process-control machinery. A crash exit code requires separate Node-runtime analysis.

## Acceptance and non-goals

- Forced fixture deadline reports failure explicitly, remains bounded, and leaves no fresh recorded PowerShell process.
- Normal entry retains expected exit 1, the missing-bundle diagnostic, empty install home and path/Unicode/CMD-metacharacter coverage.
- Keep production source, Node version/output/deadline/ACL/archive checks, all suite selections and native guard unchanged.
- Keep worker isolation unless evidence proves that changing it is appropriate.
- No retries that convert failures into success, no `continue-on-error`, no speculative timeout increase, no machine-wide process kill and no active runtime changes.
- Independent verification and hosted Windows acceptance are required before a repair is claimed. Historical worker-cause attribution remains separate from fixing any reproduced fixture defect.

## Work units and proof budget

Forecast: one contained fixture-lifecycle unit, under 200 diff lines, including regression and evidence. Rollback removes the helper/regression and diagnostic additions without changing production or To-Do code.

Allow one controlled native RED experiment, then the fix and its native validation. If it does not localize either candidate, stop for a decision rather than repeating broad green runs.

## Progress

- [x] Compare original failures and successful cold-order diagnostics.
- [ ] Observe controlled native RED and classify the actual defect.
- [ ] Apply the smallest corresponding correction.
- [ ] Validate native acceptance and independent safety review.

Local candidate validation: `node --experimental-strip-types --test --test-reporter=tap tests/installer-windows-bootstrap.test.ts` reported 37 passes, 16 native skips and zero failures; `node scripts/check-types.mjs` reported no baseline regressions. Final validation after the three process-record assertions also reported no type-baseline regressions; the focused deadline selection reported zero passes and one explicit native-unavailable skip. These Linux results are not native RED.

Independent probe-safety review confirmed fixed invocation settings, finite child sleep, mandatory record evidence and creation-time-scoped cleanup. It did not execute PowerShell or prove either root candidate. The 16-second assertion bounds the entry runner call; external cleanup calls have separate existing five-second bounds.

Commit identities and hosted RED/GREEN will be recorded after execution; none is claimed yet.
