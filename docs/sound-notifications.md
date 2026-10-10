# Sound notifications

Audio is **off by default**. In a primary Pi terminal, open `/gentle:customize` → **Notifications** (the card header reads **Audio notifications**) and use the controls **directly in the same two-column card**: the global switch, process mute and three independent type groups (**Success**, **Error**, **Attention**) that each own their included tone or a local WAV. Per-event exceptions stay folded behind **Advanced**. Nothing closes the overlay or opens a second menu, and audio preferences stay separate from visual settings, profiles and visual reset. No new command is needed.

**Quick answer (Linux/WSLg):** on **plain Linux** the installed package prefers the native WAV backend and needs no external player; it connects to the local PulseAudio/PipeWire-Pulse Unix socket and needs a running server with a default sink. Inside **WSL** the Windows system `SoundPlayer` is preferred instead: the validated WAV snapshot is mapped to the derived `\\wsl.localhost\<distro>\...` UNC path and played by the fixed system host, so no Pulse server or RDP audio dependency is required; it does depend on the default `/mnt/c` automount and the standard `C:\Windows` root and falls back to the trusted Linux CLI before any playback otherwise. **Native Windows** WAV uses the same system `SoundPlayer` through the fixed `C:\Windows\...\powershell.exe` host. A read-only probe succeeded here, but physical audio is not claimed. OGG/FLAC always use the legacy CLI backend on Linux and WSL; native OGG/FLAC codecs are a future phase and Windows OGG/FLAC is unsupported. macOS keeps `afplay` for WAV and FLAC (own CoreAudio phase planned).

## Use the direct controls

- **Audio notifications: on / off** toggles the global switch. Highlighting or rendering the row never discovers a player or enables anything.
- **Audio: unmuted / muted** toggles this process' mute. Mute survives reload and session replacement; restarting Pi clears it. Muting/disabling discards pending events; resuming never replays them.
- **Success / Error / Attention** are the three basic types. Each shows its human selection — `success tone` / `error tone` / `attention tone`, `silence`, a local WAV basename, or `Custom (varies)` when the type's events diverge. **Enter** cycles that type between `silence → builtin:success → builtin:error → builtin:attention → silence`; on a mixed type Enter applies the recommended tone for that type. **`f`** opens an inline field to assign a literal absolute local WAV to that type, independently of the other types; the field is prefilled with the current path when the type already owns a file. **`p`** explicitly previews the type's selected sound, never an arbitrary one.
- **Advanced: show/hide per-event exceptions** reveals the per-event rows (`agent.completed`, `subagent.failed`, …) for one-off overrides. They start folded; expanding or collapsing only changes the card view and never writes configuration or reproduces sound. Each per-event row cycles and assigns its own WAV like a type row. **`f`** and **`p`** on any type or per-event row stay inside the same card; in Notifications `p` never opens the visual profiles pane.

The inline field and the recovery confirmation render inside the same card. **Escape** cancels the field or confirmation; a second Escape closes the card. If the field, value or `y yes` cannot be shown in full (a resize or a very small terminal), Enter or `y` is refused instead of acting on something invisible. Invalid/unreadable configuration disables automatic audio: saving in that state requires a fresh explicit inline confirmation to replace it, cancel preserves the file and settings, and a failed write does not grant consent to the next attempt. Diagnostics are generic local UI notices, not conversation messages, tools, model context or agent state.

## Supported events and defaults

| Origin | Events | Recommended sound |
| --- | --- | --- |
| Session | `session.started` | Silence |
| Main agent | `agent.started`, `agent.cancelled` | Silence |
| Main agent | `agent.completed` | `builtin:success` |
| Main agent | `agent.failed` | `builtin:error` |
| Main agent | `agent.attention` | `builtin:attention` |
| Subagent | `subagent.queued`, `subagent.running`, `subagent.waiting`, `subagent.cancelled` | Silence |
| Subagent | `subagent.completed` | `builtin:success` |
| Subagent | `subagent.failed`, `subagent.timed_out` | `builtin:error` |

`session.started` means initial process startup only, once per process, not reload/new/resume/fork. Main outcomes use settled-run evidence; `agent_end` is not success. Attention is an active main-run edge from the existing explicit intervention lifecycle (`herdr:blocked`), not every dialog. Subagent waiting does not imply attention. Restored tasks/history and unchanged snapshots are silent.

**Shutdown limitation:** `session.shutdown` remains in the schema for compatibility but is excluded from the runtime/UI catalog. Lazy playback cannot reliably finish during immediate cleanup without delaying exit. The historical best-effort proposal is not a promise of a quit sound; shutdown cancels audio instead.

## Global configuration

Only `<gentlePiConfigHome()>/notifications.json` is read. It normally resolves to `~/.pi/gentle-ai/notifications.json`; `GENTLE_PI_CONFIG_HOME` overrides the directory. No repository override can activate audio. Missing configuration reads the preset with `enabled: false`, without creating a file. Saved files are strict, not merged with defaults: omitted event keys and `null` both mean silence, including after upgrades.

Complete default schema (the shutdown entry is inert):

```json
{
  "schema": "gentle-shell.notifications/v1",
  "enabled": false,
  "audio": {
    "backend": "auto",
    "minimumIntervalMs": 1000,
    "coalesceWindowMs": 300,
    "events": {
      "session.started": null,
      "session.shutdown": null,
      "agent.started": null,
      "agent.completed": "builtin:success",
      "agent.failed": "builtin:error",
      "agent.cancelled": null,
      "agent.attention": "builtin:attention",
      "subagent.queued": null,
      "subagent.running": null,
      "subagent.waiting": null,
      "subagent.completed": "builtin:success",
      "subagent.failed": "builtin:error",
      "subagent.cancelled": null,
      "subagent.timed_out": "builtin:error"
    }
  }
}
```

Unknown keys/schema/events are rejected. `enabled` must be boolean; backend must be `auto`; timing values are integer milliseconds: minimum interval 0–60000, coalesce window 0–2000, inclusive. Zero disables that timing window, not the TTL. Writes use an exclusive 0600 temporary file beside the target followed by atomic rename. Changes apply to the live owner immediately and invalidate stale pending mappings. Direct external edits are read on the next session attachment/reload, not polled in the background.

## Local WAV security

Builtins `success`, `error`, `attention` are original synthetic tones under the [MIT license, provenance and reproduction recipe](../assets/sounds/LICENSE.md).

Enter a **literal absolute local path** in the file dialog (without the `file:` prefix). JSON references use `file:/absolute/path/my sound.wav`. Spaces and punctuation are literal; no shell interprets them. No URLs, UNC/network or device paths, relative paths, `~`, environment expansion, commands or configurable player executables. Selection and playback both validate; extension alone does not prove format.

Allowed content: RIFF/WAVE integer PCM (format 1), mono or stereo, 8/16/24/32-bit, 8000–192000 Hz, nonempty aligned data, coherent chunk bounds/padding and rate metadata; maximum **2 MiB** and **10 seconds**. Compressed/float/extensible WAV is not accepted. The final source must be a readable regular file, not a symlink or FIFO. No-follow/nonblocking descriptor opening, bounded reads and WAV validation fail closed. Intermediate directories are not a sandbox against other same-user filesystem writers.

Playback revalidates and snapshots the bytes in a private 0700 temporary directory with an exclusive 0600 file named for the validated format, then selects a backend **after** the format is known: native WAV first on Linux, otherwise the trusted absolute CLI with separate literal argv and `shell:false`. Source changes after selection cannot substitute unchecked playback bytes. A format no available backend supports is rejected before any snapshot or spawn. A native failure after a spawn is never retried through the CLI, so partial audio cannot duplicate. Abort/timeout kills the child/worker; the serial reservation is held until close and cleanup, not merely until kill was requested. Playback timeout is 11000 ms (native bridge + socket + owned Node): the validated 10 s duration limit plus a 1 s termination margin. OS-denied termination/cleanup cannot be guaranteed by mocks.

## Noise and retention

Only the primary **TUI** owner plays. Child processes, print/JSON and **all RPC**, including interactive RPC hosts, are silent. There is no desktop notification or BEL fallback. Two independent Pi processes can overlap; serialization is per process.

Ráfagas coalesce into at most one pending candidate, in event priority order: failed/timed_out > main attention > completed > other. Changing the sound does not change event priority. Equal priority selects the latest sound but keeps the first coalesce deadline. Starts respect the minimum interval. Pending events have a **2000 ms** freshness budget (including slow discovery/validation and minimum-interval waits). That budget pauses only while another sound has actually started playing, so a long WAV does not silently discard the next candidate; it resumes with the remaining budget when playback settles. Already stale incoming events are still rejected. Waiting behind discovery that has not started playback does not pause expiry. There is still only one pending candidate, not a growing queue. Preview remains subject to context, file validation, serialization and timeout.

The scheduler keeps a bounded 256-identity FIFO. The owner additionally retains the highest sequence **per producer/run** for the active parent session, across reload, preventing old wire duplicates after FIFO eviction. This map is not size-capped: it costs O(distinct runs) during a long session, is cleared when attaching a different session ID, and disappears on process exit. The actual TaskStore producer increments a store-global sequence on each status change, but current retention is still keyed per run; no producer-wide compaction is claimed here. Muted/off occurrences are consumed, not buffered.

## Runtime backend selection

| Format | Plain Linux | WSL (Windows interop) | Native Windows | macOS |
| --- | --- | --- | --- | --- |
| WAV | Native Pulse backend (preferred); trusted CLI fallback | Windows `SoundPlayer` through the derived `\\wsl.localhost\<distro>\...` UNC (preferred); trusted Linux CLI fallback | Windows `SoundPlayer` via the fixed `C:\Windows\...\powershell.exe` host | `/usr/bin/afplay` (legacy) |
| OGG / FLAC | Legacy CLI: first of `/usr/bin/paplay`, `/usr/bin/pw-play`, `/usr/bin/aplay` that supports it | Same trusted Linux CLI | Unsupported | `afplay` supports FLAC; OGG unverified |

Capabilities are aggregated, not replaced: a native WAV backend never removes the CLI OGG/FLAC capability. `availability` and `capabilities` discover only on an explicit request, never on import, render, or while audio is off. Selection is pure and IO-free (`createDefaultNotificationBackend`): `win32` and a valid WSL interop environment take the Windows adapter, every other platform keeps the local Pulse bridge, whose target is unavailable on macOS so `afplay` owns playback. On plain Linux the native backend probes the local Unix socket once per discovery and requires a default sink; when it is unavailable the CLI is used, and the probe result is cached until the owner is rebuilt. The WSL route uses only the default `/mnt/c` automount and the standard `C:\Windows` root: a non-standard mount or root, a missing `/run/WSL/*_interop` socket, or a failed read-only probe falls back to the trusted Linux CLI **before** any playback — there is deliberately no automatic Pulse fallback on WSL (a silent Pulse path is avoided) and no arbitrary binary, configurable route or route scheme. Native codecs (OGG/FLAC) are a future phase; own CoreAudio (macOS) and WASAPI (Windows) phases are planned. No system players are installed automatically and no new package dependency is added.

## Platforms and manual verification

Physical listening, UI, reload and quit remain **PENDING / UNVERIFIED** on every platform. The Linux/WSLg native path reached a real read-only Pulse `AUTH`/ServerInfo probe with a default sink (not a physical-listen claim); the WSL and native Windows routes use the system `SoundPlayer` for WAV and need no separate WASAPI phase, while Windows OGG/FLAC stays unsupported. macOS still uses `afplay` for WAV and FLAC while its own CoreAudio phase is planned. No physical playback or audible evidence is claimed for any route.

No system dependencies are installed automatically. No usable backend produces silence plus a bounded local warning, not an agent failure. SSH and containers play on the process host, not necessarily your client; an executable may exist without a usable device/server. Automated tests use injected clocks/processes and WAV validation; they do **not** establish physical audio or manual TUI correctness.

Manual acceptance remains pending for every applicable platform:

- [ ] Navigate customize → Notifications in narrow/wide, regular/fullscreen terminals; cancel every inline field and confirmation. Verify Enter, `f` and `p` stay inside the same card and never open another menu.
- [ ] Assign a valid local WAV with spaces via `f` to one type; confirm the other types keep their own sounds, preview off/muted with `p`, enable, verify live outcomes and independent mappings; verify bad files and consent cancellation preserve bytes.
- [ ] Mute and reload/change session, then resume without replay; confirm no probe while off unless explicitly requested.
- [ ] Quit/reload during probe, validation and active playback: no late spawn, overlap, stale write, leaked process or delayed exit.
- [ ] Listen to builtin/custom tones and exercise missing player, failed player and hanging player on the real host.

Implementation progress and automated evidence live in the [ODD task](../odd/tasks/sound-notifications.md). Full closure and manual acceptance are not inferred from the mock suite.
