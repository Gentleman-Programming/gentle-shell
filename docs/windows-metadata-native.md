# One hosted Windows metadata validation (S11)

Preparation for candidate `29c79c6f31dc9e5b85cf51c36643b4efeed07e0c`.
The parent owns publication and observation of ONE run on
`test/2360-windows-metadata-native`; no dispatch, retry or automatic fix/push.

## Exact focused command

```text
node --test --test-reporter=tap --test-name-pattern="^native Windows: metadata (single |many |closed-environment timeout )" tests/installer-windows-bootstrap.test.ts
```

Only the exact hosted repository/ref/attempt-1 job sets
`GENTLE_S11_METADATA=hosted-once`. Tests also require Windows and GitHub Actions.
Do not execute these native cases locally. No dependency installation is needed.
Node 24.21.0 runs the existing TypeScript test file directly.

## Coverage and limits

Eleven selected tests: five single, five batch, one original closed-environment
safe-acceptance timeout check. Each creates a disposable owned tree and checks a
safe file/directory baseline using the public API and default process adapter.
The setup process changes only that new root's owner/DACL; it does not change any
ancestor. The production walker still reads real ancestors and must accept them.
An unrelated baseline failure is a failure, never denied-path evidence.

Single/batch cases cover ordinary files/directories, missing-path error versus
`unchecked` with safe-next continuation, and target/ancestor junction fixed
rejections with target contents preserved. The fixed reparse code distinguishes
reparse-before-ACL rejection from a metadata error or generic unsafe result.
Separate single/batch file-symlink cases attempt Node `symlinkSync(..., 'file')`,
require `target-reparse`, and preserve the target contents. Junction and file
symlink creation skip only after actual EPERM/EACCES/ENOTSUP capability errors.
Unexpected errors FAIL. See the failed S11 results below; link coverage is not
uniformly proved.

Single/batch denied-file cases first require safe baselines, then attempt a
protected fixture-file DACL with explicit current-user/trusted FullControl,
OWNER RIGHTS ChangePermissions, and OWNER RIGHTS/current-user ReadPermissions
Deny. Initial owner assignment and explicit WRITE_DAC are retained unchanged. Parent-verified Microsoft [OWNER RIGHTS documentation](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)
explains that an OWNER RIGHTS ACE suppresses implicit READ_CONTROL and WRITE_DAC.
The fixture independently attempts real .NET GetAccessControl: only observed
UnauthorizedAccessException enables denied-path assertions. Single must throw
with that native diagnostic and no known unsafe code; batch must return
`unchecked` followed by a safe result. Setup denied or still-readable observations
explicitly SKIP with the actual capability reason, never count as denied proof.

S12 canonicalizes only the new fixture ROOT with `realpathSync.native` before
constructing descendants, retaining the original cleanup closure. The shared
fixture already uses ordinary `realpathSync`; that did not prevent the observed
8.3/long-name mismatch. Final junction/symlink paths are never resolved to targets.
Reparse codes and exact link locations remain mandatory; separate callback field
assertions expose actual mismatches.

S15 removes unnecessary fixture ACL restoration, not the production denial checks.
After the denied case, the original fixture cleanup closure deletes only its owned
root. Then `lstatSync` must report exact ENOENT for both canonical ROOT and denied
file, without following final links. A present path or any other error (including
EACCES/EPERM) fails. Both absence checks run even after deletion or primary failure.
Errors are collected in attempt order: one is rethrown unchanged, multiple become
AggregateError; nested cleanup errors retain their original identities.
Every metadata case, including ordinary/missing/link/timeout cases and failed
setup, preserves primary and cleanup failures using the same bounded collector.
Capability reasons are carried as data: `t.skip` is called only after all required
cleanup/deletion and required absence checks succeed. This ordering matters because
Node can report a previously marked skip even when a later stage throws.
Cleanup or absence errors therefore FAIL, never PASS/SKIP.
Pure source checks require the native ROOT literal and descendant construction to
be present before checking their order; missing/ordinary-realpath negative controls
must fail that contract. These checks are not native canonicalization proof.
All mutations stay within the newly owned fixture tree;
no privilege enabling, impersonation, policy change or fabricated errors are used.
Setup uses direct .NET constructors, not New-Object/module autoload. Native denial
and actual deletion remain unverified after local S15 changes. Missing
errors and READ_CONTROL denial do not prove every possible metadata/I/O failure.

The timeout test recreates the original closed environment key-for-key, with
synthetic HOME/profile/AppData/temp, actual SystemRoot and the historical PATH
construction. It injects no PSModulePath. It checks the first existing synthetic
ancestor of the absent primary tools path, using Windows PowerShell 5.1 from
SystemRoot and the unchanged 15s default adapter bound. Safe acceptance within
that bound is required; ETIMEDOUT is FAILURE, not an expected passing result.

## Observed S11 and local S12 boundary

Run `39879256076` remains FAILED: **6 PASS / 5 FAIL / 0 SKIP**. The batch
file-symlink failure confirms short ROOT versus long reported path mismatch;
the two single reparse callback failures do not prove that same cause. The ROOT
candidate addresses the confirmed alias, not every possible failure cause.
Both denied cases failed during restoration, potentially masking primary errors.
The original closed-environment safe timeout case passed on that runner; this is
not full Shell proof. No S12 native rerun occurred or is authorized here.
Local callback/source checks are inert evidence only: native alias handling,
denial and DACL-only restoration remain UNVERIFIED, not GREEN.

## Observed S13 and local S15 boundary

Run `39883170542` remains FAILED: **9 PASS / 2 FAIL / 0 SKIP**.
Both failures were fixture restoration errors; the capability reason was not
recorded, so denial equivalence cannot be inferred. S15 removes that unnecessary
operation but does not prove actual Windows deletion or denial functionality.
Native RED/GREEN is unavailable under this local-only grant; no new run is authorized.
Production helpers are unchanged (differential testing N/A); new cleanup control
flow is tested directly with inert callbacks, not simulated .NET semantics.

## Evidence boundary

Built-in TAP includes explicit pass/fail/skip counts and reasons. The job captures
stdout, stderr and exit status separately under runner temp and uploads always
with seven-day retention. The five-minute job and per-process bounds limit output
and execution; no custom collector, probes or executable entry point is added.
Skipped cases remain unproved even if the job exits zero.

Local syntax/whitespace and source checks are inert preparation only, not native
RED/GREEN or security/performance proof. No local native processes are authorized.
No Shell/Engram/Pi/Core/Go/GentleAI installation or execution, real user-store
access, full test suite, PR creation/update/Ready/merge, ACL policy change or
15s increase is in scope. Even a successful native run is not Shell readiness or
full integration proof. Preserve failures and stop; further runs need new consent.
