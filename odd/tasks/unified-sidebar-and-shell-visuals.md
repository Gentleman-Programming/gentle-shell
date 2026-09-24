# Unified Sidebar and Shell Visuals

## Objective
Restore the previously implemented Gentle prompt/thinking presentation and reshape the fullscreen sidebar into one compact, unified status panel inspired by the supplied reference's information architecture (not its colors).

## Problem
- The live input is currently falling back to a different full-width editor frame instead of the previously delivered Gentle prompt treatment; thinking presentation appears inconsistent with that prior visual.
- The fullscreen sidebar splits Status and Changes into separate cards, while the requested reference groups Project, Changes, Usage, and Integrations into one scan-friendly panel.

## Why
The shell should preserve its established visual identity while presenting high-value session state as one coherent dashboard rather than a stack of disconnected cards.

## Scope
- Diagnose and restore reliable installation/ownership of the Gentle prompt presentation.
- Preserve the established transparent Gentle surfaces and current theme semantics.
- Unify sidebar Project, Changes, Usage, and Integrations into one framed panel.
- Keep Agents and TODO as independent sections below the unified panel.
- Add or update deterministic rendering and integration tests.

## Constraints
- Do not copy colors from the reference image.
- Preserve unrelated uncommitted changes in `lib/shell-card.ts` and `tests/shell-card.test.ts`; integrate rather than overwrite them.
- Keep writes single-threaded.
- No commit, push, PR, or release.
- TDD mode: strict, from `sdd-init/gentle-pi`; runner: `pnpm test`.
- The ~400 changed-line guideline is advisory; keep the implementation coherent and reviewable.

## Authorized edit surfaces
- `odd/tasks/unified-sidebar-and-shell-visuals.md`
- `lib/shell-bar.ts`
- `lib/shell-sidebar.ts`
- `lib/shell-sidebar-layout.ts`
- `lib/shell-prompt.ts`
- `lib/shell-changes.ts`
- `extensions/gentle-shell.ts`
- `tests/shell-bar.test.ts`
- `tests/shell-sidebar.test.ts`
- `tests/shell-sidebar-layout.test.ts`
- `tests/shell-prompt.test.ts`
- `tests/gentle-shell.test.ts`
- Existing user-modified `lib/shell-card.ts` and `tests/shell-card.test.ts` only if required to preserve the already-started visual change.

## Tasks
- [x] **UV-1 — Reproduce prompt ownership regression with a failing test**
  - Identify why `installPrompt` leaves the default/other editor active.
  - Add evidence that the Gentle editor is installed when safe and does not trample a genuinely custom owner.
- [x] **UV-2 — Restore Gentle prompt and thinking continuity**
  - Implement the smallest ownership fix that restores the prior Gentle prompt visual.
  - Preserve transparent surfaces, theme roles, and queued/working state behavior.
- [x] **UV-3 — Unify sidebar dashboard**
  - Render Project, Changes, Usage, and Integrations inside one `Status` frame.
  - Keep compact alignment, wrapping, width safety, and live digest invalidation.
  - Avoid rendering the old standalone Changes card in fullscreen while retaining its regular-mode widget and interactive behavior.
- [x] **UV-4 — Verify delegated scope**
  - Focused tests for prompt, shell bar, sidebar layout, and shell integration.
  - `pnpm test` — pending parent-owned full-suite verification; not run by this writer.
  - `pnpm run typecheck`.
  - `git diff --check`.
  - Structural readback against the requested hierarchy.

## Acceptance criteria
- The Gentle prompt is installed reliably in the supported Pi host and renders the established petal/state frame instead of the fallback shown in the supplied screenshot.
- Thinking/working presentation remains visually continuous with the restored shell treatment without reintroducing passive backgrounds.
- Fullscreen sidebar order is branding → unified Status panel → Agents → TODO.
- The unified panel contains Project, Changes, Usage, and Integrations, with no duplicate standalone Changes card in fullscreen.
- Regular mode and `/gentle:changes` behavior remain available.
- All applicable checks pass; any skipped or environmental failures are recorded here.

## Progress
- 2026-09-09: Scope confirmed by the user: unified panel; restore the prior input/thinking visual rather than inventing a new one.

## Verification evidence
- UV-1 RED: `node --experimental-strip-types --test tests/gentle-shell.test.ts` — 37 passed, 2 failed as intended: a retained Gentle factory is skipped on reload; native working feedback is hidden even when another custom editor owns input.
- Pi 0.85.1's getter returns the configured custom factory, not the default editor. A truthy value alone cannot establish third-party ownership. This reproduces an ownership failure, but does not prove the screenshot's exact runtime owner.

- UV-2 RED: the same focused command then failed only the new continuity assertion: `agent_end` cleared queued state before settlement (38 passed, 1 failed).
- UV-1/UV-2 GREEN: `node --experimental-strip-types --test tests/gentle-shell.test.ts` — 39 passed. Stable factory ownership permits safe reload replacement; custom editors retain native feedback; shutdown releases owned UI and timers. `agent_settled` ends the working frame, not low-level `agent_end`. Native thinking transcript rendering remains Pi-owned.

## Accepted continuation
- User approved adding `extensions/pi-pretty.ts` and new `tests/pi-pretty.test.ts` to the authorized edit surfaces.
- Reopen UV-2: coordinate bundled adapter editor ownership and derive compact working/Thinking animation from startup-banner timing and color progression. Preserve unknown editor owners, transparency, width safety, and timer cleanup/unref with no idle timer.
- Startup banner remains read-only; shared pure animation belongs in an authorized file.
- UV-3 RED: focused bar/layout tests failed 3 assertions; GREEN: 34 passed. Combined prior focused checks passed 88 tests, including pointer/scroll and same-count digest coverage.
- Prior typecheck timed out after dependency reconciliation; no result obtained. Diff check found trailing whitespace in shell-bar.ts.

## Continuation evidence
- Adapter/animation RED: `node --experimental-strip-types --test tests/shell-prompt.test.ts tests/pi-pretty.test.ts` — 12 passed, 2 intended failures after adding the injection seam: bundled editor replaced host ownership and pulse progression differed. Initial test harness lacked the seam and failed before assertions; not counted as behavior RED.
- Cadence RED: focused prompt/adapter/shell tests failed the timer assertion (160ms rather than 100ms); old palette expectations also needed updating to the accepted pulse.
- GREEN: `node --experimental-strip-types --test tests/shell-prompt.test.ts tests/shell-bar.test.ts tests/shell-sidebar.test.ts tests/shell-sidebar-layout.test.ts tests/gentle-shell.test.ts tests/pi-pretty.test.ts` — 92 passed.
- UV-2: bundled dependency receives a scoped UI proxy preventing editor replacement/restoration and loader overrides. The adapter configures Pi's supported streaming working row as Thinking… with the same foreground animation used by the prompt. Native thinking transcript blocks remain untouched. Prompt timer is unref'd and released on settlement/disposal; adapter creates no timer.
- UV-3: one Status frame contains Project, Changes, Usage and Integrations; Agents/TODO remain separate. Regular Changes and overlay tests, narrow wrapping, pointer routing and independent scrolling pass. Existing shell-card edits remain untouched.
- Current installed pi-pretty 0.6.14 differs from the previously inspected dependency source after the prior dependency reconciliation: it has no prompt/working customization. Adapter coverage uses an injected competing bundled implementation to protect both shapes without changing dependencies.

## Final delegated verification
- Focused six-file test command: 92 passed, zero failures.
- `pnpm run typecheck`: passed (197 baseline diagnostics, no regressions; two file/code pairs improved). No dependency metadata or generated-file changes observed in git status during this continuation.
- `git diff --check`: passed; trailing whitespace corrected.
- Structural readback: shared pure pulse in shell-prompt.ts; adapter-only bundled ownership interception; one fullscreen Status frame followed by Agents/TODO; startup-banner.ts and user-owned shell-card changes untouched.
- Full `pnpm test` and live terminal/screenshot confirmation remain pending with the parent. No native transcript renderer replacement is claimed.

## Accepted visual correction
- Live inspection rejected the flower-based Thinking animation. Preserve both existing placements and the prompt frame; animate the letters of `working…` and `Thinking…` with a left-to-right reflected-light scanner, not a Thinking glyph.
- Share the same cadence and per-character tip/falloff progression, with transparent theme-role painting. Preserve idle behavior, capitalization, ellipsis, width and lifecycle. Startup banner stays read-only.
- Reopen UV-2/UV-4 for strict-TDD scanner correction and the four explicitly authorized validation commands.

## Scanner correction evidence
- RED: `node --experimental-strip-types --test tests/shell-prompt.test.ts tests/gentle-shell.test.ts tests/pi-pretty.test.ts` — 52 passed, 2 failed as intended: Thinking still used a separate flower/message and working text was not scanned.
- GREEN: the same focused command — 55 passed. Six-file shell command — 93 passed.
- Triangulation: scanner frames preserve words and ellipses; a symmetric soft/accent wave surrounds one bright moving tip, enters before the word, exits after it, and wraps; prompt widths 1/8/20/40, transparent states, idle behavior and lifecycle cleanup remain covered.
- `pnpm run typecheck`: passed, 197 baseline diagnostics, no regressions.
- Final direct correction: both placements use shared foreground-only `scanWorkingText` at Pi's original loader cadence of 80ms. Thinking frames contain only the word, never a flower. Pi's existing loader frame slot paints the entire animated word with an empty separate message; row visibility/location and native loader lifecycle remain unchanged. Prompt working petal rests while the word reflects the moving highlight; idle/queued behavior is unchanged.
- No changes to startup-banner.ts or unrelated pre-existing work.

## Final direct refinement
- User selected hiding the redundant live `Thinking…` row above the editor. `working…` remains the single live state in the prompt; repeated `Thinking… Nms` transcript blocks remain untouched as historical reasoning markers.
- The rotating flower remains in the input's `working…` header. The reflected-light wave crosses only the word at Pi's original 80ms loader cadence.
- Focused prompt/shell/adapter suite: 55 passed, 0 failed.
- `pnpm run typecheck`: passed with 197 recorded baseline diagnostics, no regressions, and two improved file/code pairs.
- `git diff --check`: passed.
- Provider contract check and runtime harness: passed.
- Full `pnpm test` on the latest `origin/main`: 2617 passed, 38 skipped, 2 failed outside this feature's changed paths:
  - `tests/sdd-managed-runtime-settlement.test.ts`: native remediation scope mismatch.
  - `tests/windows-hidden-processes.test.ts`: macOS `/private/var` versus `/var` temporary-path alias mismatch in expected CodeGraph argv.
  The full suite therefore did not pass locally; PR CI remains required before merge.

## Delivery preparation
- Rebased the work onto the latest `origin/main` as `feat/1109-unified-shell-status` and reconciled the newer safe dynamic `pi-pretty` loader.
- Created approved issue #1109: `feat(ui): unify sidebar status and shell working feedback`.
- Focused six-file suite on the rebased candidate: 93 passed. Typecheck and diff check passed.
- Full suite repeated the same two unrelated failures documented above; required remote CI remains the merge gate. CodeRabbit is explicitly not a wait condition per user direction.

## Next step
Run native review for the rebased candidate, commit, open PR #1109 linkage, and merge only after required remote checks pass.
