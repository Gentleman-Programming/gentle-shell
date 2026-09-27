# Deduplicate Gentle Shell assets

## Objective
Prevent duplicate prompt-template and theme registration when launching `gentle-shell` while retaining the package's extensions, skills, prompts, and themes.

## Problem and evidence
The launcher injects a package root via `-e` and also injects explicit `--theme` and `--prompt-template` paths to that same root. Pi loads package resources from `-e`; the observed startup output shows the same installed asset path twice.

## Scope and constraints
- Allowed source surfaces: `runtime/gentle-shell-launcher.mjs`, `tests/gentle-shell-launcher.test.ts`, `tests/gentle-shell-bin.test.ts`, and if the generated runtime mirror requires it, `lib/gentle-shell-launcher.ts` and `scripts/build-runtime-modules.mjs` (only inspect the latter, do not change generator without justification).
- Preserve linked-home takeover and isolated-home asset availability; do not change user settings.
- Remote destination authorized later: `Gentleman-Programming/gentle-shell` with the current `gh` session; publish and merge only after checks pass.
- TDD mode: unknown (no explicit project/session setting observed); focused regression checks still required.
- Route: delegated direct writer, because the fix plus regression test spans nontrivial source and test files, and preparation reads belong with the writer.
- Delivery strategy: ask-on-risk; initial forecast under 100 authored changed lines excluding generated files. Native review measured 205 changed lines including the generated mirror and test expectation updates.

## Tasks
- [x] T1: Confirm Pi resource discovery and adjust launcher injection to register each resource once. Acceptance: package extensions and assets are routed through `-e` once in plain and takeover launches. Checks: targeted launcher tests. Evidence: regression RED before fix, GREEN after; source/test work-unit commit `0031c0999be8eedde09d07b8cfdb861cd4d01bda`; native workspace review lineage `review-091f5150bb2602fa` approved and acknowledged.
- [x] T2: Add focused regression coverage and run launcher/bin checks, including generated-runtime consistency where applicable. Acceptance: reproduction fails before fix and passes after it; no existing launcher expectations regress. Checks: targeted tests and runtime-module check. Evidence: 303 focused tests passed; `pnpm test`: 3,371 passed, 38 skipped; typecheck exited successfully with 195 known baseline diagnostics; runtime and diff checks passed. Independent verifier repeated focused checks.

## Progress
The launcher now supplies `-e` only; Pi package discovery owns prompts, themes, skills, and extensions. Tests cover plain and takeover argument lists; bin expectations were updated. One test inherited `PI_CODING_AGENT_DIR` and was made deterministic in its own fixture. Required suite: 303 passed, 0 failed. Generated runtime and whitespace checks passed. An independent verifier repeated the focused suite and runtime check. Native review `review-091f5150bb2602fa` approved and acknowledged for the four source/test paths, with two non-blocking advisory findings. The task document was excluded as untracked from that review. The native review prerequisite `gentle-ai sync --agent pi` also updated managed files outside this repository, including `~/.gentle-shell/agent/settings.json`; no manual settings edit was made. Actual interactive shell resource discovery remains untested. Engram mirror pending: no callable Engram memory tools are available in this session. Existing canonical issue #1345 was triaged and labeled `bug` and `status:approved`; no duplicate issue was created. The source/test work unit is committed on `fix/deduplicate-shell-assets` at `0031c0999be8eedde09d07b8cfdb861cd4d01bda`, based on `origin/main` at `be2d7b1a`.

## Next step
Merged. PR #1381 was opened against `main`, its checks went green, and it was merged on 2026-09-23T20:56:28Z (merge commit `41508d197374d654c649ea51c4d0b429b06407ea`, branch head `be0041210b86492e47d3d0076c66e4a6a63c84bf`); canonical issue #1345 was closed the same minute, and that merged branch has since been deleted. The source/test work unit `0031c09` is on `main`.

The fix is merged but **unreleased**, so an install still shows the collision. As of 2026-09-26, npm `gentle-pi` latest is still `3.7.0`, published 2026-09-23T14:30Z — about 6h25m *before* `0031c09` (20:38Z). Tag `v3.7.0` is `59257bf`, `git merge-base --is-ancestor 0031c09 v3.7.0^{}` is false, and the published `runtime/gentle-shell-launcher.mjs` at `3.7.0` still contains `packageRootAssetArgs`. Nothing further needs fixing in this repository; do not re-open this work.

Remaining step: cut a release carrying `0031c09` (`v3.7.1`). Until that ships, an affected install can be mitigated config-only, without touching this repository: add the absolute package root (for example `/opt/homebrew/lib/node_modules/gentle-pi`) as a `packages` entry in the home's `settings.json`. `findGentlePiDeclaration` then matches the launcher's own package, `decideTakeOver` returns false, and `buildPiInvocation` injects nothing, so Pi loads the package's resources once through settings discovery. Side effect of that entry: in an isolated home that declares gentle-pi, `--package-root` stops forcing a take-over — `bin/gentle-shell.mjs` forwards the flag as explicit only in `--link` mode, so it warns once that "`--package-root` only forces a take-over in --link mode" and uses the declared package whatever path was requested; `--link` mode still honors it. The entry also hardcodes the install path — remove it once a fixed release is installed.

Actual installed launcher behavior remains unverified until release/install.
