# Feature: animation-modes

Issue context: https://github.com/Gentleman-Programming/gentle-shell/issues/1142
Branch: `feat/animation-modes` from `origin/main` at `c7fd2e26`.

## Objective

Add one global Gentle-owned animation policy controlled by:

```text
/gentle:animations [status|quality|performance|potato]
```

No argument reports status. The persisted default is `quality`.

- `quality`: exact current animation behavior.
- `performance`: materially lower repaint cadence while retaining animation.
- `potato`: no Gentle-owned periodic visual animation timers; semantic state changes and static UI remain visible immediately.

## Problem / Why

An external reporter demonstrated that Gentle Shell's 80 ms working pulse repeatedly requests full TUI renders while a parent turn waits, causing severe CPU and remote-terminal scroll degradation with large transcripts. Regular TUI mode reduced CPU substantially but only a local cadence-slowing patch resolved the remaining slowdown. The same risk class applies to the startup banner's 25 ms animation loop.

## Product decisions

- Scope includes all Gentle-owned visual animations, currently the startup banner and working prompt.
- Pi core loaders/animations remain untouched.
- Policy is persisted globally in Gentle Pi's config home; no environment override.
- No-argument command behavior is status, not toggle/cycle.
- Prompt policy changes apply immediately to the live prompt.
- A startup banner already running when the command changes is allowed to finish under its original policy; the selected mode applies to future startup banners.
- Operational polling, TTLs, retries, debounces, transport timeouts, and data-refresh timers are not animations and remain unchanged.
- The separate install/update behavior that writes `tuiMode: fullscreen` is out of scope.

## Policy and cadence

Persist strict JSON:

```json
{"schema":"gentle-pi.animations/v1","policy":"quality"}
```

Malformed/nonconforming input fails closed to `quality` with an attributable status reason.

| Surface | quality | performance | potato |
|---|---|---|---|
| Working prompt | Current 80 ms pulse and current frames | 1000 ms pulse | Static working/queued/idle frame, no interval |
| Startup banner | Current 25 ms cadence and exact behavior | 250 ms paint cadence with logical tick step 10, preserving approximately the current animation duration | Immediately render the completed static artwork, no animation interval |

## Authorized scope

Expected source/test/doc surfaces:

- `lib/animation-policy.ts` (new)
- `extensions/gentle-shell.ts`
- `extensions/startup-banner.ts`
- `lib/command-palette-catalog.ts`
- `tests/animation-policy.test.ts` (new)
- `tests/gentle-shell.test.ts`
- `tests/shell-prompt.test.ts`
- `tests/startup-banner.test.ts`
- `tests/command-palette.test.ts`
- `docs/readme-reference.md`

Do not edit install-time TUI mode files, Pi dependencies, sidebar/header/agents/TODO/changes implementations, or operational timer modules.

## TDD and checks

- Strict TDD: tests exist, so each behavioral task records RED before production changes, then GREEN and refactor.
- Focused runner: `node --experimental-strip-types --test tests/<file>.test.ts`
- Final checks: `node scripts/check-types.mjs` (parent-authorized lifecycle-free replacement for `pnpm run typecheck`), `pnpm test`, and `git diff --check`.

## Tasks

- [x] **T1 — Global animation policy.** Add strict decoding, resolution, status attribution, atomic global writer, defaults, and malformed-file fallback in `lib/animation-policy.ts`, with RED/GREEN coverage in `tests/animation-policy.test.ts`.
- [x] **T2 — Command and live prompt policy.** Register `/gentle:animations status|quality|performance|potato`; no args reports status; writes update the live prompt immediately. Quality remains 80 ms, performance uses 1000 ms, and potato creates no pulse interval while state transitions still request immediate renders. Cover command, persistence, timer counts, mode switching, lifecycle cleanup, and existing prompt visuals.
- [x] **T3 — Startup banner policy.** Resolve policy at banner creation. Quality remains byte-for-byte behaviorally equivalent; performance paints every 250 ms while advancing logical animation time by 10 ticks; potato renders completed static artwork without creating a periodic animation timer. A running banner retains its creation-time policy until it finishes. Cover duration, final artwork, cleanup, and no-timer guarantees.
- [x] **T4 — Discovery and documentation.** Add the Configuration palette entry and document command syntax, persistence, exact mode semantics, default/fallback behavior, live-prompt application, and next-startup banner application. Run focused and full regression checks.

## Acceptance criteria

- Existing users who do nothing receive exact `quality` behavior.
- `performance` reduces working-prompt periodic render requests from ~12.5/s to 1/s and startup-banner animation paints from 40/s to 4/s.
- `potato` starts no Gentle-owned periodic visual animation interval for either surface.
- Starting and settling request immediate Gentle renders in every mode. Queued state appears on the next Pi-owned host render without an animation tick; enqueue repaint scheduling belongs to Pi, not Gentle Shell.
- Potato still presents a recognizable static prompt state and completed static startup artwork.
- Changing policy updates the live prompt without restarting Pi.
- An already-running startup banner finishes under its original policy; the next startup uses the persisted selection.
- Malformed policy data resolves to `quality` with a visible attributable reason and is never silently rewritten.
- No operational timers, Pi core animations, or `tuiMode` installation behavior change.
- Focused tests, typecheck, full suite, and diff check pass.

## Routing / review workload

- Route: delegated direct writer; trigger evidence is 4+ implementation files and 2+ non-trivial source files.
- Single writer only; no parallel writes.
- Forecast: approximately 450–650 authored changed lines, mostly tests. Delivery strategy remains `ask-on-risk`; push/PR/merge are not authorized by this task.

## Progress / Evidence

- Exploration identified exactly two Gentle-owned periodic visual animations: startup banner and working prompt. Hover expiry, sidebar reattachment, presence refresh, changes polling, retries, debounces, and transport timers are operational and excluded.
- Pi Pretty comparison found no safer animation mechanism: its default shimmer requests renders at ~30 fps through Pi's Loader or an explicit widget fallback. Its small/recent issue surface is not negative performance evidence. Related oh-my-pi reports #6145 and #7268 confirm the broader animated-TUI CPU risk class.

### T1 evidence

- RED: `node --experimental-strip-types --test tests/animation-policy.test.ts` failed with `ERR_MODULE_NOT_FOUND` before implementation.
- GREEN: same command passed 2/2 tests after implementation.
- Triangulation: all modes, strict invalid shapes, missing-file default, repeated atomic replacement, malformed-file attribution and preservation covered.
- Temporary fixtures: explicitly authorized for validation only; repository edit surfaces unchanged.

### T2 / validation interruption

- Added a command/live-pulse regression test; production T2 code has not changed.
- `node --experimental-strip-types --test tests/gentle-shell.test.ts` could not load `@earendil-works/pi-coding-agent`. This is an environmental failure, not valid behavioral RED evidence.
- `pnpm run typecheck` unexpectedly auto-installed 195 packages and ran lifecycle scripts before checking types. Its postinstall reported installing `.gentle-ai/v3.4.0/gentle-ai`. These side effects exceeded the expected validation-only scope; no cleanup or further package commands were attempted.
- Typecheck itself passed: 196 recorded diagnostics, no regressions, 3 improved file/code pairs.
- `node --experimental-strip-types --test tests/animation-policy.test.ts` passed again (2/2) after a test callback typing cleanup.
- `git diff --check` passed. `git status --short` showed only the allowed source/test/task surfaces; generated dependency/tool artifacts are not represented by that output.
- `pnpm test` not run following the unexpected bootstrap side effects. T2–T4 remain incomplete.

### Resumed T2 evidence

- Parent diagnosed bootstrap: preserve ignored local artifacts; no reinstall, relink, postinstall, or cleanup. Dependencies complete; use direct typecheck script.
- RED: `node --experimental-strip-types --test tests/gentle-shell.test.ts` failed 1/92 at `assert.ok(command)` because animations command was absent.
- GREEN: same command passed 92/92 after command and live-pulse implementation.
- TRIANGULATE/REFACTOR: `node --experimental-strip-types --test tests/gentle-shell.test.ts tests/shell-prompt.test.ts` passed 109/109, including persisted potato, immediate start/settle renders, queued static frame, malformed status, write failure, timer switching and cleanup. Pulse setup extracted without changing quality frames/cadence.

### T3 evidence

- RED: `node --experimental-strip-types --test tests/startup-banner.test.ts` failed 1/8 because potato started an interval.
- GREEN: same command passed 8/8 after policy capture, 250ms/10-tick performance cadence, and completed static potato implementation.
- TRIANGULATE/REFACTOR: test drives real header factories and timers, compares completed artwork across modes, checks duration within 250ms and approximately tenfold fewer paints, changes persisted policy during animation, and checks disposal. Existing artwork tests needed isolated cold modules because the duration test completes module-global stroke warmup; two intermediate test-isolation failures were corrected without production behavior changes.
- Operational stats and resize timers remain unchanged.

### T4 and final verification

- Palette entry and technical reference implemented.
- RED: `node --experimental-strip-types --test tests/command-palette.test.ts` failed 1/33: no Configuration entry for `gentle:animations`.
- GREEN: same command passed 33/33 after catalog entry and expected catalog order update. Documentation-only text has no meaningful behavioral RED requirement.
- Final focused command: `node --experimental-strip-types --test tests/animation-policy.test.ts tests/gentle-shell.test.ts tests/shell-prompt.test.ts tests/startup-banner.test.ts tests/command-palette.test.ts` passed 152/152, with no skips.
- `node scripts/check-types.mjs` passed twice: 196 recorded diagnostics, no regressions, 3 improved file/code pairs. This is the repository's diagnostic ratchet, not a zero-diagnostic compiler pass.
- `pnpm test` completed the unit and provider phases successfully: 2886 total, 2848 passed, 38 platform skips, 0 failed; provider contract mirror check passed. Its runtime harness then failed at `tests/runtime-harness.mjs:537`: `the real primary hook must stop a second distinct direct file` (actual undefined, expected true).
- Independent diagnosis proved the harness inherited `GENTLE_PI_AGENTS_CHILD=1`, causing `extensions/gentle-ai.ts` to classify the mocked primary session as a child and bypass the direct-file guard. The candidate does not modify `tests/runtime-harness.mjs`, `extensions/gentle-ai.ts`, `lib/odd-runtime-delegation-gate.ts`, or `lib/session-worktree-registry.ts`.
- Corrected primary-environment spot check: `env -u GENTLE_PI_AGENTS_CHILD node --experimental-strip-types tests/runtime-harness.mjs` passed with exit 0 and no output. This closes the environmental harness blocker without changing repository code.
- `git diff --check` passed. Working-tree inspection showed only the authorized source/test/doc/task files changed. Ignored local artifacts retained as instructed.
- Final refactor moved the existing double-Esc comment back beside its command and removed a redundant tick reset; the 152-test focused run and direct typecheck above were after that refactor.

### Independent verification corrections

- Both cadence-specific tests now use isolated persisted `quality` fixtures: startup banner scopes and restores `GENTLE_PI_CONFIG_HOME`; the prompt passes its temporary config home explicitly. Neither cadence assertion depends on the user's saved mode.
- The potato test now distinguishes ownership: changing the fake pending flag requests no Gentle render; an explicitly simulated host render request immediately exposes the queued frame without an interval. Start/settle assertions still prove Gentle-owned immediate render requests. The fake harness has no real Pi enqueue path, so this does not prove real enqueue-to-paint latency. Acceptance language and technical reference now state that boundary explicitly.
- RED/GREEN exception for this correction: production behavior is unchanged; these are test-isolation and evidence-precision corrections, not a behavior fix. No new pre-implementation behavioral failure is claimed.
- `node --experimental-strip-types --test tests/animation-policy.test.ts tests/gentle-shell.test.ts tests/shell-prompt.test.ts tests/startup-banner.test.ts tests/command-palette.test.ts`: passed 152/152, no skips.
- `node scripts/check-types.mjs`: passed, 196 recorded diagnostics with no regressions and 3 improved pairs.
- `git diff --check`: passed. Full `pnpm test` intentionally not repeated, as instructed. No production source changed in this correction.

## Next step

Implementation and verification are complete. Structural readback and native review remain before any delivery decision. No commit, push, or PR was performed.