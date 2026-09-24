# Feature: Portable canonical temporary-path tests

## Objective

Make the full test suite portable across macOS systems where `os.tmpdir()` returns `/var/...` while filesystem canonicalization resolves the same path as `/private/var/...`.

## Problem

Two tests build temporary repository/workspace paths from `mkdtempSync(tmpdir())` and later compare those lexical paths against production code that intentionally canonicalizes security-sensitive roots:

1. `tests/sdd-managed-runtime-settlement.test.ts` fails `confirmRemediationScope` because its fixture `cwd` is not canonical.
2. `tests/windows-hidden-processes.test.ts` expects the noncanonical fixture path in CodeGraph argv while the public adapter correctly passes the canonical repository root.

These are fixture defects. Weakening production canonical-path checks would reduce remediation and repository-boundary safety.

## Scope

- `tests/sdd-managed-runtime-settlement.test.ts`
- `tests/windows-hidden-processes.test.ts`
- This tracking document

## Non-goals

- No production-path normalization changes.
- No relaxation of remediation canonical-scope validation.
- No changes to CodeGraph command routing or `windowsHide` behavior.

## TDD mode

- Mode: standard verification (no explicit project/session TDD configuration was available).
- Existing RED evidence: both tests failed in the full suite on macOS due to `/var` versus `/private/var` identity.

## Tasks

- [x] P1: Canonicalize the remediation fixture root immediately after creation and rerun its focused test.
- [x] P2: Canonicalize the windows-hidden fixture root immediately after creation and rerun its focused test.
- [x] P3: Run combined focused tests, typecheck, runtime harness, provider contract, full suite, and `git diff --check`.

## Acceptance criteria

- Both formerly failing tests pass on the current macOS host.
- Security-sensitive production checks remain unchanged.
- Full suite has no non-skipped failures.
- Existing unrelated worktree changes remain untouched.

## Authorized scope

User authorized fixing both reported failures. Writes are limited to the two fixture files and this task document.

## Progress

- RED observed from `pnpm test`: remediation fixture rejected noncanonical `cwd`; CodeGraph argv differed only by `/var` versus `/private/var`.
- CodeGraph confirmed production canonicalization is deliberate at `confirmRemediationScope` and the public CodeGraph root path.
- P1 complete: remediation fixture now wraps `mkdtempSync(...)` with `realpathSync(...)`; focused test passes 8/8.
- P2 complete: windows-hidden fixture uses the same canonical construction; focused test passes 2/2 and all twelve public routes still assert `windowsHide: true`.

## Verification evidence

- Combined focused tests: 10/10 pass.
- `git diff --check`: passed.
- `pnpm run typecheck`: no regressions (197 recorded baseline diagnostics; 2 file/code pairs improved).
- `pnpm run check:provider-contract`: passed (contract 1.2.0).
- `pnpm run test:harness`: passed.
- `pnpm test`: 2,660 total; 2,622 pass; 0 fail; 38 skipped. Provider contract and runtime harness also passed in the composed script.

## Next step

No implementation work remains. Native review remains deferred because this sibling worktree contains a mixed uncommitted candidate from multiple authorized features.
