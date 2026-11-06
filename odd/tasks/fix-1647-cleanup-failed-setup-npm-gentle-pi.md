# Fix #1647: run post-install cleanup on setup failure to prevent declared npm:gentle-pi residue

## Objective

Ensure that when `gentle-shell setup` or automatic first-run provisioning fails (or times out), any conflicting packages written to `settings.json` during the install (specifically `npm:gentle-pi` and `@juicesharp/rpiv-ask-user-question`) are cleaned up via `runPostInstallCleanup`. This prevents a failed setup from leaving the home declaring `npm:gentle-pi`, which causes subsequent launches to silently run the published npm package instead of the local checkout.

## Problem

When `gentle-ai install --agent pi --scope global` executes during `runSetupFlow` in `bin/gentle-shell.mjs`, it mutates `settings.json` to declare `npm:gentle-pi`. If the install pipeline fails or times out before exiting 0, `runSetupFlow` returns early (`if (!installResult.ok) return installResult;`) without calling `runPostInstallCleanup`.

Because `runPostInstallCleanup` is skipped on failure, `npm:gentle-pi` remains declared in `settings.json`. On subsequent launches (or when continuing after the first-run warning), `findGentlePiDeclaration` sees `kind: "npm"`, `decideTakeOver` returns `false`, and `buildPiInvocation` omits `-e <packageRoot>`. As a result, Pi executes the published npm `gentle-pi` package installed in the home instead of the local source checkout of `gentle-shell`.

## Root Cause

`runSetupFlow` in `bin/gentle-shell.mjs` only calls `runPostInstallCleanup` on the happy path (`installResult.ok === true`). When `installResult` is not ok (or timed out), it returns immediately without running cleanup on `settings.json`.

## Scope

- In `bin/gentle-shell.mjs`, ensure `runPostInstallCleanup` runs when `!dryRun && !installResult.interrupted` even if `!installResult.ok` or `installResult.timedOut`, cleaning up `npm:gentle-pi` and rpiv from `settings.json` while preserving the failure status and message of `installResult`.
- In `tests/gentle-shell-bin.test.ts`, add unit tests covering:
  - Setup exit failure cleans declared `npm:gentle-pi` from `settings.json` and preserves the non-zero exit code.
  - Automatic provisioning failure cleans declared `npm:gentle-pi` from `settings.json`, allowing the continuation to inject the local package root.
- Verification across full test suite and typechecks.

## Tasks

- [x] T1 Reproduce #1647 with failing unit tests in `tests/gentle-shell-bin.test.ts` (RED).
- [x] T2 Implement post-install cleanup on setup failure in `bin/gentle-shell.mjs` (GREEN).
- [x] T3 Verify full test suite, runtime module checks, and typechecks.
- [x] T4 Commit work unit and document verification evidence (commit `be1ba218`).

## Verification Evidence

- **RED observed**:
  - `gentle-shell setup removes npm:gentle-pi that gentle-ai declared even when gentle-ai exits non-zero`: failed with `AssertionError: The input did not match the regular expression /gentle-shell: removing npm:gentle-pi from .../` (exit 3).
  - `a failing auto-provision flow removes declared npm:gentle-pi and injects the local package on continuation`: failed because `removing npm:gentle-pi` never ran and settings kept `npm:gentle-pi@3.5.1`.
- **GREEN observed**:
  - Both reproduction tests pass after the fix.
  - `node --experimental-strip-types --test tests/gentle-shell-bin.test.ts`: 130 passed, 0 failed.
  - `pnpm test`: 4,538 passed, 0 failed, 34 skipped (all three stages PASS: `unit-tests`, `provider-contract`, `runtime-harness`).
  - `pnpm run check:runtime-modules`: clean (8 generated modules).
  - `pnpm run typecheck`: clean (187 recorded baseline diagnostics, 0 regressions).


## Acceptance Criteria

- A failed or timed-out setup run that declared `npm:gentle-pi` cleans it from `settings.json`.
- The setup failure exit code and diagnostic messages remain intact and propagated to the caller.
- On subsequent launches after a failed setup, `gentle-shell` injects its local package root (`-e <packageRoot>`) rather than deferring to a stale npm declaration.
- All existing tests in `tests/gentle-shell-bin.test.ts` continue to pass.
