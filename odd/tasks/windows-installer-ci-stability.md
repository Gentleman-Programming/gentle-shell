# Windows installer CI stability

## Request and scope

Stabilize the intermittent Windows installer CI failure without changing the active runtime or weakening production safety checks. PR #2006 is merged. PR #2008 remains a diagnostic draft, with a non-closing reference to #1965. No merge of this follow-up is authorized.

Root classification is C for the reproduced native fixture descendant leak. The historical whole-worker failure remains E: the experiment confirms a cleanup defect, not the cause of every earlier CI failure.

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
- [x] Observe controlled native RED and classify the actual defect.
- [x] Apply the smallest corresponding correction and validate native GREEN.
- [x] Validate native acceptance and independent safety review.

Local candidate validation: `node --experimental-strip-types --test --test-reporter=tap tests/installer-windows-bootstrap.test.ts` reported 37 passes, 16 native skips and zero failures; `node scripts/check-types.mjs` reported no baseline regressions. Final validation after the three process-record assertions also reported no type-baseline regressions; the focused deadline selection reported zero passes and one explicit native-unavailable skip. These Linux results are not native RED.

Independent probe-safety review confirmed fixed invocation settings, finite child sleep, mandatory record evidence and creation-time-scoped cleanup. It did not execute PowerShell or prove either root candidate. The 16-second assertion bounds the entry runner call; external cleanup calls have separate existing five-second bounds.

## Native RED and correction candidate

RED commit `e7aa524fa36d54aad8a11ae764666106288fe71f`, Windows job 114107482459 / run 38016389681: the forced call returned after 5,002 ms with `ETIMEDOUT`, null status and SIGKILL. The later ownership-checked cleanup reported `residualReaped: true`. The named regression failed specifically because a recorded PowerShell descendant survived; the remaining 336 installer tests passed. This did not reproduce a worker crash.

The correction extracts the already-used asynchronous `nativeCmd` process lifecycle into `nativeCmdFile`, retaining the first entry's five-second limit and other fixtures' existing limits. The copied complete production batch gains only the existing PID/ticks observation line; a portable byte-preservation test checks this. Spawn errors reject; guard intervention still fails normal entry acceptance; residual cleanup still fails acceptance. The forced-deadline regression must retain its original assertions and stop requiring later reaping.

No production executable, Node version, deadline, policy, ACL, archive, isolation or CI selection changes. Shared runner lifecycle and ownership guards remain one source of truth. Correction candidate local checks: 38 portable passes, 16 unavailable native skips and zero failures; no type-baseline regressions; package-resource check passed (198 files, 69 pinned contract artifacts). Parent and independent structural comparisons confirm the existing async lifecycle/ownership guards and forwarded caller limits are unchanged. Independent safety review found no blocking defect, but does not establish native execution or general process-tree cleanup. ## Native GREEN and final scope

GREEN code commit `359c95aa803821ad2a07ac8d2307e02598e2dcb0`, Windows job 114111369636 / run 38017638061:

- Normal full entry returned expected status 1 without guard intervention; the PID record, missing-bundle diagnostic and empty install home assertions passed.
- Forced deadline settled in 5,707 ms, reported intervention/null status and `residualReaped: false`. The independent native guard repeated the regression successfully in 5,689 ms.
- Full installer suite: 338 passes, 62 platform-specific skips, zero failures.
- Native acceptance: 16 passes, zero skips or failures.
- All eight CI jobs passed. CodeRabbit skipped the draft; the independent correction safety review passed and is not represented as a native review receipt.

The reproduced recorded-descendant leak is fixed without increasing any deadline. The historical whole-worker failure is not attributed; there is no blanket guarantee that all Windows flakiness is resolved. PR #2008 remains draft and non-closing; no merge is authorized. Active runtime and production sources remain unchanged. This final evidence update changes documentation only; the tested code remains byte-identical to the GREEN code commit.
