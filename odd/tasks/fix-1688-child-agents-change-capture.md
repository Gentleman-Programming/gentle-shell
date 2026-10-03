# Capture isolated child agent write/edit changes in /gentle:changes (#1688)

## Objective and scope
Enable native `write` and `edit` operations performed by isolated child workers to emit verified `gentleSessionChange` evidence and populate the parent's `/gentle:changes` view.
Because isolated subagents do not load `gentle-shell.ts`, they lack the change capture hook installed in the parent.
1. Create `extensions/child-capture.ts` (inert in parent, active in children with `GENTLE_PI_AGENTS_CHILD === "1"`).
2. Include `./child-capture.ts` in `childContextExtensionPaths()` in `extensions/gentle-agents.ts`.
3. Verify with unit and integration tests that child write/edit mutations emit `gentleSessionChange` evidence and reach parent session change records.

## Completed tasks
- [x] T1: Strict TDD test in `tests/gentle-agents.test.ts` reproducing missing child capture extension in `childContextExtensionPaths`.
- [x] T2: Create `extensions/child-capture.ts` installing `installSessionChangeCapture` for children.
- [x] T3: Add `./child-capture.ts` to `childContextExtensionPaths()` in `extensions/gentle-agents.ts`.
- [x] T4: Verify full test suite, typecheck, and package file integrity.

## Evidence
Base: upstream/main at cf3012f7. Branch: fix/1688-child-agents-change-capture.
- TDD RED: test failed against base `main` with missing `/extensions/child-capture.ts` in `childContextExtensionPaths()`.
- TDD GREEN: 190/190 passed in `tests/gentle-agents.test.ts`.
- Child capture suite: 2/2 passed in `tests/child-capture.test.ts`.
- Session change capture suite: 6/6 passed in `tests/session-change-capture.test.ts`.
- Package manifest suite: 56/56 passed in `tests/package-manifest.test.ts`.
- Typecheck: 186 recorded baseline diagnostics, 0 regressions, 12 improved.
- Package file check: 155 files, 69 exact byte-pinned contract artifacts verified.
