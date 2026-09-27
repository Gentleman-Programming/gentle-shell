# ODD phase prompt reliability

## Objective and problem
The primary Gentle Shell prompt must show the explicitly reported ODD phase, rather than the generic `working…` fallback, and phase reporting must not add a noisy transcript card. Independent Pi extension loaders currently duplicate the module-local registry; the phase tool also displays an internal success result.

## Why and authorized scope
The user reported both behaviors, authorized their correction, and selected one pull request for both. Authorized delivery target: `Gentleman-Programming/gentle-shell`, base `main`, using the current `gh` session. Reference the approved, closed feature issue with `Refs #1438` (nonclosing). No unrelated cleanup, remote environment access, or release.

## Constraints and acceptance
- Preserve per-session phases, primary/child process isolation, immediate redraw, and fallback when no phase exists.
- Suppress only the routine successful phase-report transcript UI; errors must remain visible or recoverable. The prompt label itself stays visible.
- Deterministic regression tests for both behaviors; relevant checks and CI before merge.
- Changes stay in reviewable work units with tests alongside behavior; target branch `fix/odd-phase-loader-registry` was based on freshly fetched `main` at `842301779`.

## Checklist
- [x] T1 — Share the explicit ODD phase registry across independent extension loaders and test the real reporter-to-prompt path. Route: delegated direct writer (multiple non-trivial files and preparatory reading). RED generic `working…`, GREEN `authorizing…`; isolated-HOME focused suite 230/230 on current base. TypeScript baseline and T1 both report the same 188 errors (0 added, 0 removed). Native workspace review `review-788c4fb73633ac1d` approved and acknowledged for the pre-commit candidate. Work-unit commit: `87993a9a94f984f653f26f8bda740ff1fd13946d`. Committed assessment: medium, `under_budget`; pending review slice remains anchored at `842301779`.
- [x] T2 — Hide routine successful `gentle_odd_phase` tool UI while retaining state updates and visible failures; add rendering/behavior tests. Route: delegated direct writer (preparation and multi-file behavior/test). RED caught a missing self-render and then a runtime error-context mismatch; GREEN 69/69 isolated-HOME focused tests after correction, including invalid phase and no-session errors. Local direct TypeScript still reports the same 188 baseline diagnostics, none in changed files. Work-unit commit: `58b5371577c25fa19a46a4d98e75c83fb626e3f8`. Committed range assessment from `842301779`: medium, `under_budget` (192 authored changed lines), pending review slice.
- [x] T3 — Prepare issue-linked PR with exactly one `type:bug` label, verify target CI, then merge under the user's explicit authorization. Route: inline delivery operations and bounded verification worker. PR [#1450](https://github.com/Gentleman-Programming/gentle-shell/pull/1450) references the approved, closed issue `Refs #1438` without closing it. Full isolated-HOME local suite: 3,514 passed, 34 skipped, 0 failed; runtime-module check passed. All five GitHub Actions jobs and CodeRabbit completed successfully before merge. Merge commit: `6338115ff88a1153bab1b7d38a387255497e8dd9` (2026-09-25T21:10:05Z).

## Delivery and checks
Strategy: `ask-on-risk`; forecast roughly 180 authored changed lines excluding generated files, below the ~400-line review workload advisory. Work-unit commit boundaries: T1 and T2. Run isolated-HOME focused tests (the default HOME has a known unrelated Vim INSERT test contamination), relevant typecheck and required CI. The direct local TypeScript binary reports the same 188 errors on archived `main` and the T1 checkout; repository-wide typechecking still fails, with no new diagnostics from T1. No source-mutating formatting after review freeze. For each commit under RDD, assess against previous reviewed boundary and follow native due transitions; previous workspace review covered T1's exact bytes but not the later committed range.

## Progress and next step
T1 and T2 committed; T3 merged as PR #1450 with green CI. The cumulative committed range was medium and `under_budget`, so no additional native committed-range review was due. Skipped checks: 34 platform/conditional tests; interactive post-install terminal smoke test pending for the next released/reloaded version. Repository-wide TypeScript check still has the same 188 baseline errors. This final task-record update is local after merge and not included in PR #1450. Mirror topic: `odd/odd-phase-prompt-reliability/tasks`.
