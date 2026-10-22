# Windows storage module-path A/B diagnostic

## Scope

S8 authorizes one dedicated hosted Windows workflow, with exactly two storage
child invocations when preconditions hold. No Shell installation, Core/Pi/Go,
network activity in the script, real store, ACL policy change or timeout change.
Earlier failed trials remain failed. This does not establish full Shell proof.

The push-only branch is `test/2431-windows-module-ab`; attempt 1 only. Checkout,
Node setup and upload actions are pinned. The entry requires the exact public
GitHub repository, hosted Windows, branch, push, SHA matching detached HEAD and
Node 24.21.0 before dynamic helper/product imports. `--help` and actual local
refusal do not access the filesystem or import product modules.

## The single variation

One fresh synthetic root and directories use the existing closed
`isolatedEnvironment`. Existing `firstAncestor(prefixRoot, env)` intercepts the
first existing ancestor, without claiming a prefix or entering installation.
Both variants use that same target and Windows PowerShell 5.1 executable,
original `verifyWindowsStorage` and `windowsProcessCheck` (15,000 ms), and reused
`runOnce` insertion-only hash-pinned instrumentation. No cmdlet replacement,
module preload or ACL script change outside the existing marked insertions.

A has no PSModulePath. B differs only by PSModulePath set to
`SystemRoot\\System32\\WindowsPowerShell\\v1.0\\Modules`. Before B, filesystem-only
checks require this directory to exist and its resolved location to be inside
resolved SystemRoot. No host PSModulePath, ProgramFiles, secrets or arbitrary
host environment is passed to either child. No third/warmup/retry invocation.

## Evidence and interpretation

The always-uploaded artifact is `evidence.json`, bounded to fixed metadata,
SHA, statuses, invocation counts, selected failure codes, recognized phase
markers and elapsed milliseconds. No raw paths, environments, SIDs, accounts,
commands, streams or errors are emitted. Snapshots precede each attempt and
follow each result; B precondition failure preserves A. Counts represent actual
original-helper delegations, not merely entering the instrumentation adapter.
Unknown script/programmer/precondition failures stop rather than authorize B;
a recognized timeout or unsafe rejection allows B after failed A.

`COMPARE_COMPLETE` means both comparisons ran, not that either passed. Any
failed/partial result exits nonzero. Both successful predicates mean
`NOT_REPRODUCED`, not a timeout fix. Different A/B results show association,
not root cause. Fixed A-then-B ordering and filesystem/module/cache warming
are confounders; there is deliberately no extra control invocation.

The reused helper discards successful stderr: successful phase markers are
unavailable. Failure stderr is already truncated to 1024 characters; only
complete recognized lines survive privacy projection. Missing later markers
are not proof that a clause never ran. Unknown results never establish ACL
safety. Prior probe failures and missing full-install proof remain unchanged.

## Local checks (inert only)

`node --test .github/scripts/windows-storage-module-ab.test.mjs` uses pure
admission, fake adapters, reused privacy projection and actual local refusal;
it never runs the positive entry or invokes PowerShell/storage/product runtime.
Existing helpers and workflows are untouched: old/new runtime differential is
N/A for this independent new command. Independent source verification, native
assessment, commit, publication and the single hosted execution belong to the
parent. The S8 runtime grant remains unused until parent publication.
