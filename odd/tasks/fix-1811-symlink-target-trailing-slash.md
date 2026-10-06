# Fix #1811: assertSafeSymlinkTarget Rejects Trailing Slash

## Objective
Normalize symlink targets with a single trailing slash in `assertSafeSymlinkTarget` (`lib/review-candidate-view.ts`) so benign directory-pointing symlinks with trailing slashes do not fail native review before START with `candidate view symlink target is unsafe`.

## Specs
- S1: `assertSafeSymlinkTarget` must normalize targets ending with a single trailing slash before empty-segment checking, accepting standard POSIX directory symlink targets such as `../../.opencode/skills/issue-session/`.
- S2: Lexical safety guards must still reject unsafe targets, including root escapes (`../escape/`), empty targets (`""`), absolute paths (`/`), Windows drives (`C:/`), metadata paths (`.git/`), control characters, backslashes, empty segments (`//`), and `.` segments (`./`).
- S3: `tests/review-candidate-view.test.ts` must verify that trailing-slash symlink targets within the root materialize and pass verification, while invalid trailing-slash variants fail closed.

## Tasks
- [x] T1: Normalize trailing slash before empty-segment validation in `lib/review-candidate-view.ts`
- [x] T2: Add unit tests for valid trailing-slash symlinks and invalid trailing-slash escapes/empty segments in `tests/review-candidate-view.test.ts`
- [x] T3: Verify unit tests and typechecks with zero regressions

## Log
- L1: Issue #1811 reported by @ekoleszar: `assertSafeSymlinkTarget rejects a trailing slash, failing every base-diff review in repos with committed symlinks`.
- L2: Implemented single trailing slash normalization on `target` before splitting for empty segments, preserving root escape and metadata containment checks. Added regression unit test cases.
