# Contract notes for Cristian

Running log of contract-relevant changes in gentle-pi (Gentle Shell) that the
Gentle Cloud backend may consume. Each entry names its branch, what changed for
a consumer, and what did not. Newest first.

Status words: **public** = a consumer may rely on it; **internal** = documented
for context only, may change without notice; **open** = not designed yet.

## 2026-10-19 — Voice push-to-talk, hold Space (`feat/voice-push-to-talk`)

Builds on `feat/optional-parakeet-voice`.

### Summary for the backend

- **No change to any existing contract.** No RPC command or event, no model-callable tool,
  no change to the session protocol.
- **TUI only, like `/gentle:voice`.** Push-to-talk listens to raw terminal input through
  `ctx.ui.onTerminalInput`, which exists only in interactive mode. A workspace driven over
  RPC never arms it, so typing and input sent through RPC are unaffected.
- **open:** the same note as before applies: browser push-to-talk for Gentle Cloud would
  need its own capture and a contract that does not exist yet.

### New preference file (internal, additive)

`<config home>/voice-settings.json`, next to the other per-feature preference files:

```json
{ "schema": "gentle-pi.voice-settings/v1", "pushToTalk": true }
```

- Exactly these two keys. Missing, malformed or foreign content reads as `pushToTalk: false`.
- Written atomically (temporary file plus rename, mode `0600`).
- Set to `true` after a successful voice download; toggled from `/gentle:voice`.
- Read once at session start; no other startup IO for voice.
- If a workspace image pre-seeds the config home, leaving this file out keeps push-to-talk off.

### Behavior a consumer might observe (internal)

- When enabled and installed, holding Space in the TUI dictates into the draft. Taps and
  normal typing reach the editor unchanged. Confirming a hold erases the spaces the hold
  typed by rewriting later repeats to Backspace (`\x7f`), verified against the draft text.
- Disabled or not installed: no input listener is registered at all.

## 2026-10-17 — Optional local voice dictation (`feat/optional-parakeet-voice`)

### Summary for the backend

- **No change to any existing contract.** No new RPC command, RPC event, model-callable
  tool, settings key or config format. The `pi --mode rpc` session protocol is untouched.
- **Voice does not work through RPC.** `/gentle:voice` runs only in an interactive TUI
  parent session. RPC, print, JSON and delegated child sessions refuse it with a notice
  and do no voice work. A Gentle Cloud workspace that drives Gentle Shell over RPC
  therefore gets no dictation from this feature.
- **open:** browser dictation for Gentle Cloud. The browser would capture audio and the
  backend (or browser) would transcribe it, then submit text through the existing
  session protocol. No contract exists for that yet; this feature does not define one.

### Command surface (public, user-facing)

| Item | Contract |
|------|----------|
| Command | `/gentle:voice`, registered by `extensions/gentle-voice.ts`. |
| Where it runs | Interactive TUI parent sessions only. |
| Result | The transcript is pasted into the editor draft through Pi's paste pipeline. It is never submitted automatically. |
| Concurrency | One download or dictation at a time per Pi process; a second invocation is refused. |
| Startup | Registration performs no filesystem, network, native load or process spawn. |

### Storage layout (internal)

Everything lives under `<config home>/voice/`, where the config home is resolved by
`gentlePiConfigHome()` (`lib/agent-home.ts`): `~/.pi/gentle-ai` by default, or
`~/.gentle-shell/gentle-ai` for a standalone Gentle Shell home, or
`GENTLE_PI_CONFIG_HOME` when set.

```text
voice/
  runtime/sherpa-onnx-1.13.8-node-cpal-1.0.0-<target>/node_modules/
  models/parakeet-tdt-0.6b-v3-int8-2bda32ec70b0/
```

Each component directory carries an install marker written last. Directory names encode
the pinned versions, so a version bump installs side by side.

### Network egress during the explicit download (relevant for egress allowlists)

| Host | What |
|------|------|
| `registry.npmjs.org` | `sherpa-onnx-node@1.13.8`, its platform package, `node-cpal@1.0.0` |
| `huggingface.co` | Model files at pinned commit `2bda32ec70b097a55adaa07d9a7173915b43cc78` |
| `us.aws.cdn.hf.co` (`/xet-bridge-us/` only) | Large model file redirect target |

Other Hugging Face CDN regions are refused, so a workspace outside the US may fail the
model download until the allowlist is widened. Total download is about 690 MB.

### Platform requirements (relevant for workspace images)

Supported targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.
Native Windows ARM64 and musl Linux are unsupported; WSL is unproven.

- Linux needs glibc 2.34 or newer and ALSA `libasound.so.2`. Headless containers usually
  have no input device, so dictation reports "No microphone was found."
- Windows needs the Microsoft Visual C++ runtime (`vcruntime140.dll`); it is never installed.
- Node 22 or newer.
- None of the five targets has been verified on real hardware yet.

### Worker protocol `gentle.voice/v1` (internal)

The command talks to an isolated child process (`scripts/voice-worker.cjs`, started with
`process.execPath`) over stdio, one JSON object per line. Documented here because it is the
only new wire format in this feature; it is **not** a public contract.

| Direction | Messages |
|-----------|----------|
| parent → worker | `start` (target, `maxRecordingMs`, `numThreads`, runtime and model roots), `stop`, `cancel` |
| worker → parent | `recording`, `transcribing`, `result` (`text`, `truncated`), `error` (`code`) |

Every message carries `"schema": "gentle.voice/v1"` and exactly its own keys; anything else
stops the worker. Bounds: 64 KiB per line, 16 lines per session, 16 KiB of transcript text.
Defaults: 120 s recording limit, 120 s start timeout, 120 s transcription timeout, 2 s exit
grace, 2 inference threads.

Worker error codes (closed set): `invalid-request`, `node-version`, `runtime-invalid`,
`model-invalid`, `runtime-load`, `model-load`, `no-input-device`, `unsupported-input`,
`capture`, `empty-audio`, `decode`, `internal`. The parent adds `invalid-state`,
`unsupported`, `not-installed`, `no-speech`, `timeout`, `protocol`, `worker-exited` and
`cancelled`. Messages are fixed strings: no path, environment value or native error text.

## 2026-10-17 — Memory binder diagnostics (`fix/memory-binder-diagnostics`)

- **No contract change.** `AutoPermissionMemory.diagnostic()` (`lib/auto-permission-memory.ts`)
  is a new internal observer returning closed enums (`stage`, `reason`, optional
  `sourceRejection`). It has no consumer and does not affect permission decisions.
- No action needed on the backend.
