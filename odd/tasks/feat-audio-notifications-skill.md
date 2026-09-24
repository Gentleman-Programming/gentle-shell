# Audio Notifications Skill & Avisame Wrapper

## Objective

Introduce the official `gentle-ai-audio-notifications` skill and its cross-platform `avisame.sh` CLI wrapper to gentle-shell, enabling lightweight, 100% local auditory feedback (earcons) and desktop notifications for command execution and agent lifecycles without external APIs or token costs.

## Problem

Long-running commands, infrastructure provisioning, test suites, and subagent runs require constant visual polling of the terminal. While issue #1165 explored `blocked-on-human` notification and #4393 proposed heavyweight TTS, there is no lightweight, zero-token auditory feedback mechanism using native OS sound assets to notify operators of `start`, `running`, `success`, `error`, and `batch_done` events.

## Scope

- Create `skills/audio-notifications/`:
  - `SKILL.md`: Standard skill contract following `gentle-ai-skill-creator` guidelines.
  - `assets/avisame.sh`: Executable wrapper measuring duration, preserving exit codes, and playing native earcons with desktop popups across Linux, macOS, and Windows.
- Update `tests/skill-collision-prefixes.test.ts` to register `gentle-ai-audio-notifications`.
- Add test coverage in `tests/` verifying `avisame.sh` command wrapping, exit code preservation, flag handling, and execution.
- Verification via `npm test` and `npm run typecheck`.

## Constraints

- Technical artifacts remain in English.
- Script and audio execution must remain non-blocking (backgrounded) to never delay command execution.
- Zero external APIs, zero tokens, pure native OS tools.
- Strict TDD discipline.

## Tasks

- [x] **T1 — Create `skills/audio-notifications/assets/avisame.sh`.** Implement robust, non-blocking cross-platform wrapper.
- [x] **T2 — Create `skills/audio-notifications/SKILL.md`.** Author standard skill following activation contract, decision gates, and earcon mappings.
- [x] **T3 — Add test coverage and register collision prefix.** Update `tests/skill-collision-prefixes.test.ts` and test `avisame.sh`.
- [x] **T4 — Full verification and typecheck.**
