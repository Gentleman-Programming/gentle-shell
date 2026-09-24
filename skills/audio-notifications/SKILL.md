---
name: gentle-ai-audio-notifications
description: "Trigger: avisame, notify, notification, sound, audio, earcon, alert, task complete, subagent finish. Play lightweight native audio earcons and send desktop notifications for command and agent lifecycle events."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill when the operator requests auditory feedback, desktop notifications, or background monitoring for command execution, long-running tasks, test suites, or subagent lifecycles (e.g. "avisame al terminar", "notify me when tests finish", "send an alert on failure", "play sound on complete").

Do not load this skill for purely silent inline operations, interactive conversational turns, or when the operator explicitly requests silent execution.

## Hard Rules

- **Zero external APIs & zero tokens**: Use only local, built-in operating system sound assets and notification binaries. Never call remote text-to-speech or webhook services for audio telemetry.
- **Strictly non-blocking execution**: Audio players (`aplay`, `paplay`, `pw-play`, `afplay`, `powershell.exe`) and desktop notification tools (`notify-send`, `osascript`) must run in the background (`&`) so they never block or delay command execution.
- **Exit code and stream preservation**: Command wrappers must preserve stdout, stderr, and the exact process exit code of the wrapped command.
- **Graceful degradation**: If audio devices or notification daemons are unavailable, fail silently or fallback to terminal bells (`\a`) without failing the parent command.

## Earcon Sound Mappings

| Event | Linux (`/usr/share/sounds/`) | macOS (`/System/Library/Sounds/`) | Windows (PowerShell / SystemSounds) | Acoustic Profile |
|---|---|---|---|---|
| `start` | `sound-icons/pisk-up-cink.wav` or `freedesktop/stereo/bell.oga` | `Tink.aiff` | `[Console]::Beep(800, 150)` | Subtle ascending tone (~0.4s) |
| `running` | `sound-icons/glass-water-1.wav` or `stereo/audio-volume-change.oga` | `Pop.aiff` | `[Console]::Beep(1000, 100)` | Waterdrop / soft tick (~0.9s) |
| `success` | `sound-icons/xylofon.wav` or `stereo/complete.oga` | `Glass.aiff` | `[System.Media.SystemSounds]::Asterisk.Play()` | Bright chord / chime (~2.3s) |
| `error` | `sound-icons/chord-7.wav` or `stereo/dialog-error.oga` | `Basso.aiff` | `[System.Media.SystemSounds]::Hand.Play()` | Low, urgent dissonance (~0.2s) |
| `batch_done` / `fanfare` | `sound-icons/trumpet-1.wav` or `stereo/complete.oga` | `Hero.aiff` | `[System.Media.SystemSounds]::Exclamation.Play()` | Triumphant fanfare (~1.5s) |

## Decision Gates

| Situation | Action |
|---|---|
| User runs long terminal command and wants notification on completion | Prepend wrapper: `skills/audio-notifications/assets/notify.sh <command...>` |
| Subagent or pipeline starts a batch of work | Emit `notify.sh --start "Batch started"` |
| Task or test run succeeds | Emit `notify.sh --success "Tests passed"` (or let wrapper handle exit 0) |
| Task or verification fails | Emit `notify.sh --error "Task failed"` (or let wrapper handle non-zero exit) |
| Entire multi-step batch or SDD phase finishes | Emit `notify.sh --fanfare "All tasks complete"` |

## Execution Steps

1. Detect the operating system (`uname -s` or `$OSTYPE`).
2. To wrap long-running commands, execute via the bundled asset:
   ```bash
   ./skills/audio-notifications/assets/notify.sh npm test
   ./skills/audio-notifications/assets/notify.sh terraform apply -auto-approve
   ```
3. To signal discrete lifecycle events directly:
   ```bash
   # Start signal
   ./skills/audio-notifications/assets/notify.sh --start "Deploying service"
   # Success signal
   ./skills/audio-notifications/assets/notify.sh --success "Service deployed"
   # Error signal
   ./skills/audio-notifications/assets/notify.sh --error "Deployment failed"
   # Fanfare signal
   ./skills/audio-notifications/assets/notify.sh --fanfare "Pipeline finished"
   ```

## Output Contract

- Returns the wrapped process's exit code verbatim.
- Emits elapsed duration in human-readable format (`Xm Ys` or `Xs`) alongside notification text.
- Formats notification titles with distinct indicators (🚀 Start, ✅ Success, 🚨 Error, 🎺 Complete).

## References

- CLI wrapper script: `skills/audio-notifications/assets/notify.sh`
- Issue Gentleman-Programming/gentle-shell#1165 (blocked-on-human desktop notifications)
