# One Windows storage timing probe

This S6 diagnostic is separate from the failed full trial (39869680717).
It installs nothing and changes no ACL rule or timeout. PR #2431 remains
unverified by this probe; success does not prove Shell startup or fix the timeout.

## Execution boundary

Only the first push attempt on `test/2431-windows-storage-probe` in
`Gentleman-Programming/gentle-shell`, on GitHub-hosted Windows, is admitted.
Checkout HEAD must equal the event SHA; Node is pinned to 24.21.0.
The workflow has no dispatch/schedule trigger. The old full-trial branch filter
is different and must not run. Parent owns publication and the single run;
there is no automatic retry. A subsequent push would consume another run:
**do not push again without new authorization**.

`--help` and actual local refusal precede filesystem access and product imports.
After admission, dynamic imports load existing declaration-only modules. The
original inert environment constructor supplies closed synthetic profile/temp
paths. Only the same synthetic directories made before the old trial's prefix
claim are created; no real profile or product prefix is created or adopted.
`prefixRoot`'s supported storage injection intercepts its first existing
ancestor and throws a sentinel with no fallback-triggering `check`. The target
must be the synthetic LOCALAPPDATA. No second candidate is probed.

## Evidence and limits

One `verifyWindowsStorage(target, env, adapter)` call receives the original
private ACL script. A pinned script digest and exact anchors reject unknown
scripts before execution. Insertion-only stderr markers bracket identity,
path, Get-Item, reparse, access control, owner, owner rejection (including SID
translation), rules (including rejection translation), and parent lookup.
Original statement order, predicates and safe/unsafe stdout remain intact.
The original `windowsProcessCheck` retains executable, argument prefix,
closed environment, shell:false and its fixed 15,000ms/SIGKILL bound.

`WSP1 <fixed_phase> <depth> <elapsed_ms>` lines contain no paths or identities.
On failure, only recognized complete lines, bounded numbers and selected fixed
status/signal/error codes reach `artifacts/evidence.json`. No raw error,
stdout/stderr, command or log file is retained. Admitted precondition and parse
failures also save partial FAILED evidence and exit nonzero. Refusal before
admission deliberately writes no artifact; filesystem failure can prevent saving.

Markers describe the **last observed phase**, not a proven root cause. A begin
without its end can locate the observed stalled clause; truncation or buffering
can hide later progress. The original helper retains only 1024 sanitized stderr
characters on failure, so deep walks may lose markers. Startup absence alone
cannot prove the child never started. Timing overhead is not zero.

The helper discards stderr on success. Thus verified safe completion reports
`NOT_REPRODUCED`, `aclSafe:true`, and `markersAvailable:false`; no successful
phase timings are invented. Unsafe or unverified output never claims ACL safety.
Neither outcome proves the full Shell journey or repairs its original timeout.

## Local controls (inert only)

`node --test .github/scripts/windows-storage-probe.test.mjs` tests admission,
actual local refusal/help, insertion-only marking, privacy projection, first
candidate interception, one fake-adapter call and partial failure evidence.
It never invokes PowerShell, storage verification or a positive hosted entry.
Operational RED/GREEN receipts live under
`odd/checks/2431-windows-trial/storage-probe/`; do not stage them.
