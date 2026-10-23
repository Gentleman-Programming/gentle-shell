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
Unexpected errors FAIL. Neither link kind has native results yet.

Single/batch denied-file cases first require safe baselines, then attempt a
protected fixture-file DACL with explicit current-user/trusted FullControl,
OWNER RIGHTS ChangePermissions, and OWNER RIGHTS/current-user ReadPermissions
Deny. Explicit WRITE_DAC is retained: restoration does not rely on implicit owner
rights. Parent-verified Microsoft [OWNER RIGHTS documentation](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)
explains that an OWNER RIGHTS ACE suppresses implicit READ_CONTROL and WRITE_DAC.
The fixture independently attempts real .NET GetAccessControl: only observed
UnauthorizedAccessException enables denied-path assertions. Single must throw
with that native diagnostic and no known unsafe code; batch must return
`unchecked` followed by a safe result. Setup denied or still-readable observations
explicitly SKIP with the actual capability reason, never count as denied proof.

A finally block applies a fresh safe FileSecurity descriptor without reading the
denied ACL, verifies restored public acceptance and contents, then cleans up.
Restoration errors FAIL. All mutations stay within the newly owned fixture tree;
no privilege enabling, impersonation, policy change or fabricated errors are used.
Setup uses direct .NET constructors, not New-Object/module autoload. Native denial
and restoration remain unverified until the single authorized hosted run. Missing
errors and READ_CONTROL denial do not prove every possible metadata/I/O failure.

The timeout test recreates the original closed environment key-for-key, with
synthetic HOME/profile/AppData/temp, actual SystemRoot and the historical PATH
construction. It injects no PSModulePath. It checks the first existing synthetic
ancestor of the absent primary tools path, using Windows PowerShell 5.1 from
SystemRoot and the unchanged 15s default adapter bound. Safe acceptance within
that bound is required; ETIMEDOUT is FAILURE, not an expected passing result.

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
